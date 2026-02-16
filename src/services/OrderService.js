/**
 * @file src/services/OrderService.js
 * @description Ядро бизнес-логики (Business Logic Layer).
 * Реализует калькуляцию смет, жизненный цикл заказа и финансовые транзакции.
 * Полностью заменяет функционал старой веб-админки.
 * @version 8.0.0 (Bot-First Architecture)
 */

import { db } from "../db.js";
import { config } from "../config.js"; // Для доступа к ценам из конфига (если в БД нет)
import { PRICING, ESTIMATE_RULES, ORDER_STATUS } from "../constants.js";

export class OrderService {

    // =========================================================================
    // 🧮 КАЛЬКУЛЯТОР (ESTIMATION ENGINE)
    // =========================================================================

    /**
     * Расчет предварительной сметы по алгоритму "Умные точки 2.0".
     * Использует цены из базы данных (с фолбэком на константы).
     */
    static async calculateEstimate(area, rooms, wallType) {
        // Получаем актуальные цены из БД (они могут быть изменены админом)
        const dbPrices = await db.getSettings();
        
        // Объединяем цены из БД с дефолтными константами (Priority: DB > Config > Constants)
        const pPoint = {
            concrete: dbPrices['price_point_concrete'] || PRICING.points.concrete,
            brick: dbPrices['price_point_brick'] || PRICING.points.brick,
            gasblock: dbPrices['price_point_gasblock'] || PRICING.points.gasblock
        };
        const pStrobe = {
            concrete: dbPrices['price_strobe_concrete'] || PRICING.strobe.concrete,
            brick: dbPrices['price_strobe_brick'] || PRICING.strobe.brick,
            gasblock: dbPrices['price_strobe_gasblock'] || PRICING.strobe.gasblock
        };

        // 1. Алгоритм объемов (Heuristics)
        const vol = {
            points: Math.ceil((area * ESTIMATE_RULES.pointsPerSqm) + (rooms * 2)), // Розетки/выкл
            cable: Math.ceil(area * ESTIMATE_RULES.cablePerSqm), // Метров кабеля
            strobe: Math.ceil(area * 0.8), // Метров штробы
            shieldModules: ESTIMATE_RULES.minShieldModules + (rooms * 2) + 3, // Автоматы
            boxes: Math.ceil((rooms + 1) * 1.2) // Распайки
        };

        // 2. Выбор цены для конкретного типа стен
        let unitPricePoint = pPoint.gasblock;
        let unitPriceStrobe = pStrobe.gasblock;

        if (wallType === 'concrete') {
            unitPricePoint = pPoint.concrete;
            unitPriceStrobe = pStrobe.concrete;
        } else if (wallType === 'brick') {
            unitPricePoint = pPoint.brick;
            unitPriceStrobe = pStrobe.brick;
        }

        // 3. Расчет стоимости РАБОТ
        const costs = {
            points: vol.points * unitPricePoint,
            strobe: vol.strobe * unitPriceStrobe,
            cable: vol.cable * (dbPrices['price_cable_m'] || PRICING.cable.ceiling),
            shield: vol.shieldModules * (dbPrices['price_shield_module'] || PRICING.shield.moduleAssembly),
            boxes: vol.boxes * (dbPrices['price_box_assembly'] || PRICING.junctionBox.connect)
        };

        const totalWork = Object.values(costs).reduce((a, b) => a + b, 0);

        // 4. Материал (Оценка)
        // Если в БД задан коэффициент, берем его, иначе дефолт 0.45
        const matFactor = dbPrices['material_factor'] || PRICING.materialsFactor;
        const totalMaterial = Math.ceil(totalWork * matFactor);

        return {
            params: { area, rooms, wallType },
            volume: vol,
            prices: { point: unitPricePoint, strobe: unitPriceStrobe },
            breakdown: costs,
            total: {
                work: Math.ceil(totalWork),
                material: totalMaterial,
                grandTotal: Math.ceil(totalWork + totalMaterial)
            }
        };
    }

    // =========================================================================
    // 🏗 УПРАВЛЕНИЕ ЗАКАЗАМИ (ORDER LIFECYCLE)
    // =========================================================================

    /**
     * Создание заказа из Калькулятора
     */
    static async createOrder(userId, estimateData) {
        return await db.createOrder(userId, {
            area: estimateData.params.area,
            rooms: estimateData.params.rooms,
            wallType: estimateData.params.wallType,
            estimatedPrice: estimateData.total.grandTotal
        });
    }

    /**
     * Создание заказа ВРУЧНУЮ (Админом через бот)
     * @param {Object} data - { clientName, clientPhone, area, price }
     */
    static async createManualOrder(adminId, data) {
        // 1. Создаем или находим "теневого" юзера для клиента
        // Используем телефон как уникальный ключ, если нет telegram_id
        const fakeTgId = parseInt(data.clientPhone.replace(/\D/g, '').slice(-9)); // Генерим ID из телефона
        
        await db.upsertUser(fakeTgId, data.clientName, null, data.clientPhone);

        // 2. Создаем заказ
        return await db.createOrder(fakeTgId, {
            area: data.area,
            rooms: 1, // Дефолт
            wallType: 'unknown',
            estimatedPrice: data.price
        });
    }

    /**
     * Назначить мастера на заказ
     */
    static async assignMaster(orderId, masterId) {
        await db.query(
            `UPDATE orders 
             SET assignee_id = $1, status = 'work', updated_at = NOW() 
             WHERE id = $2`,
            [masterId, orderId]
        );
        // Тут можно добавить отправку уведомления мастеру через bot.sendMessage
    }

    /**
     * Закрытие заказа (Финализация)
     * Расчет прибыли, доли мастера и обновление балансов.
     */
    static async completeOrder(orderId, finalSum, walletId, userId) {
        return db.transaction(async (client) => {
            // 1. Получаем расходы по объекту
            const expRes = await client.query(
                "SELECT COALESCE(SUM(amount), 0) as total FROM object_expenses WHERE order_id = $1", 
                [orderId]
            );
            const expenses = parseFloat(expRes.rows[0].total);

            // 2. Считаем чистую прибыль
            const profit = finalSum - expenses;

            // 3. Считаем зарплату мастера (из настроек или дефолт 20%)
            const settings = await db.getSettings();
            const businessPercent = (settings['percent_business'] || 20) / 100;
            const businessShare = Math.floor(profit * businessPercent);
            const masterShare = profit - businessShare;

            // 4. Обновляем статус заказа
            await client.query(
                `UPDATE orders SET
                    status = 'done',
                    final_price = $1,
                    final_profit = $2,
                    end_date = NOW(),
                    updated_at = NOW()
                 WHERE id = $3`,
                [finalSum, profit, orderId]
            );

            // 5. Зачисляем ВСЮ сумму в кассу (приход)
            await client.query(
                `UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
                [finalSum, walletId]
            );
            
            // 6. Лог транзакции (Приход)
            await client.query(
                `INSERT INTO transactions (account_id, user_id, amount, type, category, comment, created_at)
                 VALUES ($1, $2, $3, 'income', 'order_payment', $4, NOW())`,
                [walletId, userId, finalSum, `Оплата заказа #${orderId}`]
            );

            return { profit, expenses, masterShare, businessShare };
        });
    }

    // =========================================================================
    // 📊 АНАЛИТИКА И СПИСКИ (GETTERS)
    // =========================================================================

    /**
     * Получить активные заказы (Работа/Обсуждение)
     * Включает сумму расходов.
     */
    static async getActiveOrders(userId, role) {
        let sql = `
            SELECT 
                o.id, o.status, o.created_at, o.total_price, 
                o.area, o.wall_type,
                u.first_name as client_name, 
                u.phone as client_phone, 
                u.username as client_user,
                (SELECT COALESCE(SUM(amount), 0) FROM object_expenses WHERE order_id = o.id) as expenses_sum
            FROM orders o
            JOIN users u ON o.user_id = u.telegram_id
            WHERE o.status IN ('new', 'work', 'discuss')
        `;
        
        const params = [];

        // Менеджер видит только свои, Админ — все
        if (role === 'manager') {
            sql += ` AND o.assignee_id = $1`;
            params.push(userId);
        }

        sql += ` ORDER BY o.updated_at DESC`;
        
        const res = await db.query(sql, params);
        return res.rows;
    }

    /**
     * Получить ВСЕ заказы (для Админки бота)
     * С фильтрацией и пагинацией
     */
    static async getAllOrders(status = null, limit = 20, offset = 0) {
        let sql = `
            SELECT 
                o.id, o.status, o.total_price, o.final_profit,
                u.first_name as client,
                m.first_name as master
            FROM orders o
            LEFT JOIN users u ON o.user_id = u.telegram_id
            LEFT JOIN users m ON o.assignee_id = m.telegram_id
        `;
        const params = [];

        if (status && status !== 'all') {
            sql += ` WHERE o.status = $1`;
            params.push(status);
        }

        sql += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const res = await db.query(sql, params);
        return res.rows;
    }

    /**
     * История заказов клиента
     */
    static async getUserOrders(userId) {
        const sql = `
            SELECT o.id, o.status, o.total_price, o.created_at
            FROM orders o
            WHERE o.user_id = $1
            ORDER BY o.created_at DESC LIMIT 5
        `;
        const res = await db.query(sql, [userId]);
        return res.rows;
    }

    /**
     * Генерация публичного прайс-листа
     */
    static async getPublicPriceList() {
        const dbPrices = await db.getSettings();
        return {
            wall_light: dbPrices['price_point_gasblock'] || PRICING.points.gasblock,
            wall_medium: dbPrices['price_point_brick'] || PRICING.points.brick,
            wall_heavy: dbPrices['price_point_concrete'] || PRICING.points.concrete
        };
    }
}
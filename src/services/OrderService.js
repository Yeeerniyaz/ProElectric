/**
 * @file src/services/OrderService.js
 * @description Ядро бизнес-логики (Business Logic Layer).
 * Реализует калькуляцию смет, жизненный цикл заказа и финансовые транзакции.
 * @version 8.1.0 (Detailed Granular Pricing)
 */

import { db } from "../db.js";
import { PRICING, ESTIMATE_RULES } from "../constants.js";

export class OrderService {

    // =========================================================================
    // 🧮 КАЛЬКУЛЯТОР (ESTIMATION ENGINE)
    // =========================================================================

    /**
     * Детальный расчет сметы v2.0
     * Разбивает работы на черновые (грязные) и чистовые.
     * Учитывает тип стен для сверления и штробления.
     * * @param {number} area - Площадь помещения (м2)
     * @param {number} rooms - Количество комнат
     * @param {string} wallType - Тип стен ('concrete' | 'brick')
     */
    static async calculateEstimate(area, rooms, wallType) {
        // 1. Загружаем динамические настройки из БД (они имеют приоритет над кодом)
        const settings = await db.getSettings();

        /**
         * Хелпер для безопасного получения цены
         * @param {string} key - Ключ в БД
         * @param {number} fallback - Значение по умолчанию из constants.js
         */
        const getPrice = (key, fallback) => {
            const val = settings[key];
            return (val !== undefined && val !== null) ? Number(val) : fallback;
        };

        // 2. Определяем контекст (Бетон vs Кирпич)
        const isConcrete = wallType === 'concrete';

        // 3. Собираем объект цен (Pricing Configuration)
        const prices = {
            // --- Черновые работы ---
            strobe: isConcrete 
                ? getPrice('price_strobe_concrete', PRICING.rough.strobeConcrete)
                : getPrice('price_strobe_brick', PRICING.rough.strobeBrick),
            
            drill: isConcrete
                ? getPrice('price_drill_hole_concrete', PRICING.rough.drillHoleConcrete)
                : getPrice('price_drill_hole_brick', PRICING.rough.drillHoleBrick),

            cable: getPrice('price_cable_laying', PRICING.rough.cableLaying),
            boxInstall: getPrice('price_socket_box_install', PRICING.rough.socketBoxInstall), // Вмазка
            junction: getPrice('price_junction_box_assembly', PRICING.rough.junctionBoxAssembly),

            // --- Чистовые работы ---
            socketInstall: getPrice('price_socket_install', PRICING.finish.socketInstall), // Механизмы
            shield: getPrice('price_shield_module', PRICING.finish.shieldModule),
            led: getPrice('price_led_strip', PRICING.finish.ledStrip),
            lamp: getPrice('price_lamp_install', PRICING.finish.lampInstall),
            
            // --- Коэффициенты ---
            matFactor: getPrice('material_factor', PRICING.materialsFactor)
        };

        // 4. Эвристика объемов (Volume Heuristics)
        // Рассчитываем предполагаемые объемы материалов на основе площади
        const vol = {
            cable: Math.ceil(area * ESTIMATE_RULES.cablePerSqm),
            strobe: Math.ceil(area * ESTIMATE_RULES.strobePerSqm),
            // Точки: (Площадь * 0.6) + (Комнаты * 2) -> Эмпирическая формула
            points: Math.ceil((area * ESTIMATE_RULES.pointsPerSqm) + (rooms * 2)), 
            // Распайки: По одной на комнату + коридор + кухня
            boxes: rooms + 2, 
            // Щит: Минимум 12 модулей + запас на комнаты
            shieldModules: Math.max(ESTIMATE_RULES.minShieldModules, 10 + (rooms * 2)),
            // LED: Периметр одной большой комнаты (условно)
            ledStrip: rooms * 5 
        };

        // 5. Калькуляция стоимости (Cost Calculation)
        
        // A. Черновой этап (Грязные работы)
        const roughBreakdown = {
            strobeCost: vol.strobe * prices.strobe,
            cableCost: vol.cable * prices.cable,
            drillCost: vol.points * prices.drill,       // Только сверление
            boxInstallCost: vol.points * prices.boxInstall, // Только вмазка
            junctionCost: vol.boxes * prices.junction
        };
        const roughTotal = Object.values(roughBreakdown).reduce((sum, val) => sum + val, 0);

        // B. Чистовой этап (Установка механизмов)
        const finishBreakdown = {
            mechanismsCost: vol.points * prices.socketInstall,
            shieldCost: vol.shieldModules * prices.shield,
            ledCost: vol.ledStrip * prices.led
        };
        const finishTotal = Object.values(finishBreakdown).reduce((sum, val) => sum + val, 0);

        // C. Итого работы
        const totalWork = roughTotal + finishTotal;

        // D. Материалы (Черновые + Чистовые)
        // Обычно считаются как % от работ или фиксированно, здесь берем % из настроек
        const totalMaterial = Math.ceil(totalWork * prices.matFactor);

        // E. Гранд Тотал
        const grandTotal = Math.ceil(totalWork + totalMaterial);

        return {
            params: { area, rooms, wallType },
            volume: vol,
            pricesApplied: prices,
            breakdown: {
                rough: roughBreakdown,
                finish: finishBreakdown
            },
            cost: {
                rough: Math.ceil(roughTotal),
                finish: Math.ceil(finishTotal),
                workTotal: Math.ceil(totalWork),
                material: totalMaterial,
                total: grandTotal
            }
        };
    }

    // =========================================================================
    // 🏗 УПРАВЛЕНИЕ ЗАКАЗАМИ (ORDER LIFECYCLE)
    // =========================================================================

    /**
     * Создание заказа в БД на основе расчета
     * @param {Object} user - Объект пользователя из Telegram
     * @param {Object} calcResult - Результат работы calculateEstimate()
     */
    static async createOrder(user, calcResult) {
        return db.createOrder(user.telegram_id, {
            area: calcResult.params.area,
            rooms: calcResult.params.rooms,
            wallType: calcResult.params.wallType,
            estimatedPrice: calcResult.cost.total
        });
    }

    /**
     * Ручное создание заказа (через Админку)
     * Используется, если клиент пришел не через бота, а по звонку.
     */
    static async createManualOrder(adminId, { clientName, clientPhone, area, price }) {
        // Генерируем псевдо-ID из телефона (удаляем всё кроме цифр, берем последние 9)
        const fakeTgId = parseInt(clientPhone.replace(/\D/g, '').slice(-9)) || Date.now();
        
        // Создаем "теневого" пользователя
        await db.upsertUser(fakeTgId, clientName, 'manual_entry', clientPhone);

        // Создаем заказ
        return db.createOrder(fakeTgId, {
            area: area,
            rooms: 1, // Дефолт
            wallType: 'unknown',
            estimatedPrice: price
        });
    }

    /**
     * Завершение заказа и распределение финансов
     * Transactional: Либо всё сохраняется, либо ничего.
     */
    static async completeOrder(orderId, finalSum, walletId, userId) {
        return db.transaction(async (client) => {
            // 1. Считаем фактические расходы (такси, расходники), занесенные в ходе работ
            const expRes = await client.query(
                "SELECT COALESCE(SUM(amount), 0) as total FROM object_expenses WHERE order_id = $1", 
                [orderId]
            );
            const expenses = parseFloat(expRes.rows[0].total);

            // 2. Чистая прибыль (Выручка - Расходы)
            const profit = finalSum - expenses;

            // 3. Распределение (Бизнес vs Мастер)
            // Процент бизнеса берем из настроек, по умолчанию 20%
            const settings = await db.getSettings();
            const businessPercent = (settings['percent_business'] || 20) / 100;
            
            const businessShare = Math.floor(profit * businessPercent);
            const masterShare = profit - businessShare;

            // 4. Закрываем заказ в БД
            await client.query(
                `UPDATE orders SET
                    status = 'done',
                    final_price = $1,
                    final_profit = $2,
                    updated_at = NOW()
                 WHERE id = $3`,
                [finalSum, profit, orderId]
            );

            // 5. Пополняем кассу (Income)
            // Логика: Деньги зашли в кассу, мы их видим. Зарплата мастера — это отдельный расход (вывод), 
            // но здесь мы просто фиксируем приход всей суммы.
            await client.query(
                `UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
                [finalSum, walletId]
            );
            
            // 6. Аудит транзакции
            await client.query(
                `INSERT INTO transactions (account_id, user_id, amount, type, category, comment, created_at)
                 VALUES ($1, $2, $3, 'income', 'order_payment', $4, NOW())`,
                [walletId, userId, finalSum, `Закрытие заказа #${orderId}. Прибыль: ${profit}`]
            );

            return { profit, expenses, masterShare, businessShare };
        });
    }

    // =========================================================================
    // 📊 АНАЛИТИКА И СПИСКИ (DATA ACCESS)
    // =========================================================================

    /**
     * Получить активные заказы для дашборда
     * @param {string} userId - ID запрашивающего
     * @param {string} role - Роль (admin/manager)
     */
    static async getActiveOrders(userId, role) {
        let sql = `
            SELECT 
                o.id, o.status, o.created_at, o.total_price, 
                o.area, o.wall_type,
                u.first_name as client_name, 
                u.phone as client_phone, 
                (SELECT COALESCE(SUM(amount), 0) FROM object_expenses WHERE order_id = o.id) as expenses_sum
            FROM orders o
            JOIN users u ON o.user_id = u.telegram_id
            WHERE o.status IN ('new', 'work', 'discuss')
        `;
        
        const params = [];

        // Менеджер видит только те заказы, на которые он назначен
        if (role === 'manager') {
            sql += ` AND o.assignee_id = $1`;
            params.push(userId);
        }

        sql += ` ORDER BY o.updated_at DESC`;
        
        const res = await db.query(sql, params);
        return res.rows;
    }

    /**
     * Форматирование сообщения с расчетом для Telegram
     * @param {Object} calc - Результат calculateEstimate
     */
    static formatEstimateMessage(calc) {
        const f = (n) => n.toLocaleString('ru-RU');
        const wallName = calc.params.wallType === 'concrete' ? '🏗 Бетон (Монолит)' : '🧱 Кирпич (Блок)';

        return `🏗 <b>ПРЕДВАРИТЕЛЬНЫЙ РАСЧЕТ</b>\n` +
               `➖➖➖➖➖➖➖➖➖➖\n` +
               `📐 Площадь: <b>${calc.params.area} м²</b>\n` +
               `🏠 Стены: <b>${wallName}</b>\n\n` +
               
               `<b>📋 Детализация работ:</b>\n` +
               `▫️ Точек (сверление+вмазка): ~${calc.volume.points} шт\n` +
               `▫️ Штробления: ~${calc.volume.strobe} м\n` +
               `▫️ Кабеля: ~${calc.volume.cable} м\n` +
               `▫️ Щит: ~${calc.volume.shieldModules} модулей\n\n` +

               `<b>💰 Итоговая смета:</b>\n` +
               `🛠 Черновые работы: ${f(calc.cost.rough)} ₸\n` +
               `✨ Чистовые работы: ${f(calc.cost.finish)} ₸\n` +
               `🔌 Материалы (Примерно): ${f(calc.cost.material)} ₸\n` +
               `➖➖➖➖➖➖➖➖➖➖\n` +
               `🏁 <b>ИТОГО ПОД КЛЮЧ: ~${f(calc.cost.total)} ₸</b>\n\n` +
               `<i>* Точная стоимость фиксируется после выезда мастера.</i>`;
    }
}
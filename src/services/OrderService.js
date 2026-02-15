/**
 * @file src/services/OrderService.js
 * @description Слой бизнес-логики (Business Logic Layer).
 * Единая точка доступа к данным для Бота и Web-админки.
 * @version 6.2.0 (Manager Features Added)
 */

import { db } from '../db.js';
import { ORDER_STATUS } from '../constants.js';

export class OrderService {

    // =========================================================================
    // 🏗 WRITE OPERATIONS (СОЗДАНИЕ И ИЗМЕНЕНИЕ)
    // =========================================================================

    /**
     * 🧮 Рассчитать предварительную смету (Калькулятор)
     */
    static async calculateEstimate(area, wallType) {
        const prices = await db.getSettings();
        const wallFactor = { light: 1.0, medium: 1.25, heavy: 1.6 }[wallType] || 1;

        const volume = {
            points: Math.ceil(area * 0.85),
            strobe: Math.ceil(area * 0.6),
            cable: Math.ceil(area * 4.8),
            boxes: Math.ceil(area * 0.85),
            shield: Math.ceil(area / 15) + 2
        };

        const workCost = (
            (volume.points * (prices.work_point || 1500)) +
            (volume.strobe * (prices.work_strobe || 1500) * wallFactor) +
            (volume.cable * (prices.work_cable || 450)) +
            (prices.work_shield_install || 18000)
        );

        const matCost = Math.ceil(area * (prices.material_m2 || 4500));

        return {
            area,
            wallType,
            volume,
            costs: {
                work: Math.ceil(workCost),
                material: matCost,
                total: Math.ceil(workCost + matCost)
            }
        };
    }

    /**
     * Создать Лид
     */
    static async createLead(userId, estimate) {
        return await db.createLead(userId, {
            area: estimate.area,
            wallType: estimate.wallType,
            totalWork: estimate.costs.work,
            totalMat: estimate.costs.material
        });
    }

    /**
     * Создать Заказ (Конверсия)
     */
    static async createOrder(userId, leadId) {
        return await db.createOrder(userId, leadId);
    }

    /**
     * Взять заказ в работу
     */
    static async takeOrder(orderId, userId) {
        const userRes = await db.query('SELECT role, first_name FROM users WHERE telegram_id = $1', [userId]);
        const user = userRes.rows[0];

        if (!user || !['admin', 'manager'].includes(user.role)) {
            throw new Error('ACCESS_DENIED');
        }

        await db.query(
            `UPDATE orders SET assignee_id = $1, status = 'work', updated_at = NOW() WHERE id = $2`,
            [userId, orderId]
        );
        return user;
    }

    /**
     * Обновить статус и вернуть фин. данные если закрыт
     */
    static async updateStatus(orderId, newStatus, userId) {
        await db.query(
            `UPDATE orders SET status = $1, assignee_id = $2, updated_at = NOW() WHERE id = $3`,
            [newStatus, userId, orderId]
        );

        if (newStatus === ORDER_STATUS.DONE) {
            return await this._calculateFinancialSplit(orderId);
        }
        return null;
    }

    // =========================================================================
    // 👓 READ OPERATIONS (ЧТЕНИЕ И СТАТИСТИКА)
    // =========================================================================

    /**
     * 🔥 ЖАҢА ФУНКЦИЯ: Менеджердің активті объектілері
     * (Статус: 'work' немесе 'discuss')
     */
    static async getManagerActiveOrders(managerId) {
        const sql = `
            SELECT 
                o.id, o.status, o.created_at, 
                l.total_work_cost, l.area, l.wall_type,
                u.first_name as client_name, 
                u.phone as client_phone,
                u.username as client_user
            FROM orders o
            JOIN leads l ON o.lead_id = l.id
            JOIN users u ON o.user_id = u.telegram_id
            WHERE o.assignee_id = $1 
            AND o.status IN ('work', 'discuss') 
            ORDER BY o.updated_at DESC
        `;
        const res = await db.query(sql, [managerId]);
        return res.rows;
    }

    /**
     * Получить историю заказов пользователя (для меню "Мои заказы")
     */
    static async getUserOrders(userId, limit = 5) {
        const sql = `
            SELECT 
                o.id, o.status, o.created_at, 
                l.total_work_cost,
                u.first_name as manager_name, 
                u.username as manager_user,
                u.phone as manager_phone
            FROM orders o
            JOIN leads l ON o.lead_id = l.id
            LEFT JOIN users u ON o.assignee_id = u.telegram_id
            WHERE o.user_id = $1
            ORDER BY o.created_at DESC
            LIMIT $2
        `;
        const res = await db.query(sql, [userId, limit]);
        return res.rows;
    }

    /**
     * Глобальная статистика для Админки (Funnel)
     */
    static async getGlobalStats() {
        // Воронка продаж
        const funnelRes = await db.query(`
            SELECT status, COUNT(*) as count, SUM(l.total_work_cost) as money
            FROM orders o JOIN leads l ON o.lead_id = l.id
            GROUP BY status
        `);

        // Последние 10 заказов
        const recentRes = await db.query(`
            SELECT o.id, u.first_name, l.total_work_cost, o.status, o.created_at
            FROM orders o
            JOIN users u ON o.user_id = u.telegram_id
            JOIN leads l ON o.lead_id = l.id
            ORDER BY o.created_at DESC LIMIT 10
        `);

        return {
            funnel: funnelRes.rows,
            recent: recentRes.rows
        };
    }

    /**
     * Получить актуальный прайс-лист для отправки клиенту
     */
    static async getPublicPriceList() {
        const settings = await db.getSettings();
        return {
            wall_light: settings.wall_light,
            wall_medium: settings.wall_medium,
            wall_heavy: settings.wall_heavy,
            material_m2: settings.material_m2
        };
    }

    // =========================================================================
    // 🔒 PRIVATE HELPERS
    // =========================================================================

    static async _calculateFinancialSplit(orderId) {
        const res = await db.query(`
            SELECT l.total_work_cost 
            FROM orders o 
            JOIN leads l ON o.lead_id = l.id 
            WHERE o.id = $1
        `, [orderId]);

        if (!res.rows[0]) return null;

        const total = res.rows[0].total_work_cost;
        const prices = await db.getSettings();

        const businessPercent = (prices.business_percent || 20) / 100;
        const staffPercent = (prices.staff_percent || 80) / 100;

        return {
            total,
            businessShare: Math.floor(total * businessPercent),
            staffShare: Math.floor(total * staffPercent),
            percents: {
                business: prices.business_percent,
                staff: prices.staff_percent
            }
        };
    }
}
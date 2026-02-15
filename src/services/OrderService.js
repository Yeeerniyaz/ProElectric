/**
 * @file src/services/OrderService.js
 * @description Слой бизнес-логики (Business Logic Layer).
 * Отвечает за расчеты, управление статусами и финансовые операции.
 */

import { db } from "../db.js";
import { ORDER_STATUS } from "../constants.js";

export class OrderService {
  /**
   * 🧮 Рассчитать предварительную смету (Калькулятор)
   */
  static async calculateEstimate(area, wallType) {
    // 1. Получаем настройки (цены)
    const prices = await db.getSettings();

    // 2. Коэффициенты сложности
    const wallFactor = { light: 1.0, medium: 1.25, heavy: 1.6 }[wallType] || 1;

    // 3. Эвристика объемов (Volume Heuristics)
    const volume = {
      points: Math.ceil(area * 0.85), // Точки
      strobe: Math.ceil(area * 0.6), // Штроба
      cable: Math.ceil(area * 4.8), // Кабель
      boxes: Math.ceil(area * 0.85), // Подрозетники
      shield: Math.ceil(area / 15) + 2, // Модули щита
    };

    // 4. Расчет стоимости работ
    const workCost =
      volume.points * (prices.work_point || 1500) +
      volume.strobe * (prices.work_strobe || 1500) * wallFactor +
      volume.cable * (prices.work_cable || 450) +
      (prices.work_shield_install || 18000);

    // 5. Расчет материалов
    const matCost = Math.ceil(area * (prices.material_m2 || 4500));

    return {
      area,
      wallType,
      volume,
      costs: {
        work: Math.ceil(workCost),
        material: matCost,
        total: Math.ceil(workCost + matCost),
      },
    };
  }

  /**
   * Создать Лид (Сохранить расчет)
   */
  static async createLead(userId, estimate) {
    return await db.createLead(userId, {
      area: estimate.area,
      wallType: estimate.wallType,
      totalWork: estimate.costs.work,
      totalMat: estimate.costs.material,
    });
  }

  /**
   * Создать Заказ (Конверсия из Лида)
   */
  static async createOrder(userId, leadId) {
    // Используем транзакционный метод из db.js
    return await db.createOrder(userId, leadId);
  }

  /**
   * Взять заказ в работу (Assign)
   */
  static async takeOrder(orderId, userId) {
    // Проверка роли
    const userRes = await db.query(
      "SELECT role, first_name FROM users WHERE telegram_id = $1",
      [userId],
    );
    const user = userRes.rows[0];

    if (!user || !["admin", "manager"].includes(user.role)) {
      throw new Error("ACCESS_DENIED");
    }

    await db.query(
      `UPDATE orders SET assignee_id = $1, status = 'work', updated_at = NOW() WHERE id = $2`,
      [userId, orderId],
    );

    return user; // Возвращаем данные мастера
  }

  /**
   * Обновить статус заказа
   * Возвращает финансовые данные, если заказ закрыт
   */
  static async updateStatus(orderId, newStatus, userId) {
    await db.query(
      `UPDATE orders SET status = $1, assignee_id = $2, updated_at = NOW() WHERE id = $3`,
      [newStatus, userId, orderId],
    );

    // Если статус "Выполнен", считаем деньги
    if (newStatus === ORDER_STATUS.DONE) {
      return await this._calculateFinancialSplit(orderId);
    }
    return null;
  }

  /**
   * 💰 Приватный метод: Расчет распределения денег (ERP)
   */
  static async _calculateFinancialSplit(orderId) {
    const res = await db.query(
      `
            SELECT l.total_work_cost 
            FROM orders o 
            JOIN leads l ON o.lead_id = l.id 
            WHERE o.id = $1
        `,
      [orderId],
    );

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
        staff: prices.staff_percent,
      },
    };
  }
}

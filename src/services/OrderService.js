/**
 * @file src/services/OrderService.js
 * @description Бизнес-логика CRM.
 * Калькулятор смет, Управление заказами, Финансовое закрытие.
 * @version 7.0.0 (Enterprise Logic)
 */

import { db } from "../db.js";
import { ORDER_STATUS } from "../constants.js";

export class OrderService {
  // =========================================================================
  // 🧮 КАЛЬКУЛЯТОР (ESTIMATION ENGINE)
  // =========================================================================

  /**
   * Расчет предварительной сметы по алгоритму "Умные точки"
   * @param {number} area - Площадь (м2)
   * @param {number} rooms - Количество комнат
   * @param {string} wallType - Тип стен (concrete, brick, gasblock)
   */
  static async calculateEstimate(area, rooms, wallType) {
    const prices = await db.getSettings();

    // 1. Алгоритм объемов (Volume Calculation)
    const vol = {
      // (Площадь * 0.8) + (Комнаты * 5)
      points: Math.ceil(area * 0.8 + rooms * 5),
      // Силовые точки (Плита/Кондер): 1 на каждые 20 м2
      powerPoints: Math.ceil(area / 20),
      // Распред. коробки: 1 на комнату
      boxes: rooms,
      // Штроба: Грубая оценка ~ 1.2м на м2 (или можно привязать к точкам)
      strobe: Math.ceil(area * 1.2),
      // Кабель: ~ 5.5м на м2
      cable: Math.ceil(area * 5.5),
      // Щит: 12 модулей мин + 2 на каждую комнату
      shieldModules: 12 + rooms * 2,
    };

    // 2. Определение цен (Pricing Strategy)
    let pPoint = 0,
      pStrobe = 0;

    switch (wallType) {
      case "concrete": // Бетон
        pPoint = prices.price_point_concrete || 1500;
        pStrobe = prices.price_strobe_concrete || 1750;
        break;
      case "brick": // Кирпич
        pPoint = prices.price_point_brick || 1000;
        pStrobe = prices.price_strobe_brick || 1100;
        break;
      default: // Газоблок (light)
        pPoint = prices.price_point_gasblock || 800;
        pStrobe = prices.price_strobe_gasblock || 800;
    }

    // 3. Расчет стоимости работ (Labor Cost)
    const cost = {
      points: (vol.points + vol.powerPoints) * pPoint,
      strobe: vol.strobe * pStrobe,
      boxes:
        vol.boxes *
        ((prices.price_box_install || 600) +
          (prices.price_box_assembly || 3000)),
      shield: vol.shieldModules * (prices.price_shield_module || 1750),
      cable: vol.cable * (prices.price_cable_m || 400),
    };

    const totalWork = Object.values(cost).reduce((a, b) => a + b, 0);

    // 4. Материал (Roughly estimate)
    // Если нет настройки material_m2, берем 4000
    const matPrice = prices.material_m2 || 4000;
    const totalMat = Math.ceil(area * matPrice);

    return {
      params: { area, rooms, wallType },
      volume: vol,
      costs: {
        work: Math.ceil(totalWork),
        material: totalMat,
        total: Math.ceil(totalWork + totalMat),
      },
    };
  }

  // =========================================================================
  // 🏗 ORDER MANAGEMENT (CRUD)
  // =========================================================================

  /**
   * Создание заказа (Конверсия из калькулятора)
   */
  static async createOrder(userId, estimate) {
    return await db.createOrder(userId, {
      area: estimate.params.area,
      rooms: estimate.params.rooms,
      wallType: estimate.params.wallType,
      estimatedPrice: estimate.costs.total,
    });
  }

  /**
   * Назначение мастера (Взять в работу)
   */
  static async assignMaster(orderId, managerId) {
    // Проверяем роль через SQL (или доверяем боту, здесь для скорости просто апдейт)
    await db.query(
      `UPDATE orders SET assignee_id = $1, status = 'work', updated_at = NOW() WHERE id = $2`,
      [managerId, orderId],
    );
  }

  /**
   * 🤖 AUTO-ASSIGN: Назначить случайного свободного менеджера
   * Вызывается, если заказ висит долго.
   */
  static async autoAssignMaster(orderId) {
    // Берем всех менеджеров/админов
    const res = await db.query(
      "SELECT telegram_id FROM users WHERE role IN ('manager', 'admin')",
    );
    if (res.rows.length === 0) return null;

    // Выбираем случайного (Simple Load Balancer)
    const randomMaster = res.rows[Math.floor(Math.random() * res.rows.length)];

    await this.assignMaster(orderId, randomMaster.telegram_id);
    return randomMaster.telegram_id;
  }

  // =========================================================================
  // 💰 ФИНАНСОВОЕ ЗАКРЫТИЕ (CLOSING)
  // =========================================================================

  /**
   * Закрытие объекта. Самый важный метод.
   * @param {number} orderId
   * @param {number} finalSum - Итоговая сумма, которую заплатил клиент
   * @param {number} walletId - ID кошелька, куда упали деньги
   * @param {number} userId - Кто закрывает заказ
   */
  static async completeOrder(orderId, finalSum, walletId, userId) {
    return db.transaction(async (client) => {
      // 1. Считаем расходы объекта
      const expRes = await client.query(
        "SELECT SUM(amount) as total FROM object_expenses WHERE order_id = $1",
        [orderId],
      );
      const expenses = parseFloat(expRes.rows[0].total || 0);

      // 2. Считаем чистую прибыль
      const profit = finalSum - expenses;

      // 3. Считаем долю мастера
      const settingsRes = await client.query(
        "SELECT value FROM settings WHERE key = 'percent_staff'",
      );
      const staffPercent = (settingsRes.rows[0]?.value || 80) / 100;
      const masterSalary = Math.floor(profit * staffPercent);

      // 4. Обновляем заказ (Статус DONE)
      await client.query(
        `UPDATE orders SET
                status = 'done',
                final_price = $1,
                final_profit = $2,
                end_date = NOW(),
                updated_at = NOW()
             WHERE id = $3`,
        [finalSum, profit, orderId],
      );

      // 5. Проводим приход денег в кассу (Income)
      await client.query(
        `UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
        [finalSum, walletId],
      );

      // 6. Пишем лог транзакции
      await client.query(
        `INSERT INTO transactions (account_id, user_id, amount, type, category, comment, created_at)
             VALUES ($1, $2, $3, 'income', 'order_payment', $4, NOW())`,
        [walletId, userId, finalSum, `Закрытие заказа #${orderId}`],
      );

      return {
        profit,
        expenses,
        masterSalary,
      };
    });
  }

  // =========================================================================
  // 📊 READ (GETTERS)
  // =========================================================================

  static async getManagerActiveOrders(managerId) {
    const sql = `
        SELECT o.id, o.status, o.created_at, o.total_price, o.area, o.wall_type,
               u.first_name as client_name, u.phone as client_phone, u.username as client_user
        FROM orders o
        JOIN users u ON o.user_id = u.telegram_id
        WHERE o.assignee_id = $1 AND o.status IN ('work', 'discuss')
        ORDER BY o.updated_at DESC
    `;
    const res = await db.query(sql, [managerId]);
    return res.rows;
  }

  static async getUserOrders(userId) {
    const sql = `
        SELECT o.id, o.status, o.created_at, o.total_price,
               m.first_name as manager_name
        FROM orders o
        LEFT JOIN users m ON o.assignee_id = m.telegram_id
        WHERE o.user_id = $1
        ORDER BY o.created_at DESC LIMIT 5
    `;
    const res = await db.query(sql, [userId]);
    return res.rows;
  }

  static async getGlobalStats() {
    const funnel = await db.query(
      `SELECT status, COUNT(*) as count, SUM(total_price) as money FROM orders GROUP BY status`,
    );
    return { funnel: funnel.rows };
  }
}

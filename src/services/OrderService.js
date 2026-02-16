/**
 * @file src/services/OrderService.js
 * @description Сервисный слой бизнес-логики (Business Logic Layer).
 * Отвечает за расчет смет, управление жизненным циклом заказа и финансовые транзакции.
 * @architecture Service Repository Pattern
 * @version 3.0.0 (Complex Calculation & Transactions)
 */

import { db } from "../db.js";
import { PRICING, ESTIMATE_RULES, WALL_FACTORS } from "../constants.js";

const fmt = (val) =>
  new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(val);

export const OrderService = {
  /**
   * 🧮 Умный расчет сметы на основе 3 типов стен.
   * @param {number} area - Площадь помещения
   * @param {number} rooms - Кол-во комнат
   * @param {string} wallType - Тип стен (wall_soft, wall_brick, wall_concrete)
   * @returns {Promise<Object>} Детализированный расчет
   */
  async calculateEstimate(area, rooms, wallType) {
    // 1. Получаем актуальные настройки (цены) из БД или берем дефолтные из constants
    const settings = await db.getSettings();

    const getPrice = (dbKey, defaultVal) =>
      settings[dbKey] ? Number(settings[dbKey]) : defaultVal;

    // 2. Определяем цены в зависимости от сложности стен
    let priceStrobe, priceDrill;

    switch (wallType) {
      case "wall_soft": // ГКЛ / Блок
        priceStrobe = getPrice("price_strobe_soft", PRICING.rough.strobeSoft);
        priceDrill = getPrice(
          "price_drill_hole_soft",
          PRICING.rough.drillHoleSoft,
        );
        break;
      case "wall_brick": // Кирпич
        priceStrobe = getPrice("price_strobe_brick", PRICING.rough.strobeBrick);
        priceDrill = getPrice(
          "price_drill_hole_brick",
          PRICING.rough.drillHoleBrick,
        );
        break;
      case "wall_concrete": // Бетон
      default:
        priceStrobe = getPrice(
          "price_strobe_concrete",
          PRICING.rough.strobeConcrete,
        );
        priceDrill = getPrice(
          "price_drill_hole_concrete",
          PRICING.rough.drillHoleConcrete,
        );
        break;
    }

    // 3. Эвристический расчет объемов (Heuristics)
    // Формулы:
    // Кабель = Площадь * 3.5
    // Штроба = Площадь * 0.9 (в бетоне меньше, в кирпиче больше, берем среднее)
    // Точки = Площадь * 0.75 + (Комнаты * 2)

    const volCable = Math.ceil(area * ESTIMATE_RULES.cablePerSqm);
    const volStrobe = Math.ceil(area * ESTIMATE_RULES.strobePerSqm);
    const volPoints = Math.ceil(area * ESTIMATE_RULES.pointsPerSqm) + rooms * 2;

    // 4. Расчет стоимости работ (Labor Cost)
    const costStrobe = volStrobe * priceStrobe;
    const costDrilling = volPoints * priceDrill; // Сверление лунок
    const costCable =
      volCable * getPrice("price_cable_laying", PRICING.rough.cableLaying);
    const costPointsFinish =
      volPoints *
      getPrice("price_socket_install", PRICING.finish.socketInstall);

    // Щиток (база 12 модулей + 1 модуль на каждые 10м2 свыше 40м2)
    const shieldModules = Math.max(12, Math.ceil(area / 5));
    const costShield =
      shieldModules *
      getPrice("price_shield_module", PRICING.finish.shieldModule);

    // 5. Итоговая сумма
    const laborTotal =
      costStrobe + costDrilling + costCable + costPointsFinish + costShield;

    // Добавляем % на материалы (Materials Factor)
    const materialsTotal = laborTotal * PRICING.materialsFactor;

    // Округляем до 5000 тенге для красоты
    const grandTotal = Math.ceil((laborTotal + materialsTotal) / 5000) * 5000;

    return {
      totalPrice: grandTotal,
      volumes: {
        cable: volCable,
        strobe: volStrobe,
        points: volPoints,
        shield: shieldModules,
      },
      prices: {
        strobe: priceStrobe,
        drill: priceDrill,
      },
      wallType,
    };
  },

  /**
   * 📝 Создание нового заказа в БД.
   */
  async createOrder(userId, calcResult, meta = {}) {
    const { totalPrice, volumes, wallType } = calcResult;

    // Формируем JSON с деталями
    const details = {
      volumes,
      wallType,
      meta,
    };

    // SQL Insert
    const res = await db.query(
      `INSERT INTO orders 
            (user_id, client_name, client_phone, city, area, rooms, total_price, details, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new')
            RETURNING *`,
      [
        userId,
        meta.clientName || "Не указан",
        meta.clientPhone || null,
        meta.city || "Алматы",
        meta.area || 0,
        meta.rooms || 0,
        totalPrice,
        details,
      ],
    );
    return res.rows[0];
  },

  /**
   * 📝 Создание ручного заказа (для Админа).
   */
  async createManualOrder(adminId, data) {
    const details = { source: "manual", created_by: adminId };

    const res = await db.query(
      `INSERT INTO orders 
            (user_id, client_name, client_phone, area, total_price, details, status)
            VALUES ($1, $2, $3, $4, $5, $6, 'new')
            RETURNING *`,
      [
        adminId,
        data.clientName,
        data.clientPhone,
        data.area,
        data.price,
        details,
      ],
    );
    return res.rows[0];
  },

  /**
   * 🤝 Назначение мастера на заказ.
   */
  async assignMaster(orderId, masterId) {
    const res = await db.query(
      `UPDATE orders 
             SET assignee_id = $1, status = 'work', updated_at = NOW() 
             WHERE id = $2 
             RETURNING *`,
      [masterId, orderId],
    );
    return res.rows[0];
  },

  /**
   * 🏁 Закрытие заказа с транзакцией (Money Flow).
   * 1. Считает расходы.
   * 2. Вычисляет прибыль.
   * 3. Пополняет кассу.
   * 4. Закрывает заказ.
   */
  async completeOrder(orderId, finalSum, walletId, userId) {
    const client = await db.pool.connect();

    try {
      await client.query("BEGIN"); // Старт транзакции

      // 1. Получаем сумму расходов
      const expRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE order_id = $1`,
        [orderId],
      );
      const expenses = parseFloat(expRes.rows[0].total);

      // 2. Считаем экономику
      const revenue = parseFloat(finalSum);
      const netProfit = revenue - expenses;

      // Доля мастера (например 40%) и Бизнеса (60%) - можно вынести в настройки
      const masterShare = netProfit > 0 ? netProfit * 0.4 : 0;
      const businessShare = netProfit - masterShare;

      // 3. Обновляем баланс кассы
      await client.query(
        `UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
        [revenue, walletId],
      );

      // 4. Закрываем заказ
      const updateRes = await client.query(
        `UPDATE orders 
                 SET status = 'done', 
                     final_price = $1, 
                     profit = $2, 
                     updated_at = NOW() 
                 WHERE id = $3 
                 RETURNING *`,
        [revenue, netProfit, orderId],
      );

      // 5. Логируем транзакцию (опционально можно создать таблицу transactions)
      // ...

      await client.query("COMMIT"); // Фиксация

      return {
        order: updateRes.rows[0],
        revenue,
        expenses,
        profit: netProfit,
        masterShare,
        businessShare,
      };
    } catch (e) {
      await client.query("ROLLBACK"); // Откат при ошибке
      console.error("Transaction Failed:", e);
      throw e;
    } finally {
      client.release();
    }
  },

  /**
   * 🔍 Получение активных заказов (фильтр по роли).
   */
  async getActiveOrders(userId, role) {
    let sql = `SELECT * FROM orders WHERE status IN ('new', 'work', 'discuss')`;
    const params = [];

    if (role === "client") {
      sql += ` AND user_id = $1`;
      params.push(userId);
    } else if (role === "manager") {
      // Менеджер видит свои заказы + новые (чтобы взять в работу)
      sql += ` AND (assignee_id = $1 OR assignee_id IS NULL)`;
      params.push(userId);
    }
    // Admin видит всё

    sql += ` ORDER BY created_at DESC LIMIT 10`;

    const res = await db.query(sql, params);

    // Подсчитаем сумму расходов для каждого заказа на лету
    for (let order of res.rows) {
      const exp = await db.query(
        `SELECT SUM(amount) as s FROM expenses WHERE order_id = $1`,
        [order.id],
      );
      order.expenses_sum = exp.rows[0].s || 0;
    }

    return res.rows;
  },

  /**
   * 🖼 Генератор текста сметы для сообщений.
   */
  formatEstimateMessage(estimate) {
    const { totalPrice, volumes, prices, wallType } = estimate;

    const wallNames = {
      wall_soft: "⬜️ ГКЛ / Блок (Легко)",
      wall_brick: "🧱 Кирпич (Средне)",
      wall_concrete: "🏗 Бетон (Сложно)",
    };

    return (
      `📋 <b>ПРЕДВАРИТЕЛЬНАЯ СМЕТА</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `🧱 Тип стен: <b>${wallNames[wallType]}</b>\n\n` +
      `📊 <b>Объемы работ (прим.):</b>\n` +
      `▫️ Кабель: ~${volumes.cable} м\n` +
      `▫️ Штроба: ~${volumes.strobe} м (по ${fmt(prices.strobe)})\n` +
      `▫️ Точки: ~${volumes.points} шт (по ${fmt(prices.drill)})\n` +
      `▫️ Щит: ${volumes.shield} модулей\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `🔩 <b>Материалы (черновые):</b> Включены (~40%)\n` +
      `💰 <b>ИТОГО ПОД КЛЮЧ: ~${fmt(totalPrice)}</b>\n\n` +
      `<i>* Цена является ориентировочной. Точный расчет — после выезда мастера.</i>`
    );
  },
};

/**
 * @file src/services/OrderService.js
 * @description Слой бизнес-логики (Business Logic Layer).
 * Отвечает за калькуляцию смет, управление жизненным циклом заказа,
 * финансовое распределение и формирование "слепков" (snapshots) данных.
 * @version 8.3.0 (Universal: Bot + Web Support)
 */

import { db } from "../db.js";
import { PRICING, ESTIMATE_RULES } from "../constants.js";

// Форматтер валюты (для красивого вывода 1 000 000 ₸)
const currencyFormatter = new Intl.NumberFormat("ru-RU", {
  style: "decimal",
  maximumFractionDigits: 0,
});

export class OrderService {
  // =========================================================================
  // 🧮 КАЛЬКУЛЯТОР (ESTIMATION ENGINE)
  // =========================================================================

  /**
   * Рассчитывает детальную смету на основе параметров помещения.
   * Использует динамические цены из БД, падая до дефолтных значений (fallback).
   * * @param {number} area - Площадь помещения (м2)
   * @param {number} rooms - Количество комнат
   * @param {string} wallType - Тип стен ('concrete' | 'brick')
   * @returns {Promise<Object>} Полный объект расчета (Snapshot)
   */
  static async calculateEstimate(area, rooms, wallType) {
    // 1. Загружаем актуальные настройки (цены) из БД с кэшированием
    const settings = await db.getSettings();

    /**
     * Хелпер: Безопасное получение цены
     * @param {string} key - Ключ настройки
     * @param {number} fallback - Значение по умолчанию
     */
    const getPrice = (key, fallback) => {
      const val = settings[key];
      // Проверка на null/undefined, но разрешаем 0
      return val !== undefined && val !== null && !isNaN(val)
        ? Number(val)
        : fallback;
    };

    const isConcrete = wallType === "concrete";

    // 2. Формируем конфигурацию цен для текущего расчета
    const prices = {
      // --- Черновые работы (Rough) ---
      strobe: isConcrete
        ? getPrice("price_strobe_concrete", PRICING.rough.strobeConcrete)
        : getPrice("price_strobe_brick", PRICING.rough.strobeBrick),

      drill: isConcrete
        ? getPrice("price_drill_hole_concrete", PRICING.rough.drillHoleConcrete)
        : getPrice("price_drill_hole_brick", PRICING.rough.drillHoleBrick),

      cable: getPrice("price_cable_laying", PRICING.rough.cableLaying),
      boxInstall: getPrice(
        "price_socket_box_install",
        PRICING.rough.socketBoxInstall,
      ), // Вмазка
      junction: getPrice(
        "price_junction_box_assembly",
        PRICING.rough.junctionBoxAssembly,
      ),

      // --- Чистовые работы (Finish) ---
      socketInstall: getPrice(
        "price_socket_install",
        PRICING.finish.socketInstall,
      ), // Механизмы
      shield: getPrice("price_shield_module", PRICING.finish.shieldModule),
      led: getPrice("price_led_strip", PRICING.finish.ledStrip),
      lamp: getPrice("price_lamp_install", PRICING.finish.lampInstall),

      // --- Коэффициенты ---
      matFactor: getPrice("material_factor", PRICING.materialsFactor),
    };

    // 3. Эвристика объемов (Volume Heuristics)
    // Рассчитываем предполагаемые количества на основе площади и комнат
    const vol = {
      cable: Math.ceil(area * ESTIMATE_RULES.cablePerSqm),
      strobe: Math.ceil(area * ESTIMATE_RULES.strobePerSqm),
      // Точки: (Площадь * X) + (Комнаты * Y)
      points: Math.ceil(area * ESTIMATE_RULES.pointsPerSqm + rooms * 2),
      // Распайки: 1 на комнату + кухня + коридор
      boxes: rooms + 2,
      // Щит: Минимум + запас
      shieldModules: Math.max(ESTIMATE_RULES.minShieldModules, 10 + rooms * 2),
      // LED: Условно периметр одной комнаты
      ledStrip: rooms * 5,
    };

    // 4. Финансовая калькуляция

    // A. Черновой этап
    const roughBreakdown = {
      drillCost: vol.points * prices.drill,
      strobeCost: vol.strobe * prices.strobe,
      boxInstallCost: vol.points * prices.boxInstall,
      cableCost: vol.cable * prices.cable,
      junctionCost: vol.boxes * prices.junction,
    };
    const roughTotal = Object.values(roughBreakdown).reduce(
      (sum, v) => sum + v,
      0,
    );

    // B. Чистовой этап
    const finishBreakdown = {
      mechanismsCost: vol.points * prices.socketInstall,
      shieldCost: vol.shieldModules * prices.shield,
      ledCost: vol.ledStrip * prices.led,
    };
    const finishTotal = Object.values(finishBreakdown).reduce(
      (sum, v) => sum + v,
      0,
    );

    // C. Агрегация
    const workTotal = roughTotal + finishTotal;
    const totalMaterial = Math.ceil(workTotal * prices.matFactor);
    const grandTotal = Math.ceil(workTotal + totalMaterial);

    // Возвращаем структуру Snapshot
    return {
      params: { area, rooms, wallType }, // Входные данные
      volume: vol, // Рассчитанные объемы
      pricesApplied: prices, // Цены на момент расчета (важно для истории!)
      breakdown: {
        // Детализация для отображения
        rough: roughBreakdown,
        finish: finishBreakdown,
      },
      totals: {
        // Итоговые суммы
        rough: Math.ceil(roughTotal),
        finish: Math.ceil(finishTotal),
        workTotal: Math.ceil(workTotal),
        material: totalMaterial,
        grandTotal: grandTotal,
      },
    };
  }

  // =========================================================================
  // 🏗 УПРАВЛЕНИЕ ЗАКАЗАМИ (ORDER LIFECYCLE)
  // =========================================================================

  /**
   * Создает заказ через Telegram-бота.
   * @param {Object} user - User entity из Telegram (id, username...)
   * @param {Object} calcResult - Результат calculateEstimate (Snapshot)
   * @param {Object} [context] - Доп. контекст (город, тип услуги)
   */
  static async createOrder(user, calcResult, context = {}) {
    const orderData = {
      city: context.city || user.city || "Не указан",
      serviceType: context.serviceType || "electric",
    };

    // Передаем calcResult как 3-й аргумент (JSONB details)
    return db.createOrder(user.telegram_id, orderData, calcResult);
  }

  /**
   * Создает заказ вручную через Web-админку.
   * Генерирует "фейковый" ID для клиентов без Telegram.
   */
  static async createManualOrder(
    adminId,
    { clientName, clientPhone, area, price, city },
  ) {
    // 1. Генерация Pseudo-ID (на основе телефона)
    // Берем последние 9 цифр телефона, либо текущий timestamp
    const phoneDigits = clientPhone.replace(/\D/g, "");
    const fakeTgId = parseInt(phoneDigits.slice(-9)) || Date.now();

    // 2. Регистрация "теневого" пользователя
    await db.upsertUser(fakeTgId, clientName, "manual_client", clientPhone);

    // 3. Создание упрощенного снэпшота (так как детального расчета нет)
    // Это нужно, чтобы фронтенд и БД не ломались при чтении JSONB
    const manualSnapshot = {
      params: { area: Number(area), rooms: 1, wallType: "unknown" },
      volume: { points: 0, cable: 0, strobe: 0 },
      totals: {
        grandTotal: parseFloat(price),
        rough: 0,
        finish: 0,
        workTotal: parseFloat(price),
        material: 0,
      },
      isManual: true,
      note: "Заказ создан вручную администратором",
    };

    const orderData = {
      city: city || "Алматы",
      serviceType: "manual_electric",
    };

    return db.createOrder(fakeTgId, orderData, manualSnapshot);
  }

  /**
   * Завершение заказа с финансовой проводкой.
   * Выполняется в транзакции: обновление статуса + начисление в кассу.
   * * @param {number} orderId
   * @param {number} finalSum - Фактическая сумма, которую заплатил клиент
   * @param {number} walletId - ID кассы, куда упали деньги
   * @param {number} userId - Кто закрывает заказ (админ/менеджер)
   */
  static async completeOrder(orderId, finalSum, walletId, userId) {
    return db.transaction(async (client) => {
      // 1. Считаем расходы, занесенные во время выполнения работ
      const expRes = await client.query(
        "SELECT COALESCE(SUM(amount), 0) as total FROM object_expenses WHERE order_id = $1",
        [orderId],
      );
      const expenses = parseFloat(expRes.rows[0].total);

      // 2. Расчет чистой прибыли
      const profit = finalSum - expenses;

      // 3. Распределение долей (Бизнес / Исполнитель)
      const settings = await db.getSettings();
      const businessPercent = (settings["percent_business"] || 20) / 100;

      const businessShare = Math.floor(profit * businessPercent);
      const masterShare = profit - businessShare;

      // 4. Обновление статуса заказа
      await client.query(
        `UPDATE orders SET
                    status = 'done',
                    final_price = $1,
                    final_profit = $2,
                    updated_at = NOW()
                 WHERE id = $3`,
        [finalSum, profit, orderId],
      );

      // 5. Финансовая проводка (Income)
      // Обновляем баланс кассы
      const balanceRes = await client.query(
        `UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2 RETURNING balance`,
        [finalSum, walletId],
      );

      if (balanceRes.rowCount === 0) throw new Error("Касса не найдена");

      // 6. Аудит (Лог транзакции)
      await client.query(
        `INSERT INTO transactions (account_id, user_id, amount, type, category, comment, created_at)
                 VALUES ($1, $2, $3, 'income', 'order_payment', $4, NOW())`,
        [
          walletId,
          userId,
          finalSum,
          `Закрытие заказа #${orderId}. Прибыль: ${currencyFormatter.format(profit)}`,
        ],
      );

      return { profit, expenses, masterShare, businessShare };
    });
  }

  // =========================================================================
  // 📊 АНАЛИТИКА И ВЫБОРКИ (DATA FETCHING)
  // =========================================================================

  /**
   * Получает список активных заказов для Kanban/Dashboard.
   * @param {number} userId - ID пользователя
   * @param {string} role - Роль пользователя
   */
  static async getActiveOrders(userId, role) {
    let sql = `
            SELECT 
                o.id, 
                o.status, 
                o.created_at, 
                o.total_price, 
                o.details, -- Важно: тянем JSONB для фронтенда
                o.city,
                u.first_name as client_name, 
                u.phone as client_phone, 
                u.username as client_username,
                (SELECT COALESCE(SUM(amount), 0) FROM object_expenses WHERE order_id = o.id) as expenses_sum
            FROM orders o
            JOIN users u ON o.user_id = u.telegram_id
            WHERE o.status IN ('new', 'work', 'discuss')
        `;

    const params = [];

    // Ограничение видимости для менеджеров
    if (role === "manager") {
      sql += ` AND o.assignee_id = $1`;
      params.push(userId);
    }

    sql += ` ORDER BY o.updated_at DESC`;

    const res = await db.query(sql, params);
    return res.rows;
  }

  /**
   * Генерирует текстовое представление сметы для Telegram.
   * @param {Object} calc - Результат calculateEstimate
   * @returns {string} HTML-строка
   */
  static formatEstimateMessage(calc) {
    const f = (n) => currencyFormatter.format(n);
    const wallName =
      calc.params.wallType === "concrete"
        ? "🏗 Бетон (Монолит)"
        : "🧱 Кирпич (Блок)";
    const t = calc.totals;
    const v = calc.volume;

    return (
      `🏗 <b>ПРЕДВАРИТЕЛЬНЫЙ РАСЧЕТ</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `📐 Площадь: <b>${calc.params.area} м²</b>\n` +
      `🏠 Стены: <b>${wallName}</b>\n\n` +
      `<b>📋 Ориентировочные объемы:</b>\n` +
      `▫️ Электроточек: ~${v.points} шт\n` +
      `▫️ Кабеля (ГОСТ): ~${v.cable} м\n` +
      `▫️ Штробления: ~${v.strobe} м\n` +
      `▫️ Щит: ~${v.shieldModules} модулей\n\n` +
      `<b>💰 Смета работ и материалов:</b>\n` +
      `🛠 Черновые работы: ${f(t.rough)} ₸\n` +
      `✨ Чистовые работы: ${f(t.finish)} ₸\n` +
      `🔌 Материалы (прогноз): ${f(t.material)} ₸\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `🏁 <b>ИТОГО ПОД КЛЮЧ: ~${f(t.grandTotal)} ₸</b>\n\n` +
      `<i>ℹ️ Точная смета фиксируется в договоре после бесплатного замера.</i>`
    );
  }
}

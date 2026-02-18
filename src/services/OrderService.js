/**
 * @file src/services/OrderService.js
 * @description Сервис бизнес-логики заказов (Core Business Logic v9.0.0).
 * Отвечает за:
 * 1. Сверхточный инженерный расчет сметы (Detailed Complex Estimation).
 * 2. Финансовое ядро (Net Profit, Expenses, Custom Overrides).
 * 3. Динамическое ценообразование на основе данных из БД.
 * 4. Автоматическую генерацию спецификации материалов (BOM Generator).
 * 5. Управление жизненным циклом заказа (State Machine).
 *
 * Архитектура: Enterprise ERP Module (Self-Contained).
 *
 * @module OrderService
 * @version 9.0.0 (Enterprise ERP Edition)
 */

import * as db from "../database/index.js";

// =============================================================================
// 1. 🚦 STATE MACHINE & CONFIGURATION
// =============================================================================

export const ORDER_STATUS = Object.freeze({
  DRAFT: "draft",
  NEW: "new",
  PROCESSING: "processing",
  CONFIRMED: "confirmed",
  ON_HOLD: "on_hold",
  WORK: "work",
  MATERIAL_WAIT: "material",
  PENDING_PAYMENT: "payment",
  DONE: "done",
  CANCELED: "cancel",
  DISPUTE: "dispute",
  ARCHIVED: "archived",
});

/**
 * Словарь для маппинга системных ключей стен в читаемый вид (Исправление бага "Стены: wall_")
 */
const WALL_NAMES = Object.freeze({
  wall_gas: "Газоблок / ГКЛ",
  wall_brick: "Кирпич",
  wall_concrete: "Бетон / Монолит",
});

/**
 * Ключи настроек в таблице `settings` (Расширенная модель v9.0)
 */
const DB_KEYS = Object.freeze({
  // Штробы
  STROBE_GAS: "price_strobe_gas",
  STROBE_BRICK: "price_strobe_brick",
  STROBE_CONCRETE: "price_strobe_concrete",

  // Точки (Детализация)
  POINT_SOCKET: "price_point_socket",
  POINT_BOX: "price_point_box",
  POINT_CHANDELIER: "price_point_chandelier",

  // Кабель (База + Надбавки)
  CABLE_BASE: "price_cable_base",
  CABLE_CORRUGATED_ADDER: "price_cable_corrugated",
  CABLE_CHANNEL_ADDER: "price_cable_channel",

  // Щит
  SHIELD_BASE_24: "price_shield_base_24",
  SHIELD_EXTRA_MODULE: "price_shield_extra_module",

  MAT_FACTOR: "material_factor",
});

/**
 * Инженерные эвристики (Heuristics v9.0).
 * Статистические формулы для расчета идеальных объемов работ.
 */
const ESTIMATE_RULES = Object.freeze({
  cablePerSqm: 6.5,
  cableRatioCorr: 0.7, // 70% кабеля в гофре
  cableRatioBase: 0.2, // 20% голый кабель (потолок/лотки)
  cableRatioChan: 0.1, // 10% в кабель-канале

  strobeFactor: 0.9,

  socketsPerSqm: 0.7, // Розеток/выключателей на м2
  boxesPerRoom: 1.5, // Распредкоробок на комнату
  chandeliersPerRoom: 1.0, // Люстр на комнату

  minShieldModules: 12,
  shieldModulesStep: 15, // +1 модуль за каждые 15м2 свыше 40м2
});

/**
 * Цены по умолчанию (Fallback Strategy v9.0).
 * Строго по ТЗ для версии 9.0.0.
 */
const DEFAULT_PRICING = Object.freeze({
  strobe: { concrete: 1000, brick: 700, gas: 500 },
  points: { socket: 800, box: 1200, chandelier: 3500 },
  cable: { base: 455, corrugatedAdder: 200, channelAdder: 90 },
  shield: { base24: 9000, extraModule: 500 },
  common: { matFactor: 0.45 },
});

// =============================================================================
// 2. 🧠 BUSINESS LOGIC IMPLEMENTATION
// =============================================================================

export const OrderService = {
  ORDER_STATUS,

  /**
   * 🏗 Расширенный расчет сметы (ERP Complex Estimate v9.0).
   *
   * @param {number} area - Площадь (м²)
   * @param {number} rooms - Комнат (шт)
   * @param {string} wallKey - Системный ключ стен ('wall_gas', 'wall_brick', 'wall_concrete')
   */
  async calculateComplexEstimate(area, rooms, wallKey) {
    const settings = await db.getSettings();

    const getPrice = (dbKey, fallbackValue) => {
      const val = parseFloat(settings[dbKey]);
      return !isNaN(val) && val > 0 ? val : fallbackValue;
    };

    // 1. Извлечение тарифов (Pricing Extraction)
    let priceStrobe = 0;
    switch (wallKey) {
      case "wall_gas":
        priceStrobe = getPrice(DB_KEYS.STROBE_GAS, DEFAULT_PRICING.strobe.gas);
        break;
      case "wall_brick":
        priceStrobe = getPrice(
          DB_KEYS.STROBE_BRICK,
          DEFAULT_PRICING.strobe.brick,
        );
        break;
      case "wall_concrete":
      default:
        priceStrobe = getPrice(
          DB_KEYS.STROBE_CONCRETE,
          DEFAULT_PRICING.strobe.concrete,
        );
        break;
    }

    const pricePointSocket = getPrice(
      DB_KEYS.POINT_SOCKET,
      DEFAULT_PRICING.points.socket,
    );
    const pricePointBox = getPrice(
      DB_KEYS.POINT_BOX,
      DEFAULT_PRICING.points.box,
    );
    const pricePointChandelier = getPrice(
      DB_KEYS.POINT_CHANDELIER,
      DEFAULT_PRICING.points.chandelier,
    );

    const priceCableBase = getPrice(
      DB_KEYS.CABLE_BASE,
      DEFAULT_PRICING.cable.base,
    );
    const priceCableCorrAdd = getPrice(
      DB_KEYS.CABLE_CORRUGATED_ADDER,
      DEFAULT_PRICING.cable.corrugatedAdder,
    );
    const priceCableChanAdd = getPrice(
      DB_KEYS.CABLE_CHANNEL_ADDER,
      DEFAULT_PRICING.cable.channelAdder,
    );

    const priceShieldBase24 = getPrice(
      DB_KEYS.SHIELD_BASE_24,
      DEFAULT_PRICING.shield.base24,
    );
    const priceShieldExtra = getPrice(
      DB_KEYS.SHIELD_EXTRA_MODULE,
      DEFAULT_PRICING.shield.extraModule,
    );

    const matFactor = getPrice(
      DB_KEYS.MAT_FACTOR,
      DEFAULT_PRICING.common.matFactor,
    );

    // 2. Инженерный расчет объемов (Volume Calculus)
    const volStrobe = Math.ceil(area * ESTIMATE_RULES.strobeFactor);

    // Кабель
    const totalCable = Math.ceil(area * ESTIMATE_RULES.cablePerSqm);
    const volCableCorr = Math.ceil(totalCable * ESTIMATE_RULES.cableRatioCorr);
    const volCableBase = Math.ceil(totalCable * ESTIMATE_RULES.cableRatioBase);
    const volCableChan = totalCable - volCableCorr - volCableBase; // Остаток

    // Точки
    const volSockets = Math.ceil(area * ESTIMATE_RULES.socketsPerSqm);
    const volBoxes = Math.ceil(rooms * ESTIMATE_RULES.boxesPerRoom);
    const volChandeliers = Math.ceil(rooms * ESTIMATE_RULES.chandeliersPerRoom);
    const totalPoints = volSockets + volBoxes + volChandeliers;

    // Щит
    const volModules = Math.max(
      ESTIMATE_RULES.minShieldModules,
      Math.ceil(12 + Math.max(0, area - 40) / ESTIMATE_RULES.shieldModulesStep),
    );

    // 3. Калькуляция стоимости (Cost Aggregation)
    const costStrobe = volStrobe * priceStrobe;

    const costCableBase = volCableBase * priceCableBase;
    const costCableCorr = volCableCorr * (priceCableBase + priceCableCorrAdd);
    const costCableChan = volCableChan * (priceCableBase + priceCableChanAdd);
    const costCableTotal = costCableBase + costCableCorr + costCableChan;

    const costSockets = volSockets * pricePointSocket;
    const costBoxes = volBoxes * pricePointBox;
    const costChandeliers = volChandeliers * pricePointChandelier;
    const costPointsTotal = costSockets + costBoxes + costChandeliers;

    const costShield =
      volModules <= 24
        ? priceShieldBase24
        : priceShieldBase24 + (volModules - 24) * priceShieldExtra;

    // Итого Работа
    const totalWorkRaw =
      costStrobe + costCableTotal + costPointsTotal + costShield;
    const grandTotalWork = Math.ceil(totalWorkRaw / 500) * 500; // Округление до 500 ₸

    const infoMaterial = Math.ceil(grandTotalWork * matFactor);

    // 4. Формирование DTO ответа
    const estimateDTO = {
      params: {
        area,
        rooms,
        wallTypeRaw: wallKey,
        wallType: WALL_NAMES[wallKey] || wallKey, // ИСПРАВЛЕНИЕ: Читаемое название стен
      },
      volume: {
        points: totalPoints, // Для совместимости со старым кодом
        detailedPoints: {
          sockets: volSockets,
          boxes: volBoxes,
          chandeliers: volChandeliers,
        },
        strobe: volStrobe,
        cable: totalCable,
        detailedCable: {
          base: volCableBase,
          corrugated: volCableCorr,
          channel: volCableChan,
        },
        modules: volModules,
      },
      breakdown: {
        strobe: costStrobe,
        cable: costCableTotal,
        points: costPointsTotal,
        shield: costShield,
      },
      total: {
        work: grandTotalWork,
        material_info: infoMaterial,
        grandTotal: grandTotalWork,
      },
    };

    // 5. Внедрение новой функции: Спецификация материалов (BOM)
    estimateDTO.bom = this.generateMaterialSpecification(estimateDTO.volume);

    return estimateDTO;
  },

  /**
   * 🛠 НОВАЯ ФУНКЦИЯ: Авто-генератор спецификации (BOM Generator).
   * Прогнозирует список закупаемых материалов на основе объемов.
   */
  generateMaterialSpecification(volumes) {
    return [
      {
        name: "Кабель ВВГнг-LS 3x2.5 (Розетки)",
        qty: Math.ceil(volumes.cable * 0.65),
        unit: "м",
      },
      {
        name: "Кабель ВВГнг-LS 3x1.5 (Свет)",
        qty: Math.ceil(volumes.cable * 0.35),
        unit: "м",
      },
      {
        name: "Гофра ПВХ D20",
        qty: volumes.detailedCable.corrugated,
        unit: "м",
      },
      {
        name: "Кабель-канал 25x16",
        qty: volumes.detailedCable.channel,
        unit: "м",
      },
      {
        name: "Подрозетники D68",
        qty: volumes.detailedPoints.sockets,
        unit: "шт",
      },
      {
        name: "Распредкоробки 100x100",
        qty: volumes.detailedPoints.boxes,
        unit: "шт",
      },
      {
        name: "Автоматы 16A (Линии)",
        qty: Math.ceil(volumes.modules * 0.4),
        unit: "шт",
      },
      {
        name: "УЗО / Дифавтоматы",
        qty: Math.ceil(volumes.modules * 0.15),
        unit: "шт",
      },
      {
        name: "Клеммы WAGO (Уп.)",
        qty: Math.ceil(volumes.detailedPoints.boxes * 0.5),
        unit: "уп",
      },
    ];
  },

  /**
   * 📋 Выгрузка актуального прайс-листа для клиента.
   */
  async getPublicPricelist() {
    const settings = await db.getSettings();
    const getPrice = (dbKey, fallbackValue) => {
      const val = parseFloat(settings[dbKey]);
      return !isNaN(val) && val > 0 ? val : fallbackValue;
    };

    return {
      cable: getPrice(DB_KEYS.CABLE_BASE, DEFAULT_PRICING.cable.base),
      socket: getPrice(DB_KEYS.POINT_SOCKET, DEFAULT_PRICING.points.socket),
      strobeConcrete: getPrice(
        DB_KEYS.STROBE_CONCRETE,
        DEFAULT_PRICING.strobe.concrete,
      ),
      strobeBrick: getPrice(DB_KEYS.STROBE_BRICK, DEFAULT_PRICING.strobe.brick),
      strobeGas: getPrice(DB_KEYS.STROBE_GAS, DEFAULT_PRICING.strobe.gas),
      drillConcrete: "Включено в розетку", // Логика v9 объединяет лунку и монтаж
      shield:
        getPrice(DB_KEYS.SHIELD_BASE_24, DEFAULT_PRICING.shield.base24) +
        " (до 24 мод.)",
    };
  },

  /**
   * 📝 Создание заказа с инициализацией Финансового Блока (ERP Module).
   */
  async createOrder(userId, estimate) {
    // Формируем начальный финансовый слепок заказа
    const financials = {
      final_price: estimate.total.work, // Итоговая цена (можно будет менять вручную)
      total_expenses: 0, // Сумма всех расходов (такси, материалы за счет фирмы)
      net_profit: estimate.total.work, // Чистая прибыль (Цена - Расходы)
      expenses: [], // Массив истории расходов
    };

    const orderData = {
      area: estimate.params.area,
      price: estimate.total.work,
      details: { ...estimate, financials }, // Упаковываем всё в JSONB
    };

    return await db.createOrder(userId, orderData);
  },

  /**
   * 🔄 Смена статуса заказа.
   */
  async updateOrderStatus(orderId, newStatus) {
    const valid = Object.values(ORDER_STATUS);
    if (!valid.includes(newStatus))
      throw new Error(`Invalid status: ${newStatus}`);

    await db.query(
      "UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2",
      [newStatus, orderId],
    );
    return true;
  },

  /**
   * 📍 Сохранение метаданных (Адрес, Комментарий и т.д.).
   */
  async updateOrderDetails(orderId, key, value) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error("Заказ не найден");

    const details = order.details || {};
    details[key] = value;

    await db.query(
      "UPDATE orders SET details = $1, updated_at = NOW() WHERE id = $2",
      [details, orderId],
    );
    return details;
  },

  // ===========================================================================
  // 3. 💸 ФИНАНСОВОЕ УПРАВЛЕНИЕ ЗАКАЗОМ (НОВЫЕ ФУНКЦИИ v9.0)
  // ===========================================================================

  /**
   * 💰 Установка кастомной итоговой цены (Переопределение сметы).
   * Вызывается, если Владелец договорился на скидку или допы.
   */
  async updateOrderFinalPrice(orderId, newPrice) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error("Заказ не найден");

    const details = order.details;
    if (!details.financials)
      details.financials = { expenses: [], total_expenses: 0 };

    details.financials.final_price = parseFloat(newPrice);
    details.financials.net_profit =
      details.financials.final_price - details.financials.total_expenses;

    await db.query(
      "UPDATE orders SET total_price = $1, details = $2, updated_at = NOW() WHERE id = $3",
      [details.financials.final_price, details, orderId],
    );
    return details.financials;
  },

  /**
   * 💸 Добавление расхода по объекту (Такси, Буры, Докупка за счет фирмы).
   * Автоматически пересчитывает Net Profit.
   */
  async addOrderExpense(orderId, amount, category, comment, userId) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error("Заказ не найден");

    const details = order.details;
    if (!details.financials) {
      details.financials = {
        final_price: order.total_price,
        expenses: [],
        total_expenses: 0,
      };
    }

    const expenseItem = {
      id: Date.now().toString(),
      amount: parseFloat(amount),
      category,
      comment,
      date: new Date().toISOString(),
      added_by: userId,
    };

    details.financials.expenses.push(expenseItem);
    details.financials.total_expenses += expenseItem.amount;
    details.financials.net_profit =
      details.financials.final_price - details.financials.total_expenses;

    await db.query(
      "UPDATE orders SET details = $1, updated_at = NOW() WHERE id = $2",
      [details, orderId],
    );

    // Логируем в отдельную таблицу object_expenses для сквозной аналитики
    await db.query(
      "INSERT INTO object_expenses (order_id, amount, category, comment, created_at) VALUES ($1, $2, $3, $4, NOW())",
      [orderId, expenseItem.amount, category, comment],
    );

    return details.financials;
  },

  // ===========================================================================
  // 4. 📊 АНАЛИТИКА И РЕТЕНШН
  // ===========================================================================

  /**
   * 📈 Аналитика для Дашборда (Теперь с учетом Net Profit).
   */
  async getAdminStats() {
    const result = await db.query(`
      SELECT status, COUNT(*) as count, SUM(total_price) as sum,
             SUM((details->'financials'->>'net_profit')::numeric) as net_profit_sum
      FROM orders
      GROUP BY status
    `);

    const stats = {};
    Object.values(ORDER_STATUS).forEach(
      (s) => (stats[s] = { count: 0, sum: 0, netProfit: 0 }),
    );

    let totalRevenue = 0;
    let totalNetProfit = 0;
    let potentialRevenue = 0;

    for (const row of result.rows) {
      const s = row.status;
      const val = {
        count: parseInt(row.count || 0),
        sum: parseFloat(row.sum || 0),
        netProfit: parseFloat(row.net_profit_sum || 0),
      };

      if (stats[s]) stats[s] = val;
      if (s === ORDER_STATUS.DONE) {
        totalRevenue += val.sum;
        totalNetProfit += val.netProfit;
      }

      if (
        ![
          ORDER_STATUS.CANCELED,
          ORDER_STATUS.ARCHIVED,
          ORDER_STATUS.DRAFT,
        ].includes(s)
      ) {
        potentialRevenue += val.sum;
      }
    }

    return {
      breakdown: stats,
      metrics: {
        totalRevenue,
        totalNetProfit, // Чистая прибыль для владельца!
        potentialRevenue,
        activeCount:
          stats[ORDER_STATUS.WORK].count + stats[ORDER_STATUS.PROCESSING].count,
      },
    };
  },

  /**
   * ♻️ Поиск "Брошенных корзин" (Лиды без действий).
   */
  async getAbandonedCarts() {
    return (
      await db.query(
        `
      SELECT o.id, o.user_id, u.first_name, o.total_price, o.created_at
      FROM orders o
      JOIN users u ON o.user_id = u.telegram_id
      WHERE o.status IN ($1, $2)
      AND o.created_at < NOW() - INTERVAL '24 hours'
      AND o.created_at > NOW() - INTERVAL '72 hours'
    `,
        [ORDER_STATUS.NEW, ORDER_STATUS.DRAFT],
      )
    ).rows;
  },

  async getUserOrders(userId) {
    return (
      await db.query(
        `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [userId],
      )
    ).rows;
  },

  async getOrderById(orderId) {
    return (await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId]))
      .rows[0];
  },

  async getAvailableMasters() {
    return (
      await db.query(
        `SELECT telegram_id, first_name FROM users WHERE role = 'manager'`,
      )
    ).rows;
  },
};

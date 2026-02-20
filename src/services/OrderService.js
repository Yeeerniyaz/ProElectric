/**
 * @file src/services/OrderService.js
 * @description Сервис бизнес-логики заказов (Core Business Logic v10.0.0).
 * Отвечает за:
 * 1. Инженерный расчет сметы (Бурение и точки разделены).
 * 2. Финансовое ядро (Self-Healing Expenses & Net Profit).
 * 3. Динамическое ценообразование (Pricelist Template).
 * 4. Автогенерацию массива BOM.
 * 5. Управление распределением заказов по бригадам (NEW).
 * 6. Финализацию объектов с разделением прибыли (NEW).
 *
 * @module OrderService
 * @version 10.0.0 (Enterprise ERP Edition)
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

const WALL_NAMES = Object.freeze({
  wall_gas: "Газоблок / ГКЛ",
  wall_brick: "Кирпич",
  wall_concrete: "Бетон / Монолит",
});

/**
 * 🔥 ДИНАМИЧЕСКИЙ ПРАЙС-ЛИСТ (v10.0.0)
 * Бурение лунок и монтаж механизмов теперь полностью разделены.
 */
export const PRICELIST_TEMPLATE = [
  {
    category: "🧱 Черновые работы (Подготовка)",
    items: [
      {
        key: "price_strobe_concrete",
        name: "Штробление (Бетон/Монолит)",
        default: 1000,
        unit: "₸/м",
      },
      {
        key: "price_strobe_brick",
        name: "Штробление (Кирпич)",
        default: 700,
        unit: "₸/м",
      },
      {
        key: "price_strobe_gas",
        name: "Штробление (Газоблок/ГКЛ)",
        default: 500,
        unit: "₸/м",
      },
      {
        key: "price_drill_concrete",
        name: "Бурение лунки под точку",
        default: 500,
        unit: "₸/шт",
      },
    ],
  },
  {
    category: "⚡️ Кабельные трассы",
    items: [
      {
        key: "price_cable_base",
        name: "Прокладка кабеля (открыто)",
        default: 455,
        unit: "₸/м",
      },
      {
        key: "price_cable_corrugated",
        name: "Затяжка в гофру (+к базе)",
        default: 200,
        unit: "₸/м",
      },
      {
        key: "price_cable_channel",
        name: "Монтаж кабель-канала (+к базе)",
        default: 90,
        unit: "₸/м",
      },
    ],
  },
  {
    category: "🔌 Электроточки и Оборудование",
    items: [
      {
        key: "price_point_socket",
        name: "Монтаж розетки/выключателя",
        default: 800,
        unit: "₸/шт",
      },
      {
        key: "price_point_box",
        name: "Распаечная коробка (сварка/монтаж)",
        default: 1200,
        unit: "₸/шт",
      },
      {
        key: "price_point_chandelier",
        name: "Монтаж люстры/светильника",
        default: 3500,
        unit: "₸/шт",
      },
    ],
  },
  {
    category: "🛡 Сборка электрощита",
    items: [
      {
        key: "price_shield_base_24",
        name: "Базовая сборка (до 24 мод.)",
        default: 9000,
        unit: "₸/шт",
      },
      {
        key: "price_shield_extra_module",
        name: "Доп. модуль свыше 24",
        default: 500,
        unit: "₸/шт",
      },
    ],
  },
];

const ESTIMATE_RULES = Object.freeze({
  cablePerSqm: 6.5,
  cableRatioCorr: 0.7,
  cableRatioBase: 0.2,
  cableRatioChan: 0.1,
  strobeFactor: 0.9,
  socketsPerSqm: 0.7,
  boxesPerRoom: 1.5,
  chandeliersPerRoom: 1.0,
  minShieldModules: 12,
  shieldModulesStep: 15,
});

// =============================================================================
// 2. 🧠 BUSINESS LOGIC IMPLEMENTATION
// =============================================================================

export const OrderService = {
  ORDER_STATUS,

  /**
   * 📋 Выгрузка актуального прайс-листа для Web CRM и Telegram Бота.
   */
  async getPublicPricelist() {
    const settings = await db.getSettings();
    const result = [];

    for (const section of PRICELIST_TEMPLATE) {
      const activeItems = section.items.map((item) => {
        const val = parseFloat(settings[item.key]);
        const currentPrice = !isNaN(val) && val > 0 ? val : item.default;
        return { ...item, currentPrice };
      });
      result.push({ category: section.category, items: activeItems });
    }
    return result;
  },

  /**
   * 🏗 Инженерный расчет сметы (Разделенное бурение и механизмы).
   */
  async calculateComplexEstimate(areaRaw, roomsRaw, wallKey) {
    const settings = await db.getSettings();
    const area = parseFloat(areaRaw) || 0;
    const rooms = parseInt(roomsRaw, 10) || 1;

    const getPrice = (key) => {
      const val = parseFloat(settings[key]);
      if (!isNaN(val) && val > 0) return val;
      for (const cat of PRICELIST_TEMPLATE) {
        const item = cat.items.find((i) => i.key === key);
        if (item) return item.default;
      }
      return 0;
    };

    // 1. Тарифы
    let priceStrobe = getPrice("price_strobe_concrete");
    if (wallKey === "wall_gas") priceStrobe = getPrice("price_strobe_gas");
    if (wallKey === "wall_brick") priceStrobe = getPrice("price_strobe_brick");

    const priceDrill = getPrice("price_drill_concrete"); // Отдельная цена бурения
    const pricePointSocket = getPrice("price_point_socket");
    const pricePointBox = getPrice("price_point_box");
    const pricePointChandelier = getPrice("price_point_chandelier");

    const priceCableBase = getPrice("price_cable_base");
    const priceCableCorrAdd = getPrice("price_cable_corrugated");
    const priceCableChanAdd = getPrice("price_cable_channel");

    const priceShieldBase24 = getPrice("price_shield_base_24");
    const priceShieldExtra = getPrice("price_shield_extra_module");

    // 2. Объемы
    const volStrobe = Math.ceil(area * ESTIMATE_RULES.strobeFactor);
    const totalCable = Math.ceil(area * ESTIMATE_RULES.cablePerSqm);
    const volCableCorr = Math.ceil(totalCable * ESTIMATE_RULES.cableRatioCorr);
    const volCableBase = Math.ceil(totalCable * ESTIMATE_RULES.cableRatioBase);
    const volCableChan = totalCable - volCableCorr - volCableBase;

    const volSockets = Math.ceil(area * ESTIMATE_RULES.socketsPerSqm);
    const volBoxes = Math.ceil(rooms * ESTIMATE_RULES.boxesPerRoom);
    const volChandeliers = Math.ceil(rooms * ESTIMATE_RULES.chandeliersPerRoom);
    const totalPoints = volSockets + volBoxes + volChandeliers;

    // Объем бурения (розетки + коробки)
    const volDrill = volSockets + volBoxes;

    const volModules = Math.max(
      ESTIMATE_RULES.minShieldModules,
      Math.ceil(12 + Math.max(0, area - 40) / ESTIMATE_RULES.shieldModulesStep),
    );

    // 3. Калькуляция
    const costStrobe = volStrobe * priceStrobe;
    const costDrillTotal = volDrill * priceDrill; // Сумма за бурение

    const costCableTotal =
      volCableBase * priceCableBase +
      volCableCorr * (priceCableBase + priceCableCorrAdd) +
      volCableChan * (priceCableBase + priceCableChanAdd);

    const costPointsTotal =
      volSockets * pricePointSocket +
      volBoxes * pricePointBox +
      volChandeliers * pricePointChandelier;

    const costShield =
      volModules <= 24
        ? priceShieldBase24
        : priceShieldBase24 + (volModules - 24) * priceShieldExtra;

    // Итого работа
    const grandTotalWork =
      Math.ceil(
        (costStrobe +
          costDrillTotal +
          costCableTotal +
          costPointsTotal +
          costShield) /
          500,
      ) * 500;
    const materialInfo = Math.ceil(grandTotalWork * 0.45);

    // 4. Формирование DTO
    const estimateDTO = {
      params: {
        area,
        rooms,
        wallTypeRaw: wallKey,
        wallType: WALL_NAMES[wallKey] || wallKey,
      },
      volume: {
        points: totalPoints,
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
        drill: costDrillTotal,
        cable: costCableTotal,
        points: costPointsTotal,
        shield: costShield,
      },
      total: {
        work: grandTotalWork,
        material_info: materialInfo,
        grandTotal: grandTotalWork,
      },
    };

    // Строгий массив спецификации (BOM)
    estimateDTO.bom = this.generateMaterialSpecification(estimateDTO.volume);

    return estimateDTO;
  },

  /**
   * 🛠 Генератор массива спецификации (BOM Generator)
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
   * 📝 Создание заказа (Фикс проблемы "null м2")
   */
  async createOrder(userId, estimate) {
    // 🔥 ГЕНЕРАЦИЯ УНИКАЛЬНОГО 6-ЗНАЧНОГО ID
    let isUnique = false;
    let randomId;

    while (!isUnique) {
      // Генерируем число от 100000 до 999999
      randomId = Math.floor(100000 + Math.random() * 900000);

      // Проверяем, существует ли уже такой ID в таблице заказов
      const checkId = await db.query("SELECT id FROM orders WHERE id = $1", [
        randomId,
      ]);

      if (checkId.rows.length === 0) {
        isUnique = true; // ID свободен
      }
    }

    const area = estimate.params?.area || 0;

    const financials = {
      final_price: estimate.total.work,
      total_expenses: 0,
      net_profit: estimate.total.work,
      expenses: [],
    };

    const orderData = {
      id: randomId,
      area: area,
      price: estimate.total.work,
      details: { ...estimate, financials },
    };

    return await db.createOrder(userId, orderData);
  },

  async updateOrderStatus(orderId, newStatus) {
    await db.query(
      "UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2",
      [newStatus, orderId],
    );
    return true;
  },

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
  // 3. 💸 ФИНАНСОВОЕ УПРАВЛЕНИЕ (SELF-HEALING ERP)
  // ===========================================================================

  async updateOrderFinalPrice(orderId, newPrice) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error("Заказ не найден");

    const details = order.details || {};

    // Self-Healing: Инициализация финансового блока, если его убили старые версии
    if (!details.financials) {
      details.financials = {
        final_price: parseFloat(order.total_price) || 0,
        expenses: [],
        total_expenses: 0,
        net_profit: 0,
      };
    }

    details.financials.final_price = parseFloat(newPrice);
    details.financials.net_profit =
      details.financials.final_price - details.financials.total_expenses;

    await db.query(
      "UPDATE orders SET total_price = $1, details = $2, updated_at = NOW() WHERE id = $3",
      [details.financials.final_price, details, orderId],
    );

    return details.financials;
  },

  async addOrderExpense(orderId, amount, category, comment, userId) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error("Заказ не найден");

    const details = order.details || {};

    // Self-Healing: Гарантируем наличие массива expenses, чтобы не ловить Cannot read 'length'
    if (!details.financials) {
      details.financials = {
        final_price: parseFloat(order.total_price) || 0,
        expenses: [],
        total_expenses: 0,
        net_profit: 0,
      };
    }
    if (!Array.isArray(details.financials.expenses)) {
      details.financials.expenses = [];
    }

    const expenseItem = {
      id: Date.now().toString(),
      amount: parseFloat(amount),
      category: category || "Прочее",
      comment: comment || "",
      date: new Date().toISOString(),
      added_by: userId || "admin",
    };

    details.financials.expenses.push(expenseItem);
    details.financials.total_expenses += expenseItem.amount;
    details.financials.net_profit =
      details.financials.final_price - details.financials.total_expenses;

    await db.query(
      "UPDATE orders SET details = $1, updated_at = NOW() WHERE id = $2",
      [details, orderId],
    );

    try {
      await db.query(
        "INSERT INTO object_expenses (order_id, amount, category, comment, created_at) VALUES ($1, $2, $3, $4, NOW())",
        [orderId, expenseItem.amount, category, comment],
      );
    } catch (e) {
      console.warn(
        "History write skipped (object_expenses table might not exist):",
        e.message,
      );
    }

    return details.financials;
  },

  // ===========================================================================
  // 4. 🏗 BRIGADES & PROFIT DISTRIBUTION (ERP v10.0 - NEW)
  // ===========================================================================

  async getAvailableNewOrders() {
    return await db.getAvailableNewOrders();
  },

  async getBrigadeOrders(brigadeId) {
    return await db.getBrigadeOrders(brigadeId);
  },

  async assignOrderToBrigade(orderId, brigadeId) {
    return await db.assignOrderToBrigade(orderId, brigadeId);
  },

  async getOrderExpenses(orderId) {
    return await db.getOrderExpenses(orderId);
  },

  async finalizeOrderAndDistributeProfit(orderId, ownerAccountId) {
    return await db.finalizeOrderAndDistributeProfit(orderId, ownerAccountId);
  },

  // ===========================================================================
  // 5. 📊 АНАЛИТИКА (DASHBOARD)
  // ===========================================================================

  async getAdminStats() {
    const result = await db.query(`
      SELECT status, COUNT(*) as count, SUM(total_price) as sum,
             SUM(COALESCE((details->'financials'->>'net_profit')::numeric, total_price)) as net_profit_sum
      FROM orders
      GROUP BY status
    `);

    const stats = {};
    Object.values(ORDER_STATUS).forEach(
      (s) => (stats[s] = { count: 0, sum: 0, netProfit: 0 }),
    );

    let totalRevenue = 0,
      totalNetProfit = 0,
      potentialRevenue = 0;

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
      )
        potentialRevenue += val.sum;
    }

    return {
      breakdown: stats,
      metrics: {
        totalRevenue,
        totalNetProfit,
        potentialRevenue,
        activeCount:
          stats[ORDER_STATUS.WORK].count + stats[ORDER_STATUS.PROCESSING].count,
      },
    };
  },

  async getAbandonedCarts() {
    return (
      await db.query(
        `
      SELECT o.id, o.user_id, u.first_name, o.total_price, o.created_at
      FROM orders o JOIN users u ON o.user_id = u.telegram_id
      WHERE o.status IN ($1, $2) AND o.created_at < NOW() - INTERVAL '24 hours' AND o.created_at > NOW() - INTERVAL '72 hours'
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

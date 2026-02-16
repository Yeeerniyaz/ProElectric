/**
 * @file src/constants.js
 * @description Единый источник истины (Single Source of Truth).
 * Содержит неизменяемые конфигурации, словари статусов, UI-шаблоны и бизнес-правила.
 * Использует Object.freeze для гарантии целостности данных в runtime.
 * @module Constants
 * @version 2.1.0 (Three Wall Types Support)
 */

// =============================================================================
// 1. DOMAIN ENTITIES & RBAC
// =============================================================================

/**
 * Роли пользователей в системе.
 */
export const ROLES = Object.freeze({
  ADMIN: "admin", // Владелец
  MANAGER: "manager", // Сотрудник
  CLIENT: "client", // Клиент
});

/**
 * Жизненный цикл заказа.
 */
export const ORDER_STATUS = Object.freeze({
  NEW: "new", // Новый
  DISCUSS: "discuss", // Замер/Обсуждение
  WORK: "work", // В работе
  DONE: "done", // Сдан
  CANCEL: "cancel", // Отмена
});

/**
 * UI-лейблы для статусов.
 */
export const STATUS_LABELS = Object.freeze({
  [ORDER_STATUS.NEW]: "🆕 Новый",
  [ORDER_STATUS.DISCUSS]: "🗣 Обсуждение",
  [ORDER_STATUS.WORK]: "🛠 В работе",
  [ORDER_STATUS.DONE]: "✅ Выполнен",
  [ORDER_STATUS.CANCEL]: "❌ Отмена",
});

// =============================================================================
// 2. BUSINESS RULES & PRICING
// =============================================================================

/**
 * Базовые цены (Fallback Pricing).
 * Разделены на 3 типа сложности стен.
 */
export const PRICING = Object.freeze({
  // === Черновые работы (Rough Stage) ===
  rough: {
    // 1. Легкие стены (ГКЛ, Газоблок)
    strobeSoft: 800, // Штробление
    drillHoleSoft: 800, // Лунка под подрозетник

    // 2. Средние стены (Кирпич)
    strobeBrick: 1200,
    drillHoleBrick: 1200,

    // 3. Тяжелые стены (Бетон, Монолит)
    strobeConcrete: 2000,
    drillHoleConcrete: 1800,

    // Общее
    cableLaying: 450, // Прокладка кабеля (м.п.)
    socketBoxInstall: 800, // Вмазка подрозетника
    junctionBoxAssembly: 3500, // Сборка распредкоробки
  },

  // === Чистовые работы (Finish Stage) ===
  finish: {
    socketInstall: 1200, // Установка механизма
    shieldModule: 2500, // Сборка щита (за модуль)
    lampInstall: 6000, // Люстра
    ledStrip: 2500, // LED лента
  },

  // === Коэффициенты ===
  materialsFactor: 0.4, // % материалов от стоимости работ
});

/**
 * Коэффициенты сложности для калькулятора (Multiplier Strategy).
 * Используются в callbacks.js для быстрой оценки.
 */
export const WALL_FACTORS = Object.freeze({
  wall_soft: 1.0, // База (ГКЛ/Блок)
  wall_brick: 1.4, // +40% сложности
  wall_concrete: 2.0, // x2 сложность
});

/**
 * Правила калькулятора (Эвристика).
 */
export const ESTIMATE_RULES = Object.freeze({
  cablePerSqm: 3.5, // Метров кабеля на 1 м²
  strobePerSqm: 0.9, // Метров штробы на 1 м²
  pointsPerSqm: 0.75, // Точек на 1 м²
  minShieldModules: 12, // Мин. щиток
});

// =============================================================================
// 3. UI CONFIGURATION
// =============================================================================

export const BUTTONS = Object.freeze({
  CALCULATOR: "🧮 Рассчитать стоимость",
  ORDERS: "📂 Мои заказы",
  PRICE_LIST: "💰 Прайс-лист",
  CONTACTS: "📞 Контакты",

  MANAGER_OBJECTS: "👷‍♂️ Мои объекты",
  MANAGER_CASH: "💵 Моя Касса",

  ADMIN_PANEL: "👑 Админ-панель",
  ADMIN_STATS: "📊 Статистика",
  ADMIN_SETTINGS: "⚙️ Настройки цен",
  ADMIN_STAFF: "👥 Сотрудники",

  BACK: "🔙 Главное меню",
  CANCEL: "❌ Отмена",
});

export const KEYBOARDS = {
  main: (role) => {
    const btns = [
      [{ text: BUTTONS.CALCULATOR }, { text: BUTTONS.ORDERS }],
      [{ text: BUTTONS.PRICE_LIST }, { text: BUTTONS.CONTACTS }],
    ];
    if (role === ROLES.MANAGER || role === ROLES.ADMIN) {
      btns.unshift([
        { text: BUTTONS.MANAGER_OBJECTS },
        { text: BUTTONS.MANAGER_CASH },
      ]);
    }
    if (role === ROLES.ADMIN) {
      btns.unshift([{ text: BUTTONS.ADMIN_PANEL }]);
    }
    return { keyboard: btns, resize_keyboard: true };
  },

  admin: {
    keyboard: [
      [{ text: BUTTONS.ADMIN_STATS }, { text: BUTTONS.ADMIN_SETTINGS }],
      [{ text: BUTTONS.ADMIN_STAFF }, { text: BUTTONS.BACK }],
    ],
    resize_keyboard: true,
  },

  cancel: {
    keyboard: [[{ text: BUTTONS.CANCEL }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },

  // 🔥 ОБНОВЛЕННАЯ КЛАВИАТУРА: 3 ТИПА СТЕН
  walls: {
    inline_keyboard: [
      [{ text: "⬜️ ГКЛ / Газоблок (Легко)", callback_data: "wall_soft" }],
      [{ text: "🧱 Кирпич (Средне)", callback_data: "wall_brick" }],
      [{ text: "🏗 Бетон / Монолит (Сложно)", callback_data: "wall_concrete" }],
    ],
  },

  expenseCategories: {
    keyboard: [
      [{ text: "🚕 Такси" }, { text: "🔌 Материалы" }],
      [{ text: "🍔 Питание" }, { text: "🛠 Инструмент" }],
      [{ text: BUTTONS.CANCEL }],
    ],
    resize_keyboard: true,
  },

  contact: {
    keyboard: [
      [{ text: "📱 Отправить мой номер", request_contact: true }],
      [{ text: BUTTONS.BACK }],
    ],
    resize_keyboard: true,
  },
};

export const TEXTS = {
  welcome: (name, role) =>
    `Салам, <b>${name}</b>! 👋\n` +
    `Я цифровой помощник <b>ProElectric</b>.\n\n` +
    `🛠 <b>Мои возможности:</b>\n` +
    `• Расчет сметы (3 вида стен)\n` +
    `• Учет объектов и касса\n` +
    `• Связь с мастером\n\n` +
    `<i>Ваш статус: ${role.toUpperCase()}</i>`,

  priceList: (dbPrices = {}) => {
    const getVal = (key, def) => (dbPrices[key] ? Number(dbPrices[key]) : def);
    const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

    // Загружаем цены с учетом fallback
    const p = {
      // Soft
      strobeS: getVal("price_strobe_soft", PRICING.rough.strobeSoft),
      drillS: getVal("price_drill_hole_soft", PRICING.rough.drillHoleSoft),
      // Brick
      strobeB: getVal("price_strobe_brick", PRICING.rough.strobeBrick),
      drillB: getVal("price_drill_hole_brick", PRICING.rough.drillHoleBrick),
      // Concrete
      strobeC: getVal("price_strobe_concrete", PRICING.rough.strobeConcrete),
      drillC: getVal(
        "price_drill_hole_concrete",
        PRICING.rough.drillHoleConcrete,
      ),
      // General
      cable: getVal("price_cable_laying", PRICING.rough.cableLaying),
      socket: getVal("price_socket_install", PRICING.finish.socketInstall),
      shield: getVal("price_shield_module", PRICING.finish.shieldModule),
    };

    return (
      `📋 <b>ПРАЙС-ЛИСТ 2026 (ТРИ ТИПА СТЕН)</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `<b>⬜️ ЛЕГКИЕ СТЕНЫ (ГКЛ/Блок):</b>\n` +
      `▫️ Штроба: <b>${fmt(p.strobeS)} ₸/м</b>\n` +
      `▫️ Подразетник: <b>${fmt(p.drillS)} ₸/шт</b>\n\n` +
      `<b>🧱 СРЕДНИЕ СТЕНЫ (Кирпич):</b>\n` +
      `▫️ Штроба: <b>${fmt(p.strobeB)} ₸/м</b>\n` +
      `▫️ Подразетник: <b>${fmt(p.drillB)} ₸/шт</b>\n\n` +
      `<b>🏗 ТЯЖЕЛЫЕ СТЕНЫ (Бетон):</b>\n` +
      `▫️ Штроба: <b>${fmt(p.strobeC)} ₸/м</b>\n` +
      `▫️ Подразетник: <b>${fmt(p.drillC)} ₸/шт</b>\n\n` +
      `<b>🔌 ОБЩЕЕ:</b>\n` +
      `▫️ Кабель: ${fmt(p.cable)} ₸/м\n` +
      `▫️ Точка (чистовая): ${fmt(p.socket)} ₸/шт\n` +
      `▫️ Щит (модуль): ${fmt(p.shield)} ₸/шт\n\n` +
      `<i>❗️ Цены ориентировочные.</i>`
    );
  },
};

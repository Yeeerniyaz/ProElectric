/**
 * @file src/constants.js
 * @description Единый источник правды (Single Source of Truth).
 * Содержит все текстовые константы, настройки бизнес-логики и UI-шаблоны.
 * @module Constants
 * @version 2.1.0 (Renamed Estimate -> Calculation)
 */

// =============================================================================
// 1. КЛЮЧИ БАЗЫ ДАННЫХ (DATABASE KEYS)
// =============================================================================
export const DB_KEYS = Object.freeze({
  // --- Черновые работы (Rough Work) ---
  STROBE_CONCRETE: "price_strobe_concrete",
  STROBE_BRICK: "price_strobe_brick",
  STROBE_GAS: "price_strobe_gasblock",

  DRILL_CONCRETE: "price_drill_concrete",
  DRILL_BRICK: "price_drill_brick",
  DRILL_GAS: "price_drill_gasblock",

  CABLE: "price_cable",
  BOX_INSTALL: "price_box_install",
  BOX_ASSEMBLY: "price_box_assembly",

  // --- Чистовые работы (Finish Work) ---
  SOCKET_INSTALL: "price_socket_install",
  SHIELD_MODULE: "price_shield_module",

  // --- Коэффициенты ---
  MAT_FACTOR: "material_factor", // % на черновые материалы (расходники)

  // --- Зарплаты ---
  STAFF_PERCENT: "percent_staff",
});

// =============================================================================
// 2. ЦЕНЫ ПО УМОЛЧАНИЮ (FALLBACK PRICING)
// =============================================================================
export const PRICING = Object.freeze({
  rough: {
    strobeConcrete: 1750,
    strobeBrick: 1100,
    strobeGas: 800,
    drillConcrete: 1500,
    drillBrick: 1000,
    drillGas: 800,
  },
  common: {
    cable: 400,
    boxInstall: 600,
    boxAssembly: 3000,
    socketInstall: 1000,
    shieldModule: 1750,
    matFactor: 0.4, // 40% от работы
    staffPercent: 0.8,
  },
});

// =============================================================================
// 3. БИЗНЕС-ПРАВИЛА (ESTIMATE RULES)
// =============================================================================
export const ESTIMATE_RULES = Object.freeze({
  cablePerSqm: 6.5,
  pointsPerSqm: 0.8,
  strobeFactor: 0.9,
  minShieldModules: 12,
  modulesPerRoom: 2,
  boxesPerRoom: 1.5,
});

// =============================================================================
// 4. РОЛИ И СТАТУСЫ
// =============================================================================
export const ROLES = Object.freeze({
  ADMIN: "admin",
  MANAGER: "manager",
  CLIENT: "client",
});

export const ORDER_STATUS = Object.freeze({
  NEW: "new",
  DISCUSS: "discuss",
  WORK: "work",
  DONE: "done",
  CANCEL: "cancel",
});

// =============================================================================
// 5. ТЕКСТЫ КНОПОК
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

// =============================================================================
// 6. ГЕНЕРАТОРЫ КЛАВИАТУР
// =============================================================================
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

  walls: {
    inline_keyboard: [
      [{ text: "🧱 Газоблок / ГКЛ", callback_data: "wall_gas" }],
      [{ text: "🧱 Кирпич", callback_data: "wall_brick" }],
      [{ text: "🏗 Бетон / Монолит", callback_data: "wall_concrete" }],
    ],
  },

  cancel: {
    keyboard: [[{ text: BUTTONS.CANCEL }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },

  admin: {
    keyboard: [
      [{ text: BUTTONS.ADMIN_STATS }, { text: BUTTONS.ADMIN_SETTINGS }],
      [{ text: BUTTONS.ADMIN_STAFF }, { text: BUTTONS.BACK }],
    ],
    resize_keyboard: true,
  },
};

// =============================================================================
// 7. ШАБЛОНЫ СООБЩЕНИЙ
// =============================================================================
const formatKZT = (val) =>
  new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(val);

export const TEXTS = {
  welcome: (name) =>
    `Салам, <b>${name}</b>! 👋\n` +
    `Я цифровой помощник <b>ProElectro</b>.\n` +
    `Я помогу рассчитать стоимость электромонтажа.\n\n` +
    `👇 Выберите действие:`,

  contacts: () =>
    `📞 <b>Наши контакты:</b>\n\n` +
    `👤 Главный инженер: @yeeerniyaz\n` +
    `📱 Телефон: +7 (777) 123-45-67\n` +
    `📍 Алматы, Казахстан`,

  priceList: (dbPrices = {}) => {
    const getVal = (key, def) => parseFloat(dbPrices[key] || def);

    const p = {
      strobeC: getVal(DB_KEYS.STROBE_CONCRETE, PRICING.rough.strobeConcrete),
      strobeB: getVal(DB_KEYS.STROBE_BRICK, PRICING.rough.strobeBrick),
      cable: getVal(DB_KEYS.CABLE, PRICING.common.cable),
      drillC: getVal(DB_KEYS.DRILL_CONCRETE, PRICING.rough.drillConcrete),
      box: getVal(DB_KEYS.BOX_INSTALL, PRICING.common.boxInstall),
      socket: getVal(DB_KEYS.SOCKET_INSTALL, PRICING.common.socketInstall),
      shield: getVal(DB_KEYS.SHIELD_MODULE, PRICING.common.shieldModule),
      pointTotal:
        getVal(DB_KEYS.DRILL_CONCRETE, 1500) +
        getVal(DB_KEYS.BOX_INSTALL, 600) +
        getVal(DB_KEYS.SOCKET_INSTALL, 1000),
    };

    return (
      `📋 <b>ОФИЦИАЛЬНЫЙ ПРАЙС-ЛИСТ 2026</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `<b>🏗 ЧЕРНОВЫЕ РАБОТЫ:</b>\n` +
      `▫️ Штробление (Бетон): ${formatKZT(p.strobeC)}/м\n` +
      `▫️ Штробление (Кирпич): ${formatKZT(p.strobeB)}/м\n` +
      `▫️ Прокладка кабеля: ${formatKZT(p.cable)}/м\n` +
      `▫️ Высверливание (Бетон): ${formatKZT(p.drillC)}/шт\n` +
      `▫️ Вмазка подрозетника: ${formatKZT(p.box)}/шт\n\n` +
      `<b>✨ ЧИСТОВЫЕ РАБОТЫ:</b>\n` +
      `▫️ Установка механизма: ${formatKZT(p.socket)}/шт\n` +
      `▫️ Сборка щита (модуль): ${formatKZT(p.shield)}/шт\n\n` +
      `💡 <b>Точка "Под ключ" (Бетон):</b>\n` +
      `~ ${formatKZT(p.pointTotal)} / шт\n\n` +
      `<i>❗️ Цены актуальны на сегодня.</i>`
    );
  },

  // 🔥 ОБНОВЛЕННЫЙ ШАБЛОН (БЕЗ СЛОВА "СМЕТА")
  estimateResult: (orderId, est, wallType) => {
    const wallNames = {
      gas: "🧱 Газоблок",
      brick: "🧱 Кирпич",
      concrete: "🏗 Бетон (Монолит)",
    };

    return (
      `⚡️ <b>ПРЕДВАРИТЕЛЬНЫЙ РАСЧЕТ (Заказ #${orderId})</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `🏠 <b>Параметры объекта:</b>\n` +
      `▫️ Площадь: ${est.params.area} м²\n` +
      `▫️ Комнат: ${est.params.rooms}\n` +
      `▫️ Стены: ${wallNames[wallType] || "Неизвестно"}\n\n` +
      `<b>📋 Детализация работ (Объем):</b>\n` +
      `▫️ Электроточки (~${est.volume.points} шт): <b>${formatKZT(est.breakdown.points)}</b>\n` +
      `▫️ Штробление (~${est.volume.strobe} м): <b>${formatKZT(est.breakdown.strobe)}</b>\n` +
      `▫️ Кабель (~${est.volume.cable} м): <b>${formatKZT(est.breakdown.cable)}</b>\n` +
      `▫️ Щит (~${est.volume.modules} мод): <b>${formatKZT(est.breakdown.shield)}</b>\n` +
      `▫️ Распайки (~${est.volume.boxes} шт): <b>${formatKZT(est.breakdown.boxes)}</b>\n` +
      `----------------------------------\n` +
      `⚒ <b>СТОИМОСТЬ РАБОТ: ${formatKZT(est.total.work)}</b>\n\n` +
      `📦 <b>МАТЕРИАЛЫ (Черновые):</b>\n` +
      `<i>Кабель, гофра, подрозетники, гипс...</i>\n` +
      `Расчет (+40%): <b>${formatKZT(est.total.material)}</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `🏁 <b>ИТОГО ПОД КЛЮЧ: ${formatKZT(est.total.grandTotal)}</b>\n\n` +
      `<i>⚠️ Это предварительный расчет. Точная сумма фиксируется после замера.</i>`
    );
  },
};

/**
 * @file src/constants.js
 * @description Единый источник истины (Single Source of Truth).
 * Содержит неизменяемые конфигурации, словари статусов, UI-шаблоны и бизнес-правила.
 * Использует Object.freeze для гарантии целостности данных в runtime.
 * @module Constants
 */

// =============================================================================
// 1. DOMAIN ENTITIES & RBAC
// =============================================================================

/**
 * Роли пользователей в системе.
 */
export const ROLES = Object.freeze({
  ADMIN: "admin", // Владелец: Полный доступ + Админ-панель
  MANAGER: "manager", // Сотрудник: Управление заказами, расходы, личная касса
  CLIENT: "client", // Клиент: Создание заявки, просмотр статуса
});

/**
 * Жизненный цикл заказа.
 */
export const ORDER_STATUS = Object.freeze({
  NEW: "new", // Заказ создан, ожидает распределения
  DISCUSS: "discuss", // Менеджер взял в работу, этап переговоров/замера
  WORK: "work", // Подтвержден, ведутся работы
  DONE: "done", // Завершен, оплачен, закрыт
  CANCEL: "cancel", // Отменен или отклонен
});

/**
 * Человекочитаемые названия статусов.
 */
export const STATUS_LABELS = Object.freeze({
  [ORDER_STATUS.NEW]: "🆕 Новый",
  [ORDER_STATUS.DISCUSS]: "🗣 Обсуждение",
  [ORDER_STATUS.WORK]: "🛠 В работе",
  [ORDER_STATUS.DONE]: "✅ Выполнен",
  [ORDER_STATUS.CANCEL]: "❌ Отмена",
});

// =============================================================================
// 2. BUSINESS RULES & DEFAULTS
// =============================================================================

/**
 * Базовые цены (Fallback Pricing).
 * Используются как значения по умолчанию, если БД недоступна или цена не задана.
 * Ключи здесь логически сгруппированы, маппинг на ключи БД происходит в OrderService.
 */
export const PRICING = Object.freeze({
  // === Черновые работы (Rough) ===
  rough: {
    strobeConcrete: 1750, // Штробление (Бетон)
    strobeBrick: 1100, // Штробление (Кирпич)
    cableLaying: 400, // Прокладка кабеля
    drillHoleConcrete: 1500, // Высверливание лунки (Бетон)
    drillHoleBrick: 1000, // Высверливание лунки (Кирпич)
    socketBoxInstall: 600, // Вмазка подрозетника
    junctionBoxAssembly: 3000, // Сборка распредкоробки
  },

  // === Чистовые работы (Finish) ===
  finish: {
    socketInstall: 1000, // Установка механизма
    shieldModule: 1750, // Сборка щита (за модуль)
    lampInstall: 5000, // Установка люстры (база)
    ledStrip: 2000, // Монтаж LED-ленты
  },

  // === Материалы ===
  materialsFactor: 0.45, // Коэффициент стоимости материалов (45%)
});

/**
 * Правила калькулятора (Эвристика).
 * Коэффициенты расхода материалов на квадратный метр.
 */
export const ESTIMATE_RULES = Object.freeze({
  cablePerSqm: 3.5, // Метров кабеля на 1 м² пола
  strobePerSqm: 0.8, // Метров штробы на 1 м² пола
  pointsPerSqm: 0.6, // Точек на 1 м² пола
  minShieldModules: 12, // Минимальный размер щита
});

// =============================================================================
// 3. UI CONFIGURATION (KEYBOARDS & TEXTS)
// =============================================================================

/**
 * Тексты кнопок (для исключения "магических строк" в коде).
 */
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

/**
 * Генераторы клавиатур.
 */
export const KEYBOARDS = {
  /**
   * Главное меню в зависимости от роли.
   * @param {string} role
   */
  main: (role) => {
    const btns = [
      [{ text: BUTTONS.CALCULATOR }, { text: BUTTONS.ORDERS }],
      [{ text: BUTTONS.PRICE_LIST }, { text: BUTTONS.CONTACTS }],
    ];

    // Меню сотрудника
    if (role === ROLES.MANAGER || role === ROLES.ADMIN) {
      btns.unshift([
        { text: BUTTONS.MANAGER_OBJECTS },
        { text: BUTTONS.MANAGER_CASH },
      ]);
    }

    // Меню админа
    if (role === ROLES.ADMIN) {
      btns.unshift([{ text: BUTTONS.ADMIN_PANEL }]);
    }

    return { keyboard: btns, resize_keyboard: true };
  },

  // Меню админ-панели
  admin: {
    keyboard: [
      [{ text: BUTTONS.ADMIN_STATS }, { text: BUTTONS.ADMIN_SETTINGS }],
      [{ text: BUTTONS.ADMIN_STAFF }, { text: BUTTONS.BACK }],
    ],
    resize_keyboard: true,
  },

  // Кнопка отмены
  cancel: {
    keyboard: [[{ text: BUTTONS.CANCEL }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },

  // Инлайн-выбор стен
  walls: {
    inline_keyboard: [
      [{ text: "🧱 Кирпич / Газоблок (Средне)", callback_data: "wall_brick" }],
      [{ text: "🏗 Бетон / Монолит (Сложно)", callback_data: "wall_concrete" }],
    ],
  },
};

/**
 * Текстовые шаблоны.
 */
export const TEXTS = {
  /**
   * Генерация прайс-листа.
   * Принимает объект prices (из БД), если его нет - использует PRICING (константы).
   * @param {Object} [dbPrices] - Объект цен из settings таблицы
   */
  priceList: (dbPrices = {}) => {
    // Хелпер для выбора цены: DB > Default
    const getVal = (key, def) =>
      dbPrices[key] !== undefined ? dbPrices[key] : def;

    const p = {
      strobeC: getVal("price_strobe_concrete", PRICING.rough.strobeConcrete),
      strobeB: getVal("price_strobe_brick", PRICING.rough.strobeBrick),
      cable: getVal("price_cable_laying", PRICING.rough.cableLaying),
      drillC: getVal(
        "price_drill_hole_concrete",
        PRICING.rough.drillHoleConcrete,
      ),
      drillB: getVal("price_drill_hole_brick", PRICING.rough.drillHoleBrick),
      box: getVal("price_socket_box_install", PRICING.rough.socketBoxInstall),
      junc: getVal(
        "price_junction_box_assembly",
        PRICING.rough.junctionBoxAssembly,
      ),
      socket: getVal("price_socket_install", PRICING.finish.socketInstall),
      shield: getVal("price_shield_module", PRICING.finish.shieldModule),
      lamp: getVal("price_lamp_install", PRICING.finish.lampInstall),
      led: getVal("price_led_strip", PRICING.finish.ledStrip),
    };

    return (
      `📋 <b>ОФИЦИАЛЬНЫЙ ПРАЙС-ЛИСТ 2026</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `<b>🏗 ЧЕРНОВЫЕ РАБОТЫ:</b>\n` +
      `▫️ Штробление (Бетон): ${p.strobeC} ₸/м\n` +
      `▫️ Штробление (Кирпич): ${p.strobeB} ₸/м\n` +
      `▫️ Прокладка кабеля: ${p.cable} ₸/м\n` +
      `▫️ Высверливание (Бетон): ${p.drillC} ₸/шт\n` +
      `▫️ Высверливание (Кирпич): ${p.drillB} ₸/шт\n` +
      `▫️ Вмазка подрозетника: ${p.box} ₸/шт\n` +
      `▫️ Сборка распредкоробки: ${p.junc} ₸/шт\n\n` +
      `<b>✨ ЧИСТОВЫЕ РАБОТЫ:</b>\n` +
      `▫️ Установка точки: ${p.socket} ₸/шт\n` +
      `▫️ Сборка щита (модуль): ${p.shield} ₸/шт\n` +
      `▫️ Люстры/Бра: от ${p.lamp} ₸\n` +
      `▫️ LED лента: ${p.led} ₸/м\n\n` +
      `<i>❗️ Цены актуальны на сегодня.</i>`
    );
  },
};

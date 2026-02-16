/**
 * @file src/constants.js
 * @description Единый источник правды для констант, статусов и настроек.
 * @module Constants
 */

// =============================================================================
// 👥 РОЛИ И ДОСТУПЫ (RBAC)
// =============================================================================
export const ROLES = {
    ADMIN: 'admin',      // Владелец: Всё может
    MANAGER: 'manager',  // Сотрудник: Управление заказами, личная касса
    CLIENT: 'client'     // Клиент: Только свои заказы
};

// =============================================================================
// 🔌 СТАТУСЫ ЗАКАЗОВ
// =============================================================================
export const ORDER_STATUS = {
    NEW: 'new',         // Только создан
    DISCUSS: 'discuss', // Менеджер взял, звонит
    WORK: 'work',       // В работе (черновая/чистовая)
    DONE: 'done',       // Сдан и оплачен
    CANCEL: 'cancel'    // Отменен
};

export const STATUS_LABELS = {
    [ORDER_STATUS.NEW]: '🆕 Новый',
    [ORDER_STATUS.DISCUSS]: '🗣 Обсуждение',
    [ORDER_STATUS.WORK]: '🛠 В работе',
    [ORDER_STATUS.DONE]: '✅ Сдан',
    [ORDER_STATUS.CANCEL]: '❌ Отмена'
};

// =============================================================================
// 💰 ПРАЙС-ЛИСТ И КАЛЬКУЛЯТОР (PRICING ENGINE)
// =============================================================================
export const PRICING = {
    // Электроточки
    points: {
        concrete: 3500, // Бетон
        brick: 2500,    // Кирпич
        gasblock: 1800, // Газоблок
        drywall: 1500   // Гипсокартон
    },
    // Штробление
    strobe: {
        concrete: 2500,
        brick: 1500,
        gasblock: 1000
    },
    // Кабель
    cable: {
        ceiling: 400,
        floor: 350,
        tray: 600
    },
    // Коробки
    junctionBox: {
        install: 1000,
        connect: 2500
    },
    // Щит
    shield: {
        installEmbed: 5000,
        installSurface: 2000,
        moduleAssembly: 3500
    },
    // Материалы (коэфф.)
    materialsFactor: 0.45 
};

// =============================================================================
// 🧮 ПРАВИЛА РАСЧЕТА (ESTIMATE RULES) - 🔥 ВОТ ЧТО БЫЛО ПРОПУЩЕНО
// =============================================================================
export const ESTIMATE_RULES = {
    pointsPerSqm: 0.8,       // Примерно 0.8 точки на 1 м²
    cablePerSqm: 6.5,        // Примерно 6.5 метров кабеля на 1 м²
    linesPerRoom: 3,         // Минимум 3 группы на комнату
    minShieldModules: 12     // Минимальный размер щита
};

// =============================================================================
// ⌨️ КЛАВИАТУРЫ (UI LAYOUTS)
// =============================================================================
export const KEYBOARDS = {
    main: (role) => {
        const btns = [
            [{ text: "🧮 Рассчитать стоимость" }, { text: "📂 Мои заказы" }],
            [{ text: "💰 Прайс-лист" }, { text: "📞 Контакты" }]
        ];
        
        if (role === ROLES.MANAGER || role === ROLES.ADMIN) {
            btns.unshift([{ text: "👷‍♂️ Мои объекты (Активные)" }]);
            // btns.push([{ text: "💵 Моя Касса" }]); // Опционально
        }
        
        if (role === ROLES.ADMIN) {
            btns.unshift([{ text: "👑 Админ-панель" }]);
        }
        
        return { keyboard: btns, resize_keyboard: true };
    },

    admin: {
        keyboard: [
            [{ text: "📊 Статистика (KPI)" }, { text: "👥 Сотрудники" }],
            [{ text: "📣 Рассылка" }, { text: "🔙 Главное меню" }]
        ],
        resize_keyboard: true
    },

    cancel: {
        keyboard: [[{ text: "❌ Отмена" }]],
        resize_keyboard: true
    },

    walls: {
        inline_keyboard: [
            [{ text: "🧱 Газоблок / ГКЛ (Дешевле)", callback_data: "calc_wall_gasblock" }],
            [{ text: "🧱 Кирпич (Средне)", callback_data: "calc_wall_brick" }],
            [{ text: "🏗 Бетон / Монолит (Дороже)", callback_data: "calc_wall_concrete" }]
        ]
    }
};

// =============================================================================
// 💬 ТЕКСТЫ (TEMPLATES)
// =============================================================================
export const TEXTS = {
    priceList: () => 
        `📋 <b>ОФИЦИАЛЬНЫЙ ПРАЙС-ЛИСТ 2026</b>\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `<b>🔌 ЭЛЕКТРОТОЧКИ (работа):</b>\n` +
        `▫️ Газоблок:  ${PRICING.points.gasblock} ₸\n` +
        `▫️ Кирпич:    ${PRICING.points.brick} ₸\n` +
        `▫️ Бетон:     ${PRICING.points.concrete} ₸\n\n` +
        `<i>❗️ Цены ориентировочные.</i>`
};
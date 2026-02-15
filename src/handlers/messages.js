/**
 * @file src/handlers/messages.js
 * @description Основной обработчик текстовых сообщений и команд бота ProElectro.
 * Реализует паттерн MVC (Model-View-Controller) внутри одного модуля.
 * * @author Erniyaz & Gemini Senior Architect
 * @version 2.5.0 (Production Grade)
 */

import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { STATUS_CONFIG } from '../constants.js';

// =============================================================================
// 1. КОНФИГУРАЦИЯ И КОНСТАНТЫ (CONSTANTS & CONFIG)
// =============================================================================

/**
 * Текстовые константы для интерфейса.
 * Вынесены отдельно для удобства редактирования и будущей локализации.
 */
const TEXTS = {
    WELCOME: (name) => 
        `Салам, <b>${name}</b>! 👋\n\n` +
        `Я цифровой помощник <b>ProElectro</b>.\n` +
        `Моя задача — помочь вам рассчитать стоимость электромонтажных работ и найти мастера.\n\n` +
        `👇 <b>Выберите нужное действие в меню:</b>`,
    
    MENU_HEADER: "📱 <b>Главное меню</b>",
    
    CALC_START: 
        "📏 <b>Шаг 1: Площадь помещения</b>\n\n" +
        "Пожалуйста, введите площадь объекта по полу (в м²).\n" +
        "<i>Просто отправьте число, например: <b>75</b> или <b>42.5</b></i>",
    
    CALC_ERROR_NUM: 
        "⚠️ <b>Ошибка ввода!</b>\n" +
        "Я не понял это число. Пожалуйста, введите значение от <b>5</b> до <b>5000</b> м².\n\n" +
        "<i>Пример: 60</i>",
    
    CALC_WALLS: (area) =>
        `✅ Принято: <b>${area} м²</b>.\n\n` +
        `🧱 <b>Шаг 2: Материал стен</b>\n` +
        `От этого зависит стоимость штробления и установки подрозетников.\n` +
        `Выберите вариант ниже:`,
    
    PRICE_LIST_HEADER: "📋 <b>БАЗОВЫЕ РАСЦЕНКИ (Работа):</b>\n\n",
    
    CONTACTS: 
        "📞 <b>Связь с менеджером ProElectro:</b>\n\n" +
        "👤 <b>Ернияз</b>\n" +
        "📱 <code>+7 (706) 606-63-23</code>\n\n" +
        "📍 <i>Алматы, Казахстан</i>\n" +
        "🌐 <i>Работаем без выходных</i>",
    
    CONTACT_SAVED: "✅ <b>Ваш номер успешно сохранен!</b>\nТеперь менеджер сможет связаться с вами быстрее.",
    
    NO_ORDERS: "📭 <b>У вас пока нет сохраненных расчетов.</b>\nНажмите «⚡️ Рассчитать смету», чтобы создать первый.",
    
    ADMIN_DENIED: "⛔️ <b>Доступ запрещен.</b>\nЭта команда доступна только администраторам системы.",
    
    ERROR_GENERIC: "⚠️ <b>Произошла ошибка.</b>\nПожалуйста, попробуйте позже или нажмите /start для перезагрузки.",
    
    SPAM_PROMPT: "✉️ <b>Режим рассылки:</b>\nОтправьте текст или фото с подписью. \nНачните сообщение строго со слова: <code>РАССЫЛКА:</code>"
};

/**
 * Настройки кнопок клавиатуры.
 */
const BUTTONS = {
    CALC: '⚡️ Рассчитать смету',
    ORDERS: '📂 Мои расчеты',
    PRICES: '💰 Прайс-лист',
    CONTACTS: '📞 Контакты',
    SHARE_PHONE: '📱 Отправить мой номер',
    BACK: '🔙 Назад'
};

/**
 * Клавиатуры (Keyboards)
 */
export const KB = {
    MAIN_MENU: {
        keyboard: [
            [{ text: BUTTONS.CALC }, { text: BUTTONS.ORDERS }],
            [{ text: BUTTONS.PRICES }, { text: BUTTONS.CONTACTS }]
        ],
        resize_keyboard: true,
        input_field_placeholder: "Выберите пункт меню..."
    },
    CONTACT_REQUEST: {
        keyboard: [
            [{ text: BUTTONS.SHARE_PHONE, request_contact: true }],
            [{ text: BUTTONS.BACK }]
        ],
        resize_keyboard: true
    },
    REMOVE: {
        remove_keyboard: true
    },
    ADMIN_PANEL: {
        inline_keyboard: [
            [{ text: '📊 Статистика (Funnel)', callback_data: 'adm_stats' }],
            [{ text: '📋 Список заказов (List)', callback_data: 'adm_list' }],
            [{ text: '✉️ Сделать рассылку', callback_data: 'adm_spam' }]
        ]
    },
    WALL_SELECTION: {
        inline_keyboard: [
            [{ text: '🟢 Легкие (ГКЛ / Газоблок)', callback_data: 'wall_light' }],
            [{ text: '🟡 Средние (Кирпич)', callback_data: 'wall_medium' }],
            [{ text: '🔴 Тяжелые (Бетон / Монолит)', callback_data: 'wall_heavy' }]
        ]
    }
};

// =============================================================================
// 2. МЕНЕДЖЕР СЕССИЙ (SESSION MANAGER CLASS)
// =============================================================================

/**
 * Класс для управления состоянием пользователей.
 * Позволяет хранить временные данные (шаг калькулятора, введенную площадь) в памяти.
 */
class SessionManager {
    constructor() {
        this.store = new Map();
    }

    /**
     * Получить сессию пользователя. Если нет - создать новую.
     * @param {number} chatId 
     * @returns {Object} Объект сессии
     */
    get(chatId) {
        if (!this.store.has(chatId)) {
            this.store.set(chatId, { step: 'IDLE', data: {}, lastActivity: Date.now() });
        }
        return this.store.get(chatId);
    }

    /**
     * Обновить данные сессии.
     * @param {number} chatId 
     * @param {Object} updates - Частичное обновление полей
     */
    update(chatId, updates) {
        const current = this.get(chatId);
        this.store.set(chatId, { 
            ...current, 
            ...updates, 
            lastActivity: Date.now() 
        });
    }

    /**
     * Сбросить сессию (например, при выходе в меню).
     * @param {number} chatId 
     */
    reset(chatId) {
        this.store.set(chatId, { step: 'IDLE', data: {}, lastActivity: Date.now() });
    }

    /**
     * Очистка старых сессий (Garbage Collection).
     * Можно вызывать по таймеру, если пользователей будет очень много.
     */
    cleanup() {
        const now = Date.now();
        const TTL = 24 * 60 * 60 * 1000; // 24 часа
        for (const [key, value] of this.store.entries()) {
            if (now - value.lastActivity > TTL) {
                this.store.delete(key);
            }
        }
    }
}

// Экземпляр менеджера сессий (Singleton)
export const sessions = new SessionManager();

// =============================================================================
// 3. УТИЛИТЫ И ПОМОЩНИКИ (UTILS & HELPERS)
// =============================================================================

/**
 * Проверяет, является ли пользователь администратором.
 * @param {number|string} userId 
 * @param {number|string} chatId 
 * @returns {boolean}
 */
const isAdmin = (userId, chatId) => {
    const bossId = String(config.bot.bossUsername);
    const workGroupId = String(config.bot.workGroupId);
    
    // Проверка по ID пользователя или по нахождению в рабочей группе
    return String(userId) === bossId || String(chatId) === workGroupId;
};

/**
 * Форматирует число в валюту (KZT).
 * @param {number} num 
 * @returns {string} Пример: "1 500 000 ₸"
 */
const formatCurrency = (num) => {
    return new Intl.NumberFormat('ru-KZ', {
        style: 'currency',
        currency: 'KZT',
        maximumFractionDigits: 0
    }).format(num);
};

/**
 * Безопасная отправка сообщений (с обработкой ошибок).
 * @param {number} chatId 
 * @param {string} text 
 * @param {Object} options 
 */
const safeSendMessage = async (chatId, text, options = {}) => {
    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...options });
    } catch (e) {
        console.error(`[Message Error] Chat: ${chatId}, Error: ${e.message}`);
    }
};

/**
 * Отправка уведомления админам о важном событии.
 * @param {string} textHTML 
 * @param {number|null} orderId 
 */
export const notifyAdmin = async (textHTML, orderId = null) => {
    const targetId = config.bot.workGroupId || config.bot.bossUsername;
    if (!targetId) {
        console.warn('[Notify] No admin target configured!');
        return;
    }

    const options = { parse_mode: 'HTML' };

    // Если передан ID заказа, добавляем кнопки управления
    if (orderId) {
        options.reply_markup = {
            inline_keyboard: [
                [{ text: '🙋‍♂️ Взять в работу', callback_data: `take_order_${orderId}` }],
            ]
        };
    }

    try {
        await bot.sendMessage(targetId, textHTML, options);
    } catch (e) {
        console.error(`[Notify Error] Failed to send to ${targetId}:`, e.message);
    }
};

// =============================================================================
// 4. КОНТРОЛЛЕРЫ АДМИН-ПАНЕЛИ (ADMIN CONTROLLERS)
// =============================================================================

/**
 * Обработчик всех админских команд.
 * @param {Object} msg - Объект сообщения Telegram
 * @param {Array} match - Результат RegEx
 */
export const handleAdminCommand = async (msg, match) => {
    const cmd = match[1]; // stats, list, spam
    const chatId = msg.chat.id;

    // 1. Проверка прав (Security Check)
    if (!isAdmin(msg.from.id, chatId)) {
        console.warn(`[Security] Unauthorized admin access attempt by ${msg.from.id}`);
        // Не отвечаем, чтобы не палить существование админки, или отвечаем нейтрально
        return; 
    }

    // UX: Показываем, что бот "печатает"
    await bot.sendChatAction(chatId, 'typing');

    try {
        switch (cmd) {
            case 'stats':
                await renderStats(chatId);
                break;
            case 'list':
                await renderOrdersList(chatId);
                break;
            case 'spam':
                await safeSendMessage(chatId, TEXTS.SPAM_PROMPT);
                break;
            default:
                await safeSendMessage(chatId, '⚠️ Неизвестная команда.');
        }
    } catch (e) {
        console.error(`[Admin Error] Cmd: ${cmd}`, e);
        await safeSendMessage(chatId, '❌ Ошибка выполнения команды.');
    }
};

/**
 * Рендеринг статистики воронки продаж.
 */
async function renderStats(chatId) {
    const stats = await db.getStats();
    let report = `📊 <b>ВОРОНКА ПРОДАЖ (REAL-TIME):</b>\n\n`;

    if (stats.funnel.length > 0) {
        let totalSum = 0;
        let totalCount = 0;

        stats.funnel.forEach(row => {
            // Маппинг статусов в красивые названия
            const statusKey = Object.keys(STATUS_CONFIG).find(k => k === row.status) || row.status;
            const label = STATUS_CONFIG[statusKey]?.label || row.status;
            const icon = STATUS_CONFIG[statusKey]?.icon || '🔹';
            
            const money = parseFloat(row.money || 0);
            const count = parseInt(row.count || 0);
            
            totalSum += money;
            totalCount += count;

            report += `${icon} <b>${label}:</b> ${count} шт. (~${formatCurrency(money)})\n`;
        });

        report += `➖➖➖➖➖➖➖➖\n`;
        report += `💰 <b>ИТОГО:</b> ${formatCurrency(totalSum)} (${totalCount} заявок)`;
    } else {
        report += `📭 База заказов пуста.`;
    }

    await safeSendMessage(chatId, report);
}

/**
 * Рендеринг списка последних заказов.
 */
async function renderOrdersList(chatId) {
    // Получаем последние 10 заказов с полной инфой
    const res = await db.query(`
        SELECT 
            o.id, 
            u.first_name, 
            u.username, 
            u.phone, 
            l.area, 
            l.total_work_cost, 
            o.status, 
            o.created_at
        FROM orders o 
        JOIN users u ON o.user_id = u.telegram_id 
        JOIN leads l ON o.lead_id = l.id
        ORDER BY o.created_at DESC 
        LIMIT 10
    `);

    if (res.rows.length === 0) {
        return safeSendMessage(chatId, '📭 Активных заказов нет.');
    }

    let response = `📋 <b>ПОСЛЕДНИЕ 10 ЗАКАЗОВ:</b>\n\n`;
    
    res.rows.forEach(row => {
        const date = new Date(row.created_at).toLocaleDateString('ru-RU');
        const statusKey = Object.keys(STATUS_CONFIG).find(k => k === row.status) || row.status;
        const icon = STATUS_CONFIG[statusKey]?.icon || '❓';
        const cost = formatCurrency(Math.round(row.total_work_cost));
        
        // Формируем строку заказа
        response += `🔹 <b>#${row.id}</b> ${icon} | ${date}\n`;
        response += `👤 ${row.first_name} | ${row.area} м²\n`;
        response += `💰 ${cost}\n`;
        if (row.phone) response += `📱 ${row.phone}\n`;
        response += `\n`;
    });

    await safeSendMessage(chatId, response);
}

// =============================================================================
// 5. ОСНОВНОЙ КОНТРОЛЛЕР СООБЩЕНИЙ (MAIN MESSAGE HANDLER)
// =============================================================================

export const setupMessageHandlers = () => {

    // 1. Инициализация команд бота (для меню Telegram)
    bot.setMyCommands([
        { command: '/start', description: '🚀 Главное меню' },
        { command: '/admin', description: '🔐 Панель управления' }
    ]).catch(e => console.error('[Init] Failed to set commands:', e.message));

    // =========================================================================
    // ОБРАБОТЧИК: /start
    // =========================================================================
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const user = msg.from;

        try {
            // 1. Upsert пользователя в БД (сохраняем/обновляем инфу)
            await db.upsertUser(user.id, user.first_name, user.username);
            
            // 2. Сброс состояния
            sessions.reset(chatId);

            // 3. Приветствие
            await safeSendMessage(chatId, TEXTS.WELCOME(user.first_name), { 
                reply_markup: KB.MAIN_MENU 
            });

        } catch (e) {
            console.error('[Start Error]', e);
            await safeSendMessage(chatId, TEXTS.ERROR_GENERIC);
        }
    });

    // =========================================================================
    // ОБРАБОТЧИК: /admin (Точка входа в админку)
    // =========================================================================
    bot.onText(/\/admin/, async (msg) => {
        const chatId = msg.chat.id;
        
        // Тихий игнор, если не админ
        if (!isAdmin(msg.from.id, chatId)) return;

        await safeSendMessage(chatId, '🕵️‍♂️ <b>Админ-панель ProElectro</b>\nВыберите действие:', {
            reply_markup: KB.ADMIN_PANEL
        });
    });

    // Регистрация команд быстрого доступа для админа
    bot.onText(/\/(stats|list|spam)/, handleAdminCommand);

    // =========================================================================
    // ОБРАБОТЧИК: Контакт (Поделиться телефоном)
    // =========================================================================
    bot.on('contact', async (msg) => {
        const chatId = msg.chat.id;
        
        // Защита: нельзя отправить чужой контакт
        if (msg.contact.user_id !== msg.from.id) {
            return safeSendMessage(chatId, '⚠️ Пожалуйста, отправьте <b>свой</b> контакт, используя кнопку.');
        }

        try {
            await db.updateUserPhone(msg.from.id, msg.contact.phone_number);
            await safeSendMessage(chatId, TEXTS.CONTACT_SAVED, { reply_markup: KB.MAIN_MENU });
        } catch (e) {
            console.error('[Contact Error]', e);
        }
    });

    // =========================================================================
    // ОБРАБОТЧИК: Текстовые сообщения (Логика Меню)
    // =========================================================================
    bot.on('message', async (msg) => {
        // Игнорируем команды и пустые сообщения
        if (!msg.text || msg.text.startsWith('/')) return;
        
        const chatId = msg.chat.id;
        const text = msg.text;
        
        // Получаем текущую сессию
        const session = sessions.get(chatId);

        try {
            // --- 1. РОУТИНГ ГЛАВНОГО МЕНЮ ---

            if (text === BUTTONS.CALC) {
                // Начинаем флоу калькулятора
                sessions.update(chatId, { step: 'WAITING_FOR_AREA' });
                await safeSendMessage(chatId, TEXTS.CALC_START, { reply_markup: KB.REMOVE });
                return;
            }

            if (text === BUTTONS.ORDERS) {
                // Показать историю
                await handleMyOrders(chatId, msg.from.id);
                return;
            }

            if (text === BUTTONS.PRICES) {
                // Показать прайс
                await handlePriceList(chatId);
                return;
            }

            if (text === BUTTONS.CONTACTS) {
                // Показать контакты
                await safeSendMessage(chatId, TEXTS.CONTACTS, { reply_markup: KB.CONTACT_REQUEST });
                return;
            }

            if (text === BUTTONS.BACK) {
                // Возврат в меню
                sessions.reset(chatId);
                await safeSendMessage(chatId, TEXTS.MENU_HEADER, { reply_markup: KB.MAIN_MENU });
                return;
            }

            // --- 2. ЛОГИКА КАЛЬКУЛЯТОРА (Стейт-машина) ---

            if (session.step === 'WAITING_FOR_AREA') {
                await handleCalculatorAreaStep(chatId, text, session);
                return;
            }

            // Если сообщение не распознано, можно ничего не делать или показать меню
            // safeSendMessage(chatId, 'Я вас не понял. Воспользуйтесь меню.');

        } catch (e) {
            console.error(`[Message Handler Error] Chat: ${chatId}`, e);
            await safeSendMessage(chatId, TEXTS.ERROR_GENERIC);
        }
    });
};

// =============================================================================
// 6. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ БИЗНЕС-ЛОГИКИ
// =============================================================================

/**
 * Логика обработки ввода площади для калькулятора.
 */
async function handleCalculatorAreaStep(chatId, text, session) {
    // Нормализация ввода (замена запятой на точку)
    let area = parseFloat(text.replace(',', '.'));

    // Строгая Валидация
    if (isNaN(area) || area < 5 || area > 5000) {
        await safeSendMessage(chatId, TEXTS.CALC_ERROR_NUM);
        return;
    }

    // Округление до 2 знаков
    area = Math.round(area * 100) / 100;

    // Сохраняем в сессию
    sessions.update(chatId, { 
        data: { ...session.data, area: area },
        step: 'WAITING_FOR_WALLS'
    });

    // Переходим к следующему шагу (выбор стен inline-кнопками)
    await safeSendMessage(chatId, TEXTS.CALC_WALLS(area), { reply_markup: KB.WALL_SELECTION });
}

/**
 * Получение и вывод истории заказов пользователя.
 */
async function handleMyOrders(chatId, userId) {
    const res = await db.query(
        `SELECT area, total_work_cost, created_at, status 
         FROM leads 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT 5`,
        [userId]
    );

    if (res.rows.length === 0) {
        return safeSendMessage(chatId, TEXTS.NO_ORDERS);
    }

    let history = '📂 <b>ВАШИ ПОСЛЕДНИЕ РАСЧЕТЫ:</b>\n\n';
    
    res.rows.forEach((r, i) => {
        const date = new Date(r.created_at).toLocaleDateString('ru-RU');
        const cost = formatCurrency(Math.round(r.total_work_cost));
        
        history += `🔹 <b>Расчет #${i + 1}</b> (${date})\n`;
        history += `   📐 Площадь: ${r.area} м²\n`;
        history += `   💰 Смета: <b>${cost}</b>\n\n`;
    });
    
    await safeSendMessage(chatId, history);
}

/**
 * Получение и форматирование прайс-листа из базы данных.
 */
async function handlePriceList(chatId) {
    const prices = await db.getSettings();
    
    // Формируем красивый список (динамически из базы)
    const list = 
        TEXTS.PRICE_LIST_HEADER +
        `🔹 <b>Черновые работы:</b>\n` +
        `   • Штробление стен: ${prices.work_strobe} ₸/м\n` +
        `   • Прокладка кабеля: ${prices.work_cable} ₸/м\n` +
        `   • Монтаж подрозетника: ${prices.work_box} ₸/шт\n` +
        `   • Распаечная коробка: ${prices.work_junction} ₸/шт\n\n` +
        
        `🔹 <b>Чистовые работы:</b>\n` +
        `   • Установка розетки/выкл: ${prices.work_point} ₸/шт\n` +
        `   • Монтаж светильника: ${prices.work_lamp} ₸/шт\n\n` +
        
        `🔹 <b>Щитовое оборудование:</b>\n` +
        `   • Сборка (за модуль): ${prices.work_automaton} ₸\n` +
        `   • Установка щита: ${prices.work_shield_install} ₸\n\n` +

        `<i>* Цены указаны ориентировочно и могут меняться в зависимости от объема и сложности.</i>`;

    await safeSendMessage(chatId, list);
}

// Конец модуля. 
// Happy Coding! 🚀
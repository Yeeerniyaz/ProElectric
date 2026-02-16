/**
 * @file src/handlers/messages.js
 * @description Маршрутизатор текстовых сообщений и контроллер сценарных визардов.
 * Полностью интегрирован с src/constants.js для централизованного управления текстами и конфигурациями.
 * @architecture MVC + State Machine + Event Driven
 * @version 10.0.0 (Strict Constants Compliance)
 */

import { bot } from "../core.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { OrderService } from "../services/OrderService.js";
import { 
    ROLES, 
    BUTTONS, 
    KEYBOARDS, 
    TEXTS, 
    PRICING, 
    STATUS_LABELS 
} from "../constants.js";

// =============================================================================
// 🧠 SESSION MANAGER (IN-MEMORY STATE MACHINE)
// =============================================================================
export const sessions = new Map();

// Время жизни сессии: 30 минут
const SESSION_TTL = 30 * 60 * 1000;

/**
 * Менеджер управления состоянием пользователя.
 * Реализует паттерн "State" для многошаговых диалогов.
 */
const SessionManager = {
    /**
     * Инициализация или обновление сессии
     * @param {number} chatId 
     * @param {string} step - Текущий шаг визарда
     * @param {Object} data - Контекстные данные
     */
    start(chatId, step, data = {}) {
        const existing = sessions.get(chatId) || {};
        const sessionData = { 
            step, 
            data: { ...existing.data, ...data }, 
            startTime: Date.now() 
        };
        
        sessions.set(chatId, sessionData);
        
        // Garbage Collection: Таймер очистки старых сессий
        setTimeout(() => {
            const s = sessions.get(chatId);
            if (s && Date.now() - s.startTime >= SESSION_TTL) {
                sessions.delete(chatId);
            }
        }, SESSION_TTL);
        
        console.log(`🔄 [SESSION] Updated for ${chatId}: Step=${step}`);
    },

    get(chatId) {
        return sessions.get(chatId);
    },

    clear(chatId) {
        if (sessions.has(chatId)) {
            sessions.delete(chatId);
            console.log(`🗑 [SESSION] Cleared for ${chatId}`);
        }
    },

    updateData(chatId, newData) {
        const session = sessions.get(chatId);
        if (session) {
            session.data = { ...session.data, ...newData };
            sessions.set(chatId, session);
        }
    }
};

// =============================================================================
// 🛠 HELPERS & FORMATTERS
// =============================================================================

const fmtMoney = (val) => new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', maximumFractionDigits: 0 }).format(val);
const fmtDate = (d) => new Date(d).toLocaleDateString('ru-RU');

// =============================================================================
// 🎭 WIZARD SCENARIOS (STEP HANDLERS)
// =============================================================================

const STEPS = {
    // --- SCENARIO: CALCULATOR ---
    // Шаг 1: Получение площади
    CALC_AREA: async (chatId, text, session) => {
        const area = parseInt(text.replace(/\D/g, ''));
        if (isNaN(area) || area < 5 || area > 5000) {
            return bot.sendMessage(chatId, "⚠️ Введите корректную площадь помещения (от 5 до 5000 м²).");
        }
        
        SessionManager.start(chatId, "CALC_ROOMS", { area });
        
        await bot.sendMessage(chatId, "2️⃣ Введите <b>количество комнат</b>:", { 
            parse_mode: "HTML",
            reply_markup: KEYBOARDS.cancel 
        });
    },

    // Шаг 2: Получение комнат
    CALC_ROOMS: async (chatId, text, session) => {
        const rooms = parseInt(text.replace(/\D/g, ''));
        if (isNaN(rooms) || rooms < 1 || rooms > 100) {
            return bot.sendMessage(chatId, "⚠️ Введите корректное число комнат (1-100).");
        }

        // Сохраняем данные и показываем инлайн-кнопки для выбора стен
        // Логика передается в callbacks.js
        SessionManager.updateData(chatId, { rooms });
        
        // Меняем стейт на ожидание callback
        SessionManager.start(chatId, "WAIT_WALL_SELECTION", session.data);

        await bot.sendMessage(
            chatId,
            `✅ Параметры приняты: <b>${session.data.area} м²</b>, <b>${rooms} комн.</b>\n\n` +
            `3️⃣ <b>Выберите материал стен:</b>\n` +
            `<i>Это влияет на стоимость штробления и сложность работ.</i>`,
            {
                parse_mode: "HTML",
                reply_markup: KEYBOARDS.walls // Берем из constants.js
            }
        );
    },

    // --- SCENARIO: ADD EXPENSE (MANAGER) ---
    EXPENSE_AMOUNT: async (chatId, text, session) => {
        const amount = parseInt(text.replace(/\D/g, ''));
        if (isNaN(amount) || amount <= 0) {
            return bot.sendMessage(chatId, "⚠️ Введите сумму расхода числом (например: 5000).");
        }

        SessionManager.start(chatId, "EXPENSE_CATEGORY", { ...session.data, amount });

        // Тут можно было бы вынести клавиатуру категорий в constants, но оставим динамику
        const categoryKeyboard = {
            keyboard: [
                [{ text: "🚕 Такси" }, { text: "🔌 Материалы" }],
                [{ text: "🍔 Питание" }, { text: "🛠 Инструмент" }],
                [{ text: BUTTONS.CANCEL }]
            ],
            resize_keyboard: true
        };

        await bot.sendMessage(
            chatId,
            `💸 Сумма: <b>${fmtMoney(amount)}</b>\nВыберите категорию или напишите комментарий:`,
            {
                parse_mode: "HTML",
                reply_markup: categoryKeyboard
            }
        );
    },

    EXPENSE_CATEGORY: async (chatId, text, session, user) => {
        const category = text.trim();
        if (category.length > 100) {
            return bot.sendMessage(chatId, "⚠️ Слишком длинный текст. Сократите до 100 символов.");
        }

        try {
            await db.addObjectExpense(
                session.data.orderId,
                session.data.amount,
                category,
                `User: ${user.first_name}`
            );

            await bot.sendMessage(
                chatId,
                `✅ <b>Расход успешно добавлен!</b>\n` +
                `📉 Сумма: -${fmtMoney(session.data.amount)}\n` +
                `📂 Категория: ${category}`,
                {
                    parse_mode: "HTML",
                    reply_markup: KEYBOARDS.main(user.role) // Возврат в главное меню
                }
            );
        } catch (e) {
            console.error("Expense Save Error:", e);
            await bot.sendMessage(chatId, "❌ Ошибка при сохранении данных в БД.");
        } finally {
            SessionManager.clear(chatId);
        }
    },

    // --- SCENARIO: CLOSE ORDER ---
    FINISH_SUM: async (chatId, text, session, user) => {
        const sum = parseInt(text.replace(/\D/g, ''));
        if (isNaN(sum) || sum <= 0) {
            return bot.sendMessage(chatId, "⚠️ Введите корректную сумму, которую передал клиент.");
        }

        SessionManager.updateData(chatId, { finalSum: sum });
        
        // Получаем кассы сотрудника
        const accounts = await db.getAccounts(user.telegram_id);
        
        if (accounts.length === 0) {
            SessionManager.clear(chatId);
            return bot.sendMessage(chatId, "❌ Ошибка: У вас нет привязанных касс. Обратитесь к администратору.");
        }

        const buttons = accounts.map(acc => [{
            text: `${acc.type === 'bank' ? '💳' : '💵'} ${acc.name} (${fmtMoney(acc.balance)})`,
            callback_data: `wallet_${acc.id}` // Будет обработано в callbacks.js
        }]);

        await bot.sendMessage(
            chatId,
            `💰 Принятая сумма: <b>${fmtMoney(sum)}</b>\n\n⬇️ Выберите кассу для зачисления средств:`,
            {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: buttons }
            }
        );
        // Не удаляем сессию, ждем нажатия кнопки
    }
};

// =============================================================================
// 🚀 MAIN ROUTER (CONTROLLER)
// =============================================================================

export const setupMessageHandlers = () => {
    
    // --- 1. System & Entry Points ---
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            // Регистрация / Обновление пользователя
            const user = await db.upsertUser(
                msg.from.id,
                msg.from.first_name || "Guest",
                msg.from.username
            );

            SessionManager.clear(chatId);
            
            const welcomeText = 
                `Салам, <b>${user.first_name}</b>! 👋\n` +
                `Я цифровой помощник <b>ProElectric</b>.\n\n` +
                `Ваша роль: <b>${user.role.toUpperCase()}</b>\n` +
                `Выберите действие в меню ниже 👇`;

            await bot.sendMessage(
                chatId,
                welcomeText,
                {
                    parse_mode: "HTML",
                    reply_markup: KEYBOARDS.main(user.role) // Динамическое меню из constants.js
                }
            );
        } catch (e) {
            console.error("Start Error:", e);
        }
    });

    // Обработка контактов
    bot.on('contact', async (msg) => {
        if (!msg.from || msg.contact.user_id !== msg.from.id) return;
        
        const user = await db.upsertUser(
            msg.from.id,
            msg.from.first_name,
            msg.from.username,
            msg.contact.phone_number
        );
        
        await bot.sendMessage(msg.chat.id, "✅ Контакт успешно сохранен! Мы свяжемся с вами.", {
            reply_markup: KEYBOARDS.main(user.role)
        });
    });

    // --- 2. Main Message Loop ---
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;

        const chatId = msg.chat.id;
        const text = msg.text.trim();
        const userId = msg.from.id;

        // --- A. Global Navigation Checks ---
        // Используем константы для проверки нажатий
        if (text === BUTTONS.CANCEL || text === BUTTONS.BACK) {
            SessionManager.clear(chatId);
            const user = await db.upsertUser(userId, msg.from.first_name);
            return bot.sendMessage(chatId, "🔙 Возврат в главное меню.", {
                reply_markup: KEYBOARDS.main(user.role)
            });
        }

        // --- B. Client Features ---
        
        // 🧮 Калькулятор
        if (text === BUTTONS.CALCULATOR) {
            SessionManager.start(chatId, "CALC_AREA");
            return bot.sendMessage(chatId, "1️⃣ Введите <b>площадь помещения (м²)</b>:", {
                parse_mode: "HTML",
                reply_markup: KEYBOARDS.cancel
            });
        }

        // 💰 Прайс-лист
        if (text === BUTTONS.PRICE_LIST) {
            try {
                // Получаем настройки из БД для актуальных цен
                const dbSettings = await db.getSettings();
                // Генерируем текст через шаблон в constants.js
                const message = TEXTS.priceList(dbSettings);
                
                return bot.sendMessage(chatId, message, { parse_mode: "HTML" });
            } catch (e) {
                console.error("PriceList Error:", e);
                // Fallback, если БД недоступна (текст с дефолтными ценами)
                return bot.sendMessage(chatId, TEXTS.priceList(), { parse_mode: "HTML" });
            }
        }

        // 📂 Мои заказы
        if (text === BUTTONS.ORDERS) {
            const res = await db.query("SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5", [userId]);
            
            if (res.rows.length === 0) {
                return bot.sendMessage(chatId, "📭 История заказов пуста.");
            }

            let msgTxt = "<b>📂 ВАШИ ПОСЛЕДНИЕ ЗАКАЗЫ:</b>\n\n";
            res.rows.forEach(o => {
                // Используем словарь статусов из constants
                const statusLabel = STATUS_LABELS[o.status] || o.status;
                msgTxt += `🔹 <b>Заказ #${o.id}</b>\n`;
                msgTxt += `📅 ${fmtDate(o.created_at)} | ${statusLabel}\n`;
                msgTxt += `💰 ${fmtMoney(o.total_price)}\n\n`;
            });
            return bot.sendMessage(chatId, msgTxt, { parse_mode: "HTML" });
        }

        // 📞 Контакты
        if (text === BUTTONS.CONTACTS) {
            const contactKeyboard = {
                keyboard: [
                    [{ text: "📱 Отправить мой номер", request_contact: true }],
                    [{ text: BUTTONS.BACK }]
                ],
                resize_keyboard: true
            };
            
            return bot.sendMessage(chatId, 
                `📞 <b>НАШИ КОНТАКТЫ:</b>\n\n` +
                `👤 Менеджер: <b>Ернияз</b>\n` +
                `📱 <a href="tel:+77066066323">+7 (706) 606-63-23</a>\n` +
                `📍 г. Алматы\n\n` +
                `💬 Нажмите кнопку ниже, чтобы мы сами связались с вами:`, 
                { 
                    parse_mode: "HTML", 
                    reply_markup: contactKeyboard 
                }
            );
        }

        // --- C. Manager / Admin Features ---
        
        // 💵 Моя Касса
        if (text === BUTTONS.MANAGER_CASH) {
            const user = await db.upsertUser(userId, msg.from.first_name);
            // Проверка прав через ROLES
            if (![ROLES.ADMIN, ROLES.MANAGER].includes(user.role)) return;

            const accounts = await db.getAccounts(userId);
            if (accounts.length === 0) return bot.sendMessage(chatId, "🤷‍♂️ У вас нет доступных касс.");

            let balanceMsg = "<b>👜 ФИНАНСОВЫЙ ОТЧЕТ:</b>\n\n";
            let total = 0;
            accounts.forEach(acc => {
                const icon = acc.type === 'bank' ? '💳' : '💵';
                balanceMsg += `▫️ ${icon} <b>${acc.name}</b>: ${fmtMoney(acc.balance)}\n`;
                total += parseFloat(acc.balance);
            });
            balanceMsg += `\n<b>💰 ИТОГО: ${fmtMoney(total)}</b>`;
            return bot.sendMessage(chatId, balanceMsg, { parse_mode: "HTML" });
        }

        // 👷‍♂️ Мои объекты
        if (text === BUTTONS.MANAGER_OBJECTS) {
            const user = await db.upsertUser(userId, msg.from.first_name);
            if (![ROLES.ADMIN, ROLES.MANAGER].includes(user.role)) return;

            // Получаем активные заказы
            const orders = await OrderService.getActiveOrders(userId, user.role);
            if (orders.length === 0) return bot.sendMessage(chatId, "📭 Активных объектов в работе нет.");

            // Рендерим карточки заказов
            for (const o of orders) {
                const expenses = parseFloat(o.expenses_sum || 0);
                const expText = expenses > 0 ? `\n💸 Расходы: -${fmtMoney(expenses)}` : "";
                const clientName = o.client_name || 'Клиент';
                const clientPhone = o.client_phone || 'нет номера';
                
                const msgText = 
                    `🔌 <b>ОБЪЕКТ #${o.id}</b> | ${STATUS_LABELS[o.status]}\n` +
                    `👤 ${clientName} (${clientPhone})\n` +
                    `📍 ${o.city || 'Алматы'}\n` +
                    `💰 Смета: <b>${fmtMoney(o.total_price)}</b>` + expText;

                await bot.sendMessage(chatId, msgText, {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "💸 Расход", callback_data: `add_expense_${o.id}` },
                                { text: "✅ Закрыть", callback_data: `close_order_start_${o.id}` }
                            ]
                        ]
                    }
                });
            }
            return;
        }

        // --- D. Wizard State Machine Processing ---
        
        const session = SessionManager.get(chatId);
        
        if (session && STEPS[session.step]) {
            const user = await db.upsertUser(userId, msg.from.first_name);
            try {
                console.log(`👣 [WIZARD] Executing step ${session.step} for ${user.first_name}`);
                await STEPS[session.step](chatId, text, session, user);
            } catch (err) {
                console.error(`Wizard Error [${session.step}]:`, err);
                bot.sendMessage(chatId, "⚠️ Произошла ошибка при обработке данных. Попробуйте снова.", { 
                    reply_markup: KEYBOARDS.main(user.role) 
                });
                SessionManager.clear(chatId);
            }
        }
    });
};

/**
 * Уведомление сотрудников о новом событии (например, новом заказе).
 * Используется в callbacks.js и Admin Service.
 * @param {string} text - Текст сообщения (HTML)
 * @param {number|null} orderId - ID заказа (опционально, для кнопки действия)
 */
export const notifyAdmin = async (text, orderId = null) => {
    try {
        const employees = await db.getEmployees();
        // Убираем дубликаты ID, если есть
        const uniqueIds = [...new Set(employees.map(u => u.telegram_id))];

        const markup = orderId ? {
            inline_keyboard: [[{ text: "🙋‍♂️ Взять в работу", callback_data: `take_order_${orderId}` }]]
        } : undefined;

        // Рассылка (Promise.allSettled чтобы ошибка одного не ломала всех)
        const results = await Promise.allSettled(uniqueIds.map(id => 
            bot.sendMessage(id, text, { parse_mode: "HTML", reply_markup: markup })
        ));
        
        // Логирование результатов рассылки
        const successCount = results.filter(r => r.status === 'fulfilled').length;
        console.log(`📢 [NOTIFY] Sent to ${successCount}/${uniqueIds.length} employees.`);

        // Дублирование в канал (если настроен)
        if (config.bot.channelId) {
             bot.sendMessage(config.bot.channelId, text, { parse_mode: "HTML" }).catch(e => {
                 console.warn(`⚠️ Channel notify failed: ${e.message}`);
             });
        }

    } catch (e) {
        console.error("NotifyAdmin Critical Error:", e);
    }
};
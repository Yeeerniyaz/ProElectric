/**
 * @file src/handlers/messages.js
 * @description Маршрутизатор текстовых сообщений (Message Router) и контроллер сцен (Wizard Controller).
 * Реализует главное меню, пошаговый калькулятор, финансовые операции и админские команды.
 * @version 8.2.0 (Role-Based Menu & State Machine)
 */

import { bot } from "../core.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { OrderService } from "../services/OrderService.js";

// =============================================================================
// 🧠 SESSION MANAGER (IN-MEMORY)
// =============================================================================
export const sessions = new Map();

// Время жизни сессии: 30 минут
const SESSION_TTL = 30 * 60 * 1000;

/**
 * Очищает сессию пользователя
 * @param {number} chatId 
 */
const clearSession = (chatId) => {
    sessions.delete(chatId);
};

/**
 * Инициализирует новую сессию
 * @param {number} chatId 
 * @param {string} step - Начальный шаг
 * @param {Object} data - Начальные данные
 */
const startSession = (chatId, step, data = {}) => {
    sessions.set(chatId, { step, data, startTime: Date.now() });
    
    // Auto-cleanup timer
    setTimeout(() => {
        const s = sessions.get(chatId);
        if (s && Date.now() - s.startTime >= SESSION_TTL) {
            sessions.delete(chatId);
            // Опционально: можно отправить сообщение "Сессия истекла"
        }
    }, SESSION_TTL);
};

// =============================================================================
// 🎨 UI COMPONENTS (KEYBOARDS & FORMATTERS)
// =============================================================================

const currencyFormatter = new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'KZT',
    maximumFractionDigits: 0
});

const formatKZT = (val) => currencyFormatter.format(val);

const UI = {
    /**
     * Генератор главного меню в зависимости от роли
     * @param {string} role - 'admin' | 'manager' | 'client'
     */
    mainMenu: (role) => {
        const keyboard = [
            [{ text: "🧮 Рассчитать стоимость" }, { text: "📂 Мои заказы" }],
            [{ text: "💰 Прайс-лист" }, { text: "📞 Контакты" }]
        ];

        // Расширенное меню для сотрудников
        if (['admin', 'manager'].includes(role)) {
            keyboard.unshift([
                { text: "👷‍♂️ Мои объекты" }, 
                { text: "💵 Моя Касса" }
            ]);
        }

        // Админ-панель (ссылка на веб или инфо)
        if (role === 'admin') {
            keyboard.unshift([{ text: "⚙️ Настройки" }]); // Заглушка, если нужно будет добавить настройки бота
        }

        return {
            keyboard,
            resize_keyboard: true,
            one_time_keyboard: false
        };
    },

    cancel: {
        keyboard: [[{ text: "❌ Отмена" }]],
        resize_keyboard: true,
        one_time_keyboard: true
    },

    contact: {
        keyboard: [
            [{ text: "📱 Отправить мой номер", request_contact: true }],
            [{ text: "🔙 Назад" }]
        ],
        resize_keyboard: true
    },

    expenseCategories: {
        keyboard: [
            [{ text: "🚕 Такси" }, { text: "🔌 Материалы" }],
            [{ text: "🍔 Питание" }, { text: "🛠 Инструмент" }],
            [{ text: "❌ Отмена" }]
        ],
        resize_keyboard: true
    }
};

// =============================================================================
// 🎭 WIZARD SCENES (STEP HANDLERS)
// =============================================================================

const STEPS = {
    // --- SCENARIO: CALCULATOR ---
    AREA: async (chatId, text, session) => {
        const area = parseInt(text.replace(/\D/g, ''));
        if (isNaN(area) || area < 5 || area > 10000) {
            return bot.sendMessage(chatId, "⚠️ Пожалуйста, введите корректную площадь (от 5 до 10000 м²).");
        }
        
        session.data.area = area;
        session.step = "ROOMS";
        
        await bot.sendMessage(chatId, "2️⃣ Введите <b>количество комнат</b> (числом):", { 
            parse_mode: "HTML",
            reply_markup: UI.cancel 
        });
    },

    ROOMS: async (chatId, text, session) => {
        const rooms = parseInt(text.replace(/\D/g, ''));
        if (isNaN(rooms) || rooms < 1 || rooms > 100) {
            return bot.sendMessage(chatId, "⚠️ Введите корректное количество комнат (1-100).");
        }

        session.data.rooms = rooms;
        // Передаем управление в Callback Handler (выбор стен кнопками)
        session.step = "WALLS_WAIT"; 

        await bot.sendMessage(
            chatId,
            `✅ Принято: ${session.data.area} м², ${rooms} комн.\n\n` +
            `3️⃣ <b>Выберите материал стен:</b>\n` +
            `<i>От этого зависит сложность и стоимость штробления.</i>`,
            {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🧱 Газоблок / ГКЛ (Легко)", callback_data: "wall_light" }],
                        [{ text: "🧱 Кирпич (Средне)", callback_data: "wall_brick" }],
                        [{ text: "🏗 Бетон / Монолит (Сложно)", callback_data: "wall_concrete" }]
                    ]
                }
            }
        );
    },

    // --- SCENARIO: ADD EXPENSE (MANAGER) ---
    EXPENSE_AMOUNT: async (chatId, text, session) => {
        const amount = parseInt(text.replace(/\D/g, ''));
        if (isNaN(amount) || amount <= 0) {
            return bot.sendMessage(chatId, "⚠️ Введите сумму расхода числом (например: 5000).");
        }

        session.data.amount = amount;
        session.step = "EXPENSE_CATEGORY";

        await bot.sendMessage(
            chatId,
            `💸 Сумма расхода: <b>${formatKZT(amount)}</b>\nВыберите категорию или напишите свою:`,
            {
                parse_mode: "HTML",
                reply_markup: UI.expenseCategories
            }
        );
    },

    EXPENSE_CATEGORY: async (chatId, text, session, user) => {
        const category = text.trim();
        if (category.length > 50) {
            return bot.sendMessage(chatId, "⚠️ Слишком длинное название категории. Сократите до 50 символов.");
        }

        try {
            await db.addObjectExpense(
                session.data.orderId,
                session.data.amount,
                category,
                `Added by ${user.first_name}`
            );

            await bot.sendMessage(
                chatId,
                `✅ <b>Расход успешно добавлен!</b>\n` +
                `📉 Сумма: -${formatKZT(session.data.amount)}\n` +
                `📂 Категория: ${category}`,
                {
                    parse_mode: "HTML",
                    reply_markup: UI.mainMenu(user.role)
                }
            );
        } catch (e) {
            console.error("Expense Add Error:", e);
            await bot.sendMessage(chatId, "❌ Ошибка при сохранении данных.");
        } finally {
            clearSession(chatId);
        }
    },

    // --- SCENARIO: CLOSE ORDER (FINISH) ---
    FINISH_SUM: async (chatId, text, session) => {
        const sum = parseInt(text.replace(/\D/g, ''));
        if (isNaN(sum) || sum <= 0) {
            return bot.sendMessage(chatId, "⚠️ Введите итоговую сумму, полученную от клиента (числом).");
        }

        session.data.finalSum = sum;
        
        // Получаем список доступных касс для этого пользователя
        const accounts = await db.getAccounts(session.data.userId);
        
        if (accounts.length === 0) {
            return bot.sendMessage(chatId, "❌ У вас нет доступных касс. Обратитесь к администратору.");
        }

        const buttons = accounts.map(acc => [{
            text: `${acc.type === 'bank' ? '💳' : '💵'} ${acc.name}`,
            callback_data: `wallet_${acc.id}` // Обрабатывается в callbacks.js
        }]);

        await bot.sendMessage(
            chatId,
            `💰 Итоговая сумма: <b>${formatKZT(sum)}</b>\n\n⬇️ Куда поступили средства?`,
            {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: buttons }
            }
        );
        // Дальше ждем callback, сессию не удаляем
    }
};

// =============================================================================
// 🚀 MESSAGE ROUTER
// =============================================================================

export const setupMessageHandlers = () => {
    
    // --- 1. /start Handler ---
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            // Upsert пользователя (регистрация или обновление)
            const user = await db.upsertUser(
                msg.from.id,
                msg.from.first_name || "Гость",
                msg.from.username
            );

            const roleLabel = {
                'admin': '👑 Администратор',
                'manager': '👷‍♂️ Менеджер / Мастер',
                'client': '👤 Клиент'
            };

            await bot.sendMessage(
                chatId,
                `Салам, <b>${user.first_name}</b>! 👋\n` +
                `Я бот-помощник <b>ProElectric</b>.\n\n` +
                `🛠 <b>Что я умею:</b>\n` +
                `• Быстрый расчет стоимости электромонтажа\n` +
                `• Просмотр истории заказов\n` +
                `• Связь с мастером\n\n` +
                `<i>Ваш статус: ${roleLabel[user.role] || user.role}</i>`,
                {
                    parse_mode: "HTML",
                    reply_markup: UI.mainMenu(user.role)
                }
            );
            clearSession(chatId);
        } catch (e) {
            console.error("Start Error:", e);
        }
    });

    // --- 2. Contact Handler ---
    bot.on('contact', async (msg) => {
        if (!msg.from || msg.contact.user_id !== msg.from.id) return;
        
        const user = await db.upsertUser(
            msg.from.id,
            msg.from.first_name,
            msg.from.username,
            msg.contact.phone_number
        );
        
        await bot.sendMessage(msg.chat.id, "✅ Номер телефона сохранен! Мы свяжемся с вами при необходимости.", {
            reply_markup: UI.mainMenu(user.role)
        });
    });

    // --- 3. Main Message Handler ---
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;

        const chatId = msg.chat.id;
        const text = msg.text.trim();
        const userId = msg.from.id;

        // --- GLOBAL COMMANDS ---
        if (text === "❌ Отмена" || text === "🔙 Назад") {
            clearSession(chatId);
            const user = await db.upsertUser(userId, msg.from.first_name); // Refresh user role
            return bot.sendMessage(chatId, "🏠 Главное меню:", {
                reply_markup: UI.mainMenu(user.role)
            });
        }

        // --- A. CLIENT MENU ---
        
        if (text === "🧮 Рассчитать стоимость") {
            startSession(chatId, "AREA");
            return bot.sendMessage(chatId, "1️⃣ Введите <b>площадь помещения (м²)</b>:", {
                parse_mode: "HTML",
                reply_markup: UI.cancel
            });
        }

        if (text === "💰 Прайс-лист") {
            // Получаем базовые цены (например, из настроек БД или статики)
            const settings = await db.getSettings();
            const p = {
                concrete: settings.price_strobe_concrete || 0,
                brick: settings.price_strobe_brick || 0,
                point: settings.price_socket_install || 0
            };

            return bot.sendMessage(chatId, 
                `📋 <b>БАЗОВЫЙ ПРАЙС-ЛИСТ</b>\n\n` +
                `🧱 Штробление (Кирпич): <b>${formatKZT(p.brick)} / м</b>\n` +
                `🏗 Штробление (Бетон): <b>${formatKZT(p.concrete)} / м</b>\n` +
                `🔌 Установка точки: <b>${formatKZT(p.point)} / шт</b>\n\n` +
                `<i>* Полная смета рассчитывается индивидуально после замера.</i>`, 
                { parse_mode: "HTML" }
            );
        }

        if (text === "📂 Мои заказы") {
            const orders = await OrderService.getActiveOrders(userId, 'client'); // Надо бы фильтр по юзеру
            // В OrderService.js метод getActiveOrders возвращает все заказы для админов. 
            // Для клиента лучше использовать отдельный запрос или фильтрацию.
            // Здесь используем упрощенный запрос через db (нужно реализовать в db.js getOrdersByUserId)
            // Пока заглушка или используем то что есть:
            const userOrders = await db.query("SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5", [userId]);
            
            if (userOrders.rows.length === 0) {
                return bot.sendMessage(chatId, "📭 У вас пока нет активных заказов.");
            }

            let msgTxt = "<b>📂 ВАШИ ПОСЛЕДНИЕ ЗАКАЗЫ:</b>\n\n";
            userOrders.rows.forEach(o => {
                const statusEmoji = { new: '🆕', work: '🛠', done: '✅', cancel: '❌' }[o.status] || '❓';
                msgTxt += `🔹 <b>Заказ #${o.id}</b>\n`;
                msgTxt += `📅 ${new Date(o.created_at).toLocaleDateString()}\n`;
                msgTxt += `💰 Сумма: ${formatKZT(o.total_price)}\n`;
                msgTxt += `Статус: ${statusEmoji}\n\n`;
            });

            return bot.sendMessage(chatId, msgTxt, { parse_mode: "HTML" });
        }

        if (text === "📞 Контакты") {
            return bot.sendMessage(chatId, 
                `📞 <b>Наши контакты:</b>\n\n` +
                `👤 Ернияз (Руководитель)\n` +
                `📱 <a href="tel:+77066066323">+7 (706) 606-63-23</a>\n` +
                `📍 г. Алматы\n\n` +
                `💬 Нажмите кнопку ниже, чтобы отправить свой номер для связи:`, 
                { 
                    parse_mode: "HTML", 
                    reply_markup: UI.contact 
                }
            );
        }

        // --- B. MANAGER / ADMIN MENU ---
        
        // 💵 МОЯ КАССА
        if (text === "💵 Моя Касса") {
            const user = await db.upsertUser(userId, msg.from.first_name);
            if (!['admin', 'manager'].includes(user.role)) return;

            const accounts = await db.getAccounts(userId); // Фильтр внутри db.getAccounts
            
            if (accounts.length === 0) {
                return bot.sendMessage(chatId, "🤷‍♂️ У вас нет доступных касс.");
            }

            let balanceMsg = "<b>👜 ВАШИ ФИНАНСЫ:</b>\n\n";
            let total = 0;

            accounts.forEach(acc => {
                const icon = acc.type === 'bank' ? '💳' : '💵';
                balanceMsg += `${icon} <b>${acc.name}</b>: ${formatKZT(acc.balance)}\n`;
                total += parseFloat(acc.balance);
            });

            balanceMsg += `\n<b>💰 ИТОГО: ${formatKZT(total)}</b>`;
            return bot.sendMessage(chatId, balanceMsg, { parse_mode: "HTML" });
        }

        // 👷‍♂️ МОИ ОБЪЕКТЫ
        if (text === "👷‍♂️ Мои объекты") {
            const user = await db.upsertUser(userId, msg.from.first_name);
            if (!['admin', 'manager'].includes(user.role)) return;

            const orders = await OrderService.getActiveOrders(userId, user.role);
            
            if (orders.length === 0) {
                return bot.sendMessage(chatId, "📭 Активных объектов в работе нет.");
            }

            for (const o of orders) {
                const expenses = parseFloat(o.expenses_sum || 0);
                const expText = expenses > 0 ? `\n💸 Расходы: -${formatKZT(expenses)}` : "";
                
                const msgText = 
                    `🔌 <b>Объект #${o.id}</b> | ${o.status === 'work' ? '🛠 В работе' : '🆕 Новый'}\n` +
                    `👤 ${o.client_name || 'Клиент'} (${o.client_phone || 'нет тел.'})\n` +
                    `📍 ${o.city || 'Алматы'}\n` +
                    `💰 Смета: ${formatKZT(o.total_price)}` + expText;

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

        // --- C. WIZARD STEP PROCESSOR ---
        const session = sessions.get(chatId);
        if (session && STEPS[session.step]) {
            // Обогащаем сессию данными о пользователе
            const user = await db.upsertUser(userId, msg.from.first_name);
            session.data.userId = userId;
            
            try {
                await STEPS[session.step](chatId, text, session, user);
            } catch (err) {
                console.error(`Wizard Error [${session.step}]:`, err);
                bot.sendMessage(chatId, "⚠️ Произошла ошибка. Попробуйте начать заново (/start).");
                clearSession(chatId);
            }
        }
    });
};

/**
 * Уведомление админов о новом заказе
 * @param {string} text - Текст уведомления
 * @param {number|null} orderId - ID заказа для кнопки "Взять в работу"
 */
export const notifyAdmin = async (text, orderId = null) => {
    try {
        const admins = await db.getEmployees(); // Получаем всех админов и менеджеров
        
        const markup = orderId ? {
            inline_keyboard: [[{ text: "🙋‍♂️ Взять в работу", callback_data: `take_order_${orderId}` }]]
        } : undefined;

        for (const admin of admins) {
            await bot.sendMessage(admin.telegram_id, text, {
                parse_mode: "HTML",
                reply_markup: markup
            }).catch(e => console.error(`Failed to send to admin ${admin.telegram_id}:`, e.message));
        }
    } catch (e) {
        console.error("NotifyAdmin Error:", e);
    }
};
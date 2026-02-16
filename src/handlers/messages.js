/**
 * @file src/handlers/messages.js
 * @description Обработчик текстовых сообщений (Message Router).
 * Реализует машину состояний (State Machine) для пошагового визарда калькулятора.
 * Отвечает за навигацию по главному меню и маршрутизацию команд.
 * @module Handlers/Messages
 * @version 2.0.0 (Senior Level)
 */

import { bot } from "../core.js";
import * as db from "../database/index.js";
import { KEYBOARDS, BUTTONS, TEXTS, ROLES } from "../constants.js";
import { OrderService } from "../services/OrderService.js";

// =============================================================================
// УПРАВЛЕНИЕ СЕССИЯМИ (SESSION MANAGEMENT)
// =============================================================================

/**
 * Хранилище сессий пользователей.
 * Используется для запоминания промежуточных данных калькулятора (площадь, комнаты).
 * Ключ: chatId (Number), Значение: Объект сессии { step, data: {} }
 * В высоконагруженном проекте здесь должен быть Redis, но для текущих задач Map идеален.
 */
export const sessions = new Map();

/**
 * Очистить сессию пользователя (например, после завершения расчета).
 * @param {number} chatId 
 */
export const clearSession = (chatId) => {
    sessions.delete(chatId);
};

// =============================================================================
// ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ (MESSAGE HANDLER)
// =============================================================================

/**
 * Инициализация всех слушателей текстовых сообщений.
 * Вызывается один раз при старте бота.
 */
export const setupMessageHandlers = () => {

    // --- 1. ОБРАБОТКА КОМАНДЫ /START (REGISTRATION) ---
    bot.onText(/\/start/, async (message) => {
        const chatId = message.chat.id;
        const { id, first_name, username } = message.from;

        try {
            // LEAD CAPTURE: Сразу сохраняем лид в базу данных
            // Если пользователь уже есть, обновим его имя/username
            const user = await db.upsertUser(id, first_name, username, null);

            console.log(`👤 [NEW LEAD] Пользователь ${first_name} (@${username}) запустил бота.`);

            // Отправляем приветствие с персонализацией и правильной клавиатурой
            await bot.sendMessage(chatId, TEXTS.welcome(first_name), {
                parse_mode: "HTML",
                reply_markup: KEYBOARDS.main(user.role)
            });

        } catch (error) {
            console.error("❌ Ошибка в /start:", error);
            await bot.sendMessage(chatId, "⚠️ Произошла ошибка при регистрации. Попробуйте позже.");
        }
    });

    // --- 2. ОБРАБОТКА ТЕКСТА (TEXT ROUTER) ---
    bot.on("message", async (message) => {
        // Игнорируем команды (начинаются с /) и служебные сообщения (оставил/вошел в чат)
        if (!message.text || message.text.startsWith("/")) return;

        const chatId = message.chat.id;
        const text = message.text;
        const userId = message.from.id;

        // Получаем текущую сессию пользователя (если он в процессе калькулятора)
        const session = sessions.get(chatId);

        try {
            // =================================================================
            // БЛОК 1: ГЛАВНОЕ МЕНЮ (MAIN MENU NAVIGATION)
            // =================================================================

            // 🧮 Кнопка: Рассчитать стоимость
            if (text === BUTTONS.CALCULATOR) {
                // Инициализируем новую сессию
                sessions.set(chatId, { step: "WAIT_AREA", data: {} });
                
                return bot.sendMessage(chatId, "1️⃣ Введите <b>общую площадь помещения</b> (м²):", { 
                    parse_mode: "HTML",
                    reply_markup: KEYBOARDS.cancel // Показываем кнопку "Отмена"
                });
            }

            // 💰 Кнопка: Прайс-лист
            if (text === BUTTONS.PRICE_LIST) {
                // Получаем "живые" цены из базы данных
                const settings = await db.getSettings();
                // Генерируем красивый текст прайса
                const priceText = TEXTS.priceList(settings);

                return bot.sendMessage(chatId, priceText, { parse_mode: "HTML" });
            }

            // 📞 Кнопка: Контакты
            if (text === BUTTONS.CONTACTS) {
                return bot.sendMessage(chatId, TEXTS.contacts(), { parse_mode: "HTML" });
            }

            // 📂 Кнопка: Мои заказы (История)
            if (text === BUTTONS.ORDERS) {
                // Получаем последние 5 заказов пользователя
                const orders = await OrderService.getUserOrders(userId);

                if (orders.length === 0) {
                    return bot.sendMessage(chatId, "📭 У вас пока нет расчетов. Нажмите <b>'Рассчитать стоимость'</b>!", { parse_mode: "HTML" });
                }

                let historyText = "📂 <b>Ваша история расчетов:</b>\n\n";
                
                orders.forEach((order, index) => {
                    const date = new Date(order.created_at).toLocaleDateString('ru-RU');
                    const area = order.details.params.area;
                    // Форматируем цену красиво
                    const price = new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', maximumFractionDigits: 0 }).format(order.total_price);
                    
                    historyText += `${index + 1}. 📅 <b>${date}</b> | 🏠 ${area} м² | 💰 <b>${price}</b>\n`;
                    historyText += `   ID заказа: #${order.id}\n\n`;
                });

                return bot.sendMessage(chatId, historyText, { parse_mode: "HTML" });
            }

            // ❌ Кнопка: Отмена (выход из калькулятора)
            if (text === BUTTONS.CANCEL) {
                clearSession(chatId);
                // Получаем пользователя, чтобы вернуть правильное меню (админ/клиент)
                const user = await db.upsertUser(userId, message.from.first_name, message.from.username);
                
                return bot.sendMessage(chatId, "🚫 Расчет отменен. Вы в главном меню.", {
                    reply_markup: KEYBOARDS.main(user.role)
                });
            }

            // =================================================================
            // БЛОК 2: МЕНЮ СОТРУДНИКОВ (STAFF MENU)
            // =================================================================
            
            // 👷‍♂️ Кнопка: Мои объекты (для Менеджеров)
            if (text === BUTTONS.MANAGER_OBJECTS) {
                const activeOrders = await OrderService.getManagerActiveOrders(userId);
                
                if (activeOrders.length === 0) {
                    return bot.sendMessage(chatId, "✅ У вас сейчас нет активных объектов в работе.");
                }

                for (const order of activeOrders) {
                    const txt = `🏗 <b>Объект #${order.id}</b>\n` +
                                `👤 Клиент: ${order.client_name} (@${order.client_user})\n` +
                                `📱 Тел: ${order.client_phone || 'Не указан'}\n` +
                                `🏠 Площадь: ${order.area} м²\n` +
                                `💰 Смета: ${order.total_price}\n` +
                                `💸 Расходы: ${order.expenses_sum}\n` +
                                `Статус: ${order.status}`;
                                
                    await bot.sendMessage(chatId, txt, { parse_mode: "HTML" });
                }
                return;
            }

            // 👑 Кнопка: Админ-панель
            if (text === BUTTONS.ADMIN_PANEL) {
                // Проверяем права в БД (на случай, если роль сняли, а кнопка осталась)
                const user = await db.upsertUser(userId, message.from.first_name, message.from.username);
                if (user.role !== ROLES.ADMIN) {
                    return bot.sendMessage(chatId, "⛔️ Доступ запрещен.");
                }

                return bot.sendMessage(chatId, "👑 Добро пожаловать в Панель Управления.", {
                    reply_markup: KEYBOARDS.admin // Показываем админскую клавиатуру
                });
            }
            
            // 🔙 Кнопка: Главное меню (возврат из админки)
            if (text === BUTTONS.BACK) {
                const user = await db.upsertUser(userId, message.from.first_name, message.from.username);
                return bot.sendMessage(chatId, "🔙 Возвращаемся в главное меню...", {
                    reply_markup: KEYBOARDS.main(user.role)
                });
            }

            // =================================================================
            // БЛОК 3: ЛОГИКА КАЛЬКУЛЯТОРА (WIZARD STATE MACHINE)
            // =================================================================

            if (session) {
                // ШАГ 1: Валидация площади
                if (session.step === "WAIT_AREA") {
                    // Удаляем всё, кроме цифр
                    const area = parseInt(text.replace(/\D/g, ''));
                    
                    // Валидация (защита от дурака)
                    if (!area || area < 10 || area > 2000) {
                        return bot.sendMessage(chatId, "⚠️ <b>Некорректная площадь!</b>\nПожалуйста, введите число от 10 до 2000.", { parse_mode: "HTML" });
                    }

                    // Сохраняем и идем дальше
                    session.data.area = area;
                    session.step = "WAIT_ROOMS";
                    
                    return bot.sendMessage(chatId, "2️⃣ Отлично! Теперь напишите количество <b>комнат</b> (например: 2):", { parse_mode: "HTML" });
                }

                // ШАГ 2: Валидация комнат
                if (session.step === "WAIT_ROOMS") {
                    const rooms = parseInt(text.replace(/\D/g, ''));

                    if (!rooms || rooms < 1 || rooms > 30) {
                        return bot.sendMessage(chatId, "⚠️ Пожалуйста, введите реальное количество комнат (цифрой).");
                    }

                    session.data.rooms = rooms;
                    session.step = "WAIT_WALLS"; // Финальный шаг
                    
                    // Переходим к Inline-кнопкам (обработка будет в callbacks.js)
                    return bot.sendMessage(chatId, "3️⃣ Из какого материала сделаны <b>стены</b>?\n<i>Это важно для расчета штробления.</i>", {
                        parse_mode: "HTML",
                        reply_markup: KEYBOARDS.walls // Показываем кнопки выбора стен
                    });
                }
            }

            // Если сообщение не распознано
            // bot.sendMessage(chatId, "🤷‍♂️ Я вас не понял. Используйте меню.");

        } catch (error) {
            console.error(`❌ [MESSAGE ERROR] User ${userId}:`, error);
            bot.sendMessage(chatId, "⚠️ Произошла ошибка. Попробуйте нажать /start");
        }
    });
};
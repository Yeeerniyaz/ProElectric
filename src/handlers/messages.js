/**
 * @file src/handlers/messages.js
 * @description Обработчик текстовых сообщений (Router & Wizard).
 * Реализует сценарии: Калькулятор, Закрытие сделки, Внесение расходов.
 * @version 7.3.0 (Expenses & New Menu)
 */

import { bot } from "../core.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { OrderService } from "../services/OrderService.js";

// Хранилище сессий (RAM). Экспортируется для доступа из callbacks.
export const sessions = new Map();

// =============================================================================
// 🎛 UI КОМПОНЕНТЫ (КЛАВИАТУРЫ)
// =============================================================================

const getMainMenu = (role) => {
  const buttons = [
    [{ text: "🧮 Рассчитать стоимость" }, { text: "📂 Мои заказы" }],
    [{ text: "💰 Прайс-лист" }, { text: "📞 Контакты" }],
  ];
  // Панель сотрудника
  if (["admin", "manager"].includes(role)) {
    buttons.unshift([{ text: "👷‍♂️ Мои объекты (Активные)" }]);
  }
  return { keyboard: buttons, resize_keyboard: true };
};

const KB = {
  CONTACT: {
    keyboard: [
      [{ text: "📱 Отправить номер", request_contact: true }],
      [{ text: "🔙 Назад" }],
    ],
    resize_keyboard: true,
  },
  CANCEL: {
    keyboard: [[{ text: "❌ Отмена" }]],
    resize_keyboard: true,
  },
};

const formatKZT = (num) =>
  new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(num);

// =============================================================================
// 🧠 ЛОГИКА ОБРАБОТКИ (HANDLERS)
// =============================================================================

export const setupMessageHandlers = () => {
  
  // 1. КОМАНДА /START
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const userId = msg.from ? msg.from.id : chatId;
      const userName = msg.from ? msg.from.first_name : "Гость";
      const userLogin = msg.from ? msg.from.username : null;

      // Регистрация / Обновление данных
      const user = await db.upsertUser(userId, userName, userLogin);

      await bot.sendMessage(
        chatId,
        `Салам, <b>${userName}</b>! 👋\n` +
        `Я цифровой помощник <b>ProElectro</b>.\n` +
        `Готов помочь с расчетом электрики или управлением заказами.\n\n` +
        `<i>Ваш статус: ${user.role}</i>`,
        { 
            parse_mode: "HTML", 
            reply_markup: getMainMenu(user.role) 
        }
      );
      
      sessions.delete(chatId);

    } catch (e) {
      console.error("Start Error:", e);
    }
  });

  // 2. ОБРАБОТКА КОНТАКТА
  bot.on("contact", async (msg) => {
    if (!msg.from || msg.contact.user_id !== msg.from.id) return;
    const user = await db.upsertUser(
      msg.from.id,
      msg.from.first_name,
      msg.from.username,
      msg.contact.phone_number
    );
    await bot.sendMessage(msg.chat.id, "✅ Номер успешно сохранен!", {
      reply_markup: getMainMenu(user.role),
    });
  });

  // 3. ТЕКСТОВЫЕ СООБЩЕНИЯ (WIZARD & COMMANDS)
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from ? msg.from.id : chatId;

    // --- ОТМЕНА ОПЕРАЦИИ ---
    if (text === "❌ Отмена" || text === "🔙 Назад") {
      sessions.delete(chatId);
      const user = await db.upsertUser(userId, msg.from.first_name);
      return bot.sendMessage(chatId, "Операция отменена.", {
        reply_markup: getMainMenu(user.role),
      });
    }

    // --- INIT: КАЛЬКУЛЯТОР ---
    if (text === "🧮 Рассчитать стоимость") {
      sessions.set(chatId, { step: "AREA", data: {} });
      // Таймер "Брошенная корзина"
      setTimeout(() => checkAbandonedSession(chatId), 15 * 60 * 1000);

      return bot.sendMessage(chatId, "1️⃣ Введите <b>площадь помещения (м²)</b>:", {
        parse_mode: "HTML",
        reply_markup: KB.CANCEL,
      });
    }

    // --- WIZARD PROCESSOR ---
    const session = sessions.get(chatId);
    if (session) {
        
        // ШАГ 1: ПЛОЩАДЬ -> КОМНАТЫ
        if (session.step === "AREA") {
            const area = parseInt(text);
            if (isNaN(area) || area < 5 || area > 5000) {
                return bot.sendMessage(chatId, "⚠️ Введите корректное число (от 5 до 5000).");
            }
            session.data.area = area;
            session.step = "ROOMS";
            
            return bot.sendMessage(chatId, "2️⃣ Введите <b>количество комнат</b> (числом):", {
                parse_mode: "HTML"
            });
        }

        // ШАГ 2: КОМНАТЫ -> СТЕНЫ (КНОПКИ)
        if (session.step === "ROOMS") {
            const rooms = parseInt(text);
            if (isNaN(rooms) || rooms < 1 || rooms > 50) {
                return bot.sendMessage(chatId, "⚠️ Введите корректное число комнат (1-50).");
            }
            session.data.rooms = rooms;
            session.step = "WALLS"; // Ожидаем нажатие Inline-кнопки (в callbacks.js)

            return bot.sendMessage(
                chatId,
                `✅ Принято: ${session.data.area} м², ${rooms} комн.\n\n` +
                `3️⃣ <b>Выберите материал стен:</b>\n` +
                `<i>Это влияет на сложность и стоимость штробления.</i>`,
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🧱 Газоблок / ГКЛ", callback_data: "wall_light" }],
                            [{ text: "🧱 Кирпич", callback_data: "wall_brick" }],
                            [{ text: "🏗 Бетон / Монолит", callback_data: "wall_concrete" }],
                        ],
                    },
                }
            );
        }

        // ШАГ: ЗАКРЫТИЕ ЗАКАЗА -> ВЫБОР КОШЕЛЬКА
        if (session.step === "FINISH_SUM") {
            const sum = parseInt(text.replace(/[^0-9]/g, ''));
            if (isNaN(sum) || sum <= 0) {
                return bot.sendMessage(chatId, "⚠️ Введите корректную сумму цифрами.");
            }
            
            session.data.finalSum = sum;
            
            const accounts = await db.getAccounts();
            const btns = accounts.map(a => [{ 
                text: `${a.type === 'bank' ? '💳' : '💵'} ${a.name}`, 
                callback_data: `wallet_${a.id}` 
            }]);

            return bot.sendMessage(
                chatId,
                `💰 Сумма к закрытию: <b>${formatKZT(sum)}</b>\n\n` +
                `Выберите кассу, куда поступили деньги:`,
                {
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: btns }
                }
            );
        }

        // ШАГ: РАСХОД -> СУММА
        if (session.step === "EXPENSE_AMOUNT") {
            const amount = parseInt(text.replace(/[^0-9]/g, ''));
            if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "⚠️ Введите корректную сумму.");
            
            session.data.amount = amount;
            session.step = "EXPENSE_CATEGORY";
            
            return bot.sendMessage(chatId, `💰 Сумма: ${formatKZT(amount)}\nТеперь выберите категорию:`, {
                reply_markup: {
                    keyboard: [
                        [{ text: "🚕 Такси" }, { text: "🔌 Материал (Докупка)" }],
                        [{ text: "🍔 Обед" }, { text: "🛠 Инструмент" }],
                        [{ text: "❌ Отмена" }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
        }

        // ШАГ: РАСХОД -> КАТЕГОРИЯ И СОХРАНЕНИЕ
        if (session.step === "EXPENSE_CATEGORY") {
            const category = text.replace(/[^a-zA-Zа-яА-Я0-9 ]/g, ""); // Убираем спецсимволы
            
            try {
              await db.addObjectExpense(
                  session.data.orderId, 
                  session.data.amount, 
                  category, 
                  "Через бот"
              );
              
              // Получаем роль для правильного меню
              const user = await db.upsertUser(userId, msg.from.first_name);

              await bot.sendMessage(chatId, `✅ <b>Расход записан!</b>\n-${formatKZT(session.data.amount)} (${text})`, {
                  parse_mode: "HTML",
                  reply_markup: getMainMenu(user.role)
              });
              
            } catch (e) {
                bot.sendMessage(chatId, "❌ Ошибка записи в БД.");
                console.error(e);
            }
            
            sessions.delete(chatId);
            return;
        }
    }

    // --- МЕНЕДЖЕР: АКТИВНЫЕ ОБЪЕКТЫ ---
    if (text === "👷‍♂️ Мои объекты (Активные)") {
        const orders = await OrderService.getManagerActiveOrders(userId);
        
        if (orders.length === 0) {
            return bot.sendMessage(chatId, "📭 У вас нет активных объектов в работе.");
        }

        for (const o of orders) {
           const expensesTxt = o.expenses_sum > 0 ? `\n💸 <b>Расходы:</b> -${formatKZT(o.expenses_sum)}` : "";
           
           const msgText = 
            `🔌 <b>Заказ #${o.id}</b> | ${getStatusEmoji(o.status)}\n` +
            `👤 Клиент: ${o.client_name || "Гость"}\n` +
            `📞 Тел: ${o.client_phone || "нет"}\n` +
            `🏠 Объект: ${o.area} м² | ${o.wall_type || "-"}\n` +
            `💰 Смета: ${formatKZT(o.total_price)}` + 
            expensesTxt + `\n`;

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

    // --- КЛИЕНТ: МОИ ЗАКАЗЫ ---
    if (text === "📂 Мои заказы") {
        const orders = await OrderService.getUserOrders(userId);
        if (!orders.length) return bot.sendMessage(chatId, "📭 История заказов пуста.");

        let msgText = "<b>📂 ВАШИ ЗАКАЗЫ:</b>\n\n";
        orders.forEach(o => {
            msgText += `🔹 <b>#${o.id}</b> — ${formatKZT(o.total_price)}\nСтатус: ${getStatusEmoji(o.status)}\n\n`;
        });
        return bot.sendMessage(chatId, msgText, { parse_mode: "HTML" });
    }

    // --- ИНФО ---
    if (text === "💰 Прайс-лист") {
        const p = await OrderService.getPublicPriceList();
        return bot.sendMessage(chatId, 
            `📋 <b>БАЗОВЫЙ ПРАЙС 2026:</b>\n\n` +
            `🧱 Газоблок (точка): ${p.wall_light} ₸\n` +
            `🧱 Кирпич (точка): ${p.wall_medium} ₸\n` +
            `🏗 Бетон (точка): ${p.wall_heavy} ₸\n\n` +
            `<i>*Точная стоимость работ определяется мастером после замера.</i>`,
            { parse_mode: "HTML" }
        );
    }

    if (text === "📞 Контакты") {
        return bot.sendMessage(chatId, 
            `📞 <b>Наши контакты:</b>\n\n` +
            `👤 Ернияз: +7 (706) 606-63-23\n` +
            `📍 Алматы, ProElectro HQ`,
            { parse_mode: "HTML", reply_markup: KB.CONTACT }
        );
    }

  });
};

// =============================================================================
// 🔧 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =============================================================================

function getStatusEmoji(status) {
    const map = {
        'new': '🆕 Новый',
        'discuss': '🗣 Обсуждение',
        'work': '🛠 В работе',
        'done': '✅ Сдан',
        'cancel': '❌ Отмена'
    };
    return map[status] || status;
}

function checkAbandonedSession(chatId) {
    const session = sessions.get(chatId);
    if (session && ['AREA', 'ROOMS'].includes(session.step)) {
        bot.sendMessage(chatId, 
            "🤔 <b>Вы не закончили расчет.</b>\n" +
            "Если возникли вопросы, вы всегда можете связаться с нами через раздел Контакты.",
            { parse_mode: "HTML" }
        ).catch(() => {});
    }
}
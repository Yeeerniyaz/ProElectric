/**
 * @file src/handlers/messages.js
 * @description Обработчик сообщений (Router & Wizard Controller).
 * Использует паттерн State Machine для управления диалогами.
 * @version 8.0.0 (Senior Refactor)
 */

import { bot } from "../core.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { OrderService } from "../services/OrderService.js";

// =============================================================================
// 🧠 STATE MANAGER (SESSION STORAGE)
// =============================================================================
export const sessions = new Map();

// Время жизни сессии (15 мин)
const SESSION_TTL = 15 * 60 * 1000;

// =============================================================================
// 🎨 UI COMPONENTS (KEYBOARDS & TEXTS)
// =============================================================================

const UI = {
  mainMenu: (role) => {
    const buttons = [
      [{ text: "🧮 Рассчитать стоимость" }, { text: "📂 Мои заказы" }],
      [{ text: "💰 Прайс-лист" }, { text: "📞 Контакты" }],
    ];
    if (["admin", "manager"].includes(role)) {
      buttons.unshift([{ text: "👷‍♂️ Мои объекты (Активные)" }]);
    }
    return { keyboard: buttons, resize_keyboard: true };
  },

  contact: {
    keyboard: [
      [{ text: "📱 Отправить номер", request_contact: true }],
      [{ text: "🔙 Назад" }],
    ],
    resize_keyboard: true,
  },

  cancel: {
    keyboard: [[{ text: "❌ Отмена" }]],
    resize_keyboard: true,
  },

  expenseCategory: {
    keyboard: [
      [{ text: "🚕 Такси" }, { text: "🔌 Материал (Докупка)" }],
      [{ text: "🍔 Обед" }, { text: "🛠 Инструмент" }],
      [{ text: "❌ Отмена" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

const formatKZT = (num) =>
  new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(num);

// =============================================================================
// 🛠 WIZARD STEPS (SCENARIOS)
// =============================================================================

const STEPS = {
  // --- SCENARIO: CALCULATOR ---
  AREA: async (chatId, text, session) => {
    const area = parseInt(text);
    if (isNaN(area) || area < 5 || area > 5000) {
      return bot.sendMessage(chatId, "⚠️ Введите корректную площадь (5 - 5000 м²).");
    }
    session.data.area = area;
    session.step = "ROOMS";
    await bot.sendMessage(chatId, "2️⃣ Введите <b>количество комнат</b>:", { parse_mode: "HTML" });
  },

  ROOMS: async (chatId, text, session) => {
    const rooms = parseInt(text);
    if (isNaN(rooms) || rooms < 1 || rooms > 50) {
      return bot.sendMessage(chatId, "⚠️ Введите корректное число комнат (1-50).");
    }
    session.data.rooms = rooms;
    session.step = "WALLS"; // Ожидаем callback
    
    await bot.sendMessage(
      chatId,
      `✅ Принято: ${session.data.area} м², ${rooms} комн.\n\n` +
      `3️⃣ <b>Выберите материал стен:</b>\n` +
      `<i>Это влияет на стоимость штробления.</i>`,
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
  },

  // --- SCENARIO: CLOSE ORDER ---
  FINISH_SUM: async (chatId, text, session) => {
    const sum = parseInt(text.replace(/[^0-9]/g, ""));
    if (isNaN(sum) || sum <= 0) {
      return bot.sendMessage(chatId, "⚠️ Введите сумму цифрами (например: 150000).");
    }
    session.data.finalSum = sum;

    const accounts = await db.getAccounts();
    const btns = accounts.map((a) => [{
      text: `${a.type === "bank" ? "💳" : "💵"} ${a.name}`,
      callback_data: `wallet_${a.id}`,
    }]);

    await bot.sendMessage(
      chatId,
      `💰 Сумма закрытия: <b>${formatKZT(sum)}</b>\n\nВыберите кассу поступления:`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: btns },
      }
    );
  },

  // --- SCENARIO: ADD EXPENSE ---
  EXPENSE_AMOUNT: async (chatId, text, session) => {
    const amount = parseInt(text.replace(/[^0-9]/g, ""));
    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, "⚠️ Введите сумму расхода цифрами.");
    }
    session.data.amount = amount;
    session.step = "EXPENSE_CATEGORY";

    await bot.sendMessage(
      chatId,
      `💸 Расход: <b>${formatKZT(amount)}</b>\nВыберите категорию:`,
      {
        parse_mode: "HTML",
        reply_markup: UI.expenseCategory,
      }
    );
  },

  EXPENSE_CATEGORY: async (chatId, text, session, user) => {
    const category = text.replace(/[^a-zA-Zа-яА-Я0-9 ]/g, ""); // Санитизация
    
    try {
      await db.addObjectExpense(
        session.data.orderId,
        session.data.amount,
        category,
        "Через Telegram Бот"
      );

      await bot.sendMessage(
        chatId,
        `✅ <b>Расход записан!</b>\n` +
        `📉 Сумма: -${formatKZT(session.data.amount)}\n` +
        `📂 Категория: ${category}`,
        {
          parse_mode: "HTML",
          reply_markup: UI.mainMenu(user.role),
        }
      );
    } catch (e) {
      console.error("Expense Save Error:", e);
      await bot.sendMessage(chatId, "❌ Ошибка при сохранении. Попробуйте позже.");
    }
    sessions.delete(chatId);
  },
};

// =============================================================================
// 🚀 MAIN LOGIC (ROUTER)
// =============================================================================

export const setupMessageHandlers = () => {
  
  // --- 1. START COMMAND ---
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const user = await db.upsertUser(
        msg.from.id,
        msg.from.first_name || "Гость",
        msg.from.username
      );

      await bot.sendMessage(
        chatId,
        `Салам, <b>${user.first_name}</b>! 👋\n` +
        `Я цифровой помощник <b>ProElectro</b>.\n` +
        `Чем могу быть полезен?`,
        {
          parse_mode: "HTML",
          reply_markup: UI.mainMenu(user.role),
        }
      );
      sessions.delete(chatId);
    } catch (e) {
      console.error("Start Cmd Error:", e);
    }
  });

  // --- 2. CONTACT SHARING ---
  bot.on("contact", async (msg) => {
    if (!msg.from || msg.contact.user_id !== msg.from.id) return;
    const user = await db.upsertUser(
      msg.from.id,
      msg.from.first_name,
      msg.from.username,
      msg.contact.phone_number
    );
    await bot.sendMessage(msg.chat.id, "✅ Номер успешно сохранен!", {
      reply_markup: UI.mainMenu(user.role),
    });
  });

  // --- 3. MESSAGE ROUTER ---
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const userId = msg.from.id;

    // A. GLOBAL COMMANDS
    if (text === "❌ Отмена" || text === "🔙 Назад") {
      sessions.delete(chatId);
      const user = await db.upsertUser(userId, msg.from.first_name);
      return bot.sendMessage(chatId, "Операция отменена.", {
        reply_markup: UI.mainMenu(user.role),
      });
    }

    // B. MENU NAVIGATION
    if (text === "🧮 Рассчитать стоимость") {
      sessions.set(chatId, { step: "AREA", data: {} });
      startSessionTimer(chatId); // Auto-cleanup
      return bot.sendMessage(chatId, "1️⃣ Введите <b>площадь помещения (м²)</b>:", {
        parse_mode: "HTML",
        reply_markup: UI.cancel,
      });
    }

    if (text === "💰 Прайс-лист") {
      const p = await OrderService.getPublicPriceList();
      return bot.sendMessage(chatId, 
        `📋 <b>БАЗОВЫЙ ПРАЙС 2026:</b>\n\n` +
        `🧱 Газоблок: ${p.wall_light} ₸\n` +
        `🧱 Кирпич: ${p.wall_medium} ₸\n` +
        `🏗 Бетон: ${p.wall_heavy} ₸\n\n` +
        `<i>*Ориентировочно. Точно — после замера.</i>`, 
        { parse_mode: "HTML" }
      );
    }

    if (text === "📂 Мои заказы") {
      const orders = await OrderService.getUserOrders(userId);
      if (!orders.length) return bot.sendMessage(chatId, "📭 История пуста.");
      
      const list = orders.map(o => `🔹 <b>#${o.id}</b> | ${formatKZT(o.total_price)} | ${getStatusEmoji(o.status)}`).join("\n\n");
      return bot.sendMessage(chatId, `<b>📂 ВАШИ ЗАКАЗЫ:</b>\n\n${list}`, { parse_mode: "HTML" });
    }

    if (text === "📞 Контакты") {
      return bot.sendMessage(chatId, `📞 <b>Контакты:</b>\n👤 Ернияз: +7 (706) 606-63-23`, { 
          parse_mode: "HTML", 
          reply_markup: UI.contact 
      });
    }

    // C. MANAGER COMMANDS
    if (text === "👷‍♂️ Мои объекты (Активные)") {
      const user = await db.upsertUser(userId, msg.from.first_name);
      if (!["admin", "manager"].includes(user.role)) return;

      const orders = await OrderService.getManagerActiveOrders(userId);
      if (orders.length === 0) return bot.sendMessage(chatId, "📭 Нет активных объектов.");

      for (const o of orders) {
        const expTxt = o.expenses_sum > 0 ? `\n💸 Расходы: -${formatKZT(o.expenses_sum)}` : "";
        const msgTxt = 
          `🔌 <b>Заказ #${o.id}</b> | ${getStatusEmoji(o.status)}\n` +
          `👤 ${o.client_name || "Гость"} (${o.client_phone || "-"})\n` +
          `🏠 ${o.area} м² | ${o.wall_type || "?"}\n` +
          `💰 Смета: ${formatKZT(o.total_price)}` + expTxt;

        await bot.sendMessage(chatId, msgTxt, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "💸 Расход", callback_data: `add_expense_${o.id}` },
                { text: "✅ Закрыть", callback_data: `close_order_start_${o.id}` },
              ],
            ],
          },
        });
      }
      return;
    }

    // D. WIZARD STEP PROCESSOR (STATE MACHINE)
    const session = sessions.get(chatId);
    if (session && STEPS[session.step]) {
      try {
        const user = await db.upsertUser(userId, msg.from.first_name);
        await STEPS[session.step](chatId, text, session, user);
      } catch (err) {
        console.error(`Wizard Error [${session.step}]:`, err);
        bot.sendMessage(chatId, "⚠️ Произошла ошибка. Попробуйте заново.");
        sessions.delete(chatId);
      }
    }
  });
};

// =============================================================================
// 🔧 UTILS & HELPERS
// =============================================================================

function startSessionTimer(chatId) {
  setTimeout(() => {
    const s = sessions.get(chatId);
    if (s) {
      bot.sendMessage(chatId, "🤔 Вы не закончили действие. Нужна помощь?", {
        reply_markup: UI.contact
      }).catch(() => {});
      // Не удаляем сессию сразу, даем шанс, но напоминаем
    }
  }, SESSION_TTL);
}

function getStatusEmoji(status) {
  const map = { new: "🆕", discuss: "🗣", work: "🛠", done: "✅", cancel: "❌" };
  return map[status] || status;
}

/**
 * 🔔 NOTIFY ADMINS (EXPORTED)
 * Используется в callbacks.js для уведомления о новых заказах
 */
export const notifyAdmin = async (text, orderId = null) => {
  try {
    const res = await db.query("SELECT telegram_id FROM users WHERE role IN ('admin', 'manager')");
    if (res.rows.length === 0) return;

    const opts = {
      parse_mode: "HTML",
      reply_markup: orderId
        ? { inline_keyboard: [[{ text: "🙋‍♂️ Взять в работу", callback_data: `take_order_${orderId}` }]] }
        : undefined,
    };

    for (const admin of res.rows) {
      await bot.sendMessage(admin.telegram_id, text, opts).catch(() => {});
    }
  } catch (e) {
    console.error("NotifyAdmin Error:", e.message);
  }
};
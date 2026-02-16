/**
 * @file src/handlers/messages.js
 * @description Роутер текстовых сообщений и Wizard-контроллер.
 * Реализует главное меню, калькулятор и навигацию по ролям.
 * @version 8.1.0 (Senior Refactor: Multi-Role Menu & Wallets)
 */

import { bot } from "../core.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { OrderService } from "../services/OrderService.js";
import { KEYBOARDS, TEXTS } from "../constants.js"; // Предлагаю использовать глобальные константы, но здесь оставлю локальные UI для надежности

// =============================================================================
// 🧠 STATE MANAGER (SESSION STORAGE)
// =============================================================================
export const sessions = new Map();

// Время жизни сессии (30 мин)
const SESSION_TTL = 30 * 60 * 1000;

// =============================================================================
// 🎨 UI COMPONENTS (DYNAMIC KEYBOARDS)
// =============================================================================

const UI = {
  // Динамическое меню в зависимости от роли
  mainMenu: (role) => {
    // Базовые кнопки для Клиента
    const buttons = [
      [{ text: "🧮 Рассчитать стоимость" }, { text: "📂 Мои заказы" }],
      [{ text: "💰 Прайс-лист" }, { text: "📞 Контакты" }],
    ];

    // Кнопки для Менеджера
    if (["admin", "manager"].includes(role)) {
      buttons.unshift([
          { text: "👷‍♂️ Мои объекты" }, 
          { text: "💵 Моя Касса" } // <-- Новая функция из веб-админки
      ]);
    }

    // Кнопки для Админа (Владельца)
    if (role === "admin") {
      buttons.unshift([{ text: "👑 Админ-панель" }]);
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
      [{ text: "🚕 Такси" }, { text: "🔌 Материал" }],
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
  // --- SCENARIO 1: CALCULATOR ---
  AREA: async (chatId, text, session) => {
    const area = parseInt(text.replace(/\D/g, '')); // Удаляем все не-цифры
    if (isNaN(area) || area < 5 || area > 5000) {
      return bot.sendMessage(chatId, "⚠️ Пожалуйста, введите корректную площадь цифрами (от 5 до 5000).");
    }
    session.data.area = area;
    session.step = "ROOMS";
    await bot.sendMessage(chatId, "2️⃣ Введите <b>количество комнат</b>:", { parse_mode: "HTML" });
  },

  ROOMS: async (chatId, text, session) => {
    const rooms = parseInt(text.replace(/\D/g, ''));
    if (isNaN(rooms) || rooms < 1 || rooms > 50) {
      return bot.sendMessage(chatId, "⚠️ Введите корректное число комнат (1-50).");
    }
    session.data.rooms = rooms;
    session.step = "WALLS"; // Передаем управление в callbacks.js
    
    await bot.sendMessage(
      chatId,
      `✅ Принято: ${session.data.area} м², ${rooms} комн.\n\n` +
      `3️⃣ <b>Выберите материал стен:</b>\n` +
      `<i>Это влияет на сложность штробления и итоговую цену.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🧱 Газоблок / ГКЛ (Легко)", callback_data: "wall_light" }],
            [{ text: "🧱 Кирпич (Средне)", callback_data: "wall_brick" }],
            [{ text: "🏗 Бетон / Монолит (Сложно)", callback_data: "wall_concrete" }],
          ],
        },
      }
    );
  },

  // --- SCENARIO 2: CLOSE ORDER (FINANCE) ---
  FINISH_SUM: async (chatId, text, session) => {
    const sum = parseInt(text.replace(/\D/g, "")); // Очистка от мусора
    if (isNaN(sum) || sum <= 0) {
      return bot.sendMessage(chatId, "⚠️ Введите итоговую сумму цифрами (например: 150000).");
    }
    session.data.finalSum = sum;

    // Показываем доступные кошельки
    // Админ видит всё, Менеджер только свою кассу
    const userId = session.data.userId || chatId; // Fallback
    const userRole = session.data.userRole || 'manager';

    const accounts = await db.getAccounts(userId, userRole);
    
    if (accounts.length === 0) {
        return bot.sendMessage(chatId, "❌ Ошибка: Не найдены доступные кассы. Обратитесь к админу.");
    }

    const btns = accounts.map((a) => [{
      text: `${a.type === "bank" ? "💳" : "💵"} ${a.name}`,
      callback_data: `wallet_${a.id}`,
    }]);

    await bot.sendMessage(
      chatId,
      `💰 Сумма к закрытию: <b>${formatKZT(sum)}</b>\n\n⬇️ Выберите, куда поступили деньги:`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: btns },
      }
    );
  },

  // --- SCENARIO 3: ADD EXPENSE ---
  EXPENSE_AMOUNT: async (chatId, text, session) => {
    const amount = parseInt(text.replace(/\D/g, ""));
    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, "⚠️ Введите сумму расхода цифрами.");
    }
    session.data.amount = amount;
    session.step = "EXPENSE_CATEGORY";

    await bot.sendMessage(
      chatId,
      `💸 Расход: <b>${formatKZT(amount)}</b>\nНа что потрачено?`,
      {
        parse_mode: "HTML",
        reply_markup: UI.expenseCategory,
      }
    );
  },

  EXPENSE_CATEGORY: async (chatId, text, session, user) => {
    // Санитизация текста (убираем эмодзи для БД, если нужно, или оставляем)
    const category = text.trim(); 
    
    try {
      await db.addObjectExpense(
        session.data.orderId,
        session.data.amount,
        category,
        "Bot Expense"
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
  
  // --- 1. START & AUTH ---
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      // Регистрируем/Обновляем пользователя
      const user = await db.upsertUser(
        msg.from.id,
        msg.from.first_name || "Гость",
        msg.from.username
      );

      // Приветственное сообщение
      await bot.sendMessage(
        chatId,
        `Салам, <b>${user.first_name}</b>! 👋\n` +
        `Я цифровой помощник <b>ProElectro</b>.\n\n` +
        `🤖 <b>Мои возможности:</b>\n` +
        `• Расчет стоимости работ за 30 сек\n` +
        `• Управление заказами и финансами\n` +
        `• Прайс-лист и контакты\n\n` +
        `<i>Ваш статус: ${user.role.toUpperCase()}</i>`,
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
    await bot.sendMessage(msg.chat.id, "✅ Номер успешно сохранен! Теперь мы сможем с вами связаться.", {
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
      return bot.sendMessage(chatId, "Главное меню:", {
        reply_markup: UI.mainMenu(user.role),
      });
    }

    // B. CLIENT FEATURES
    if (text === "🧮 Рассчитать стоимость") {
      sessions.set(chatId, { step: "AREA", data: {} });
      startSessionTimer(chatId);
      return bot.sendMessage(chatId, "1️⃣ Введите <b>площадь помещения (м²)</b>:", {
        parse_mode: "HTML",
        reply_markup: UI.cancel,
      });
    }

    if (text === "💰 Прайс-лист") {
      const p = await OrderService.getPublicPriceList();
      return bot.sendMessage(chatId, 
        `📋 <b>БАЗОВЫЙ ПРАЙС 2026:</b>\n\n` +
        `🧱 Газоблок: ${formatKZT(p.wall_light)}\n` +
        `🧱 Кирпич: ${formatKZT(p.wall_medium)}\n` +
        `🏗 Бетон: ${formatKZT(p.wall_heavy)}\n\n` +
        `<i>* Цены указаны за точку. Точная смета после замера.</i>`, 
        { parse_mode: "HTML" }
      );
    }

    if (text === "📂 Мои заказы") {
      const orders = await OrderService.getUserOrders(userId);
      if (!orders.length) return bot.sendMessage(chatId, "📭 История заказов пуста.");
      
      const list = orders.map(o => `🔹 <b>#${o.id}</b> | ${formatKZT(o.total_price)} | ${getStatusEmoji(o.status)}`).join("\n\n");
      return bot.sendMessage(chatId, `<b>📂 ВАШИ ЗАКАЗЫ:</b>\n\n${list}`, { parse_mode: "HTML" });
    }

    if (text === "📞 Контакты") {
      return bot.sendMessage(chatId, 
        `📞 <b>Наши контакты:</b>\n\n` +
        `👤 Ернияз (Руководитель)\n` +
        `📱 Телефон: +7 (706) 606-63-23\n` +
        `📍 Алматы, Казахстан`, 
        { 
          parse_mode: "HTML", 
          reply_markup: UI.contact 
        }
      );
    }

    // C. MANAGER / ADMIN FEATURES
    
    // 💵 МОЯ КАССА (Замена веб-интерфейсу финансов)
    if (text === "💵 Моя Касса") {
        const user = await db.upsertUser(userId, msg.from.first_name);
        if (!["admin", "manager"].includes(user.role)) return;

        // Получаем кошельки, привязанные к этому юзеру
        const accounts = await db.getAccounts(userId, user.role);
        
        if (accounts.length === 0) {
            return bot.sendMessage(chatId, "🤷‍♂️ У вас нет привязанной кассы. Попросите админа создать её.");
        }

        let msgTxt = "<b>👛 МОИ ФИНАНСЫ:</b>\n\n";
        let total = 0;

        accounts.forEach(acc => {
            msgTxt += `▫️ <b>${acc.name}:</b> ${formatKZT(acc.balance)}\n`;
            total += parseFloat(acc.balance);
        });

        msgTxt += `\n<b>💰 ИТОГО НА РУКАХ: ${formatKZT(total)}</b>`;
        return bot.sendMessage(chatId, msgTxt, { parse_mode: "HTML" });
    }

    // 👷‍♂️ МОИ ОБЪЕКТЫ
    if (text === "👷‍♂️ Мои объекты" || text === "👷‍♂️ Мои объекты (Активные)") {
      const user = await db.upsertUser(userId, msg.from.first_name);
      if (!["admin", "manager"].includes(user.role)) return;

      const orders = await OrderService.getManagerActiveOrders(userId);
      if (orders.length === 0) return bot.sendMessage(chatId, "📭 Активных объектов нет.");

      for (const o of orders) {
        const expTxt = o.expenses_sum > 0 ? `\n💸 Расходы: -${formatKZT(o.expenses_sum)}` : "";
        const msgText = 
          `🔌 <b>Заказ #${o.id}</b> | ${getStatusEmoji(o.status)}\n` +
          `👤 ${o.client_name || "Гость"} (${o.client_phone || "-"})\n` +
          `🏠 ${o.area} м² | ${o.wall_type || "?"}\n` +
          `💰 Смета: ${formatKZT(o.total_price)}` + expTxt;

        await bot.sendMessage(chatId, msgText, {
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

    // D. WIZARD STEP PROCESSOR
    const session = sessions.get(chatId);
    if (session && STEPS[session.step]) {
      try {
        const user = await db.upsertUser(userId, msg.from.first_name);
        // Передаем роль и ID юзера в сессию для контекста
        session.data.userRole = user.role;
        session.data.userId = userId;
        
        await STEPS[session.step](chatId, text, session, user);
      } catch (err) {
        console.error(`Wizard Error [${session.step}]:`, err);
        bot.sendMessage(chatId, "⚠️ Произошла ошибка при обработке данных. Попробуйте снова или нажмите Отмена.");
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
      bot.sendMessage(chatId, "🤔 Вы не закончили расчет. Нужна помощь?", {
        reply_markup: UI.contact
      }).catch(() => {});
    }
  }, SESSION_TTL);
}

function getStatusEmoji(status) {
  const map = { new: "🆕", discuss: "🗣", work: "🛠", done: "✅", cancel: "❌" };
  return map[status] || status;
}

/**
 * 🔔 NOTIFY ADMINS (EXPORTED)
 * Рассылает уведомление всем пользователям с ролью admin/manager
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
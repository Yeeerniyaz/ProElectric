import { bot } from "../core.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { ORDER_STATUS, STATUS_CONFIG } from "../constants.js";
// 🔥 Импортируем логин
import { handleLoginFlow } from "./auth.js";

// Экспортируем сессии
export const sessions = new Map();

// ============================================================
// 🎛 КОНФИГУРАЦИЯ КЛАВИАТУР (UI LAYER)
// ============================================================
export const KB = {
  MAIN_MENU: {
    reply_markup: {
      keyboard: [
        ["⚡️ Рассчитать смету", "📂 Мои расчеты"],
        ["💬 Обратная связь", "ℹ️ О компании"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  },
  CONTACT: {
    reply_markup: {
      keyboard: [
        [{ text: "📱 Отправить свой контакт", request_contact: true }],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  },
  ADMIN_INLINE: {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🔐 Вход для сотрудников",
            url: `https://t.me/${config.bot.username}?start=login`,
          },
        ],
        [
          { text: "📊 Статистика", callback_data: "adm_stats" },
          { text: "🆕 Новые", callback_data: "adm_new" },
        ],
        [
          { text: "💬 Обсуждение", callback_data: "adm_discuss" },
          { text: "⚡️ В работе", callback_data: "adm_work" },
        ],
        [
          { text: "✅ Готово", callback_data: "adm_done" },
          { text: "📋 Весь список", callback_data: "adm_list" },
        ],
      ],
    },
    parse_mode: "HTML",
  },
};

/**
 * 📢 Уведомление в админ-группу
 */
export const notifyAdmin = async (text, orderId = null) => {
  if (!config.bot.groupId) return;
  const options = { parse_mode: "HTML" };

  if (orderId) {
    options.reply_markup = {
      inline_keyboard: [
        [{ text: "🙋‍♂️ Взять в работу", callback_data: `take_order_${orderId}` }],
        [
          {
            text: "🗣 Обсуждение",
            callback_data: `status_${ORDER_STATUS.DISCUSS}_${orderId}`,
          },
          {
            text: "🏗 В работе",
            callback_data: `status_${ORDER_STATUS.WORK}_${orderId}`,
          },
        ],
        [
          {
            text: "✅ Решено",
            callback_data: `status_${ORDER_STATUS.DONE}_${orderId}`,
          },
          {
            text: "❌ Отказ",
            callback_data: `status_${ORDER_STATUS.CANCEL}_${orderId}`,
          },
        ],
      ],
    };
  }
  try {
    await bot.sendMessage(config.bot.groupId, text, options);
  } catch (e) {
    console.error("Notify Error:", e.message);
  }
};

// ============================================================
// 🛠 ЛОГИКА АДМИН-КОМАНД (Controller Layer)
// ============================================================
export const handleAdminCommand = async (msg, match) => {
  const cmd = match[1];
  const chatId = msg.chat.id.toString();
  const myAdminId = "2041384570";
  const groupAdminId = config.bot.groupId ? config.bot.groupId.toString() : "";

  if (
    msg.from &&
    msg.from.id.toString() !== myAdminId &&
    chatId !== groupAdminId
  )
    return;

  // 🔥 UX: Показываем, что бот думает
  bot.sendChatAction(chatId, "typing");

  try {
    if (cmd === "stats") {
      const res = await db.query(
        `SELECT o.status, COUNT(*), SUM(l.total_work_cost) as total FROM orders o JOIN leads l ON o.lead_id = l.id GROUP BY o.status`,
      );
      let statsMsg = "📊 <b>ВОРОНКА ПРОДАЖ (ORDERS):</b>\n\n";
      let grandTotal = 0;
      res.rows.forEach((r) => {
        const cfg = STATUS_CONFIG[r.status] || { label: r.status, icon: "❓" };
        const sum = Math.round(r.total || 0);
        statsMsg += `${cfg.icon} ${cfg.label}: <b>${r.count} шт.</b> (~${sum.toLocaleString()} ₸)\n`;
        if (r.status !== ORDER_STATUS.CANCEL) grandTotal += sum;
      });
      statsMsg += `\n💰 <b>ПОТЕНЦИАЛ: ~${grandTotal.toLocaleString()} ₸</b>`;
      return bot.sendMessage(chatId, statsMsg, { parse_mode: "HTML" });
    }

    const statusFilter = cmd === "list" ? "%" : cmd;
    const res = await db.query(
      `
            SELECT o.id, u.first_name, u.phone, l.area, l.total_work_cost, o.status, o.created_at, m.first_name as manager_name
            FROM orders o JOIN users u ON o.user_id = u.id JOIN leads l ON o.lead_id = l.id
            LEFT JOIN users m ON o.assignee_id = m.id
            WHERE o.status LIKE $1 ORDER BY o.created_at DESC LIMIT 15
        `,
      [statusFilter],
    );

    if (res.rows.length === 0)
      return bot.sendMessage(
        chatId,
        `📭 В категории [${cmd.toUpperCase()}] пусто.`,
      );

    let response = `📋 <b>СПИСОК ЗАКАЗОВ [${cmd.toUpperCase()}]:</b>\n\n`;
    res.rows.forEach((row, i) => {
      const date = new Date(row.created_at).toLocaleDateString("ru-RU");
      const cfg = STATUS_CONFIG[row.status];
      const managerStr = row.manager_name
        ? `\n   👷‍♂️ <b>Отв: ${row.manager_name}</b>`
        : "";
      response += `${i + 1}. <b>Заказ #${row.id}</b> | ${cfg?.icon || ""}\n   👤 ${row.first_name} | 📱 <code>${row.phone}</code>\n   📐 ${row.area}м² | 💰 ~${Math.round(row.total_work_cost).toLocaleString()}₸${managerStr}\n   📅 ${date}\n\n`;
    });
    await bot.sendMessage(chatId, response, { parse_mode: "HTML" });
  } catch (e) {
    console.error("Admin Cmd Error:", e);
  }
};

// ============================================================
// 🚀 ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ (Router Layer)
// ============================================================
export const setupMessageHandlers = () => {
  // 1. ИНИЦИАЛИЗАЦИЯ МЕНЮ
  bot
    .setMyCommands([
      { command: "/start", description: "🚀 Перезапуск бота" },
      { command: "/menu", description: "📱 Главное меню" },
      { command: "/admin", description: "🔐 Панель управления" },
    ])
    .catch((e) => console.error("Menu Init Error:", e.message));

  // 2. КОМАНДА /menu
  bot.onText(/\/menu/, async (msg) => {
    sessions.delete(msg.chat.id);
    await bot.sendMessage(
      msg.chat.id,
      "📱 <b>Главное меню открыто</b>",
      KB.MAIN_MENU,
    );
  });

  // 3. АДМИНСКИЕ КОМАНДЫ
  bot.onText(/\/(stats|new|discuss|work|done|cancel|list)/, handleAdminCommand);

  // 4. ПУЛЬТ В КАНАЛЕ
  bot.on("channel_post", (msg) => {
    if (msg.text === "/admin")
      return bot.sendMessage(
        msg.chat.id,
        "🏗 <b>УПРАВЛЕНИЕ PROELECTRO</b>\nВыберите действие:",
        KB.ADMIN_INLINE,
      );
    const match = msg.text
      ? msg.text.match(/\/(stats|new|discuss|work|done|cancel|list)/)
      : null;
    if (match) handleAdminCommand(msg, match);
  });

  bot.onText(/\/admin/, (msg) =>
    bot.sendMessage(
      msg.chat.id,
      "🏗 <b>УПРАВЛЕНИЕ PROELECTRO</b>\nВыберите действие:",
      KB.ADMIN_INLINE,
    ),
  );

  // 5. START (Deep Linking)
  bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param = match[1];

    if (param === "login") return handleLoginFlow(msg);

    // 🔥 UX: Показываем активность
    bot.sendChatAction(chatId, "typing");
    const res = await db.query(
      "SELECT phone FROM users WHERE telegram_id = $1",
      [msg.from.id],
    );

    if (res.rows.length > 0 && res.rows[0].phone) {
      sessions.set(chatId, { step: "IDLE", data: {} });
      await bot.sendMessage(
        chatId,
        `Салам, ${msg.from.first_name}! Чем могу помочь?`,
        KB.MAIN_MENU,
      );
    } else {
      await bot.sendMessage(
        chatId,
        "👋 Привет! Я бот ProElectro.\nДля начала работы нажмите кнопку ниже:",
        KB.CONTACT,
      );
    }
  });

  // 6. CONTACT (Регистрация)
  bot.on("contact", async (msg) => {
    const chatId = msg.chat.id;
    if (msg.contact.user_id !== msg.from.id) return;

    bot.sendChatAction(chatId, "typing"); // 🔥 UX
    const user = await db.upsertUser(
      msg.from.id,
      msg.from.first_name,
      msg.from.username,
      msg.contact.phone_number,
    );
    sessions.set(chatId, { step: "IDLE", data: {} });

    if (user.status === "new") {
      await notifyAdmin(
        `🆕 <b>НОВЫЙ КЛИЕНТ</b>\n👤 ${msg.from.first_name}\n📱 <code>${msg.contact.phone_number}</code>`,
      );
      await db.query("UPDATE users SET status = 'active' WHERE id = $1", [
        user.id,
      ]);
      // Если нужно сразу логинить сотрудника, раскомментируй:
      // await handleLoginFlow(msg, true);
    }
    await bot.sendMessage(
      chatId,
      "✅ Регистрация успешна! Доступ к калькулятору открыт.",
      KB.MAIN_MENU,
    );
  });

  // 7. TEXT MESSAGES
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/") || msg.contact) return;
    const chatId = msg.chat.id;
    if (
      config.bot.groupId &&
      chatId.toString() === config.bot.groupId.toString()
    )
      return;

    let session = sessions.get(chatId) || { step: "IDLE", data: {} };

    if (msg.text === "⚡️ Рассчитать смету") {
      session.step = "WAITING_FOR_AREA";
      sessions.set(chatId, session);
      await bot.sendMessage(
        chatId,
        "📏 <b>Введите площадь помещения (м²):</b>\n\n<i>Или нажмите /menu для отмены</i>",
        { parse_mode: "HTML", reply_markup: { remove_keyboard: true } },
      );
      return;
    }

    if (msg.text === "📂 Мои расчеты") {
      bot.sendChatAction(chatId, "typing");
      const res = await db.query(
        "SELECT area, total_work_cost, created_at FROM leads WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1) ORDER BY created_at DESC LIMIT 3",
        [msg.from.id],
      );
      if (res.rows.length === 0)
        return bot.sendMessage(
          chatId,
          "📭 История расчетов пуста.",
          KB.MAIN_MENU,
        );
      let text = "📂 <b>Ваши последние расчеты:</b>\n\n";
      res.rows.forEach((r, i) => {
        text += `${i + 1}. ${r.area} м² — ${Math.round(r.total_work_cost).toLocaleString()} ₸\n`;
      });
      await bot.sendMessage(chatId, text, { parse_mode: "HTML" }, KB.MAIN_MENU);
      return;
    }

    if (session.step === "WAITING_FOR_AREA") {
      const area = parseFloat(msg.text.replace(",", "."));
      if (isNaN(area) || area <= 0 || area > 10000) {
        return bot.sendMessage(
          chatId,
          "⚠️ Пожалуйста, введите корректное число (например: 65).\nДля отмены нажмите /menu",
        );
      }
      session.data.area = area;
      session.step = "WAITING_FOR_WALLS";
      sessions.set(chatId, session);
      await bot.sendMessage(
        chatId,
        `🏢 Объект: <b>${area} м²</b>.\nИз чего сделаны стены?`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🟢 Легкие (ГКЛ/Газоблок)",
                  callback_data: "wall_light",
                },
              ],
              [{ text: "🟡 Средние (Кирпич)", callback_data: "wall_medium" }],
              [
                {
                  text: "🔴 Тяжелые (Бетон/Монолит)",
                  callback_data: "wall_heavy",
                },
              ],
            ],
          },
        },
      );
    }
  });
};

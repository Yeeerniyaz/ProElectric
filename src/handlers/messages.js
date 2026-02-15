/**
 * @file src/handlers/messages.js
 * @description Обработчик текстовых сообщений.
 * Исправлена работа в каналах и ошибка с reset().
 */

import { bot } from "../core.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { OrderService } from "../services/OrderService.js";

// Хранилище сессий (RAM)
export const sessions = new Map();

// Мәзір (Динамикалық)
const getMainMenu = (role) => {
  const buttons = [
    [{ text: "🧮 Рассчитать стоимость" }, { text: "📂 Мои заказы" }],
    [{ text: "💰 Прайс-лист" }, { text: "📞 Контакты" }],
  ];
  if (["admin", "manager"].includes(role)) {
    buttons.unshift([{ text: "👷‍♂️ Мои объекты (Активные)" }]);
  }
  return { keyboard: buttons, resize_keyboard: true };
};

export const KB = {
  CONTACT: {
    keyboard: [
      [{ text: "📱 Отправить номер", request_contact: true }],
      [{ text: "🔙 Назад" }],
    ],
    resize_keyboard: true,
  },
  ADMIN: {
    inline_keyboard: [[{ text: "📊 Воронка", callback_data: "adm_stats" }]],
  },
};

const formatKZT = (num) =>
  new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(num);
const getStatusLabel = (s) =>
  ({
    new: "🆕 Новый",
    work: "🛠 В работе",
    done: "✅ Выполнен",
    cancel: "❌ Отменен",
  })[s] || s;

export const setupMessageHandlers = () => {
  // 1. /start
  bot.onText(/\/start/, async (msg) => {
    try {
      // Каналда 'from' болмауы мүмкін, сондықтан тексереміз
      const userId = msg.from ? msg.from.id : msg.chat.id;
      const userName = msg.from
        ? msg.from.first_name
        : msg.chat.title || "Гость";
      const userLogin = msg.from ? msg.from.username : "channel";

      const user = await db.upsertUser(userId, userName, userLogin);

      await bot.sendMessage(
        msg.chat.id,
        `Салам, <b>${userName}</b>! 👋\nЯ бот <b>ProElectro</b>. Готов к работе!\nВаш статус: <b>${user.role}</b>`,
        { parse_mode: "HTML", reply_markup: getMainMenu(user.role) },
      );
    } catch (e) {
      console.error("Start Error:", e);
    }
  });

  // 2. Admin
  bot.onText(/\/admin/, async (msg) => {
    const userId = msg.from ? msg.from.id : msg.chat.id;
    // Канал болса немесе Админ болса рұқсат береміз
    const isAdmin =
      String(userId) === String(config.bot.bossUsername) ||
      String(msg.chat.id) === String(config.bot.workGroupId) ||
      msg.chat.type === "channel"; // Каналға рұқсат

    if (!isAdmin) return bot.sendMessage(msg.chat.id, "⛔️ Доступ запрещен.");

    await bot.sendMessage(msg.chat.id, "👨‍💻 <b>Админ-панель:</b>", {
      parse_mode: "HTML",
      reply_markup: KB.ADMIN,
    });
  });

  // 3. Contact
  bot.on("contact", async (msg) => {
    if (!msg.from || msg.contact.user_id !== msg.from.id) return;
    const user = await db.upsertUser(
      msg.from.id,
      msg.from.first_name,
      msg.from.username,
      msg.contact.phone_number,
    );
    await bot.sendMessage(msg.chat.id, "✅ Номер сохранен!", {
      reply_markup: getMainMenu(user.role),
    });
  });

  // 4. Messages
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from ? msg.from.id : chatId; // Канал үшін ID

    try {
      // --- МЕНЕДЖЕР ---
      if (text === "👷‍♂️ Мои объекты (Активные)") {
        const orders = await OrderService.getManagerActiveOrders(userId);
        if (orders.length === 0)
          return bot.sendMessage(chatId, "📭 Активті объектілер жоқ.");

        let response = "<b>👷‍♂️ ЖҰМЫСТАҒЫ ОБЪЕКТІЛЕР:</b>\n\n";
        orders.forEach((o) => {
          const date = new Date(o.created_at).toLocaleDateString();
          response += `🔌 <b>#${o.id}</b> | ${o.client_name}\n💰 ${formatKZT(o.total_work_cost)}\n➖➖➖➖➖\n`;
        });
        return bot.sendMessage(chatId, response, { parse_mode: "HTML" });
      }

      // --- КАЛЬКУЛЯТОР ---
      if (text === "🧮 Рассчитать стоимость") {
        // 🔥 ТҮЗЕТІЛДІ: Ескі сессияны өшіру (delete)
        sessions.delete(chatId);
        sessions.set(chatId, { step: "WALLS", data: {} });
        return bot.sendMessage(chatId, "Введите <b>площадь (м²)</b> цифрами:", {
          parse_mode: "HTML",
          reply_markup: { remove_keyboard: true },
        });
      }

      // Калькулятор логикасы
      const session = sessions.get(chatId);
      if (session && session.step === "WALLS") {
        const area = parseInt(text);
        if (isNaN(area) || area < 5 || area > 5000)
          return bot.sendMessage(chatId, "⚠️ Введите число от 5 до 5000.");

        session.data.area = area;
        session.step = "TYPE";

        return bot.sendMessage(
          chatId,
          `✅ ${area} м². <b>Выберите стены:</b>`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🧱 Газоблок / ГКЛ", callback_data: "wall_light" }],
                [{ text: "🧱 Кирпич", callback_data: "wall_medium" }],
                [{ text: "🏗 Бетон / Монолит", callback_data: "wall_heavy" }],
              ],
            },
          },
        );
      }

      // --- БАСҚАЛАРЫ ---
      if (text === "📂 Мои заказы") {
        const orders = await OrderService.getUserOrders(userId);
        if (!orders.length)
          return bot.sendMessage(chatId, "📭 Тапсырыстар жоқ.");

        let response = "<b>📂 ВАШИ ЗАКАЗЫ:</b>\n\n";
        orders.forEach((o) => {
          response += `🔹 <b>#${o.id}</b> (${new Date(o.created_at).toLocaleDateString()}) — ${formatKZT(o.total_work_cost)}\nСтатус: ${getStatusLabel(o.status)}\n➖➖➖➖➖\n`;
        });
        return bot.sendMessage(chatId, response, { parse_mode: "HTML" });
      }

      // Прайс
      if (text === "💰 Прайс-лист") {
        const p = await OrderService.getPublicPriceList();
        return bot.sendMessage(
          chatId,
          `📋 <b>ПРАЙС:</b>\n🧱 Газоблок: ${p.wall_light} ₸\n🧱 Кирпич: ${p.wall_medium} ₸\n🏗 Бетон: ${p.wall_heavy} ₸`,
          { parse_mode: "HTML" },
        );
      }

      if (text === "📞 Контакты") {
        return bot.sendMessage(
          chatId,
          `📞 <b>Связь:</b>\n👤 Ернияз: +7 (706) 606-63-23`,
          { parse_mode: "HTML", reply_markup: KB.CONTACT },
        );
      }
    } catch (e) {
      console.error("Msg Error:", e);
    }
  });
};

export const handleAdminCommand = async (msg, match) => {
  const chatId = msg.chat.id;
  if (match[1] === "stats") {
    const stats = await OrderService.getGlobalStats();
    let report = `📊 <b>ВОРОНКА:</b>\n`;
    stats.funnel.forEach(
      (row) => (report += `${getStatusLabel(row.status)}: ${row.count} шт.\n`),
    );
    await bot.sendMessage(chatId, report, { parse_mode: "HTML" });
  }
};

export const notifyAdmin = async (text, orderId = null) => {
  if (!config.bot.workGroupId) return;
  const opts = {
    parse_mode: "HTML",
    reply_markup: orderId
      ? {
          inline_keyboard: [
            [
              {
                text: "🙋‍♂️ Взять в работу",
                callback_data: `take_order_${orderId}`,
              },
            ],
          ],
        }
      : undefined,
  };
  await bot
    .sendMessage(config.bot.workGroupId, text, opts)
    .catch((e) => console.error("Notify Error:", e.message));
};

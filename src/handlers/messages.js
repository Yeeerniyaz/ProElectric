/**
 * @file src/handlers/messages.js
 * @description Обработчик текстовых сообщений и команд (/start, /admin).
 * Работает как Контроллер: принимает запрос -> вызывает Service -> отдает ответ.
 * @version 6.0.0 (Refactored)
 */

import { bot } from "../core.js";
import { db } from "../db.js"; // Базовые операции юзера
import { config } from "../config.js";
import { OrderService } from "../services/OrderService.js"; // Подключаем наш новый Сервис

// Хранилище сессий (RAM)
export const sessions = new Map();

// ====================================================
// 🔘 UI CONFIGURATION (КЛАВИАТУРЫ)
// ====================================================
export const KB = {
  MAIN: {
    keyboard: [
      [{ text: "🧮 Рассчитать стоимость" }, { text: "📂 Мои заказы" }],
      [{ text: "💰 Прайс-лист" }, { text: "📞 Контакты" }],
    ],
    resize_keyboard: true,
  },
  CONTACT: {
    keyboard: [
      [{ text: "📱 Отправить номер", request_contact: true }],
      [{ text: "🔙 Назад" }],
    ],
    resize_keyboard: true,
  },
  ADMIN: {
    inline_keyboard: [
      [{ text: "📊 Воронка (Stats)", callback_data: "adm_stats" }],
      [{ text: "📢 Рассылка", callback_data: "adm_spam" }],
    ],
  },
};

// ====================================================
// 🛠 UTILS
// ====================================================
const formatKZT = (num) =>
  new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(num);

const getStatusLabel = (status) => {
  const map = {
    new: "🆕 Новый",
    work: "🛠 В работе",
    done: "✅ Выполнен",
    cancel: "❌ Отменен",
  };
  return map[status] || status;
};

// ====================================================
// 🚀 MAIN HANDLERS
// ====================================================
export const setupMessageHandlers = () => {
  // 1. /start & Регистрация
  bot.onText(/\/start/, async (msg) => {
    try {
      await db.upsertUser(msg.from.id, msg.from.first_name, msg.from.username);
      await bot.sendMessage(
        msg.chat.id,
        `Салам, <b>${msg.from.first_name}</b>! 👋\nЯ бот <b>ProElectro</b>. Готов к работе!`,
        { parse_mode: "HTML", reply_markup: KB.MAIN },
      );
    } catch (e) {
      console.error("Start Error:", e);
    }
  });

  // 2. Админ-панель
  bot.onText(/\/admin/, async (msg) => {
    const isAdmin =
      String(msg.from.id) === String(config.bot.bossUsername) ||
      String(msg.chat.id) === String(config.bot.workGroupId);

    if (!isAdmin) return bot.sendMessage(msg.chat.id, "⛔️ Доступ запрещен.");

    await bot.sendMessage(msg.chat.id, "👨‍💻 <b>Админ-панель:</b>", {
      parse_mode: "HTML",
      reply_markup: KB.ADMIN,
    });
  });

  // 3. Контакты
  bot.on("contact", async (msg) => {
    if (msg.contact.user_id !== msg.from.id) return;
    await db.updateUserPhone(msg.from.id, msg.contact.phone_number);
    await bot.sendMessage(msg.chat.id, "✅ Номер сохранен!", {
      reply_markup: KB.MAIN,
    });
  });

  // 4. Текстовое меню
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const text = msg.text;

    try {
      // --- 📂 МОИ ЗАКАЗЫ (Через Service) ---
      if (text === "📂 Мои заказы") {
        const orders = await OrderService.getUserOrders(msg.from.id);

        if (orders.length === 0)
          return bot.sendMessage(chatId, "📭 История заказов пуста.");

        let response = "<b>📂 ВАШИ ЗАКАЗЫ:</b>\n\n";
        orders.forEach((o) => {
          const date = new Date(o.created_at).toLocaleDateString();
          response += `🔹 <b>#${o.id}</b> (${date}) — ${formatKZT(o.total_work_cost)}\n`;
          response += `   Статус: ${getStatusLabel(o.status)}\n`;
          if (o.manager_name) response += `   Мастер: ${o.manager_name}\n`;
          response += `➖➖➖➖➖➖➖\n`;
        });
        return bot.sendMessage(chatId, response, { parse_mode: "HTML" });
      }

      // --- 💰 ПРАЙС-ЛИСТ (Через Service) ---
      if (text === "💰 Прайс-лист") {
        const p = await OrderService.getPublicPriceList();
        const msgText =
          `📋 <b>ПРАЙС-ЛИСТ (Работа):</b>\n\n` +
          `🧱 Газоблок: ${p.wall_light} ₸/т\n` +
          `🧱 Кирпич: ${p.wall_medium} ₸/т\n` +
          `🏗 Бетон: ${p.wall_heavy} ₸/т\n\n` +
          `🔌 Черновой материал: ~${p.material_m2} ₸/м²`;
        return bot.sendMessage(chatId, msgText, { parse_mode: "HTML" });
      }

      // --- 📞 КОНТАКТЫ ---
      if (text === "📞 Контакты") {
        return bot.sendMessage(
          chatId,
          `📞 <b>Связь:</b>\n👤 Ернияз: +7 (706) 606-63-23\n👇 Оставьте заявку кнопкой ниже:`,
          { parse_mode: "HTML", reply_markup: KB.CONTACT },
        );
      }

      // --- 🧮 КАЛЬКУЛЯТОР (Логика UI) ---
      if (text === "🧮 Рассчитать стоимость") {
        sessions.set(chatId, { step: "WALLS", data: {} });
        return bot.sendMessage(chatId, "Введите <b>площадь (м²)</b> цифрами:", {
          parse_mode: "HTML",
          reply_markup: { remove_keyboard: true },
        });
      }

      // Обработка ввода цифр для калькулятора
      const session = sessions.get(chatId);
      if (session && session.step === "WALLS") {
        const area = parseInt(text);
        if (isNaN(area) || area < 5 || area > 5000) {
          return bot.sendMessage(chatId, "⚠️ Введите число от 5 до 5000.");
        }

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
    } catch (e) {
      console.error("Handler Error:", e);
      bot.sendMessage(chatId, "❌ Произошла ошибка. Попробуйте /start");
    }
  });
};

// ====================================================
// 👮‍♂️ ADMIN LOGIC
// ====================================================
export const handleAdminCommand = async (msg, match) => {
  const chatId = msg.chat.id;
  const cmd = match[1];

  try {
    if (cmd === "stats") {
      const stats = await OrderService.getGlobalStats();

      let report = `📊 <b>ВОРОНКА ПРОДАЖ:</b>\n\n`;
      if (stats.funnel.length) {
        stats.funnel.forEach((row) => {
          report += `${getStatusLabel(row.status)}: ${row.count} шт. (${formatKZT(row.money)})\n`;
        });
      } else {
        report += "📭 Пусто.\n";
      }

      report += `\n🆕 <b>Последние заказы:</b>\n`;
      stats.recent.forEach((o) => {
        report += `#${o.id} ${o.first_name} — ${getStatusLabel(o.status)}\n`;
      });

      await bot.sendMessage(chatId, report, { parse_mode: "HTML" });
    }

    if (cmd === "spam") {
      await bot.sendMessage(chatId, "Функция рассылки в разработке 🚧");
    }
  } catch (e) {
    console.error("Admin Cmd Error:", e);
    await bot.sendMessage(chatId, "❌ Ошибка при выполнении команды.");
  }
};

// Уведомлялка (оставляем здесь, так как она чисто UI)
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

import { bot } from "../core.js";
import { db } from "../db.js";
import { config } from "../config.js";

// Хранилище сессий для калькулятора (кто на каком шаге)
export const sessions = new Map();

// ====================================================
// 🔘 КЛАВИАТУРЫ (UI)
// ====================================================
export const KB = {
  // 👤 МЕНЮ КЛИЕНТА (Никаких админских кнопок!)
  MAIN_MENU: {
    keyboard: [
      [{ text: "🧮 Рассчитать стоимость" }, { text: "📂 Мои заказы" }],
      [{ text: "💰 Прайс-лист" }, { text: "📞 Контакты" }],
    ],
    resize_keyboard: true,
  },
  // 📱 ЗАПРОС КОНТАКТА
  CONTACT_REQUEST: {
    keyboard: [
      [{ text: "📱 Отправить мой номер", request_contact: true }],
      [{ text: "🔙 Назад" }],
    ],
    resize_keyboard: true,
  },
  // 👮‍♂️ АДМИН-ПАНЕЛЬ (Видна только тебе по команде /admin)
  ADMIN_PANEL: {
    inline_keyboard: [
      [{ text: "📊 Статистика (Funnel)", callback_data: "adm_stats" }],
      [{ text: "✉️ Сделать рассылку", callback_data: "adm_spam" }],
    ],
  },
};

// ====================================================
// ⚙️ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ====================================================

// Утилита: Красивая цена (500 000 ₸)
const formatKZT = (num) => {
  return new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(num);
};

// Утилита: Перевод статусов
const getStatusLabel = (status) => {
  const map = {
    new: "🆕 Новый",
    work: "🛠 В работе",
    done: "✅ Выполнен",
    cancel: "❌ Отменен",
  };
  return map[status] || status;
};

// Уведомление админам (через группу или лс)
export const notifyAdmin = async (text, orderId = null) => {
  try {
    // Если есть ID рабочей группы - шлем туда
    if (config.bot.workGroupId) {
      const opts = { parse_mode: "HTML" };
      // Добавляем кнопку "Взять в работу" для группы
      if (orderId) {
        opts.reply_markup = {
          inline_keyboard: [
            [
              {
                text: "🙋‍♂️ Взять в работу",
                callback_data: `take_order_${orderId}`,
              },
            ],
          ],
        };
      }
      await bot.sendMessage(config.bot.workGroupId, text, opts);
    } else {
      // Иначе шлем Боссу в личку
      await bot.sendMessage(config.bot.bossUsername, text, {
        parse_mode: "HTML",
      });
    }
  } catch (e) {
    console.error("⚠️ Notify Admin Error:", e.message);
  }
};

// ====================================================
// 🚀 ОСНОВНОЙ ОБРАБОТЧИК СООБЩЕНИЙ
// ====================================================
export const setupMessageHandlers = () => {
  // 1. Обработка /start (Вход для всех)
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
      await db.upsertUser(user.id, user.first_name, user.username);

      await bot.sendMessage(
        chatId,
        `Салам, <b>${user.first_name}</b>! 👋\n\n` +
          `Я бот <b>ProElectro</b>. Помогу рассчитать стоимость электрики и оформить заявку.\n\n` +
          `👇 Выбери действие в меню:`,
        { parse_mode: "HTML", reply_markup: KB.MAIN_MENU },
      );
    } catch (e) {
      console.error("Start Error:", e);
    }
  });

  // 2. Обработка /admin (ТОЛЬКО ДЛЯ БОССА)
  bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const bossId = String(config.bot.bossUsername);

    // Проверка: ты ли это?
    if (
      userId !== bossId &&
      String(chatId) !== String(config.bot.workGroupId)
    ) {
      // Если пишет левый чувак - игнорим или прикидываемся шлангом
      return bot.sendMessage(chatId, "❓ Команда не распознана.");
    }

    await bot.sendMessage(
      chatId,
      "🕵️‍♂️ <b>Админ-панель ProElectro</b>\nВыберите действие:",
      {
        parse_mode: "HTML",
        reply_markup: KB.ADMIN_PANEL,
      },
    );
  });

  // 3. Обработка контактов
  bot.on("contact", async (msg) => {
    const chatId = msg.chat.id;
    const phone = msg.contact.phone_number;

    if (msg.contact.user_id !== msg.from.id) return;

    try {
      await db.updateUserPhone(msg.from.id, phone);
      await bot.sendMessage(chatId, "✅ Ваш номер успешно сохранен!", {
        reply_markup: KB.MAIN_MENU,
      });
    } catch (e) {
      console.error("Contact Error:", e);
    }
  });

  // 4. Текстовое меню
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const text = msg.text;

    // --- 🧮 КАЛЬКУЛЯТОР ---
    if (text === "🧮 Рассчитать стоимость") {
      sessions.set(chatId, { step: "WALLS", data: { area: 0 } });

      await bot.sendMessage(
        chatId,
        "Введите <b>площадь помещения</b> (м²):\n<i>Просто напишите число, например: 75</i>",
        {
          parse_mode: "HTML",
          reply_markup: { remove_keyboard: true }, // Скрываем меню на время ввода
        },
      );
      return;
    }

    // --- 📂 МОИ ЗАКАЗЫ ---
    if (text === "📂 Мои заказы") {
      try {
        const sql = `
                    SELECT 
                        o.id, o.status, o.created_at, 
                        l.total_work_cost,
                        u.first_name as manager_name, 
                        u.username as manager_user,
                        u.phone as manager_phone
                    FROM orders o
                    JOIN leads l ON o.lead_id = l.id
                    LEFT JOIN users u ON o.assignee_id = u.telegram_id
                    WHERE o.user_id = $1
                    ORDER BY o.created_at DESC
                    LIMIT 5
                `;
        const res = await db.query(sql, [msg.from.id]);

        if (res.rows.length === 0) {
          return bot.sendMessage(chatId, "📭 У вас пока нет активных заказов.");
        }

        let response = "<b>📂 ВАШИ ПОСЛЕДНИЕ ЗАКАЗЫ:</b>\n\n";

        res.rows.forEach((order) => {
          const date = new Date(order.created_at).toLocaleDateString("ru-RU");
          const status = getStatusLabel(order.status);

          response += `🔹 <b>Заказ #${order.id}</b> от ${date}\n`;
          response += `💰 Сумма: ${formatKZT(order.total_work_cost)}\n`;
          response += `📊 Статус: <b>${status}</b>\n`;

          if (order.manager_name) {
            const link = order.manager_user ? `(@${order.manager_user})` : "";
            response += `👷‍♂️ <b>Менеджер:</b> ${order.manager_name} ${link}\n`;
            if (order.manager_phone)
              response += `📞 Тел: ${order.manager_phone}\n`;
          } else {
            response += `🕒 <i>Ожидает распределения...</i>\n`;
          }
          response += `➖➖➖➖➖➖➖\n`;
        });

        await bot.sendMessage(chatId, response, { parse_mode: "HTML" });
      } catch (e) {
        console.error("My Orders Error:", e);
        await bot.sendMessage(
          chatId,
          "❌ Ошибка при получении списка заказов.",
        );
      }
      return;
    }

    // --- 💰 ПРАЙС ---
    if (text === "💰 Прайс-лист") {
      const prices = await db.getSettings();
      const msgText =
        `📋 <b>АКТУАЛЬНЫЙ ПРАЙС (Работа):</b>\n\n` +
        `🧱 <b>Точка (Газоблок):</b> ${prices.wall_light} ₸\n` +
        `🧱 <b>Точка (Кирпич):</b> ${prices.wall_medium} ₸\n` +
        `🧱 <b>Точка (Бетон):</b> ${prices.wall_heavy} ₸\n\n` +
        `🔌 <b>Материал (черновой):</b> ~${prices.material_m2} ₸/м²\n\n` +
        `<i>*Цены могут меняться в зависимости от сложности.</i>`;

      await bot.sendMessage(chatId, msgText, { parse_mode: "HTML" });
      return;
    }

    // --- 📞 КОНТАКТЫ (Без сайта, без лишнего) ---
    if (text === "📞 Контакты") {
      await bot.sendMessage(
        chatId,
        `📞 <b>Наши контакты:</b>\n\n` +
          `👤 Ернияз: +7 (706) 606-63-23\n` +
          `📍 Алматы, Казахстан\n\n` +
          `👇 Нажмите кнопку ниже, чтобы мы сами вам перезвонили:`,
        {
          parse_mode: "HTML",
          reply_markup: KB.CONTACT_REQUEST,
        },
      );
      return;
    }

    // --- ЛОГИКА КАЛЬКУЛЯТОРА (ВВОД ПЛОЩАДИ) ---
    const session = sessions.get(chatId);
    if (session && session.step === "WALLS") {
      const area = parseInt(text);
      if (isNaN(area) || area < 10 || area > 10000) {
        return bot.sendMessage(
          chatId,
          "⚠️ Пожалуйста, введите корректную площадь (число от 10 до 10000).",
        );
      }

      session.data.area = area;
      session.step = "TYPE";

      await bot.sendMessage(
        chatId,
        `✅ Площадь: ${area} м². \n🧱 <b>Выберите материал стен:</b>`,
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
      return;
    }
  });
};

// ====================================================
// 👮‍♂️ АДМИНСКИЕ КОМАНДЫ (Обработчик callback)
// ====================================================
export const handleAdminCommand = async (msg, match) => {
  const chatId = msg.chat.id;
  const cmd = match[1]; // stats или spam

  const userId = String(msg.from.id); // КТО нажал кнопку
  const bossId = String(config.bot.bossUsername);

  // Двойная проверка прав
  if (userId !== bossId && String(chatId) !== String(config.bot.workGroupId)) {
    return bot.answerCallbackQuery(msg.id, {
      text: "⛔️ Доступ запрещен",
      show_alert: true,
    });
  }

  if (cmd === "stats") {
    const stats = await db.getStats();

    let report = `📊 <b>СТАТИСТИКА:</b>\n\n`;
    if (stats.funnel.length > 0) {
      stats.funnel.forEach((row) => {
        const label = getStatusLabel(row.status);
        report += `${label}: ${row.count} заяв. (${formatKZT(row.money)})\n`;
      });
    } else {
      report += `📭 Заявок пока нет.\n`;
    }

    report += `\n🆕 <b>Последние 5:</b>\n`;
    stats.recent.slice(0, 5).forEach((o) => {
      report += `#${o.id} - ${o.first_name} - ${getStatusLabel(o.status)}\n`;
    });

    await bot.sendMessage(chatId, report, { parse_mode: "HTML" });
  }

  if (cmd === "spam") {
    await bot.sendMessage(
      chatId,
      '✉️ Введите текст рассылки (или фото с подписью). Начните с слова "РАССЫЛКА: "',
    );
  }
};

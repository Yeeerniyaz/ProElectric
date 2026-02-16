/**
 * @file src/handlers/admin.js
 * @description Administrative Control Plane.
 * Модуль управления системой: HR, Финансы, Аналитика и Массовые коммуникации.
 * Реализует защищенные маршруты с проверкой RBAC и Rate Limiting для рассылок.
 * @version 5.0.0 (Enterprise Grade)
 */

import { bot } from "../core.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { OrderService } from "../services/OrderService.js";

// =============================================================================
// 1. CONFIGURATION & CONSTANTS
// =============================================================================

const UI = {
  FORMATTERS: {
    money: (num) =>
      new Intl.NumberFormat("ru-KZ", {
        style: "currency",
        currency: "KZT",
        maximumFractionDigits: 0,
      }).format(num),
    date: (d) => new Date(d).toLocaleString("ru-RU"),
  },

  MESSAGES: {
    ACCESS_DENIED: `⛔️ <b>ДОСТУП ЗАПРЕЩЕН</b>\nЭта команда доступна только Администраторам.`,
    PANEL_HEADER: `👑 <b>ПАНЕЛЬ УПРАВЛЕНИЯ</b>\nСистемы работают в штатном режиме.`,
    INVALID_INPUT: `⚠️ <b>Ошибка формата</b>\nПроверьте правильность введенных данных.`,
    BROADCAST_START: (count) =>
      `📣 Запуск рассылки на <b>${count}</b> пользователей...`,
    BROADCAST_REPORT: (s, f, t) =>
      `✅ <b>Рассылка завершена</b>\n⏱ Время: ${t}ms\n✅ Успешно: ${s}\n❌ Ошибок: ${f}`,
  },

  KEYBOARDS: {
    ADMIN_MAIN: {
      keyboard: [
        [{ text: "📊 Статистика (KPI)" }, { text: "👥 Сотрудники" }],
        [{ text: "📣 Рассылка" }, { text: "📂 Все заказы" }],
        [{ text: "🔙 Выход" }],
      ],
      resize_keyboard: true,
    },
  },
};

// =============================================================================
// 2. MIDDLEWARE (GUARDS)
// =============================================================================

/**
 * Декоратор для защиты админских маршрутов.
 * Проверяет роль пользователя перед выполнением целевой функции.
 * @param {Function} handler - Целевая функция
 */
const AdminGuard = (handler) => async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    // 1. Fast Path: Проверка по конфигу (Owner)
    if (userId === config.bot.ownerId) {
      return await handler(msg, match);
    }

    // 2. Slow Path: Проверка через БД
    const user = await db.upsertUser(
      userId,
      msg.from.first_name,
      msg.from.username,
    );

    if (user.role === "admin") {
      return await handler(msg, match);
    } else {
      console.warn(
        `⛔️ [Admin Attempt] Unauthorized access by ${userId} (${user.first_name})`,
      );
      return bot.sendMessage(chatId, UI.MESSAGES.ACCESS_DENIED, {
        parse_mode: "HTML",
      });
    }
  } catch (e) {
    console.error("💥 [Admin Guard Error]", e);
    bot.sendMessage(chatId, "⚠️ Внутренняя ошибка проверки прав.");
  }
};

// =============================================================================
// 3. SERVICES (LOCAL HELPERS)
// =============================================================================

class BroadcastService {
  /**
   * Безопасная рассылка сообщений с учетом лимитов Telegram.
   * @param {string} text - Текст сообщения
   * @param {Array} users - Массив пользователей
   * @param {Function} progressCallback - Коллбек прогресса (необязательно)
   */
  static async send(text, users, progressCallback) {
    const BATCH_SIZE = 20; // Сообщений за раз
    const DELAY_MS = 1000; // Пауза между пачками
    let success = 0;
    let fail = 0;

    // Разбиваем на пачки (Chunking)
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);

      const promises = batch.map((u) =>
        bot
          .sendMessage(u.telegram_id, `📢 <b>НОВОСТИ:</b>\n\n${text}`, {
            parse_mode: "HTML",
          })
          .then(() => success++)
          .catch(() => fail++),
      );

      await Promise.all(promises);

      if (i + BATCH_SIZE < users.length) {
        await new Promise((r) => setTimeout(r, DELAY_MS)); // Rate Limiting
      }
    }

    return { success, fail };
  }
}

// =============================================================================
// 4. CONTROLLERS
// =============================================================================

const AdminController = {
  /**
   * Главное меню админки
   */
  async openPanel(msg) {
    await bot.sendMessage(msg.chat.id, UI.MESSAGES.PANEL_HEADER, {
      parse_mode: "HTML",
      reply_markup: UI.KEYBOARDS.ADMIN_MAIN,
    });
  },

  /**
   * Статистика и Финансы
   */
  async showStats(msg) {
    const kpi = await db.getKPI();
    const activeOrders = await OrderService.getActiveOrders(null, "admin");
    const accounts = await db.getAccounts(null, "admin");

    const totalCash = accounts.reduce(
      (acc, val) => acc + parseFloat(val.balance),
      0,
    );

    let accountsList = "";
    accounts.forEach((acc) => {
      const icon = acc.type === "bank" ? "💳" : "💵";
      accountsList += `▫️ ${icon} ${acc.name}: <b>${UI.FORMATTERS.money(acc.balance)}</b>\n`;
    });

    const report =
      `📊 <b>СВОДНЫЙ ОТЧЕТ</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `💰 <b>Выручка (Gross):</b> ${UI.FORMATTERS.money(kpi.revenue)}\n` +
      `📉 <b>Чистая прибыль (Net):</b> ${UI.FORMATTERS.money(kpi.profit)}\n` +
      `🛠 <b>Активные заказы:</b> ${activeOrders.length}\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `🏦 <b>БАЛАНС КАСС (${UI.FORMATTERS.money(totalCash)}):</b>\n` +
      `${accountsList}\n` +
      `<i>📅 ${UI.FORMATTERS.date(new Date())}</i>`;

    await bot.sendMessage(msg.chat.id, report, { parse_mode: "HTML" });
  },

  /**
   * Управление персоналом
   */
  async showEmployees(msg) {
    const employees = await db.getEmployees();

    if (employees.length === 0) {
      return bot.sendMessage(msg.chat.id, "🤷‍♂️ Список сотрудников пуст.");
    }

    let list = "<b>👥 ПЕРСОНАЛ:</b>\n\n";
    employees.forEach((u, index) => {
      const roleIcons = { admin: "👑", manager: "👷‍♂️" };
      const link = u.username
        ? `@${u.username}`
        : `ID: <code>${u.telegram_id}</code>`;
      list += `${index + 1}. ${roleIcons[u.role] || "👤"} <b>${u.first_name}</b>\n`;
      list += `   └ ${link} — ${u.role.toUpperCase()}\n`;
    });

    list +=
      `\n⚙️ <b>Команды управления:</b>\n` +
      `/setrole [ID] [manager/admin/client]\n` +
      `<i>Пример: /setrole 12345678 manager</i>`;

    await bot.sendMessage(msg.chat.id, list, { parse_mode: "HTML" });
  },

  /**
   * Изменение роли пользователя
   */
  async setRole(msg, match) {
    const targetId = match[1];
    const newRole = match[2].toLowerCase();

    if (!["admin", "manager", "client"].includes(newRole)) {
      return bot.sendMessage(
        msg.chat.id,
        "⚠️ Недопустимая роль. Используйте: admin, manager, client",
      );
    }

    try {
      // Создаем имя для личной кассы, если это сотрудник
      const cashierName = `Сотрудник ${targetId}`;
      await db.promoteUser(targetId, newRole, cashierName);

      await bot.sendMessage(
        msg.chat.id,
        `✅ <b>Права обновлены!</b>\nПользователь <code>${targetId}</code> теперь <b>${newRole.toUpperCase()}</b>`,
        { parse_mode: "HTML" },
      );

      // Уведомление пользователю
      bot
        .sendMessage(
          targetId,
          `🆙 <b>ВАШ СТАТУС ОБНОВЛЕН</b>\n` +
            `Текущая роль: <b>${newRole.toUpperCase()}</b>\n` +
            `Введите /start для обновления меню.`,
          { parse_mode: "HTML" },
        )
        .catch(() => {}); // Игнорируем ошибку, если бот заблокирован пользователем
    } catch (e) {
      console.error(e);
      bot.sendMessage(msg.chat.id, "❌ Ошибка БД при смене роли.");
    }
  },

  /**
   * Массовая рассылка
   */
  async broadcast(msg, match) {
    const text = match[1];
    if (!text || text.length < 5)
      return bot.sendMessage(
        msg.chat.id,
        "⚠️ Текст рассылки слишком короткий.",
      );

    const res = await db.query("SELECT telegram_id FROM users");
    const users = res.rows;

    await bot.sendMessage(
      msg.chat.id,
      UI.MESSAGES.BROADCAST_START(users.length),
      { parse_mode: "HTML" },
    );

    const startTime = Date.now();
    const { success, fail } = await BroadcastService.send(text, users);
    const duration = Date.now() - startTime;

    await bot.sendMessage(
      msg.chat.id,
      UI.MESSAGES.BROADCAST_REPORT(success, fail, duration),
      { parse_mode: "HTML" },
    );
  },

  /**
   * Создание заказа вручную (Manual Order)
   */
  async manualOrder(msg, match) {
    const [_, phone, areaStr, priceStr] = match;
    const area = parseInt(areaStr);
    const price = parseInt(priceStr);

    if (isNaN(area) || isNaN(price)) {
      return bot.sendMessage(msg.chat.id, UI.MESSAGES.INVALID_INPUT, {
        parse_mode: "HTML",
      });
    }

    try {
      const order = await OrderService.createManualOrder(msg.from.id, {
        clientName: "Клиент (Телефон)",
        clientPhone: phone,
        area: area,
        price: price,
      });

      await bot.sendMessage(
        msg.chat.id,
        `✅ <b>Заказ #${order.id} создан успешно!</b>\n` +
          `📞 ${phone} | 🏠 ${area}м² | 💰 ${UI.FORMATTERS.money(price)}`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error("Manual Order Error:", e);
      bot.sendMessage(msg.chat.id, "❌ Ошибка создания заказа.");
    }
  },

  /**
   * Системная диагностика
   */
  async systemHealth(msg) {
    const mem = process.memoryUsage();
    const uptime = process.uptime();
    const settings = await db.getSettings();

    const status =
      `🖥 <b>SYSTEM STATUS</b>\n` +
      `⏱ Uptime: ${Math.floor(uptime / 60)} min\n` +
      `💾 RAM: ${Math.round(mem.rss / 1024 / 1024)} MB\n` +
      `🔌 DB Connection: OK\n` +
      `⚙️ Config Loaded: ${Object.keys(settings).length} keys`;

    bot.sendMessage(msg.chat.id, status, { parse_mode: "HTML" });
  },

  async showMyId(msg) {
    const userId = msg.from.id;
    const user = await db.upsertUser(userId, msg.from.first_name);
    bot.sendMessage(
      msg.chat.id,
      `🆔 <b>ID:</b> <code>${userId}</code>\n` +
        `🎭 <b>Role:</b> ${user.role}\n` +
        `💬 <b>Chat:</b> <code>${msg.chat.id}</code>`,
      { parse_mode: "HTML" },
    );
  },
};

// =============================================================================
// 5. HANDLER REGISTRATION
// =============================================================================

export const setupAdminHandlers = () => {
  // UI Commands
  bot.onText(/\/admin/, AdminGuard(AdminController.openPanel));
  bot.onText(/👑 Админ-панель/, AdminGuard(AdminController.openPanel));
  bot.onText(/📊 Статистика \(KPI\)/, AdminGuard(AdminController.showStats));
  bot.onText(/👥 Сотрудники/, AdminGuard(AdminController.showEmployees));

  // Action Commands
  // Regex: /setrole 12345678 manager
  bot.onText(
    /\/setrole (\d+) (admin|manager|client)/i,
    AdminGuard(AdminController.setRole),
  );

  // Regex: /broadcast Hello World
  bot.onText(/\/broadcast (.+)/s, AdminGuard(AdminController.broadcast)); // s flag allows multiline match

  // Regex: /neworder +77001112233 50 150000
  // Поддерживает телефоны с +, пробелами, скобками
  bot.onText(
    /\/neworder\s+([\+\d\s\-\(\)]+)\s+(\d+)\s+(\d+)/,
    AdminGuard(AdminController.manualOrder),
  );

  // Utility Commands
  bot.onText(/\/ping/, AdminGuard(AdminController.systemHealth));
  bot.onText(/\/myid/, AdminController.showMyId); // Public safe

  // Help
  bot.onText(
    /\/help_admin/,
    AdminGuard(async (msg) => {
      const text =
        `🛠 <b>СПРАВКА АДМИНИСТРАТОРА</b>\n\n` +
        `<b>1. Управление ролями:</b>\n` +
        `/setrole [ID] [role] - Назначить права\n\n` +
        `<b>2. Создание заказа (по звонку):</b>\n` +
        `/neworder [Тел] [М²] [Цена]\n` +
        `<i>Пример: /neworder +77071234567 45 200000</i>\n\n` +
        `<b>3. Рассылка:</b>\n` +
        `/broadcast [Текст] - Отправить всем пользователям`;
      bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
    }),
  );

  console.log("✅ [Admin] Handlers initialized.");
};

/**
 * @file src/handlers/admin.js
 * @description Administrative Control Plane (ACP).
 * Модуль высшего уровня для управления бизнес-логикой, персоналом и финансами.
 *
 * @architecture MVC (Model-View-Controller)
 * @security RBAC (Role-Based Access Control) + Type-Safe Guards
 * @version 7.0.0 (Titanium Edition)
 */

import { bot } from "../core.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { OrderService } from "../services/OrderService.js";

// =============================================================================
// 1. CONSTANTS & PRESENTATION LAYER
// =============================================================================

const UI = {
  FORMATTERS: {
    money: (amount) =>
      new Intl.NumberFormat("ru-KZ", {
        style: "currency",
        currency: "KZT",
        maximumFractionDigits: 0,
      }).format(amount),

    date: (date) =>
      new Date(date).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
  },

  MESSAGES: {
    ACCESS_DENIED: (id) =>
      `⛔️ <b>ACCESS DENIED</b>\nID: <code>${id}</code> не авторизован.`,
    PANEL_HEADER: `🛰 <b>COMMAND CENTER</b>\nСистемы в норме. Выберите действие:`,
    MANUAL_ORDER_HELP: `📝 <b>Ручной заказ:</b>\n<code>/neworder +77071234567 50 150000</code>`,
    BROADCAST_START: (n) => `📣 Начинаем вещание на <b>${n}</b> получателей...`,
    BROADCAST_DONE: (s, f, t) =>
      `✅ <b>Рассылка завершена</b>\n⏱ ${t}ms | ✅ ${s} | ❌ ${f}`,
  },

  KEYBOARDS: {
    MAIN: {
      keyboard: [
        [{ text: "📊 KPI & Финансы" }, { text: "👥 Персонал" }],
        [{ text: "📣 Рассылка" }, { text: "📂 Активные заказы" }],
        [{ text: "🔙 Главное меню" }],
      ],
      resize_keyboard: true,
    },
  },
};

// =============================================================================
// 2. SECURITY LAYER (GUARDS)
// =============================================================================

/**
 * Guard: Проверяет права администратора.
 * Устойчив к типам данных (String/Number) и контексту (ЛС/Канал).
 */
const AdminGuard = (handler) => async (msg, match) => {
  const chatId = msg.chat.id;

  // Определяем, кто инициатор.
  // Если сообщение из канала (через bot.js bridge), msg.from.id может быть ID канала.
  const initiatorId = msg.from ? msg.from.id : chatId;

  // Приводим все к строкам для надежного сравнения
  const userIdStr = String(initiatorId).trim();
  const ownerIdStr = String(config.bot.ownerId).trim();

  // Логируем попытку входа (для отладки)
  console.log(
    `🛡 [GUARD] Auth Check: User(${userIdStr}) vs Owner(${ownerIdStr})`,
  );

  try {
    let authorized = false;

    // 1. Root Access (Owner ID из .env)
    if (userIdStr === ownerIdStr) {
      authorized = true;
    }
    // 2. Database Role Check
    else {
      // Пытаемся найти пользователя или канал в базе
      const user = await db.upsertUser(
        initiatorId,
        msg.from?.first_name || msg.chat.title || "Unknown",
        msg.from?.username || msg.chat.username,
      );

      if (user && user.role === "admin") {
        authorized = true;
      }
    }

    if (authorized) {
      return await handler(msg, match);
    } else {
      console.warn(`⛔️ [GUARD] Unauthorized access: ${userIdStr}`);
      // В каналах лучше не отвечать на ошибки прав, чтобы не спамить
      if (msg.chat.type === "private") {
        bot.sendMessage(chatId, UI.MESSAGES.ACCESS_DENIED(userIdStr), {
          parse_mode: "HTML",
        });
      }
    }
  } catch (e) {
    console.error("💥 [GUARD CRITICAL]", e);
  }
};

// =============================================================================
// 3. SERVICE LAYER (BUSINESS LOGIC)
// =============================================================================

class BroadcastEngine {
  /**
   * Умная рассылка с соблюдением лимитов Telegram (30 msg/sec).
   */
  static async execute(text, userIds) {
    const BATCH_SIZE = 25;
    const INTERVAL = 1100; // Чуть больше секунды для безопасности
    let success = 0,
      fail = 0;

    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      const chunk = userIds.slice(i, i + BATCH_SIZE);
      const tasks = chunk.map((id) =>
        bot
          .sendMessage(id, `🔔 <b>ОПОВЕЩЕНИЕ:</b>\n\n${text}`, {
            parse_mode: "HTML",
          })
          .then(() => success++)
          .catch(() => fail++),
      );

      await Promise.all(tasks);
      if (i + BATCH_SIZE < userIds.length)
        await new Promise((r) => setTimeout(r, INTERVAL));
    }
    return { success, fail };
  }
}

// =============================================================================
// 4. CONTROLLERS
// =============================================================================

const AdminController = {
  /**
   * Панель управления (Dashboard)
   */
  async dashboard(msg) {
    await bot.sendMessage(msg.chat.id, UI.MESSAGES.PANEL_HEADER, {
      parse_mode: "HTML",
      reply_markup: UI.KEYBOARDS.MAIN,
    });
  },

  /**
   * Отчет по финансам и KPI
   */
  async financeReport(msg) {
    const startT = Date.now();
    const [kpi, activeOrders, accounts] = await Promise.all([
      db.getKPI(),
      OrderService.getActiveOrders(null, "admin"),
      db.getAccounts(null, "admin"),
    ]);

    const totalCash = accounts.reduce(
      (sum, acc) => sum + Number(acc.balance),
      0,
    );

    const accRows = accounts
      .map(
        (a) =>
          `▫️ ${a.type === "bank" ? "💳" : "💵"} ${a.name}: <b>${UI.FORMATTERS.money(a.balance)}</b>`,
      )
      .join("\n");

    const report =
      `📊 <b>ФИНАНСОВАЯ СВОДКА</b>\n` +
      `🕒 <i>${UI.FORMATTERS.date(new Date())}</i>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `💸 <b>Выручка:</b> ${UI.FORMATTERS.money(kpi.revenue)}\n` +
      `📉 <b>Прибыль:</b> ${UI.FORMATTERS.money(kpi.profit)}\n` +
      `🏗 <b>В работе:</b> ${activeOrders.length} заказов\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `🏦 <b>БАЛАНСЫ (${UI.FORMATTERS.money(totalCash)}):</b>\n${accRows}`;

    await bot.sendMessage(msg.chat.id, report, { parse_mode: "HTML" });
    console.log(`⏱ [PERF] Report generated in ${Date.now() - startT}ms`);
  },

  /**
   * Создание заказа вручную (Manual Order Entry)
   */
  async manualOrder(msg, match) {
    // Regex: /neworder +77771112233 50 150000
    const [_, rawPhone, rawArea, rawPrice] = match;
    const area = parseInt(rawArea);
    const price = parseInt(rawPrice);

    if (isNaN(area) || isNaN(price)) {
      return bot.sendMessage(msg.chat.id, UI.MESSAGES.MANUAL_ORDER_HELP, {
        parse_mode: "HTML",
      });
    }

    try {
      // 1. Создаем заказ в системе
      const order = await OrderService.createManualOrder(msg.from.id, {
        clientName: "Ручной ввод",
        clientPhone: rawPhone,
        area,
        price,
      });

      // 2. Подтверждаем админу
      await bot.sendMessage(
        msg.chat.id,
        `✅ <b>Заказ #${order.id} создан!</b>\nСумма: ${UI.FORMATTERS.money(price)}`,
        { parse_mode: "HTML" },
      );

      // 3. 🔥 ОТПРАВЛЯЕМ УВЕДОМЛЕНИЕ В КАНАЛ (Notifier)
      if (config.bot.channelId) {
        const channelMsg =
          `⚡️ <b>НОВЫЙ ЗАКАЗ (MANUAL)</b>\n` +
          `➖➖➖➖➖➖➖➖\n` +
          `🆔 <b>#${order.id}</b>\n` +
          `📞 Контакт: ${rawPhone}\n` +
          `📐 Объем: ${area} м²\n` +
          `💰 Бюджет: <b>${UI.FORMATTERS.money(price)}</b>\n` +
          `👤 Менеджер: ${msg.from?.first_name || "Admin"}`;

        // Отправляем тихо, если это ночь (опционально), или всегда
        await bot
          .sendMessage(config.bot.channelId, channelMsg, { parse_mode: "HTML" })
          .catch((err) => console.error(`⚠️ [NOTIFY FAIL] ${err.message}`));
      }
    } catch (e) {
      console.error("❌ [MANUAL ORDER]", e);
      bot.sendMessage(msg.chat.id, "❌ Ошибка создания заказа.");
    }
  },

  /**
   * Управление ролями (HR)
   */
  async setRole(msg, match) {
    const [_, targetId, role] = match;
    const validRoles = ["admin", "manager", "client"];

    if (!validRoles.includes(role.toLowerCase())) return;

    try {
      await db.promoteUser(
        targetId,
        role.toLowerCase(),
        `Сотрудник ${targetId}`,
      );
      await bot.sendMessage(
        msg.chat.id,
        `✅ Пользователь <code>${targetId}</code> теперь <b>${role.toUpperCase()}</b>`,
        { parse_mode: "HTML" },
      );

      // Notify user
      bot
        .sendMessage(
          targetId,
          `🆙 Вам выданы права: <b>${role.toUpperCase()}</b>`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
    } catch (e) {
      bot.sendMessage(msg.chat.id, "❌ Ошибка базы данных.");
    }
  },

  /**
   * Массовая рассылка (Broadcast)
   */
  async broadcast(msg, match) {
    const text = match[1];
    if (!text) return;

    const res = await db.query("SELECT telegram_id FROM users");
    const users = res.rows.map((r) => r.telegram_id);

    await bot.sendMessage(
      msg.chat.id,
      UI.MESSAGES.BROADCAST_START(users.length),
      { parse_mode: "HTML" },
    );

    const start = Date.now();
    const { success, fail } = await BroadcastEngine.execute(text, users);

    await bot.sendMessage(
      msg.chat.id,
      UI.MESSAGES.BROADCAST_DONE(success, fail, Date.now() - start),
      { parse_mode: "HTML" },
    );
  },

  /**
   * Отладочная команда для проверки ID
   */
  async debugId(msg) {
    const debugInfo =
      `🕵️‍♂️ <b>DEBUG INFO</b>\n` +
      `👤 Your ID (msg.from): <code>${msg.from?.id}</code>\n` +
      `💬 Chat ID (msg.chat): <code>${msg.chat.id}</code>\n` +
      `🔑 Owner ID (env): <code>${config.bot.ownerId}</code>\n` +
      `📁 Context: ${msg.chat.type}`;

    await bot.sendMessage(msg.chat.id, debugInfo, { parse_mode: "HTML" });
  },
};

// =============================================================================
// 5. ROUTER CONFIGURATION
// =============================================================================

export const setupAdminHandlers = () => {
  // RegExp Commands
  const R = {
    ADMIN_PANEL: /^\/admin|👑/i,
    STATS: /KPI|Статистика/i,
    MANUAL_ORDER: /^\/neworder\s+([+\d\s\-\(\)]+)\s+(\d+)\s+(\d+)/,
    SET_ROLE: /^\/setrole (\d+) (admin|manager|client)/i,
    BROADCAST: /^\/broadcast\s+(.+)/s,
    DEBUG: /^\/debug_id/,
  };

  // Register Routes
  bot.onText(R.ADMIN_PANEL, AdminGuard(AdminController.dashboard));
  bot.onText(R.STATS, AdminGuard(AdminController.financeReport));
  bot.onText(R.MANUAL_ORDER, AdminGuard(AdminController.manualOrder));
  bot.onText(R.SET_ROLE, AdminGuard(AdminController.setRole));
  bot.onText(R.BROADCAST, AdminGuard(AdminController.broadcast));

  // Public Debug (Safe)
  bot.onText(R.DEBUG, AdminController.debugId);

  // Сотрудники
  bot.onText(
    /👥 Сотрудники/i,
    AdminGuard(async (msg) => {
      const users = await db.getEmployees();
      const list =
        users
          .map(
            (u) =>
              `${u.role === "admin" ? "👑" : "👷"} <b>${u.first_name}</b> (ID: <code>${u.telegram_id}</code>)`,
          )
          .join("\n") || "Список пуст";
      bot.sendMessage(msg.chat.id, `<b>ПЕРСОНАЛ:</b>\n\n${list}`, {
        parse_mode: "HTML",
      });
    }),
  );

  console.log("✅ [ADMIN] Module initialized.");
};

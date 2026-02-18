/**
 * @file src/bot.js
 * @description Модуль инициализации и маршрутизации Telegram бота.
 * Выполняет роль Router/Dispatcher: перенаправляет входящие события в контроллеры.
 * Реализует приоритетную обработку FSM (машины состояний) для админов.
 *
 * @module BotCore
 * @version 7.1.0 (Senior Architect Edition)
 * @author ProElectric Team
 */

import { Telegraf, session } from "telegraf";
import { config } from "./config.js";

// Импорт контроллеров (Handlers)
import { UserHandler } from "./handlers/UserHandler.js";
import { AdminHandler } from "./handlers/AdminHandler.js";

// =============================================================================
// 🔧 LOCAL ROUTING TRIGGERS
// =============================================================================
const TRIGGERS = {
  // --- Пользовательское меню ---
  CALCULATE: "🚀 Рассчитать стоимость",
  ORDERS: "📂 Мои заявки",
  PRICE_LIST: "💰 Прайс-лист",
  CONTACTS: "📞 Контакты",
  HOW_WORK: "ℹ️ Как мы работаем",
  BACK: "🔙 Назад",
  CANCEL: "❌ Отмена",
  MAIN_MENU: "🏠 Главное меню",
  SHARE_PHONE: "📱 Отправить мой номер телефона",

  // --- Админское меню (Вход) ---
  ADMIN_PANEL: "👑 Админ-панель",

  // --- Внутри админки ---
  ADMIN_DASHBOARD: "📊 P&L Отчет",
  ADMIN_ORDERS: "📦 Управление заказами",
  ADMIN_SETTINGS: "⚙️ Настройки цен",
  ADMIN_STAFF: "👥 Персонал",
  ADMIN_SQL: "👨‍💻 SQL Терминал",
  ADMIN_BACKUP: "💾 Бэкап базы",
  ADMIN_SERVER: "🖥 Состояние сервера",
};

// =============================================================================
// 1. ИНИЦИАЛИЗАЦИЯ (BOOTSTRAP)
// =============================================================================

if (!config.bot.token) {
  console.error("❌ [FATAL] BOT_TOKEN is missing in configuration.");
  process.exit(1);
}

// Создаем инстанс бота
export const bot = new Telegraf(config.bot.token);

// =============================================================================
// 2. MIDDLEWARE (PIPELINE)
// =============================================================================

// 2.1. Session Middleware
// Важно: defaultSession инициализирует объект для хранения состояний (FSM)
bot.use(session({ defaultSession: () => ({}) }));

// 2.2. Logger Middleware (Audit)
bot.use(async (ctx, next) => {
  if (!config.system.isProduction) {
    const user = ctx.from
      ? `${ctx.from.id} (${ctx.from.first_name})`
      : "System";
    const type = ctx.updateType;
    const content =
      ctx.message?.text || ctx.callbackQuery?.data || "media/action";

    console.log(
      `📡 [Bot] Update from ${user} | Type: ${type} | Content: ${content}`,
    );
  }
  await next();
});

// =============================================================================
// 3. МАРШРУТИЗАЦИЯ (ROUTING MAP)
// =============================================================================

// --- 👑 ADMIN COMMANDS (Direct Access) ---
bot.command("admin", (ctx) => AdminHandler.showAdminMenu(ctx));
bot.hears(/^\/setrole/, (ctx) => AdminHandler.processSetRole(ctx));
bot.hears(/^\/setprice/, (ctx) => AdminHandler.processSetPrice(ctx));
bot.hears(/^\/sql/, (ctx) => AdminHandler.processSQL(ctx));
bot.hears(/^\/order/, (ctx) => AdminHandler.findOrder(ctx)); // Поиск заказа

// --- 🕹 ADMIN MENU HANDLERS ---
bot.hears(TRIGGERS.ADMIN_PANEL, (ctx) => AdminHandler.showAdminMenu(ctx));
bot.hears(TRIGGERS.ADMIN_DASHBOARD, (ctx) => AdminHandler.showDashboard(ctx));
bot.hears(TRIGGERS.ADMIN_ORDERS, (ctx) =>
  AdminHandler.showOrdersInstruction(ctx),
);
bot.hears(TRIGGERS.ADMIN_SETTINGS, (ctx) => AdminHandler.showSettings(ctx));
bot.hears(TRIGGERS.ADMIN_STAFF, (ctx) => AdminHandler.showStaffList(ctx));
bot.hears(TRIGGERS.ADMIN_SQL, (ctx) => AdminHandler.showSQLInstruction(ctx));
bot.hears(TRIGGERS.ADMIN_BACKUP, (ctx) => AdminHandler.processBackup(ctx));
bot.hears(TRIGGERS.ADMIN_SERVER, (ctx) => AdminHandler.showServerStats(ctx));

// Навигация админа (если отличается)
bot.hears(TRIGGERS.BACK, (ctx) => UserHandler.returnToMainMenu(ctx));

// --- 👤 USER COMMANDS ---
bot.command("start", (ctx) => UserHandler.startCommand(ctx));
bot.command("cancel", (ctx) => UserHandler.returnToMainMenu(ctx));
bot.command("menu", (ctx) => UserHandler.returnToMainMenu(ctx));

// --- 🖱 CALLBACK ACTIONS (Inline Buttons) ---

// 1. Admin Complex Actions (New Logic)
// Перехватываем все новые колбэки: расходы, комменты, отмены
bot.action(
  [
    /^expense_/,
    /^comment_/,
    /^cancel_/,
    /^back_to_order_/,
    "admin_cancel_input",
  ],
  (ctx) => AdminHandler.handleCallback(ctx, ctx.callbackQuery.data),
);

// 2. Admin Refresh
bot.action("admin_refresh_dashboard", (ctx) => AdminHandler.showDashboard(ctx));

// 3. Admin Status Change (status_123_work)
bot.action(/^status_(\d+)_(.+)$/, (ctx) => {
  const orderId = ctx.match[1];
  const newStatus = ctx.match[2];
  return AdminHandler.handleOrderStatusChange(ctx, orderId, newStatus);
});

// 4. User Actions
bot.action(/^wall_/, (ctx) => UserHandler.handleWallSelection(ctx));
bot.action("action_save_order", (ctx) => UserHandler.saveOrderAction(ctx));
bot.action("action_recalc", (ctx) => UserHandler.enterCalculationMode(ctx));

// --- 💬 USER TEXT MENU (Navigation) ---
bot.hears([TRIGGERS.CALCULATE, TRIGGERS.MAIN_MENU], (ctx) =>
  UserHandler.enterCalculationMode(ctx),
);
bot.hears(TRIGGERS.ORDERS, (ctx) => UserHandler.showMyOrders(ctx));
bot.hears(TRIGGERS.PRICE_LIST, (ctx) => UserHandler.showPriceList(ctx));
bot.hears(TRIGGERS.CONTACTS, (ctx) => UserHandler.handleTextMessage(ctx));
bot.hears(TRIGGERS.HOW_WORK, (ctx) => UserHandler.handleTextMessage(ctx));

// --- 📥 GLOBAL INPUT HANDLER (Wizard Steps & FSM) ---
bot.on("text", async (ctx) => {
  // 🔥 ПРИОРИТЕТ 1: Проверяем, не вводит ли Админ данные (FSM)
  // Если handleAdminInput вернет true, значит сообщение обработано как админское (расход/коммент)
  // и мы прерываем цепочку.
  try {
    if (ctx.session?.adminState && (await AdminHandler.handleAdminInput(ctx))) {
      return;
    }
  } catch (e) {
    console.error("Admin FSM Error:", e);
  }

  // 🔥 ПРИОРИТЕТ 2: Обычная обработка пользователя
  return UserHandler.handleTextMessage(ctx);
});

// --- 📱 CONTACT HANDLER ---
bot.on("contact", (ctx) => UserHandler.handleContact(ctx));

// =============================================================================
// 4. ERROR HANDLING (GLOBAL CATCH)
// =============================================================================

bot.catch((err, ctx) => {
  console.error(`🔥 [Bot Catch] Error for ${ctx.updateType}:`, err);
  // Пытаемся безопасно ответить пользователю, если это возможно
  try {
    if (ctx.chat?.type === "private") {
      // Silent fail or polite message
    }
  } catch (e) {
    // ignore
  }
});

/**
 * @file src/bot.js
 * @description Модуль инициализации и маршрутизации Telegram бота.
 * Выполняет роль Router/Dispatcher: перенаправляет входящие события в контроллеры.
 * Полностью автономен (Self-Contained): не зависит от внешних файлов констант.
 *
 * @module BotCore
 * @version 6.4.0 (Senior Architect Edition)
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
// Определяем тексты кнопок локально для маршрутизации.
// FIX: Добавлена константа ADMIN_PANEL для обработки кнопки входа
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
  ADMIN_PANEL: "👑 Админ-панель", // <--- ДОБАВЛЕНО: Текст кнопки входа

  // --- Внутри админки ---
  ADMIN_DASHBOARD: "📊 P&L Отчет",
  ADMIN_ORDERS: "📦 Управление заказами",
  ADMIN_SETTINGS: "⚙️ Настройки цен",
  ADMIN_STAFF: "👥 Персонал",
  ADMIN_SQL: "👨‍💻 SQL Терминал",
  ADMIN_BACKUP: "💾 Бэкап базы",
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
// FIX: Добавляем defaultSession, чтобы ctx.session всегда был объектом
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

// --- 👑 ADMIN COMMANDS (Regex Routers) ---
bot.hears(/^\/setrole/, (ctx) => AdminHandler.processSetRole(ctx)); // /setrole 123 admin
bot.hears(/^\/setprice/, (ctx) => AdminHandler.processSetPrice(ctx)); // /setprice cable 500
bot.hears(/^\/sql/, (ctx) => AdminHandler.processSQL(ctx)); // /sql SELECT * ...
bot.hears(/^\/backup/, (ctx) => AdminHandler.processBackup(ctx)); // /backup

// FIX: Добавляем команду /admin для явного вызова панели
bot.command("admin", (ctx) => AdminHandler.showAdminMenu(ctx));

// --- 🕹 ADMIN MENU HANDLERS ---
// FIX: Добавляем слушатель кнопки "👑 Админ-панель"
bot.hears(TRIGGERS.ADMIN_PANEL, (ctx) => AdminHandler.showAdminMenu(ctx));

bot.hears(TRIGGERS.ADMIN_DASHBOARD, (ctx) => AdminHandler.showDashboard(ctx));
bot.hears(TRIGGERS.ADMIN_ORDERS, (ctx) =>
  AdminHandler.showOrdersInstruction(ctx),
);
bot.hears(TRIGGERS.ADMIN_SETTINGS, (ctx) =>
  AdminHandler.showSettingsInstruction(ctx),
);
bot.hears(TRIGGERS.ADMIN_STAFF, (ctx) =>
  AdminHandler.showStaffInstruction(ctx),
);
bot.hears(TRIGGERS.ADMIN_SQL, (ctx) => AdminHandler.showSQLInstruction(ctx));
bot.hears(TRIGGERS.ADMIN_BACKUP, (ctx) => AdminHandler.processBackup(ctx));

// Админские кнопки возврата (если они отличаются от юзерских)
bot.hears("🔙 В главное меню", (ctx) => UserHandler.returnToMainMenu(ctx));

// --- 👤 USER COMMANDS ---
bot.command("start", (ctx) => UserHandler.startCommand(ctx));
bot.command("cancel", (ctx) => UserHandler.returnToMainMenu(ctx));
bot.command("menu", (ctx) => UserHandler.returnToMainMenu(ctx));

// --- 🖱 CALLBACK ACTIONS (Inline Buttons) ---
bot.action(/^wall_/, (ctx) => UserHandler.handleWallSelection(ctx));
bot.action("action_save_order", (ctx) => UserHandler.saveOrderAction(ctx));
bot.action("action_recalc", (ctx) => UserHandler.enterCalculationMode(ctx));

// Админские действия с заказами (status_123_work)
bot.action(/^status_/, (ctx) =>
  AdminHandler.handleOrderStatusChange(ctx, ...ctx.match[0].split("_").slice(1))
);

// --- 💬 USER TEXT MENU (Navigation) ---
bot.hears([TRIGGERS.CALCULATE, TRIGGERS.MAIN_MENU], (ctx) =>
  UserHandler.enterCalculationMode(ctx),
);
bot.hears(TRIGGERS.ORDERS, (ctx) => UserHandler.showMyOrders(ctx));
bot.hears(TRIGGERS.PRICE_LIST, (ctx) => UserHandler.showPriceList(ctx));
bot.hears(TRIGGERS.CONTACTS, (ctx) => UserHandler.handleTextMessage(ctx));
bot.hears(TRIGGERS.HOW_WORK, (ctx) => UserHandler.handleTextMessage(ctx));
bot.hears([TRIGGERS.BACK, TRIGGERS.CANCEL], (ctx) =>
  UserHandler.returnToMainMenu(ctx),
);

// --- 📥 GLOBAL INPUT HANDLER (Wizard Steps) ---
// Ловит любой текст, который не попал в предыдущие фильтры
bot.on("text", (ctx) => {
  // Если мы в процессе ввода данных для расчета
  return UserHandler.handleTextMessage(ctx);
});

// --- 📱 CONTACT HANDLER ---
bot.on("contact", (ctx) => UserHandler.handleContact(ctx));

// =============================================================================
// 4. ERROR HANDLING (GLOBAL CATCH)
// =============================================================================

bot.catch((err, ctx) => {
  console.error(`🔥 [Bot Catch] Error for ${ctx.updateType}:`, err);
  try {
    if (ctx.chat?.type === "private") {
      ctx.reply("⚠️ Внутренняя ошибка. Попробуйте перезапустить бота /start");
    }
  } catch (e) {
    console.error("Failed to send error notification.");
  }
});
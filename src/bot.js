/**
 * @file src/bot.js
 * @description Модуль инициализации и маршрутизации Telegram бота.
 * Выполняет роль Router/Dispatcher: перенаправляет входящие события в контроллеры.
 * Полностью автономен (Self-Contained): не зависит от внешних файлов констант.
 *
 * @module BotCore
 * @version 7.5.0 (Senior Architect Edition)
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
// Убедимся, что сессия работает корректно и всегда возвращает объект
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
bot.hears(/^\/setrole/, (ctx) => AdminHandler.processSetRole(ctx));
bot.hears(/^\/setprice/, (ctx) => AdminHandler.processSetPrice(ctx));
bot.hears(/^\/sql/, (ctx) => AdminHandler.processSQL(ctx));
bot.hears(/^\/order/, (ctx) => AdminHandler.findOrder(ctx));

// Явный вызов админ-панели
bot.command("admin", (ctx) => AdminHandler.showAdminMenu(ctx));

// --- 🕹 ADMIN MENU HANDLERS ---
bot.hears(TRIGGERS.ADMIN_PANEL, (ctx) => AdminHandler.showAdminMenu(ctx));
bot.hears(TRIGGERS.ADMIN_DASHBOARD, (ctx) => AdminHandler.showDashboard(ctx));
bot.hears(TRIGGERS.ADMIN_ORDERS, (ctx) => AdminHandler.showOrdersInstruction(ctx));
bot.hears(TRIGGERS.ADMIN_SETTINGS, (ctx) => AdminHandler.showSettings(ctx));
bot.hears(TRIGGERS.ADMIN_STAFF, (ctx) => AdminHandler.showStaffList(ctx));
bot.hears(TRIGGERS.ADMIN_SQL, (ctx) => AdminHandler.showSQLInstruction(ctx));
bot.hears(TRIGGERS.ADMIN_BACKUP, (ctx) => AdminHandler.processBackup(ctx));
bot.hears(TRIGGERS.ADMIN_SERVER, (ctx) => AdminHandler.showServerStats(ctx));

// Кнопка "Назад" в админке
bot.hears("🔙 В главное меню", (ctx) => UserHandler.returnToMainMenu(ctx));

// --- 👤 USER COMMANDS ---
bot.command("start", (ctx) => UserHandler.startCommand(ctx));
bot.command("cancel", (ctx) => UserHandler.returnToMainMenu(ctx));
bot.command("menu", (ctx) => UserHandler.returnToMainMenu(ctx));

// --- 🖱 CALLBACK ACTIONS (Inline Buttons) ---

// 1. Клиентские экшены (Калькулятор)
bot.action(/^wall_/, (ctx) => UserHandler.handleWallSelection(ctx));
bot.action("action_save_order", (ctx) => UserHandler.saveOrderAction(ctx));
bot.action("action_recalc", (ctx) => UserHandler.enterCalculationMode(ctx));

// 2. Админские экшены (Управление заказами)
bot.action(/^status_(\d+)_(.+)$/, (ctx) => {
  return AdminHandler.handleOrderStatusChange(ctx, ctx.match[1], ctx.match[2]);
});

// Новые экшены для работы с метаданными (Адрес, Комменты, Причина отмены)
bot.action(/^prompt_address_(\d+)$/, (ctx) => AdminHandler.promptAddress(ctx, ctx.match[1]));
bot.action(/^prompt_comment_(\d+)$/, (ctx) => AdminHandler.promptComment(ctx, ctx.match[1]));
bot.action(/^prompt_cancel_(\d+)$/, (ctx) => AdminHandler.promptCancel(ctx, ctx.match[1]));
bot.action(/^cancel_reason_(\d+)_(client|firm)$/, (ctx) => AdminHandler.processCancelReason(ctx, ctx.match[1], ctx.match[2]));
bot.action(/^refresh_order_(\d+)$/, (ctx) => AdminHandler.findOrder(ctx)); // Обновление карточки заказа

// Мелкие заглушки для кнопок, которые не обрабатываются бэкендом
bot.action(/^expense_(\d+)$/, (ctx) => ctx.answerCbQuery("💸 Перейдите в Web-версию (CRM) для учета финансов", { show_alert: true }));
bot.action(/^download_(\d+)$/, (ctx) => ctx.answerCbQuery("🚧 Генерация акта в разработке"));

// Обновление дашборда
bot.action("admin_refresh_dashboard", (ctx) => AdminHandler.showDashboard(ctx));


// --- 💬 TEXT MENU (Navigation) ---
bot.hears([TRIGGERS.CALCULATE, TRIGGERS.MAIN_MENU], (ctx) => UserHandler.enterCalculationMode(ctx));
bot.hears(TRIGGERS.ORDERS, (ctx) => UserHandler.showMyOrders(ctx));
bot.hears(TRIGGERS.PRICE_LIST, (ctx) => UserHandler.showPriceList(ctx));
bot.hears(TRIGGERS.CONTACTS, (ctx) => UserHandler.handleTextMessage(ctx));
bot.hears(TRIGGERS.HOW_WORK, (ctx) => UserHandler.handleTextMessage(ctx));
bot.hears([TRIGGERS.BACK, TRIGGERS.CANCEL], (ctx) => UserHandler.returnToMainMenu(ctx));

// --- 📥 GLOBAL TEXT INTERCEPTOR (FSM) ---
// Ловит любой текст, который не подошел под команды и кнопки меню
bot.on("text", async (ctx) => {
  // 1. Сначала прокидываем текст в AdminHandler, чтобы он перехватил ввод адреса/комментария
  await AdminHandler.handleMessage(ctx);
  
  // 2. Затем в UserHandler для обработки ввода площади/комнат в калькуляторе
  await UserHandler.handleTextMessage(ctx);
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
      // ctx.reply("⚠️ Ошибка сервера. Мы уже чиним.");
    }
  } catch (e) {
    console.error("Failed to send error notification.");
  }
});
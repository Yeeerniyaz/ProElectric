/**
 * @file src/bot.js
 * @description Модуль инициализации и маршрутизации Telegram бота.
 * Выполняет роль Router/Dispatcher: перенаправляет входящие события в контроллеры.
 * Полностью автономен (Self-Contained): не зависит от внешних файлов констант.
 *
 * @module BotCore
 * @version 6.3.0 (Senior Architect Edition)
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
// Это плата за отказ от глобального файла constants.js (Loose Coupling).
// Эти строки должны совпадать с тем, что отправляют клавиатуры в Handlers.

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

  // --- Админское меню ---
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
// Хранит состояние (FSM) в оперативной памяти.
// В Production Highload рекомендуется заменить на Redis (telegraf-session-redis).
bot.use(session());

// 2.2. Logger Middleware (Audit)
// Логирует все входящие события для отладки.
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
// Команды, требующие аргументов или специального парсинга
bot.hears(/^\/setrole/, (ctx) => AdminHandler.processSetRole(ctx)); // /setrole 123 admin
bot.hears(/^\/setprice/, (ctx) => AdminHandler.processSetPrice(ctx)); // /setprice cable 500
bot.hears(/^\/sql/, (ctx) => AdminHandler.processSQL(ctx)); // /sql SELECT * ...
bot.hears(/^\/backup/, (ctx) => AdminHandler.processBackup(ctx)); // /backup

// --- 🕹 ADMIN MENU HANDLERS ---
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

// --- 👤 USER COMMANDS ---
bot.command("start", (ctx) => UserHandler.startCommand(ctx));
bot.command("cancel", (ctx) => UserHandler.returnToMainMenu(ctx));
bot.command("menu", (ctx) => UserHandler.returnToMainMenu(ctx));

// --- 🖱 CALLBACK ACTIONS (Inline Buttons) ---
// Используем Regex для обработки динамических callback_data
bot.action(/^wall_/, (ctx) => UserHandler.handleWallSelection(ctx)); // Выбор стен (wall_brick...)
bot.action("action_save_order", (ctx) => UserHandler.saveOrderAction(ctx)); // Сохранение заказа
bot.action("action_recalc", (ctx) => UserHandler.enterCalculationMode(ctx)); // Пересчет

// Админские действия с заказами (status_123_work)
bot.action(/^status_/, (ctx) => AdminHandler.handleOrderStatusChange(ctx));

// --- 💬 USER TEXT MENU (Navigation) ---
// Обработка нажатий на Reply клавиатуру
bot.hears([TRIGGERS.CALCULATE, TRIGGERS.MAIN_MENU], (ctx) =>
  UserHandler.enterCalculationMode(ctx),
);
bot.hears(TRIGGERS.ORDERS, (ctx) => UserHandler.showMyOrders(ctx));
bot.hears(TRIGGERS.PRICE_LIST, (ctx) => UserHandler.showPriceList(ctx));
bot.hears(TRIGGERS.CONTACTS, (ctx) => UserHandler.handleTextMessage(ctx)); // Проксируем в хендлер
bot.hears(TRIGGERS.HOW_WORK, (ctx) => UserHandler.handleTextMessage(ctx)); // Проксируем в хендлер
bot.hears([TRIGGERS.BACK, TRIGGERS.CANCEL], (ctx) =>
  UserHandler.returnToMainMenu(ctx),
);

// --- 📥 GLOBAL INPUT HANDLER (Wizard Steps) ---
// Ловит любой текст, который не попал в предыдущие фильтры.
// Используется для ввода площади, количества комнат и т.д.
bot.on("text", (ctx) => {
  return UserHandler.handleTextMessage(ctx);
});

// --- 📱 CONTACT HANDLER ---
// Обработка отправки контактов (регистрация)
bot.on("contact", (ctx) => UserHandler.handleContact(ctx));

// =============================================================================
// 4. ERROR HANDLING (GLOBAL CATCH)
// =============================================================================

bot.catch((err, ctx) => {
  console.error(`🔥 [Bot Catch] Error for ${ctx.updateType}:`, err);

  // Пытаемся безопасно ответить пользователю, если это возможно
  try {
    if (ctx.chat?.type === "private") {
      ctx.reply(
        "⚠️ Произошла внутренняя ошибка сервера. Инженеры уже уведомлены.",
      );
    }
  } catch (e) {
    // Если не удалось отправить сообщение (юзер заблокировал бота), просто логируем
    console.error("Failed to send error notification to user.");
  }
});
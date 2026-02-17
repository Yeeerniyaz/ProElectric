/**
 * @file src/bot.js
 * @description Модуль инициализации и конфигурации Telegram бота.
 * Содержит всю логику маршрутизации (Routing), Middleware и обработку ошибок.
 * Полностью отделен от HTTP-сервера.
 *
 * @module Bot
 * @version 6.1.0 (Senior Architect Edition)
 * @author ProElectric Team
 */

import { Telegraf, session } from "telegraf";
import { config } from "./config.js";
import { BUTTONS } from "./constants.js";

// Импорт контроллеров (Handlers)
import { UserHandler } from "./handlers/UserHandler.js";
import { AdminHandler } from "./handlers/AdminHandler.js";

// =============================================================================
// 1. ИНИЦИАЛИЗАЦИЯ (BOOTSTRAPPING)
// =============================================================================

if (!config.bot.token) {
  throw new Error("❌ [BOT FATAL] Отсутствует BOT_TOKEN в конфигурации.");
}

export const bot = new Telegraf(config.bot.token);

// =============================================================================
// 2. MIDDLEWARE (ПРОМЕЖУТОЧНОЕ ПО)
// =============================================================================

// Подключение сессий (хранение состояния FSM в памяти)
// В продакшене для Highload стоит переключиться на Redis (telegraf-session-redis)
bot.use(session());

// Логгер входящих апдейтов (Performance Monitoring)
bot.use(async (ctx, next) => {
  const start = Date.now();
  try {
    await next();
  } finally {
    const ms = Date.now() - start;
    if (!config.system.isProduction) {
      console.log(
        `📡 [Bot] Update ID: ${ctx.update.update_id} | Type: ${ctx.updateType} | Time: ${ms}ms`,
      );
    }
  }
});

// =============================================================================
// 3. МАРШРУТИЗАЦИЯ (ROUTING)
// =============================================================================

// --- 👑 Админские команды (Admin Routes) ---
// Используем регулярные выражения для гибкости
bot.hears(/^\/setrole/, (ctx) => AdminHandler.processSetRole(ctx)); // Назначение ролей
bot.hears(/^\/setprice/, (ctx) => AdminHandler.processSetPrice(ctx)); // Смена цен
bot.hears(/^\/broadcast/, (ctx) => AdminHandler.processBroadcast(ctx)); // Рассылка
bot.hears(/^\/backup/, (ctx) => AdminHandler.processBackup(ctx)); // Бэкап БД
bot.hears(/^\/status/, (ctx) => AdminHandler.processSetStatus(ctx)); // Смена статуса заказа
bot.hears(/^\/ban/, (ctx) => AdminHandler.processBanUser(ctx)); // Бан пользователя
bot.hears(/^\/sql/, (ctx) => AdminHandler.processSQL(ctx)); // SQL-терминал
bot.hears(/^\/expense/, (ctx) => AdminHandler.processSetExpense(ctx)); // Добавление расхода

// --- 🕹 Меню Админа (Admin Dashboard) ---
bot.hears(BUTTONS.ADMIN_STATS, (ctx) => AdminHandler.showDashboard(ctx));
bot.hears(BUTTONS.ADMIN_SETTINGS, (ctx) =>
  AdminHandler.showSettingsInstruction(ctx),
);
bot.hears(BUTTONS.ADMIN_STAFF, (ctx) => AdminHandler.showStaffInstruction(ctx));
bot.hears(BUTTONS.ADMIN_ORDERS, (ctx) =>
  AdminHandler.showOrdersInstruction(ctx),
);
bot.hears(BUTTONS.ADMIN_SQL, (ctx) => AdminHandler.showSQLInstruction(ctx));

// --- 👤 Пользовательские команды (User Routes) ---
bot.command("start", (ctx) => UserHandler.startCommand(ctx));
bot.command("cancel", (ctx) => UserHandler.returnToMainMenu(ctx));

// --- ⚡️ Интерактивные действия (Callbacks) ---
bot.action(/^wall_/, (ctx) => UserHandler.handleWallSelection(ctx)); // Выбор стен
bot.action("action_save_order", (ctx) => UserHandler.saveOrderAction(ctx)); // Сохранение заказа
bot.action("action_recalc", (ctx) => UserHandler.enterCalculationMode(ctx)); // Пересчет

// --- 💬 Текстовое меню (Text Commands) ---
// Массив триггеров позволяет реагировать на разные вариации кнопок
bot.hears([BUTTONS.CALCULATE, "🏠 Главное меню"], (ctx) =>
  UserHandler.enterCalculationMode(ctx),
);
bot.hears(BUTTONS.ORDERS, (ctx) => UserHandler.showMyOrders(ctx));
bot.hears(BUTTONS.PRICE_LIST, (ctx) => UserHandler.showPriceList(ctx));
bot.hears(BUTTONS.CONTACTS, (ctx) => UserHandler.handleTextMessage(ctx)); // Обработка через роутер хендлера
bot.hears(BUTTONS.HOW_WORK, (ctx) => UserHandler.handleTextMessage(ctx)); // Обработка через роутер хендлера
bot.hears([BUTTONS.BACK, BUTTONS.CANCEL], (ctx) =>
  UserHandler.returnToMainMenu(ctx),
);

// --- 🎮 Глобальный обработчик (Catch-All) ---
// Обрабатывает ввод данных в пошаговом визарде (площадь, комнаты и т.д.)
bot.on("text", (ctx) => {
  // Если это команда админа, которую мы не поймали выше - игнорируем здесь,
  // чтобы не мешать UserHandler'у, или передаем в AdminHandler если нужно.
  // В данной архитектуре AdminHandler ловит свои команды через hears(Regex),
  // поэтому всё остальное идет в UserHandler.
  return UserHandler.handleTextMessage(ctx);
});

// Контакт (для регистрации)
bot.on("contact", (ctx) => UserHandler.handleContact(ctx));

// =============================================================================
// 4. ОБРАБОТКА ОШИБОК (ERROR HANDLING)
// =============================================================================

bot.catch((err, ctx) => {
  console.error(`🔥 [Bot Error] Update ${ctx.updateType} failed:`, err);

  // Пытаемся уведомить пользователя, если это возможно
  try {
    if (ctx.chat && ctx.chat.type === "private") {
      ctx.reply(
        "⚠️ Произошла временная ошибка. Попробуйте позже или нажмите /start",
      );
    }
  } catch (e) {
    // Игнорируем ошибку ответа (например, если юзер забанил бота)
  }
});

// Экспортируем настроенный инстанс
// Запуск (launch) будет производиться в точке входа (server.js/index.js)

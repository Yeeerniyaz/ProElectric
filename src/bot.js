/**
 * @file src/bot.js
 * @description Ядро Telegram-бота (Dispatcher & Router v9.0.0 Enterprise).
 * Выполняет маршрутизацию всех входящих событий, управляет сессиями (FSM)
 * и экспортирует экземпляр бота для интеграции с Express (Web CRM).
 *
 * @module BotCore
 * @version 9.0.1 (Hotfix Config Integration)
 */

import { Telegraf, session } from "telegraf";
import { config } from "./config.js";

// Импорт контроллеров бизнес-логики
import { UserHandler } from "./handlers/UserHandler.js";
import { AdminHandler } from "./handlers/AdminHandler.js";

// =============================================================================
// 1. ИНИЦИАЛИЗАЦИЯ ИНСТАНСА (HOTFIX: Исправлен путь к токену согласно config.js)
// =============================================================================
export const bot = new Telegraf(config.bot.token);

// =============================================================================
// 2. MIDDLEWARES (СЕССИИ И КОНТЕКСТ)
// =============================================================================

// Подключаем хранилище сессий (критично для калькулятора и FSM админа)
bot.use(session());

// Гарантируем, что объект сессии всегда существует, чтобы избежать TypeError
bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {};
  return next();
});

// =============================================================================
// 3. СИСТЕМНЫЕ КОМАНДЫ (COMMANDS)
// =============================================================================

bot.start((ctx) => UserHandler.startCommand(ctx));

// =============================================================================
// 4. МАРШРУТИЗАТОР ТЕКСТОВЫХ КНОПОК (HEARS)
// =============================================================================

// --- Клиентский интерфейс ---
const USER_TRIGGERS = [
  "🚀 Рассчитать стоимость",
  "📂 Мои заявки",
  "💰 Прайс-лист",
  "📞 Контакты",
  "ℹ️ Как мы работаем",
  "🔙 Назад",
  "❌ Отмена",
];
bot.hears(USER_TRIGGERS, (ctx) => UserHandler.handleTextMessage(ctx));

// --- Интерфейс управления (CRM) ---
bot.hears("👑 Админ-панель", (ctx) => AdminHandler.showAdminMenu(ctx));

const ADMIN_TRIGGERS = [
  "📊 Финансовый Отчет",
  "📦 Реестр объектов",
  "⚙️ Настройки цен",
  "👥 Персонал",
  "👨‍💻 SQL Терминал",
  "💾 Дамп базы",
  "🖥 Статус сервера",
  "🔙 В главное меню",
];
bot.hears(ADMIN_TRIGGERS, (ctx) => AdminHandler.handleMessage(ctx));

// =============================================================================
// 5. МАРШРУТИЗАТОР INLINE-КНОПОК (CALLBACK QUERIES)
// =============================================================================

// --- Клиент: Калькулятор и Заказы ---
bot.action(/wall_(gas|brick|concrete)/, (ctx) =>
  UserHandler.handleWallSelection(ctx),
);
bot.action("action_save_order", (ctx) => UserHandler.saveOrderAction(ctx));
bot.action("action_recalc", (ctx) => {
  ctx.answerCbQuery().catch(() => {}); // Гасим часики
  return UserHandler.enterCalculationMode(ctx);
});

// --- Админ: Управление объектами (ERP Controller) ---
bot.action(/status_(\d+)_([a-zA-Z_]+)/, (ctx) => {
  return AdminHandler.handleOrderStatusChange(ctx, ctx.match[1], ctx.match[2]);
});

bot.action(/prompt_cancel_(\d+)/, (ctx) =>
  AdminHandler.promptCancel(ctx, ctx.match[1]),
);

bot.action(/cancel_reason_(\d+)_([a-zA-Z_]+)/, (ctx) => {
  return AdminHandler.processCancelReason(ctx, ctx.match[1], ctx.match[2]);
});

bot.action(/refresh_order_(\d+)/, (ctx) => AdminHandler.findOrder(ctx));

bot.action(/prompt_address_(\d+)/, (ctx) =>
  AdminHandler.promptAddress(ctx, ctx.match[1]),
);

bot.action(/prompt_comment_(\d+)/, (ctx) =>
  AdminHandler.promptComment(ctx, ctx.match[1]),
);

bot.action("admin_refresh_dashboard", (ctx) => AdminHandler.showDashboard(ctx));

// =============================================================================
// 6. ГЛОБАЛЬНЫЙ ПЕРЕХВАТЧИК (SMART INTERCEPTOR)
// =============================================================================

// Перехват отправки номера телефона (Авторизация)
bot.on("contact", (ctx) => UserHandler.handleContact(ctx));

// Умный роутинг любого свободного текста (FSM + Команды)
bot.on("text", async (ctx) => {
  const text = ctx.message.text;

  // 1. Direct Commands (Команды администратора из любой точки)
  if (
    text.startsWith("/order") ||
    text.startsWith("/setprice") ||
    text.startsWith("/setrole") ||
    text.startsWith("/sql")
  ) {
    return AdminHandler.handleMessage(ctx);
  }

  // 2. FSM Admin (Состояния ожидания ввода адреса или комментария)
  if (ctx.session?.adminState && ctx.session.adminState !== "IDLE") {
    return AdminHandler.handleMessage(ctx);
  }

  // 3. FSM User (Состояния ожидания площади или количества комнат)
  if (ctx.session?.state && ctx.session.state !== "IDLE") {
    return UserHandler.handleTextMessage(ctx);
  }
});

// =============================================================================
// 7. ГЛОБАЛЬНАЯ ОБРАБОТКА ОШИБОК (ERROR BOUNDARY)
// =============================================================================

bot.catch((err, ctx) => {
  console.error(
    `[Telegraf Error] Update ID: ${ctx.update.update_id} | Type: ${ctx.updateType}`,
    err,
  );
});

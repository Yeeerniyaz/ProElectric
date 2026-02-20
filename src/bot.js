/**
 * @file src/bot.js
 * @description Ядро Telegram-бота (Dispatcher & Router v10.5.0 Enterprise).
 * Выполняет маршрутизацию всех входящих событий, управляет сессиями (FSM),
 * экспортирует экземпляр бота для Web CRM и управляет инстансом Socket.IO.
 * ИСПРАВЛЕНИЕ: Добавлен триггер для кнопки "Управление Бригадами".
 *
 * @module BotCore
 * @version 10.5.0 (Enterprise ERP Edition)
 */

import { Telegraf, session } from "telegraf";
import { config } from "./config.js";

// Импорт контроллеров бизнес-логики
import { UserHandler } from "./handlers/UserHandler.js";
import { AdminHandler } from "./handlers/AdminHandler.js";
import { BrigadeHandler } from "./handlers/BrigadeHandler.js";

// =============================================================================
// 1. ИНИЦИАЛИЗАЦИЯ ИНСТАНСА
// =============================================================================
export const bot = new Telegraf(config.bot.token);

// =============================================================================
// 2. ИНТЕГРАЦИЯ WEBSOCKET (SOCKET.IO)
// =============================================================================
let ioInstance = null;

/**
 * Внедрение инстанса Socket.IO из server.js для отправки real-time событий из бота.
 */
export const setSocketIO = (io) => {
  ioInstance = io;
  console.log("🔌 [Bot] Socket.IO instance successfully injected.");
};

export const getSocketIO = () => ioInstance;

// =============================================================================
// 3. MIDDLEWARES (СЕССИИ И КОНТЕКСТ)
// =============================================================================

// Подключаем хранилище сессий (критично для калькулятора и FSM)
bot.use(session());

// Гарантируем, что объект сессии всегда существует, чтобы избежать TypeError
bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {};
  return next();
});

// =============================================================================
// 4. СИСТЕМНЫЕ КОМАНДЫ (COMMANDS)
// =============================================================================

bot.start((ctx) => UserHandler.startCommand(ctx));
bot.command("webauth", (ctx) => UserHandler.generateWebOTP(ctx)); // Прямая команда для OTP

// =============================================================================
// 5. МАРШРУТИЗАТОР ТЕКСТОВЫХ КНОПОК (HEARS)
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
  "🔑 Доступ в Web CRM", // Кнопка запроса OTP
];
bot.hears(USER_TRIGGERS, (ctx) => UserHandler.handleTextMessage(ctx));

// --- Интерфейс управления (CRM) ---
bot.hears("👑 Админ-панель", (ctx) => AdminHandler.showAdminMenu(ctx));

// ИСПРАВЛЕНИЕ: Добавлен триггер "🏗 Управление Бригадами"
const ADMIN_TRIGGERS = [
  "📊 Финансовый Отчет",
  "📦 Реестр объектов",
  "🏗 Управление Бригадами",
  "⚙️ Настройки цен",
  "👥 Персонал",
  "👨‍💻 SQL Терминал",
  "💾 Дамп базы",
  "🖥 Статус сервера",
  "🔙 В главное меню",
];
bot.hears(ADMIN_TRIGGERS, (ctx) => AdminHandler.handleMessage(ctx));

// --- Интерфейс Бригадира (ERP) ---
bot.hears("👷 Панель Бригадира", (ctx) => BrigadeHandler.showMenu(ctx));

const BRIGADE_TRIGGERS = [
  "💼 Биржа заказов", // Просмотр статусов 'new'
  "🛠 Мои объекты", // Управление своими заказами
  "💸 Сверка и Выручка", // Инкассация
  "🔙 В главное меню",
];
bot.hears(BRIGADE_TRIGGERS, (ctx) => BrigadeHandler.handleMessage(ctx));

// =============================================================================
// 6. МАРШРУТИЗАТОР INLINE-КНОПОК (CALLBACK QUERIES)
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

// --- Админ: Управление объектами ---
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

// --- Админ: Действия по Инкассации ---
bot.action(/app_inc_(\d+)_([\d.]+)/, (ctx) =>
  AdminHandler.approveIncassation(ctx, ctx.match[1], ctx.match[2]),
);
bot.action(/rej_inc_(\d+)_([\d.]+)/, (ctx) =>
  AdminHandler.rejectIncassation(ctx, ctx.match[1], ctx.match[2]),
);

// --- Бригадир: Действия по объектам и Финансам ---
bot.action(/take_order_(\d+)/, (ctx) =>
  BrigadeHandler.takeOrder(ctx, ctx.match[1]),
);
bot.action(/add_expense_(\d+)/, (ctx) =>
  BrigadeHandler.promptExpense(ctx, ctx.match[1]),
);
bot.action(/finish_order_(\d+)/, (ctx) =>
  BrigadeHandler.finishOrder(ctx, ctx.match[1]),
);
bot.action("start_incassation", (ctx) => BrigadeHandler.promptIncassation(ctx));
bot.action(/refuse_order_(\d+)/, (ctx) =>
  BrigadeHandler.refuseOrder(ctx, ctx.match[1]),
);
bot.action(/prompt_transfer_(\d+)/, (ctx) =>
  BrigadeHandler.promptTransfer(ctx, ctx.match[1]),
);
bot.action(/exec_transfer_(\d+)_(\d+)/, (ctx) =>
  BrigadeHandler.executeTransfer(ctx, ctx.match[1], ctx.match[2]),
);
bot.action(/cancel_transfer_(\d+)/, (ctx) => BrigadeHandler.showMyObjects(ctx)); // Отмена передачи и возврат
bot.action(/set_status_processing_(.+)/, async (ctx) =>
  BrigadeHandler.setOrderStatus(ctx, ctx.match[1], "processing"),
);
bot.action(/set_status_work_(.+)/, async (ctx) =>
  BrigadeHandler.setOrderStatus(ctx, ctx.match[1], "work"),
);
bot.action(/prompt_price_(.+)/, async (ctx) =>
  BrigadeHandler.promptPrice(ctx, ctx.match[1]),
);

// =============================================================================
// 7. ГЛОБАЛЬНЫЙ ПЕРЕХВАТЧИК (SMART INTERCEPTOR)
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
    text.startsWith("/sql") ||
    text.startsWith("/addbrigade")
  ) {
    return AdminHandler.handleMessage(ctx);
  }

  // 2. FSM Admin (Состояния ожидания ввода адреса или комментария)
  if (ctx.session?.adminState && ctx.session.adminState !== "IDLE") {
    return AdminHandler.handleMessage(ctx);
  }

  // 3. FSM Brigade (Состояния ожидания сумм расходов, авансов или инкассации)
  if (ctx.session?.brigadeState && ctx.session.brigadeState !== "IDLE") {
    return BrigadeHandler.handleMessage(ctx);
  }

  // 4. FSM User (Состояния ожидания площади или количества комнат)
  if (ctx.session?.state && ctx.session.state !== "IDLE") {
    return UserHandler.handleTextMessage(ctx);
  }
});

// =============================================================================
// 8. ГЛОБАЛЬНАЯ ОБРАБОТКА ОШИБОК (ERROR BOUNDARY)
// =============================================================================

bot.catch((err, ctx) => {
  console.error(
    `[Telegraf Error] Update ID: ${ctx.update?.update_id} | Type: ${ctx.updateType}`,
    err,
  );
});

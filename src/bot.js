/**
 * @file src/bot.js
 * @description Ядро Telegram-бота (Dispatcher & Router v10.9.23 Enterprise).
 * Выполняет маршрутизацию всех входящих событий, управляет сессиями (FSM),
 * экспортирует экземпляр бота для Web CRM и управляет инстансом Socket.IO.
 * ИСПРАВЛЕНИЕ: Добавлены обработчики инлайн-кнопок для Клиентов (Отмена заказа, пинг шефа).
 * ДОБАВЛЕНО: Глобальный middleware для автоматического трекинга активности (last_active).
 * ДОБАВЛЕНО: Graceful Error Boundary (пользователь получает уведомление при ошибке).
 * НИКАКИХ СОКРАЩЕНИЙ.
 *
 * @module BotCore
 * @version 10.9.23 (Enterprise ERP Edition - Telemetry & Stability)
 */

import { Telegraf, session } from "telegraf";
import { config } from "./config.js";

// Импорт контроллеров бизнес-логики
import { UserHandler } from "./handlers/UserHandler.js";
import { AdminHandler } from "./handlers/AdminHandler.js";
import { BrigadeHandler } from "./handlers/BrigadeHandler.js";
import { UserService } from "./services/UserService.js"; // 🔥 ДОБАВЛЕНО: Для глобального трекинга

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
// 3. MIDDLEWARES (СЕССИИ, КОНТЕКСТ И ТЕЛЕМЕТРИЯ)
// =============================================================================

// Подключаем хранилище сессий (критично для калькулятора и FSM)
bot.use(session());

// Гарантируем, что объект сессии всегда существует, чтобы избежать TypeError
bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {};
  return next();
});

// 🔥 ДОБАВЛЕНО: Глобальный трекинг активности (Telemetry).
// Выполняется асинхронно, не блокируя основной поток (Performance First).
bot.use(async (ctx, next) => {
  if (ctx.from && ctx.from.id) {
    UserService.trackUserActivity(ctx.from.id).catch((err) => {
      console.error(
        `[Telemetry Error] Failed to track activity for ${ctx.from.id}:`,
        err.message,
      );
    });
  }
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

// --- Клиент: Управление своими заказами (НОВОЕ) ---
bot.action(/user_cancel_order_(.+)/, (ctx) =>
  UserHandler.cancelOrderByUser(ctx, ctx.match[1]),
);
bot.action(/user_ping_boss_(.+)/, (ctx) =>
  UserHandler.pingBoss(ctx, ctx.match[1]),
);

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

// --- Админ: Действия по Инкассации и Бригадам ---
bot.action(/app_inc_(\d+)_([\d.]+)/, (ctx) =>
  AdminHandler.approveIncassation(ctx, ctx.match[1], ctx.match[2]),
);
bot.action(/rej_inc_(\d+)_([\d.]+)/, (ctx) =>
  AdminHandler.rejectIncassation(ctx, ctx.match[1], ctx.match[2]),
);
bot.action(/toggle_brigade_(\d+)_(true|false)/, (ctx) =>
  AdminHandler.toggleBrigadeAccess(ctx, ctx.match[1], ctx.match[2]),
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

bot.catch(async (err, ctx) => {
  console.error(
    `🔥 [Telegraf Error] Update ID: ${ctx.update?.update_id} | Type: ${ctx.updateType}`,
    err,
  );

  // 🔥 ДОБАВЛЕНО: Элегантное уведомление пользователя о системной ошибке
  try {
    if (ctx.chat) {
      await ctx.reply(
        "⚠️ <b>Произошла системная ошибка.</b>\nПожалуйста, попробуйте повторить действие позже или напишите /start для перезапуска.",
        { parse_mode: "HTML" },
      );
    }
  } catch (notifyErr) {
    console.error(
      "[Telegraf Error] Failed to notify user about error:",
      notifyErr.message,
    );
  }
});

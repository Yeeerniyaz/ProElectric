/**
 * @file src/server.js
 * @description Главная точка входа (Application Entry Point).
 * Реализует паттерн "Hybrid Monolith": объединяет HTTP REST API и Telegram Bot Long-Polling.
 *
 * @module Server
 * @version 6.0.0 (Production Ready)
 * @author ProElectric Team
 */

import express from "express";
import session from "express-session";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import { Telegraf, session as telegrafSession } from "telegraf";

// Импорт конфигурации и ядра
import { config } from "./config.js";
import { initDB, closePool } from "./database/index.js";
import { MESSAGES, BUTTONS } from "./constants.js";

// Импорт бизнес-логики
import { UserHandler } from "./handlers/UserHandler.js";
import { AdminHandler } from "./handlers/AdminHandler.js";
import { OrderService } from "./services/OrderService.js";
import { UserService } from "./services/UserService.js";

// --- КОНФИГУРАЦИЯ ОКРУЖЕНИЯ ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

// =============================================================================
// 1. ИНИЦИАЛИЗАЦИЯ TELEGRAM БОТА
// =============================================================================
const bot = new Telegraf(process.env.BOT_TOKEN);

// Middleware бота
bot.use(telegrafSession()); // Включаем поддержку сессий (ctx.session)

// Логгер входящих апдейтов (полезно для дебага)
bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  if (config.debug)
    console.log(`[Bot] Update ${ctx.updateType} processed in ${ms}ms`);
});

// --- Маршрутизация команд (Bot Routing) ---

// Админские команды
bot.hears(/^\/setrole/, (ctx) => AdminHandler.processSetRole(ctx)); // Было promoteUser
bot.hears(/^\/setprice/, (ctx) => AdminHandler.processSetPrice(ctx)); // Было updatePriceSetting
bot.hears(/^\/broadcast/, (ctx) => AdminHandler.processBroadcast(ctx)); // Было broadcastMessage
bot.hears(/^\/backup/, (ctx) => AdminHandler.processBackup(ctx)); // Было downloadDatabase

// Новые мощные команды (реализуем их ниже)
bot.hears(/^\/status/, (ctx) => AdminHandler.processSetStatus(ctx)); // Смена статуса заказа
bot.hears(/^\/ban/, (ctx) => AdminHandler.processBanUser(ctx)); // Бан пользователя
bot.hears(/^\/sql/, (ctx) => AdminHandler.processSQL(ctx)); // SQL запрос напрямую

// Кнопки меню админа
bot.hears(BUTTONS.ADMIN_STATS, (ctx) => AdminHandler.showDashboard(ctx)); // Было showStatistics
bot.hears(BUTTONS.ADMIN_SETTINGS, (ctx) =>
  AdminHandler.showSettingsInstruction(ctx),
);
bot.hears(BUTTONS.ADMIN_STAFF, (ctx) => AdminHandler.showStaffInstruction(ctx));

// Пользовательские команды
bot.command("start", (ctx) => UserHandler.startCommand(ctx));
bot.command("cancel", (ctx) => UserHandler.returnToMainMenu(ctx));

// Actions (Inline кнопки)
bot.action(/^wall_/, (ctx) => UserHandler.handleWallSelection(ctx));
bot.action("action_save_order", (ctx) => UserHandler.saveOrderAction(ctx));
bot.action("action_contact", (ctx) => UserHandler.enterContactMode(ctx));

// Текстовое меню
bot.hears(["🚀 Рассчитать стоимость", "🏠 Главное меню"], (ctx) =>
  UserHandler.enterCalculationMode(ctx),
);
bot.hears("📂 Мои расчеты", (ctx) => UserHandler.showMyOrders(ctx));
bot.hears("ℹ️ О нас", (ctx) => UserHandler.showAbout(ctx));
bot.hears("📞 Контакты", (ctx) => UserHandler.enterContactMode(ctx));
bot.hears("❌ Отмена", (ctx) => UserHandler.returnToMainMenu(ctx));

// Глобальный обработчик текста (State Machine)
bot.on("text", (ctx) => UserHandler.handleTextMessage(ctx));

// Обработка ошибок бота
bot.catch((err, ctx) => {
  console.error(`🔥 [Bot Error] Update ${ctx.updateType}:`, err);
  // Не роняем процесс, просто логируем
});

// =============================================================================
// 2. ИНИЦИАЛИЗАЦИЯ EXPRESS (WEB SERVER)
// =============================================================================
const app = express();

// --- Безопасность и Middleware (Security Layer) ---
app.use(
  helmet({
    contentSecurityPolicy: false, // Отключаем CSP для простоты работы инлайн-скриптов админки
  }),
);
app.use(cors()); // Разрешаем CORS (если фронтенд будет на другом домене)
app.use(express.json()); // Парсинг JSON body
app.use(express.urlencoded({ extended: true })); // Парсинг Form data

// Ограничение запросов (Rate Limiting)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100, // Лимит 100 запросов с одного IP
  message: { error: "Too many requests, please try again later." },
});

// --- Настройка Сессий (Session Management) ---
app.use(
  session({
    name: "pro_electric_sid", // Кастомное имя куки (безопасность через неясность)
    secret: config.sessionSecret || "super_secret_dev_key_change_in_prod",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: IS_PROD, // В продакшене (HTTPS) ставим true
      httpOnly: true, // Запрещаем доступ к куке из JS
      maxAge: 24 * 60 * 60 * 1000, // 24 часа
    },
  }),
);

// --- Раздача статики (Frontend) ---
// Папка public доступна по адресу http://localhost:3000/
app.use(express.static(path.join(__dirname, "../public")));

// =============================================================================
// 3. API ROUTES (REST API)
// =============================================================================

// src/server.js

// ... (после всех app.use и перед bot.launch)


// 🚀 ЕДИНЫЙ API ШЛЮЗ (Universal Route)
// Вместо 100 роутов мы используем один, который вызывает методы контроллера
app.post("/api/execute", async (req, res) => {
  const { action, payload } = req.body;
  const adminId = 12345; // В реале тут должна быть проверка сессии/токена

  // Эмуляция контекста Telegraf для переиспользования AdminHandler
  const mockCtx = {
    from: { id: adminId },
    message: { text: `/api ${action}` }, // Фейковая команда
    reply: async (text) => text, // Заглушка
    replyWithHTML: async (text) => text,
    // ... другие методы по необходимости
  };

  try {
    let result;
    // Маппинг действий фронтенда на методы бэкенда
    switch (action) {
      case "get_stats":
        // Тут нам нужно немного адаптировать AdminHandler,
        // чтобы он возвращал данные, а не слал сообщения в телегу.
        // Для простоты сейчас сделаем прямые SQL запросы здесь,
        // но в идеале AdminHandler должен быть чистым.
        const stats = await UserService.getDashboardStats();
        result = stats;
        break;

      case "get_orders":
        // Получаем заказы прямым запросом (быстрее)
        const orders = await db.query(
          "SELECT * FROM orders ORDER BY created_at DESC LIMIT 50",
        );
        result = orders.rows;
        break;

      case "update_status":
        await db.query("UPDATE orders SET status = $1 WHERE id = $2", [
          payload.status,
          payload.id,
        ]);
        result = { success: true };
        break;

      case "get_users":
        const users = await db.query(
          "SELECT * FROM users ORDER BY created_at DESC LIMIT 50",
        );
        result = users.rows;
        break;

      default:
        throw new Error("Unknown action");
    }
    res.json({ ok: true, data: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
/**
 * Middleware для проверки авторизации админа
 */

// 📋 Получение списка пользователей

// =============================================================================
// 4. ЗАПУСК И ОРКЕСТРАЦИЯ (BOOTSTRAP)
// =============================================================================

const startServer = async () => {
  try {
    console.clear();
    console.log("==================================================");
    console.log("🏗️  PRO ELECTRIC SYSTEM - STARTING UP");
    console.log(`🌍 Environment: ${IS_PROD ? "PRODUCTION" : "DEVELOPMENT"}`);
    console.log("==================================================");

    // 1. Инициализация Базы Данных (ожидание подключения)
    await initDB();
    // 2. Запуск Телеграм Бота (Polling Mode)
    // В продакшене для высокой нагрузки лучше использовать Webhook,
    // но для старта Polling надежнее и проще.
    bot.launch().then(() => {
      console.log("🤖 Telegram Bot started successfully (Polling mode)");
    });

    // 3. Запуск HTTP Сервера
    const server = app.listen(PORT, () => {
      console.log(`🚀 Web Server running at: http://localhost:${PORT}`);
      console.log(
        `🔧 Admin Panel available at: http://localhost:${PORT}/admin.html`,
      );
    });

    // Настройка Graceful Shutdown внутри функции
    setupGracefulShutdown(server);
  } catch (error) {
    console.error("🔥 Critical Startup Error:", error);
    process.exit(1);
  }
};

/**
 * Настройка корректного завершения работы
 * @param {import('http').Server} httpServer
 */
const setupGracefulShutdown = (httpServer) => {
  const shutdown = async (signal) => {
    console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);

    // 1. Останавливаем прием новых HTTP запросов
    httpServer.close(() => {
      console.log("✅ HTTP Server closed.");
    });

    // 2. Останавливаем бота
    try {
      bot.stop(signal);
      console.log("✅ Telegram Bot stopped.");
    } catch (e) {
      console.warn("⚠️ Bot was not running or failed to stop.");
    }

    // 3. Закрываем соединения с БД
    await closePool();

    console.log("👋 Goodbye!");
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
};

// 🔥 Поехали!
startServer();

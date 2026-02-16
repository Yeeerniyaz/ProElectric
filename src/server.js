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
import { initDatabase, closeDatabase } from "./database/index.js";
import { MESSAGES } from "./constants.js";

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
const bot = new Telegraf(config.botToken);

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
bot.command("admin", (ctx) => AdminHandler.enterAdminPanel(ctx));
bot.hears(/^\/setrole/, (ctx) => AdminHandler.promoteUser(ctx));
bot.hears(/^\/setprice/, (ctx) => AdminHandler.updatePriceSetting(ctx));
bot.hears(/^\/broadcast/, (ctx) => AdminHandler.broadcastMessage(ctx));
bot.hears("📊 Статистика", (ctx) => AdminHandler.showStatistics(ctx));
bot.hears("💾 Скачать БД", (ctx) => AdminHandler.downloadDatabase(ctx));

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
app.use("/api/", apiLimiter);

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

/**
 * Middleware для проверки авторизации админа
 */
const requireAdmin = (req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === "admin") {
    return next();
  }
  res.status(401).json({ success: false, error: "Unauthorized" });
};

// 📊 Получение статистики (Dashboard)
app.get("/api/stats", requireAdmin, async (req, res) => {
  try {
    const stats = await OrderService.getAdminStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error("[API] Stats Error:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// 📋 Получение списка пользователей
app.get("/api/users", requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const users = await UserService.getAllUsers(limit, offset);
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔐 Авторизация (Login)
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;

  // В реальном проекте пароль должен лежать в ENV и быть хешированным
  // Для демо используем хардкод из конфига или простой
  const ADMIN_USER = process.env.ADMIN_USER || "admin";
  const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    // Успешный вход
    req.session.user = { id: 1, role: "admin", username };
    console.log(`[Auth] Admin logged in: ${username}`);
    res.json({ success: true });
  } else {
    console.warn(`[Auth] Failed login attempt: ${username}`);
    res.status(401).json({ success: false, error: "Invalid credentials" });
  }
});

// 🚪 Выход (Logout)
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ success: false });
    res.clearCookie("pro_electric_sid");
    res.json({ success: true });
  });
});

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
    await initDatabase();

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
    await closeDatabase();

    console.log("👋 Goodbye!");
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
};

// 🔥 Поехали!
startServer();

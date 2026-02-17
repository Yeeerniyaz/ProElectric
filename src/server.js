/**
 * @file src/server.js
 * @description Главная точка входа в приложение (Application Bootstrapper).
 * Отвечает за оркестрацию запуска сервисов: Database -> Web Server -> Telegram Bot.
 * Реализует Graceful Shutdown для безопасной остановки в Docker/Kubernetes.
 *
 * @module Server
 * @version 6.3.0 (Production Ready)
 * @author ProElectric Team
 */

import http from "http";
import { config } from "./config.js";
import * as db from "./database/index.js";

// Импортируем настроенные экземпляры сервисов
import app from "./app.js"; // Express App (без вызова .listen)
import { bot } from "./bot.js"; // Telegraf Bot (без вызова .launch)

// =============================================================================
// 🔧 PROCESS CONFIGURATION
// =============================================================================

const PORT = config.server.port || 3000;
const IS_PROD = config.system.isProduction;

// Перехват необработанных ошибок (Global Exception Handlers)
process.on("uncaughtException", (err) => {
  console.error("🔥 FATAL: Uncaught Exception:", err);
  // В продакшене здесь стоит отправлять алерт в Sentry
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "🔥 FATAL: Unhandled Rejection at:",
    promise,
    "reason:",
    reason,
  );
});

// =============================================================================
// 🚀 BOOTSTRAP LOGIC
// =============================================================================

/**
 * Основная функция запуска системы.
 * Выполняет инициализацию в строгом порядке зависимостей.
 */
const bootstrap = async () => {
  console.log(
    `\n🚀 Starting ProElectric System [${IS_PROD ? "PROD" : "DEV"}]...`,
  );

  let server;

  try {
    // 1. Инициализация Базы Данных
    // Приложение не должно стартовать, если БД недоступна
    console.log("⏳ Connecting to Database...");
    await db.initDB();
    console.log("✅ Database connected successfully.");

    // 2. Запуск HTTP Сервера
    // Создаем нативный HTTP сервер, оборачивая Express, для гибкого управления
    server = http.createServer(app);

    await new Promise((resolve, reject) => {
      server.listen(PORT, () => {
        console.log(`🌍 Web Server is running on port: ${PORT}`);
        console.log(`🔧 Admin Panel: http://localhost:${PORT}/admin.html`);
        console.log(`📡 API Health: http://localhost:${PORT}/api/auth/check`);
        resolve();
      });
      server.on("error", reject);
    });

    // 3. Запуск Telegram Бота
    // Используем Webhook в проде (если настроен) или Long Polling в деве
    console.log("⏳ Launching Telegram Bot...");

    // В будущем здесь можно добавить логику webhook'а:
    // if (IS_PROD) await bot.createWebhook({ domain: config.bot.webhookDomain ... });
    // else await bot.launch();

    await bot.launch(() => {
      console.log(`🤖 Telegram Bot is online (@${bot.botInfo?.username})`);
    });

    // 4. Финализация
    console.log("\n✅ SYSTEM IS FULLY OPERATIONAL 🚀\n");

    // Навешиваем обработчики завершения
    setupGracefulShutdown(server);
  } catch (error) {
    console.error("\n❌ CRITICAL STARTUP ERROR:");
    console.error(error);

    // Пытаемся закрыть пул БД, если он успел открыться
    try {
      await db.closePool();
    } catch (e) {}

    process.exit(1);
  }
};

// =============================================================================
// 🛑 GRACEFUL SHUTDOWN
// =============================================================================

/**
 * Корректное завершение работы.
 * Важно для сохранения данных и отсутствия 502 ошибок при деплое.
 * * @param {http.Server} server - Экземпляр HTTP сервера
 */
const setupGracefulShutdown = (server) => {
  const shutdown = async (signal) => {
    console.log(`\n🛑 Received signal: ${signal}. Shutting down gracefully...`);

    // Таймер принудительного убийства (если что-то зависнет)
    const forceExitTimer = setTimeout(() => {
      console.error("⚠️ Force shutdown due to timeout (10s).");
      process.exit(1);
    }, 10000);

    try {
      // 1. Останавливаем прием новых HTTP соединений
      if (server) {
        await new Promise((resolve) => server.close(resolve));
        console.log("💤 HTTP Server closed.");
      }

      // 2. Останавливаем Бота
      bot.stop(signal);
      console.log("💤 Telegram Bot stopped.");

      // 3. Закрываем соединения с БД
      await db.closePool();
      console.log("💤 Database pool closed.");

      console.log("✅ Goodbye.");
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (err) {
      console.error("⚠️ Error during graceful shutdown:", err);
      process.exit(1);
    }
  };

  // Перехват сигналов ОС
  process.once("SIGTERM", () => shutdown("SIGTERM")); // Docker stop
  process.once("SIGINT", () => shutdown("SIGINT")); // Ctrl+C
};

// =============================================================================
// ▶️ EXECUTION
// =============================================================================

bootstrap();

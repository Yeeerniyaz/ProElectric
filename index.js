import { initDB } from "./src/db.js";
import { initBot } from "./src/bot.js";
import { startServer } from "./src/server.js";
import { config } from "./src/config.js";

/**
 * 🔥 ГЛАВНАЯ ТОЧКА ВХОДА PROELECTRO
 */
async function bootstrap() {
  console.clear();
  console.log("========================================");
  console.log("🔌  P R O E L E C T R O   S Y S T E M  ");
  console.log("========================================");
  console.log(`🌍 Environment: ${config.server.env}`);
  console.log("⏳ Запуск систем...");

  try {
    // 1. БАЗА ДАННЫХ
    // Сначала подключаем БД, так как без нее бот бесполезен
    await initDB();

    // 2. WEB DASHBOARD (Админка)
    // Запускаем сервер для Portainer Healthcheck и админов
    startServer();

    // 3. TELEGRAM BOT
    // Запускаем логику и полинг
    await initBot();

    console.log("\n✅ [SYSTEM] ВСЕ СИСТЕМЫ В НОРМЕ. ГОТОВ К РАБОТЕ!");
    console.log("========================================\n");

    // --- Graceful Shutdown (Мягкое завершение) ---
    // Это нужно, чтобы Docker корректно останавливал бота при обновлении
    const shutdown = (signal) => {
      console.log(`\n🛑 [${signal}] Получен сигнал остановки.`);
      console.log("💤 Завершаем процессы...");
      // Тут можно добавить закрытие пула БД: await pool.end();
      console.log("👋 До свидания!");
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    console.error("\n💥 [SYSTEM FATAL] КРИТИЧЕСКИЙ СБОЙ ПРИ ЗАПУСКЕ:");
    console.error(error);
    process.exit(1);
  }
}

// Глобальный перехват необработанных ошибок (чтобы контейнер не падал молча)
process.on("uncaughtException", (err) => {
  console.error("🔥 [FATAL] Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "🔥 [FATAL] Unhandled Rejection at:",
    promise,
    "reason:",
    reason,
  );
});

// Поехали!
bootstrap();

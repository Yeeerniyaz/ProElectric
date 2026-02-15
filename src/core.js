import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";

// Инициализация бота
export const bot = new TelegramBot(config.bot.token, { polling: false });
// Polling запускаем вручную в bot.js, здесь только инстанс

// ============================================================
// 🛡 ГЛОБАЛЬНЫЙ ПЕРЕХВАТ ОШИБОК (SAFETY NET)
// ============================================================

// Если промис упал и никто его не поймал
process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 [FATAL] Unhandled Rejection:", reason);
  // Не выходим из процесса, чтобы бот жил
});

// Если произошла критическая ошибка в коде
process.on("uncaughtException", (error) => {
  console.error("🔥 [FATAL] Uncaught Exception:", error);
});

console.log("✅ [CORE] Система защиты активирована.");

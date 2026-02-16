import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";

// 🔥 ИСПРАВЛЕНИЕ: Включаем polling прямо здесь
export const bot = new TelegramBot(config.bot.token, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10 }
    }
});

// ============================================================
// 🛡 ГЛОБАЛЬНЫЙ ПЕРЕХВАТ ОШИБОК
// ============================================================

process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 [FATAL] Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("🔥 [FATAL] Uncaught Exception:", error);
});

console.log("✅ [CORE] Ядро запущено (Polling включен).");
/**
 * @file src/core.js
 * @description Ядро бота (Core Instance).
 * Инициализирует TelegramBot, настраивает Polling и глобальные перехватчики ошибок.
 * @module Core
 */

import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";

// =============================================================================
// 🤖 ИНИЦИАЛИЗАЦИЯ БОТА
// =============================================================================

console.log(`🔄 [CORE] Запуск бота в режиме: ${config.system.env.toUpperCase()}...`);

export const bot = new TelegramBot(config.bot.token, { 
    polling: {
        interval: 300,      // Проверка обновлений каждые 300мс
        autoStart: true,    // Авто-старт
        params: { 
            timeout: 10     // Long-polling таймаут (сек)
        }
    }
});

// =============================================================================
// 🛡 ОБРАБОТКА ОШИБОК (ERROR HANDLING)
// =============================================================================

// 1. Ошибки Polling (Связь с Telegram)
// Важно: не даем процессу упасть из-за ETIMEDOUT или обрыва сети
bot.on('polling_error', (error) => {
    // Игнорируем штатные разрывы соединения
    if (error.code === 'EFATAL' || error.code === 'ETIMEDOUT' || error.message.includes('ECONNRESET')) {
        // Тихое логирование, чтобы не спамить в консоль
        // console.warn(`⚠️ [BOT NET] ${error.code}: Переподключение...`);
    } else {
        console.error(`❌ [BOT ERROR] ${error.message}`);
    }
});

// 2. Глобальные необработанные ошибки (Promise Rejection)
process.on("unhandledRejection", (reason, promise) => {
    console.error("🔥 [FATAL] Unhandled Rejection at:", promise, "reason:", reason);
    // В продакшене здесь можно слать алерт в Sentry или админу в ЛС
});

// 3. Глобальные критические ошибки
process.on("uncaughtException", (error) => {
    console.error("🔥 [FATAL] Uncaught Exception:", error);
    // При критической ошибке лучше перезагрузить процесс (Docker это сделает сам при exit 1)
    process.exit(1); 
});

// =============================================================================
// 🛑 GRACEFUL SHUTDOWN (Мягкое выключение)
// =============================================================================

const shutdown = (signal) => {
    console.log(`\n🔻 [CORE] Получен сигнал ${signal}. Остановка бота...`);
    bot.stopPolling();
    console.log("✅ [CORE] Бот остановлен. Bye!");
    process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C
process.once('SIGTERM', () => shutdown('SIGTERM')); // Docker stop

console.log(`✅ [CORE] Ядро активно. Бот: @${config.bot.username}`);
/**
 * @file index.js
 * @description Точка входа в приложение (Entry Point).
 * Запускает подключение к БД и инициализирует Бота.
 * @author Senior Architect
 */

import { initDB } from "./src/db.js";
import { initBot } from "./src/bot.js";
import { config } from "./src/config.js";

// Глобальная обработка выхода (Ctrl+C, Docker stop)
const handleExit = (signal) => {
    console.log(`\n🛑 [SYSTEM] Получен сигнал ${signal}. Завершение работы...`);
    process.exit(0);
};

process.on('SIGINT', handleExit);
process.on('SIGTERM', handleExit);

async function bootstrap() {
    // Очистка консоли для красивого старта
    console.clear();
    console.log("\n==================================================");
    console.log("⚡️  P R O E L E C T R O   B O T   v 8 . 0  ⚡️");
    console.log("==================================================");
    console.log(`🌍 Environment: ${config.system.env}`);
    console.log(`📅 Started at:  ${new Date().toLocaleString()}`);
    console.log("--------------------------------------------------");

    try {
        // 1. Инициализация Базы Данных (Миграции + Подключение)
        console.log("📦 [1/2] Подключение к Базе Данных...");
        await initDB();

        // 2. Запуск Телеграм Бота (Polling)
        console.log("🤖 [2/2] Запуск Bot API...");
        await initBot();

        console.log("\n✅ [SYSTEM] СИСТЕМА УСПЕШНО ЗАПУЩЕНА!");
        console.log("==================================================\n");

        // Уведомление Владельцу о старте (если настроен ID)
        if (config.bot.ownerId) {
            // Импортируем бота динамически, чтобы избежать циклических зависимостей при старте
            const { bot } = await import('./src/core.js');
            bot.sendMessage(config.bot.ownerId, "🚀 <b>Бот перезапущен и готов к работе!</b>", { parse_mode: "HTML" })
               .catch(() => {}); // Игнорируем ошибку, если лс не начат
        }

    } catch (error) {
        console.error("\n💥 [SYSTEM FATAL] КРИТИЧЕСКИЙ СБОЙ ПРИ ЗАПУСКЕ:");
        console.error(error);
        process.exit(1);
    }
}

// Поехали! 🚀
bootstrap();
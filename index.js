import { initDB, db } from './src/db.js';
// В твоем коде используется либо src/bot.js, либо src/core.js. 
// Согласно последней структуре, мы используем initBot.
import { initBot } from './src/bot.js'; 
import { startServer } from './src/server.js';

/**
 * Главная точка входа в систему ProElectro
 */
async function bootstrap() {
    try {
        console.log('🔌 [SYSTEM] Подключаем питание к системе...');
        
        // 1. Инициализация базы данных (Ждем, пока "прогреется")
        await initDB();
        
        // 2. Запуск логики Telegram-бота
        initBot();
        
        // 3. Запуск веб-сервера для Portainer Healthcheck
        startServer();
        
        console.log('⚡️ [SYSTEM] Система в сети. Напряжение в норме, ждем лиды!');

        // --- Graceful Shutdown (Мягкое завершение) ---
        const shutdown = async (signal) => {
            console.log(`\n🛑 [${signal}] Получен сигнал на отключение. Гасим систему...`);
            
            // Здесь можно добавить логику уведомления админа перед выключением
            // await bot.sendMessage(config.bot.bossUsername, "⚠️ Сервер ProElectro уходит на перезагрузку.");
            
            process.exit(0);
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

    } catch (error) {
        console.error('💥 [SYSTEM FATAL] Фатальное замыкание при старте:', error.message);
        process.exit(1);
    }
}

// Поехали!
bootstrap();
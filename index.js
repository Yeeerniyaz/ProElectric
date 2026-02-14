import { initDB } from './src/db.js';
import { startServer } from './src/server.js';
import { setupMessageHandlers } from './src/handlers/messages.js';
import { setupCallbackHandlers } from './src/handlers/callbacks.js';

async function bootstrap() {
    try {
        console.log('🔌 Подключаем питание к системе...');
        
        // 1. Инициализация базы данных
        await initDB();
        
        // 2. Запуск веб-админки
        startServer();
        
        // 3. Запуск логики Telegram-бота
        setupMessageHandlers();
        setupCallbackHandlers();
        
        console.log('⚡️ Система в сети. Напряжение в норме, ждем лиды!');
    } catch (error) {
        console.error('💥 Фатальное замыкание при старте:', error);
        process.exit(1);
    }
}

bootstrap();
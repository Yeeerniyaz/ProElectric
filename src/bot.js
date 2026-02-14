import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js'; // Тянем чистый конфиг без посредников
import { setupMessageHandlers } from './handlers/messages.js';
import { setupCallbackHandlers } from './handlers/callbacks.js';

/**
 * Инициализация экземпляра бота.
 * Senior-подход: использование Polling с параметрами для стабильности в Docker.
 */
const bot = new TelegramBot(config.bot.token, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

/**
 * Функция запуска всей логики бота.
 * Мы вызываем её в index.js после того, как убедимся, что база данных "под напряжением".
 */
export const initBot = () => {
    try {
        console.log('🤖 [BOT] Инициализация обработчиков...');
        
        // Регистрируем текстовые команды и работу с контактами
        setupMessageHandlers();
        
        // Регистрируем логику кнопок и калькулятора
        setupCallbackHandlers();

        console.log('✅ [BOT] Все системы активны. Бот готов принимать заказы!');
    } catch (error) {
        console.error('💥 [BOT FATAL] Ошибка при запуске логики:', error.message);
        throw error;
    }
};

// Глобальный перехват ошибок Telegram API, чтобы бот не "падал" тихо
bot.on('polling_error', (error) => {
    console.error(`⚠️ [POLLING ERROR] Код: ${error.code}. Сообщение: ${error.message}`);
});

export { bot };
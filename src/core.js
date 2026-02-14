import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';

/**
 * Инициализация экземпляра бота.
 * Мы используем Polling для простоты деплоя в Docker на начальном этапе.
 */
export const bot = new TelegramBot(config.bot.token, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

// Логируем успешный запуск "двигателя"
console.log('🚀 [CORE] Бот ProElectro успешно инициализирован.');

/**
 * Глобальный обработчик ошибок Polling.
 * Senior-подход: не даем боту тихо "упасть" при проблемах с сетью.
 */
bot.on('polling_error', (error) => {
    console.error(`⚠️ [POLLING ERROR] Код: ${error.code}. Сообщение: ${error.message}`);
});
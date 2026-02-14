import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';

export const bot = new TelegramBot(config.bot.token, { 
    polling: {
        autoStart: false, 
        
        interval: 300, // Проверять новые сообщения каждые 300мс
        params: { 
            timeout: 10 // Длинный опрос (Long Polling) на 10 сек
        }
    }
});

console.log('🤖 [CORE] Ядро бота инициализировано (режим ожидания).');
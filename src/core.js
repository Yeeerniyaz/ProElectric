import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';

// Инициализируем бота с включенным автоматическим опросом
export const bot = new TelegramBot(config.bot.token, { 
    polling: {
        autoStart: true, // Включаем, чтобы бот начал слушать сразу
        interval: 300, 
        params: { 
            timeout: 10 
        }
    }
});

console.log('🤖 [CORE] Ядро бота инициализировано и запущено (Polling: ON).');
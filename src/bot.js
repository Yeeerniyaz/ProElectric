/**
 * @file src/bot.js
 * @description Инициализация Telegram бота.
 * Исправлена работа Polling и Webhook.
 */

import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import { setupAuthHandlers } from './handlers/auth.js';
import { setupMessageHandlers } from './handlers/messages.js';
import { setupCallbackHandlers } from './handlers/callbacks.js';

// Polling параметрлерін күшейтеміз
export const bot = new TelegramBot(config.bot.token, { 
    polling: {
        interval: 300,      // Жиі тексереміз
        autoStart: true,
        params: { timeout: 10 }
    }
});

export const initBot = async () => {
    console.log('🤖 [BOT] Инициализация...');

    // Webhook қатесін болдырмау үшін try-catch
    try {
        await bot.deleteWebHook();
        console.log('🧹 [BOT] Вебхук тазаланды.');
    } catch (e) {
        // Егер вебхук болмаса, қате емес
    }

    // Хендлерлерді қосу
    setupMessageHandlers();
    setupCallbackHandlers();
    setupAuthHandlers();

    // Каналдарды қолдау
    bot.on('channel_post', (msg) => {
        bot.emit('message', msg);
    });

    // Қателерден құлап қалмау
    bot.on('polling_error', (error) => {
        if (error.code !== 'EFATAL' && error.code !== 'ETIMEDOUT') {
            console.error(`⚠️ [BOT] Polling: ${error.message}`);
        }
    });

    console.log('✅ [BOT] Система активна!');
};
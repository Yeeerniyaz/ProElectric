/**
 * @file src/bot.js
 * @description Инициализация Telegram бота.
 * Исправлена ошибка 'deleteWebhook is not a function'.
 */

import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import { setupAuthHandlers } from './handlers/auth.js';
import { setupMessageHandlers } from './handlers/messages.js';
import { setupCallbackHandlers } from './handlers/callbacks.js';

export const bot = new TelegramBot(config.bot.token, { polling: true });

export const initBot = async () => {
    console.log('🤖 [BOT] Инициализация подсистем...');

    // 🔥 ТҮЗЕТІЛДІ: deleteWebHook (Webhook емес WebHook)
    try {
        await bot.deleteWebHook();
        console.log('🧹 [BOT] Вебхук успешно очищен.');
    } catch (e) {
        // Егер бұрын вебхук болмаса, қате шығуы қалыпты, елемейміз
    }

    setupMessageHandlers();
    setupCallbackHandlers();
    setupAuthHandlers();

    // Каналдарды қолдау
    bot.on('channel_post', (msg) => {
        bot.emit('message', msg);
    });

    // Қателерді сүзу
    bot.on('polling_error', (error) => {
        if (error.code !== 'EFATAL' && error.code !== 'ETIMEDOUT') {
            console.error(`💥 [BOT ERROR] ${error.code}: ${error.message}`);
        }
    });

    console.log('✅ [BOT] Система активна и принимает команды (в т.ч. из каналов).');
};
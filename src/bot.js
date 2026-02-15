/**
 * @file src/bot.js
 * @description Инициализация Telegram бота и регистрации обработчиков.
 * Добавлена поддержка каналов (channel_post).
 */

import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import { setupAuthHandlers } from './handlers/auth.js';
import { setupMessageHandlers } from './handlers/messages.js';
import { setupCallbackHandlers } from './handlers/callbacks.js';

// 1. Создаем бота (Polling қосулы)
export const bot = new TelegramBot(config.bot.token, { polling: true });

export const initBot = async () => {
    console.log('🤖 [BOT] Инициализация подсистем...');

    // 2. Вебхукты тазалау (Polling дұрыс істеуі үшін)
    try {
        await bot.deleteWebhook();
        console.log('🧹 [BOT] Вебхук успешно очищен.');
    } catch (e) {
        console.warn('⚠️ [BOT] Ошибка очистки вебхука:', e.message);
    }

    // 3. Хендлерлерді қосу
    setupAuthHandlers();
    setupMessageHandlers();
    setupCallbackHandlers();

    // 4. 🔥 КАНАЛДАРДЫ ҚОЛДАУ (Осы жер жаңа)
    // Каналға жазған кезде 'channel_post' оқиғасы болады, біз оны 'message' деп қабылдаймыз
    bot.on('channel_post', (msg) => {
        bot.emit('message', msg);
    });
    
    // 5. Лог ошибок
    bot.on('polling_error', (error) => {
        if (error.code !== 'EFATAL' && error.code !== 'ETIMEDOUT') {
             console.error(`💥 [BOT ERROR] ${error.code}: ${error.message}`);
        }
    });

    console.log('✅ [BOT] Система активна и принимает команды (в т.ч. из каналов).');
};
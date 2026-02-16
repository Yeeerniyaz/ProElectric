/**
 * @file src/bot.js
 * @description Настройка обработчиков событий.
 */

// 🔥 ИСПРАВЛЕНИЕ: Импортируем бота из core.js, а не создаем нового
import { bot } from './core.js'; 
import { setupAuthHandlers } from './handlers/auth.js';
import { setupMessageHandlers } from './handlers/messages.js';
import { setupCallbackHandlers } from './handlers/callbacks.js';

export const initBot = async () => {
    console.log('🤖 [BOT] Подключение логики...');

    // Очистка вебхуков (важно при переходе на polling)
    try {
        await bot.deleteWebHook();
        console.log('🧹 [BOT] Вебхук сброшен (переход на polling).');
    } catch (e) {
        console.error('⚠️ Ошибка сброса вебхука:', e.message);
    }

    // Подключаем логику (Хендлеры)
    setupMessageHandlers();
    setupCallbackHandlers();
    setupAuthHandlers();

    // Обработка постов в каналах
    bot.on('channel_post', (msg) => {
        bot.emit('message', msg);
    });

    // Логирование ошибок polling
    bot.on('polling_error', (error) => {
        if (error.code !== 'EFATAL' && error.code !== 'ETIMEDOUT') {
            console.error(`⚠️ [BOT] Ошибка связи: ${error.message}`);
        }
    });

    console.log('✅ [BOT] Логика подключена и работает!');
};
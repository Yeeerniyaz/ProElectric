/**
 * @file src/bot.js
 * @description Оркестратор хендлеров и цикла обновлений.
 */

import { bot } from './core.js';
import { setupAuthHandlers } from './handlers/auth.js';
import { setupAdminHandlers } from './handlers/admin.js';
import { setupCallbackHandlers } from './handlers/callbacks.js';
import { setupMessageHandlers } from './handlers/messages.js';

export const initBot = async () => {
    console.log('🤖 [BOT] Регистрация модулей...');

    // 1. Очистка старых соединений (Critical!)
    try {
        await bot.deleteWebHook();
    } catch (e) {
        console.warn('⚠️ [BOT] Webhook cleanup failed.');
    }

    // 2. Регистрация хендлеров (ПОРЯДОК ВАЖЕН)
    setupAuthHandlers();     // Проверка прав
    setupAdminHandlers();    // Админ-команды
    setupCallbackHandlers(); // Кнопки
    setupMessageHandlers();  // Текстовые команды и визарды

    // 3. ЗАПУСК ЦИКЛА ПРИЕМА КОМАНД
    // Без этого метода бот будет молчать
    bot.startPolling({
        restart: true,
        params: { timeout: 10 }
    });

    console.log('✅ [BOT] Бот запущен и слушает команды!');
};
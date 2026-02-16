import { bot } from './core.js';
import { setupAuthHandlers } from './handlers/auth.js';
import { setupAdminHandlers } from './handlers/admin.js';
import { setupCallbackHandlers } from './handlers/callbacks.js';
import { setupMessageHandlers } from './handlers/messages.js';

export const initBot = async () => {
    console.log('🤖 [BOT] Регистрация модулей...');

    // 1. Очистка старых соединений
    await bot.deleteWebHook().catch(() => {});

    // 2. Регистрация логики (ПОРЯДОК ВАЖЕН)
    setupAuthHandlers();     // Проверка прав
    setupAdminHandlers();    // Админка
    setupCallbackHandlers(); // Кнопки
    setupMessageHandlers();  // Команды (Рассчитать, Старт и т.д.)

    // 3. ВКЛЮЧАЕМ ПРИЕМ СООБЩЕНИЙ
    bot.startPolling({ restart: true });

    console.log('🚀 [BOT] Бот запущен и слушает команды!');
};
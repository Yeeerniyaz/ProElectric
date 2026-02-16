/**
 * @file src/core.js
 * @description Ядро системы. Исправлен экспорт и контекст EventEmitter.
 * @version 6.2.0 (Stable Export)
 */

import TelegramBot from 'node-telegram-bot-api';
import { EventEmitter } from 'events';
import { config } from './config.js';

// ПРОВЕРКА КОНФИГУРАЦИИ
if (!config.bot?.token) {
    throw new Error('SYSTEM_HALT: BOT_TOKEN is missing in config.');
}

console.log(`🏗 [CORE] Инициализация Engine... Окружение: ${config.system.env}`);

/**
 * ИНИЦИАЛИЗАЦИЯ ИНСТАНСА
 * Мы экспортируем 'bot' как константу (Named Export), чтобы 'auth.js' мог его найти.
 */
export const bot = new TelegramBot(config.bot.token, {
    polling: false, // Управляется контроллером в src/bot.js
    request: {
        agentOptions: {
            keepAlive: true,
            maxSockets: 50
        }
    }
});

/**
 * FIX: bot.setMaxListeners is not a function
 * Принудительно вызываем метод базового класса EventEmitter в контексте инстанса бота.
 */
try {
    EventEmitter.prototype.setMaxListeners.call(bot, 100);
} catch (e) {
    console.warn('⚠️ [CORE] Предупреждение: Не удалось изменить лимит слушателей событий.');
}

// ГЛОБАЛЬНАЯ ОБРАБОТКА СИСТЕМНЫХ ОШИБОК (SAFETY LAYER)
const setupSafetyLayer = () => {
    // Ошибки сети Telegram
    bot.on('polling_error', (err) => {
        if (['EFATAL', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code)) return;
        console.error(`📡 [POLLING ERROR] ${err.code}: ${err.message}`);
    });

    // Ошибки промисов
    process.on('unhandledRejection', (reason) => {
        console.error('🔥 [CRITICAL] Unhandled Rejection:', reason);
    });

    // Критические исключения
    process.on('uncaughtException', (err) => {
        console.error('🔥 [CRITICAL] Uncaught Exception:', err);
        setTimeout(() => process.exit(1), 500);
    });
};

setupSafetyLayer();

console.log(`✅ [CORE] Ядро успешно экспортировано.`);
/**
 * @file src/core.js
 * @description Ядро системы (Identity & Network Layer).
 * Инкапсулирует инстанс TelegramBot с применением прототипного расширения EventEmitter
 * и оптимизацией TCP-стека через Keep-Alive агентов.
 * @version 6.1.0 (Enterprise Resilience)
 */

import TelegramBot from 'node-telegram-bot-api';
import { EventEmitter } from 'events';
import { config } from './config.js';

// =============================================================================
// ⚙️ КРИТИЧЕСКАЯ ПРОВЕРКА КОНФИГУРАЦИИ
// =============================================================================

if (!config.bot?.token) {
    throw new Error('SYSTEM_HALT: BOT_TOKEN is not defined in environment.');
}

// =============================================================================
// 🌐 СЕТЕВАЯ ОПТИМИЗАЦИЯ (TCP REUSE)
// =============================================================================

/**
 * Настройка HTTP-агента для минимизации задержек на установку TLS-соединений.
 * В высоконагруженных ботах повторное использование сокетов экономит до 200мс на запрос.
 */
const requestOptions = {
    agentOptions: {
        keepAlive: true,
        keepAliveMsecs: 15000,
        maxSockets: 100, // Увеличено для параллельной рассылки/обработки
        maxFreeSockets: 10,
        scheduling: 'lifo', // Использование "горячих" сокетов
        timeout: 20000
    },
    timeout: 30000
};

// =============================================================================
// 🤖 ИНИЦИАЛИЗАЦИЯ ИНСТАНСА (SAFE FACTORY)
// =============================================================================

console.log(`🏗 [CORE] Инициализация Engine... Окружение: ${config.system.env}`);

/**
 * Создаем инстанс. 
 * polling: false — стратегия запуска делегирована контроллеру (src/bot.js).
 */
export const bot = new TelegramBot(config.bot.token, {
    polling: false,
    request: requestOptions
});

/**
 * РЕШЕНИЕ ПРОБЛЕМЫ: TypeError: bot.setMaxListeners is not a function
 * Библиотека скрывает EventEmitter. Мы обращаемся к прототипу напрямую,
 * чтобы предотвратить Memory Leak при регистрации множества Wizard-сцен и хендлеров.
 */
try {
    EventEmitter.prototype.setMaxListeners.call(bot, 100);
} catch (e) {
    console.warn('⚠️ [CORE] Не удалось расширить лимит слушателей событий через прототип.');
}

// =============================================================================
// 🛡 ОТКАЗОУСТОЙЧИВОСТЬ (PROCESS GUARDIAN)
// =============================================================================

/**
 * Централизованный механизм перехвата исключений.
 * Senior уровень просто логирует. Above Senior — предотвращает деградацию системы.
 */
const setupProcessGuardian = () => {
    // Ошибки сетевого уровня Telegram API
    bot.on('polling_error', (err) => {
        const skipCodes = ['EFATAL', 'ETIMEDOUT', 'ECONNRESET'];
        if (skipCodes.includes(err.code)) return;
        console.error(`📡 [NETWORK ERROR] Code: ${err.code} | ${err.message}`);
    });

    // Ошибки выполнения команд (защита от падения при некорректном callback_data)
    bot.on('error', (err) => {
        console.error('💥 [BOT ERROR] Global catch:', err.message);
    });

    // Критические ошибки Node.js процесса
    process.on('unhandledRejection', (reason, promise) => {
        console.error('🔥 [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (err) => {
        console.error('🔥 [CRITICAL] Uncaught Exception. System Restart Required:', err);
        // Даем время логгеру записать ошибку перед выходом
        setTimeout(() => process.exit(1), 500);
    });
};

setupProcessGuardian();

const instanceTag = Math.random().toString(36).substring(7);
console.log(`✅ [CORE] Engine Ready. Instance ID: [${instanceTag}]`);
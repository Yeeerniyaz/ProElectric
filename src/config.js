/**
 * @file src/config.js
 * @description Центральный модуль конфигурации приложения.
 * Отвечает за валидацию переменных окружения, типизацию и предоставление
 * единого "Source of Truth" для всех настроек системы.
 * @module Config
 */

import 'dotenv/config';

// =============================================================================
// 🛠 УТИЛИТЫ ВАЛИДАЦИИ (Environment Parsers)
// =============================================================================

/**
 * Получает обязательную переменную окружения.
 * Бросает фатальную ошибку, если переменной нет, предотвращая запуск "сломанного" приложения.
 * @param {string} name - Имя переменной
 * @returns {string} Значение переменной
 */
const requireEnv = (name) => {
    const val = process.env[name];
    if (!val) {
        throw new Error(`❌ [CONFIG FATAL] Missing required env variable: "${name}"`);
    }
    return val;
};

/**
 * Парсит числовую переменную.
 * @param {string} name - Имя переменной
 * @param {number|null} defaultValue - Значение по умолчанию
 * @returns {number|null} Число или null
 */
const getInt = (name, defaultValue = null) => {
    const val = process.env[name];
    if (val === undefined || val === '') return defaultValue;
    
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) {
        throw new Error(`❌ [CONFIG FATAL] Env variable "${name}" must be a number, got "${val}"`);
    }
    return parsed;
};

/**
 * Парсит список ID, разделенных запятой (например: "123,456,789").
 * Используется для списка дополнительных админов.
 * @param {string} name 
 * @returns {Array<number>} Массив ID
 */
const getList = (name) => {
    const val = process.env[name];
    if (!val) return [];
    return val.split(',').map(v => parseInt(v.trim(), 10)).filter(n => !isNaN(n));
};

// =============================================================================
// ⚙️ СТРУКТУРА КОНФИГУРАЦИИ (Configuration Schema)
// =============================================================================

const configRaw = {
    // --- 🤖 Настройки Telegram Bot ---
    bot: {
        token: requireEnv('BOT_TOKEN'),
        
        // 👑 Владелец (SuperAdmin) - полный доступ ко всему
        ownerId: getInt('ADMIN_ID'), 

        // Дополнительные админы (если нужно несколько)
        adminIds: getList('ADDITIONAL_ADMIN_IDS'),

        // ID основной группы, куда падают заявки/лиды
        groupId: getInt('GROUP_ID'), // Опционально

        // ID канала (публичного/приватного) для рассылок и логов
        channelId: process.env.CHANNEL_ID, // Может быть строкой (@channel) или ID (-100...)
        
        // Юзернейм шефа для контактов в боте
        bossUsername: (process.env.BOSS_USERNAME || 'yeeerniyaz').replace('@', ''),
        
        // Юзернейм самого бота (для генерации ссылок)
        username: (process.env.BOT_USERNAME || 'bot').replace('@', ''), 
    },

    // --- 💰 Ценообразование (Базовые ставки для расчета) ---
    // Используются как дефолтные значения, если в БД нет переопределений
    pricing: {
        point: getInt('PRICE_POINT', 2500),              // Точка (розетка/выключатель)
        strobeConcrete: getInt('PRICE_STROBE_C', 2000),  // Штроба (бетон)
        strobeBrick: getInt('PRICE_STROBE_B', 1500),     // Штроба (кирпич)
        cableLaying: getInt('PRICE_CABLE', 400),         // Прокладка кабеля
        shieldModule: getInt('PRICE_MODULE', 3500),      // Сборка 1 модуля щита
        materialFactor: parseFloat(process.env.MATERIAL_FACTOR || '0.4'), // Коэффициент материала
    },

    // --- 🐘 Настройки Базы Данных (PostgreSQL) ---
    db: {
        user: requireEnv('DB_USER'),
        password: requireEnv('DB_PASSWORD'),
        host: process.env.DB_HOST || 'localhost',
        database: requireEnv('DB_NAME'),
        port: getInt('DB_PORT', 5432),
        
        // Пул соединений для High Load (оптимизация)
        max: getInt('DB_POOL_MAX', 20), 
        idleTimeoutMillis: 30000, 
        connectionTimeoutMillis: 5000, 
    },

    // --- 🌍 Системные настройки ---
    system: {
        env: process.env.NODE_ENV || 'development',
        port: getInt('PORT', 3000), // Порт для Healthcheck (если понадобится)
        timezone: process.env.TZ || 'Asia/Almaty',
    },

    // --- 🔐 Безопасность ---
    security: {
        sessionSecret: process.env.SESSION_SECRET || 'dev_secret_key', // Для сессий (если будут)
    }
};

// 🔒 Deep Freeze: Гарантируем, что конфигурация неизменна в рантайме
export const config = Object.freeze(configRaw);

// =============================================================================
// 🚀 SELF-CHECK ПРИ СТАРТЕ
// =============================================================================
(() => {
    // Скрываем токен при логировании
    const safeConfig = { ...config.bot, token: '***HIDDEN***' };
    
    console.log(`✅ [CONFIG] Loaded. Env: ${config.system.env}`);
    console.log(`👑 [CONFIG] Owner ID: ${config.bot.ownerId ? 'SET' : '⚠️ NOT SET'}`);
    
    if (!config.bot.ownerId) {
        console.warn('⚠️ [WARNING] ADMIN_ID не установлен! Вы не сможете управлять ботом.');
    }
})();
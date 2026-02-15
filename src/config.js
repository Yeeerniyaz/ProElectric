import 'dotenv/config';

// ------------------------------------------------------------------
// 🛠 УТИЛИТЫ ВАЛИДАЦИИ (Validation Utils)
// ------------------------------------------------------------------

/**
 * Получает обязательную переменную окружения.
 * Бросает фатальную ошибку, если переменной нет.
 */
const requireEnv = (name) => {
    if (!process.env[name]) {
        throw new Error(`❌ [CONFIG FATAL] Missing required env variable: "${name}"`);
    }
    return process.env[name];
};

/**
 * Получает числовую переменную.
 * Если переменной нет — возвращает defaultValue.
 * Если есть, но не число — бросает ошибку.
 */
const getInt = (name, defaultValue) => {
    const val = process.env[name];
    if (!val) return defaultValue;
    
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) {
        throw new Error(`❌ [CONFIG FATAL] Env variable "${name}" must be a number, got "${val}"`);
    }
    return parsed;
};

// ------------------------------------------------------------------
// ⚙️ КОНФИГУРАЦИЯ (Configuration Object)
// ------------------------------------------------------------------

export const config = {
    // --- Настройки Telegram ---
    bot: {
        token: requireEnv('BOT_TOKEN'),
        
        // ID основной группы админов (куда падают лиды)
        groupId: getInt('GROUP_ID', null),
        
        // ID рабочей группы сотрудников (для авторизации)
        workGroupId: getInt('WORK_GROUP_ID', null),
        
        bossUsername: process.env.BOSS_USERNAME || '@yeeerniyaz',
        
        // 🔥 Убираем '@' если случайно добавили в .env, чтобы ссылки t.me/Bot работали
        username: (process.env.BOT_USERNAME || 'ProElectroBot').replace('@', ''), 
    },

    // --- Настройки Базы Данных (PostgreSQL) ---
    db: {
        user: requireEnv('DB_USER'),
        password: requireEnv('DB_PASSWORD'),
        host: process.env.DB_HOST || 'proelectro-db', // Имя сервиса в docker-compose
        database: requireEnv('DB_NAME'),
        port: getInt('DB_PORT', 5432),
        
        // Настройки пула (для High Load)
        max: 20, 
        idleTimeoutMillis: 30000, 
        connectionTimeoutMillis: 5000, // Увеличил до 5 сек для надежности
    },

    // --- Настройки Веб-сервера (Dashboard) ---
    server: {
        port: getInt('WEB_PORT', 3000),
        env: process.env.NODE_ENV || 'development',
    },

    // --- Безопасность и Админка ---
    security: {
        sessionSecret: requireEnv('SESSION_SECRET'),
        adminLogin: process.env.ADMIN_LOGIN || 'admin',
        adminPassHash: process.env.ADMIN_PASS_HASH || 'yeehash'
    }
};

// ------------------------------------------------------------------
// 🚀 SELF-CHECK ПРИ СТАРТЕ
// ------------------------------------------------------------------
console.log(`✅ [CONFIG] Loaded. Env: ${config.server.env} | Bot: @${config.bot.username}`);
if (!config.bot.groupId) console.warn('⚠️ [CONFIG] GROUP_ID not set! Admin notifications disabled.');
if (!config.bot.workGroupId) console.warn('⚠️ [CONFIG] WORK_GROUP_ID not set! Gatekeeper disabled (open access).');
import 'dotenv/config';

// Функция для жесткой проверки наличия переменных
const requireEnv = (name) => {
    if (!process.env[name]) {
        throw new Error(`❌ [CONFIG FATAL] Забыл добавить переменную "${name}" в файл .env`);
    }
    return process.env[name];
};

export const config = {
    // --- Настройки Telegram ---
    bot: {
        token: requireEnv('BOT_TOKEN'),
        // Превращаем ID группы в число (Telegram API любит числа)
        groupId: parseInt(process.env.GROUP_ID, 10) || null,
        bossUsername: process.env.BOSS_USERNAME || '@yeeerniyaz'
    },

    // --- Настройки Базы Данных ---
    db: {
        user: requireEnv('DB_USER'),
        password: requireEnv('DB_PASSWORD'),
        host: process.env.DB_HOST || 'proelectro-db', // Дефолт для Docker
        database: requireEnv('DB_NAME'),
        port: parseInt(process.env.DB_PORT, 10) || 5432,
        max: 20, // Максимум 20 параллельных клиентов
        idleTimeoutMillis: 30000, // Закрывать простой через 30 сек
        connectionTimeoutMillis: 2000, // Если база не отвечает 2 сек — ошибка
    },

    // --- Настройки Веб-сервера ---
    server: {
        port: parseInt(process.env.WEB_PORT, 10) || 3000,
        env: process.env.NODE_ENV || 'development',
    },

    // --- Безопасность и Админка ---
    security: {
        sessionSecret: requireEnv('SESSION_SECRET'),
        adminLogin: process.env.ADMIN_LOGIN || 'admin',
        adminPassHash: process.env.ADMIN_PASS_HASH || 'yeehash'
    }
};
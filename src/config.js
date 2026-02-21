/**
 * @file src/config.js
 * @description Синхронизированный модуль конфигурации (v10.9.17 Enterprise).
 * Устраняет ошибки "undefined" в app.js и connection.js, объединяя все секции.
 * Внедрены настройки безопасности для OTP авторизации и WebSockets.
 * ДОБАВЛЕНО: Централизация лимитов (Rate Limit) и времени жизни сессий.
 * НИКАКИХ СОКРАЩЕНИЙ: Весь оригинальный код сохранен.
 *
 * @module Configuration
 */

import "dotenv/config";

// --- Вспомогательные утилиты для парсинга ---
const getEnv = (name, defaultValue = undefined) => {
  const val = process.env[name];
  if (val === undefined || val === "") {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(
      `❌ [CONFIG FATAL] Отсутствует обязательная переменная "${name}"`,
    );
  }
  return val;
};

const getInt = (name, defaultValue = null) => {
  const val = process.env[name];
  if (val === undefined || val === "") return defaultValue;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed))
    throw new Error(`❌ [CONFIG FATAL] "${name}" должно быть числом`);
  return parsed;
};

const getList = (name) => {
  const val = process.env[name];
  if (!val) return [];
  return val
    .split(",")
    .map((v) => parseInt(v.trim(), 10))
    .filter((n) => !isNaN(n));
};

// --- Формирование строки подключения к БД ---
const getDatabaseUrl = () => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = getEnv("DB_USER", "postgres");
  const pass = getEnv("DB_PASSWORD", "postgres");
  const host = getEnv("DB_HOST", "localhost");
  const port = getInt("DB_PORT", 5432);
  const name = getEnv("DB_NAME", "proelectric");
  return `postgres://${user}:${pass}@${host}:${port}/${name}`;
};

const isProduction = process.env.NODE_ENV === "production";

// --- Глобальный объект конфигурации ---
const configRaw = {
  system: {
    env: getEnv("NODE_ENV", "development"),
    port: getInt("PORT", 3000),
    timezone: getEnv("TZ", "Asia/Almaty"),
    isProduction,
  },

  // Секция server — необходима для app.js и WebSockets
  server: {
    corsOrigin: getEnv("CORS_ORIGIN", "*"),
    sessionSecret: getEnv("SESSION_SECRET", "dev_secret_key_change_me"),
    jwtSecret: getEnv("JWT_SECRET", "proelectric_enterprise_jwt_secret_key"), // Для Web CRM (OTP Auth)
    otpExpiresIn: getInt("OTP_EXPIRES_IN", 15), // Время жизни OTP пароля в минутах
    // 🔥 НОВОЕ: Enterprise константы вынесены из app.js
    rateLimitWindowMs: getInt("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000), // Окно лимита (15 минут)
    rateLimitMax: getInt("RATE_LIMIT_MAX", 1500), // Кол-во запросов
    sessionMaxAge: getInt("SESSION_MAX_AGE", 30 * 24 * 60 * 60 * 1000), // Жизнь сессии (30 дней)
  },

  // Секция db — необходима для connection.js
  db: {
    connectionString: getDatabaseUrl(),
    max: getInt("DB_POOL_MAX", 20),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // ИСПРАВЛЕНИЕ: SSL включается только если явно передать DB_SSL=true в .env
    // В Docker сетях между контейнерами SSL не нужен
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  },

  // Секция bot — необходима для bot.js
  bot: {
    token: getEnv("BOT_TOKEN"),
    // Используем fallback: если нет ADMIN_ID, ищем OWNER_ID
    ownerId: getInt(
      "ADMIN_ID",
      process.env.OWNER_ID ? parseInt(process.env.OWNER_ID, 10) : undefined,
    ),
    adminIds: getList("ADDITIONAL_ADMIN_IDS"),
    bossUsername: (process.env.BOSS_USERNAME || "yeeerniyaz").replace("@", ""),
  },

  // Секция admin — необходима для авторизации (обратная совместимость)
  admin: {
    password: getEnv("ADMIN_PASS", "admin123"),
  },
};

// Замораживаем объект для предотвращения изменений в рантайме
export const config = Object.freeze(configRaw);

(() => {
  if (process.env.NODE_ENV !== "test") {
    console.log(
      `✅ [CONFIG] Configuration loaded successfully (v10.9.17 Enterprise).`,
    );
    console.log(`🌍 [ENV] Environment: ${config.system.env.toUpperCase()}`);
  }
})();

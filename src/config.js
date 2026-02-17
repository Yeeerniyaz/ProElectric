/**
 * @file src/config.js
 * @description Центральный модуль конфигурации приложения.
 * Реализует паттерн "Strict Configuration": приложение не запустится,
 * если отсутствуют критически важные переменные окружения.
 * * @module Config
 */

import "dotenv/config";

// =============================================================================
// 🛠 УТИЛИТЫ ВАЛИДАЦИИ И ПАРСИНГА (Environment Parsers)
// =============================================================================

/**
 * Получает строковую переменную окружения.
 * @param {string} name - Ключ переменной
 * @param {string} [defaultValue] - Значение по умолчанию (опционально)
 * @returns {string} Значение
 * @throws {Error} Если переменная обязательна, но отсутствует
 */
const getEnv = (name, defaultValue = undefined) => {
  const val = process.env[name];
  if (val === undefined || val === "") {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(
      `❌ [CONFIG FATAL] Ошибка конфигурации: Отсутствует обязательная переменная "${name}"`,
    );
  }
  return val;
};

/**
 * Парсит целочисленную переменную.
 * @param {string} name - Ключ переменной
 * @param {number} [defaultValue] - Значение по умолчанию
 * @returns {number} Число
 */
const getInt = (name, defaultValue = null) => {
  const val = process.env[name];
  if (val === undefined || val === "") return defaultValue;

  const parsed = parseInt(val, 10);
  if (isNaN(parsed)) {
    throw new Error(
      `❌ [CONFIG FATAL] Переменная "${name}" должна быть числом, получено: "${val}"`,
    );
  }
  return parsed;
};

/**
 * Парсит булевую переменную (true/false, 1/0, yes/no).
 * @param {string} name
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
const getBool = (name, defaultValue = false) => {
  const val = process.env[name];
  if (val === undefined || val === "") return defaultValue;
  return ["true", "1", "yes", "on"].includes(val.toLowerCase());
};

/**
 * Парсит список ID/строк, разделенных запятой.
 * @param {string} name
 * @returns {Array<number>} Массив ID
 */
const getList = (name) => {
  const val = process.env[name];
  if (!val) return [];
  return val
    .split(",")
    .map((v) => parseInt(v.trim(), 10))
    .filter((n) => !isNaN(n));
};

// =============================================================================
// 🐘 ФОРМИРОВАНИЕ ПОДКЛЮЧЕНИЯ К БД
// =============================================================================

/**
 * Строит строку подключения (Connection String) или возвращает готовую.
 * Приоритет отдается DATABASE_URL (12-Factor App methodology).
 */
const getDatabaseUrl = () => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const user = getEnv("DB_USER", "postgres");
  const pass = getEnv("DB_PASSWORD", "postgres");
  const host = getEnv("DB_HOST", "localhost");
  const port = getInt("DB_PORT", 5432);
  const name = getEnv("DB_NAME", "proelectric");

  return `postgres://${user}:${pass}@${host}:${port}/${name}`;
};

// =============================================================================
// ⚙️ СХЕМА КОНФИГУРАЦИИ
// =============================================================================

const isProduction = process.env.NODE_ENV === "production";

const configRaw = {
  // --- 🌍 Системное окружение ---
  system: {
    env: getEnv("NODE_ENV", "development"),
    port: getInt("PORT", 3000),
    timezone: getEnv("TZ", "Asia/Almaty"),
    isProduction,
  },

  // --- 🤖 Настройки Telegram Bot ---
  bot: {
    token: getEnv("BOT_TOKEN"),

    // Права доступа
    ownerId: getInt("ADMIN_ID"),
    adminIds: getList("ADDITIONAL_ADMIN_IDS"),

    // Каналы коммуникации
    groupId: getInt("GROUP_ID", null),
    channelId: process.env.CHANNEL_ID, // ID канала для логов (опционально)

    // Контакты
    bossUsername: (process.env.BOSS_USERNAME || "yeeerniyaz").replace("@", ""),
    username: (process.env.BOT_USERNAME || "bot").replace("@", ""),
  },

  // --- 🐘 Настройки Базы Данных (PostgreSQL) ---
  db: {
    connectionString: getDatabaseUrl(),
    // Настройки пула соединений
    max: getInt("DB_POOL_MAX", 20),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // SSL обязателен для многих облачных провайдеров в проде
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  },

  // --- 🔐 Безопасность и Доступ ---
  security: {
    // Пароль для входа в Web-админку (/admin.html)
    adminPassword: getEnv("ADMIN_PASS", "admin123"),
    sessionSecret: getEnv("SESSION_SECRET", "dev_secret_key_change_me"),
    corsOrigins: getList("CORS_ORIGINS"), // Если API будет дергаться с других доменов
  },

  // ⚠️ Примечание:
  // Настройки цен (Pricing) удалены из конфига.
  // Теперь они динамически загружаются из таблицы `settings` в БД.
};

// 🔒 Deep Freeze: Гарантируем неизменность конфига в рантайме
export const config = Object.freeze(configRaw);

// =============================================================================
// 🚀 SELF-CHECK ПРИ ЗАПУСКЕ
// =============================================================================
(() => {
  // Логируем статус загрузки конфигурации (без чувствительных данных)
  if (process.env.NODE_ENV !== "test") {
    console.log(`✅ [CONFIG] Configuration loaded successfully.`);
    console.log(`🌍 [ENV] Environment: ${config.system.env.toUpperCase()}`);
    console.log(
      `🔌 [DB] Connection Target: ${config.db.connectionString.includes("@") ? config.db.connectionString.split("@")[1] : "Internal URL"}`,
    );

    if (!config.bot.ownerId) {
      console.warn(
        `⚠️ [WARNING] ADMIN_ID is not set! Bot admin commands will be disabled.`,
      );
    }

    if (
      config.system.env === "production" &&
      config.security.adminPassword === "admin123"
    ) {
      console.warn(
        `⚠️ [SECURITY] You are using default ADMIN_PASS in production! Please change it.`,
      );
    }
  }
})();

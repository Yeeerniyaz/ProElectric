/**
 * @file src/config.js
 * @description Центральный модуль конфигурации приложения.
 * Исправленная версия для совместимости с app.js и server.js.
 * @module Config
 */

import "dotenv/config";

// =============================================================================
// 🛠 УТИЛИТЫ
// =============================================================================

const getEnv = (name, defaultValue = undefined) => {
  const val = process.env[name];
  if (val === undefined || val === "") {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`❌ [CONFIG FATAL] Missing var: "${name}"`);
  }
  return val;
};

const getInt = (name, defaultValue = null) => {
  const val = process.env[name];
  if (val === undefined || val === "") return defaultValue;
  return parseInt(val, 10);
};

const getList = (name) => {
  const val = process.env[name];
  return val ? val.split(",").map((v) => v.trim()) : [];
};

// =============================================================================
// ⚙️ КОНФИГУРАЦИЯ
// =============================================================================

const isProduction = process.env.NODE_ENV === "production";

const configRaw = {
  // 1. Системные настройки
  system: {
    env: getEnv("NODE_ENV", "development"),
    isProduction,
    timezone: getEnv("TZ", "Asia/Almaty"),
  },

  // 2. Настройки Сервера (Исправляем ошибку undefined 'server')
  server: {
    port: getInt("PORT", 3000),
    // app.js ждет corsOrigin (строка), а не corsOrigins (массив)
    corsOrigin: getEnv("CORS_ORIGIN", "*"), 
    sessionSecret: getEnv("SESSION_SECRET", "dev_secret_key_change_me"),
  },

  // 3. База данных
  database: {
    url: getEnv("DATABASE_URL"), // Ожидает полную строку подключения
    maxPoolSize: getInt("DB_POOL_MAX", 20),
    idleTimeout: 30000,
  },

  // 4. Telegram Bot
  bot: {
    token: getEnv("BOT_TOKEN"),
    webhookDomain: getEnv("WEBHOOK_DOMAIN", null),
  },

  // 5. Админка (app.js ждет config.admin.password)
  admin: {
    password: getEnv("ADMIN_PASSWORD", "admin123"),
    ownerId: getInt("OWNER_ID", 0),
  },
};

export const config = Object.freeze(configRaw);

// =============================================================================
// 🚀 SELF-CHECK
// =============================================================================
if (process.env.NODE_ENV !== "test") {
  console.log(`✅ [CONFIG] Loaded. Env: ${config.system.env}`);
  // Проверка критических полей
  if (!config.server.sessionSecret) console.warn("⚠️ Warning: SESSION_SECRET is missing");
}
/**
 * @file src/config.js
 * @description Централизованная конфигурация приложения.
 * Реализует паттерн "Strict Configuration": приложение не запустится без критических переменных.
 * Приводит типы (строки в числа/булево) и структурирует настройки по доменам.
 *
 * @module Config
 * @version 6.4.0 (Stable)
 * @author ProElectric Team
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Инициализация переменных окружения
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

// =============================================================================
// 🛠 HELPERS (VALIDATION & PARSING)
// =============================================================================

/**
 * Получить обязательную переменную окружения.
 * @throws {Error} Если переменная не задана.
 */
const getEnvStrict = (key) => {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error(
      `❌ [CONFIG FATAL] Missing required environment variable: ${key}`,
    );
  }
  return value;
};

/**
 * Получить переменную с дефолтным значением.
 */
const getEnv = (key, defaultVal) => {
  return process.env[key] !== undefined ? process.env[key] : defaultVal;
};

/**
 * Получить переменную и привести к числу.
 */
const getInt = (key, defaultVal) => {
  const value = process.env[key];
  if (value === undefined) return defaultVal;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultVal : parsed;
};

/**
 * Получить переменную и привести к массиву (разделитель запятая).
 */
const getList = (key, defaultVal = []) => {
  const value = process.env[key];
  if (!value) return defaultVal;
  return value.split(",").map((s) => s.trim());
};

// =============================================================================
// ⚙️ CONFIGURATION OBJECT
// =============================================================================

const configRaw = {
  // 1. Системные настройки
  system: {
    env: getEnv("NODE_ENV", "development"),
    isProduction: getEnv("NODE_ENV") === "production",
    timezone: getEnv("TZ", "Asia/Almaty"),
  },

  // 2. Настройки HTTP Сервера (Исправляет ошибку corsOrigin)
  server: {
    port: getInt("PORT", 3000),
    host: getEnv("HOST", "0.0.0.0"),
    // Секрет для сессий (Cookies). В проде должен быть сложным!
    sessionSecret: getEnv(
      "SESSION_SECRET",
      "dev_secret_key_change_me_immediately",
    ),
    // CORS: Разрешенные домены (для фронтенда)
    corsOrigin: getEnv("CORS_ORIGIN", "*"),
    // Лимиты загрузки файлов (фото отчетов и т.д.)
    bodyLimit: "10mb",
  },

  // 3. База данных (PostgreSQL)
  database: {
    // Строка подключения: postgres://user:pass@host:port/dbname
    url: getEnvStrict("DATABASE_URL"),
    maxPoolSize: getInt("DB_POOL_SIZE", 20),
    idleTimeout: 30000,
  },

  // 4. Telegram Bot
  bot: {
    token: getEnvStrict("BOT_TOKEN"),
    // Для Webhook режима (в будущем)
    webhookDomain: getEnv("WEBHOOK_DOMAIN", null),
    webhookPath: getEnv("WEBHOOK_PATH", "/api/webhook/telegram"),
  },

  // 5. Администрирование и Доступ
  admin: {
    // Пароль для входа в веб-панель (/admin.html)
    password: getEnv("ADMIN_PASSWORD", "admin123"),
    // ID владельца в Telegram (для критических уведомлений)
    ownerId: getInt("OWNER_ID", 0), // Если 0 — уведомления отключены
    // Список ID разработчиков (для отладки)
    developers: getList("DEV_IDS", []),
  },
};

// =============================================================================
// 🔒 FREEZE & EXPORT
// =============================================================================

// Защищаем конфиг от случайных изменений в коде (Runtime Immutability)
export const config = Object.freeze(configRaw);

// =============================================================================
// 🚀 SELF-DIAGNOSTICS (LOGGING)
// =============================================================================

if (config.system.env !== "test") {
  // Безопасное логирование при старте (скрываем пароли)
  const safeDbUrl = config.database.url.replace(/:([^:@]+)@/, ":*****@");
  const safeToken = config.bot.token.substring(0, 5) + "...";

  console.log(
    `\n🔧 [CONFIG] Loaded environment: ${config.system.env.toUpperCase()}`,
  );
  console.log(`🔌 [DB] Target: ${safeDbUrl}`);
  console.log(`🤖 [BOT] Token: ${safeToken}`);

  if (config.admin.ownerId === 0) {
    console.warn(
      `⚠️ [WARNING] OWNER_ID not set! Critical notifications will be disabled.`,
    );
  }
}

/**
 * @file src/database/connection.js
 * @description Модуль управления соединениями с PostgreSQL (Database Driver).
 * Реализует паттерн "Connection Pool" и обеспечивает отказоустойчивость подключения.
 * * @module DatabaseConnection
 * @version 6.2.0 (Senior Architect Edition)
 */

import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

// =============================================================================
// 🔧 ВАЛИДАЦИЯ КОНФИГУРАЦИИ (FAIL-FAST)
// =============================================================================

if (!config.db || !config.db.connectionString) {
  console.error("🔥 [DB FATAL] Критическая ошибка: В объекте config отсутствует config.db.connectionString.");
  console.error("Проверьте файл src/config.js и наличие переменной DATABASE_URL в .env.");
  process.exit(1);
}

// =============================================================================
// ⚙️ НАСТРОЙКА ПУЛА (POOL CONFIGURATION)
// =============================================================================

const poolConfig = {
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: config.db.max || 20,
  idleTimeoutMillis: config.db.idleTimeoutMillis || 30000,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis || 5000,
};

/**
 * Единственный экземпляр пула для всего приложения (Singleton).
 */
const pool = new Pool(poolConfig);

// =============================================================================
// 🛡 МОНИТОРИНГ И ОБРАБОТКА СОБЫТИЙ
// =============================================================================

pool.on("connect", () => {
  if (!config.system.isProduction) {
    console.log("🔌 [DB] Новое соединение установлено с пулом.");
  }
});

pool.on("error", (err) => {
  console.error("🔥 [DB POOL ERROR] Непредвиденная ошибка простаивающего клиента:", err.message);
});

// =============================================================================
// 🚀 ПУБЛИЧНЫЙ ИНТЕРФЕЙС (API)
// =============================================================================

/**
 * Выполнение одиночного SQL-запроса (Shortcut).
 * Автоматически управляет жизненным циклом соединения.
 * * @param {string} text - SQL-текст
 * @param {Array<any>} params - Параметры
 */
export const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;

    // Логирование медленных запросов (>100ms)
    if (duration > 100) {
      console.warn(`⚠️ [DB SLOW QUERY] ${duration}мс | SQL: ${text}`);
    }

    return res;
  } catch (error) {
    console.error(`❌ [DB QUERY ERROR] Ошибка выполнения запроса: ${error.message}`);
    console.error(`SQL: ${text}`);
    if (params) console.error(`Params: ${JSON.stringify(params)}`);
    throw error;
  }
};

/**
 * Получение клиента для сложных операций или транзакций.
 * ⚠️ Требует обязательного вызова client.release()!
 */
export const getClient = async () => {
  try {
    const client = await pool.connect();
    return client;
  } catch (error) {
    console.error("❌ [DB CONNECTION] Не удалось получить клиента из пула:", error.message);
    throw error;
  }
};

/**
 * Безопасное закрытие пула при завершении работы (Graceful Shutdown).
 */
export const closePool = async () => {
  console.log("🔌 [DB] Закрытие пула соединений...");
  await pool.end();
  console.log("✅ [DB] Пул успешно закрыт.");
};
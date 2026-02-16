/**
 * @file src/database/connection.js
 * @description Модуль управления соединением с базой данных (Connection Layer).
 * Отвечает за конфигурацию пула (Pool), обработку ошибок соединения и логирование запросов.
 * Реализует паттерн Singleton для пула подключений.
 * @module DatabaseConnection
 * @version 1.0.0 (Senior Level)
 */

import pg from "pg";
import { config } from "../config.js";

// Деструктурируем Pool из пакета pg
const { Pool } = pg;

// =============================================================================
// КОНФИГУРАЦИЯ ПУЛА (POOL CONFIGURATION)
// =============================================================================

/**
 * Создаем пул подключений.
 * Пул позволяет переиспользовать открытые соединения, что значительно ускоряет работу бота,
 * так как не нужно каждый раз тратить время на рукопожатие (handshake) с базой.
 */
const pool = new Pool({
  // Параметры подключения берутся строго из конфигурации (Environment Variables)
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,

  // Тюнинг производительности (Performance Tuning)
  max: 20, // Максимальное количество клиентов в пуле (достаточно для бота средней нагрузки)
  idleTimeoutMillis: 30000, // Время простоя клиента перед его закрытием (30 сек)
  connectionTimeoutMillis: 5000, // Таймаут на попытку подключения (5 сек)
});

// =============================================================================
// ОБРАБОТКА СИСТЕМНЫХ ОШИБОК (ERROR HANDLING)
// =============================================================================

/**
 * Глобальный обработчик ошибок пула.
 * Срабатывает, если клиент в пуле теряет соединение или происходит критический сбой сети.
 * Важно: Если пул "умер", приложение должно завершиться, чтобы Docker перезапустил его.
 */
pool.on("error", (err, client) => {
  console.error(
    "❌ [DB CRITICAL] Внезапная ошибка в клиенте базы данных (Idle Client Error):",
    err,
  );
  process.exit(-1); // Завершаем процесс с кодом ошибки
});

// =============================================================================
// ЭКСПОРТИРУЕМЫЕ МЕТОДЫ (PUBLIC API)
// =============================================================================

/**
 * Выполнить SQL запрос.
 * Обертка над pool.query для централизованного логирования и обработки ошибок.
 * * @param {string} text - Текст SQL запроса (может содержать $1, $2...)
 * @param {Array<any>} [params] - Массив параметров для безопасной подстановки
 * @returns {Promise<pg.QueryResult>} Результат выполнения запроса
 * @throws {Error} Если запрос не выполнился
 */
export const query = async (text, params) => {
  // Замеряем время выполнения запроса (Performance Monitoring)
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    // const duration = Date.now() - start;
    // console.log(`⚡️ [DB QUERY] Executed in ${duration}ms: ${text}`); // Раскомментировать для Debug режима
    return res;
  } catch (error) {
    console.error(
      `❌ [DB QUERY FAILED] Ошибка при выполнении запроса:\nText: ${text}\nError: ${error.message}`,
    );
    throw error; // Пробрасываем ошибку вызывающему коду
  }
};

/**
 * Получить выделенного клиента из пула.
 * НЕОБХОДИМО для выполнения транзакций (BEGIN -> COMMIT/ROLLBACK),
 * так как транзакция должна выполняться в рамках одного и того же соединения.
 * * @returns {Promise<pg.PoolClient>} Клиент базы данных
 * @example
 * const client = await getClient();
 * try {
 * await client.query('BEGIN');
 * ...
 * await client.query('COMMIT');
 * } finally {
 * client.release(); // Обязательно вернуть клиента в пул!
 * }
 */
export const getClient = async () => {
  const client = await pool.connect();
  return client;
};

// Экспортируем сам пул для специфичных случаев (например, закрытия при выключении)
export default pool;

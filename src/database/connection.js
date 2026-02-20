/**
 * @file src/database/connection.js
 * @description Модуль управления соединениями с PostgreSQL (Database Driver).
 * Реализует паттерн "Connection Pool" и обеспечивает отказоустойчивость подключения.
 * Внедрен механизм LISTEN/NOTIFY для Real-Time WebSockets интеграции (v10.0.0).
 * ИСПРАВЛЕНО: Добавлен экспорт объекта pool для работы вечных сессий в app.js.
 * * @module DatabaseConnection
 * @version 10.0.0 (Enterprise Real-Time Edition)
 */

import pg from "pg";
import { config } from "../config.js";
import { EventEmitter } from "events"; // Для трансляции событий БД в сокеты

const { Pool } = pg;

// =============================================================================
// 🔧 ВАЛИДАЦИЯ КОНФИГУРАЦИИ (FAIL-FAST)
// =============================================================================

if (!config.db || !config.db.connectionString) {
  console.error(
    "🔥 [DB FATAL] Критическая ошибка: В объекте config отсутствует config.db.connectionString.",
  );
  console.error(
    "Проверьте файл src/config.js и наличие переменной DATABASE_URL в .env.",
  );
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
 * 🔥 ИСПРАВЛЕНИЕ: Теперь пул экспортируется для использования в хранилище сессий.
 */
export const pool = new Pool(poolConfig);

// =============================================================================
// 📡 REAL-TIME EVENT EMITTER
// =============================================================================

/**
 * Глобальная шина событий базы данных.
 * Сервер (server.js) сможет подписаться на dbEvents.on('update', ...) и слать io.emit()
 */
export const dbEvents = new EventEmitter();

let listenClient = null; // Выделенный клиент только для прослушивания NOTIFY

/**
 * Активация слушателя PostgreSQL LISTEN.
 * Вызывается один раз при старте сервера.
 */
export const initRealtimeListeners = async () => {
  try {
    listenClient = await pool.connect();

    // Подписываемся на каналы PostgreSQL
    await listenClient.query("LISTEN order_updates");
    await listenClient.query("LISTEN settings_updates");
    await listenClient.query("LISTEN brigade_updates");

    listenClient.on("notification", (msg) => {
      try {
        // Пытаемся распарсить JSON payload от триггера БД
        const payload = msg.payload ? JSON.parse(msg.payload) : {};
        dbEvents.emit(msg.channel, payload);
      } catch (e) {
        // Если payload обычный текст
        dbEvents.emit(msg.channel, msg.payload);
      }
    });

    console.log(
      "📡 [DB Real-Time] Слушатель PostgreSQL (LISTEN/NOTIFY) успешно активирован.",
    );
  } catch (error) {
    console.error(
      "❌ [DB Real-Time] Ошибка запуска слушателя БД:",
      error.message,
    );
  }
};

// =============================================================================
// 🛡 МОНИТОРИНГ И ОБРАБОТКА СОБЫТИЙ
// =============================================================================

pool.on("connect", () => {
  if (!config.system.isProduction) {
    console.log("🔌 [DB] Новое соединение установлено с пулом.");
  }
});

pool.on("error", (err) => {
  console.error(
    "🔥 [DB POOL ERROR] Непредвиденная ошибка простаивающего клиента:",
    err.message,
  );
});

// =============================================================================
// 🚀 ПУБЛИЧНЫЙ ИНТЕРФЕЙС (API)
// =============================================================================

/**
 * Выполнение одиночного SQL-запроса (Shortcut).
 * Автоматически управляет жизненным циклом соединения.
 * @param {string} text - SQL-текст
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
    console.error(
      `❌ [DB QUERY ERROR] Ошибка выполнения запроса: ${error.message}`,
    );
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
    console.error(
      "❌ [DB CONNECTION] Не удалось получить клиента из пула:",
      error.message,
    );
    throw error;
  }
};

/**
 * Безопасное закрытие пула при завершении работы (Graceful Shutdown).
 */
export const closePool = async () => {
  console.log("🔌 [DB] Закрытие пула соединений...");

  if (listenClient) {
    listenClient.release(); // Освобождаем клиента-слушателя
    console.log("📡 [DB Real-Time] Слушатель отсоединен.");
  }

  await pool.end();
  console.log("✅ [DB] Пул успешно закрыт.");
};

/**
 * @file src/database/connection.js
 * @description Модуль управления соединениями с PostgreSQL (Database Driver v10.9.17).
 * Реализует паттерн "Connection Pool" и обеспечивает отказоустойчивость подключения.
 * Внедрен механизм LISTEN/NOTIFY для Real-Time WebSockets интеграции.
 * ДОБАВЛЕНО: Auto-Reconnect (Self-Healing) для слушателя событий БД.
 * ДОБАВЛЕНО: Метод checkHealth() для мониторинга.
 * НИКАКИХ СОКРАЩЕНИЙ.
 * * @module DatabaseConnection
 * @version 10.9.17 (Enterprise Real-Time & Fault Tolerance Edition)
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
 * Пул экспортируется для использования в хранилище сессий.
 */
export const pool = new Pool(poolConfig);

// =============================================================================
// 📡 REAL-TIME EVENT EMITTER & SELF-HEALING LISTENERS
// =============================================================================

/**
 * Глобальная шина событий базы данных.
 * Сервер (server.js) сможет подписаться на dbEvents.on('update', ...) и слать io.emit()
 */
export const dbEvents = new EventEmitter();

let listenClient = null; // Выделенный клиент только для прослушивания NOTIFY

/**
 * Активация слушателя PostgreSQL LISTEN.
 * 🔥 ОБНОВЛЕНО: Добавлена рекурсивная защита от обрывов связи (Auto-Reconnect).
 */
export const initRealtimeListeners = async () => {
  try {
    if (listenClient) {
      listenClient.release(true); // Жестко сбрасываем старого клиента, если он завис
    }

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

    // Обработка критических разрывов (например, рестарт Postgres)
    listenClient.on("error", (err) => {
      console.error(
        "🔥 [DB Real-Time] Ошибка слушателя событий! Обрыв связи:",
        err.message,
      );
      listenClient.release(true);
      console.log(
        "🔄 [DB Real-Time] Попытка переподключения через 5 секунд...",
      );
      setTimeout(initRealtimeListeners, 5000);
    });

    console.log(
      "📡 [DB Real-Time] Слушатель PostgreSQL (LISTEN/NOTIFY) успешно активирован и защищен.",
    );
  } catch (error) {
    console.error(
      "❌ [DB Real-Time] Ошибка запуска слушателя БД (переподключение через 5с):",
      error.message,
    );
    setTimeout(initRealtimeListeners, 5000);
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
 * 🔥 НОВОЕ: Проверка состояния БД (Health Check)
 * @returns {Promise<Object>}
 */
export const checkHealth = async () => {
  const start = Date.now();
  try {
    await pool.query("SELECT 1");
    return { status: "OK", latency: Date.now() - start };
  } catch (error) {
    return {
      status: "ERROR",
      latency: Date.now() - start,
      error: error.message,
    };
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

/**
 * @file src/db.js
 * @description Data Access Layer (DAL) уровня Enterprise.
 * Реализует паттерн Repository, управляет пулом соединений, транзакциями,
 * миграциями схемы и кэшированием конфигурации.
 * * @module DB
 * @version 2.0.0
 */

import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

// =============================================================================
// 🔌 POOL CONFIGURATION
// =============================================================================

// Парсинг BigInt: PostgreSQL возвращает bigint как строку, конвертируем в число (если влезает) или оставляем строкой
pg.types.setTypeParser(20, (val) => parseInt(val, 10));

const pool = new Pool({
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: config.db.max,
  idleTimeoutMillis: config.db.idleTimeoutMillis,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis,
});

// Глобальные обработчики событий пула
pool.on("connect", () => {
  // Можно добавить метрики
});

pool.on("error", (err) => {
  console.error("💥 [DB CRITICAL] Unexpected error on idle client", err);
  // В продакшене здесь может быть отправка алерта в Sentry/Prometheus
});

// =============================================================================
// 🛠 CORE UTILITIES (Transaction & Query Wrappers)
// =============================================================================

/**
 * Выполняет SQL запрос.
 * @param {string} text - SQL запрос
 * @param {Array} [params] - Параметры
 * @returns {Promise<pg.QueryResult>}
 */
const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`⚠️ [DB SLOW QUERY] ${duration}ms: ${text}`);
    }
    return res;
  } catch (err) {
    console.error(`❌ [DB ERROR] Query: ${text} | Error: ${err.message}`);
    throw err;
  }
};

/**
 * Выполняет функцию внутри транзакции.
 * Автоматически делает BEGIN, COMMIT или ROLLBACK.
 * @param {Function} callback - Функция, принимающая pg-клиент (client)
 * @returns {Promise<any>} Результат выполнения callback
 */
const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("⚠️ [DB TRANSACTION ROLLBACK]", e.message);
    throw e;
  } finally {
    client.release();
  }
};

// =============================================================================
// 🧠 SETTINGS CACHE (In-Memory Optimization)
// =============================================================================

const SettingsCache = {
  data: null,
  lastFetch: 0,
  TTL: 60 * 1000, // 1 минута

  async get() {
    const now = Date.now();
    if (this.data && now - this.lastFetch < this.TTL) {
      return this.data;
    }

    try {
      const res = await query("SELECT key, value FROM settings");
      const settings = {};
      res.rows.forEach((row) => {
        // Конвертируем numeric/text в число
        settings[row.key] = parseFloat(row.value);
      });

      this.data = settings;
      this.lastFetch = now;
      return settings;
    } catch (e) {
      console.error("Failed to load settings", e);
      return this.data || {}; // Возвращаем старый кэш или пустоту, чтобы не крашить бота
    }
  },

  invalidate() {
    this.data = null;
  },
};

// =============================================================================
// 🏛 REPOSITORIES
// =============================================================================

export const db = {
  query,
  transaction,
  pool, // Экспортируем для Graceful Shutdown

  // --- Настройки ---
  getSettings: () => SettingsCache.get(),

  updateSetting: async (key, value) => {
    await query(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
      [key, value],
    );
    SettingsCache.invalidate(); // Сброс кэша
  },

  // --- Пользователи ---
  upsertUser: async (telegramId, firstName, username, phone = null) => {
    let role = "client";
    // Если ID совпадает с владельцем из конфига - даем права админа сразу
    if (telegramId === config.bot.ownerId) role = "admin";

    const sql = `
            INSERT INTO users (telegram_id, first_name, username, phone, role, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
            ON CONFLICT (telegram_id) DO UPDATE SET 
                first_name = EXCLUDED.first_name,
                username = EXCLUDED.username,
                phone = COALESCE(EXCLUDED.phone, users.phone),
                role = CASE WHEN users.role = 'client' AND $5 = 'admin' THEN 'admin' ELSE users.role END, -- Не понижаем права случайно
                updated_at = NOW()
            RETURNING telegram_id, role, first_name, username, phone;
        `;
    const res = await query(sql, [
      telegramId,
      firstName,
      username,
      phone,
      role,
    ]);
    return res.rows[0];
  },

  getEmployees: async () => {
    const res = await query(
      "SELECT * FROM users WHERE role IN ('admin', 'manager') ORDER BY role, first_name",
    );
    return res.rows;
  },

  // --- Заказы ---
  /**
   * Создает заказ.
   * @param {object} orderData - Данные заказа
   * @param {object} detailsSnapshot - JSON объект с детальным расчетом (чтобы цена не менялась при смене тарифов)
   */
  createOrder: async (userId, orderData, detailsSnapshot) => {
    const sql = `
            INSERT INTO orders (
                user_id, status, 
                city, service_type, 
                details, -- JSONB snapshot
                total_price, 
                created_at, updated_at
            ) VALUES ($1, 'new', $2, $3, $4, $5, NOW(), NOW())
            RETURNING id;
        `;

    // detailsSnapshot содержит { breakdown, params }
    const res = await query(sql, [
      userId,
      orderData.city || "Не указан",
      orderData.serviceType || "electric",
      JSON.stringify(detailsSnapshot),
      detailsSnapshot.totals.grandTotal, // Итоговая сумма
    ]);
    return res.rows[0];
  },

  getOrders: async (limit = 50) => {
    const sql = `
            SELECT o.*, u.username, u.first_name, u.phone 
            FROM orders o
            LEFT JOIN users u ON o.user_id = u.telegram_id
            ORDER BY o.created_at DESC 
            LIMIT $1
        `;
    const res = await query(sql, [limit]);
    return res.rows;
  },

  updateOrderStatus: async (id, status) => {
    await query(
      "UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2",
      [status, id],
    );
  },

  // --- Финансы (Кассы и Транзакции) ---
  getAccounts: async (ownerId = null) => {
    let sql = "SELECT * FROM accounts";
    let params = [];

    // Если передан ownerId, показываем только его кассы + общие
    // Но для админа показываем все. Логику фильтрации лучше вынести в Service, здесь DAL отдает данные.
    // Сейчас реализуем базовый фильтр:
    if (ownerId) {
      sql += " WHERE owner_id = $1 OR owner_id IS NULL";
      params.push(ownerId);
    }
    sql += " ORDER BY id ASC";

    const res = await query(sql, params);
    return res.rows;
  },

  createTransaction: async ({
    accountId,
    amount,
    type,
    category,
    comment,
    userId,
  }) => {
    return transaction(async (client) => {
      const op = type === "income" ? "+" : "-";

      // 1. Атомарное обновление баланса
      const updateRes = await client.query(
        `UPDATE accounts SET balance = balance ${op} $1, updated_at = NOW() WHERE id = $2 RETURNING balance`,
        [amount, accountId],
      );

      if (updateRes.rowCount === 0) throw new Error("Account not found");

      // 2. Лог транзакции
      await client.query(
        `INSERT INTO transactions 
                (account_id, user_id, amount, type, category, comment, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [accountId, userId || null, amount, type, category, comment],
      );

      return updateRes.rows[0].balance;
    });
  },
};

// =============================================================================
// 🔥 MIGRATION SYSTEM
// =============================================================================

export const initDB = async () => {
  console.log("⏳ [DB] Starting Schema Synchronization...");

  try {
    await transaction(async (client) => {
      // 1. Users
      await client.query(`
                CREATE TABLE IF NOT EXISTS users (
                    telegram_id BIGINT PRIMARY KEY,
                    username TEXT,
                    first_name TEXT,
                    phone TEXT,
                    role TEXT DEFAULT 'client', -- client, admin, manager
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            `);

      // 2. Orders (Updated structure for Granular Pricing)
      await client.query(`
                CREATE TABLE IF NOT EXISTS orders (
                    id SERIAL PRIMARY KEY,
                    user_id BIGINT REFERENCES users(telegram_id),
                    city TEXT,
                    service_type TEXT,
                    details JSONB, -- Хранит breakdown, points, meters
                    status TEXT DEFAULT 'new', -- new, in_progress, completed, canceled
                    total_price NUMERIC DEFAULT 0,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            `);

      // 3. Accounts (Кассы)
      await client.query(`
                CREATE TABLE IF NOT EXISTS accounts (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    balance NUMERIC DEFAULT 0,
                    type TEXT DEFAULT 'cash',
                    owner_id BIGINT,
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            `);

      // 4. Transactions
      await client.query(`
                CREATE TABLE IF NOT EXISTS transactions (
                    id SERIAL PRIMARY KEY,
                    account_id INTEGER REFERENCES accounts(id),
                    user_id BIGINT,
                    amount NUMERIC NOT NULL,
                    type TEXT NOT NULL, -- income, expense
                    category TEXT,
                    comment TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                );
            `);

      // 5. Settings (Dynamic Pricing)
      await client.query(`
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value NUMERIC NOT NULL,
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            `);

      // --- SEEDING (Дефолтные цены) ---
      const defaultPrices = {
        // Черновые
        price_strobe_concrete: 1750,
        price_strobe_brick: 1100,
        price_cable_laying: 400,
        price_drill_hole_concrete: 1500,
        price_drill_hole_brick: 1000,
        price_socket_box_install: 600,
        price_junction_box_assembly: 3000,
        // Чистовые
        price_socket_install: 1000,
        price_shield_module: 1750,
        price_lamp_install: 5000,
        price_led_strip: 2000,
        // Система
        material_factor: 0.45,
      };

      for (const [key, value] of Object.entries(defaultPrices)) {
        await client.query(
          "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
          [key, value],
        );
      }
    });

    console.log("✅ [DB] Schema Synced & Ready.");
  } catch (e) {
    console.error("💥 [DB FATAL] Migration Failed:", e);
    process.exit(1);
  }
};

// =============================================================================
// 🛑 GRACEFUL SHUTDOWN
// =============================================================================

process.on("SIGTERM", async () => {
  console.log("🛑 [DB] Closing connection pool...");
  await pool.end();
});

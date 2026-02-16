/**
 * @file src/db.js
 * @description Ядро Базы Данных (PostgreSQL).
 * Enterprise-level архитектура для финансового учета и управления заказами.
 * @version 7.0.0 (ProElectro Ultimate)
 */

import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

// Настройка пула с агрессивным восстановлением соединений
const pool = new Pool({
  ...config.db,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Кэш настроек (цен) для снижения нагрузки на БД
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_TTL = 60 * 1000; // 1 минута

pool.on("error", (err) =>
  console.error("💥 [DB CRITICAL] Unexpected error on idle client", err),
);

// =============================================================================
// 🛠 LOW-LEVEL UTILS
// =============================================================================

const query = async (text, params) => pool.query(text, params);

/**
 * Выполняет callback внутри SQL-транзакции.
 * Если ошибка -> ROLLBACK. Если успех -> COMMIT.
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
    throw e;
  } finally {
    client.release();
  }
};

// =============================================================================
// 🚀 DATA ACCESS LAYER (DAL)
// =============================================================================

export const db = {
  query,
  transaction,

  /**
   * Получить настройки (Цены) с кэшированием
   */
  getSettings: async () => {
    if (settingsCache && Date.now() - settingsCacheTime < CACHE_TTL)
      return settingsCache;
    try {
      const res = await query("SELECT key, value FROM settings");
      const settings = {};
      res.rows.forEach(
        (row) => (settings[row.key] = parseFloat(row.value) || row.value),
      );
      settingsCache = settings;
      settingsCacheTime = Date.now();
      return settings;
    } catch (e) {
      console.error("⚠️ [DB] Failed to fetch settings", e);
      return {};
    }
  },

  /**
   * Создать или Обновить пользователя (Upsert)
   */
  upsertUser: async (telegramId, firstName, username, phone = null) => {
    const sql = `
            INSERT INTO users (telegram_id, first_name, username, phone, created_at, updated_at)
            VALUES ($1, $2, $3, $4, NOW(), NOW())
            ON CONFLICT (telegram_id) DO UPDATE SET 
                first_name = EXCLUDED.first_name,
                username = EXCLUDED.username,
                phone = COALESCE(EXCLUDED.phone, users.phone), 
                updated_at = NOW()
            RETURNING telegram_id, role, first_name, username, phone;
        `;
    const res = await query(sql, [telegramId, firstName, username, phone]);
    return res.rows[0];
  },

  /**
   * Создать новый ЗАКАЗ (Лид + Объект)
   * Используется для Калькулятора
   */
  createOrder: async (userId, orderData) => {
    const { area, rooms, wallType, estimatedPrice } = orderData;
    // Создаем сразу в orders, минуя лишнюю таблицу leads (оптимизация)
    const sql = `
        INSERT INTO orders (
            user_id, status, area, rooms, wall_type, 
            total_price, created_at, updated_at
        ) VALUES ($1, 'new', $2, $3, $4, $5, NOW(), NOW())
        RETURNING id;
    `;
    const res = await query(sql, [
      userId,
      area,
      rooms,
      wallType,
      estimatedPrice,
    ]);
    return res.rows[0];
  },

  /**
   * Добавить расход ПО ОБЪЕКТУ (Материал, Такси)
   * Влияет на чистую прибыль объекта.
   */
  addObjectExpense: async (orderId, amount, category, comment) => {
    const sql = `
        INSERT INTO object_expenses (order_id, amount, category, comment, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING id;
    `;
    return query(sql, [orderId, amount, category, comment]);
  },

  /**
   * Получить список кошельков (Кассы)
   */
  getAccounts: async () => {
    const res = await query("SELECT * FROM accounts ORDER BY id ASC");
    return res.rows;
  },

  /**
   * 💰 ГЛАВНАЯ ФИНАНСОВАЯ ОПЕРАЦИЯ
   * Изменяет баланс кошелька + пишет лог в историю транзакций.
   * Атомарная операция.
   */
  updateBalance: async ({
    accountId,
    amount,
    type,
    category,
    comment,
    userId,
  }) => {
    return transaction(async (client) => {
      const op = type === "income" ? "+" : "-";

      // 1. Обновляем баланс
      const updateRes = await client.query(
        `UPDATE accounts SET balance = balance ${op} $1, updated_at = NOW() WHERE id = $2 RETURNING balance`,
        [amount, accountId],
      );

      if (updateRes.rowCount === 0) throw new Error("Account not found");

      // 2. Пишем в историю (Audit Log)
      await client.query(
        `INSERT INTO transactions (account_id, user_id, amount, type, category, comment, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [accountId, userId || null, amount, type, category, comment],
      );

      return updateRes.rows[0].balance;
    });
  },
};

// =============================================================================
// 🔥 INITIALIZATION & MIGRATIONS
// =============================================================================

export const initDB = async () => {
  console.log("⏳ [DB] Verifying Schema Integrity...");
  try {
    await transaction(async (client) => {
      // 1. Users (Сотрудники и Клиенты)
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

      // 2. Orders (Заказы / Объекты)
      // Хранит всю инфу для расчета и аналитики
      await client.query(`
        CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY,
            user_id BIGINT REFERENCES users(telegram_id),
            assignee_id BIGINT, -- Ответственный мастер
            status TEXT DEFAULT 'new', -- new, discuss, work, done, cancel
            
            -- Технические данные
            area NUMERIC,
            rooms INTEGER,
            wall_type TEXT, -- concrete, brick, gasblock
            
            -- Финансы
            total_price NUMERIC DEFAULT 0, -- Общая сумма договора
            final_profit NUMERIC DEFAULT 0, -- Чистая прибыль (Факт - Расходы)
            
            -- Даты
            start_date TIMESTAMP,
            end_date TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // 3. Object Expenses (Расходы Объекта)
      // Вычитаются из прибыли конкретного заказа
      await client.query(`
        CREATE TABLE IF NOT EXISTS object_expenses (
            id SERIAL PRIMARY KEY,
            order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
            amount NUMERIC NOT NULL,
            category TEXT, -- material, taxi, delivery, consumables
            comment TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // 4. Accounts (Кассы)
      await client.query(`
        CREATE TABLE IF NOT EXISTS accounts (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            balance NUMERIC DEFAULT 0,
            type TEXT DEFAULT 'cash', -- cash, bank, safe
            updated_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // 5. Transactions (Общие расходы бизнеса + ЗП + История)
      await client.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            account_id INTEGER REFERENCES accounts(id),
            user_id BIGINT, -- Кто совершил (необязательно)
            amount NUMERIC NOT NULL,
            type TEXT NOT NULL, -- income, expense
            category TEXT, -- salary, tools, rent, food, transfer
            comment TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // 6. Settings (Цены на работы)
      await client.query(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value NUMERIC NOT NULL,
            updated_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // --- SEEDING (Начальное заполнение) ---

      // Кошельки
      const accs = await client.query("SELECT COUNT(*) FROM accounts");
      if (accs.rows[0].count == 0) {
        await client.query(`
            INSERT INTO accounts (name, type) VALUES 
            ('Kaspi Gold', 'bank'), 
            ('Наличные', 'cash'), 
            ('Сейф (Офис)', 'safe')
        `);
        console.log("🌱 [DB] Created default accounts");
      }

      // Цены (Based on your Provided Table)
      // Используем средние значения для калькулятора
      const prices = [
        ["price_strobe_concrete", 1750], // Штроба бетон (1500-2000)
        ["price_strobe_brick", 1100], // Штроба кирпич (1000-1200)
        ["price_strobe_gasblock", 800], // Штроба легкая

        ["price_point_concrete", 1500], // Лунка бетон
        ["price_point_brick", 1000], // Лунка кирпич
        ["price_point_gasblock", 800], // Лунка легкая

        ["price_box_install", 600], // Вмазка подрозетника (500-700)
        ["price_box_assembly", 3000], // Сборка распред. коробки (2500-3500)
        ["price_shield_module", 1750], // Модуль щита (1500-2000)
        ["price_socket_install", 1000], // Установка розетки (800-1200)
        ["price_cable_m", 400], // Кабель (300-500)

        // Проценты распределения
        ["percent_business", 20],
        ["percent_staff", 80],
      ];

      for (const [k, v] of prices) {
        await client.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
          [k, v],
        );
      }
    });

    console.log("✅ [DB] System Ready & Migrated.");
  } catch (e) {
    console.error("💥 [DB FATAL] Migration Failed:", e);
    process.exit(1);
  }
};

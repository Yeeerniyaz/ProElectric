/**
 * @file src/db.js
 * @description Ядро Базы Данных (PostgreSQL).
 * Enterprise-level архитектура для финансового учета, управления заказами и мульти-касс.
 * @version 8.1.0 (Detailed Pricing Support)
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
   * Автоматически выдает админку владельцу.
   */
  upsertUser: async (telegramId, firstName, username, phone = null) => {
    // Если это Владелец, роль всегда admin
    let role = 'client';
    if (telegramId === config.bot.ownerId) role = 'admin';

    const sql = `
            INSERT INTO users (telegram_id, first_name, username, phone, role, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
            ON CONFLICT (telegram_id) DO UPDATE SET 
                first_name = EXCLUDED.first_name,
                username = EXCLUDED.username,
                phone = COALESCE(EXCLUDED.phone, users.phone), 
                updated_at = NOW()
            RETURNING telegram_id, role, first_name, username, phone;
        `;
    const res = await query(sql, [telegramId, firstName, username, phone, role]);
    return res.rows[0];
  },

  /**
   * Назначить роль пользователю + Создать личную кассу
   */
  promoteUser: async (targetId, newRole, name) => {
      // 1. Обновляем роль
      await query("UPDATE users SET role = $1 WHERE telegram_id = $2", [newRole, targetId]);
      
      // 2. Если роль admin/manager — создаем личную кассу (если нет)
      if (['admin', 'manager'].includes(newRole)) {
          const accRes = await query("SELECT id FROM accounts WHERE owner_id = $1", [targetId]);
          if (accRes.rows.length === 0) {
              await query(
                  "INSERT INTO accounts (name, type, balance, owner_id) VALUES ($1, 'cash', 0, $2)",
                  [`Касса: ${name}`, targetId]
              );
          }
      }
  },

  /**
   * Получить список сотрудников
   */
  getEmployees: async () => {
      const res = await query("SELECT * FROM users WHERE role IN ('admin', 'manager') ORDER BY role");
      return res.rows;
  },

  /**
   * Создать новый ЗАКАЗ (Лид + Объект)
   */
  createOrder: async (userId, orderData) => {
    const { area, rooms, wallType, estimatedPrice } = orderData;
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
   * Админ видит всё, Менеджер — только свои.
   */
  getAccounts: async (userId = null, role = 'admin') => {
    let sql = "SELECT * FROM accounts";
    let params = [];

    if (role !== 'admin' && userId) {
        sql += " WHERE owner_id = $1"; // Личная касса
        params.push(userId);
    }
    
    sql += " ORDER BY id ASC";
    const res = await query(sql, params);
    return res.rows;
  },

  /**
   * Получить KPI (для админки)
   */
  getKPI: async () => {
    const rev = await query("SELECT SUM(final_price) as val FROM orders WHERE status='done'");
    const prof = await query("SELECT SUM(final_profit) as val FROM orders WHERE status='done'");
    const active = await query("SELECT COUNT(*) as val FROM orders WHERE status IN ('work','discuss')");
    return {
        revenue: parseFloat(rev.rows[0].val || 0),
        profit: parseFloat(prof.rows[0].val || 0),
        active: parseInt(active.rows[0].val || 0)
    };
  },

  /**
   * 💰 ГЛАВНАЯ ФИНАНСОВАЯ ОПЕРАЦИЯ
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

      // 2. Пишем в историю
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

      // 2. Orders
      await client.query(`
        CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY,
            user_id BIGINT REFERENCES users(telegram_id),
            assignee_id BIGINT, 
            status TEXT DEFAULT 'new',
            area NUMERIC,
            rooms INTEGER,
            wall_type TEXT, 
            total_price NUMERIC DEFAULT 0,
            final_price NUMERIC DEFAULT 0,
            final_profit NUMERIC DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // 3. Expenses
      await client.query(`
        CREATE TABLE IF NOT EXISTS object_expenses (
            id SERIAL PRIMARY KEY,
            order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
            amount NUMERIC NOT NULL,
            category TEXT,
            comment TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // 4. Accounts (С полем owner_id!)
      await client.query(`
        CREATE TABLE IF NOT EXISTS accounts (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            balance NUMERIC DEFAULT 0,
            type TEXT DEFAULT 'cash',
            owner_id BIGINT, -- Привязка к сотруднику
            updated_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // 5. Transactions
      await client.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            account_id INTEGER REFERENCES accounts(id),
            user_id BIGINT,
            amount NUMERIC NOT NULL,
            type TEXT NOT NULL, 
            category TEXT,
            comment TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // 6. Settings
      await client.query(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value NUMERIC NOT NULL,
            updated_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // --- SEEDING (Начальное заполнение цен) ---
      // Здесь добавлены все новые пункты из вашего прайса
      const prices = [
        // Черновые
        ["price_strobe_concrete", 1750], 
        ["price_strobe_brick", 1100], 
        ["price_cable_laying", 400],         // Прокладка кабеля
        ["price_drill_hole_concrete", 1500], // Сверление лунки (Бетон)
        ["price_drill_hole_brick", 1000],    // Сверление лунки (Кирпич)
        ["price_socket_box_install", 600],   // Вмазка подрозетника
        ["price_junction_box_assembly", 3000], // Сборка распредкоробки
        
        // Чистовые
        ["price_socket_install", 1000],      // Розетка/выкл
        ["price_shield_module", 1750],       // Модуль щита
        ["price_lamp_install", 5000],        // Люстра
        ["price_led_strip", 2000],           // Лента
        
        // Система
        ["material_factor", 0.45],           // Материалы 45%
        ["percent_business", 20]             // Доля бизнеса 20%
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
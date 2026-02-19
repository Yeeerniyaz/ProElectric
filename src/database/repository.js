/**
 * @file src/database/repository.js
 * @description Слой репозитория (Data Access Layer v9.2.0).
 * Содержит коллекцию готовых методов для работы с БД.
 * Внедрен глобальный финансовый модуль (Корпоративная касса, счета, транзакции).
 *
 * Архитектура: Repository Pattern.
 *
 * @module Repository
 * @version 9.2.0 (Enterprise Finance Edition)
 */

import { query, getClient } from "./connection.js";

// =============================================================================
// ⚙️ SETTINGS (DYNAMIC PRICING & CONFIG)
// =============================================================================

export const getSettings = async () => {
  const sql = "SELECT key, value FROM settings";
  const { rows } = await query(sql);

  const settings = {};
  for (const row of rows) {
    const numVal = parseFloat(row.value);
    settings[row.key] = isNaN(numVal) ? row.value : numVal;
  }
  return settings;
};

export const saveSetting = async (key, value) => {
  const sql = `
    INSERT INTO settings (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET 
      value = EXCLUDED.value,
      updated_at = NOW()
    RETURNING *
  `;
  const res = await query(sql, [key, String(value)]);
  return res.rows[0];
};

export const saveBulkSettings = async (settingsArray) => {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    for (const item of settingsArray) {
      if (item.key && item.value !== undefined) {
        await client.query(
          `INSERT INTO settings (key, value, updated_at) 
           VALUES ($1, $2, NOW()) 
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [item.key, String(item.value)],
        );
      }
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`Ошибка массового обновления настроек: ${error.message}`);
  } finally {
    client.release();
  }
};

// =============================================================================
// 👤 USERS REPOSITORY (CRM)
// =============================================================================

export const findUserById = async (telegramId) => {
  const sql = "SELECT * FROM users WHERE telegram_id = $1";
  const res = await query(sql, [telegramId]);
  return res.rows[0];
};

export const upsertUser = async ({ id, first_name, username }) => {
  const safeName = first_name || "Пользователь";
  const safeUsername = username || null;

  const sql = `
    INSERT INTO users (telegram_id, first_name, username, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (telegram_id) DO UPDATE SET 
      first_name = EXCLUDED.first_name,
      username = EXCLUDED.username,
      updated_at = NOW()
    RETURNING *
  `;
  const res = await query(sql, [id, safeName, safeUsername]);
  return res.rows[0];
};

export const updateUserPhone = async (userId, phone) => {
  const sql =
    "UPDATE users SET phone = $1, updated_at = NOW() WHERE telegram_id = $2 RETURNING *";
  const res = await query(sql, [phone, userId]);
  return res.rows[0];
};

export const updateUserRole = async (userId, newRole) => {
  const sql =
    "UPDATE users SET role = $1, updated_at = NOW() WHERE telegram_id = $2 RETURNING *";
  const res = await query(sql, [newRole, userId]);
  return res.rows[0];
};

export const getAllUsers = async (limit = 50, offset = 0) => {
  const sql = `
    SELECT telegram_id, first_name, username, phone, role, created_at, updated_at 
    FROM users 
    ORDER BY created_at DESC 
    LIMIT $1 OFFSET $2
  `;
  const res = await query(sql, [limit, offset]);
  return res.rows;
};

// =============================================================================
// 📦 ORDERS REPOSITORY (BUSINESS CORE)
// =============================================================================

export const createOrder = async (userId, data) => {
  const sql = `
    INSERT INTO orders (id, user_id, total_price, area, details, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, 'new', NOW(), NOW())
    RETURNING *
  `;

  const area =
    data.area ||
    (data.details && data.details.params ? data.details.params.area : 0);

  // Передаем data.id (те самые 6 цифр из OrderService) первым аргументом
  const res = await query(sql, [
    data.id, // $1 - Случайный ID
    userId, // $2
    data.price, // $3
    area, // $4
    data.details || {}, // $5
  ]);

  return res.rows[0];
};

export const getOrderById = async (orderId) => {
  const sql = "SELECT * FROM orders WHERE id = $1";
  const res = await query(sql, [orderId]);
  return res.rows[0];
};

export const updateOrderStatus = async (orderId, status) => {
  const sql =
    "UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *";
  const res = await query(sql, [status, orderId]);
  return res.rows[0];
};

export const updateOrderDetails = async (orderId, details, totalPrice) => {
  const sql = `
    UPDATE orders 
    SET details = $1, total_price = $2, updated_at = NOW() 
    WHERE id = $3 
    RETURNING *
  `;
  const res = await query(sql, [details, totalPrice, orderId]);
  return res.rows[0];
};

export const getUserOrders = async (userId, limit = 20) => {
  const sql = `
    SELECT * FROM orders 
    WHERE user_id = $1 
    ORDER BY created_at DESC 
    LIMIT $2
  `;
  const res = await query(sql, [userId, limit]);
  return res.rows;
};

// =============================================================================
// 💸 CORPORATE FINANCE REPOSITORY (GLOBAL CASHBOX v10.0)
// =============================================================================

/**
 * Получить список всех счетов (касс). Автоматически создает "Главную кассу", если счетов нет.
 */
export const getAccounts = async () => {
  let res = await query("SELECT * FROM accounts ORDER BY id ASC");

  // Self-Healing: Если в базе нет счетов, создаем системный по умолчанию
  if (res.rows.length === 0) {
    await query(
      `INSERT INTO accounts (name, type, balance, created_at, updated_at) VALUES ('Главная Касса (Наличные)', 'cash', 0, NOW(), NOW())`,
    );
    await query(
      `INSERT INTO accounts (name, type, balance, created_at, updated_at) VALUES ('Расчетный счет (Безнал)', 'card', 0, NOW(), NOW())`,
    );
    res = await query("SELECT * FROM accounts ORDER BY id ASC");
  }

  return res.rows;
};

/**
 * Получить историю глобальных транзакций компании.
 */
export const getCompanyTransactions = async (limit = 100) => {
  const sql = `
    SELECT t.*, a.name as account_name, u.first_name as user_name
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN users u ON t.user_id = u.telegram_id
    ORDER BY t.created_at DESC
    LIMIT $1
  `;
  const res = await query(sql, [limit]);
  return res.rows;
};

/**
 * Добавление транзакции и пересчет баланса счета (Строгая транзакция).
 * @param {Object} data - { accountId, userId, amount, type ('income'|'expense'), category, comment }
 */
export const addCompanyTransaction = async ({
  accountId,
  userId,
  amount,
  type,
  category,
  comment,
}) => {
  const client = await getClient();
  try {
    await client.query("BEGIN");

    // 1. Записываем операцию
    const sqlTx = `
      INSERT INTO transactions (account_id, user_id, amount, type, category, comment, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *
    `;
    const resTx = await client.query(sqlTx, [
      accountId,
      userId,
      amount,
      type,
      category,
      comment,
    ]);
    const transaction = resTx.rows[0];

    // 2. Обновляем баланс счета
    const operator = type === "income" ? "+" : "-";
    const sqlAcc = `
      UPDATE accounts 
      SET balance = balance ${operator} $1, updated_at = NOW() 
      WHERE id = $2 
      RETURNING balance
    `;
    await client.query(sqlAcc, [amount, accountId]);

    await client.query("COMMIT");
    return transaction;
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`Ошибка проведения транзакции: ${error.message}`);
  } finally {
    client.release();
  }
};

/**
 * Добавление расхода к объекту.
 * Теперь это изолированная функция конкретного объекта (уже работает).
 */
export const addOrderExpense = async (orderId, amount, category, comment) => {
  const sql = `
    INSERT INTO object_expenses (order_id, amount, category, comment, created_at)
    VALUES ($1, $2, $3, $4, NOW())
    RETURNING *
  `;
  const res = await query(sql, [orderId, amount, category, comment]);
  return res.rows[0];
};

// =============================================================================
// 📊 ANALYTICS & DASHBOARD
// =============================================================================

export const getGlobalStats = async () => {
  const sqlUsers = "SELECT COUNT(*) as count FROM users";
  const sqlRevenue =
    "SELECT SUM(total_price) as sum FROM orders WHERE status = 'done'";
  const sqlActive =
    "SELECT COUNT(*) as count FROM users WHERE updated_at > NOW() - INTERVAL '24 hours'";

  const [resUsers, resRevenue, resActive] = await Promise.all([
    query(sqlUsers),
    query(sqlRevenue),
    query(sqlActive),
  ]);

  return {
    totalUsers: parseInt(resUsers.rows[0].count),
    totalRevenue: parseFloat(resRevenue.rows[0].sum || 0),
    active24h: parseInt(resActive.rows[0].count),
  };
};

export const getOrdersFunnel = async () => {
  const sql = `
    SELECT status, COUNT(*) as count, SUM(total_price) as sum
    FROM orders
    GROUP BY status
  `;
  const res = await query(sql);
  return res.rows;
};

/**
 * @file src/database/repository.js
 * @description Слой репозитория (Data Access Layer v10.9.12).
 * Содержит коллекцию готовых методов для работы с БД.
 * Внедрен глобальный финансовый модуль, система управления Бригадами (ERP),
 * распределение прибыли и Web OTP авторизация.
 * ДОБАВЛЕНО: Интеллектуальный парсинг дат (startDate, endDate) для всех аналитических выборок.
 *
 * Архитектура: Repository Pattern. Строгие транзакции (ACID) для финансов.
 *
 * @module Repository
 * @version 10.9.12 (Enterprise ERP Edition - Time-Series Analytics)
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
// 👤 USERS REPOSITORY (CRM & WEB AUTH)
// =============================================================================

export const findUserById = async (telegramId) => {
  const sql = "SELECT * FROM users WHERE telegram_id = $1";
  const res = await query(sql, [telegramId]);
  return res.rows[0];
};

export const getSystemOwnerId = async () => {
  const sql = "SELECT telegram_id FROM users WHERE role = 'owner' LIMIT 1";
  const res = await query(sql);
  return res.rows.length > 0 ? res.rows[0].telegram_id : null;
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

// --- WEB OTP AUTHENTICATION ---

export const setWebPassword = async (
  telegramId,
  otpHash,
  expiresInMinutes = 15,
) => {
  const sql = `
    UPDATE users 
    SET web_password = $1, web_password_expires = NOW() + INTERVAL '${expiresInMinutes} minutes'
    WHERE telegram_id = $2
    RETURNING *
  `;
  const res = await query(sql, [otpHash, telegramId]);
  return res.rows[0];
};

export const getWebAuthUser = async (phone) => {
  const cleanPhone = phone.replace(/\D/g, "");
  const sql = `
    SELECT * FROM users 
    WHERE REGEXP_REPLACE(phone, '\\D', '', 'g') LIKE '%' || $1
    AND web_password_expires > NOW()
  `;
  const res = await query(sql, [cleanPhone]);
  return res.rows[0];
};

export const clearWebPassword = async (telegramId) => {
  const sql =
    "UPDATE users SET web_password = NULL, web_password_expires = NULL WHERE telegram_id = $1";
  await query(sql, [telegramId]);
};

// =============================================================================
// 📦 ORDERS REPOSITORY (BUSINESS CORE & BRIGADE ASSIGNMENT)
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
  const res = await query(sql, [
    data.id,
    userId,
    data.price,
    area,
    data.details || {},
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
  const sql = `UPDATE orders SET details = $1, total_price = $2, updated_at = NOW() WHERE id = $3 RETURNING *`;
  const res = await query(sql, [details, totalPrice, orderId]);
  return res.rows[0];
};

export const getUserOrders = async (userId, limit = 20) => {
  const sql = `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`;
  const res = await query(sql, [userId, limit]);
  return res.rows;
};

export const getAvailableNewOrders = async () => {
  const sql = `SELECT * FROM orders WHERE status = 'new' ORDER BY created_at ASC`;
  const res = await query(sql);
  return res.rows;
};

export const getBrigadeOrders = async (brigadeId) => {
  const sql = `SELECT * FROM orders WHERE brigade_id = $1 ORDER BY created_at DESC`;
  const res = await query(sql, [brigadeId]);
  return res.rows;
};

export const assignOrderToBrigade = async (orderId, brigadeId) => {
  const sql = `UPDATE orders SET brigade_id = $1, status = 'work', updated_at = NOW() WHERE id = $2 AND status = 'new' RETURNING *`;
  const res = await query(sql, [brigadeId, orderId]);
  return res.rows[0];
};

export const getOrderExpenses = async (orderId) => {
  const sql =
    "SELECT * FROM object_expenses WHERE order_id = $1 ORDER BY created_at DESC";
  const res = await query(sql, [orderId]);
  return res.rows;
};

// =============================================================================
// 🛠 BRIGADES REPOSITORY (ERP CORE)
// =============================================================================

export const createBrigade = async (name, brigadierId, profitPercentage) => {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const sqlBrigade = `INSERT INTO brigades (name, brigadier_id, profit_percentage, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *`;
    const resBrigade = await client.query(sqlBrigade, [
      name,
      brigadierId,
      profitPercentage,
    ]);
    const brigade = resBrigade.rows[0];

    const sqlAccount = `INSERT INTO accounts (user_id, name, type, balance, created_at, updated_at) VALUES ($1, $2, 'brigade_acc', 0, NOW(), NOW())`;
    await client.query(sqlAccount, [brigadierId, `Счет бригады: ${name}`]);

    await client.query(
      "UPDATE users SET role = 'manager' WHERE telegram_id = $1 AND role = 'user'",
      [brigadierId],
    );
    await client.query("COMMIT");
    return brigade;
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`Ошибка создания бригады: ${error.message}`);
  } finally {
    client.release();
  }
};

export const getBrigades = async () => {
  const sql = "SELECT * FROM brigades ORDER BY id ASC";
  const res = await query(sql);
  return res.rows;
};

export const getBrigadeByManagerId = async (telegramId) => {
  const sql = "SELECT * FROM brigades WHERE brigadier_id = $1 LIMIT 1";
  const res = await query(sql, [telegramId]);
  return res.rows[0];
};

export const updateBrigade = async (brigadeId, profitPercentage, isActive) => {
  const sql = `UPDATE brigades SET profit_percentage = COALESCE($1, profit_percentage), is_active = COALESCE($2, is_active), updated_at = NOW() WHERE id = $3 RETURNING *`;
  const res = await query(sql, [profitPercentage, isActive, brigadeId]);
  return res.rows[0];
};

// =============================================================================
// 💸 CORPORATE FINANCE REPOSITORY (GLOBAL CASHBOX)
// =============================================================================

export const getAccounts = async () => {
  let res = await query(
    "SELECT * FROM accounts WHERE type != 'brigade_acc' ORDER BY id ASC",
  );
  if (res.rows.length === 0) {
    await query(
      `INSERT INTO accounts (name, type, balance, created_at, updated_at) VALUES ('Главная Касса (Наличные)', 'cash', 0, NOW(), NOW())`,
    );
    await query(
      `INSERT INTO accounts (name, type, balance, created_at, updated_at) VALUES ('Расчетный счет (Безнал)', 'card', 0, NOW(), NOW())`,
    );
    res = await query(
      "SELECT * FROM accounts WHERE type != 'brigade_acc' ORDER BY id ASC",
    );
  }
  return res.rows;
};

export const getCompanyTransactions = async (limit = 100) => {
  const sql = `
    SELECT t.*, a.name as account_name, u.first_name as user_name
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN users u ON t.user_id = u.telegram_id
    WHERE a.type != 'brigade_acc'
    ORDER BY t.created_at DESC LIMIT $1
  `;
  const res = await query(sql, [limit]);
  return res.rows;
};

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
    const sqlTx = `INSERT INTO transactions (account_id, user_id, amount, type, category, comment, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`;
    const resTx = await client.query(sqlTx, [
      accountId,
      userId,
      amount,
      type,
      category,
      comment,
    ]);

    const operator = type === "income" ? "+" : "-";
    await client.query(
      `UPDATE accounts SET balance = balance ${operator} $1, updated_at = NOW() WHERE id = $2`,
      [amount, accountId],
    );
    await client.query("COMMIT");
    return resTx.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`Ошибка проведения транзакции: ${error.message}`);
  } finally {
    client.release();
  }
};

export const addOrderExpense = async (orderId, amount, category, comment) => {
  const sql = `INSERT INTO object_expenses (order_id, amount, category, comment, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *`;
  const res = await query(sql, [orderId, amount, category, comment]);
  return res.rows[0];
};

export const finalizeOrderAndDistributeProfit = async (orderId) => {
  const client = await getClient();
  try {
    await client.query("BEGIN");

    const sqlOrder = `SELECT o.total_price, o.brigade_id, b.profit_percentage, b.brigadier_id, b.name as brigade_name FROM orders o JOIN brigades b ON o.brigade_id = b.id WHERE o.id = $1 AND o.status = 'work'`;
    const resOrder = await client.query(sqlOrder, [orderId]);
    if (resOrder.rows.length === 0)
      throw new Error(
        "Заказ не найден, не привязан к бригаде или не в статусе 'work'",
      );
    const order = resOrder.rows[0];

    const resExp = await client.query(
      "SELECT COALESCE(SUM(amount), 0) as total_expenses FROM object_expenses WHERE order_id = $1",
      [orderId],
    );
    const totalExpenses = parseFloat(resExp.rows[0].total_expenses);
    const netProfit = parseFloat(order.total_price) - totalExpenses;

    if (netProfit <= 0)
      throw new Error(
        "Чистая прибыль отрицательная. Авто-распределение невозможно.",
      );

    const brigadeShare =
      netProfit * (parseFloat(order.profit_percentage) / 100);
    const ownerShare = netProfit - brigadeShare;

    const resBrigadeAcc = await client.query(
      "SELECT id FROM accounts WHERE user_id = $1 AND type = 'brigade_acc' LIMIT 1",
      [order.brigadier_id],
    );
    const brigadeAccountId = resBrigadeAcc.rows[0]?.id;
    if (!brigadeAccountId) throw new Error("Не найден системный счет бригады.");

    await client.query(
      "UPDATE accounts SET balance = balance + $1 - $2, updated_at = NOW() WHERE id = $3",
      [brigadeShare, netProfit, brigadeAccountId],
    );

    await client.query(
      "INSERT INTO transactions (account_id, user_id, amount, type, category, comment, order_id, created_at) VALUES ($1, $2, $3, 'income', 'Заработок', $4, $5, NOW())",
      [
        brigadeAccountId,
        order.brigadier_id,
        brigadeShare,
        `Доля ${order.profit_percentage}% за объект #${orderId}`,
        orderId,
      ],
    );
    await client.query(
      "INSERT INTO transactions (account_id, user_id, amount, type, category, comment, order_id, created_at) VALUES ($1, $2, $3, 'expense', 'Удержание', $4, $5, NOW())",
      [
        brigadeAccountId,
        order.brigadier_id,
        netProfit,
        `Наличные средства от клиента остались у вас (Долг Шефу)`,
        orderId,
      ],
    );

    await client.query(
      "UPDATE orders SET status = 'done', updated_at = NOW() WHERE id = $1",
      [orderId],
    );
    await client.query("COMMIT");
    return { netProfit, brigadeShare, ownerShare };
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`Ошибка распределения прибыли: ${error.message}`);
  } finally {
    client.release();
  }
};

export const processIncassation = async (
  brigadierId,
  amount,
  ownerAccountId,
) => {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const resBrigadeAcc = await client.query(
      "SELECT id FROM accounts WHERE user_id = $1 AND type = 'brigade_acc' LIMIT 1",
      [brigadierId],
    );
    const brigadeAccountId = resBrigadeAcc.rows[0]?.id;

    if (!brigadeAccountId || !ownerAccountId)
      throw new Error("Счет бригады или счет Владельца не найден.");

    await client.query(
      "UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2",
      [amount, brigadeAccountId],
    );
    await client.query(
      "INSERT INTO transactions (account_id, user_id, amount, type, category, comment, created_at) VALUES ($1, $2, $3, 'income', 'Инкассация', 'Передача выручки Шефу', NOW())",
      [brigadeAccountId, brigadierId, amount],
    );

    await client.query(
      "UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2",
      [amount, ownerAccountId],
    );
    await client.query(
      "INSERT INTO transactions (account_id, user_id, amount, type, category, comment, created_at) VALUES ($1, $2, $3, 'income', 'Инкассация', 'Получение выручки от бригады', NOW())",
      [ownerAccountId, brigadierId, amount],
    );

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`Ошибка проведения инкассации: ${error.message}`);
  } finally {
    client.release();
  }
};

// =============================================================================
// 📊 ADVANCED ANALYTICS (DYNAMIC BRIGADE & DATE FILTERING)
// =============================================================================

export const getGlobalStats = async (
  brigadeId = null,
  startDate = null,
  endDate = null,
) => {
  let dateFilterOrders = "";
  let dateFilterUsers = "";
  const dateParams = [];
  let pIdx = 1;

  if (startDate) {
    dateFilterOrders += ` AND created_at >= $${pIdx}`;
    dateFilterUsers += ` AND created_at >= $${pIdx}`;
    dateParams.push(startDate);
    pIdx++;
  }
  if (endDate) {
    dateFilterOrders += ` AND created_at <= $${pIdx}::date + interval '1 day' - interval '1 second'`;
    dateFilterUsers += ` AND created_at <= $${pIdx}::date + interval '1 day' - interval '1 second'`;
    dateParams.push(endDate);
    pIdx++;
  }

  if (brigadeId) {
    const pRevenue = [...dateParams, brigadeId];
    const pActive = [...dateParams, brigadeId];
    const sqlRevenue = `SELECT SUM(total_price) as sum FROM orders WHERE status = 'done' AND brigade_id = $${pRevenue.length} ${dateFilterOrders}`;
    const sqlActive = `SELECT COUNT(*) as count FROM orders WHERE status = 'work' AND brigade_id = $${pActive.length} ${dateFilterOrders}`;

    const [resRevenue, resActive] = await Promise.all([
      query(sqlRevenue, pRevenue),
      query(sqlActive, pActive),
    ]);
    return {
      totalUsers: 0,
      totalRevenue: parseFloat(resRevenue.rows[0]?.sum || 0),
      active24h: parseInt(resActive.rows[0]?.count || 0),
    };
  }

  const [resUsers, resRevenue, resActive] = await Promise.all([
    query(
      `SELECT COUNT(*) as count FROM users WHERE 1=1 ${dateFilterUsers}`,
      dateParams,
    ),
    query(
      `SELECT SUM(total_price) as sum FROM orders WHERE status = 'done' ${dateFilterOrders}`,
      dateParams,
    ),
    query(
      `SELECT COUNT(*) as count FROM users WHERE updated_at > NOW() - INTERVAL '24 hours'`,
    ),
  ]);
  return {
    totalUsers: parseInt(resUsers.rows[0].count),
    totalRevenue: parseFloat(resRevenue.rows[0].sum || 0),
    active24h: parseInt(resActive.rows[0].count),
  };
};

export const getOrdersFunnel = async (
  brigadeId = null,
  startDate = null,
  endDate = null,
) => {
  let sql = `SELECT status, COUNT(*) as count, SUM(total_price) as sum FROM orders WHERE 1=1`;
  const params = [];

  if (brigadeId) {
    params.push(brigadeId);
    sql += ` AND brigade_id = $${params.length}`;
  }
  if (startDate) {
    params.push(startDate);
    sql += ` AND created_at >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    sql += ` AND created_at <= $${params.length}::date + interval '1 day' - interval '1 second'`;
  }

  sql += ` GROUP BY status`;
  const res = await query(sql, params);
  return res.rows;
};

export const getDeepAnalyticsData = async (
  brigadeId = null,
  startDate = null,
  endDate = null,
) => {
  let avgSql = `SELECT COALESCE(AVG(total_price), 0) as avg_check, COALESCE(AVG(COALESCE((details->'financials'->>'net_profit')::numeric, total_price)), 0) as avg_margin FROM orders WHERE status = 'done'`;
  let expensesSql = `SELECT category, COALESCE(SUM(amount), 0) as total FROM object_expenses WHERE 1=1`;
  const params = [];
  const expParams = [];

  if (startDate) {
    params.push(startDate);
    avgSql += ` AND created_at >= $${params.length}`;
    expParams.push(startDate);
  }
  if (endDate) {
    params.push(endDate);
    avgSql += ` AND created_at <= $${params.length}::date + interval '1 day' - interval '1 second'`;
    expParams.push(endDate);
  }

  if (brigadeId) {
    params.push(brigadeId);
    avgSql += ` AND brigade_id = $${params.length}`;

    // Перестраиваем запрос расходов, если есть бригадир (через JOIN)
    expensesSql = `
      SELECT e.category, COALESCE(SUM(e.amount), 0) as total
      FROM object_expenses e JOIN orders o ON e.order_id = o.id
      WHERE o.brigade_id = $${expParams.length + 1}
    `;
    if (startDate) expensesSql += ` AND e.created_at >= $1`;
    if (endDate)
      expensesSql += ` AND e.created_at <= $2::date + interval '1 day' - interval '1 second'`;

    expParams.push(brigadeId);
    expensesSql += ` GROUP BY e.category ORDER BY total DESC`;
  } else {
    if (startDate) expensesSql += ` AND created_at >= $1`;
    if (endDate)
      expensesSql += ` AND created_at <= $2::date + interval '1 day' - interval '1 second'`;
    expensesSql += ` GROUP BY category ORDER BY total DESC`;
  }

  const avgQuery = await query(avgSql, params);
  const expensesQuery = await query(expensesSql, expParams);

  let debtQuery;
  if (brigadeId) {
    const bRes = await query(
      "SELECT brigadier_id FROM brigades WHERE id = $1",
      [brigadeId],
    );
    const brigadierId = bRes.rows[0]?.brigadier_id || 0;
    debtQuery = await query(
      `SELECT COALESCE(SUM(balance), 0) as total_debt FROM accounts WHERE type = 'brigade_acc' AND user_id = $1 AND balance < 0`,
      [brigadierId],
    );
  } else {
    debtQuery = await query(
      `SELECT COALESCE(SUM(balance), 0) as total_debt FROM accounts WHERE type = 'brigade_acc' AND balance < 0`,
    );
  }

  return {
    economics: {
      averageCheck: parseFloat(avgQuery.rows[0]?.avg_check || 0),
      averageMargin: parseFloat(avgQuery.rows[0]?.avg_margin || 0),
      totalBrigadeDebts: Math.abs(
        parseFloat(debtQuery.rows[0]?.total_debt || 0),
      ),
    },
    expenseBreakdown: expensesQuery.rows || [],
  };
};

export const getTimelineAnalytics = async (
  brigadeId = null,
  startDate = null,
  endDate = null,
) => {
  let sql = `
    SELECT 
      TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month,
      COALESCE(SUM(total_price), 0) as gross_revenue,
      COALESCE(SUM(COALESCE((details->'financials'->>'net_profit')::numeric, total_price)), 0) as net_profit,
      COUNT(id) as closed_orders
    FROM orders WHERE status = 'done'
  `;
  const params = [];
  if (brigadeId) {
    params.push(brigadeId);
    sql += ` AND brigade_id = $${params.length}`;
  }
  if (startDate) {
    params.push(startDate);
    sql += ` AND created_at >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    sql += ` AND created_at <= $${params.length}::date + interval '1 day' - interval '1 second'`;
  }
  sql += ` GROUP BY DATE_TRUNC('month', created_at) ORDER BY month DESC LIMIT 12;`;

  const res = await query(sql, params);
  return res.rows;
};

export const getOrdersTimelineAnalytics = async (
  brigadeId = null,
  startDate = null,
  endDate = null,
) => {
  let sql = `
    SELECT 
      TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month,
      COUNT(id) FILTER (WHERE status = 'new') as new_orders,
      COUNT(id) FILTER (WHERE status = 'work' OR status = 'processing') as work_orders,
      COUNT(id) FILTER (WHERE status = 'done') as done_orders,
      COUNT(id) FILTER (WHERE status = 'cancel') as cancel_orders
    FROM orders WHERE 1=1
  `;
  const params = [];
  if (brigadeId) {
    params.push(brigadeId);
    sql += ` AND brigade_id = $${params.length}`;
  }
  if (startDate) {
    params.push(startDate);
    sql += ` AND created_at >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    sql += ` AND created_at <= $${params.length}::date + interval '1 day' - interval '1 second'`;
  }
  sql += ` GROUP BY DATE_TRUNC('month', created_at) ORDER BY month DESC LIMIT 12;`;

  const res = await query(sql, params);
  return res.rows;
};

export const getBrigadesAnalytics = async (
  startDate = null,
  endDate = null,
) => {
  let ordersFilter = `o.status = 'done'`;
  const params = [];

  if (startDate) {
    params.push(startDate);
    ordersFilter += ` AND o.created_at >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    ordersFilter += ` AND o.created_at <= $${params.length}::date + interval '1 day' - interval '1 second'`;
  }

  const sql = `
    SELECT 
      b.id, b.name,
      COUNT(o.id) as closed_orders_count,
      COALESCE(SUM(o.total_price), 0) as total_revenue_brought,
      COALESCE(SUM(COALESCE((o.details->'financials'->>'net_profit')::numeric, o.total_price)), 0) as total_net_profit_brought,
      COALESCE(a.balance, 0) as current_balance
    FROM brigades b
    LEFT JOIN orders o ON b.id = o.brigade_id AND ${ordersFilter}
    LEFT JOIN accounts a ON b.brigadier_id = a.user_id AND a.type = 'brigade_acc'
    GROUP BY b.id, b.name, a.balance
    ORDER BY total_net_profit_brought DESC;
  `;

  const res = await query(sql, params);
  return res.rows.map((row) => ({
    ...row,
    current_debt:
      row.current_balance < 0 ? Math.abs(parseFloat(row.current_balance)) : 0,
  }));
};

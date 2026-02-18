/**
 * @file src/database/repository.js
 * @description Слой репозитория (Data Access Layer).
 * Содержит коллекцию готовых методов для работы с БД.
 * Изолирует прямой SQL от бизнес-логики (Services).
 *
 * Архитектура: Repository Pattern.
 *
 * @module Repository
 * @version 9.0.0 (Enterprise Edition)
 * @author ProElectric Team
 */

import { query } from "./connection.js";

// =============================================================================
// ⚙️ SETTINGS (DYNAMIC PRICING)
// =============================================================================

/**
 * Получение всех настроек системы одной пачкой.
 * Используется для кеширования цен в OrderService.
 * @returns {Promise<Object>} Объект вида { 'price_cable': 350, ... }
 */
export const getSettings = async () => {
  const sql = "SELECT key, value FROM settings";
  const { rows } = await query(sql);

  const settings = {};
  for (const row of rows) {
    // Автоматическая конвертация чисел
    const numVal = parseFloat(row.value);
    settings[row.key] = isNaN(numVal) ? row.value : numVal;
  }
  return settings;
};

/**
 * Сохранение или обновление настройки (Upsert).
 * @param {string} key - Ключ (напр. 'price_strobe_concrete')
 * @param {string|number} value - Значение
 */
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

// =============================================================================
// 👤 USERS REPOSITORY
// =============================================================================

/**
 * Найти пользователя по Telegram ID.
 */
export const findUserById = async (telegramId) => {
  const sql = "SELECT * FROM users WHERE telegram_id = $1";
  const res = await query(sql, [telegramId]);
  return res.rows[0];
};

/**
 * Регистрация или обновление пользователя (Upsert).
 * Гарантирует актуальность username и first_name.
 */
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

/**
 * Обновление телефона пользователя.
 */
export const updateUserPhone = async (userId, phone) => {
  const sql =
    "UPDATE users SET phone = $1, updated_at = NOW() WHERE telegram_id = $2";
  await query(sql, [phone, userId]);
};

/**
 * Смена роли пользователя.
 */
export const updateUserRole = async (userId, newRole) => {
  const sql =
    "UPDATE users SET role = $1, updated_at = NOW() WHERE telegram_id = $2 RETURNING *";
  const res = await query(sql, [newRole, userId]);
  return res.rows[0];
};

/**
 * Получение списка пользователей с пагинацией.
 */
export const getAllUsers = async (limit = 50, offset = 0) => {
  const sql = `
    SELECT telegram_id, first_name, username, phone, role, created_at 
    FROM users 
    ORDER BY created_at DESC 
    LIMIT $1 OFFSET $2
  `;
  const res = await query(sql, [limit, offset]);
  return res.rows;
};

// =============================================================================
// 📦 ORDERS REPOSITORY
// =============================================================================

/**
 * Создание нового заказа.
 * @param {number} userId
 * @param {Object} data - { price, details, area, ... }
 */
export const createOrder = async (userId, data) => {
  const sql = `
    INSERT INTO orders (user_id, total_price, details, status, created_at)
    VALUES ($1, $2, $3, 'new', NOW())
    RETURNING *
  `;
  // details сохраняем как JSONB
  const res = await query(sql, [userId, data.price, data.details || {}]);
  return res.rows[0];
};

/**
 * Получение заказа по ID.
 */
export const getOrderById = async (orderId) => {
  const sql = "SELECT * FROM orders WHERE id = $1";
  const res = await query(sql, [orderId]);
  return res.rows[0];
};

/**
 * Обновление статуса заказа.
 */
export const updateOrderStatus = async (orderId, status) => {
  const sql =
    "UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *";
  const res = await query(sql, [status, orderId]);
  return res.rows[0];
};

/**
 * Обновление деталей заказа (BOM) и итоговой цены.
 * Используется при редактировании сметы вручную.
 * @param {number} orderId
 * @param {Object} details - Новый JSONB объект с материалами
 * @param {number} totalPrice - Пересчитанная цена
 */
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

/**
 * Получение истории заказов пользователя.
 */
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
// 💸 EXPENSES REPOSITORY (NEW: Fixes "undefined length" error)
// =============================================================================

/**
 * Добавление расхода к объекту.
 * @param {number} orderId
 * @param {number} amount
 * @param {string} category
 * @param {string} comment
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

/**
 * Получение всех расходов по конкретному заказу.
 * Критически важно для корректного отображения на фронтенде.
 * @param {number} orderId
 */
export const getOrderExpenses = async (orderId) => {
  const sql = "SELECT * FROM object_expenses WHERE order_id = $1 ORDER BY created_at DESC";
  const res = await query(sql, [orderId]);
  return res.rows;
};

// =============================================================================
// 📊 ANALYTICS & DASHBOARD
// =============================================================================

/**
 * Получение глобальной статистики (для дашборда).
 * Возвращает количество юзеров, выручку (done) и активных за сутки.
 */
export const getGlobalStats = async () => {
  // Выполняем 3 запроса параллельно, но внутри одной функции для чистоты API
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

/**
 * Аналитика по статусам заказов (Воронка).
 */
export const getOrdersFunnel = async () => {
  const sql = `
    SELECT status, COUNT(*) as count, SUM(total_price) as sum
    FROM orders
    GROUP BY status
  `;
  const res = await query(sql);
  return res.rows;
};
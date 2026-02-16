/**
 * @file src/database/repository.js
 * @description Слой репозитория (Repository Layer).
 * Содержит методы для выполнения CRUD операций (Create, Read, Update, Delete).
 * Изолирует бизнес-логику от прямого написания SQL-запросов.
 * @module DatabaseRepository
 * @version 1.0.0 (Senior Level)
 */

import { query, getClient } from "./connection.js";
import { ROLES } from "../constants.js";

// =============================================================================
// МЕТОДЫ РАБОТЫ С НАСТРОЙКАМИ (SETTINGS)
// =============================================================================

/**
 * Получить все глобальные настройки (цены, коэффициенты) из базы.
 * Преобразует массив строк из БД в удобный JavaScript объект.
 *
 * @returns {Promise<Object>} Объект вида { 'price_cable': '400', ... }
 */
export const getSettings = async () => {
  const result = await query("SELECT key, value FROM settings");

  const settings = {};
  // Явный цикл for-of для максимальной понятности и производительности
  for (const row of result.rows) {
    settings[row.key] = row.value;
  }

  return settings;
};

// =============================================================================
// МЕТОДЫ РАБОТЫ С ПОЛЬЗОВАТЕЛЯМИ (USERS)
// =============================================================================

/**
 * Создать или обновить пользователя (Upsert).
 * Используется при каждом сообщении от пользователя (/start), чтобы обновить его имя/username.
 *
 * @param {number|string} telegramId - Уникальный ID пользователя Telegram
 * @param {string} firstName - Имя пользователя
 * @param {string} username - Юзернейм (без @)
 * @param {string} phone - Номер телефона (может быть null)
 * @returns {Promise<Object>} Обновленный объект пользователя
 */

export const upsertUser = async (telegramId, firstName, username, phone) => {
  // Используем конструкцию ON CONFLICT для реализации логики "Вставь или Обнови"
  const sql = `
        INSERT INTO users (telegram_id, first_name, username, phone)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (telegram_id) DO UPDATE SET 
            first_name = COALESCE(EXCLUDED.first_name, users.first_name),
            username = COALESCE(EXCLUDED.username, users.username),
            phone = COALESCE(EXCLUDED.phone, users.phone),
            updated_at = NOW()
        RETURNING *
    `;

  const result = await query(sql, [telegramId, firstName, username, phone]);
  return result.rows[0];
};

/**
 * Повысить или понизить роль сотрудника.
 * Это ТРАНЗАКЦИОННАЯ операция: если мы назначаем менеджера, мы ОБЯЗАНЫ создать ему кассу.
 *
 * @param {number|string} targetId - ID пользователя
 * @param {string} newRole - Новая роль (admin, manager, client)
 * @param {string} nameForAccount - Имя пользователя для названия кассы
 * @returns {Promise<void>}
 */
export const promoteUser = async (targetId, newRole, nameForAccount) => {
  // Получаем выделенного клиента для транзакции
  const client = await getClient();

  try {
    await client.query("BEGIN"); // Начинаем транзакцию

    // 1. Обновляем роль в таблице пользователей
    await client.query(
      "UPDATE users SET role = $1, updated_at = NOW() WHERE telegram_id = $2",
      [newRole, targetId],
    );

    // 2. Если новая роль подразумевает работу с финансами, создаем кассу
    if (newRole === ROLES.MANAGER || newRole === ROLES.ADMIN) {
      await client.query(
        `INSERT INTO accounts (user_id, name, type)
                 VALUES ($1, $2, 'cash')
                 ON CONFLICT DO NOTHING`, // Если касса уже есть, не создаем дубликат
        [targetId, `Касса: ${nameForAccount}`],
      );
    }

    await client.query("COMMIT"); // Применяем изменения
  } catch (error) {
    await client.query("ROLLBACK"); // Отменяем всё при ошибке
    throw error; // Пробрасываем ошибку выше
  } finally {
    client.release(); // Обязательно возвращаем клиента в пул
  }
};

// =============================================================================
// МЕТОДЫ РАБОТЫ С ЗАКАЗАМИ (ORDERS)
// =============================================================================

/**
 * Создать новый заказ в системе.
 * Сохраняет полную детализацию расчета (смету) в поле JSONB.
 *
 * @param {number|string} userId - ID клиента
 * @param {Object} data - Объект с данными заказа
 * @param {number} data.area - Площадь
 * @param {number} data.price - Итоговая цена
 * @param {Object} data.details - Полный объект сметы (JSON)
 * @returns {Promise<Object>} Созданный заказ (id, status, total_price)
 */
export const createOrder = async (userId, data) => {
  const sql = `
        INSERT INTO orders (user_id, area, total_price, details, status)
        VALUES ($1, $2, $3, $4, 'new')
        RETURNING id, status, total_price
    `;

  const result = await query(sql, [
    userId,
    data.area,
    data.price,
    data.details,
  ]);

  return result.rows[0];
};

// =============================================================================
// МЕТОДЫ РАБОТЫ С ФИНАНСАМИ (ACCOUNTS)
// =============================================================================

/**
 * Получить список финансовых счетов (Касс).
 * Учитывает права доступа: Админ видит всё, остальные — только своё.
 *
 * @param {number|string|null} userId - ID пользователя (владельца)
 * @param {string|null} role - Роль запрашивающего
 * @returns {Promise<Array>} Список аккаунтов
 */
export const getAccounts = async (userId = null, role = null) => {
  let sql = "SELECT * FROM accounts";
  const params = [];

  // Логика фильтрации:
  // Если роль НЕ 'admin' и передан userId, то фильтруем по этому userId.
  // Админ получает список всех касс без фильтрации (если userId не передан специально).
  if (role !== ROLES.ADMIN && userId) {
    sql += " WHERE user_id = $1";
    params.push(userId);
  }

  sql += " ORDER BY id ASC"; // Сортировка для предсказуемого порядка

  const result = await query(sql, params);
  return result.rows;
};

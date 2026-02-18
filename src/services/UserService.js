/**
 * @file src/services/UserService.js
 * @description Сервис управления пользователями (Identity & RBAC Module v9.0.0).
 * Отвечает за аутентификацию, профилирование, управление ролями и клиентскую аналитику.
 * Оптимизирован под использование как из Telegram-бота, так и из Web CRM.
 *
 * @module UserService
 * @version 9.0.0 (Enterprise ERP Edition)
 */

import * as db from "../database/index.js";

// =============================================================================
// 🔒 ROLES DEFINITION (RBAC)
// =============================================================================

export const ROLES = Object.freeze({
  OWNER: "owner", // Владелец бизнеса (Super Admin)
  ADMIN: "admin", // Администратор (Доступ к CRM)
  MANAGER: "manager", // Мастер / Инженер (Работает с заказами)
  USER: "user", // Клиент бота
  BANNED: "banned", // Заблокирован
});

// =============================================================================
// 🧠 BUSINESS LOGIC IMPLEMENTATION
// =============================================================================

export const UserService = {
  ROLES,

  /**
   * Получение текущей роли пользователя.
   * @param {number|string} telegramId - Telegram ID пользователя.
   * @returns {Promise<string>} Роль пользователя (по умолчанию 'user').
   */
  async getUserRole(telegramId) {
    const res = await db.query(
      "SELECT role FROM users WHERE telegram_id = $1 LIMIT 1",
      [telegramId],
    );
    return res.rows.length ? res.rows[0].role : ROLES.USER;
  },

  /**
   * Получение полного профиля пользователя.
   * @param {number|string} telegramId
   * @returns {Promise<Object|null>}
   */
  async getUserProfile(telegramId) {
    const res = await db.query(
      "SELECT * FROM users WHERE telegram_id = $1 LIMIT 1",
      [telegramId],
    );
    return res.rows[0] || null;
  },

  /**
   * 📝 Регистрация или обновление пользователя (Авторизация при /start).
   * Реализует паттерн UPSERT.
   * @param {Object} telegramUser - Объект пользователя из Telegraf (ctx.from)
   * @returns {Promise<Object>} Обновленная запись пользователя
   */
  async registerOrUpdateUser(telegramUser) {
    const { id, first_name, username } = telegramUser;

    const sql = `
      INSERT INTO users (telegram_id, first_name, username, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (telegram_id) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        username = EXCLUDED.username,
        updated_at = NOW()
      RETURNING *
    `;

    const res = await db.query(sql, [id, first_name, username || null]);
    return res.rows[0];
  },

  /**
   * 📱 Привязка или обновление номера телефона.
   * Очищает номер от лишних символов перед сохранением.
   */
  async updateUserPhone(telegramId, phone) {
    // Оставляем только плюс и цифры
    const cleanPhone = phone.replace(/[^\d+]/g, "");

    const res = await db.query(
      "UPDATE users SET phone = $1, updated_at = NOW() WHERE telegram_id = $2 RETURNING *",
      [cleanPhone, telegramId],
    );
    return res.rows[0];
  },

  /**
   * 🛡 Управление правами доступа (RBAC Mutator).
   * @param {number} initiatorId - ID того, кто меняет роль (0 если запрос идет из защищенной Web API)
   * @param {number|string} targetId - ID пользователя, которому меняем роль
   * @param {string} newRole - Назначаемая роль
   */
  async changeUserRole(initiatorId, targetId, newRole) {
    // Проверка прав инициатора (если это не системный вызов из Web API)
    if (initiatorId !== 0) {
      const initiatorRole = await this.getUserRole(initiatorId);
      if (initiatorRole !== ROLES.OWNER && initiatorRole !== ROLES.ADMIN) {
        throw new Error("Недостаточно прав для изменения ролей.");
      }
    }

    if (!Object.values(ROLES).includes(newRole)) {
      throw new Error(`Недопустимая роль системы: ${newRole}`);
    }

    const res = await db.query(
      "UPDATE users SET role = $1, updated_at = NOW() WHERE telegram_id = $2 RETURNING *",
      [newRole, targetId],
    );

    if (res.rowCount === 0) {
      throw new Error("Пользователь не найден в базе данных.");
    }

    return res.rows[0];
  },

  /**
   * 👥 Выгрузка списка пользователей для Web CRM (с пагинацией).
   */
  async getAllUsers(limit = 100, offset = 0) {
    const res = await db.query(
      `SELECT telegram_id, first_name, username, phone, role, created_at, updated_at 
       FROM users 
       ORDER BY created_at DESC 
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return res.rows;
  },

  /**
   * 🎯 Получение списка пользователей для массовой рассылки.
   * @param {string} roleFilter - 'all', 'user', 'manager', 'admin'
   */
  async getUsersForBroadcast(roleFilter = "all") {
    let sql = "SELECT telegram_id FROM users WHERE telegram_id > 0"; // Исключаем виртуальных оффлайн-клиентов
    const params = [];

    if (roleFilter !== "all") {
      sql += " AND role = $1";
      params.push(roleFilter);
    }

    const res = await db.query(sql, params);
    return res.rows;
  },

  /**
   * 📊 Аналитика по базе клиентов для дашборда CRM.
   */
  async getDashboardStats() {
    const [usersData, activeData] = await Promise.all([
      db.query("SELECT COUNT(*) as count FROM users"),
      db.query(
        "SELECT COUNT(*) as count FROM users WHERE updated_at > NOW() - INTERVAL '24 hours'",
      ),
    ]);

    return {
      totalUsers: parseInt(usersData.rows[0].count, 10),
      activeUsers24h: parseInt(activeData.rows[0].count, 10),
    };
  },
};

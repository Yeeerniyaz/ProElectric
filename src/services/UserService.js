/**
 * @file src/services/UserService.js
 * @description Сервис управления пользователями и правами доступа.
 * Реализует логику регистрации, назначения ролей (RBAC) и профилирования.
 * @module UserService
 * @version 4.0.0 (Enterprise Level)
 */

import * as db from "../database/repository.js";
import { ROLES, MESSAGES } from "../constants.js";

export const UserService = {
  /**
   * 👤 Регистрация или обновление пользователя.
   * Используется при каждом взаимодействии с ботом (команда /start или нажатие кнопки).
   * Обновляет "last_active", что позволяет считать Retention (удержание).
   * * @param {Object} telegramUser - Объект пользователя от Telegram (ctx.from)
   * @returns {Promise<Object>} Объект пользователя из нашей БД
   */
  async registerOrUpdateUser(telegramUser) {
    const { id, first_name, username, is_bot } = telegramUser;

    // Ботов не регистрируем, чтобы не засорять статистику
    if (is_bot) return null;

    // Формируем данные для сохранения
    const userData = {
      telegram_id: id,
      first_name: first_name || "Неизвестный",
      username: username || null,
      // Если фото или телефон придут позже, обновим их отдельными методами
    };

    // Вызываем репозиторий для создания или обновления (Upsert)
    const user = await db.upsertUser(
      userData.telegram_id,
      userData.first_name,
      userData.username,
      userData.phone,
    );

    return user;
  },

  /**
   * 🛡️ Проверка прав доступа.
   * Определяет, является ли пользователь Админом или Менеджером.
   * * @param {number} userId - Telegram ID пользователя
   * @returns {Promise<boolean>} True, если пользователь имеет права админа
   */
  async isAdmin(userId) {
    const user = await db.getUserByTelegramId(userId);

    if (!user) return false;

    // Проверяем вхождение роли в список разрешенных
    return [ROLES.ADMIN, ROLES.OWNER, ROLES.MANAGER].includes(user.role);
  },

  /**
   * 👑 Назначение новой роли пользователю.
   * Позволяет Главному Админу назначать других админов или менеджеров.
   * * @param {number} initiatorId - ID того, кто пытается назначить роль (для проверки прав)
   * @param {number} targetUserId - ID пользователя, которому меняем роль
   * @param {string} newRole - Новая роль ('admin', 'manager', 'user')
   * @returns {Promise<Object>} Результат операции
   */
  async changeUserRole(initiatorId, targetUserId, newRole) {
    // 1. Проверяем инициатора (тот кто меняет)
    const initiator = await db.getUserByTelegramId(initiatorId);

    if (!initiator || initiator.role !== ROLES.OWNER) {
      // Только Владелец (Owner) может назначать Админов.
      // Если нужно разрешить Админам добавлять Админов, добавьте сюда || initiator.role === ROLES.ADMIN
      throw new Error("У вас нет прав для назначения администраторов.");
    }

    // 2. Проверяем валидность роли
    const validRoles = Object.values(ROLES);
    if (!validRoles.includes(newRole)) {
      throw new Error(
        `Недопустимая роль. Доступные роли: ${validRoles.join(", ")}`,
      );
    }

    // 3. Обновляем роль в базе
    // Используем прямой SQL запрос через репозиторий для надежности
    const result = await db.query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE telegram_id = $2 RETURNING *`,
      [newRole, targetUserId],
    );

    if (result.rowCount === 0) {
      throw new Error("Пользователь с таким ID не найден в базе.");
    }

    return result.rows[0];
  },

  /**
   * 📱 Сохранение номера телефона.
   * Важно для связи с клиентом. Обычно происходит по кнопке "Поделиться контактом".
   * * @param {number} userId - Telegram ID
   * @param {string} phoneNumber - Номер телефона
   */
  async updateUserPhone(userId, phoneNumber) {
    await db.query(
      `UPDATE users SET phone = $1, updated_at = NOW() WHERE telegram_id = $2`,
      [phoneNumber, userId],
    );
  },

  /**
   * 📢 Получение списка получателей для рассылки.
   * Используется для отправки уведомлений о новых заказах всем админам.
   * * @returns {Promise<Array>} Массив ID пользователей с правами админа/менеджера
   */
  async getAdminIdsForNotification() {
    const result = await db.query(
      `SELECT telegram_id FROM users WHERE role IN ($1, $2, $3)`,
      [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER],
    );

    // Возвращаем чистый массив ID: [12345, 67890]
    return result.rows.map((row) => row.telegram_id);
  },

  /**
   * 📊 Получение профиля пользователя со статистикой.
   * Нужно для отображения личного кабинета (сколько заказов, какая скидка и т.д.)
   * * @param {number} userId
   */
  async getUserProfile(userId) {
    const user = await db.getUserByTelegramId(userId);
    if (!user) return null;

    // Подтягиваем количество заказов этого пользователя
    const ordersCountRes = await db.query(
      `SELECT COUNT(*) as count FROM orders WHERE user_id = $1`,
      [userId],
    );

    return {
      ...user,
      ordersCount: parseInt(ordersCountRes.rows[0].count) || 0,
    };
  },

  /**
   * 📋 Получение списка всех пользователей (для Админ-панели).
   * С пагинацией, чтобы не грузить базу если будет 10 000 юзеров.
   * * @param {number} limit - Лимит на страницу
   * @param {number} offset - Смещение
   */
  async getAllUsers(limit = 50, offset = 0) {
    const res = await db.query(
      `SELECT telegram_id, first_name, username, phone, role, created_at 
             FROM users 
             ORDER BY created_at DESC 
             LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return res.rows;
  },
};

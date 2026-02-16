/**
 * @file src/services/UserService.js
 * @description Сервис управления пользователями (Business Logic Layer).
 * Реализует расширенную логику RBAC, профилирование, поиск и аналитику.
 * @module UserService
 * @version 5.0.0 (Senior Edition)
 */

import * as db from "../database/index.js";
import { ROLES } from "../constants.js";

export const UserService = {
  // ===========================================================================
  // 1. CORE AUTH & REGISTRATION
  // ===========================================================================

  /**
   * 👤 Регистрация или обновление пользователя (Upsert Pattern).
   * Вызывается при каждом входящем сообщении. Обновляет дату последней активности.
   *
   * @param {Object} telegramUser - Объект пользователя из Telegram (ctx.from)
   * @returns {Promise<Object|null>} Объект пользователя из БД
   */
  async registerOrUpdateUser(telegramUser) {
    const { id, first_name, username, is_bot } = telegramUser;

    // 1. Фильтрация ботов (они не должны попадать в статистику)
    if (is_bot) return null;

    // 2. Подготовка данных (Sanitization)
    const safeName = first_name || "Пользователь";
    const safeUsername = username || null;

    // 3. Выполнение запроса (Direct SQL for Performance)
    // Используем ON CONFLICT для атомарной операции "Вставь или Обнови"
    const sql = `
        INSERT INTO users (telegram_id, first_name, username, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (telegram_id) DO UPDATE SET 
            first_name = EXCLUDED.first_name,
            username = EXCLUDED.username,
            updated_at = NOW()
        RETURNING *
    `;

    try {
      const res = await db.query(sql, [id, safeName, safeUsername]);
      return res.rows[0];
    } catch (error) {
      console.error("[UserService] Register Error:", error);
      throw new Error("Ошибка регистрации пользователя.");
    }
  },

  /**
   * 📱 Обновление контактных данных.
   *
   * @param {number} userId - Telegram ID
   * @param {string} phoneNumber - Номер телефона
   */
  async updateUserPhone(userId, phoneNumber) {
    const sql = `
        UPDATE users 
        SET phone = $1, updated_at = NOW() 
        WHERE telegram_id = $2
    `;
    await db.query(sql, [phoneNumber, userId]);
  },

  // ===========================================================================
  // 2. PERMISSIONS & ROLES (RBAC)
  // ===========================================================================

  /**
   * 🕵️‍♂️ Получение текущей роли пользователя (Helper).
   */
  async getUserRole(userId) {
    const res = await db.query(
      "SELECT role FROM users WHERE telegram_id = $1",
      [userId],
    );
    return res.rows[0]?.role || ROLES.CLIENT;
  },

  /**
   * 🛡️ Проверка прав Администратора.
   * Возвращает true, если пользователь входит в управляющий состав.
   */
  async isAdmin(userId) {
    const role = await this.getUserRole(userId);
    return [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER].includes(role);
  },

  /**
   * 👑 Безопасное изменение роли (Secure Role Promotion).
   * Реализует защиту от повышения привилегий и иерархию управления.
   *
   * @param {number} initiatorId - ID того, кто меняет роль
   * @param {number} targetUserId - ID того, кому меняют роль
   * @param {string} newRole - Новая роль
   * @returns {Promise<Object>} Результат операции
   */
  async changeUserRole(initiatorId, targetUserId, newRole) {
    // 1. Получаем роли обоих участников
    // Используем Promise.all для параллельного выполнения (Optimization)
    const [initiatorRole, targetRole] = await Promise.all([
      this.getUserRole(initiatorId),
      this.getUserRole(targetUserId),
    ]);

    // 2. Валидация существования роли
    const validRoles = Object.values(ROLES);
    if (!validRoles.includes(newRole)) {
      throw new Error(
        `⛔ Ошибка: Роли "${newRole}" не существует. Доступные: ${validRoles.join(", ")}`,
      );
    }

    // 3. ПРАВИЛА БЕЗОПАСНОСТИ (Security Policy)

    // Правило A: Никто не может разжаловать Владельца (кроме самого Владельца)
    if (targetRole === ROLES.OWNER && initiatorId !== targetUserId) {
      throw new Error("⛔ Отказано: Нельзя изменять права Владельца системы.");
    }

    // Правило B: Менеджеры не могут менять роли
    if (initiatorRole === ROLES.MANAGER) {
      throw new Error(
        "⛔ Отказано: Менеджеры не имеют прав управления персоналом.",
      );
    }

    // Правило C: Админы не могут назначать Владельцев или других Админов
    // (Админ управляет только Менеджерами и Клиентами)
    if (initiatorRole === ROLES.ADMIN) {
      if (newRole === ROLES.OWNER || newRole === ROLES.ADMIN) {
        throw new Error(
          "⛔ Отказано: Администратор не может выдавать такие высокие права.",
        );
      }
      if (targetRole === ROLES.ADMIN || targetRole === ROLES.OWNER) {
        throw new Error(
          "⛔ Отказано: Вы не можете менять роль равного или старшего по званию.",
        );
      }
    }

    // Правило D: Владелец может всё.

    // 4. Выполнение транзакции
    const sql = `
        UPDATE users 
        SET role = $1, updated_at = NOW() 
        WHERE telegram_id = $2 
        RETURNING *
    `;
    const result = await db.query(sql, [newRole, targetUserId]);

    if (result.rowCount === 0) {
      throw new Error("❌ Пользователь не найден в базе данных.");
    }

    return result.rows[0];
  },

  /**
   * 📢 Получение списка ID для уведомлений.
   * Используется для алертов о новых заказах.
   */
  async getAdminIdsForNotification() {
    // Выбираем всех сотрудников, кроме обычных клиентов
    const sql = `
        SELECT telegram_id 
        FROM users 
        WHERE role IN ($1, $2, $3)
    `;
    const result = await db.query(sql, [
      ROLES.OWNER,
      ROLES.ADMIN,
      ROLES.MANAGER,
    ]);
    return result.rows.map((row) => row.telegram_id);
  },

  // ===========================================================================
  // 3. PROFILE & ANALYTICS
  // ===========================================================================

  /**
   * 📊 Получение расширенного профиля пользователя.
   * Включает личные данные, статистику заказов и LTV (Lifetime Value).
   */
  async getUserProfile(userId) {
    // Запрос пользователя
    const userRes = await db.query(
      "SELECT * FROM users WHERE telegram_id = $1",
      [userId],
    );
    const user = userRes.rows[0];
    if (!user) return null;

    // Запрос статистики (агрегация)
    const statsSql = `
        SELECT 
            COUNT(*) as total_orders,
            SUM(total_price) as total_spent,
            MAX(created_at) as last_order_date
        FROM orders 
        WHERE user_id = $1 AND status != 'cancel'
    `;
    const statsRes = await db.query(statsSql, [userId]);
    const stats = statsRes.rows[0];

    return {
      ...user,
      stats: {
        ordersCount: parseInt(stats.total_orders) || 0,
        totalSpent: parseInt(stats.total_spent) || 0,
        lastOrderDate: stats.last_order_date || null,
      },
    };
  },

  /**
   * 📋 Получение списка всех пользователей с пагинацией.
   * Оптимизировано для Админ-панели.
   */
  async getAllUsers(limit = 50, offset = 0) {
    const sql = `
        SELECT telegram_id, first_name, username, phone, role, created_at, updated_at 
        FROM users 
        ORDER BY created_at DESC 
        LIMIT $1 OFFSET $2
    `;
    const res = await db.query(sql, [limit, offset]);
    return res.rows;
  },

  /**
   * 🔍 Поиск пользователей (Search).
   * Позволяет найти клиента по ID, имени или юзернейму.
   *
   * @param {string} query - Поисковая строка
   */
  async findUsers(query) {
    const searchQuery = `%${query}%`;
    const sql = `
        SELECT telegram_id, first_name, username, phone, role 
        FROM users 
        WHERE 
            first_name ILIKE $1 OR 
            username ILIKE $1 OR 
            phone ILIKE $1 OR
            CAST(telegram_id AS TEXT) ILIKE $1
        LIMIT 10
    `;
    const res = await db.query(sql, [searchQuery]);
    return res.rows;
  },

  /**
   * 📈 Глобальная статистика (Dashboard).
   * Возвращает агрегированные данные для панели управления.
   */
  async getDashboardStats() {
    // Используем Promise.all для одновременного выполнения трех тяжелых запросов
    const [usersData, ordersData, activeData] = await Promise.all([
      // 1. Всего пользователей
      db.query("SELECT COUNT(*) as count FROM users"),

      // 2. Финансы (Сумма успешных заказов)
      db.query(
        "SELECT SUM(total_price) as revenue FROM orders WHERE status = 'done'",
      ),

      // 3. Активность за сегодня (Retention Day 1)
      db.query(
        "SELECT COUNT(*) as count FROM users WHERE updated_at > NOW() - INTERVAL '24 hours'",
      ),
    ]);

    return {
      totalUsers: parseInt(usersData.rows[0].count),
      totalRevenue: parseInt(ordersData.rows[0].revenue) || 0,
      activeUsers24h: parseInt(activeData.rows[0].count),
    };
  },

  /**
   * 🎯 Получение аудитории для рассылок (Targeting).
   *
   * @param {string} roleFilter - 'all' | 'admins' | 'clients'
   */
  async getUsersForBroadcast(roleFilter = "all") {
    let sql = "SELECT telegram_id FROM users";
    const params = [];

    if (roleFilter === "admins") {
      sql += ` WHERE role IN ($1, $2, $3)`;
      params.push(ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER);
    } else if (roleFilter === "clients") {
      sql += ` WHERE role = $1`;
      params.push(ROLES.CLIENT);
    }

    const res = await db.query(sql, params);
    return res.rows.map((r) => r.telegram_id);
  },
};

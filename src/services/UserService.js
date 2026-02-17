/**
 * @file src/services/UserService.js
 * @description Сервис управления пользователями (Business Logic Layer).
 * Реализует расширенную логику RBAC (Role-Based Access Control), профилирование, поиск и аналитику.
 * Полностью автономен и не зависит от глобальных констант.
 *
 * @module UserService
 * @version 5.1.0 (Senior Edition)
 */

import * as db from "../database/index.js";

// =============================================================================
// 🔒 INTERNAL CONSTANTS & CONFIGURATION
// =============================================================================

/**
 * Определения ролей пользователей (RBAC).
 * Зафиксированы через Object.freeze для предотвращения мутаций в рантайме.
 */
export const ROLES = Object.freeze({
  OWNER: "owner", // Владелец системы (Супер-админ)
  ADMIN: "admin", // Администратор (Управляет персоналом и настройками)
  MANAGER: "manager", // Менеджер / Мастер (Работает с заказами)
  CLIENT: "user", // Обычный клиент (Потребитель)
  BANNED: "banned", // Заблокированный пользователь
});

/**
 * Определение прав доступа для проверок (Policy Definitions).
 */
const POLICIES = Object.freeze({
  // Кто считается административным персоналом
  ADMIN_STAFF: [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER],
  // Кого можно назначать через бота
  ASSIGNABLE_ROLES: [ROLES.ADMIN, ROLES.MANAGER, ROLES.CLIENT, ROLES.BANNED],
});

// =============================================================================
// 🧠 BUSINESS LOGIC SERVICE
// =============================================================================

export const UserService = {
  // Экспортируем константы, чтобы другие модули могли их использовать (UserHandler, AdminHandler)
  ROLES,

  // ===========================================================================
  // 1. CORE AUTH & REGISTRATION
  // ===========================================================================

  /**
   * 👤 Регистрация или обновление пользователя (Upsert Pattern).
   * Вызывается при каждом входящем сообщении. Обновляет дату последней активности.
   * Гарантирует актуальность данных профиля (имя, username).
   *
   * @param {Object} telegramUser - Объект пользователя из Telegram (ctx.from)
   * @returns {Promise<Object|null>} Объект пользователя из БД или null, если это бот
   */
  async registerOrUpdateUser(telegramUser) {
    const { id, first_name, username, is_bot } = telegramUser;

    // 1. Фильтрация ботов (они не должны попадать в бизнес-статистику)
    if (is_bot) return null;

    // 2. Подготовка данных (Sanitization)
    // Защита от отсутствующего имени или username
    const safeName = first_name || "Пользователь";
    const safeUsername = username || null;

    // 3. Выполнение запроса (Direct SQL for Performance)
    // Используем ON CONFLICT для атомарной операции "Вставь или Обнови".
    // Это предотвращает Race Conditions при параллельных запросах.
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
      throw new Error("Системная ошибка регистрации пользователя.");
    }
  },

  /**
   * 📱 Обновление контактных данных.
   * Критически важно для конверсии лида в клиента.
   *
   * @param {number} userId - Telegram ID
   * @param {string} phoneNumber - Номер телефона (формат не валидируем жестко, доверяем Телеграму)
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
   * 🕵️‍♂️ Получение текущей роли пользователя.
   * Если пользователь не найден в БД, считается обычным клиентом.
   *
   * @param {number} userId
   * @returns {Promise<string>} Роль (owner, admin, manager, user, banned)
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
   * Возвращает true, если пользователь входит в управляющий состав (Owner, Admin, Manager).
   * Используется для защиты роутов админ-панели.
   *
   * @param {number} userId
   * @returns {Promise<boolean>}
   */
  async isAdmin(userId) {
    const role = await this.getUserRole(userId);
    return POLICIES.ADMIN_STAFF.includes(role);
  },

  /**
   * 👑 Безопасное изменение роли (Secure Role Promotion).
   * Реализует жесткую защиту от повышения привилегий (Privilege Escalation).
   *
   * @param {number} initiatorId - ID того, кто меняет роль
   * @param {number} targetUserId - ID того, кому меняют роль
   * @param {string} newRole - Новая роль
   * @returns {Promise<Object>} Обновленный объект пользователя
   * @throws {Error} Если нарушены правила безопасности
   */
  async changeUserRole(initiatorId, targetUserId, newRole) {
    // 1. Параллельная загрузка ролей для оптимизации
    const [initiatorRole, targetRole] = await Promise.all([
      this.getUserRole(initiatorId),
      this.getUserRole(targetUserId),
    ]);

    // 2. Валидация существования роли
    if (
      !POLICIES.ASSIGNABLE_ROLES.includes(newRole) &&
      newRole !== ROLES.OWNER
    ) {
      throw new Error(
        `⛔ Ошибка: Роли "${newRole}" не существует. Доступные: ${POLICIES.ASSIGNABLE_ROLES.join(", ")}`,
      );
    }

    // 3. ПРАВИЛА БЕЗОПАСНОСТИ (Security Policy Enforcement)

    // Правило A: Иммунитет Владельца. Никто не может разжаловать Владельца (даже другой Владелец).
    // Это защита от случайного "выстрела в ногу".
    if (targetRole === ROLES.OWNER) {
      throw new Error("⛔ Отказано: Нельзя изменять права Владельца системы.");
    }

    // Правило B: Ограничение Менеджеров. Менеджеры управляют заказами, а не людьми.
    if (initiatorRole === ROLES.MANAGER) {
      throw new Error(
        "⛔ Отказано: Менеджеры не имеют прав управления персоналом.",
      );
    }

    // Правило C: Иерархия Администраторов.
    // Админ не может назначать Владельцев или других Админов.
    // Админ не может менять роль равного себе или старшего.
    if (initiatorRole === ROLES.ADMIN) {
      if (newRole === ROLES.OWNER || newRole === ROLES.ADMIN) {
        throw new Error(
          "⛔ Отказано: Администратор не может выдавать права уровня Admin/Owner.",
        );
      }
      if (targetRole === ROLES.ADMIN || targetRole === ROLES.OWNER) {
        throw new Error(
          "⛔ Отказано: Вы не можете менять роль равного или старшего по званию.",
        );
      }
    }

    // Правило D: Владелец (Owner) может всё.

    // 4. Атомарное обновление
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
   * 📢 Получение списка ID персонала для уведомлений.
   * Используется при создании нового заказа, чтобы оповестить команду.
   */
  async getAdminIdsForNotification() {
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
   * 📊 Получение расширенного профиля пользователя (360-View).
   * Собирает данные из разных таблиц: профиль + агрегированная статистика заказов.
   */
  async getUserProfile(userId) {
    // Шаг 1: Данные пользователя
    const userRes = await db.query(
      "SELECT * FROM users WHERE telegram_id = $1",
      [userId],
    );
    const user = userRes.rows[0];
    if (!user) return null;

    // Шаг 2: Финансовая статистика (LTV)
    // Исключаем отмененные заказы из подсчета денег
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
   * Оптимизировано для рендеринга больших списков в админке.
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
   * 🔍 Полнотекстовый поиск пользователей.
   * Ищет по ID, Имени, Username или Телефону.
   * Использует ILIKE для регистронезависимого поиска.
   *
   * @param {string} query - Поисковый запрос
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
   * 📈 Глобальная статистика (KPI Dashboard).
   * Выполняет 3 параллельных запроса для формирования сводки.
   */
  async getDashboardStats() {
    const [usersData, ordersData, activeData] = await Promise.all([
      // KPI 1: База пользователей
      db.query("SELECT COUNT(*) as count FROM users"),

      // KPI 2: Общая выручка (Только завершенные заказы)
      db.query(
        "SELECT SUM(total_price) as revenue FROM orders WHERE status = 'done'",
      ),

      // KPI 3: DAU (Daily Active Users) - кто обновлялся за 24ч
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
   * 🎯 Таргетинг аудитории для рассылок (Broadcast).
   * Позволяет сегментировать получателей по ролям.
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
      // Клиентами считаем всех, у кого роль 'user'
      sql += ` WHERE role = $1`;
      params.push(ROLES.CLIENT);
    }
    // 'all' берет всех без WHERE

    const res = await db.query(sql, params);
    return res.rows.map((r) => r.telegram_id);
  },
};

/**
 * @file public/js/api.js
 * @description API Client (Singleton). RESTful Архитектура.
 * Отвечает за связь фронтенда с обновленным Express Backend'ом.
 * Включает обработку сессий, стандартизированный fetch и новые Enterprise-методы.
 * Никакой UI логики здесь нет — только чистая работа с сетью.
 * * @version 8.0.0 (Senior Architect Edition)
 */

class ApiClient {
  constructor(baseUrl = "/api") {
    this.baseUrl = baseUrl;
  }

  /**
   * 🛠 Универсальный приватный метод для отправки HTTP-запросов (REST).
   * Автоматически парсит JSON и перехватывает ошибки от сервера.
   */
  async _request(endpoint, method = "GET", body = null) {
    const options = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      // Куки (сессия) передаются автоматически, так как фронт и API на одном домене
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, options);

      // Пытаемся распарсить JSON, даже если статус ошибочный (чтобы прочитать текст ошибки)
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Пробрасываем ошибку дальше, чтобы UI мог показать красивый Toast
        throw new Error(data.error || `HTTP Error: ${response.status}`);
      }

      return data;
    } catch (error) {
      console.error(`📡 [API Error] ${method} ${endpoint}:`, error.message);
      throw error;
    }
  }

  // =========================================================================
  // 🔐 АВТОРИЗАЦИЯ (AUTHENTICATION)
  // =========================================================================

  /**
   * @param {string} login
   * @param {string} password
   */
  async login(login, password) {
    return this._request("/auth/login", "POST", { login, password });
  }

  async logout() {
    return this._request("/auth/logout", "POST");
  }

  /**
   * Проверка валидности сессии (вызывается при старте SPA)
   */
  async checkAuth() {
    try {
      const res = await this._request("/auth/check");
      return res.authenticated;
    } catch (e) {
      return false;
    }
  }

  // =========================================================================
  // 📊 ДАШБОРД И АНАЛИТИКА (DASHBOARD)
  // =========================================================================

  async getDashboardData() {
    return this._request("/dashboard/stats");
  }

  // =========================================================================
  // 📦 УПРАВЛЕНИЕ ЗАКАЗАМИ (ORDERS)
  // =========================================================================

  async getOrders(status = "all", limit = 100, offset = 0) {
    const query = new URLSearchParams({ status, limit, offset }).toString();
    return this._request(`/orders?${query}`);
  }

  async updateOrderStatus(id, status) {
    return this._request(`/orders/${id}/status`, "PATCH", { status });
  }

  /**
   * 🔥 НОВОЕ: Сохранение метаданных заказа (JSONB)
   * @param {number|string} id - ID заказа
   * @param {string} key - ключ ('address', 'comment', 'cancel_reason')
   * @param {any} value - значение
   */
  async updateOrderDetails(id, key, value) {
    return this._request(`/orders/${id}/details`, "PATCH", { key, value });
  }

  // =========================================================================
  // ⚙️ НАСТРОЙКИ И ЦЕНЫ (SETTINGS & DYNAMIC PRICING)
  // =========================================================================

  async getSettings() {
    return this._request("/settings");
  }

  /**
   * Обновление стоимости услуги или коэффициента
   */
  async updateSetting(key, value) {
    return this._request("/settings", "POST", { key, value });
  }

  // =========================================================================
  // 👥 ПЕРСОНАЛ И ПОЛЬЗОВАТЕЛИ (STAFF)
  // =========================================================================

  async getUsers(limit = 100, offset = 0) {
    const query = new URLSearchParams({ limit, offset }).toString();
    return this._request(`/users?${query}`);
  }

  async changeUserRole(userId, role) {
    return this._request("/users/role", "POST", { userId, role });
  }

  // =========================================================================
  // 🚀 МАРКЕТИНГ И РАССЫЛКА (BROADCAST)
  // =========================================================================

  /**
   * 🔥 НОВОЕ: Запуск массовой рассылки через Telegram-бота
   * @param {string} text - Текст сообщения (поддерживает HTML)
   * @param {string|null} imageUrl - Прямая ссылка на картинку (опционально)
   * @param {string} targetRole - 'all', 'user', 'manager' и т.д.
   */
  async sendBroadcast(text, imageUrl = null, targetRole = "all") {
    return this._request("/broadcast", "POST", { text, imageUrl, targetRole });
  }
}

// Экспортируем готовый синглтон
const api = new ApiClient();

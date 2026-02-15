/**
 * =============================================================================
 * 🔌 PROELECTRO API CLIENT
 * =============================================================================
 * @file public/js/api.js
 * @description Слой работы с данными (Data Layer).
 * Отвечает за HTTP-запросы к серверу, обработку ошибок и авторизацию.
 * Никакой UI-логики здесь нет, только чистые данные.
 */

const API_BASE = "/api";

class ApiClient {
  /**
   * Универсальный метод запроса
   * @private
   */
  static async request(endpoint, options = {}) {
    const config = {
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    };

    try {
      const response = await fetch(`${API_BASE}${endpoint}`, config);

      // 1. Обработка потери сессии (401 Unauthorized)
      if (response.status === 401) {
        console.warn("⚠️ Session expired. Redirecting to login...");
        // Если мы не на экране логина, перезагружаем страницу
        if (document.getElementById("app").style.display !== "none") {
          window.location.reload();
        }
        throw new Error("Требуется авторизация");
      }

      // 2. Парсинг ответа
      const data = await response.json();

      // 3. Обработка ошибок API (например, "Недостаточно средств")
      if (!response.ok) {
        throw new Error(data.error || `Ошибка сервера: ${response.status}`);
      }

      return data;
    } catch (error) {
      console.error(`💥 API Error [${endpoint}]:`, error.message);
      throw error;
    }
  }

  // =========================================================================
  // 🔐 AUTH (Авторизация)
  // =========================================================================

  static async checkAuth() {
    return this.request("/me");
  }

  static async login(password) {
    return this.request("/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  }

  static async logout() {
    return this.request("/logout", { method: "POST" });
  }

  // =========================================================================
  // 📊 ANALYTICS (Аналитика)
  // =========================================================================

  static async getKPI() {
    return this.request("/analytics/kpi");
  }

  static async getRevenueChart() {
    return this.request("/analytics/revenue-chart");
  }

  static async getFinanceStats() {
    return this.request("/analytics/finance");
  }

  // =========================================================================
  // 📦 ORDERS (Заказы)
  // =========================================================================

  /**
   * Получить список заказов с фильтрацией
   * @param {Object} params { page, limit, status, search }
   */
  static async getOrders(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/orders?${query}`);
  }

  /**
   * Создать заказ вручную
   */
  static async createOrder(data) {
    return this.request("/orders", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /**
   * Обновить заказ (Статус, Менеджер)
   * Это ключевой метод для изменения заказа после замера!
   */
  static async updateOrder(id, data) {
    return this.request(`/orders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  /**
   * Удалить заказ (Архивация)
   */
  static async deleteOrder(id) {
    return this.request(`/orders/${id}`, { method: "DELETE" });
  }

  // =========================================================================
  // 💰 ACCOUNTS & FINANCE (Счета и переводы)
  // =========================================================================

  static async getAccounts() {
    return this.request("/accounts");
  }

  static async transfer(fromId, toId, amount, comment) {
    return this.request("/accounts/transfer", {
      method: "POST",
      body: JSON.stringify({ fromId, toId, amount, comment }),
    });
  }

  static async addTransaction(data) {
    return this.request("/transactions", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // =========================================================================
  // 👥 USERS (CRM)
  // =========================================================================

  static async getUsers() {
    return this.request("/users");
  }

  static async updateUserRole(id, role) {
    return this.request(`/users/${id}/role`, {
      method: "POST",
      body: JSON.stringify({ role }),
    });
  }

  // =========================================================================
  // ⚙️ SETTINGS (Настройки цен)
  // =========================================================================

  static async getSettings() {
    return this.request("/settings");
  }

  static async updateSettings(data) {
    return this.request("/settings", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
}

// Экспортируем в глобальную область видимости (для браузера)
window.API = ApiClient;

/**
 * @file public/js/api.js
 * @description Frontend API Client (ERP Middleware v9.1.2).
 * Обеспечивает строгую типизацию запросов к REST API сервера ProElectric.
 * Включает методы финансового контроллера, управления заказами и динамического прайс-листа.
 *
 * @module API
 * @version 9.1.2 (Enterprise ERP Edition)
 */

const API_BASE = "/api";

/**
 * Универсальная обертка для HTTP-запросов (Fetch Wrapper).
 * Автоматически обрабатывает JSON, заголовки, сессии и перехватывает ошибки.
 * @param {string} endpoint - Путь (например, '/orders')
 * @param {Object} options - Fetch options (method, body, etc.)
 * @returns {Promise<any>}
 */
async function fetchWrapper(endpoint, options = {}) {
  options.credentials = "include"; // Обязательно для передачи сессионных куки (авторизация)
  options.headers = options.headers || {};

  // Если передаем не FormData, ставим заголовок JSON
  if (!(options.body instanceof FormData)) {
    options.headers["Content-Type"] = "application/json";
  }

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, options);
    const data = await response.json();

    if (!response.ok) {
      // Пробрасываем ошибку с бэкенда для отображения в Utils.showToast
      throw new Error(data.error || "Неизвестная ошибка сервера");
    }
    return data;
  } catch (error) {
    console.error(`[API Controller] Failed request to ${endpoint}:`, error);
    throw error;
  }
}

/**
 * Экспорт всех методов для работы CRM (Data Access Layer Front-end)
 */
export const API = {
  // ==========================================
  // 🔐 AUTHENTICATION
  // ==========================================
  login: (login, password) =>
    fetchWrapper("/auth/login", {
      method: "POST",
      body: JSON.stringify({ login, password }),
    }),

  logout: () => fetchWrapper("/auth/logout", { method: "POST" }),

  checkAuth: () => fetchWrapper("/auth/check"),

  // ==========================================
  // 📊 DASHBOARD (ANALYTICS)
  // ==========================================
  getStats: () => fetchWrapper("/dashboard/stats"),

  // ==========================================
  // 📦 ORDERS MANAGEMENT
  // ==========================================
  getOrders: (status = "all", limit = 100, offset = 0) =>
    fetchWrapper(`/orders?status=${status}&limit=${limit}&offset=${offset}`),

  /**
   * Создание оффлайн-лида вручную (Без бота, через CRM)
   */
  createManualOrder: (data) =>
    fetchWrapper("/orders", { method: "POST", body: JSON.stringify(data) }),

  updateOrderStatus: (id, status) =>
    fetchWrapper(`/orders/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  /**
   * Универсальное обновление деталей (BOM-массив, адрес, комментарий)
   */
  updateOrderDetails: (id, key, value) =>
    fetchWrapper(`/orders/${id}/details`, {
      method: "PATCH",
      body: JSON.stringify({ key, value }),
    }),

  // ==========================================
  // 💸 FINANCE (ERP MODULE)
  // ==========================================

  /**
   * Переопределение итоговой цены для клиента
   */
  updateOrderFinalPrice: (id, newPrice) =>
    fetchWrapper(`/orders/${id}/finance/price`, {
      method: "PATCH",
      body: JSON.stringify({ newPrice }),
    }),

  /**
   * Добавление расхода к объекту (Материалы, Такси, Инструмент)
   */
  addOrderExpense: (id, amount, category, comment) =>
    fetchWrapper(`/orders/${id}/finance/expense`, {
      method: "POST",
      body: JSON.stringify({ amount, category, comment }),
    }),

  // ==========================================
  // ⚙️ SYSTEM SETTINGS (DYNAMIC PRICING)
  // ==========================================
  getSettings: () => fetchWrapper("/settings"),

  /**
   * Получение структурированного прайс-листа по категориям из OrderService
   */
  getPricelist: () => fetchWrapper("/pricelist"),

  updateSetting: (key, value) =>
    fetchWrapper("/settings", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    }),

  /**
   * Массовое обновление настроек (Bulk Update) за одну транзакцию
   */
  updateBulkSettings: (payloadArray) =>
    fetchWrapper("/settings", {
      method: "POST",
      body: JSON.stringify(payloadArray),
    }),

  // ==========================================
  // 👥 STAFF & BROADCAST
  // ==========================================
  getUsers: (limit = 100, offset = 0) =>
    fetchWrapper(`/users?limit=${limit}&offset=${offset}`),

  updateUserRole: (userId, role) =>
    fetchWrapper("/users/role", {
      method: "POST",
      body: JSON.stringify({ userId, role }),
    }),

  sendBroadcast: (text, imageUrl, targetRole) =>
    fetchWrapper("/broadcast", {
      method: "POST",
      body: JSON.stringify({ text, imageUrl, targetRole }),
    }),
};

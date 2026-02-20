/**
 * @file public/js/api.js
 * @description Frontend API Client (ERP Middleware v10.7.0).
 * Обеспечивает строгую типизацию запросов к REST API сервера ProElectric.
 * Включает методы OTP-авторизации, глубокой аналитики, управления бригадами и инкассации.
 * ДОБАВЛЕНО: Эндпоинты для Timeline (График доходов) и Рейтинга бригад.
 *
 * @module API
 * @version 10.7.0 (Enterprise ERP & Advanced Analytics Edition)
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
  options.credentials = "include"; // Обязательно для передачи сессионных куки
  options.headers = options.headers || {};

  // Если передаем не FormData, ставим заголовок JSON
  if (!(options.body instanceof FormData)) {
    options.headers["Content-Type"] = "application/json";
  }

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, options);

    // Обработка скачивания файлов (например, дамп базы данных JSON)
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json") === false) {
      return response; // Возвращаем сырой объект Response для скачивания Blob в app.js
    }

    const data = await response.json();

    if (!response.ok) {
      // Пробрасываем ошибку с бэкенда для отображения в UI (включая 401 и 403)
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
  // 🔐 AUTHENTICATION & OTP (Zero-Trust)
  // ==========================================

  // Legacy login (Оставлен для обратной совместимости / fallback)
  login: (login, password) =>
    fetchWrapper("/auth/login", {
      method: "POST",
      body: JSON.stringify({ login, password }),
    }),

  // OTP Авторизация по номеру телефона
  requestOtp: (phone) =>
    fetchWrapper("/auth/otp/request", {
      method: "POST",
      body: JSON.stringify({ phone }),
    }),

  verifyOtp: (phone, otp) =>
    fetchWrapper("/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ phone, otp }),
    }),

  logout: () => fetchWrapper("/auth/logout", { method: "POST" }),

  // Проверка сессии (возвращает роль пользователя для RBAC роутинга)
  checkAuth: () => fetchWrapper("/auth/me"),

  // ==========================================
  // 📊 DASHBOARD & ADVANCED ANALYTICS (NEW)
  // ==========================================
  getStats: () => fetchWrapper("/dashboard/stats"),

  // Глубокая аналитика (юнит-экономика)
  getDeepAnalytics: () => fetchWrapper("/analytics/deep"),

  // НОВОЕ: Таймлайн (Доходы фирмы по месяцам)
  getTimeline: () => fetchWrapper("/analytics/timeline"),

  // НОВОЕ: Рейтинг бригад (Leaderboard: кто сколько заработал и должен)
  getBrigadesAnalytics: () => fetchWrapper("/analytics/brigades"),

  // ==========================================
  // 🏗 BRIGADES MANAGEMENT (ERP)
  // ==========================================
  getBrigades: () => fetchWrapper("/brigades"),

  createBrigade: (name, brigadierId, profitPercentage) =>
    fetchWrapper("/brigades", {
      method: "POST",
      body: JSON.stringify({ name, brigadierId, profitPercentage }),
    }),

  updateBrigade: (id, profitPercentage, isActive) =>
    fetchWrapper(`/brigades/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ profitPercentage, isActive }),
    }),

  getBrigadeOrders: (id) => fetchWrapper(`/brigades/${id}/orders`),

  // ==========================================
  // 📦 ORDERS MANAGEMENT
  // ==========================================
  getOrders: (status = "all", limit = 100, offset = 0) =>
    fetchWrapper(`/orders?status=${status}&limit=${limit}&offset=${offset}`),

  createManualOrder: (data) =>
    fetchWrapper("/orders", { method: "POST", body: JSON.stringify(data) }),

  updateOrderStatus: (id, status) =>
    fetchWrapper(`/orders/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  updateOrderDetails: (id, key, value) =>
    fetchWrapper(`/orders/${id}/details`, {
      method: "PATCH",
      body: JSON.stringify({ key, value }),
    }),

  // Расширенное управление объектами (ERP Level)
  assignBrigade: (id, brigadeId) =>
    fetchWrapper(`/orders/${id}/assign`, {
      method: "PATCH",
      body: JSON.stringify({ brigadeId }),
    }),

  updateBOM: (id, newBomArray) =>
    fetchWrapper(`/orders/${id}/bom`, {
      method: "PATCH",
      body: JSON.stringify({ newBomArray }),
    }),

  finalizeOrder: (id) =>
    fetchWrapper(`/orders/${id}/finalize`, { method: "POST" }),

  // ==========================================
  // 💸 PROJECT FINANCE (ORDER LEVEL)
  // ==========================================
  updateOrderFinalPrice: (id, newPrice) =>
    fetchWrapper(`/orders/${id}/finance/price`, {
      method: "PATCH",
      body: JSON.stringify({ newPrice }),
    }),

  addOrderExpense: (id, amount, category, comment) =>
    fetchWrapper(`/orders/${id}/finance/expense`, {
      method: "POST",
      body: JSON.stringify({ amount, category, comment }),
    }),

  // ==========================================
  // 🏢 CORPORATE FINANCE (GLOBAL CASHBOX)
  // ==========================================
  getFinanceAccounts: () => fetchWrapper("/finance/accounts"),

  getFinanceTransactions: (limit = 100) =>
    fetchWrapper(`/finance/transactions?limit=${limit}`),

  addFinanceTransaction: (data) =>
    fetchWrapper("/finance/transactions", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Проведение Инкассации (Списание долга бригады)
  approveIncassation: (brigadierId, amount) =>
    fetchWrapper("/finance/incassation/approve", {
      method: "POST",
      body: JSON.stringify({ brigadierId, amount }),
    }),

  // ==========================================
  // ⚙️ SYSTEM SETTINGS & DEVOPS
  // ==========================================
  getSettings: () => fetchWrapper("/settings"),

  getPricelist: () => fetchWrapper("/pricelist"),

  updateSetting: (key, value) =>
    fetchWrapper("/settings", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    }),

  updateBulkSettings: (payloadArray) =>
    fetchWrapper("/settings", {
      method: "POST",
      body: JSON.stringify(payloadArray),
    }),

  // Запрос на формирование и скачивание дампа базы
  downloadBackup: () => fetchWrapper("/system/backup"),

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

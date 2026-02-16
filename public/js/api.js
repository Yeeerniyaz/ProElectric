/**
 * 🔌 API Client (Singleton)
 * Отвечает за общение с сервером. Никакой UI логики.
 */
class ApiClient {
  constructor(baseUrl = "/api/execute") {
    this.baseUrl = baseUrl;
  }

  async request(action, payload = {}) {
    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, payload }),
      });

      if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

      const json = await response.json();
      if (!json.ok) throw new Error(json.error || "Unknown API Error");

      return json.data;
    } catch (error) {
      console.error("API Request Failed:", error);
      // Можно добавить всплывающее уведомление об ошибке здесь
      throw error;
    }
  }

  // Удобные методы-обертки
  getStats() {
    return this.request("get_stats");
  }
  getOrders() {
    return this.request("get_orders");
  }
  getUsers() {
    return this.request("get_users");
  }
  updateOrderStatus(id, status) {
    return this.request("update_status", { id, status });
  }
}

export const api = new ApiClient();

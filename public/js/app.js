/**
 * @file public/js/app.js
 * @description Главный контроллер Frontend приложения (Single Page Application).
 * Управляет отображением заказов, редактированием смет и настройками.
 *
 * @version 9.0.0 (Enterprise UI)
 * @author ProElectric Team
 */

import { API } from "./api.js";

// =============================================================================
// 🛠 UTILITIES
// =============================================================================

const Utils = {
  // Форматирование денег (1000 -> 1 000 ₸)
  formatCurrency: (value) => {
    return new Intl.NumberFormat("ru-KZ", {
      style: "currency",
      currency: "KZT",
      maximumFractionDigits: 0,
    }).format(value || 0);
  },

  // Форматирование даты
  formatDate: (dateString) => {
    if (!dateString) return "-";
    return new Date(dateString).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  },

  // Статусы и их цвета
  getStatusBadge: (status) => {
    const map = {
      new: { label: "Новый", class: "badge-new" },
      work: { label: "В работе", class: "badge-work" },
      done: { label: "Завершен", class: "badge-done" },
      draft: { label: "Черновик", class: "badge-draft" },
    };
    const s = map[status] || { label: status, class: "badge-default" };
    return `<span class="pe-badge ${s.class}">${s.label}</span>`;
  },

  showToast: (message, type = "info") => {
    // Простой тостер. В реальном проекте лучше использовать библиотеку.
    const toast = document.createElement("div");
    toast.className = `pe-toast pe-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  },
};

// =============================================================================
// 🚀 APPLICATION CORE
// =============================================================================

const App = {
  state: {
    currentUser: null,
    currentOrder: null, // Кешируем открытый заказ для редактирования
    settings: {}, // Кеш настроек
  },

  async init() {
    console.log("🚀 ProElectric Enterprise UI v9.0.0 Loading...");
    
    try {
      // 1. Проверка авторизации
      const auth = await API.checkAuth();
      if (!auth.authenticated) {
        window.location.href = "/login.html";
        return;
      }

      // 2. Инициализация навигации
      this.bindNavigation();

      // 3. Загрузка дефолтной страницы (Дашборд или Заказы)
      this.loadOrders(); 

    } catch (e) {
      console.error("Init Error:", e);
    }
  },

  bindNavigation() {
    document.getElementById("btn-nav-orders")?.addEventListener("click", () => this.loadOrders());
    document.getElementById("btn-nav-settings")?.addEventListener("click", () => this.loadSettings());
    document.getElementById("btn-logout")?.addEventListener("click", async () => {
      await API.logout();
      window.location.reload();
    });
  },

  // ===========================================================================
  // 📦 ORDERS MODULE
  // ===========================================================================

  async loadOrders() {
    this.renderView("loading");
    try {
      const orders = await API.getOrders(100, 0); // Берем последние 100
      this.renderOrdersList(orders);
    } catch (e) {
      this.renderError("Ошибка загрузки заказов: " + e.message);
    }
  },

  renderOrdersList(orders) {
    const container = document.getElementById("main-content"); // Основной контейнер
    
    let html = `
      <div class="pe-header-row">
        <h2>📦 Список заказов</h2>
        <button class="pe-btn pe-btn-primary" onclick="App.openCreateOrderModal()">+ Создать вручную</button>
      </div>
      <div class="pe-table-responsive">
        <table class="pe-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Клиент</th>
              <th>Адрес/Инфо</th>
              <th>Сумма</th>
              <th>Статус</th>
              <th>Дата</th>
              <th>Действие</th>
            </tr>
          </thead>
          <tbody>
    `;

    if (orders.length === 0) {
      html += `<tr><td colspan="7" class="text-center">Заказов пока нет</td></tr>`;
    } else {
      html += orders.map(o => `
        <tr onclick="App.openOrderDetails(${o.id})" class="clickable-row">
          <td>#${o.id}</td>
          <td>
            <div class="fw-bold">${o.client_name || "Неизвестно"}</div>
            <small>${o.client_phone || ""}</small>
          </td>
          <td>${o.details?.params?.wallType || "-"} (${o.details?.params?.area || 0} м²)</td>
          <td>${Utils.formatCurrency(o.total_price)}</td>
          <td>${Utils.getStatusBadge(o.status)}</td>
          <td>${Utils.formatDate(o.created_at)}</td>
          <td><button class="pe-btn pe-btn-sm">Открыть</button></td>
        </tr>
      `).join("");
    }

    html += `</tbody></table></div>`;
    container.innerHTML = html;
  },

  /**
   * [CRITICAL FIX] Открытие деталей заказа.
   * Теперь корректно обрабатывает массив расходов (expenses).
   */
  async openOrderDetails(orderId) {
    this.renderView("loading");
    try {
      const order = await API.getOrder(orderId);
      this.state.currentOrder = order; // Сохраняем в стейт
      this.renderOrderDetailsView(order);
    } catch (e) {
      this.renderError("Не удалось открыть заказ: " + e.message);
    }
  },

  renderOrderDetailsView(order) {
    const container = document.getElementById("main-content");
    
    // 1. Безопасное извлечение расходов (Fix for 'undefined length')
    const expenses = Array.isArray(order.expenses) ? order.expenses : [];
    
    // 2. Расчет чистой прибыли для отображения
    const profit = order.calculated_profit || 0;
    const profitClass = profit >= 0 ? "text-success" : "text-danger";

    const html = `
      <div class="pe-details-page">
        <div class="pe-details-header">
          <button class="pe-btn pe-btn-secondary" onclick="App.loadOrders()">← Назад</button>
          <h2>Заказ #${order.id} <span style="font-size:0.6em">${Utils.getStatusBadge(order.status)}</span></h2>
        </div>

        <div class="pe-grid-2">
          <div class="pe-card">
            <h3>📊 Финансы</h3>
            <div class="pe-stat-row">
              <span>Сумма заказа:</span>
              <strong>${Utils.formatCurrency(order.total_price)}</strong>
            </div>
            <div class="pe-stat-row">
              <span>Расходы:</span>
              <strong class="text-danger">-${Utils.formatCurrency(order.financial_stats?.expenses || 0)}</strong>
            </div>
             <div class="pe-stat-row">
              <span>Материалы (BOM):</span>
              <strong class="text-warning">-${Utils.formatCurrency(order.financial_stats?.materialsCost || 0)}</strong>
            </div>
            <hr>
            <div class="pe-stat-row big">
              <span>Чистая прибыль:</span>
              <strong class="${profitClass}">${Utils.formatCurrency(profit)}</strong>
            </div>

            <div class="pe-actions mt-3">
              <h4>Действия</h4>
              <button class="pe-btn pe-btn-danger w-100 mb-2" onclick="App.openAddExpenseModal(${order.id})">💸 Добавить расход</button>
              <select class="pe-input w-100" onchange="App.changeStatus(${order.id}, this.value)">
                <option value="new" ${order.status === 'new' ? 'selected' : ''}>Новый</option>
                <option value="work" ${order.status === 'work' ? 'selected' : ''}>В работе</option>
                <option value="done" ${order.status === 'done' ? 'selected' : ''}>Завершен</option>
                <option value="draft" ${order.status === 'draft' ? 'selected' : ''}>Черновик</option>
              </select>
            </div>
          </div>

          <div class="pe-card">
            <h3>🧾 История расходов</h3>
            <div class="pe-expenses-list">
              ${expenses.length === 0 
                ? `<p class="text-muted">Расходов пока нет.</p>` 
                : expenses.map(exp => `
                  <div class="pe-expense-item">
                    <div class="d-flex justify-content-between">
                      <strong>${exp.category}</strong>
                      <span class="text-danger">-${Utils.formatCurrency(exp.amount)}</span>
                    </div>
                    <small>${exp.comment || ""}</small>
                    <div class="text-muted x-small">${Utils.formatDate(exp.created_at)}</div>
                  </div>
                `).join("")}
            </div>
          </div>
        </div>

        <div class="pe-card mt-3">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <h3>🛠 Смета материалов (BOM)</h3>
            <button class="pe-btn pe-btn-primary" onclick="App.saveBOM(${order.id})">💾 Сохранить изменения</button>
          </div>
          <div class="pe-table-responsive">
            <table class="pe-table pe-table-compact" id="bom-table">
              <thead>
                <tr>
                  <th>Наименование</th>
                  <th width="100">Кол-во</th>
                  <th width="80">Ед.</th>
                  <th width="120">Цена (₸)</th>
                  <th width="120">Итого</th>
                  <th width="50"></th>
                </tr>
              </thead>
              <tbody id="bom-tbody">
                ${this.renderBOMRows(order.details?.materials || [])}
              </tbody>
            </table>
            <button class="pe-btn pe-btn-sm pe-btn-secondary mt-2" onclick="App.addBOMRow()">+ Добавить строку</button>
          </div>
        </div>
      </div>
    `;
    
    container.innerHTML = html;
  },

  renderBOMRows(materials) {
    if (!materials || materials.length === 0) return "";
    return materials.map((m, idx) => `
      <tr class="bom-row" data-idx="${idx}">
        <td><input type="text" class="pe-input bom-name" value="${m.name || ''}"></td>
        <td><input type="number" class="pe-input bom-qty" value="${m.qty || 0}" oninput="App.recalcRow(this)"></td>
        <td><input type="text" class="pe-input bom-unit" value="${m.unit || 'шт'}" style="width:60px"></td>
        <td><input type="number" class="pe-input bom-price" value="${m.price || 0}" oninput="App.recalcRow(this)"></td>
        <td class="bom-total fw-bold">${Utils.formatCurrency(m.total || (m.qty * m.price))}</td>
        <td><button class="pe-btn-icon text-danger" onclick="this.closest('tr').remove()">×</button></td>
      </tr>
    `).join("");
  },

  // ===========================================================================
  // ⚙️ LOGIC: BOM EDITING
  // ===========================================================================

  recalcRow(input) {
    const tr = input.closest("tr");
    const qty = parseFloat(tr.querySelector(".bom-qty").value) || 0;
    const price = parseFloat(tr.querySelector(".bom-price").value) || 0;
    const total = qty * price;
    tr.querySelector(".bom-total").textContent = Utils.formatCurrency(total);
  },

  addBOMRow() {
    const tbody = document.getElementById("bom-tbody");
    const tr = document.createElement("tr");
    tr.className = "bom-row";
    tr.innerHTML = `
      <td><input type="text" class="pe-input bom-name" value="Новый материал"></td>
      <td><input type="number" class="pe-input bom-qty" value="1" oninput="App.recalcRow(this)"></td>
      <td><input type="text" class="pe-input bom-unit" value="шт" style="width:60px"></td>
      <td><input type="number" class="pe-input bom-price" value="0" oninput="App.recalcRow(this)"></td>
      <td class="bom-total fw-bold">0 ₸</td>
      <td><button class="pe-btn-icon text-danger" onclick="this.closest('tr').remove()">×</button></td>
    `;
    tbody.appendChild(tr);
  },

  async saveBOM(orderId) {
    const rows = document.querySelectorAll(".bom-row");
    const materials = [];
    
    rows.forEach(row => {
      const qty = parseFloat(row.querySelector(".bom-qty").value) || 0;
      const price = parseFloat(row.querySelector(".bom-price").value) || 0;
      materials.push({
        name: row.querySelector(".bom-name").value,
        qty: qty,
        unit: row.querySelector(".bom-unit").value,
        price: price,
        total: qty * price
      });
    });

    try {
      await API.updateBOM(orderId, materials);
      Utils.showToast("Смета успешно обновлена!", "success");
      this.openOrderDetails(orderId); // Перезагружаем для обновления сумм
    } catch (e) {
      Utils.showToast("Ошибка сохранения: " + e.message, "error");
    }
  },

  // ===========================================================================
  // 💸 LOGIC: EXPENSES
  // ===========================================================================

  openAddExpenseModal(orderId) {
    const amount = prompt("Сумма расхода (₸):");
    if (!amount) return;
    
    const category = prompt("Категория (Такси, Обед, Материал, Инструмент):", "Расход");
    if (!category) return;

    const comment = prompt("Комментарий:", "");

    this.addExpense(orderId, parseFloat(amount), category, comment);
  },

  async addExpense(orderId, amount, category, comment) {
    try {
      await API.addOrderExpense(orderId, amount, category, comment);
      Utils.showToast("Расход добавлен", "success");
      this.openOrderDetails(orderId); // Обновляем view
    } catch (e) {
      Utils.showToast("Ошибка: " + e.message, "error");
    }
  },

  async changeStatus(orderId, status) {
    try {
      await API.updateOrderStatus(orderId, status);
      Utils.showToast(`Статус изменен на ${status}`, "success");
      // Не перезагружаем всю страницу, просто бейдж можно обновить, но проще релоад
      this.openOrderDetails(orderId);
    } catch (e) {
      Utils.showToast("Ошибка смены статуса", "error");
    }
  },

  // ===========================================================================
  // ⚙️ SETTINGS MODULE
  // ===========================================================================

  async loadSettings() {
    this.renderView("loading");
    try {
      const settings = await API.getSettings();
      this.renderSettingsView(settings);
    } catch (e) {
      this.renderError("Ошибка настроек: " + e.message);
    }
  },

  renderSettingsView(settings) {
    const container = document.getElementById("main-content");
    const keys = Object.keys(settings).length ? Object.keys(settings) : [
      "price_strobe_concrete", "price_strobe_brick", "price_strobe_gas",
      "price_point_socket", "price_point_box", "price_point_chandelier",
      "price_cable_base", "price_shield_base_24"
    ];

    const html = `
      <div class="pe-details-page">
        <h2>⚙️ Настройки цен (Прайс-лист)</h2>
        <p class="text-muted">Эти цены используются при автоматическом расчете новых заказов.</p>
        
        <div class="pe-card">
          <div class="pe-settings-grid">
            ${keys.map(key => `
              <div class="pe-setting-item">
                <label>${key}</label>
                <input type="number" class="pe-input" id="set-${key}" value="${settings[key] || 0}">
                <button class="pe-btn pe-btn-sm pe-btn-primary mt-1" onclick="App.saveSetting('${key}')">Сохранить</button>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;
    container.innerHTML = html;
  },

  async saveSetting(key) {
    const input = document.getElementById(`set-${key}`);
    const value = input.value;
    try {
      await API.saveSetting(key, value);
      Utils.showToast(`Цена ${key} обновлена!`, "success");
    } catch (e) {
      Utils.showToast("Ошибка сохранения", "error");
    }
  },

  // ===========================================================================
  // 🏗 CORE UI HELPERS
  // ===========================================================================

  renderView(viewName) {
    const container = document.getElementById("main-content");
    if (viewName === "loading") {
      container.innerHTML = `<div class="text-center p-5"><h3>⏳ Загрузка...</h3></div>`;
    }
  },

  renderError(msg) {
    const container = document.getElementById("main-content");
    container.innerHTML = `<div class="alert alert-danger">${msg}</div>`;
  },
};

// Экспортируем App в глобальную область видимости, чтобы работал onclick="" в HTML
window.App = App;

// Запуск при загрузке DOM
document.addEventListener("DOMContentLoaded", () => {
  App.init();
});
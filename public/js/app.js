/**
 * @file public/js/app.js
 * @description Основная логика UI Админки (SPA).
 * Рендеринг таблиц, графиков и обработка форм.
 * @version 7.0.0 (Final Release)
 */

class App {
  constructor() {
    this.currentTab = "dashboard";
    this.init();
  }

  async init() {
    // 1. Проверка авторизации
    const isAdmin = await api.checkAuth();
    if (!isAdmin) {
      document.getElementById("login-screen").classList.remove("hidden");
      document.getElementById("app").classList.add("hidden");
      this.bindLogin();
    } else {
      document.getElementById("login-screen").classList.add("hidden");
      document.getElementById("app").classList.remove("hidden");
      this.bindEvents();
      this.loadTab("dashboard");
      this.updateDate();
    }
  }

  // --- BINDINGS ---
  bindLogin() {
    document
      .getElementById("login-form")
      .addEventListener("submit", async (e) => {
        e.preventDefault();
        const pass = document.getElementById("password").value;
        try {
          await api.login(pass);
          window.location.reload();
        } catch (err) {
          document.getElementById("login-error").innerText = err.message;
        }
      });
  }

  bindEvents() {
    // Logout
    document
      .getElementById("logout-btn")
      .addEventListener("click", () => api.logout());

    // Tab Switching
    document.querySelectorAll(".menu-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll(".menu-item")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.loadTab(btn.dataset.tab);
      });
    });

    // Create Order Form
    document
      .getElementById("create-order-form")
      .addEventListener("submit", async (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        try {
          await api.createOrder(Object.fromEntries(formData));
          closeModal("modal-create-order");
          alert("✅ Заказ создан!");
          this.loadOrders(); // Refresh
          e.target.reset();
        } catch (err) {
          alert("Ошибка: " + err.message);
        }
      });

    // Add Expense Form
    document
      .getElementById("add-expense-form")
      .addEventListener("submit", async (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const orderId = document.getElementById("expense-order-id").value;

        try {
          await api.addExpense(orderId, Object.fromEntries(formData));
          closeModal("modal-add-expense");
          alert("✅ Расход добавлен!");
          this.loadOrders(); // Refresh table
          e.target.reset();
        } catch (err) {
          alert("Ошибка: " + err.message);
        }
      });
  }

  // --- NAVIGATION ---
  loadTab(tabName) {
    this.currentTab = tabName;

    // UI Toggle
    document
      .querySelectorAll(".tab-content")
      .forEach((el) => el.classList.remove("active"));
    document.getElementById(`tab-${tabName}`).classList.add("active");
    document.getElementById("page-title").innerText =
      tabName === "dashboard"
        ? "Обзор"
        : tabName === "orders"
          ? "Управление заказами"
          : tabName === "finance"
            ? "Финансы"
            : "Настройки";

    // Data Loading
    if (tabName === "dashboard") this.loadDashboard();
    if (tabName === "orders") this.loadOrders();
    if (tabName === "finance") this.loadFinance();
    if (tabName === "settings") this.loadSettings();
  }

  // --- DASHBOARD ---
  async loadDashboard() {
    try {
      const data = await api.getDashboardData();

      document.getElementById("kpi-revenue").innerText = this.formatMoney(
        data.revenue,
      );
      document.getElementById("kpi-profit").innerText = this.formatMoney(
        data.profit,
      );
      document.getElementById("kpi-active").innerText = data.activeOrders;
      document.getElementById("kpi-done").innerText = data.totalOrders; // или data.doneOrders
    } catch (e) {
      console.error(e);
    }
  }

  // --- ORDERS ---
  async loadOrders(status = "all") {
    try {
      // Update Filter UI
      document
        .querySelectorAll(".filter-btn")
        .forEach((b) => b.classList.remove("active"));
      event?.target?.classList.add("active"); // Если вызвано кликом

      const res = await api.getOrders(status);
      const tbody = document.getElementById("orders-table-body");
      tbody.innerHTML = "";

      res.data.forEach((order) => {
        const tr = document.createElement("tr");

        // Расчет прибыли для отображения
        const expenses = parseFloat(order.expenses_sum || 0);
        const finalPrice = parseFloat(order.final_price || 0);
        const profit = order.status === "done" ? finalPrice - expenses : 0;

        const profitClass = profit > 0 ? "text-success" : "";

        tr.innerHTML = `
                    <td>#${order.id}</td>
                    <td>
                        <div style="font-weight:600">${order.client_name || "Гость"}</div>
                        <div style="font-size:12px; color:#64748b">${order.client_phone || "-"}</div>
                    </td>
                    <td><span class="status-badge ${order.status}">${this.translateStatus(order.status)}</span></td>
                    <td>${order.manager_name || '<span style="color:#cbd5e1">Не назначен</span>'}</td>
                    <td>
                        ${
                          order.status === "done"
                            ? `<b>${this.formatMoney(finalPrice)}</b>`
                            : `<span style="color:#64748b">~${this.formatMoney(order.total_price)}</span>`
                        }
                    </td>
                    <td style="color:#ef4444">-${this.formatMoney(expenses)}</td>
                    <td class="${profitClass}">${order.status === "done" ? this.formatMoney(profit) : "-"}</td>
                    <td>
                        <button class="btn secondary" style="padding: 5px 10px; font-size: 12px;" onclick="app.openAddExpense(${order.id})">
                            💸 Расход
                        </button>
                    </td>
                `;
        tbody.appendChild(tr);
      });
    } catch (e) {
      console.error(e);
    }
  }

  openAddExpense(orderId) {
    document.getElementById("expense-order-id").value = orderId;
    document.getElementById("expense-order-info").innerText =
      `Заказ #${orderId}`;
    openModal("modal-add-expense");
  }

  // --- FINANCE ---
  async loadFinance() {
    try {
      // Accounts
      const accounts = await api.getAccounts();
      const accContainer = document.getElementById("accounts-list");
      accContainer.innerHTML = "";

      accounts.forEach((acc) => {
        const div = document.createElement("div");
        div.className = "account-item";
        div.innerHTML = `
                    <span class="account-name">${acc.type === "bank" ? "💳" : "💵"} ${acc.name}</span>
                    <span class="account-balance">${this.formatMoney(acc.balance)}</span>
                `;
        accContainer.appendChild(div);
      });

      // Transactions
      const txs = await api.getTransactions();
      const txBody = document.getElementById("transactions-body");
      txBody.innerHTML = "";

      txs.forEach((tx) => {
        const tr = document.createElement("tr");
        const isIncome = tx.type === "income";
        const color = isIncome ? "var(--success)" : "var(--danger)";
        const sign = isIncome ? "+" : "-";

        tr.innerHTML = `
                    <td>${new Date(tx.created_at).toLocaleDateString()}</td>
                    <td>${tx.account_name}</td>
                    <td>${this.translateTxType(tx.category)}</td>
                    <td style="color:${color}; font-weight:600">${sign} ${this.formatMoney(tx.amount)}</td>
                    <td style="color:#64748b; font-size:12px">${tx.comment || "-"}</td>
                `;
        txBody.appendChild(tr);
      });
    } catch (e) {
      console.error(e);
    }
  }

  // --- SETTINGS ---
  async loadSettings() {
    try {
      const settings = await api.getSettings();
      const grid = document.getElementById("settings-grid");
      grid.innerHTML = "";

      const labels = {
        material_m2: "Цена материала (₸/м²)",
        price_point_concrete: "Точка (Бетон)",
        price_point_brick: "Точка (Кирпич)",
        price_point_gasblock: "Точка (Газоблок)",
        price_strobe_concrete: "Штроба (Бетон)",
        price_strobe_brick: "Штроба (Кирпич)",
        percent_staff: "Доля мастера (%)",
        percent_business: "Доля бизнеса (%)",
      };

      for (const [key, val] of Object.entries(settings)) {
        if (key.includes("updated_at")) continue;

        const div = document.createElement("div");
        div.className = "setting-item";
        div.innerHTML = `
                    <label>${labels[key] || key}</label>
                    <input type="number" value="${val}" onchange="app.saveSetting('${key}', this.value)">
                `;
        grid.appendChild(div);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async saveSetting(key, value) {
    try {
      await api.updateSetting(key, value);
      // Visual feedback (optional toast)
    } catch (e) {
      alert("Ошибка сохранения");
    }
  }

  // --- HELPERS ---
  formatMoney(num) {
    return new Intl.NumberFormat("ru-KZ", {
      style: "currency",
      currency: "KZT",
      maximumFractionDigits: 0,
    }).format(num);
  }

  translateStatus(status) {
    const map = {
      new: "Новый",
      discuss: "Обсуждение",
      work: "В работе",
      done: "Сдан",
      cancel: "Отмена",
    };
    return map[status] || status;
  }

  translateTxType(cat) {
    const map = {
      order_payment: "Оплата заказа",
      salary: "Зарплата",
      material: "Материал",
      taxi: "Такси",
      food: "Обед",
    };
    return map[cat] || cat;
  }

  updateDate() {
    const options = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    };
    document.getElementById("date-display").innerText =
      new Date().toLocaleDateString("ru-RU", options);
  }

  // Refresh button action
  refreshData() {
    this.loadTab(this.currentTab);
  }
}

// Global Helpers for HTML attributes
window.openModal = (id) =>
  document.getElementById(id).classList.remove("hidden");
window.closeModal = (id) => document.getElementById(id).classList.add("hidden");

// Start App
const app = new App();

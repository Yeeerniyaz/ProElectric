/**
 * @file public/js/app.js
 * @description SPA Controller v8.1 (Admin Pricing Edition).
 * Управляет интерфейсом, заказами и редактором цен.
 */

// =============================================================================
// 🛠 UTILS & HELPERS
// =============================================================================

const Utils = {
  formatMoney: (num) => {
    if (num === null || num === undefined) return "-";
    return new Intl.NumberFormat("ru-KZ", {
      style: "currency",
      currency: "KZT",
      maximumFractionDigits: 0,
    }).format(num);
  },

  formatDate: (isoDate) => {
    if (!isoDate) return "-";
    return new Date(isoDate).toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  },

  escapeHtml: (unsafe) => {
    if (typeof unsafe !== "string") return unsafe;
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  },
};

// =============================================================================
// 🍞 TOAST NOTIFICATIONS
// =============================================================================

class Toaster {
  constructor() {
    this.container = document.createElement("div");
    this.container.className = "toast-container";
    document.body.appendChild(this.container);
    this._injectStyles();
  }

  _injectStyles() {
    if (document.getElementById("toast-styles")) return;
    const css = `
            .toast-container { position: fixed; top: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; }
            .toast { min-width: 300px; padding: 16px; border-radius: 8px; background: white; box-shadow: 0 5px 15px rgba(0,0,0,0.15); display: flex; align-items: center; justify-content: space-between; animation: slideIn 0.3s ease-out; border-left: 4px solid #ccc; }
            .toast.success { border-left-color: #10b981; } 
            .toast.error { border-left-color: #ef4444; } 
            .toast-content { display: flex; align-items: center; gap: 12px; font-weight: 500; color: #1f2937; }
            .toast-close { cursor: pointer; color: #9ca3af; background: none; border: none; font-size: 18px; }
            @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
            @keyframes fadeOut { to { transform: translateX(100%); opacity: 0; } }
        `;
    const style = document.createElement("style");
    style.id = "toast-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  show(msg, type = "info") {
    const icons = {
      success: "check-circle",
      error: "alert-circle",
      info: "info",
    };
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
            <div class="toast-content"><i data-feather="${icons[type]}"></i><span>${msg}</span></div>
            <button class="toast-close">&times;</button>
        `;
    this.container.appendChild(toast);
    feather.replace();

    setTimeout(() => {
      toast.style.animation = "fadeOut 0.3s forwards";
      setTimeout(() => toast.remove(), 300);
    }, 3000);

    toast.querySelector(".toast-close").onclick = () => toast.remove();
  }
}
const toast = new Toaster();

// =============================================================================
// 🧊 STATE STORE
// =============================================================================

class Store {
  constructor() {
    this.state = { orders: [], settings: {}, filters: { status: "all" } };
    this.listeners = [];
  }
  get(key) {
    return this.state[key];
  }
  set(key, val) {
    this.state[key] = val;
    this._notify(key, val);
  }
  subscribe(key, cb) {
    this.listeners.push({ key, cb });
  }
  _notify(key, val) {
    this.listeners.filter((l) => l.key === key).forEach((l) => l.cb(val));
  }
}
const store = new Store();

// =============================================================================
// 🏗 MODULES
// =============================================================================

/**
 * Модуль управления Ценами (Settings Manager)
 * Отвечает за рендеринг и сохранение прайс-листа.
 */
class SettingsManager {
  constructor() {
    // Конфигурация полей: какие ключи показывать и как называть
    this.schema = {
      rough: {
        title: "🧱 Черновые работы",
        fields: {
          price_strobe_concrete: "Штробление (Бетон)",
          price_strobe_brick: "Штробление (Кирпич)",
          price_cable_laying: "Прокладка кабеля (м)",
          price_drill_hole_concrete: "Сверление лунки (Бетон)",
          price_drill_hole_brick: "Сверление лунки (Кирпич)",
          price_socket_box_install: "Вмазка подрозетника",
          price_junction_box_assembly: "Сборка распредкоробки",
        },
      },
      finish: {
        title: "✨ Чистовые работы",
        fields: {
          price_socket_install: "Установка розетки/выкл",
          price_shield_module: "Сборка щита (за модуль)",
          price_lamp_install: "Установка люстры",
          price_led_strip: "Монтаж LED-ленты (м)",
        },
      },
      system: {
        title: "⚙️ Система и Коэффициенты",
        fields: {
          material_factor: "Коэфф. материалов (0.45 = 45%)",
          percent_business: "Доля бизнеса (%)",
          percent_staff: "Доля мастера (%)", // На всякий случай
        },
      },
    };
  }

  async render() {
    const container = document.getElementById("settings-grid");
    container.innerHTML = '<div class="loader"></div>';

    try {
      const settings = await api.getSettings();
      store.set("settings", settings);
      container.innerHTML = "";

      // Генерируем блоки по схеме
      Object.values(this.schema).forEach((group) => {
        const card = document.createElement("div");
        card.className = "card settings-card";

        let fieldsHtml = "";
        for (const [key, label] of Object.entries(group.fields)) {
          const val = settings[key] !== undefined ? settings[key] : "";
          fieldsHtml += `
                        <div class="form-group row">
                            <label>${label}</label>
                            <input type="number" step="0.01" 
                                   class="setting-input form-control" 
                                   data-key="${key}" 
                                   value="${val}">
                        </div>
                    `;
        }

        card.innerHTML = `<h3>${group.title}</h3><div class="form-group-list">${fieldsHtml}</div>`;
        container.appendChild(card);
      });

      // Навешиваем обработчики на инпуты (Auto-Save)
      document.querySelectorAll(".setting-input").forEach((input) => {
        input.addEventListener("change", (e) => this._handleSave(e.target));
      });
    } catch (e) {
      console.error(e);
      container.innerHTML = `<p class="error">Ошибка загрузки: ${e.message}</p>`;
    }
  }

  async _handleSave(input) {
    const key = input.dataset.key;
    const val = parseFloat(input.value);

    if (isNaN(val)) return;

    try {
      input.classList.add("loading");
      await api.updateSetting(key, val);

      // Визуальный фидбек успеха
      input.classList.remove("loading");
      input.classList.add("saved");
      setTimeout(() => input.classList.remove("saved"), 1000);
      toast.success("Сохранено");
    } catch (e) {
      input.classList.remove("loading");
      input.classList.add("error");
      toast.error("Ошибка сохранения");
    }
  }
}

/**
 * Модуль Заказов
 */
class OrderManager {
  constructor() {}

  async loadOrders(status = "all") {
    store.set("filters", { ...store.get("filters"), status });

    // Визуальное переключение кнопок фильтра
    document
      .querySelectorAll(".filter-btn")
      .forEach((b) => b.classList.remove("active"));
    event?.target?.classList.add("active");

    const tbody = document.getElementById("orders-table-body");
    tbody.innerHTML =
      '<tr><td colspan="7" class="text-center">Загрузка...</td></tr>';

    try {
      const res = await api.getOrders(status);
      store.set("orders", res.data || []);
      this.renderTable();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-error">Ошибка: ${e.message}</td></tr>`;
    }
  }

  renderTable() {
    const tbody = document.getElementById("orders-table-body");
    const orders = store.get("orders");

    if (!orders.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">📭 Список пуст</td></tr>`;
      return;
    }

    tbody.innerHTML = orders
      .map((o) => {
        const expenses = parseFloat(o.expenses_sum || 0);
        const finalPrice = parseFloat(o.final_price || 0);
        const profit = o.status === "done" ? finalPrice - expenses : 0;
        const profitClass = profit > 0 ? "text-success" : "text-muted";

        return `
                <tr>
                    <td class="font-mono">#${o.id}</td>
                    <td>
                        <div class="font-bold">${Utils.escapeHtml(o.client_name)}</div>
                        <div class="text-sm text-muted">${o.client_phone || ""}</div>
                    </td>
                    <td>${this._statusBadge(o.status)}</td>
                    <td>${o.manager_name || "—"}</td>
                    <td>
                        <div>${o.status === "done" ? Utils.formatMoney(finalPrice) : "~" + Utils.formatMoney(o.total_price)}</div>
                        ${expenses > 0 ? `<div class="text-xs text-danger">Расх: -${Utils.formatMoney(expenses)}</div>` : ""}
                    </td>
                    <td class="${profitClass} font-bold">
                        ${o.status === "done" ? Utils.formatMoney(profit) : "..."}
                    </td>
                    <td class="text-right">
                        <button class="btn-icon" onclick="app.openExpenseModal(${o.id})" title="Расход"><i data-feather="minus-circle"></i></button>
                    </td>
                </tr>
            `;
      })
      .join("");

    feather.replace();
  }

  _statusBadge(status) {
    const map = {
      new: { t: "Новый", c: "badge-new" },
      work: { t: "В работе", c: "badge-work" },
      done: { t: "Сдан", c: "badge-done" },
      cancel: { t: "Отмена", c: "badge-cancel" },
    };
    const s = map[status] || { t: status, c: "badge-default" };
    return `<span class="status-badge ${s.c}">${s.t}</span>`;
  }
}

// =============================================================================
// 🚀 MAIN APP CONTROLLER
// =============================================================================

class App {
  constructor() {
    this.orders = new OrderManager();
    this.settings = new SettingsManager();
    this.init();
  }

  async init() {
    try {
      const isAdmin = await api.checkAuth();
      if (!isAdmin) return this.showLogin();

      document.getElementById("login-screen").classList.add("hidden");
      document.getElementById("app").classList.remove("hidden");

      this.setupNavigation();
      this.setupForms();
      this.loadTab("dashboard"); // Default tab

      toast.success("Добро пожаловать!");
    } catch (e) {
      this.showLogin();
    }
  }

  showLogin() {
    document.getElementById("login-screen").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");

    document.getElementById("login-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api.login(document.getElementById("password").value);
        window.location.reload();
      } catch (err) {
        toast.error("Неверный пароль");
      }
    };
  }

  setupNavigation() {
    document.querySelectorAll(".menu-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll(".menu-item")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.loadTab(btn.dataset.tab);
      });
    });

    document.getElementById("logout-btn").onclick = () => {
      if (confirm("Выйти?")) api.logout();
    };
  }

  async loadTab(tab) {
    document
      .querySelectorAll(".tab-content")
      .forEach((t) => t.classList.remove("active"));
    document.getElementById(`tab-${tab}`).classList.add("active");

    // Lazy loading logic
    if (tab === "dashboard") this.loadDashboard();
    if (tab === "orders") this.orders.loadOrders("all");
    if (tab === "settings") this.settings.render();
    if (tab === "finance") this.loadFinance();
  }

  // --- DASHBOARD & FINANCE (Simple versions) ---

  async loadDashboard() {
    const data = await api.getDashboardData();
    const setText = (id, val) => (document.getElementById(id).innerText = val);
    setText("kpi-revenue", Utils.formatMoney(data.revenue));
    setText("kpi-profit", Utils.formatMoney(data.profit));
    setText("kpi-active", data.activeOrders);
    setText("kpi-done", data.totalOrders); // Assuming API returns total
  }

  async loadFinance() {
    const accs = await api.getAccounts();
    const list = document.getElementById("accounts-list");
    list.innerHTML = accs
      .map(
        (a) => `
            <div class="account-card">
                <div class="acc-icon bg-blue"><i data-feather="credit-card"></i></div>
                <div>
                    <div class="font-bold">${a.name}</div>
                    <div>${Utils.formatMoney(a.balance)}</div>
                </div>
            </div>
        `,
      )
      .join("");
    feather.replace();
  }

  // --- MODALS & FORMS ---

  setupForms() {
    // Create Order
    document.getElementById("create-order-form").onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      await api.createOrder(data);
      toast.success("Заказ создан");
      window.closeModal("modal-create-order");
      this.orders.loadOrders("all");
    };

    // Add Expense
    document.getElementById("add-expense-form").onsubmit = async (e) => {
      e.preventDefault();
      const id = document.getElementById("expense-order-id").value;
      const data = Object.fromEntries(new FormData(e.target));
      await api.addExpense(id, data);
      toast.success("Расход добавлен");
      window.closeModal("modal-add-expense");
      this.orders.loadOrders(store.get("filters").status);
    };
  }

  // Global helpers called from HTML
  openExpenseModal(id) {
    document.getElementById("expense-order-id").value = id;
    document.getElementById("expense-order-info").innerText = `Заказ #${id}`;
    window.openModal("modal-add-expense");
  }

  loadOrders(status) {
    this.orders.loadOrders(status);
  }
  loadFinance() {
    this.loadFinance();
  }
  refreshData() {
    this.loadTab(document.querySelector(".menu-item.active").dataset.tab);
  }
}

// Init Global
window.app = new App();
window.openModal = (id) =>
  document.getElementById(id).classList.remove("hidden");
window.closeModal = (id) => document.getElementById(id).classList.add("hidden");

/**
 * @file public/js/app.js
 * @description SPA Controller v8.0 (Enterprise CRM Edition).
 * Управляет интерфейсом, заказами, редактором цен и массовой рассылкой.
 * Написан на Vanilla JS с применением паттернов Singleton и Event Delegation.
 *
 * @author ProElectric Team
 */

// =============================================================================
// 🛠 UTILS & HELPERS
// =============================================================================

const Utils = {
  formatMoney: (num) => {
    if (num === null || num === undefined || isNaN(num)) return "0 ₸";
    return new Intl.NumberFormat("ru-KZ", {
      style: "currency",
      currency: "KZT",
      maximumFractionDigits: 0,
    }).format(num);
  },

  formatDate: (isoDate) => {
    if (!isoDate) return "—";
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
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },
};

// =============================================================================
// 🍞 TOAST NOTIFICATIONS (Система уведомлений)
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
      .toast-container { position: fixed; top: 24px; right: 24px; z-index: 9999; display: flex; flex-direction: column; gap: 12px; pointer-events: none; }
      .toast { pointer-events: auto; min-width: 320px; padding: 16px 20px; border-radius: 10px; background: #fff; box-shadow: 0 10px 25px rgba(0,0,0,0.1); display: flex; align-items: center; justify-content: space-between; animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1); border-left: 4px solid #3b82f6; }
      .toast.success { border-left-color: #10b981; } 
      .toast.error { border-left-color: #ef4444; } 
      .toast.warning { border-left-color: #f59e0b; }
      .toast-content { display: flex; align-items: center; gap: 14px; font-weight: 500; font-size: 14px; color: #111827; }
      .toast-close { cursor: pointer; color: #9ca3af; background: none; border: none; font-size: 20px; line-height: 1; padding: 0; transition: color 0.2s; }
      .toast-close:hover { color: #111827; }
      @keyframes slideIn { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      @keyframes fadeOut { to { transform: translateX(120%); opacity: 0; } }
    `;
    const style = document.createElement("style");
    style.id = "toast-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  show(msg, type = "success") {
    const icons = {
      success: "check-circle",
      error: "alert-octagon",
      warning: "alert-triangle",
      info: "info",
    };
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <div class="toast-content"><i data-feather="${icons[type] || icons.info}"></i><span>${msg}</span></div>
      <button class="toast-close">&times;</button>
    `;
    this.container.appendChild(toast);

    // Инициализация иконки (Feather)
    if (window.feather) feather.replace();

    // Авто-удаление
    const timeout = setTimeout(
      () => this._removeToast(toast),
      type === "error" ? 5000 : 3000,
    );

    // Удаление по клику
    toast.querySelector(".toast-close").onclick = () => {
      clearTimeout(timeout);
      this._removeToast(toast);
    };
  }

  _removeToast(toast) {
    toast.style.animation =
      "fadeOut 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards";
    setTimeout(() => toast.remove(), 300);
  }
}
const toast = new Toaster();

// =============================================================================
// 🚀 MAIN APP CONTROLLER
// =============================================================================

class Application {
  constructor() {
    this.state = {
      orders: [],
      settings: {},
      currentTab: "dashboard",
      filterStatus: "all",
    };

    // Глобальные словари
    this.statusMap = {
      draft: { label: "Черновик", color: "badge-default" },
      new: { label: "Новый лид", color: "badge-new" },
      processing: { label: "В обработке", color: "badge-work" },
      work: { label: "На монтаже", color: "badge-work" },
      payment: { label: "Ждет оплату", color: "badge-warning" },
      done: { label: "Сдан", color: "badge-done" },
      cancel: { label: "Отказ", color: "badge-cancel" },
    };

    this.settingsSchema = {
      price_strobe_concrete: "Штробление (Бетон)",
      price_strobe_brick: "Штробление (Кирпич)",
      price_strobe_gas: "Штробление (Газоблок)",
      price_drill_concrete: "Точка подрозетника (Бетон)",
      price_drill_brick: "Точка подрозетника (Кирпич)",
      price_drill_gas: "Точка подрозетника (Газоблок)",
      price_cable: "Прокладка кабеля (м)",
      price_socket_install: "Монтаж мех-ма розетки (шт)",
      price_shield_module: "Сборка щита (за модуль)",
      material_factor: "Коэффициент материалов (Например: 0.45)",
    };

    this.init();
  }

  async init() {
    this.cacheDOM();
    this.bindEvents();

    try {
      const isAuth = await api.checkAuth();
      if (isAuth) {
        this.showApp();
      } else {
        this.showLogin();
      }
    } catch (e) {
      this.showLogin();
    }
  }

  cacheDOM() {
    this.loginScreen = document.getElementById("login-screen");
    this.appScreen = document.getElementById("app");
    this.loginForm = document.getElementById("login-form");
    this.loginError = document.getElementById("login-error");
    this.dateDisplay = document.getElementById("date-display");

    // Модалки
    this.modals = {
      details: document.getElementById("modal-update-details"),
      cancel: document.getElementById("modal-cancel-order"),
      create: document.getElementById("modal-create-order"),
    };
  }

  bindEvents() {
    // --- Авторизация ---
    this.loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector("button");
      const login = e.target.login.value;
      const pass = e.target.password.value;

      try {
        btn.disabled = true;
        await api.login(login, pass);
        this.showApp();
        toast.show("Успешный вход в систему");
      } catch (err) {
        this.loginError.textContent = err.message;
        this.loginError.style.display = "block";
        toast.show("Ошибка авторизации", "error");
      } finally {
        btn.disabled = false;
      }
    });

    // --- Навигация (Боковое меню) ---
    document.querySelectorAll(".menu-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        const tab = e.currentTarget.dataset.tab;
        this.switchTab(tab);
      });
    });

    // --- Выход ---
    document
      .getElementById("logout-btn")
      .addEventListener("click", async () => {
        if (confirm("Завершить сеанс?")) {
          await api.logout();
          window.location.reload();
        }
      });

    // --- Модальные окна (Глобальное открытие/закрытие) ---
    document.querySelectorAll('[data-action="open-modal"]').forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const targetId = e.currentTarget.dataset.target;
        this.openModal(targetId);
      });
    });

    document.querySelectorAll('[data-action="close-modal"]').forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const targetId = e.currentTarget.dataset.target;
        this.closeModal(targetId);
      });
    });

    // --- Фильтры заказов ---
    document.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        document
          .querySelectorAll(".filter-btn")
          .forEach((b) => b.classList.remove("active"));
        e.currentTarget.classList.add("active");
        this.state.filterStatus = e.currentTarget.dataset.filter;
        this.loadOrders();
      });
    });

    // --- Формы (Отправка данных) ---
    document
      .getElementById("update-details-form")
      .addEventListener("submit", this.handleUpdateDetails.bind(this));
    document
      .getElementById("cancel-order-form")
      .addEventListener("submit", this.handleCancelOrder.bind(this));
    document
      .getElementById("broadcast-form")
      .addEventListener("submit", this.handleBroadcast.bind(this));

    // Кнопка принудительного обновления
    document.querySelectorAll('[data-action="refresh"]').forEach((btn) => {
      btn.addEventListener("click", () =>
        this.switchTab(this.state.currentTab),
      );
    });
  }

  // =========================================================================
  // 🧭 UI ROUTING (Навигация)
  // =========================================================================

  showApp() {
    this.loginScreen.classList.add("hidden");
    this.appScreen.classList.remove("hidden");

    // 🔥 ИСПРАВЛЕНИЕ: Снимаем класс невидимости (cloak) и добавляем видимость
    this.appScreen.classList.remove("cloak");
    this.appScreen.classList.add("visible");
    this.appScreen.setAttribute("aria-hidden", "false");

    // Установка даты
    const options = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    };
    this.dateDisplay.textContent = new Date().toLocaleDateString(
      "ru-RU",
      options,
    );

    this.switchTab("dashboard");
  }
  showLogin() {
    this.appScreen.classList.add("hidden");
    this.loginScreen.classList.remove("hidden");
  }

  async switchTab(tabName) {
    this.state.currentTab = tabName;

    // Обновляем визуальное состояние меню
    document.querySelectorAll(".menu-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.tab === tabName);
    });

    // Показываем нужную секцию
    document.querySelectorAll(".tab-content").forEach((section) => {
      section.hidden = section.id !== `tab-${tabName}`;
    });

    // Маршрутизация загрузки данных
    document.getElementById("loading-indicator").style.opacity = "1";

    try {
      switch (tabName) {
        case "dashboard":
          await this.loadDashboard();
          break;
        case "orders":
          await this.loadOrders();
          break;
        case "settings":
          await this.loadSettings();
          break;
      }
    } catch (err) {
      toast.show(err.message, "error");
    } finally {
      document.getElementById("loading-indicator").style.opacity = "0";
    }
  }

  // =========================================================================
  // 📊 ДАШБОРД (DASHBOARD)
  // =========================================================================

  async loadDashboard() {
    const data = await api.getDashboardData();

    // Анимация счетчиков или прямая вставка
    document.getElementById("kpi-active").textContent =
      data.overview.pendingOrders || 0;
    document.getElementById("kpi-done").textContent =
      data.funnel.done?.count || 0;
    document.getElementById("kpi-users").textContent =
      data.overview.totalUsers || 0;
    document.getElementById("kpi-revenue").textContent = Utils.formatMoney(
      data.overview.totalRevenue,
    );

    // Убираем скелетоны
    document
      .querySelectorAll(".kpi-value")
      .forEach((el) => el.classList.remove("skeleton-box"));
  }

  // =========================================================================
  // 📦 ЗАКАЗЫ (ORDERS)
  // =========================================================================

  async loadOrders() {
    const tbody = document.getElementById("orders-table-body");
    const emptyState = document.getElementById("orders-empty");
    const template = document.getElementById("tpl-order-row");

    tbody.innerHTML = "";
    const orders = await api.getOrders(this.state.filterStatus);
    this.state.orders = orders;

    if (orders.length === 0) {
      emptyState.classList.remove("hidden");
      return;
    }

    emptyState.classList.add("hidden");

    orders.forEach((o) => {
      const row = template.content.cloneNode(true).querySelector("tr");
      const details = o.details || {};
      const params = details.params || {};

      // ID и Клиент
      row.querySelector(".order-id").textContent = `#${o.id}`;
      row.querySelector(".client-name").textContent = Utils.escapeHtml(
        o.client_name || "Неизвестно",
      );
      row.querySelector(".client-phone").textContent = Utils.escapeHtml(
        o.client_phone || "Нет телефона",
      );

      // Метаданные (Адрес и коммент)
      row.querySelector(".order-address").textContent = Utils.escapeHtml(
        details.address || "📍 Адрес не указан",
      );
      if (details.comment) {
        row.querySelector(".order-comment").textContent =
          `📝 ${Utils.escapeHtml(details.comment)}`;
      }
      if (params.area) {
        row.querySelector(".order-params").textContent =
          `🏠 ${params.area}м² | Комнат: ${params.rooms} | Стены: ${params.wallType}`;
      }

      // Статус
      const statusInfo = this.statusMap[o.status] || {
        label: o.status,
        color: "badge-default",
      };
      const badge = row.querySelector(".status-badge");
      badge.textContent = statusInfo.label;
      badge.classList.add(statusInfo.color);

      // Финансы (Только работа)
      row.querySelector(".finance-info").textContent = Utils.formatMoney(
        o.total_price,
      );

      // Действия (Кнопки)
      row.querySelector(".action-edit").onclick = () =>
        this.triggerEditDetails(o.id);

      const cancelBtn = row.querySelector(".action-cancel");
      if (["cancel", "done", "archived"].includes(o.status)) {
        cancelBtn.disabled = true; // Блокируем кнопку, если уже отменен или сдан
        cancelBtn.style.opacity = "0.3";
        cancelBtn.style.cursor = "not-allowed";
      } else {
        cancelBtn.onclick = () => this.triggerCancelOrder(o.id);
      }

      tbody.appendChild(row);
    });

    if (window.feather) feather.replace();
  }

  // =========================================================================
  // ⚙️ НАСТРОЙКИ (SETTINGS / PRICING)
  // =========================================================================

  async loadSettings() {
    const grid = document.getElementById("settings-grid");
    grid.innerHTML = ""; // Clear

    const data = await api.getSettings();
    this.state.settings = data;

    // Генерируем карточки для каждого параметра из нашей схемы
    Object.entries(this.settingsSchema).forEach(([key, label]) => {
      const value = data[key] !== undefined ? data[key] : "";

      const item = document.createElement("div");
      item.className = "setting-item card p-4";

      item.innerHTML = `
        <label class="setting-label block font-medium mb-2 text-sm">${label}</label>
        <div class="input-suffix-wrapper relative">
            <input type="number" 
                   class="setting-input form-control w-full" 
                   data-key="${key}" 
                   value="${value}" 
                   step="${key === "material_factor" ? "0.01" : "1"}">
            <span class="suffix absolute right-3 top-2.5 text-muted">${key === "material_factor" ? "" : "₸"}</span>
        </div>
      `;

      // Event Listener для Auto-Save при потере фокуса
      const input = item.querySelector(".setting-input");
      input.addEventListener("blur", async (e) => {
        const newVal = parseFloat(e.target.value);
        if (isNaN(newVal)) return;

        try {
          e.target.style.borderColor = "#3b82f6";
          await api.updateSetting(e.target.dataset.key, newVal);
          toast.show("Сохранено", "success");
        } catch (err) {
          toast.show("Ошибка сохранения", "error");
          e.target.style.borderColor = "#ef4444";
        } finally {
          setTimeout(() => (e.target.style.borderColor = ""), 1000);
        }
      });

      grid.appendChild(item);
    });
  }

  // =========================================================================
  // 🎛 МОДАЛЬНЫЕ ОКНА И ФОРМЫ (ACTIONS)
  // =========================================================================

  openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.showModal();
  }

  closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
      modal.close();
      const form = modal.querySelector("form");
      if (form) form.reset();
    }
  }

  // --- 1. Редактирование Метаданных (Адрес / Коммент) ---
  triggerEditDetails(orderId) {
    // Находим заказ в стейте, чтобы подставить текущие данные
    const order = this.state.orders.find((o) => o.id === orderId);
    if (!order) return;

    document.getElementById("details-hidden-id").value = order.id;
    document.getElementById("details-order-id").textContent = `#${order.id}`;

    // Подставляем старые данные
    const details = order.details || {};
    document.getElementById("details-address").value = details.address || "";
    document.getElementById("details-comment").value = details.comment || "";

    this.openModal("modal-update-details");
  }

  async handleUpdateDetails(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const orderId = document.getElementById("details-hidden-id").value;
    const address = document.getElementById("details-address").value.trim();
    const comment = document.getElementById("details-comment").value.trim();

    try {
      btn.disabled = true;
      // Отправляем два запроса. В идеале бэкенд должен принимать объект, но мы сделали по одному ключу
      if (address) await api.updateOrderDetails(orderId, "address", address);
      if (comment) await api.updateOrderDetails(orderId, "comment", comment);

      toast.show("Данные заказа обновлены");
      this.closeModal("modal-update-details");
      this.loadOrders(); // Перерисовываем таблицу
    } catch (err) {
      toast.show(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  // --- 2. Отмена заказа ---
  triggerCancelOrder(orderId) {
    document.getElementById("cancel-hidden-id").value = orderId;
    this.openModal("modal-cancel-order");
  }

  async handleCancelOrder(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const orderId = document.getElementById("cancel-hidden-id").value;
    const reason = document.getElementById("cancel-reason-select").value;

    try {
      btn.disabled = true;
      // 1. Сохраняем причину отмены
      await api.updateOrderDetails(orderId, "cancel_reason", reason);
      // 2. Меняем статус на 'cancel'
      await api.updateOrderStatus(orderId, "cancel");

      toast.show("Заказ успешно отменен", "warning");
      this.closeModal("modal-cancel-order");
      this.loadOrders();
    } catch (err) {
      toast.show(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  // --- 3. Массовая Рассылка ---
  async handleBroadcast(e) {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type="submit"]');

    const targetRole = form.targetRole.value;
    const imageUrl = form.imageUrl.value.trim() || null;
    const text = form.text.value.trim();

    if (
      !confirm("Вы уверены, что хотите отправить это сообщение пользователям?")
    )
      return;

    try {
      btn.disabled = true;
      btn.innerHTML = `<i class="animate-spin" data-feather="loader"></i> Отправка...`;
      if (window.feather) feather.replace();

      const res = await api.sendBroadcast(text, imageUrl, targetRole);

      toast.show(
        `Рассылка запущена! Примерное время: ${res.estimatedTimeSec} сек.`,
      );
      form.reset();
    } catch (err) {
      toast.show(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i data-feather="send"></i> Запустить рассылку`;
      if (window.feather) feather.replace();
    }
  }
}

// =============================================================================
// 🏁 ИНИЦИАЛИЗАЦИЯ
// =============================================================================

// Ждем загрузки DOM, чтобы элементы гарантированно существовали
document.addEventListener("DOMContentLoaded", () => {
  window.app = new Application();
});

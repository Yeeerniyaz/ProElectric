/**
 * =============================================================================
 * ⚡️ PROELECTRO ENTERPRISE | FRONTEND CONTROLLER
 * =============================================================================
 * @file public/js/app.js
 * @description Основной контроллер приложения. Реализует MVC паттерн на клиенте.
 * Управляет навигацией, рендерингом данных, модальными окнами и бизнес-логикой UI.
 * * @author Yerniyaz & Gemini Senior Architect
 * @version 5.0.0 (The "God Mode" Update)
 */

// =============================================================================
// 🛠 UTILS & HELPERS (Утилиты)
// =============================================================================

const Utils = {
  // Формат валюты (KZT)
  money: new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }),

  // Формат даты (ДД.ММ.ГГГГ ЧЧ:ММ)
  date: (isoString) => {
    if (!isoString) return "-";
    return new Date(isoString).toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  },

  // Генерация HTML для бейджа статуса
  statusBadge: (status) => {
    const map = {
      new: { text: "Новый", cls: "st-new" },
      work: { text: "В работе", cls: "st-work" },
      discuss: { text: "Обсуждение", cls: "st-work" },
      done: { text: "Выполнен", cls: "st-done" },
      cancel: { text: "Отмена", cls: "st-cancel" },
    };
    const s = map[status] || { text: status, cls: "st-new" };
    return `<span class="status-badge ${s.cls}">${s.text}</span>`;
  },

  // Показать уведомление (Toast)
  toast: (title, icon = "success") => {
    Swal.fire({
      toast: true,
      position: "top-end",
      icon: icon,
      title: title,
      showConfirmButton: false,
      timer: 3000,
      timerProgressBar: true,
      background: "#1e293b",
      color: "#fff",
    });
  },

  // Дебаунс для поиска (чтобы не спамить запросами)
  debounce: (func, wait) => {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  },
};

// =============================================================================
// 🧠 STATE MANAGEMENT (Состояние приложения)
// =============================================================================

const State = {
  currentUser: null,
  currentView: "dashboard",
  orders: {
    page: 1,
    limit: 10,
    totalPages: 1,
    filter: "all",
    search: "",
  },
  users: {
    list: [],
  },
  accounts: [],
  settings: {},
};

// =============================================================================
// 🎮 APP CONTROLLER (Основная логика)
// =============================================================================

class App {
  // 1. Инициализация
  static async init() {
    try {
      // Проверка сессии
      const auth = await API.checkAuth();
      if (auth.isAdmin) {
        State.currentUser = auth;
        this.showApp();
      }
    } catch (e) {
      console.log("Not authorized");
      document.getElementById("loginOverlay").style.display = "grid";
    }

    // Навешивание событий
    this.bindEvents();

    // Роутинг (обработка хеша в URL)
    window.addEventListener("hashchange", () => this.handleRoute());
    this.handleRoute(); // Первый запуск
  }

  // 2. Обработка роутинга (SPA навигация)
  static handleRoute() {
    const hash = location.hash.slice(1) || "dashboard";
    this.switchView(hash);
  }

  static switchView(viewName) {
    // Скрываем все секции
    document
      .querySelectorAll(".view-section")
      .forEach((el) => (el.style.display = "none"));

    // Показываем нужную
    const target = document.getElementById(`view-${viewName}`);
    if (target) {
      target.style.display = "block";
      State.currentView = viewName;

      // Обновляем меню
      document
        .querySelectorAll(".nav-link")
        .forEach((btn) => btn.classList.remove("active"));
      const activeBtn = document.querySelector(`[href="#${viewName}"]`);
      if (activeBtn) activeBtn.classList.add("active");

      // Загружаем данные для конкретной страницы
      this.loadViewData(viewName);
    } else {
      // Если страницы нет — на дашборд
      location.hash = "dashboard";
    }
  }

  // 3. Загрузка данных в зависимости от страницы
  static async loadViewData(view) {
    switch (view) {
      case "dashboard":
        await Promise.all([
          this.renderKPI(),
          this.renderRecentOrders(),
          this.renderAccountsWidget(),
        ]);
        break;
      case "orders":
        await this.renderOrdersTable();
        break;
      case "finance":
        await Promise.all([
          this.renderFinanceStats(),
          this.renderAccountsFull(),
          this.renderTransactions(),
        ]);
        break;
      case "crm":
        await this.renderUsersTable();
        break;
      case "settings":
        await this.renderSettingsForm();
        break;
    }
  }

  // 4. Показать приложение после логина
  static showApp() {
    document.getElementById("loginOverlay").style.display = "none";
    document.getElementById("app").style.display = "flex";
    // Запускаем авто-обновление данных раз в 30 сек
    setInterval(() => this.loadViewData(State.currentView), 30000);
  }

  // =========================================================================
  // 📊 DASHBOARD RENDERERS
  // =========================================================================

  static async renderKPI() {
    try {
      const data = await API.getKPI();
      const container = document.getElementById("kpiGrid");
      if (!container) return;

      const cards = [
        {
          label: "Оборот (Выполнено)",
          val: Utils.money.format(data.revenue),
          icon: "bi-wallet2",
          color: "text-success",
        },
        {
          label: "Заказов в работе",
          val: data.activeOrders,
          icon: "bi-cone-striped",
          color: "text-warning",
        },
        {
          label: "Конверсия",
          val: data.conversion,
          icon: "bi-graph-up",
          color: "text-info",
        },
        {
          label: "Всего заказов",
          val: data.totalOrders,
          icon: "bi-list-check",
          color: "text-muted",
        },
      ];

      container.innerHTML = cards
        .map(
          (c) => `
                <div class="glass-card p-3 d-flex justify-content-between align-items-center">
                    <div>
                        <div class="text-muted small text-uppercase mb-1">${c.label}</div>
                        <div class="fs-4 fw-bold ${c.color}">${c.val}</div>
                    </div>
                    <i class="bi ${c.icon} fs-1 opacity-25"></i>
                </div>
            `,
        )
        .join("");
    } catch (e) {
      console.error("KPI Error", e);
    }
  }

  static async renderRecentOrders() {
    const res = await API.getOrders(5); // Последние 5
    const tbody = document.getElementById("recentOrdersBody");
    if (!tbody) return;

    tbody.innerHTML = res.data
      .map(
        (o) => `
            <tr>
                <td><small class="text-muted">#${o.id}</small></td>
                <td><span class="fw-bold">${o.client_name || "Не указан"}</span></td>
                <td>${Utils.money.format(o.total_work_cost)}</td>
                <td>${Utils.statusBadge(o.status)}</td>
                <td class="text-end">
                    <button class="btn btn-sm btn-outline-light" onclick="App.openOrderEdit(${o.id})">
                        <i class="bi bi-pencil"></i>
                    </button>
                </td>
            </tr>
        `,
      )
      .join("");
  }

  static async renderAccountsWidget() {
    const accs = await API.getAccounts();
    const div = document.getElementById("dashboardAccounts");
    if (!div) return;

    div.innerHTML = accs
      .map(
        (a) => `
            <div class="d-flex justify-content-between align-items-center mb-3 p-2 border-bottom border-secondary">
                <div class="d-flex align-items-center gap-3">
                    <div class="rounded-circle bg-dark p-2 text-warning"><i class="bi bi-wallet2"></i></div>
                    <div>
                        <div class="fw-bold">${a.name}</div>
                        <div class="small text-muted text-uppercase">${a.type}</div>
                    </div>
                </div>
                <div class="fw-bold fs-5">${Utils.money.format(a.balance)}</div>
            </div>
        `,
      )
      .join("");
  }

  // =========================================================================
  // 📦 ORDERS MANAGEMENT (The Core)
  // =========================================================================

  static async renderOrdersTable() {
    const tbody = document.getElementById("allOrdersBody");
    if (!tbody) return;

    // Показываем скелетон или лоадер
    tbody.innerHTML =
      '<tr><td colspan="7" class="text-center py-5 text-muted"><i class="bi bi-arrow-repeat spinner-border"></i> Загрузка...</td></tr>';

    try {
      const res = await API.request(
        `/orders?page=${State.orders.page}&limit=${State.orders.limit}&status=${State.orders.filter}&search=${State.orders.search}`,
      );

      State.orders.totalPages = Math.ceil(res.total / State.orders.limit);
      this.renderPagination();

      if (res.data.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="7" class="text-center py-5 text-muted">Заказы не найдены</td></tr>';
        return;
      }

      tbody.innerHTML = res.data
        .map(
          (o) => `
                <tr>
                    <td>${o.id}</td>
                    <td>
                        <div class="fw-bold text-white">${o.client_name || "Гость"}</div>
                        <div class="small text-muted">${o.client_phone || "-"}</div>
                    </td>
                    <td>${Utils.money.format(o.total_work_cost)}</td>
                    <td>
                        <div>${o.manager_name || '<span class="text-muted">—</span>'}</div>
                    </td>
                    <td>${Utils.statusBadge(o.status)}</td>
                    <td>${Utils.date(o.created_at)}</td>
                    <td class="text-end">
                        <button class="btn btn-sm btn-primary" onclick="App.openOrderEdit(${o.id}, '${o.status}', '${o.client_name}', ${o.total_work_cost})">
                            <i class="bi bi-pencil-square"></i> Изменить
                        </button>
                    </td>
                </tr>
            `,
        )
        .join("");
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Ошибка: ${e.message}</td></tr>`;
    }
  }

  static renderPagination() {
    const container = document.getElementById("ordersPagination");
    if (!container) return;

    const { page, totalPages } = State.orders;

    let html = `
            <button class="btn btn-sm btn-outline-secondary" ${page <= 1 ? "disabled" : ""} onclick="App.changePage(${page - 1})">Назад</button>
            <span class="mx-3 text-muted">Страница ${page} из ${totalPages}</span>
            <button class="btn btn-sm btn-outline-secondary" ${page >= totalPages ? "disabled" : ""} onclick="App.changePage(${page + 1})">Вперед</button>
        `;
    container.innerHTML = html;
  }

  static changePage(newPage) {
    State.orders.page = newPage;
    this.renderOrdersTable();
  }

  static applyOrderFilter(status) {
    State.orders.filter = status;
    State.orders.page = 1;
    // Обновляем UI кнопок фильтра
    document
      .querySelectorAll(".filter-btn")
      .forEach((b) => b.classList.remove("active", "btn-primary"));
    document.querySelectorAll(".filter-btn").forEach((b) => {
      if (b.dataset.status === status) b.classList.add("active", "btn-primary");
      else b.classList.add("btn-outline-secondary");
    });

    this.renderOrdersTable();
  }

  static handleOrderSearch(value) {
    State.orders.search = value;
    State.orders.page = 1;
    this.renderOrdersTable();
  }

  /**
   * 🔥 ОТКРЫТИЕ МОДАЛКИ РЕДАКТИРОВАНИЯ ЗАКАЗА (ПОСЛЕ ЗАМЕРА)
   * Здесь мы даем возможность изменить статус, менеджера и в будущем - цену.
   */
  static async openOrderEdit(orderId, currentStatus, clientName, currentCost) {
    // Загружаем список менеджеров
    const usersRes = await API.request("/users");
    const managers = usersRes.filter((u) =>
      ["admin", "manager"].includes(u.role),
    );

    const modal = new bootstrap.Modal(
      document.getElementById("editOrderModal"),
    );
    const form = document.getElementById("editOrderForm");

    // Заполняем форму
    form.orderId.value = orderId;
    document.getElementById("editOrderTitle").innerText =
      `Заказ #${orderId} - ${clientName}`;

    // Селект статуса
    const statusSelect = form.status;
    statusSelect.value = currentStatus;

    // Селект менеджера
    const assigneeSelect = form.assignee_id;
    assigneeSelect.innerHTML =
      `<option value="">-- Не назначен --</option>` +
      managers
        .map(
          (m) =>
            `<option value="${m.telegram_id}">${m.first_name} (${m.role})</option>`,
        )
        .join("");

    // TODO: Если бэкенд будет поддерживать изменение цены, раскомментировать:
    // form.actual_cost.value = currentCost;

    modal.show();
  }

  // =========================================================================
  // 👥 CRM (USERS)
  // =========================================================================

  static async renderUsersTable() {
    const tbody = document.getElementById("usersTableBody");
    if (!tbody) return;

    const res = await API.request("/users");
    State.users.list = res;

    tbody.innerHTML = res
      .map(
        (u) => `
            <tr>
                <td>${u.telegram_id}</td>
                <td>${u.first_name || "Нет имени"}</td>
                <td>@${u.username || "-"}</td>
                <td>${u.phone || "-"}</td>
                <td>
                    <select onchange="App.changeUserRole('${u.telegram_id}', this.value)" class="form-select form-select-sm bg-dark text-white border-secondary" style="width: 120px">
                        <option value="user" ${u.role === "user" ? "selected" : ""}>Клиент</option>
                        <option value="manager" ${u.role === "manager" ? "selected" : ""}>Менеджер</option>
                        <option value="admin" ${u.role === "admin" ? "selected" : ""}>Админ</option>
                    </select>
                </td>
                <td>${Utils.date(u.created_at)}</td>
            </tr>
        `,
      )
      .join("");
  }

  static async changeUserRole(id, role) {
    try {
      await API.request(`/users/${id}/role`, {
        method: "POST",
        body: JSON.stringify({ role }),
      });
      Utils.toast(`Роль обновлена: ${role}`);
    } catch (e) {
      Utils.toast("Ошибка смены роли", "error");
    }
  }

  // =========================================================================
  // 💰 FINANCE
  // =========================================================================

  static async renderAccountsFull() {
    const accs = await API.getAccounts();
    const container = document.getElementById("financeAccountsGrid");
    if (!container) return;

    container.innerHTML = accs
      .map(
        (a) => `
            <div class="col-md-4">
                <div class="glass-card p-4 h-100 position-relative overflow-hidden">
                    <div class="d-flex justify-content-between">
                        <h5 class="mb-1">${a.name}</h5>
                        <i class="bi bi-wallet2 opacity-25 fs-2"></i>
                    </div>
                    <div class="display-6 fw-bold my-3">${Utils.money.format(a.balance)}</div>
                    <div class="badge bg-secondary bg-opacity-25 text-white">${a.type}</div>
                </div>
            </div>
        `,
      )
      .join("");
  }

  static async renderTransactions() {
    // В будущем: добавить API для списка транзакций
    // document.getElementById('transactionsTable').innerHTML = '...'
  }

  static async renderFinanceStats() {
    const data = await API.request("/analytics/finance");
    // Здесь можно отрисовать Chart.js с расходами и доходами
  }

  // =========================================================================
  // ⚙️ SETTINGS
  // =========================================================================

  static async renderSettingsForm() {
    const s = await API.getSettings();
    const f = document.getElementById("fullSettingsForm");
    if (!f) return;

    for (const k in s) {
      if (f[k]) f[k].value = s[k];
    }
  }

  // =========================================================================
  // 🔗 EVENT BINDING (Обработчики событий)
  // =========================================================================

  static bindEvents() {
    // Логин
    document
      .getElementById("loginForm")
      .addEventListener("submit", async (e) => {
        e.preventDefault();
        const pass = document.getElementById("passwordInput").value;
        try {
          await API.login(pass);
          State.currentUser = { isAdmin: true };
          this.showApp();
        } catch (e) {
          Swal.fire("Ошибка", "Неверный пароль", "error");
        }
      });

    // Глобальный Выход
    window.logout = async () => {
      await API.logout();
      location.reload();
    };

    // Сохранение настроек
    const settingsForm = document.getElementById("fullSettingsForm");
    if (settingsForm) {
      settingsForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target));
        try {
          await API.updateSettings(data);
          Utils.toast("Настройки сохранены");
        } catch (e) {
          Utils.toast(e.message, "error");
        }
      });
    }

    // Поиск заказов (с дебаунсом)
    const searchInput = document.getElementById("orderSearchInput");
    if (searchInput) {
      searchInput.addEventListener(
        "input",
        Utils.debounce((e) => {
          this.handleOrderSearch(e.target.value);
        }, 500),
      );
    }

    // Создание заказа вручную
    const manualForm = document.getElementById("manualOrderForm");
    if (manualForm) {
      manualForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target));
        try {
          await API.manualOrder(data);
          bootstrap.Modal.getInstance(
            document.getElementById("manualOrderModal"),
          ).hide();
          e.target.reset();
          this.renderOrdersTable();
          Utils.toast("Заказ создан");
        } catch (e) {
          Utils.toast(e.message, "error");
        }
      });
    }

    // Редактирование заказа (Сохранение изменений)
    const editOrderForm = document.getElementById("editOrderForm");
    if (editOrderForm) {
      editOrderForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const id = e.target.orderId.value;
        const status = e.target.status.value;
        const assignee_id = e.target.assignee_id.value;

        try {
          await API.request(`/orders/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ status, assignee_id }),
          });

          bootstrap.Modal.getInstance(
            document.getElementById("editOrderModal"),
          ).hide();
          this.renderOrdersTable();
          Utils.toast("Заказ обновлен");
        } catch (e) {
          Utils.toast(e.message, "error");
        }
      });
    }

    // Перевод средств
    const transferForm = document.getElementById("transferForm");
    if (transferForm) {
      transferForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target));
        if (data.fromId === data.toId)
          return Utils.toast("Счета совпадают", "warning");

        try {
          await API.transfer(data.fromId, data.toId, data.amount, data.comment);
          bootstrap.Modal.getInstance(
            document.getElementById("transferModal"),
          ).hide();
          e.target.reset();
          // Обновляем данные на странице (если мы в финансах или дашборде)
          this.loadViewData(State.currentView);
          Utils.toast("Перевод выполнен");
        } catch (e) {
          Utils.toast(e.message, "error");
        }
      });
    }
  }
}

// Запуск при загрузке
document.addEventListener("DOMContentLoaded", () => App.init());

// Экспорт для доступа из HTML (например, onclick="App.changePage()")
window.App = App;

/**
 * =============================================================================
 * ⚡️ PROELECTRO ENTERPRISE | FRONTEND CONTROLLER
 * =============================================================================
 * @file public/js/app.js
 * @description Основной контроллер приложения (MVC).
 * Включает:
 * 1. Mobile First Design (Карточки вместо таблиц)
 * 2. Финансовый учет (Приход/Расход в модальном окне)
 * 3. Поиск по ID
 * 4. Исправление циклической перезагрузки
 * @version 7.0.0 (Ultimate)
 */

const Utils = {
  money: new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }),

  date: (isoString) => {
    if (!isoString) return "-";
    return new Date(isoString).toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  },

  statusBadge: (status) => {
    const map = {
      new: { text: "Новый", cls: "bg-primary" },
      work: { text: "В работе", cls: "bg-warning text-dark" },
      discuss: { text: "Обсуждение", cls: "bg-info text-dark" },
      done: { text: "Выполнен", cls: "bg-success" },
      cancel: { text: "Отмена", cls: "bg-danger" },
    };
    const s = map[status] || { text: status, cls: "bg-secondary" };
    return `<span class="badge ${s.cls}">${s.text}</span>`;
  },

  toast: (title, icon = "success") => {
    Swal.fire({
      toast: true,
      position: "top-end",
      icon,
      title,
      showConfirmButton: false,
      timer: 3000,
      timerProgressBar: true,
      background: "#212529",
      color: "#fff",
    });
  },

  debounce: (func, wait) => {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  },
};

const State = {
  currentUser: null,
  currentView: "dashboard",
  orders: { page: 1, limit: 10, totalPages: 1, filter: "all", search: "" },
  users: [],
};

class App {
  static async init() {
    this.bindEvents();

    try {
      // 1. Авторизацияны тексереміз
      const auth = await API.checkAuth();
      if (auth.isAdmin) {
        State.currentUser = auth;
        this.showApp();
      } else {
        this.showLogin();
      }
    } catch (e) {
      console.log("Not authorized");
      this.showLogin();
    }
  }

  static showLogin() {
    document.getElementById("loginOverlay").style.display = "grid";
    document.getElementById("app").style.display = "none";
  }

  static showApp() {
    document.getElementById("loginOverlay").style.display = "none";
    document.getElementById("app").style.display = "flex";
    document
      .getElementById("app")
      .style.setProperty("display", "flex", "important");

    // 2. Loop Fix: Роутингті тек логиннен кейін қосамыз
    window.addEventListener("hashchange", () => this.handleRoute());
    this.handleRoute();

    setInterval(() => {
      if (document.visibilityState === "visible")
        this.loadViewData(State.currentView);
    }, 30000);
  }

  static handleRoute() {
    const hash = location.hash.slice(1) || "dashboard";
    this.switchView(hash);
  }

  static switchView(viewName) {
    document
      .querySelectorAll(".view-section")
      .forEach((el) => (el.style.display = "none"));

    const target = document.getElementById(`view-${viewName}`);
    if (target) {
      target.style.display = "block";
      State.currentView = viewName;

      // Mobile Nav Active State
      document
        .querySelectorAll(".nav-item")
        .forEach((btn) => btn.classList.remove("active"));
      const activeLink = document.querySelector(
        `.bottom-nav a[href="#${viewName}"]`,
      );
      if (activeLink) activeLink.classList.add("active");

      const titles = {
        dashboard: "Дашборд",
        orders: "Заказы",
        finance: "Финансы",
        crm: "Команда",
        settings: "Настройки",
      };
      document.getElementById("pageTitle").innerText =
        titles[viewName] || "ProElectro";

      this.loadViewData(viewName);
    } else {
      location.hash = "dashboard";
    }
  }

  static async loadViewData(view) {
    if (!State.currentUser) return;

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

  // --- RENDERERS (MOBILE CARDS STYLE) ---

  static async renderKPI() {
    try {
      const data = await API.getKPI();
      const container = document.getElementById("kpiGrid");
      if (!container) return;

      const cards = [
        { l: "Оборот", v: Utils.money.format(data.revenue), c: "text-success" },
        { l: "В работе", v: data.activeOrders, c: "text-warning" },
        { l: "Конверсия", v: data.conversion, c: "text-info" },
        {
          l: "Средний чек",
          v: Utils.money.format(data.avgCheck),
          c: "text-primary",
        },
      ];

      container.innerHTML = cards
        .map(
          (c) => `
                <div class="kpi-card">
                    <div class="text-muted small mb-1">${c.l}</div>
                    <div class="fs-5 fw-bold ${c.c}">${c.v}</div>
                </div>
            `,
        )
        .join("");
    } catch (e) {
      console.error("KPI Error", e);
    }
  }

  static async renderRecentOrders() {
    const res = await API.getOrders({ limit: 5 });
    const div = document.getElementById("recentOrdersBody");
    if (!div) return;

    div.innerHTML = res.data
      .map(
        (o) => `
            <div class="order-card" onclick="location.hash='#orders'">
                <div class="d-flex justify-content-between mb-1">
                    <span class="badge bg-secondary">#${o.id}</span>
                    ${Utils.statusBadge(o.status)}
                </div>
                <div class="fw-bold text-white mb-1">${o.client_name || "Гость"}</div>
                <div class="text-warning fw-bold">${Utils.money.format(o.total_work_cost)}</div>
            </div>
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
            <div class="glass-card d-flex justify-content-between align-items-center py-3">
                <div class="d-flex align-items-center gap-3">
                    <div class="rounded-circle bg-dark p-2 text-warning"><i class="bi bi-wallet2"></i></div>
                    <div><div class="fw-bold">${a.name}</div></div>
                </div>
                <div class="fw-bold fs-5 text-white">${Utils.money.format(a.balance)}</div>
            </div>
        `,
      )
      .join("");
  }

  static async renderOrdersTable() {
    const div = document.getElementById("allOrdersBody");
    if (!div) return;

    div.innerHTML =
      '<div class="text-center py-5"><div class="spinner-border text-warning"></div></div>';

    try {
      const res = await API.getOrders({
        page: State.orders.page,
        limit: State.orders.limit,
        status: State.orders.filter,
        search: State.orders.search,
      });

      if (res.data.length === 0) {
        div.innerHTML =
          '<div class="text-center py-5 text-muted">Заказы не найдены</div>';
        return;
      }

      // 🔥 MOBILE CARD LAYOUT + FINANCIAL DATA
      div.innerHTML = res.data
        .map(
          (o) => `
                <div class="order-card">
                    <div class="order-header">
                        <div>
                            <span class="badge bg-dark border border-secondary text-muted mb-2">ID: ${o.id}</span>
                            <div class="fw-bold fs-5 text-white">${o.client_name || "Гость"}</div>
                            <div class="small text-muted">${o.client_phone || "Нет номера"}</div>
                        </div>
                        <div class="text-end">
                            ${Utils.statusBadge(o.status)}
                            <div class="mt-2 small text-muted">${Utils.date(o.created_at).split(",")[0]}</div>
                        </div>
                    </div>
                    
                    <div class="d-flex justify-content-between align-items-end mt-3 border-top border-secondary pt-3">
                        <div>
                            <div class="small text-muted">Сумма</div>
                            <div class="order-price">${Utils.money.format(o.total_work_cost)}</div>
                            ${o.manager_name ? `<div class="small text-muted mt-1"><i class="bi bi-person"></i> ${o.manager_name}</div>` : ""}
                        </div>
                        <button class="btn btn-primary rounded-pill px-4" 
                            onclick="App.openOrderEdit(${o.id}, '${o.status}', '${o.assignee_id}', ${o.final_price}, ${o.expenses})">
                            Открыть
                        </button>
                    </div>
                </div>
            `,
        )
        .join("");

      // Pagination Render (Simple)
      const paginationDiv = document.getElementById("ordersPagination");
      if (paginationDiv) {
        State.orders.totalPages = Math.ceil(res.total / State.orders.limit);
        paginationDiv.innerHTML = `
                    <button class="btn btn-dark border-secondary" ${State.orders.page <= 1 ? "disabled" : ""} onclick="App.changePage(${State.orders.page - 1})"><</button>
                    <span class="text-muted">${State.orders.page} / ${State.orders.totalPages}</span>
                    <button class="btn btn-dark border-secondary" ${State.orders.page >= State.orders.totalPages ? "disabled" : ""} onclick="App.changePage(${State.orders.page + 1})">></button>
                `;
      }
    } catch (e) {
      div.innerHTML = `<div class="text-center text-danger">Ошибка: ${e.message}</div>`;
    }
  }

  static changePage(page) {
    State.orders.page = page;
    this.renderOrdersTable();
  }

  static applyOrderFilter(status) {
    State.orders.filter = status;
    State.orders.page = 1;
    document.querySelectorAll(".filter-chip").forEach((b) => {
      b.classList.toggle("active", b.dataset.status === status);
    });
    this.renderOrdersTable();
  }

  // 🔥 МОДАЛКА: Баға және Шығынды қабылдайды
  static async openOrderEdit(
    orderId,
    currentStatus,
    managerId,
    finalPrice = 0,
    expenses = 0,
  ) {
    if (!State.users.length) State.users = await API.getUsers();
    const managers = State.users.filter((u) =>
      ["admin", "manager"].includes(u.role),
    );

    const form = document.getElementById("editOrderForm");
    form.orderId.value = orderId;
    form.status.value = currentStatus;

    // Жаңа өрістер
    form.final_price.value = finalPrice || "";
    form.expenses.value = expenses || "";

    form.assignee_id.innerHTML =
      `<option value="">-- Не назначен --</option>` +
      managers
        .map(
          (m) =>
            `<option value="${m.telegram_id}" ${String(m.telegram_id) === String(managerId) ? "selected" : ""}>${m.first_name}</option>`,
        )
        .join("");

    new bootstrap.Modal(document.getElementById("editOrderModal")).show();
  }

  static async renderUsersTable(search = "") {
    const div = document.getElementById("usersTableBody");
    if (!div) return;

    let users = State.users.length ? State.users : await API.getUsers();
    State.users = users;

    // 🔥 ID бойынша іздеу
    if (search) {
      const term = search.toLowerCase();
      users = users.filter(
        (u) =>
          (u.first_name && u.first_name.toLowerCase().includes(term)) ||
          String(u.telegram_id).includes(term),
      );
    }

    // Card Style Users
    div.innerHTML = users
      .map(
        (u) => `
            <div class="glass-card d-flex align-items-center justify-content-between p-3">
                <div class="d-flex align-items-center gap-3">
                    <div class="rounded-circle bg-dark d-flex align-items-center justify-content-center text-warning fw-bold" style="width: 40px; height: 40px;">
                        ${u.first_name ? u.first_name[0] : "?"}
                    </div>
                    <div>
                        <div class="fw-bold text-white">${u.first_name || "Без имени"}</div>
                        <div class="small text-muted">ID: ${u.telegram_id}</div>
                    </div>
                </div>
                <div>
                    <select onchange="App.changeUserRole('${u.telegram_id}', this.value)" class="form-select form-select-sm" style="width: 100px;">
                        <option value="user" ${u.role === "user" ? "selected" : ""}>User</option>
                        <option value="manager" ${u.role === "manager" ? "selected" : ""}>Staff</option>
                        <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
                    </select>
                </div>
            </div>
        `,
      )
      .join("");
  }

  static async changeUserRole(id, role) {
    try {
      await API.updateUserRole(id, role);
      Utils.toast(`Роль обновлена: ${role}`);
    } catch (e) {
      Utils.toast("Ошибка", "error");
    }
  }

  static async renderAccountsFull() {
    const accs = await API.getAccounts();
    document.getElementById("financeAccountsGrid").innerHTML = accs
      .map(
        (a) => `
            <div class="col-6 col-md-4">
                <div class="glass-card p-3 h-100 d-flex flex-column justify-content-between">
                    <div class="d-flex justify-content-between">
                        <h6 class="mb-0 text-uppercase text-muted small" style="font-size: 0.7rem;">${a.name}</h6>
                        <i class="bi bi-wallet2 text-warning"></i>
                    </div>
                    <div class="fs-4 fw-bold mt-2">${Utils.money.format(a.balance)}</div>
                </div>
            </div>
        `,
      )
      .join("");

    const opts = accs
      .map(
        (a) =>
          `<option value="${a.id}">${a.name} (${Utils.money.format(a.balance)})</option>`,
      )
      .join("");
    document.getElementById("fromAccount").innerHTML = opts;
    document.getElementById("toAccount").innerHTML = opts;
  }

  static async renderTransactions() {}

  static async renderSettingsForm() {
    const s = await API.getSettings();
    const f = document.getElementById("fullSettingsForm");
    if (f) for (const k in s) if (f[k]) f[k].value = s[k];
  }

  static bindEvents() {
    document
      .getElementById("loginForm")
      ?.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await API.login(document.getElementById("passwordInput").value);
          State.currentUser = { isAdmin: true };
          this.showApp();
        } catch {
          Utils.toast("Неверный пароль", "error");
        }
      });

    // Search debounce
    document.getElementById("orderSearchInput")?.addEventListener(
      "input",
      Utils.debounce((e) => {
        State.orders.search = e.target.value;
        this.renderOrdersTable();
      }, 500),
    );

    document.getElementById("crmSearchInput")?.addEventListener(
      "input",
      Utils.debounce((e) => {
        this.renderUsersTable(e.target.value);
      }, 500),
    );

    document
      .getElementById("manualOrderForm")
      ?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target));
        try {
          await API.createOrder(data);
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

    // 🔥 ЖАҢА: Заказды, Бағаны, Шығынды сақтау
    document
      .getElementById("editOrderForm")
      ?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          await API.updateOrder(fd.get("orderId"), {
            status: fd.get("status"),
            assignee_id: fd.get("assignee_id"),
            final_price: fd.get("final_price"), // Баға
            expenses: fd.get("expenses"), // Шығын
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

    document
      .getElementById("transferForm")
      ?.addEventListener("submit", async (e) => {
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
          this.loadViewData(State.currentView);
          Utils.toast("Перевод выполнен");
        } catch (e) {
          Utils.toast(e.message, "error");
        }
      });

    document
      .getElementById("fullSettingsForm")
      ?.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await API.updateSettings(Object.fromEntries(new FormData(e.target)));
          Utils.toast("Настройки сохранены");
        } catch (e) {
          Utils.toast(e.message, "error");
        }
      });
  }
}

document.addEventListener("DOMContentLoaded", () => App.init());
window.App = App;
window.logout = async () => {
  await API.logout();
  location.reload();
};

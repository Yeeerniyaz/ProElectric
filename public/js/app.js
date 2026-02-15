/**
 * =============================================================================
 * ⚡️ PROELECTRO ENTERPRISE | FRONTEND CONTROLLER
 * =============================================================================
 * @file public/js/app.js
 * @description Основной контроллер приложения (MVC).
 * Исправлена ошибка циклической перезагрузки (Infinite Loop).
 */

const Utils = {
    money: new Intl.NumberFormat("ru-KZ", { style: "currency", currency: "KZT", maximumFractionDigits: 0 }),
    
    date: (isoString) => {
        if (!isoString) return "-";
        return new Date(isoString).toLocaleDateString("ru-RU", {
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
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
            toast: true, position: "top-end", icon, title,
            showConfirmButton: false, timer: 3000, timerProgressBar: true,
            background: "#212529", color: "#fff"
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
        // 1. Оқиғаларды тіркеу (Login формасы жұмыс істеуі үшін)
        this.bindEvents();

        try {
            // 2. Авторизацияны тексеру
            const auth = await API.checkAuth();
            if (auth.isAdmin) {
                State.currentUser = auth;
                this.showApp(); // Егер админ болса -> Қолданбаны ашамыз
            } else {
                this.showLogin(); // Егер қонақ болса -> Логин көрсету
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
        document.getElementById("app").style.setProperty("display", "flex", "important");

        // 3. 🔥 МАҢЫЗДЫ: Роутингті тек логиннен кейін қосамыз!
        // Бұрын бұл init() ішінде болғандықтан, шексіз жүктелу болатын.
        window.addEventListener("hashchange", () => this.handleRoute());
        this.handleRoute(); 

        // Авто-жаңарту (30 сек)
        setInterval(() => {
            if (document.visibilityState === 'visible') this.loadViewData(State.currentView);
        }, 30000);
    }

    static handleRoute() {
        const hash = location.hash.slice(1) || "dashboard";
        this.switchView(hash);
    }

    static switchView(viewName) {
        document.querySelectorAll(".view-section").forEach((el) => (el.style.display = "none"));
        
        const target = document.getElementById(`view-${viewName}`);
        if (target) {
            target.style.display = "block";
            State.currentView = viewName;

            document.querySelectorAll(".nav-link").forEach((btn) => btn.classList.remove("active"));
            const activeBtn = document.querySelector(`[href="#${viewName}"]`);
            if (activeBtn) activeBtn.classList.add("active");
            
            const titles = { dashboard: 'Дашборд', orders: 'Заказы', finance: 'Финансы', crm: 'Команда', settings: 'Настройки' };
            document.getElementById('pageTitle').innerText = titles[viewName] || 'ProElectro';

            this.loadViewData(viewName);
        } else {
            location.hash = "dashboard";
        }
    }

    static async loadViewData(view) {
        // Егер юзер логин жасамаса, деректерді жүктемейміз
        if (!State.currentUser) return;

        switch (view) {
            case "dashboard":
                await Promise.all([this.renderKPI(), this.renderRecentOrders(), this.renderAccountsWidget()]);
                break;
            case "orders":
                await this.renderOrdersTable();
                break;
            case "finance":
                await Promise.all([this.renderAccountsFull(), this.renderTransactions()]);
                break;
            case "crm":
                await this.renderUsersTable();
                break;
            case "settings":
                await this.renderSettingsForm();
                break;
        }
    }

    // --- RENDERERS ---

    static async renderKPI() {
        try {
            const data = await API.getKPI();
            const container = document.getElementById("kpiGrid");
            if (!container) return;

            const cards = [
                { l: "Оборот", v: Utils.money.format(data.revenue), i: "bi-wallet2", c: "text-success" },
                { l: "В работе", v: data.activeOrders, i: "bi-cone-striped", c: "text-warning" },
                { l: "Конверсия", v: data.conversion, i: "bi-graph-up", c: "text-info" },
                { l: "Средний чек", v: Utils.money.format(data.avgCheck), i: "bi-cash-stack", c: "text-primary" },
            ];

            container.innerHTML = cards.map(c => `
                <div class="col-md-3">
                    <div class="glass-card p-3 d-flex justify-content-between align-items-center h-100">
                        <div>
                            <div class="text-muted small text-uppercase mb-1">${c.l}</div>
                            <div class="fs-4 fw-bold ${c.c}">${c.v}</div>
                        </div>
                        <i class="bi ${c.i} fs-1 opacity-25 text-white"></i>
                    </div>
                </div>
            `).join("");
        } catch (e) { console.error("KPI Error", e); }
    }

    static async renderRecentOrders() {
        const res = await API.getOrders({ limit: 5 });
        const tbody = document.getElementById("recentOrdersBody");
        if (!tbody) return;

        tbody.innerHTML = res.data.map(o => `
            <tr>
                <td><small class="text-muted">#${o.id}</small></td>
                <td><div class="fw-bold">${o.client_name || "Гость"}</div></td>
                <td>${Utils.money.format(o.total_work_cost)}</td>
                <td>${Utils.statusBadge(o.status)}</td>
                <td><small>${o.manager_name || '-'}</small></td>
            </tr>
        `).join("");
    }

    static async renderAccountsWidget() {
        const accs = await API.getAccounts();
        const div = document.getElementById("dashboardAccounts");
        if (!div) return;

        div.innerHTML = accs.map(a => `
            <div class="d-flex justify-content-between align-items-center p-3 glass-card border-0 mb-2">
                <div class="d-flex align-items-center gap-3">
                    <div class="rounded-circle bg-dark p-2 text-warning"><i class="bi bi-wallet2"></i></div>
                    <div><div class="fw-bold">${a.name}</div></div>
                </div>
                <div class="fw-bold fs-5 text-white">${Utils.money.format(a.balance)}</div>
            </div>
        `).join("");
    }

    static async renderOrdersTable() {
        const tbody = document.getElementById("allOrdersBody");
        if (!tbody) return;

        tbody.innerHTML = '<tr><td colspan="7" class="text-center py-5"><div class="spinner-border text-warning"></div></td></tr>';

        try {
            const res = await API.getOrders({
                page: State.orders.page,
                limit: State.orders.limit,
                status: State.orders.filter,
                search: State.orders.search
            });

            if (res.data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center py-5 text-muted">Заказы не найдены</td></tr>';
                return;
            }

            tbody.innerHTML = res.data.map(o => `
                <tr>
                    <td>#${o.id}</td>
                    <td>
                        <div class="fw-bold text-white">${o.client_name || "Гость"}</div>
                        <div class="small text-muted">${o.client_phone || "-"}</div>
                    </td>
                    <td>${Utils.money.format(o.total_work_cost)}</td>
                    <td>${o.manager_name || '<span class="text-muted">—</span>'}</td>
                    <td>${Utils.statusBadge(o.status)}</td>
                    <td>${Utils.date(o.created_at)}</td>
                    <td class="text-end">
                        <button class="btn btn-sm btn-outline-primary" onclick="App.openOrderEdit(${o.id}, '${o.status}', '${o.client_name}', '${o.assignee_id}')">
                            <i class="bi bi-pencil-square"></i>
                        </button>
                    </td>
                </tr>
            `).join("");
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Ошибка: ${e.message}</td></tr>`;
        }
    }

    static applyOrderFilter(status) {
        State.orders.filter = status;
        State.orders.page = 1;
        document.querySelectorAll(".filter-btn").forEach(b => {
            b.classList.toggle("active", b.dataset.status === status);
        });
        this.renderOrdersTable();
    }

    static async openOrderEdit(orderId, currentStatus, clientName, currentManagerId) {
        if (!State.users.length) State.users = await API.getUsers();
        const managers = State.users.filter(u => ["admin", "manager"].includes(u.role));

        const form = document.getElementById("editOrderForm");
        form.orderId.value = orderId;
        form.status.value = currentStatus;
        form.assignee_id.innerHTML = `<option value="">-- Не назначен --</option>` +
            managers.map(m => `<option value="${m.telegram_id}" ${String(m.telegram_id) === String(currentManagerId) ? 'selected' : ''}>${m.first_name}</option>`).join("");

        new bootstrap.Modal(document.getElementById("editOrderModal")).show();
    }

    static async renderUsersTable() {
        const users = await API.getUsers();
        State.users = users;
        document.getElementById("usersTableBody").innerHTML = users.map(u => `
            <tr>
                <td>${u.telegram_id}</td>
                <td>${u.first_name}</td>
                <td>${u.phone || "-"}</td>
                <td>
                    <select onchange="App.changeUserRole('${u.telegram_id}', this.value)" class="form-select form-select-sm bg-dark text-white border-secondary">
                        <option value="user" ${u.role === "user" ? "selected" : ""}>Клиент</option>
                        <option value="manager" ${u.role === "manager" ? "selected" : ""}>Менеджер</option>
                        <option value="admin" ${u.role === "admin" ? "selected" : ""}>Админ</option>
                    </select>
                </td>
                <td>${Utils.date(u.created_at)}</td>
            </tr>
        `).join("");
    }

    static async changeUserRole(id, role) {
        try {
            await API.updateUserRole(id, role);
            Utils.toast(`Роль обновлена: ${role}`);
        } catch (e) { Utils.toast("Ошибка", "error"); }
    }

    static async renderAccountsFull() {
        const accs = await API.getAccounts();
        document.getElementById("financeAccountsGrid").innerHTML = accs.map(a => `
            <div class="col-md-4">
                <div class="glass-card p-4 h-100 d-flex flex-column justify-content-between">
                    <div class="d-flex justify-content-between">
                        <h5 class="mb-0 text-uppercase text-muted small">${a.name}</h5>
                        <i class="bi bi-wallet2 text-warning"></i>
                    </div>
                    <div class="display-6 fw-bold mt-3">${Utils.money.format(a.balance)}</div>
                </div>
            </div>
        `).join("");
        
        const opts = accs.map(a => `<option value="${a.id}">${a.name} (${Utils.money.format(a.balance)})</option>`).join("");
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
        document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
            e.preventDefault();
            try {
                await API.login(document.getElementById("passwordInput").value);
                State.currentUser = { isAdmin: true };
                this.showApp();
            } catch { Utils.toast("Неверный пароль", "error"); }
        });

        document.getElementById("orderSearchInput")?.addEventListener("input", Utils.debounce((e) => {
            State.orders.search = e.target.value;
            this.renderOrdersTable();
        }, 500));

        document.getElementById("manualOrderForm")?.addEventListener("submit", async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.target));
            try {
                await API.createOrder(data);
                bootstrap.Modal.getInstance(document.getElementById("manualOrderModal")).hide();
                e.target.reset();
                this.renderOrdersTable();
                Utils.toast("Заказ создан");
            } catch (e) { Utils.toast(e.message, "error"); }
        });

        document.getElementById("editOrderForm")?.addEventListener("submit", async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            try {
                await API.updateOrder(fd.get('orderId'), { status: fd.get('status'), assignee_id: fd.get('assignee_id') });
                bootstrap.Modal.getInstance(document.getElementById("editOrderModal")).hide();
                this.renderOrdersTable();
                Utils.toast("Заказ обновлен");
            } catch (e) { Utils.toast(e.message, "error"); }
        });

        document.getElementById("transferForm")?.addEventListener("submit", async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.target));
            if (data.fromId === data.toId) return Utils.toast("Счета совпадают", "warning");
            try {
                await API.transfer(data.fromId, data.toId, data.amount, data.comment);
                bootstrap.Modal.getInstance(document.getElementById("transferModal")).hide();
                e.target.reset();
                this.loadViewData(State.currentView);
                Utils.toast("Перевод выполнен");
            } catch (e) { Utils.toast(e.message, "error"); }
        });
        
        document.getElementById("fullSettingsForm")?.addEventListener("submit", async (e) => {
            e.preventDefault();
            try {
                await API.updateSettings(Object.fromEntries(new FormData(e.target)));
                Utils.toast("Настройки сохранены");
            } catch (e) { Utils.toast(e.message, "error"); }
        });
    }
}

document.addEventListener("DOMContentLoaded", () => App.init());
window.App = App;
window.logout = async () => { await API.logout(); location.reload(); };
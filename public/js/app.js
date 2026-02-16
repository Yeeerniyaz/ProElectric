/**
 * @file public/js/app.js
 * @description Enterprise-grade SPA Client Controller.
 * Features: State Management, Toast System, Sortable Tables, Input Masking.
 * @author Senior Architect (ProElectro Team)
 * @version 8.0.0 (Ultimate)
 */

// =============================================================================
// 🛠 UTILS & HELPERS
// =============================================================================

const Utils = {
    // Форматирование денег (KZT)
    formatMoney: (num) => {
        if (num === null || num === undefined) return '-';
        return new Intl.NumberFormat('ru-KZ', {
            style: 'currency',
            currency: 'KZT',
            maximumFractionDigits: 0
        }).format(num);
    },

    // Форматирование даты
    formatDate: (isoDate, includeTime = false) => {
        if (!isoDate) return '-';
        const date = new Date(isoDate);
        const opts = { day: '2-digit', month: '2-digit', year: 'numeric' };
        if (includeTime) {
            opts.hour = '2-digit';
            opts.minute = '2-digit';
        }
        return date.toLocaleDateString('ru-RU', opts);
    },

    // Задержка (Debounce)
    debounce: (func, wait) => {
        let timeout;
        return function(...args) {
            const later = () => {
                clearTimeout(timeout);
                func.apply(this, args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },

    // Безопасный HTML (Sanitizer)
    escapeHtml: (unsafe) => {
        if (typeof unsafe !== 'string') return unsafe;
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    },

    // Генерация ID
    uuid: () => Math.random().toString(36).substring(2) + Date.now().toString(36)
};

// =============================================================================
// 🍞 TOAST NOTIFICATION SYSTEM (No more alerts!)
// =============================================================================

class Toaster {
    constructor() {
        this.container = document.createElement('div');
        this.container.className = 'toast-container';
        document.body.appendChild(this.container);
        this._injectStyles();
    }

    _injectStyles() {
        if (document.getElementById('toast-styles')) return;
        const css = `
            .toast-container { position: fixed; top: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; }
            .toast { min-width: 300px; padding: 16px; border-radius: 8px; background: white; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); display: flex; align-items: center; justify-content: space-between; animation: slideIn 0.3s ease-out; border-left: 4px solid #ccc; }
            .toast.success { border-left-color: #10b981; } .toast.success i { color: #10b981; }
            .toast.error { border-left-color: #ef4444; } .toast.error i { color: #ef4444; }
            .toast.info { border-left-color: #3b82f6; } .toast.info i { color: #3b82f6; }
            .toast-content { display: flex; align-items: center; gap: 12px; font-weight: 500; color: #1f2937; }
            .toast-close { cursor: pointer; color: #9ca3af; background: none; border: none; font-size: 18px; }
            @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
            @keyframes fadeOut { to { transform: translateX(100%); opacity: 0; } }
        `;
        const style = document.createElement('style');
        style.id = 'toast-styles';
        style.textContent = css;
        document.head.appendChild(style);
    }

    show(message, type = 'info', duration = 4000) {
        const icons = {
            success: 'check-circle',
            error: 'alert-circle',
            info: 'info'
        };

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <div class="toast-content">
                <i data-feather="${icons[type]}"></i>
                <span>${message}</span>
            </div>
            <button class="toast-close">&times;</button>
        `;

        this.container.appendChild(toast);
        feather.replace();

        // Close logic
        const close = () => {
            toast.style.animation = 'fadeOut 0.3s ease-in forwards';
            setTimeout(() => toast.remove(), 300);
        };

        toast.querySelector('.toast-close').addEventListener('click', close);
        setTimeout(close, duration);
    }

    success(msg) { this.show(msg, 'success'); }
    error(msg) { this.show(msg, 'error'); }
    info(msg) { this.show(msg, 'info'); }
}

const toast = new Toaster();

// =============================================================================
// 🧊 LOCAL STATE STORE (Reactivity)
// =============================================================================

class Store {
    constructor() {
        this.state = {
            user: null,
            orders: [],
            accounts: [],
            transactions: [],
            settings: {},
            dashboard: {},
            filters: {
                orderStatus: 'all',
                searchQuery: ''
            }
        };
        this.listeners = [];
    }

    get(key) { return this.state[key]; }

    set(key, value) {
        this.state[key] = value;
        this._notify(key, value);
    }

    // Частичное обновление (Patch)
    patch(key, updateObj) {
        this.state[key] = { ...this.state[key], ...updateObj };
        this._notify(key, this.state[key]);
    }

    subscribe(key, callback) {
        this.listeners.push({ key, callback });
    }

    _notify(key, value) {
        this.listeners
            .filter(l => l.key === key || l.key === '*')
            .forEach(l => l.callback(value));
    }
}

const store = new Store();

// =============================================================================
// 🏗 MODULES (BUSINESS LOGIC)
// =============================================================================

/**
 * Модуль управления заказами
 */
class OrderManager {
    constructor(app) {
        this.app = app;
        this.sortDir = 'desc';
        this.sortCol = 'id';
    }

    async fetchOrders() {
        try {
            // Загружаем ВСЕ заказы сразу для быстрого поиска на клиенте (если < 1000 записей)
            // Для Enterprise > 10k записей нужно переделать на Server-Side Pagination
            const res = await api.getOrders(store.get('filters').orderStatus);
            store.set('orders', res.data);
        } catch (e) {
            toast.error('Не удалось загрузить заказы');
        }
    }

    renderTable() {
        const tbody = document.getElementById('orders-table-body');
        tbody.innerHTML = '';

        let orders = [...store.get('orders')];
        const search = store.get('filters').searchQuery.toLowerCase();

        // 1. Фильтрация (Client-Side Search)
        if (search) {
            orders = orders.filter(o => 
                (o.client_name && o.client_name.toLowerCase().includes(search)) ||
                (o.client_phone && o.client_phone.includes(search)) ||
                String(o.id).includes(search)
            );
        }

        // 2. Сортировка
        orders.sort((a, b) => {
            let valA = a[this.sortCol];
            let valB = b[this.sortCol];
            
            // Числа
            if (!isNaN(parseFloat(valA)) && isFinite(valA)) {
                valA = parseFloat(valA);
                valB = parseFloat(valB);
            }
            
            if (valA < valB) return this.sortDir === 'asc' ? -1 : 1;
            if (valA > valB) return this.sortDir === 'asc' ? 1 : -1;
            return 0;
        });

        if (orders.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty-state">📭 Ничего не найдено</td></tr>`;
            return;
        }

        // 3. Рендеринг
        orders.forEach(order => {
            const tr = document.createElement('tr');
            
            const expenses = parseFloat(order.expenses_sum || 0);
            const finalPrice = parseFloat(order.final_price || 0);
            const profit = order.status === 'done' ? (finalPrice - expenses) : 0;
            
            const profitClass = profit > 0 ? 'text-success' : (profit < 0 ? 'text-danger' : 'text-muted');
            const expClass = expenses > 0 ? 'text-danger-soft' : 'text-muted';

            tr.innerHTML = `
                <td class="font-mono text-muted">#${order.id}</td>
                <td>
                    <div class="client-cell">
                        <div class="font-bold">${Utils.escapeHtml(order.client_name || 'Гость')}</div>
                        <div class="text-sm text-muted">${order.client_phone || '-'}</div>
                    </div>
                </td>
                <td>${this._renderStatusBadge(order.status)}</td>
                <td>
                    ${order.manager_name 
                        ? `<div class="manager-badge"><i data-feather="user"></i> ${order.manager_name}</div>` 
                        : '<span class="text-muted">—</span>'}
                </td>
                <td>
                    <div class="money-cell">
                        ${order.status === 'done' 
                            ? `<span class="font-bold">${Utils.formatMoney(finalPrice)}</span>` 
                            : `<span class="text-muted estimate">~${Utils.formatMoney(order.total_price)}</span>`
                        }
                        <div class="text-xs ${expClass}">Расх: -${Utils.formatMoney(expenses)}</div>
                    </div>
                </td>
                <td class="${profitClass} font-bold">
                    ${order.status === 'done' ? Utils.formatMoney(profit) : '...'}
                </td>
                <td class="text-right">
                    <button class="btn-icon" onclick="app.openAddExpense(${order.id})" title="Добавить расход">
                        <i data-feather="minus-circle"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        feather.replace();
    }

    _renderStatusBadge(status) {
        const map = {
            'new': { text: 'Новый', class: 'badge-new' },
            'discuss': { text: 'Обсуждение', class: 'badge-discuss' },
            'work': { text: 'В работе', class: 'badge-work' },
            'done': { text: 'Сдан', class: 'badge-done' },
            'cancel': { text: 'Отмена', class: 'badge-cancel' }
        };
        const s = map[status] || { text: status, class: 'badge-default' };
        return `<span class="status-badge ${s.class}">${s.text}</span>`;
    }

    setupSort(col) {
        if (this.sortCol === col) {
            this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortCol = col;
            this.sortDir = 'desc';
        }
        this.renderTable();
    }
}

/**
 * Модуль Финансов
 */
class FinanceManager {
    constructor() { }

    async fetchData() {
        try {
            const [accs, txs] = await Promise.all([
                api.getAccounts(),
                api.getTransactions()
            ]);
            store.set('accounts', accs);
            store.set('transactions', txs);
            this.renderAccounts();
            this.renderTransactions();
        } catch (e) {
            toast.error('Ошибка загрузки финансов');
        }
    }

    renderAccounts() {
        const container = document.getElementById('accounts-list');
        container.innerHTML = '';
        store.get('accounts').forEach(acc => {
            const div = document.createElement('div');
            div.className = 'account-card';
            div.innerHTML = `
                <div class="acc-icon ${acc.type === 'bank' ? 'bg-blue' : 'bg-green'}">
                    <i data-feather="${acc.type === 'bank' ? 'credit-card' : 'briefcase'}"></i>
                </div>
                <div class="acc-info">
                    <div class="acc-name">${acc.name}</div>
                    <div class="acc-balance">${Utils.formatMoney(acc.balance)}</div>
                </div>
            `;
            container.appendChild(div);
        });
        feather.replace();
    }

    renderTransactions() {
        const tbody = document.getElementById('transactions-body');
        tbody.innerHTML = '';
        store.get('transactions').forEach(tx => {
            const tr = document.createElement('tr');
            const isInc = tx.type === 'income';
            tr.innerHTML = `
                <td class="text-muted text-sm">${Utils.formatDate(tx.created_at)}</td>
                <td>${tx.account_name}</td>
                <td>${this._translateCat(tx.category)}</td>
                <td class="${isInc ? 'text-success' : 'text-danger'} font-bold">
                    ${isInc ? '+' : '-'} ${Utils.formatMoney(tx.amount)}
                </td>
                <td class="text-muted text-sm">${tx.comment || ''}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    _translateCat(cat) {
        const map = { 
            'order_payment': 'Оплата заказа', 'salary': 'Зарплата', 
            'material': 'Материал', 'taxi': 'Такси', 'food': 'Обед', 
            'tools': 'Инструмент' 
        };
        return map[cat] || cat;
    }
}

// =============================================================================
// 🚀 MAIN APP CONTROLLER
// =============================================================================

class App {
    constructor() {
        this.currentTab = 'dashboard';
        this.modules = {
            orders: new OrderManager(this),
            finance: new FinanceManager(this)
        };
        this.init();
    }

    async init() {
        // Проверка сессии
        try {
            const isAdmin = await api.checkAuth();
            if (!isAdmin) throw new Error('Auth required');
            
            document.getElementById('login-screen').classList.add('hidden');
            document.getElementById('app').classList.remove('hidden');
            
            this.bindGlobalEvents();
            this.loadTab('dashboard');
            this.startAutoRefresh();
            
            toast.success('Добро пожаловать в ProElectro CRM!');
        } catch (e) {
            document.getElementById('login-screen').classList.remove('hidden');
            document.getElementById('app').classList.add('hidden');
            this.bindLogin();
        }
    }

    // --- EVENT BINDING ---
    bindLogin() {
        document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button');
            this.setLoading(btn, true);
            try {
                await api.login(document.getElementById('password').value);
                window.location.reload();
            } catch (err) {
                document.getElementById('login-error').innerText = err.message;
                this.setLoading(btn, false);
                toast.error('Неверный пароль');
            }
        });
    }

    bindGlobalEvents() {
        // Logout
        document.getElementById('logout-btn').addEventListener('click', () => {
            if(confirm('Выйти из системы?')) api.logout();
        });

        // Tabs
        document.querySelectorAll('.menu-item').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.menu-item').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.loadTab(btn.dataset.tab);
            });
        });

        // Search Input (Debounced)
        const searchInput = document.createElement('input'); // Можно добавить в HTML
        // (Логика поиска есть в OrderManager)

        // Modal Closers
        document.querySelectorAll('.close-btn, .btn.secondary').forEach(btn => {
            btn.addEventListener('click', () => {
                const modal = btn.closest('.modal');
                if (modal) modal.classList.add('hidden');
            });
        });

        // Keyboard Shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
            }
        });

        // Forms
        this._bindForm('create-order-form', async (data) => {
            await api.createOrder(data);
            this.modules.orders.fetchOrders(); // Refresh but don't blocking wait
            return 'Заказ успешно создан';
        });

        this._bindForm('add-expense-form', async (data) => {
            const orderId = document.getElementById('expense-order-id').value;
            await api.addExpense(orderId, data);
            this.modules.orders.fetchOrders();
            return 'Расход добавлен';
        });
    }

    _bindForm(formId, action) {
        const form = document.getElementById(formId);
        if (!form) return;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button[type="submit"]');
            this.setLoading(btn, true);

            try {
                const formData = new FormData(form);
                const data = Object.fromEntries(formData);
                const msg = await action(data);
                
                toast.success(msg);
                form.closest('.modal').classList.add('hidden');
                form.reset();
            } catch (err) {
                toast.error(err.message || 'Ошибка выполнения');
            } finally {
                this.setLoading(btn, false);
            }
        });
    }

    // --- NAVIGATION ---
    async loadTab(tabName) {
        this.currentTab = tabName;
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.getElementById(`tab-${tabName}`).classList.add('active');
        
        // Dynamic Title
        const titles = {
            'dashboard': 'Обзор компании',
            'orders': 'Управление заказами',
            'finance': 'Финансовый отчет',
            'settings': 'Настройки системы'
        };
        document.getElementById('page-title').innerText = titles[tabName];
        this.updateDate();

        // Lazy Load Data
        switch (tabName) {
            case 'dashboard': await this.loadDashboard(); break;
            case 'orders': 
                await this.modules.orders.fetchOrders(); 
                // Подписка на изменение store
                store.subscribe('orders', () => this.modules.orders.renderTable());
                this.modules.orders.renderTable();
                break;
            case 'finance': await this.modules.finance.fetchData(); break;
            case 'settings': await this.loadSettings(); break;
        }
    }

    // --- FEATURES ---
    
    async loadDashboard() {
        try {
            const data = await api.getDashboardData();
            // Animate Numbers (Simple count up)
            this._animateNumber('kpi-revenue', data.revenue, true);
            this._animateNumber('kpi-profit', data.profit, true);
            this._animateNumber('kpi-active', data.activeOrders);
            this._animateNumber('kpi-done', data.totalOrders);
        } catch (e) { console.error(e); }
    }

    async loadSettings() {
        try {
            const settings = await api.getSettings();
            const grid = document.getElementById('settings-grid');
            grid.innerHTML = '';

            const labels = {
                'material_m2': 'Цена материала (₸/м²)',
                'price_point_concrete': 'Точка (Бетон)',
                'price_point_brick': 'Точка (Кирпич)',
                'price_point_gasblock': 'Точка (Газоблок)',
                'price_strobe_concrete': 'Штроба (Бетон)',
                'price_strobe_brick': 'Штроба (Кирпич)',
                'percent_staff': 'Доля мастера (%)',
                'percent_business': 'Доля бизнеса (%)'
            };

            for (const [key, val] of Object.entries(settings)) {
                if (key.includes('updated_at')) continue;
                
                const div = document.createElement('div');
                div.className = 'setting-item';
                div.innerHTML = `
                    <label>${labels[key] || key}</label>
                    <input type="number" value="${val}" data-key="${key}" class="setting-input">
                `;
                grid.appendChild(div);
            }

            // Save on Enter
            document.querySelectorAll('.setting-input').forEach(input => {
                input.addEventListener('change', async (e) => {
                    try {
                        await api.updateSetting(e.target.dataset.key, e.target.value);
                        toast.success('Настройка сохранена');
                        e.target.classList.add('saved');
                        setTimeout(() => e.target.classList.remove('saved'), 1000);
                    } catch (err) {
                        toast.error('Ошибка сохранения');
                    }
                });
            });

        } catch (e) { console.error(e); }
    }

    // --- UI HELPERS ---

    setLoading(btn, isLoading) {
        if (isLoading) {
            btn.dataset.original = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = `<span class="spinner-border"></span> Ждите...`;
        } else {
            btn.disabled = false;
            btn.innerHTML = btn.dataset.original;
        }
    }

    openAddExpense(orderId) {
        document.getElementById('expense-order-id').value = orderId;
        document.getElementById('expense-order-info').innerHTML = `К заказу <b>#${orderId}</b>`;
        document.getElementById('modal-add-expense').classList.remove('hidden');
    }

    refreshData() {
        this.loadTab(this.currentTab);
        toast.info('Данные обновлены');
    }

    updateDate() {
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        document.getElementById('date-display').innerText = 
            new Date().toLocaleDateString('ru-RU', options).replace(/^./, str => str.toUpperCase());
    }

    _animateNumber(id, endValue, isMoney = false) {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerText = isMoney ? Utils.formatMoney(endValue) : endValue;
        // Здесь можно подключить библиотеку типа CountUp.js для эффекта
    }

    startAutoRefresh() {
        // Автообновление каждые 30 сек
        setInterval(() => {
            if (this.currentTab === 'dashboard') this.loadDashboard();
        }, 30000);
    }
}

// Global Exports for HTML onclick handlers
const app = new App();
window.app = app;
window.openModal = (id) => document.getElementById(id).classList.remove('hidden');
window.closeModal = (id) => document.getElementById(id).classList.add('hidden');
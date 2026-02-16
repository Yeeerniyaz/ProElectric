/**
 * @file public/js/api.js
 * @description Клиентская библиотека для работы с API.
 * Все запросы к бэкенду живут здесь.
 */

const API_BASE = '/api';

class ApiClient {
    
    // --- AUTH ---
    async login(password) {
        const res = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        if (!res.ok) throw new Error('Неверный пароль');
        return await res.json();
    }

    async logout() {
        await fetch(`${API_BASE}/logout`, { method: 'POST' });
        window.location.reload();
    }

    async checkAuth() {
        try {
            const res = await fetch(`${API_BASE}/me`);
            const data = await res.json();
            return data.isAdmin;
        } catch (e) {
            return false;
        }
    }

    // --- DASHBOARD ---
    async getDashboardData() {
        return this._request('/analytics/kpi');
    }

    // --- ORDERS ---
    async getOrders(status = 'all') {
        return this._request(`/orders?status=${status}&limit=50`);
    }

    async createOrder(data) {
        return this._request('/orders', 'POST', data);
    }

    async addExpense(orderId, data) {
        return this._request(`/orders/${orderId}/expenses`, 'POST', data);
    }

    // --- FINANCE ---
    async getAccounts() {
        return this._request('/accounts');
    }

    async getTransactions() {
        return this._request('/finance/history');
    }

    // --- SETTINGS ---
    async getSettings() {
        return this._request('/settings');
    }

    async updateSetting(key, value) {
        return this._request('/settings', 'POST', { key, value });
    }

    // --- INTERNAL HELPER ---
    async _request(endpoint, method = 'GET', body = null) {
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (body) options.body = JSON.stringify(body);

        const res = await fetch(`${API_BASE}${endpoint}`, options);
        
        if (res.status === 401) {
            // Если сессия протухла — выкидываем на логин
            window.location.reload();
            throw new Error('Unauthorized');
        }
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Server Error');
        }
        
        return await res.json();
    }
}

const api = new ApiClient();
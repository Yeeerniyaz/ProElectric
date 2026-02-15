/**
 * @file public/js/api.js
 * @description API Client for ProElectro ERP.
 * Handles HTTP requests, Authentication & Error Management.
 * @version 6.5.0 (Mobile Ready)
 */

const API_URL = '/api';

class API {
    // Токенді (сессия статусын) LocalStorage-дан аламыз
    static get token() {
        return localStorage.getItem('erp_token');
    }

    // Негізгі сұраныс жіберу функциясы
    static async request(endpoint, method = 'GET', body = null) {
        const headers = { 'Content-Type': 'application/json' };
        
        // UI логикасы үшін ғана (Сервер cookie тексереді)
        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        try {
            const response = await fetch(API_URL + endpoint, {
                method,
                headers,
                body: body ? JSON.stringify(body) : null
            });

            // Егер авторизация қатесі болса (401) -> Шығарып жібереміз
            if (response.status === 401) {
                this.logout();
                location.reload();
                throw new Error('Сессия аяқталды.');
            }

            const data = await response.json();

            // Егер сервер қате қайтарса
            if (!response.ok) {
                throw new Error(data.error || 'Server Error');
            }

            return data;
        } catch (error) {
            console.error(`API Error [${endpoint}]:`, error);
            throw error;
        }
    }

    // ============================================================
    // 🔐 AUTHENTICATION
    // ============================================================
    
    static async login(password) {
        const res = await this.request('/login', 'POST', { password });
        if (res.success) {
            localStorage.setItem('erp_token', 'session_active'); 
        }
        return res;
    }

    static async checkAuth() {
        return this.request('/me');
    }

    static async logout() {
        try {
            await this.request('/logout', 'POST');
        } finally {
            localStorage.removeItem('erp_token');
        }
    }

    // ============================================================
    // 🏗 ORDER MANAGEMENT
    // ============================================================

    static async getOrders(params = {}) {
        const searchParams = new URLSearchParams(params);
        return this.request(`/orders?${searchParams.toString()}`);
    }

    // Бот арқылы емес, қолмен заказ ашу
    static async createOrder(data) {
        return this.request('/orders', 'POST', data);
    }

    // Заказды жаңарту (Статус, Баға, Шығын, Менеджер)
    static async updateOrder(id, data) {
        return this.request(`/orders/${id}`, 'PATCH', data);
    }

    // ============================================================
    // 💰 FINANCE
    // ============================================================

    static async getAccounts() {
        return this.request('/accounts');
    }

    static async transfer(fromId, toId, amount, comment) {
        return this.request('/accounts/transfer', 'POST', { fromId, toId, amount, comment });
    }

    // 🔥 ЖАҢА: Қаржылық статистика (Кіріс/Шығыс категориялары)
    static async getFinanceStats() {
        return this.request('/analytics/finance');
    }

    // ============================================================
    // 📊 ANALYTICS (KPI)
    // ============================================================

    static async getKPI() {
        return this.request('/analytics/kpi');
    }

    // ============================================================
    // 👥 CRM & SETTINGS
    // ============================================================

    static async getUsers() {
        return this.request('/users');
    }

    static async updateUserRole(id, role) {
        return this.request(`/users/${id}/role`, 'POST', { role });
    }

    static async getSettings() {
        return this.request('/settings');
    }

    static async updateSettings(data) {
        return this.request('/settings', 'POST', data);
    }
}
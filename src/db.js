import pg from 'pg';
import { config } from './config.js';
import { ORDER_STATUS } from './constants.js';

const { Pool } = pg;

// Создаем пул соединений с настройками для высокой нагрузки
const pool = new Pool({
    ...config.db,
    max: 20, 
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// Глобальный кеш настроек
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_TTL = 60 * 1000;

pool.on('error', (err) => {
    console.error('💥 [DB CRITICAL] Внезапная ошибка клиента PostgreSQL', err);
});

export const db = {
    query: (text, params) => pool.query(text, params),
    getClient: () => pool.connect(),

    /**
     * Загрузка настроек и цен (с кешированием)
     */
    getSettings: async () => {
        if (settingsCache && (Date.now() - settingsCacheTime < CACHE_TTL)) {
            return settingsCache;
        }

        try {
            const res = await pool.query('SELECT key, value FROM settings');
            const settings = {};
            res.rows.forEach(row => {
                const num = parseFloat(row.value);
                settings[row.key] = isNaN(num) ? row.value : num;
            });
            settingsCache = settings;
            settingsCacheTime = Date.now();
            return settings;
        } catch (error) {
            console.error('⚠️ [DB] Не удалось загрузить настройки:', error.message);
            return settingsCache || {}; 
        }
    },

    /**
     * Сохранение или обновление пользователя (UPSERT)
     * 🔥 ВАЖНОЕ ИСПРАВЛЕНИЕ: Мы принудительно обновляем телефон при конфликте!
     */
    upsertUser: async (telegramId, firstName, username, phone) => {
        const sql = `
            INSERT INTO users (telegram_id, first_name, username, phone, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (telegram_id) 
            DO UPDATE SET 
                first_name = EXCLUDED.first_name,
                username = EXCLUDED.username,
                -- 🔥 Если пришел новый телефон, пишем его. Если нет - оставляем старый.
                phone = COALESCE(EXCLUDED.phone, users.phone), 
                updated_at = NOW()
            RETURNING id, status, phone; -- Возвращаем актуальный телефон
        `;
        try {
            const res = await pool.query(sql, [telegramId, firstName, username, phone]);
            return res.rows[0];
        } catch (e) {
            console.error('💥 [DB] upsertUser error:', e.message);
            throw e;
        }
    },

    createLead: async (userId, leadData) => {
        const { area, wallType, totalWork, totalMat } = leadData;
        const sql = `
            INSERT INTO leads (user_id, area, wall_type, total_work_cost, total_mat_cost, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            RETURNING id;
        `;
        const res = await pool.query(sql, [userId, area, wallType, totalWork, totalMat]);
        return res.rows[0].id;
    },

    createOrder: async (telegramId, leadId) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const userRes = await client.query('SELECT id, first_name, username, phone FROM users WHERE telegram_id = $1', [telegramId]);
            if (userRes.rows.length === 0) throw new Error('User not found');
            const user = userRes.rows[0];

            const orderRes = await client.query(
                `INSERT INTO orders (user_id, lead_id, status, created_at, updated_at)
                 VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id`, 
                [user.id, leadId, ORDER_STATUS.NEW]
            );
            const leadRes = await client.query('SELECT area, total_work_cost FROM leads WHERE id = $1', [leadId]);
            
            await client.query('COMMIT');
            return { orderId: orderRes.rows[0].id, user, lead: leadRes.rows[0] };
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    },

    updateOrderStatus: async (orderId, newStatus, assigneeId = null) => {
        let sql = `UPDATE orders SET status = $1, updated_at = NOW()`;
        const params = [newStatus];
        if (assigneeId) {
            sql += `, assignee_id = $2 WHERE id = $3`;
            params.push(assigneeId, orderId);
        } else {
            sql += ` WHERE id = $2`;
            params.push(orderId);
        }
        return (await pool.query(sql, params)).rowCount > 0;
    }
};

export const initDB = async () => {
    try {
        const start = Date.now();
        await pool.query('SELECT 1');
        console.log(`✅ [DB] Подключено к ${config.db.database} за ${Date.now() - start}мс`);
    } catch (err) {
        console.error('💥 [DB FATAL] Нет подключения к БД!');
        process.exit(1);
    }
};
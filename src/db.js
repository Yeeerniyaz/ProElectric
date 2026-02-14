import pg from 'pg';
import { config } from './config.js';
import { ORDER_STATUS } from './constants.js';

const { Pool } = pg;

// Создаем пул соединений с настройками для стабильности
const pool = new Pool({
    ...config.db,
    max: 20, // Максимум 20 параллельных клиентов
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Обработчик критических ошибок
pool.on('error', (err) => {
    console.error('💥 [DB CRITICAL] Внезапная ошибка клиента PostgreSQL', err);
    process.exit(-1);
});

export const db = {
    /**
     * Выполнить произвольный SQL-запрос
     */
    query: (text, params) => pool.query(text, params),

    /**
     * Получить клиент для ручных транзакций
     */
    getClient: () => pool.connect(),

    /**
     * Загрузка настроек и цен.
     * ВАЖНО: Запрашиваем каждый раз свежие данные, чтобы работало изменение цен из дашборда.
     */
    getSettings: async () => {
        try {
            const res = await pool.query('SELECT key, value FROM settings');
            const settings = {};
            res.rows.forEach(row => {
                const num = parseFloat(row.value);
                settings[row.key] = isNaN(num) ? row.value : num;
            });
            return settings;
        } catch (error) {
            console.error('⚠️ [DB] Не удалось загрузить настройки:', error.message);
            return {}; 
        }
    },

    /**
     * Сохранение пользователя.
     * Возвращает ID и STATUS, чтобы мы знали, новый это клиент или старый.
     */
    upsertUser: async (telegramId, firstName, username, phone) => {
        const sql = `
            INSERT INTO users (telegram_id, first_name, username, phone, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (telegram_id) 
            DO UPDATE SET 
                first_name = EXCLUDED.first_name,
                username = EXCLUDED.username,
                phone = EXCLUDED.phone,
                updated_at = NOW()
            RETURNING id, status;
        `;
        const res = await pool.query(sql, [telegramId, firstName, username, phone]);
        return res.rows[0];
    },

    /**
     * Создание черновика расчета (Lead).
     * Просто сохраняем цифры, чтобы потом сформировать заказ.
     */
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

    /**
     * Создание реального заказа (Order) с ТРАНЗАКЦИЕЙ.
     * Гарантирует, что заказ создастся только если существуют юзер и лид.
     */
    createOrder: async (telegramId, leadId) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN'); // Начинаем транзакцию

            // 1. Находим пользователя
            const userRes = await client.query('SELECT id, first_name, username, phone FROM users WHERE telegram_id = $1', [telegramId]);
            if (userRes.rows.length === 0) throw new Error('User not found');
            const user = userRes.rows[0];

            // 2. Создаем заказ со статусом NEW
            const orderSql = `
                INSERT INTO orders (user_id, lead_id, status, created_at, updated_at)
                VALUES ($1, $2, $3, NOW(), NOW())
                RETURNING id;
            `;
            const orderRes = await client.query(orderSql, [user.id, leadId, ORDER_STATUS.NEW]);
            const orderId = orderRes.rows[0].id;

            // 3. Достаем детали сметы (для уведомления)
            const leadRes = await client.query('SELECT area, total_work_cost FROM leads WHERE id = $1', [leadId]);
            const lead = leadRes.rows[0];

            await client.query('COMMIT'); // Применяем изменения
            
            return { orderId, user, lead };

        } catch (e) {
            await client.query('ROLLBACK'); // Если ошибка — отменяем всё
            console.error('💥 [DB TRANSACTION] Order creation failed:', e);
            throw e;
        } finally {
            client.release(); // Возвращаем клиент в пул
        }
    },

    /**
     * Обновление статуса заказа (CRM)
     */
    updateOrderStatus: async (orderId, newStatus) => {
        const sql = `
            UPDATE orders 
            SET status = $1, updated_at = NOW() 
            WHERE id = $2 
            RETURNING id;
        `;
        const res = await pool.query(sql, [newStatus, orderId]);
        return res.rowCount > 0;
    }
};

/**
 * Проверка подключения при старте
 */
export const initDB = async () => {
    try {
        const start = Date.now();
        const res = await pool.query('SELECT NOW(), version()');
        const duration = Date.now() - start;
        console.log(`✅ [DB] Подключено к ${config.db.database} за ${duration}мс`);
    } catch (err) {
        console.error('💥 [DB FATAL] Нет подключения к базе данных!');
        console.error('   └─ Проверь .env и контейнер proelectro-db');
        process.exit(1);
    }
};
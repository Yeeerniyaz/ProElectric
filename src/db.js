import pg from 'pg';
import { config } from './config.js';
import { ORDER_STATUS } from './constants.js';

const { Pool } = pg;

// Создаем пул соединений с настройками для высокой нагрузки
const pool = new Pool({
    ...config.db,
    max: 20, // Максимум 20 параллельных клиентов
    idleTimeoutMillis: 30000, // Закрывать простой через 30 сек
    connectionTimeoutMillis: 5000, // Тайм-аут подключения 5 сек
});

// Глобальный кеш настроек (чтобы не душить базу)
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_TTL = 60 * 1000; // Кеш живет 1 минуту

// Обработчик критических ошибок пула
pool.on('error', (err) => {
    console.error('💥 [DB CRITICAL] Внезапная ошибка клиента PostgreSQL', err);
    // В продакшене тут можно не убивать процесс, а просто логировать, если есть ретрай
    // process.exit(-1); 
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
     * Загрузка настроек и цен (с кешированием)
     * Кеш обновляется раз в минуту.
     */
    getSettings: async () => {
        // Если кеш свежий — отдаем его
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
            
            // Обновляем кеш
            settingsCache = settings;
            settingsCacheTime = Date.now();
            
            return settings;
        } catch (error) {
            console.error('⚠️ [DB] Не удалось загрузить настройки:', error.message);
            // Если база упала, возвращаем хотя бы старый кеш (если есть) или пустой объект
            return settingsCache || {}; 
        }
    },

    /**
     * Сохранение или обновление пользователя (UPSERT)
     */
    upsertUser: async (telegramId, firstName, username, phone) => {
        const sql = `
            INSERT INTO users (telegram_id, first_name, username, phone, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (telegram_id) 
            DO UPDATE SET 
                first_name = EXCLUDED.first_name,
                username = EXCLUDED.username,
                phone = COALESCE(EXCLUDED.phone, users.phone), -- Не затираем телефон, если он уже есть
                updated_at = NOW()
            RETURNING id, status, phone;
        `;
        try {
            const res = await pool.query(sql, [telegramId, firstName, username, phone]);
            return res.rows[0];
        } catch (e) {
            console.error('💥 [DB] upsertUser error:', e.message);
            throw e;
        }
    },

    /**
     * Создание черновика расчета (Lead)
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
     * Создание реального заказа (Order) с ТРАНЗАКЦИЕЙ
     */
    createOrder: async (telegramId, leadId) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN'); // Старт транзакции

            // 1. Находим пользователя
            const userRes = await client.query('SELECT id, first_name, username, phone FROM users WHERE telegram_id = $1', [telegramId]);
            if (userRes.rows.length === 0) throw new Error('User not found');
            const user = userRes.rows[0];

            // 2. Создаем заказ
            const orderSql = `
                INSERT INTO orders (user_id, lead_id, status, created_at, updated_at)
                VALUES ($1, $2, $3, NOW(), NOW())
                RETURNING id;
            `;
            const orderRes = await client.query(orderSql, [user.id, leadId, ORDER_STATUS.NEW]);
            const orderId = orderRes.rows[0].id;

            // 3. Достаем детали сметы
            const leadRes = await client.query('SELECT area, total_work_cost FROM leads WHERE id = $1', [leadId]);
            const lead = leadRes.rows[0];

            await client.query('COMMIT'); // Успех
            
            return { orderId, user, lead };

        } catch (e) {
            await client.query('ROLLBACK'); // Откат при ошибке
            console.error('💥 [DB TRANSACTION] Order creation failed:', e);
            throw e;
        } finally {
            client.release(); // Важно: всегда возвращаем клиент в пул!
        }
    },

    /**
     * Обновление статуса заказа и ответственного
     */
    updateOrderStatus: async (orderId, newStatus, assigneeId = null) => {
        let sql = `UPDATE orders SET status = $1, updated_at = NOW()`;
        const params = [newStatus];
        
        // Если передан assigneeId, обновляем и его
        if (assigneeId) {
            sql += `, assignee_id = $2 WHERE id = $3`;
            params.push(assigneeId, orderId);
        } else {
            sql += ` WHERE id = $2`;
            params.push(orderId);
        }
        
        sql += ` RETURNING id`;

        const res = await pool.query(sql, params);
        return res.rowCount > 0;
    }
};

/**
 * Инициализация и проверка подключения при старте
 */
export const initDB = async () => {
    try {
        const start = Date.now();
        // Простой пинг базы
        await pool.query('SELECT 1');
        const duration = Date.now() - start;
        console.log(`✅ [DB] Подключено к ${config.db.database} за ${duration}мс`);
    } catch (err) {
        console.error('💥 [DB FATAL] Нет подключения к базе данных!');
        console.error('   └─ Проверь переменные .env и запущен ли контейнер proelectro-db');
        process.exit(1);
    }
};
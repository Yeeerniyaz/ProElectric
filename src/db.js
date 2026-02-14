import pg from 'pg';
import { config } from './config.js'; // Исправлен путь к конфигу

const { Pool } = pg;

// Настраиваем пул соединений с защитой от перегрузок
const pool = new Pool(config.db);

/**
 * Объект для работы с базой данных
 */
export const db = {
    /**
     * Выполнение любого SQL запроса
     */
    query: (text, params) => pool.query(text, params),

    /**
     * Получение клиента из пула для сложных операций (транзакций)
     */
    getClient: () => pool.connect(),

    /**
     * Динамическое получение настроек из БД.
     * Позволяет менять цены за точки и материалы через дашборд мгновенно.
     */
    getSettings: async () => {
        try {
            const res = await pool.query('SELECT key, value FROM settings');
            const settings = {};
            res.rows.forEach(row => {
                settings[row.key] = parseFloat(row.value);
            });
            return settings;
        } catch (error) {
            console.error('❌ [DB ERROR] Ошибка загрузки settings:', error.message);
            return {};
        }
    },

    /**
     * Регистрация или обновление данных пользователя (Фейсконтроль)
     */
    upsertUser: async (telegramId, firstName, username, phone) => {
        const sql = `
            INSERT INTO users (telegram_id, first_name, username, phone)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (telegram_id) 
            DO UPDATE SET 
                first_name = EXCLUDED.first_name,
                username = EXCLUDED.username,
                phone = EXCLUDED.phone
            RETURNING id;
        `;
        const res = await pool.query(sql, [telegramId, firstName, username, phone]);
        return res.rows[0].id;
    }
};

/**
 * Инициализация базы данных и проверка "искры"
 */
export const initDB = async () => {
    try {
        const res = await pool.query('SELECT NOW() as now');
        console.log(`✅ [DB] Соединение установлено. Время БД: ${res.rows[0].now}`);
        
        const checkSettings = await pool.query("SELECT COUNT(*) FROM settings");
        console.log(`📊 [DB] В таблице настроек найдено записей: ${checkSettings.rows[0].count}`);
        
    } catch (err) {
        console.error('💥 [DB FATAL] Короткое замыкание при подключении к БД!');
        console.error('Детали:', err.message);
        process.exit(1);
    }
};
import pg from 'pg';
import { config } from './bot.js';

const { Pool } = pg;

// Настраиваем пул соединений
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
     * ГЛАВНАЯ ФИШКА: Получение всех настроек из БД в реальном времени.
     * Позволяет менять цены за точки, коэффициенты и стоимость материалов
     * через дашборд, и бот сразу подхватит их при следующем расчете.
     * @returns {Promise<Object>} Объект типа { key: value }
     */
    getSettings: async () => {
        try {
            const res = await pool.query('SELECT key, value FROM settings');
            const settings = {};
            res.rows.forEach(row => {
                // Приводим строку из БД к числу для математики
                settings[row.key] = parseFloat(row.value);
            });
            return settings;
        } catch (error) {
            console.error('❌ [DB ERROR] Не удалось загрузить настройки из таблицы settings:', error.message);
            // Возвращаем пустой объект, чтобы калькулятор не упал, а выдал дефолты
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
        
        // Проверяем наличие таблицы настроек
        const checkSettings = await pool.query("SELECT COUNT(*) FROM settings");
        console.log(`📊 [DB] В таблице настроек найдено записей: ${checkSettings.rows[0].count}`);
        
    } catch (err) {
        console.error('💥 [DB FATAL] Короткое замыкание при подключении к PostgreSQL!');
        console.error('Сообщение:', err.message);
        process.exit(1);
    }
};
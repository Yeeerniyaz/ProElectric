import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

// Создаем пул соединений (это эффективнее, чем открывать новое на каждый запрос)
const pool = new Pool(config.db);

// Обработчик ошибок пула (если БД упадет, мы увидим это в логах)
pool.on('error', (err) => {
    console.error('💥 [DB CRITICAL] Внезапная ошибка клиента PostgreSQL', err);
    process.exit(-1);
});

export const db = {
    /**
     * Выполнить произвольный SQL-запрос
     * @param {string} text - SQL запрос
     * @param {Array} params - Параметры для защиты от SQL-инъекций
     */
    query: (text, params) => pool.query(text, params),

    /**
     * Получить клиент из пула для транзакций (BEGIN -> COMMIT -> ROLLBACK)
     */
    getClient: () => pool.connect(),

    /**
     * Загрузка настроек и цен из таблицы settings
     * Возвращает объект вида { "price_concrete": 4000, ... }
     */
    getSettings: async () => {
        try {
            const res = await pool.query('SELECT key, value FROM settings');
            const settings = {};
            res.rows.forEach(row => {
                // Пытаемся привести к числу, если это возможно
                const num = parseFloat(row.value);
                settings[row.key] = isNaN(num) ? row.value : num;
            });
            return settings;
        } catch (error) {
            console.error('⚠️ [DB] Не удалось загрузить настройки:', error.message);
            return {}; // Возвращаем пустой объект, чтобы бот не упал
        }
    },

    /**
     * "Умное" сохранение пользователя (Upsert)
     * Используем PostgreSQL фичу ON CONFLICT для атомарности
     */
    upsertUser: async (telegramId, firstName, username, phone) => {
        const sql = `
            INSERT INTO users (telegram_id, first_name, username, phone)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (telegram_id) 
            DO UPDATE SET 
                first_name = EXCLUDED.first_name,
                username = EXCLUDED.username,
                phone = EXCLUDED.phone,
                updated_at = NOW()
            RETURNING id;
        `;
        const res = await pool.query(sql, [telegramId, firstName, username, phone]);
        return res.rows[0].id;
    }
};

/**
 * Функция проверки здоровья базы при старте
 */
export const initDB = async () => {
    try {
        const start = Date.now();
        const res = await pool.query('SELECT NOW(), version()');
        const duration = Date.now() - start;
        console.log(`✅ [DB] Подключено к ${config.db.database} за ${duration}мс`);
        console.log(`   └─ Версия: ${res.rows[0].version}`);
    } catch (err) {
        console.error('💥 [DB FATAL] Нет подключения к базе данных!');
        console.error('   └─ Проверь .env и запущен ли контейнер proelectro-db');
        console.error('   └─ Ошибка:', err.message);
        process.exit(1); // Жесткий выход, чтобы Docker перезапустил контейнер
    }
};

// psql -U proelectro -d proelectro_db
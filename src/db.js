import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

// 1. Конфигурация пула (High Load Ready)
const pool = new Pool({
  user: config.db.user,
  host: config.db.host,
  database: config.db.database,
  password: config.db.password,
  port: config.db.port,
  max: 20, // Максимум 20 одновременных подключений
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Кэширование настроек (Performance Optimization)
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_TTL = 60 * 1000; // 1 минута

pool.on("error", (err) => {
  console.error("💥 [DB CRITICAL] Unexpected error on idle client", err);
});

// =============================================================================
// 🛠 БАЗОВЫЕ ИНСТРУМЕНТЫ (CORE UTILS)
// =============================================================================

/**
 * Выполняет SQL-запрос.
 * Автоматически логирует медленные запросы (>1000ms).
 */
const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`⚠️ [DB SLOW] ${duration}ms: ${text} [${params}]`);
    }
    return res;
  } catch (e) {
    console.error(`💥 [DB ERROR] ${e.message} | Query: ${text}`);
    throw e;
  }
};

/**
 * 🔥 TRANSACTION WRAPPER (Главная фишка Senior-кода)
 * Выполняет функцию внутри транзакции. Само делает COMMIT или ROLLBACK.
 * @param {Function} callback - Асинхронная функция, принимающая client
 */
const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client); // Выполняем бизнес-логику
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("💥 [TX ROLLBACK]", e.message);
    throw e;
  } finally {
    client.release(); // Всегда освобождаем соединение
  }
};

// =============================================================================
// 🧠 БИЗНЕС-ЛОГИКА (DOMAIN LOGIC)
// =============================================================================

export const db = {
  query,
  transaction,
  getClient: () => pool.connect(),

  /**
   * Получить настройки (с кэшированием)
   */
  getSettings: async () => {
    if (settingsCache && Date.now() - settingsCacheTime < CACHE_TTL) {
      return settingsCache;
    }
    // Дефолтные настройки (Fallback)
    const defaults = {
      material_m2: 4000,
      wall_light: 4500,
      wall_medium: 5500,
      wall_heavy: 7500,
      work_strobe: 1500,
      work_cable: 400,
      work_box: 1000,
      work_junction: 2500,
      work_point: 1500,
      work_lamp: 3000,
      work_automaton: 2500,
      work_shield_install: 5000,
      work_input: 15000,
      work_check: 20000,
      business_percent: 20,
      staff_percent: 80,
    };
    try {
      const res = await query("SELECT key, value FROM settings");
      const settings = { ...defaults };
      res.rows.forEach((row) => {
        const num = parseFloat(row.value);
        settings[row.key] = isNaN(num) ? row.value : num;
      });
      settingsCache = settings;
      settingsCacheTime = Date.now();
      return settings;
    } catch (e) {
      return defaults;
    }
  },

  /**
   * Создать или обновить пользователя
   */
  upsertUser: async (telegramId, firstName, username, phone = null) => {
    const sql = `
            INSERT INTO users (telegram_id, first_name, username, phone, created_at, updated_at)
            VALUES ($1, $2, $3, $4, NOW(), NOW())
            ON CONFLICT (telegram_id) DO UPDATE SET 
                first_name = EXCLUDED.first_name,
                username = EXCLUDED.username,
                phone = COALESCE(EXCLUDED.phone, users.phone), 
                updated_at = NOW()
            RETURNING telegram_id, role, phone;
        `;
    const res = await query(sql, [telegramId, firstName, username, phone]);
    return res.rows[0];
  },

  updateUserPhone: async (telegramId, phone) => {
    await query(
      "UPDATE users SET phone = $1, updated_at = NOW() WHERE telegram_id = $2",
      [phone, telegramId],
    );
    return true;
  },

  /**
   * Создать лид (расчет)
   */
  createLead: async (userId, leadData) => {
    const { area, wallType, totalWork, totalMat } = leadData;
    const res = await query(
      `INSERT INTO leads (user_id, area, wall_type, total_work_cost, total_mat_cost, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
      [userId, area, wallType, totalWork, totalMat],
    );
    return res.rows[0].id;
  },

  /**
   * Создать заказ (используя безопасную транзакцию)
   */
  createOrder: async (telegramId, leadId) => {
    return transaction(async (client) => {
      // 1. Проверяем юзера
      const userRes = await client.query(
        "SELECT * FROM users WHERE telegram_id = $1",
        [telegramId],
      );
      if (!userRes.rows[0]) throw new Error("User not found");

      // 2. Проверяем лид
      const leadRes = await client.query("SELECT * FROM leads WHERE id = $1", [
        leadId,
      ]);
      if (!leadRes.rows[0]) throw new Error("Lead not found");

      // 3. Создаем заказ
      const orderRes = await client.query(
        `INSERT INTO orders (user_id, lead_id, status, created_at, updated_at)
                 VALUES ($1, $2, 'new', NOW(), NOW()) RETURNING id`,
        [telegramId, leadId],
      );

      return {
        orderId: orderRes.rows[0].id,
        user: userRes.rows[0],
        lead: leadRes.rows[0],
      };
    });
  },

  /**
   * Финансовый перевод (используя безопасную транзакцию)
   */
  transferMoney: async (data) => {
    return transaction(async (client) => {
      const { fromAccountId, toAccountId, amount, userId, comment } = data;

      // Списываем
      await client.query(
        "UPDATE accounts SET balance = balance - $1, updated_at = NOW() WHERE id = $2",
        [amount, fromAccountId],
      );
      // Начисляем
      await client.query(
        "UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2",
        [amount, toAccountId],
      );

      // Логируем
      await client.query(
        `INSERT INTO transactions (user_id, account_id, amount, type, category, comment, created_at)
                 VALUES ($1, $2, $3, 'expense', 'transfer', $4, NOW())`,
        [userId, fromAccountId, amount, `OUT -> #${toAccountId}. ${comment}`],
      );
      await client.query(
        `INSERT INTO transactions (user_id, account_id, amount, type, category, comment, created_at)
                 VALUES ($1, $2, $3, 'income', 'transfer', $4, NOW())`,
        [userId, toAccountId, amount, `IN <- #${fromAccountId}. ${comment}`],
      );
      return true;
    });
  },

  addTransaction: async (data) => {
    return transaction(async (client) => {
      const { userId, accountId, amount, type, category, comment, orderId } =
        data;
      const balanceChange = type === "income" ? amount : -amount;

      await client.query(
        "UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2",
        [balanceChange, accountId],
      );

      const res = await client.query(
        `INSERT INTO transactions (user_id, account_id, amount, type, category, comment, order_id, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id`,
        [userId, accountId, amount, type, category, comment, orderId || null],
      );
      return res.rows[0].id;
    });
  },

  getStats: async () => {
    try {
      const funnel = await query(`
                SELECT status, COUNT(*) as count, SUM(l.total_work_cost) as money
                FROM orders o JOIN leads l ON o.lead_id = l.id
                GROUP BY status
            `);
      const recent = await query(`
                SELECT o.id, u.first_name, l.total_work_cost, o.status, o.created_at
                FROM orders o
                JOIN users u ON o.user_id = u.telegram_id
                JOIN leads l ON o.lead_id = l.id
                ORDER BY o.created_at DESC LIMIT 10
            `);
      return { funnel: funnel.rows, recent: recent.rows };
    } catch (e) {
      return { funnel: [], recent: [] };
    }
  },

  getFinancialAnalytics: async () => {
    try {
      const res = await query(`
                SELECT category, type, SUM(amount) as total_amount, COUNT(*) as count
                FROM transactions GROUP BY category, type
            `);
      return res.rows;
    } catch (e) {
      return [];
    }
  },

  getAccounts: async () => {
    try {
      const res = await query("SELECT * FROM accounts ORDER BY id ASC");
      return res.rows;
    } catch (e) {
      return [];
    }
  },
};

/**
 * Инициализация БД (Idempotent Migration)
 * Можно запускать сколько угодно раз — ничего не сломает.
 */
export const initDB = async () => {
  console.log("⏳ [DB] Verifying schema...");
  try {
    await db.transaction(async (client) => {
      // Создание таблиц (если нет)
      const tables = [
        `CREATE TABLE IF NOT EXISTS users (telegram_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, phone TEXT, role TEXT DEFAULT 'user', password_hash TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS leads (id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(telegram_id), area NUMERIC, wall_type TEXT, total_work_cost NUMERIC, total_mat_cost NUMERIC, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(telegram_id), lead_id INTEGER REFERENCES leads(id), status TEXT DEFAULT 'new', assignee_id BIGINT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, name TEXT NOT NULL, balance NUMERIC DEFAULT 0, type TEXT DEFAULT 'cash', updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value NUMERIC NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(telegram_id), account_id INTEGER REFERENCES accounts(id), order_id INTEGER REFERENCES orders(id), amount NUMERIC NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL, comment TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
      ];

      for (const t of tables) await client.query(t);

      // Миграция колонок (на случай старой базы)
      await client.query(
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES leads(id)`,
      );
      await client.query(
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
      );
      await client.query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
      );

      // Начальные данные (Seeding)
      const accCheck = await client.query("SELECT COUNT(*) FROM accounts");
      if (parseInt(accCheck.rows[0].count) === 0) {
        await client.query(`INSERT INTO accounts (name, type, balance) VALUES 
                    ('Каспий Бизнес', 'bank', 0), ('Наличка (Офис)', 'cash', 0),
                    ('Фонд Материал', 'saving', 0), ('Фонд Оклад', 'saving', 0), ('Чистая прибыль', 'saving', 0)`);
      }

      // Настройки
      const settings = [
        ["material_m2", 4000],
        ["wall_light", 4500],
        ["wall_medium", 5500],
        ["wall_heavy", 7500],
        ["work_strobe", 1500],
        ["work_cable", 400],
        ["work_box", 1000],
        ["work_junction", 2500],
        ["work_point", 1500],
        ["work_lamp", 3000],
        ["work_automaton", 2500],
        ["work_shield_install", 5000],
        ["work_input", 15000],
        ["work_check", 20000],
        ["business_percent", 20],
        ["staff_percent", 80],
      ];
      for (const [k, v] of settings) {
        await client.query(
          "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
          [k, v],
        );
      }
    });
    console.log(`✅ [DB] Schema verified & ready.`);
  } catch (e) {
    console.error("💥 [DB FATAL]", e);
    process.exit(1);
  }
};

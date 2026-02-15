import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

// 1. Настройка пула (Production Grade)
const pool = new Pool({
  user: config.db.user,
  host: config.db.host,
  database: config.db.database,
  password: config.db.password,
  port: config.db.port,
  max: 20, // Лимит соединений
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Кэширование настроек
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_TTL = 60 * 1000; // 1 минута

pool.on("error", (err) => {
  console.error("💥 [DB CRITICAL] Unexpected error on idle client", err);
});

export const db = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),

  /**
   * Получение актуальных цен с поддержкой кеширования
   */
  getSettings: async () => {
    if (settingsCache && Date.now() - settingsCacheTime < CACHE_TTL) {
      return settingsCache;
    }

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
      const res = await pool.query("SELECT key, value FROM settings");
      const settings = { ...defaults };
      res.rows.forEach((row) => {
        const num = parseFloat(row.value);
        settings[row.key] = isNaN(num) ? row.value : num;
      });
      settingsCache = settings;
      settingsCacheTime = Date.now();
      return settings;
    } catch (error) {
      console.error("⚠️ [DB] Settings load error:", error.message);
      return defaults;
    }
  },

  upsertUser: async (telegramId, firstName, username, phone = null) => {
    const client = await pool.connect();
    try {
      const query = `
                INSERT INTO users (telegram_id, first_name, username, phone, created_at, updated_at)
                VALUES ($1, $2, $3, $4, NOW(), NOW())
                ON CONFLICT (telegram_id) 
                DO UPDATE SET 
                    first_name = EXCLUDED.first_name,
                    username = EXCLUDED.username,
                    phone = COALESCE(EXCLUDED.phone, users.phone), 
                    updated_at = NOW()
                RETURNING telegram_id, role, phone;
            `;
      const res = await client.query(query, [
        telegramId,
        firstName,
        username,
        phone,
      ]);
      return res.rows[0];
    } catch (e) {
      console.error("💥 [DB] upsertUser error:", e.message);
      throw e;
    } finally {
      client.release();
    }
  },

  updateUserPhone: async (telegramId, phone) => {
    try {
      await pool.query(
        "UPDATE users SET phone = $1, updated_at = NOW() WHERE telegram_id = $2",
        [phone, telegramId],
      );
      return true;
    } catch (e) {
      console.error("💥 [DB] Phone update error:", e.message);
      return false;
    }
  },

  createLead: async (userId, leadData) => {
    const { area, wallType, totalWork, totalMat } = leadData;
    try {
      const res = await pool.query(
        `INSERT INTO leads (user_id, area, wall_type, total_work_cost, total_mat_cost, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
        [userId, area, wallType, totalWork, totalMat],
      );
      return res.rows[0].id;
    } catch (e) {
      console.error("💥 [DB] Lead creation error:", e.message);
      return null;
    }
  },

  createOrder: async (telegramId, leadId) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const userRes = await client.query(
        "SELECT telegram_id, first_name, username, phone FROM users WHERE telegram_id = $1",
        [telegramId],
      );
      if (!userRes.rows[0]) throw new Error("User not found");

      const orderRes = await client.query(
        `INSERT INTO orders (user_id, lead_id, status, created_at, updated_at)
                 VALUES ($1, $2, 'new', NOW(), NOW()) RETURNING id`,
        [telegramId, leadId],
      );
      await client.query("COMMIT");
      return { orderId: orderRes.rows[0].id, user: userRes.rows[0] };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },

  getStats: async () => {
    try {
      const funnel = await pool.query(`
                SELECT status, COUNT(*) as count, SUM(l.total_work_cost) as money
                FROM orders o JOIN leads l ON o.lead_id = l.id
                GROUP BY status
            `);
      const recent = await pool.query(`
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
    const sql = `
            SELECT 
                category,
                type,
                SUM(amount) as total_amount,
                COUNT(*) as count
            FROM transactions
            GROUP BY category, type
        `;
    try {
      const res = await pool.query(sql);
      return res.rows;
    } catch (e) {
      console.error("💥 [DB] getFinancialAnalytics error:", e.message);
      return [];
    }
  },

  // =========================================================================
  // 🔥 ЖАҢА ФУНКЦИЯЛАР: ШОТТАР ЖӘНЕ АУДАРЫМДАР (ERP v3.0)
  // =========================================================================

  /**
   * Барлық шоттардың тізімі мен балансын алу
   */
  getAccounts: async () => {
    try {
      const res = await pool.query("SELECT * FROM accounts ORDER BY id ASC");
      return res.rows;
    } catch (e) {
      console.error("💥 [DB] getAccounts error:", e.message);
      return [];
    }
  },

  /**
   * Шоттар арасында ақша аудару (Перевод)
   * @param {Object} data { fromAccountId, toAccountId, amount, userId, comment }
   */
  transferMoney: async (data) => {
    const { fromAccountId, toAccountId, amount, userId, comment } = data;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Ақшаны шығару (Minus)
      await client.query(
        "UPDATE accounts SET balance = balance - $1, updated_at = NOW() WHERE id = $2",
        [amount, fromAccountId],
      );

      // 2. Ақшаны кіргізу (Plus)
      await client.query(
        "UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2",
        [amount, toAccountId],
      );

      // 3. Тарихқа жазу (Transactions) - екі жақты жазба
      await client.query(
        `INSERT INTO transactions (user_id, account_id, amount, type, category, comment, created_at)
                 VALUES ($1, $2, $3, 'expense', 'transfer', $4, NOW())`,
        [
          userId,
          fromAccountId,
          amount,
          `Шығыс аударым: #${toAccountId}. ${comment}`,
        ],
      );

      await client.query(
        `INSERT INTO transactions (user_id, account_id, amount, type, category, comment, created_at)
                 VALUES ($1, $2, $3, 'income', 'transfer', $4, NOW())`,
        [
          userId,
          toAccountId,
          amount,
          `Кіріс аударым: #${fromAccountId}. ${comment}`,
        ],
      );

      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("💥 [DB] transferMoney error:", e.message);
      throw e;
    } finally {
      client.release();
    }
  },

  /**
   * Транзакция қосу (Балансты автоматты жаңартумен)
   * @param {Object} data { userId, accountId, amount, type, category, comment, orderId }
   */
  addTransaction: async (data) => {
    const { userId, accountId, amount, type, category, comment, orderId } =
      data;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Шот балансын жаңарту
      const balanceChange = type === "income" ? amount : -amount;
      await client.query(
        "UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2",
        [balanceChange, accountId],
      );

      // 2. Транзакцияны тіркеу
      const res = await client.query(
        `INSERT INTO transactions (user_id, account_id, amount, type, category, comment, order_id, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id`,
        [userId, accountId, amount, type, category, comment, orderId || null],
      );

      await client.query("COMMIT");
      return res.rows[0].id;
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("💥 [DB] addTransaction error:", e.message);
      throw e;
    } finally {
      client.release();
    }
  },
};

/**
 * AUTO-MIGRATION SYSTEM (Senior ERP Edition)
 * Базаны нөлден жасайды немесе ескі нұсқаны автоматты түрде жаңартады.
 */
export const initDB = async () => {
  const client = await pool.connect();
  try {
    console.log("⏳ [DB] Verifying database schema and migrating...");

    // Барлығы бір транзакцияда өтуі тиіс
    await client.query("BEGIN");

    // 1. ПАЙДАЛАНУШЫЛАР (USERS) + Migration
    await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                telegram_id BIGINT PRIMARY KEY,
                username TEXT, 
                first_name TEXT, 
                phone TEXT,
                role TEXT DEFAULT 'user',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

    // Егер кесте бұрыннан болса, жетіспейтін бағандарды қосамыз
    await client.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
        `);

    // 2. ШОТТАР (ACCOUNTS)
    await client.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                balance NUMERIC DEFAULT 0,
                type TEXT DEFAULT 'cash', -- 'bank', 'cash', 'saving'
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

    // 3. БАПТАУЛАР (SETTINGS)
    await client.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY, 
                value NUMERIC NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

    // 4. ЛИДТЕР (LEADS)
    await client.query(`
            CREATE TABLE IF NOT EXISTS leads (
                id SERIAL PRIMARY KEY, 
                user_id BIGINT REFERENCES users(telegram_id),
                area NUMERIC, 
                wall_type TEXT, 
                total_work_cost NUMERIC, 
                total_mat_cost NUMERIC,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

    // 5. ТАПСЫРЫСТАР (ORDERS)
    await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY, 
                user_id BIGINT REFERENCES users(telegram_id),
                lead_id INTEGER REFERENCES leads(id),
                status TEXT DEFAULT 'new', 
                assignee_id BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

    // 6. ТРАНЗАКЦИЯЛАР (TRANSACTIONS)
    await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id BIGINT REFERENCES users(telegram_id), -- Кім жасады
                account_id INTEGER REFERENCES accounts(id), -- Қай шот бойынша
                order_id INTEGER REFERENCES orders(id),        -- Қай заказға қатысты
                amount NUMERIC NOT NULL,
                type TEXT NOT NULL,         -- 'income', 'expense'
                category TEXT NOT NULL,     -- 'salary', 'material', 'transfer', 'business'
                comment TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

    // --- БАЗАНЫ БАСТАПҚЫ ДЕРЕКТЕРМЕН ТОЛТЫРУ (SEEDING) ---

    // Шоттарды тексеру және қосу
    const accountCheck = await client.query("SELECT COUNT(*) FROM accounts");
    if (parseInt(accountCheck.rows[0].count) === 0) {
      console.log("🏦 [DB] Creating default ERP accounts...");
      await client.query(`
                INSERT INTO accounts (name, type, balance) VALUES 
                ('Каспий Бизнес', 'bank', 0),
                ('Наличка (Офис)', 'cash', 0),
                ('Фонд Материал', 'saving', 0),
                ('Фонд Оклад', 'saving', 0),
                ('Чистая прибыль', 'saving', 0);
            `);
    }

    // Прайс-лист және пайыздарды тексеру
    const initialSettings = [
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

    for (const [key, val] of initialSettings) {
      await client.query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
        [key, val],
      );
    }

    await client.query("COMMIT");
    console.log(
      `✅ [DB] Database initialized successfully (Accounts & ERP v3.0)`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("💥 [DB FATAL] Initialization or Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
};

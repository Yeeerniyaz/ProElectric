import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

const pool = new Pool({
  ...config.db,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Кэш настроек
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_TTL = 60 * 1000;

pool.on("error", (err) => console.error("💥 [DB CRITICAL]", err));

// --- UTILS ---
const query = async (text, params) => pool.query(text, params);

const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

// --- LOGIC ---
export const db = {
  query,
  transaction,

  // Настройки с кэшированием
  getSettings: async () => {
    if (settingsCache && Date.now() - settingsCacheTime < CACHE_TTL)
      return settingsCache;
    try {
      const res = await query("SELECT key, value FROM settings");
      const settings = {};
      res.rows.forEach(
        (row) => (settings[row.key] = parseFloat(row.value) || row.value),
      );
      settingsCache = settings;
      settingsCacheTime = Date.now();
      return settings;
    } catch (e) {
      return {};
    }
  },

  // Юзерді жаңарту
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

  // Рольді өзгерту
  updateUserRole: async (telegramId, role) => {
    await query(
      "UPDATE users SET role = $1, updated_at = NOW() WHERE telegram_id = $2",
      [role, telegramId],
    );
  },

  // Заказ құру
  createOrder: async (telegramId, leadId) => {
    return transaction(async (client) => {
      const userRes = await client.query(
        "SELECT * FROM users WHERE telegram_id = $1",
        [telegramId],
      );
      const leadRes = await client.query("SELECT * FROM leads WHERE id = $1", [
        leadId,
      ]);
      if (!userRes.rows[0] || !leadRes.rows[0]) throw new Error("Data missing");

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

  // Ақша аудару
  transferMoney: async ({
    fromAccountId,
    toAccountId,
    amount,
    userId,
    comment,
  }) => {
    return transaction(async (client) => {
      await client.query(
        "UPDATE accounts SET balance = balance - $1, updated_at = NOW() WHERE id = $2",
        [amount, fromAccountId],
      );
      await client.query(
        "UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2",
        [amount, toAccountId],
      );

      // Лог
      await client.query(
        `INSERT INTO transactions (user_id, account_id, amount, type, category, comment, created_at) VALUES ($1, $2, $3, 'expense', 'transfer', $4, NOW())`,
        [userId, fromAccountId, amount, `To #${toAccountId}`],
      );
      await client.query(
        `INSERT INTO transactions (user_id, account_id, amount, type, category, comment, created_at) VALUES ($1, $2, $3, 'income', 'transfer', $4, NOW())`,
        [userId, toAccountId, amount, `From #${fromAccountId}`],
      );
    });
  },

  // Есепшоттарды алу
  getAccounts: async () => {
    const res = await query("SELECT * FROM accounts ORDER BY id ASC");
    return res.rows;
  },

  // Лид құру
  createLead: async (userId, leadData) => {
    const { area, wallType, totalWork, totalMat } = leadData;
    const res = await query(
      `INSERT INTO leads (user_id, area, wall_type, total_work_cost, total_mat_cost, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
      [userId, area, wallType, totalWork, totalMat],
    );
    return res.rows[0].id;
  },
};

/**
 * 🔥 INIT DB (MIGRATION SYSTEM)
 */
export const initDB = async () => {
  console.log("⏳ [DB] Verifying schema...");
  try {
    await transaction(async (client) => {
      // 1. Кестелер
      await client.query(
        `CREATE TABLE IF NOT EXISTS users (telegram_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, phone TEXT, role TEXT DEFAULT 'user', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS leads (id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(telegram_id), area NUMERIC, wall_type TEXT, total_work_cost NUMERIC, total_mat_cost NUMERIC, created_at TIMESTAMP DEFAULT NOW())`,
      );

      // Orders + Жаңа бағаналар
      await client.query(`CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY, 
                user_id BIGINT REFERENCES users(telegram_id), 
                lead_id INTEGER REFERENCES leads(id), 
                status TEXT DEFAULT 'new', 
                assignee_id BIGINT, 
                final_price NUMERIC DEFAULT 0, 
                expenses NUMERIC DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(), 
                updated_at TIMESTAMP DEFAULT NOW()
            )`);

      await client.query(
        `CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, name TEXT NOT NULL, balance NUMERIC DEFAULT 0, type TEXT DEFAULT 'cash', updated_at TIMESTAMP DEFAULT NOW())`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value NUMERIC NOT NULL, updated_at TIMESTAMP DEFAULT NOW())`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(telegram_id), account_id INTEGER REFERENCES accounts(id), order_id INTEGER REFERENCES orders(id), amount NUMERIC NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL, comment TEXT, created_at TIMESTAMP DEFAULT NOW())`,
      );

      // 2. Миграциялар (Қауіпсіз қосу)
      const addCol = async (tbl, col, type) => {
        try {
          await client.query(
            `ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS ${col} ${type}`,
          );
        } catch (e) {}
      };
      await addCol("orders", "final_price", "NUMERIC DEFAULT 0");
      await addCol("orders", "expenses", "NUMERIC DEFAULT 0");
      await addCol("orders", "updated_at", "TIMESTAMP DEFAULT NOW()");

      // 3. Default Settings (Сенің CSV файлыңа негізделген)
      const defaults = [
        // Қабырғалар (Штробление) - CSV: 1500-2000 (Бетон), 1000-1200 (Кирпич)
        ["wall_heavy", 1750], // Бетон орташа
        ["wall_medium", 1100], // Кирпич орташа
        ["wall_light", 800], // Газоблок (Болжам)
        ["material_m2", 4000], // Материал

        // Жұмыстар
        ["work_cable", 400], // CSV: 300-500
        ["work_point", 1000], // CSV: 800-1200 (Розетка установка)
        ["work_box", 700], // CSV: 500-700 (Подрозетник)
        ["work_shield", 1750], // CSV: 1500-2000 (Щит модулі)

        // Проценттер
        ["business_percent", 20],
        ["staff_percent", 80],
      ];

      for (const [k, v] of defaults) {
        await client.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
          [k, v],
        );
      }

      // 4. Accounts seeding
      const accs = await client.query("SELECT COUNT(*) FROM accounts");
      if (accs.rows[0].count == 0) {
        await client.query(
          `INSERT INTO accounts (name, type) VALUES ('Kaspi', 'bank'), ('Сейф', 'cash'), ('Фонд', 'saving')`,
        );
      }
    });
    console.log(`✅ [DB] Schema ready.`);
  } catch (e) {
    console.error("💥 [DB FATAL]", e);
    process.exit(1);
  }
};

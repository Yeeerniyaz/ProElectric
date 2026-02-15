/**
 * @file src/server.js
 * @description Backend API для CRM-системы ProElectro.
 * Обеспечивает работу Dashboard, аналитику, управление заказами и пользователями.
 * * @author Yerniyaz & Gemini Senior Architect
 * @version 4.1.0 (Added Manual Orders)
 */

import express from "express";
import session from "express-session";
import crypto from "crypto";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

import { config } from "./config.js";
import { db } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const startServer = () => {
  const app = express();
  app.set("trust proxy", 1);

  // =========================================================================
  // 🛡 MIDDLEWARE LAYER
  // =========================================================================

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: config.server.env === "production" ? false : "*",
      credentials: true,
    }),
  );

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "⛔️ Слишком много запросов." },
  });
  app.use("/api/", limiter);

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    session({
      name: "proelectro_sid",
      secret: config.security.sessionSecret || "dev_secret_key_123",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: config.server.env === "production",
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: "strict",
      },
    }),
  );

  // =========================================================================
  // 🔐 AUTH GUARD
  // =========================================================================

  const requireAuth = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
      return next();
    }
    res.status(401).json({ error: "⛔️ Доступ запрещен. Авторизуйтесь." });
  };

  const requestLogger = (req, res, next) => {
    const user = req.session.isAdmin ? "ADMIN" : "GUEST";
    console.log(`[API] ${req.method} ${req.url} (${user})`);
    next();
  };
  app.use("/api/", requestLogger);

  // =========================================================================
  // 🚪 AUTH ROUTES
  // =========================================================================

  app.post("/api/login", (req, res) => {
    const { password } = req.body;
    const hash = crypto
      .createHash("sha256")
      .update(password || "")
      .digest("hex");

    if (hash === config.security.adminPassHash) {
      req.session.isAdmin = true;
      req.session.loginTime = Date.now();
      return res.json({ success: true, message: "Вход выполнен" });
    }

    setTimeout(() => {
      res.status(403).json({ error: "Неверный пароль" });
    }, 1000);
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("proelectro_sid");
      res.json({ success: true });
    });
  });

  app.get("/api/me", (req, res) => {
    res.json({ isAdmin: !!req.session.isAdmin });
  });

  // =========================================================================
  // 📊 ANALYTICS API
  // =========================================================================

  app.get("/api/analytics/kpi", requireAuth, async (req, res) => {
    try {
      const revenueRes = await db.query(
        `SELECT SUM(l.total_work_cost) as total FROM orders o JOIN leads l ON o.lead_id = l.id WHERE o.status = 'done'`,
      );
      const activeRes = await db.query(
        `SELECT COUNT(*) as count FROM orders WHERE status IN ('new', 'work', 'discuss')`,
      );
      const totalOrdersRes = await db.query(`SELECT COUNT(*) FROM orders`);
      const doneOrdersRes = await db.query(
        `SELECT COUNT(*) FROM orders WHERE status = 'done'`,
      );

      const revenue = parseFloat(revenueRes.rows[0].total || 0);
      const active = parseInt(activeRes.rows[0].count || 0);
      const total = parseInt(totalOrdersRes.rows[0].count || 1);
      const done = parseInt(doneOrdersRes.rows[0].count || 0);
      const conversion = ((done / total) * 100).toFixed(1);
      const avgCheck = done > 0 ? (revenue / done).toFixed(0) : 0;

      res.json({
        revenue,
        activeOrders: active,
        conversion: `${conversion}%`,
        avgCheck: parseFloat(avgCheck),
        totalOrders: total,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/analytics/revenue-chart", requireAuth, async (req, res) => {
    try {
      const chartRes = await db.query(`
                SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, SUM(total_work_cost) as value
                FROM leads WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY date ORDER BY date ASC
            `);
      res.json(chartRes.rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/analytics/status-dist", requireAuth, async (req, res) => {
    try {
      const resData = await db.query(
        `SELECT status, COUNT(*) as count FROM orders GROUP BY status`,
      );
      res.json(resData.rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // =========================================================================
  // 🏗 ORDERS MANAGEMENT (CRUD)
  // =========================================================================

  // Получить список заказов
  app.get("/api/orders", requireAuth, async (req, res) => {
    const { status, page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;

    let queryStr = `
            SELECT o.id, o.status, o.created_at, u.first_name as client_name, u.phone as client_phone,
            l.area, l.total_work_cost, m.first_name as manager_name
            FROM orders o
            JOIN users u ON o.user_id = u.telegram_id
            JOIN leads l ON o.lead_id = l.id
            LEFT JOIN users m ON o.assignee_id = m.telegram_id
            WHERE 1=1
        `;
    const params = [];
    let pIdx = 1;

    if (status && status !== "all") {
      queryStr += ` AND o.status = $${pIdx++}`;
      params.push(status);
    }

    if (search) {
      queryStr += ` AND (u.first_name ILIKE $${pIdx} OR u.phone ILIKE $${pIdx} OR CAST(o.id AS TEXT) LIKE $${pIdx})`;
      params.push(`%${search}%`);
      pIdx++;
    }

    queryStr += ` ORDER BY o.created_at DESC LIMIT $${pIdx++} OFFSET $${pIdx}`;
    params.push(limit, offset);

    try {
      const dataRes = await db.query(queryStr, params);
      const countRes = await db.query("SELECT COUNT(*) FROM orders");
      res.json({
        data: dataRes.rows,
        total: parseInt(countRes.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 🔥 СОЗДАТЬ ЗАКАЗ ВРУЧНУЮ (MANUAL ORDER)
  app.post("/api/orders", requireAuth, async (req, res) => {
    const { clientName, clientPhone, area, wallType, note } = req.body;

    if (!clientName || !area) {
      return res.status(400).json({ error: "Имя и площадь обязательны" });
    }

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      // 1. Поиск или создание юзера
      // Генерируем фейковый telegram_id (отрицательный), чтобы не пересекаться с реальными
      // Или ищем по телефону, если есть
      let userId;
      let userRes;

      if (clientPhone) {
        userRes = await client.query(
          "SELECT telegram_id FROM users WHERE phone = $1",
          [clientPhone],
        );
      }

      if (userRes && userRes.rows.length > 0) {
        userId = userRes.rows[0].telegram_id;
      } else {
        // Создаем нового "офлайн" клиента
        // Генерим ID: берем текущее время (минус), чтобы было уникально
        const fakeId = -Date.now();
        await client.query(
          `INSERT INTO users (telegram_id, first_name, phone, role, created_at) 
                     VALUES ($1, $2, $3, 'client', NOW())`,
          [fakeId, clientName, clientPhone || null],
        );
        userId = fakeId;
      }

      // 2. Расчет стоимости (упрощенный для ручного ввода)
      // Берем цены из базы, чтобы посчитать примерную смету
      const pricesRes = await client.query("SELECT key, value FROM settings");
      const prices = {};
      pricesRes.rows.forEach((r) => (prices[r.key] = parseFloat(r.value)));

      const totalMat = area * (prices.material_m2 || 4000);
      // Примерная формула работы (как в боте)
      const workCost = area * 5000; // Усредненно, если детально не считали

      // 3. Создаем Лид
      const leadRes = await client.query(
        `INSERT INTO leads (user_id, area, wall_type, total_work_cost, total_mat_cost, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
        [userId, area, wallType || "manual", workCost, totalMat],
      );
      const leadId = leadRes.rows[0].id;

      // 4. Создаем Заказ
      await client.query(
        `INSERT INTO orders (user_id, lead_id, status, created_at, updated_at)
                 VALUES ($1, $2, 'new', NOW(), NOW())`,
        [userId, leadId],
      );

      await client.query("COMMIT");
      res.json({ success: true, message: "Заказ создан вручную" });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("Manual Order Error:", e);
      res.status(500).json({ error: "Ошибка при создании заказа" });
    } finally {
      client.release();
    }
  });

  // Обновить заказ (статус/менеджер)
  app.patch("/api/orders/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    const { status, assignee_id } = req.body;

    try {
      let updates = [];
      let values = [];
      let idx = 1;

      if (status) {
        updates.push(`status = $${idx++}`);
        values.push(status);
      }
      if (assignee_id) {
        updates.push(`assignee_id = $${idx++}`);
        values.push(assignee_id);
      }

      if (updates.length === 0) return res.json({ success: true });

      updates.push(`updated_at = NOW()`);
      values.push(id);

      const query = `UPDATE orders SET ${updates.join(", ")} WHERE id = $${idx}`;
      await db.query(query, values);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Удалить заказ (Soft Delete - пометка статусом 'cancel', или Hard delete)
  // Лучше Hard delete для мусора, или Cancel для истории. Сделаем Hard для теста.
  app.delete("/api/orders/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
      // Сначала удаляем ордер, потом лид? Или каскад?
      // Проще просто пометить как отмененный
      await db.query("UPDATE orders SET status = 'cancel' WHERE id = $1", [id]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // =========================================================================
  // 👥 USERS & SETTINGS API
  // =========================================================================

  app.get("/api/users", requireAuth, async (req, res) => {
    try {
      const resData = await db.query(
        `SELECT telegram_id, first_name, username, phone, role, created_at FROM users ORDER BY created_at DESC LIMIT 100`,
      );
      res.json(resData.rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/users/:id/role", requireAuth, async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    if (!["user", "manager", "admin"].includes(role))
      return res.status(400).json({ error: "Role invalid" });
    try {
      await db.query("UPDATE users SET role = $1 WHERE telegram_id = $2", [
        role,
        id,
      ]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/settings", requireAuth, async (req, res) => {
    try {
      const settings = await db.getSettings();
      res.json(settings);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/settings", requireAuth, async (req, res) => {
    const updates = req.body;
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      for (const [key, val] of Object.entries(updates)) {
        const numVal = parseFloat(val);
        if (!isNaN(numVal)) {
          await client.query(
            `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, numVal],
          );
        }
      }
      await client.query("COMMIT");
      res.json({ success: true });
    } catch (e) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // =========================================================================
  // 💰 FINANCIAL ERP API 
  // =========================================================================

  /**
   * Барлық шоттар мен олардың баланстарын алу
   */
  app.get("/api/accounts", requireAuth, async (req, res) => {
    try {
      const accounts = await db.getAccounts();
      res.json(accounts);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Шоттар арасында ақша аудару (Transfer)
   * Тело: { fromId, toId, amount, comment }
   */
  app.post("/api/accounts/transfer", requireAuth, async (req, res) => {
    const { fromId, toId, amount, comment } = req.body;
    const userId = req.session.telegram_id || config.bot.bossUsername; // Кім жасағанын тіркеу

    if (!fromId || !toId || !amount) {
      return res.status(400).json({ error: "Деректер толық емес" });
    }

    try {
      await db.transferMoney({
        fromAccountId: fromId,
        toAccountId: toId,
        amount: parseFloat(amount),
        userId: userId,
        comment: comment || "Ішкі аударым",
      });
      res.json({ success: true, message: "Аударым сәтті орындалды" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Жаңа транзакция қосу (Шығын немесе Кіріс)
   * Тело: { accountId, amount, type, category, comment, orderId }
   */
  app.post("/api/transactions", requireAuth, async (req, res) => {
    const { accountId, amount, type, category, comment, orderId } = req.body;
    const userId = req.session.telegram_id || config.bot.bossUsername;

    try {
      const transactionId = await db.addTransaction({
        userId,
        accountId,
        amount: parseFloat(amount),
        type, // 'income' немесе 'expense'
        category, // 'salary', 'material', 'rent', т.б.
        comment,
        orderId,
      });
      res.json({ success: true, transactionId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Қаржылық аналитика (Диаграммалар үшін)
   */
  app.get("/api/analytics/finance", requireAuth, async (req, res) => {
    try {
      const analytics = await db.getFinancialAnalytics();
      res.json(analytics);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // =========================================================================
  // 🌍 STATIC & START
  // =========================================================================

  app.use(express.static(path.join(__dirname, "../public")));

  app.get("/health", (req, res) =>
    res.json({ status: "ok", uptime: process.uptime() }),
  );
  app.get("/main", (req, res) =>
    res.sendFile(path.join(__dirname, "../public/admin.html")),
  );

  app.listen(config.server.port, "0.0.0.0", () => {
    console.log(`🚀 [SERVER] Running on port ${config.server.port}`);
  });
};

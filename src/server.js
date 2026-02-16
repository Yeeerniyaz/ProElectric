/**
 * @file src/server.js
 * @description REST API для CRM-системы (ProElectro Enterprise).
 * Интегрирована новая финансовая модель и строгий учет расходов.
 * @version 7.5.0 (Full Expenses Support)
 */

import express from "express";
import session from "express-session";
import crypto from "crypto";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

import { config } from "./config.js";
import { db } from "./db.js";
import { OrderService } from "./services/OrderService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const startServer = () => {
  const app = express();

  // =========================================================================
  // 🛡 SECURITY & MIDDLEWARE
  // =========================================================================
  app.set("trust proxy", 1);
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
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 2000,
      standardHeaders: true,
    }),
  );
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Сессии
  app.use(
    session({
      name: "proelectro_sid",
      secret: config.security.sessionSecret || "dev_secret_super_secure",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: config.server.env === "production",
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 дней
        sameSite: "lax",
      },
    }),
  );

  // =========================================================================
  // 🔐 AUTH GUARD
  // =========================================================================
  const requireAuth = (req, res, next) => {
    if (req.session && req.session.isAdmin) return next();
    res.status(401).json({ error: "Access Denied: Unauthorized" });
  };

  // Логгер запросов
  app.use((req, res, next) => {
    if (req.url.startsWith("/api")) {
      console.log(`[API] ${req.method} ${req.url} | User: ${req.session?.isAdmin ? "ADMIN" : "GUEST"}`);
    }
    next();
  });

  // =========================================================================
  // 🔑 AUTH ROUTES
  // =========================================================================
  app.post("/api/login", (req, res) => {
    const { password } = req.body;
    const hash = crypto.createHash("sha256").update(password || "").digest("hex");

    if (hash === config.security.adminPassHash) {
      req.session.isAdmin = true;
      req.session.telegram_id = 999;
      return res.json({ success: true, user: { role: "admin" } });
    }
    res.status(403).json({ error: "Неверный пароль" });
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
  });

  app.get("/api/me", (req, res) =>
    res.json({ isAdmin: !!req.session?.isAdmin }),
  );

  // =========================================================================
  // 📊 ANALYTICS & DASHBOARD
  // =========================================================================
  app.get("/api/analytics/kpi", requireAuth, async (req, res) => {
    try {
      // 1. Финансы (Сумма закрытых сделок и Прибыль)
      const finRes = await db.query(
        `SELECT SUM(final_price) as revenue, SUM(final_profit) as profit FROM orders WHERE status = 'done'`
      );
      
      // 2. Активные заказы
      const activeRes = await db.query(
        `SELECT COUNT(*) as count FROM orders WHERE status IN ('new', 'work', 'discuss')`
      );

      // 3. Всего заказов
      const totalRes = await db.query(`SELECT COUNT(*) as count FROM orders`);
      const doneRes = await db.query(`SELECT COUNT(*) as count FROM orders WHERE status = 'done'`);

      const revenue = parseFloat(finRes.rows[0].revenue || 0);
      const profit = parseFloat(finRes.rows[0].profit || 0);
      const done = parseInt(doneRes.rows[0].count || 0);
      const total = parseInt(totalRes.rows[0].count || 1);

      res.json({
        revenue, // Оборот
        profit,  // Чистая прибыль
        activeOrders: parseInt(activeRes.rows[0].count || 0),
        conversion: ((done / total) * 100).toFixed(1) + "%",
        avgCheck: done > 0 ? Math.round(revenue / done) : 0,
        totalOrders: total,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "KPI Error" });
    }
  });

  // =========================================================================
  // 🏗 ORDER MANAGEMENT
  // =========================================================================

  // GET Orders (Список)
  app.get("/api/orders", requireAuth, async (req, res) => {
    try {
        const { status, limit = 20 } = req.query;
        // 🔥 ВАЖНО: Добавили expenses_sum (сумма расходов по объекту)
        let query = `
            SELECT o.*, 
                   u.first_name as client_name, u.phone as client_phone, u.username as client_user,
                   m.first_name as manager_name,
                   (SELECT COALESCE(SUM(amount), 0) FROM object_expenses WHERE order_id = o.id) as expenses_sum
            FROM orders o
            LEFT JOIN users u ON o.user_id = u.telegram_id
            LEFT JOIN users m ON o.assignee_id = m.telegram_id
            WHERE 1=1
        `;
        const params = [];
        
        if (status && status !== 'all') {
            params.push(status);
            query += ` AND o.status = $${params.length}`;
        }
        
        query += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await db.query(query, params);
        res.json({ data: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
  });

  // POST Manual Order (Создать вручную)
  app.post("/api/orders", requireAuth, async (req, res) => {
    const { area, rooms, wallType, clientName, clientPhone } = req.body;
    try {
        const fakeId = -Date.now(); 
        await db.upsertUser(fakeId, clientName, null, clientPhone);

        const estimate = await OrderService.calculateEstimate(area, rooms, wallType);
        const order = await db.createOrder(fakeId, estimate);
        
        res.json({ success: true, orderId: order.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
  });

  // POST Add Expense (Добавить расход через Админку)
  app.post("/api/orders/:id/expenses", requireAuth, async (req, res) => {
      const { amount, category, comment } = req.body;
      const orderId = req.params.id;
      try {
          await db.addObjectExpense(orderId, amount, category, comment || "Web Admin");
          res.json({ success: true });
      } catch (e) {
          res.status(500).json({ error: e.message });
      }
  });

  // =========================================================================
  // 💰 FINANCE (Accounts & Transactions)
  // =========================================================================
  
  app.get("/api/accounts", requireAuth, async (req, res) => {
    try {
      const accounts = await db.getAccounts();
      res.json(accounts);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Проведение транзакции
  app.post("/api/finance/transaction", requireAuth, async (req, res) => {
    const { accountId, amount, type, category, comment } = req.body;
    try {
        await db.updateBalance({
            accountId,
            amount: parseFloat(amount),
            type,
            category,
            comment,
            userId: req.session.telegram_id
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
  });

  // История транзакций
  app.get("/api/finance/history", requireAuth, async (req, res) => {
      try {
          const result = await db.query(`
            SELECT t.*, a.name as account_name 
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            ORDER BY t.created_at DESC LIMIT 50
          `);
          res.json(result.rows);
      } catch (e) {
          res.status(500).json({ error: e.message });
      }
  });

  // =========================================================================
  // ⚙️ SETTINGS
  // =========================================================================
  app.get("/api/settings", requireAuth, async (req, res) => {
    const settings = await db.getSettings();
    res.json(settings);
  });

  app.post("/api/settings", requireAuth, async (req, res) => {
    try {
      const { key, value } = req.body;
      await db.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) 
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, parseFloat(value)]
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // =========================================================================
  // 🌍 SPA FALLBACK
  // =========================================================================
  app.use(express.static(path.join(__dirname, "../public")));
  app.get("*path", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/admin.html"));
  });

  app.listen(config.server.port, "0.0.0.0", () => {
    console.log(`🚀 [SERVER] ProElectro CRM running on port ${config.server.port}`);
  });
};
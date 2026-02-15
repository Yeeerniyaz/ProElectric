/**
 * @file src/server.js
 * @description REST API для CRM-системы.
 * Работает через Service Layer и безопасные транзакции.
 * @version 6.2.0 (Manager Filter Added)
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
  app.set("trust proxy", 1);

  // =========================================================================
  // 🛡 MIDDLEWARE & SECURITY
  // =========================================================================

  app.use(
    helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }),
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
      max: 1000,
      standardHeaders: true,
      message: { error: "⛔️ Too many requests" },
    }),
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    session({
      name: "proelectro_sid",
      secret: config.security.sessionSecret || "dev_secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: config.server.env === "production",
        maxAge: 24 * 60 * 60 * 1000, // 24 часа
        sameSite: "strict",
      },
    }),
  );

  // =========================================================================
  // 🔐 AUTHENTICATION
  // =========================================================================

  const requireAuth = (req, res, next) => {
    if (req.session && req.session.isAdmin) return next();
    res.status(401).json({ error: "Unauthorized" });
  };

  const requestLogger = (req, res, next) => {
    if (req.url.startsWith("/api")) {
      console.log(
        `[API] ${req.method} ${req.url} | User: ${req.session.isAdmin ? "ADMIN" : "GUEST"}`,
      );
    }
    next();
  };
  app.use(requestLogger);

  // Login
  app.post("/api/login", (req, res) => {
    const { password } = req.body;
    const hash = crypto
      .createHash("sha256")
      .update(password || "")
      .digest("hex");

    if (hash === config.security.adminPassHash) {
      req.session.isAdmin = true;
      // В будущем здесь можно сохранять telegram_id менеджера, если вход через Telegram Login
      return res.json({ success: true });
    }
    res.status(403).json({ error: "Invalid password" });
  });

  // Logout
  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
  });

  app.get("/api/me", (req, res) =>
    res.json({ isAdmin: !!req.session.isAdmin }),
  );

  // =========================================================================
  // 📊 ANALYTICS & DASHBOARD
  // =========================================================================

  app.get("/api/analytics/kpi", requireAuth, async (req, res) => {
    try {
      const [revRes, activeRes, totalRes, doneRes] = await Promise.all([
        db.query(
          `SELECT SUM(l.total_work_cost) as total FROM orders o JOIN leads l ON o.lead_id = l.id WHERE o.status = 'done'`,
        ),
        db.query(
          `SELECT COUNT(*) as count FROM orders WHERE status IN ('new', 'work', 'discuss')`,
        ),
        db.query(`SELECT COUNT(*) as count FROM orders`),
        db.query(`SELECT COUNT(*) as count FROM orders WHERE status = 'done'`),
      ]);

      const revenue = parseFloat(revRes.rows[0].total || 0);
      const done = parseInt(doneRes.rows[0].count || 0);
      const total = parseInt(totalRes.rows[0].count || 1);

      res.json({
        revenue,
        activeOrders: parseInt(activeRes.rows[0].count || 0),
        conversion: ((done / total) * 100).toFixed(1) + "%",
        avgCheck: done > 0 ? Math.round(revenue / done) : 0,
        totalOrders: total,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // =========================================================================
  // 🏗 ORDER MANAGEMENT
  // =========================================================================

  // Получить список заказов (с фильтрацией)
  app.get("/api/orders", requireAuth, async (req, res) => {
    // 🔥 assignee_id параметрі қосылды
    const { status, page = 1, limit = 20, search, assignee_id } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    let query = `
      SELECT o.id, o.status, o.created_at, 
             u.first_name as client_name, u.phone as client_phone,
             l.area, l.total_work_cost, 
             m.first_name as manager_name
      FROM orders o
      JOIN users u ON o.user_id = u.telegram_id
      JOIN leads l ON o.lead_id = l.id
      LEFT JOIN users m ON o.assignee_id = m.telegram_id
      WHERE 1=1
    `;

    if (status && status !== "all") {
      params.push(status);
      query += ` AND o.status = $${params.length}`;
    }

    // 🔥 Егер менеджер ID келсе, тек соның заказдырын сүземіз
    if (assignee_id) {
      params.push(assignee_id);
      query += ` AND o.assignee_id = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (u.first_name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`;
    }

    query += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    try {
      const data = await db.query(query, [...params, limit, offset]);
      const count = await db.query("SELECT COUNT(*) FROM orders");
      res.json({
        data: data.rows,
        total: parseInt(count.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Создать заказ ВРУЧНУЮ
  app.post("/api/orders", requireAuth, async (req, res) => {
    const { clientName, clientPhone, area, wallType } = req.body;

    try {
      await db.transaction(async (client) => {
        // 1. Создаем или находим юзера (Фейковый ID для ручных заказов)
        const fakeId = -Date.now();
        await client.query(
          `INSERT INTO users (telegram_id, first_name, phone, role) VALUES ($1, $2, $3, 'client')`,
          [fakeId, clientName, clientPhone],
        );

        // 2. Считаем смету через Сервис (но цены берем простые)
        const pricesRes = await client.query("SELECT key, value FROM settings");
        const prices = {};
        pricesRes.rows.forEach((r) => (prices[r.key] = parseFloat(r.value)));

        const totalWork = area * 5000;
        const totalMat = area * (prices.material_m2 || 4000);

        // 3. Лид
        const leadRes = await client.query(
          `INSERT INTO leads (user_id, area, wall_type, total_work_cost, total_mat_cost) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [fakeId, area, wallType || "manual", totalWork, totalMat],
        );

        // 4. Заказ
        await client.query(
          `INSERT INTO orders (user_id, lead_id, status) VALUES ($1, $2, 'new')`,
          [fakeId, leadRes.rows[0].id],
        );
      });

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Обновить статус или менеджера
  app.patch("/api/orders/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    const { status, assignee_id } = req.body;

    try {
      if (status) {
        await OrderService.updateStatus(
          id,
          status,
          req.session.telegram_id || 0,
        );
      }
      if (assignee_id) {
        await db.query(
          `UPDATE orders SET assignee_id = $1, updated_at = NOW() WHERE id = $2`,
          [assignee_id, id],
        );
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // =========================================================================
  // 💰 FINANCE ERP
  // =========================================================================

  app.get("/api/accounts", requireAuth, async (req, res) => {
    try {
      const accounts = await db.getAccounts();
      res.json(accounts);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/accounts/transfer", requireAuth, async (req, res) => {
    const { fromId, toId, amount, comment } = req.body;
    try {
      await db.transferMoney({
        fromAccountId: fromId,
        toAccountId: toId,
        amount: parseFloat(amount),
        userId: req.session.telegram_id || 0,
        comment: comment || "Web Transfer",
      });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/transactions", requireAuth, async (req, res) => {
    try {
      const { accountId, amount, type, category, comment, orderId } = req.body;
      await db.addTransaction({
        userId: req.session.telegram_id || 0,
        accountId,
        amount: parseFloat(amount),
        type,
        category,
        comment,
        orderId,
      });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/analytics/finance", requireAuth, async (req, res) => {
    try {
      const data = await db.getFinancialAnalytics();
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // =========================================================================
  // ⚙️ SETTINGS & USERS
  // =========================================================================

  app.get("/api/settings", requireAuth, async (req, res) => {
    const settings = await db.getSettings();
    res.json(settings);
  });

  app.post("/api/settings", requireAuth, async (req, res) => {
    try {
      await db.transaction(async (client) => {
        for (const [key, val] of Object.entries(req.body)) {
          await client.query(
            `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) 
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, parseFloat(val)],
          );
        }
      });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Получить пользователей (Для CRM)
  app.get("/api/users", requireAuth, async (req, res) => {
    try {
      const users = await db.query(
        "SELECT telegram_id, first_name, username, phone, role, created_at FROM users ORDER BY created_at DESC",
      );
      res.json(users.rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Смена роли пользователя
  app.post("/api/users/:id/role", requireAuth, async (req, res) => {
    try {
      await db.query("UPDATE users SET role = $1 WHERE telegram_id = $2", [
        req.body.role,
        req.params.id,
      ]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // =========================================================================
  // 🌍 SERVER START
  // =========================================================================

  app.use(express.static(path.join(__dirname, "../public")));

  app.get("*path", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/admin.html"));
  });

  app.listen(config.server.port, "0.0.0.0", () => {
    console.log(`🚀 [SERVER] Running on port ${config.server.port}`);
  });
};

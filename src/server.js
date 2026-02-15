/**
 * @file src/server.js
 * @description REST API для CRM-системы (ProElectro Enterprise).
 * Реализован Service Layer, безопасные транзакции и расширенная валидация.
 * @version 6.5.0 (Financial Patch Update)
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
      max: 2000, // Лимитті сәл көтердік (Front-end polling үшін)
      standardHeaders: true,
    }),
  );
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    session({
      name: "proelectro_sid",
      secret: config.security.sessionSecret || "dev_secret_key_v1",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: config.server.env === "production",
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 күн
        sameSite: "strict",
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

  const requestLogger = (req, res, next) => {
    if (req.url.startsWith("/api")) {
      console.log(
        `[API] ${req.method} ${req.url} | User: ${req.session.isAdmin ? "ADMIN" : "GUEST"}`,
      );
    }
    next();
  };
  app.use(requestLogger);

  // =========================================================================
  // 🔑 AUTH ROUTES
  // =========================================================================
  app.post("/api/login", (req, res) => {
    const { password } = req.body;
    // SHA-256 Hash тексеру
    const hash = crypto
      .createHash("sha256")
      .update(password || "")
      .digest("hex");

    if (hash === config.security.adminPassHash) {
      req.session.isAdmin = true;
      req.session.telegram_id = 999; // System Admin ID
      return res.json({ success: true, user: { role: "admin" } });
    }
    res.status(403).json({ error: "Invalid credentials" });
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
  });

  app.get("/api/me", (req, res) =>
    res.json({ isAdmin: !!req.session.isAdmin }),
  );

  // =========================================================================
  // 📊 ANALYTICS
  // =========================================================================
  app.get("/api/analytics/kpi", requireAuth, async (req, res) => {
    try {
      const [revRes, activeRes, totalRes, doneRes] = await Promise.all([
        db.query(
          `SELECT SUM(total_work_cost) as total FROM leads l JOIN orders o ON o.lead_id = l.id WHERE o.status = 'done'`,
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
  // 🏗 ORDER MANAGEMENT (CORE)
  // =========================================================================

  // Список заказов + Фильтры
  app.get("/api/orders", requireAuth, async (req, res) => {
    const { status, page = 1, limit = 20, search, assignee_id } = req.query;
    const offset = (page - 1) * limit;
    const params = [];

    // 🔥 ЖАҢА: final_price және expenses өрістерін аламыз
    let query = `
      SELECT o.id, o.status, o.created_at, o.final_price, o.expenses,
             u.first_name as client_name, u.phone as client_phone,
             l.area, l.total_work_cost, 
             m.first_name as manager_name, m.telegram_id as assignee_id
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

  // Создание заказа (Ручное)
  app.post("/api/orders", requireAuth, async (req, res) => {
    const { clientName, clientPhone, area, wallType } = req.body;
    try {
      await db.transaction(async (client) => {
        const fakeId = -Date.now(); // Fake ID for Manual User
        await client.query(
          `INSERT INTO users (telegram_id, first_name, phone, role) VALUES ($1, $2, $3, 'client')`,
          [fakeId, clientName, clientPhone],
        );

        const prices = await db.getSettings();
        const totalWork = area * 5000; // Simplified
        const totalMat = area * (prices.material_m2 || 4000);

        const leadRes = await client.query(
          `INSERT INTO leads (user_id, area, wall_type, total_work_cost, total_mat_cost) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [fakeId, area, wallType || "manual", totalWork, totalMat],
        );

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

  // 🔥 UPDATE ORDER (PATCH) - Бұл жерде бағаны да өзгертеміз
  app.patch("/api/orders/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    const { status, assignee_id, final_price, expenses } = req.body;

    try {
      const updates = [];
      const values = [];
      let idx = 1;

      // 1. Статус өзгерту (Service арқылы - хабарлама жіберу үшін)
      if (status) {
        await OrderService.updateStatus(id, status, req.session.telegram_id);
      }

      // 2. Басқа өрістерді SQL арқылы жаңарту
      if (assignee_id) {
        updates.push(`assignee_id = $${idx++}`);
        values.push(assignee_id);
      }
      if (final_price !== undefined && final_price !== "") {
        updates.push(`final_price = $${idx++}`);
        values.push(parseFloat(final_price));
      }
      if (expenses !== undefined && expenses !== "") {
        updates.push(`expenses = $${idx++}`);
        values.push(parseFloat(expenses));
      }

      if (updates.length > 0) {
        values.push(id);
        await db.query(
          `UPDATE orders SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${idx}`,
          values,
        );
      }

      res.json({ success: true });
    } catch (e) {
      console.error(e);
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
        userId: req.session.telegram_id,
        comment: comment || "Web Transfer",
      });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // =========================================================================
  // ⚙️ SYSTEM (Settings & Users)
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

  // CRM Users List
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
  // 🌍 SPA FALLBACK
  // =========================================================================
  app.use(express.static(path.join(__dirname, "../public")));

  app.get("*path", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/admin.html"));
  });

  app.listen(config.server.port, "0.0.0.0", () => {
    console.log(`🚀 [SERVER] Started on port ${config.server.port}`);
  });
};

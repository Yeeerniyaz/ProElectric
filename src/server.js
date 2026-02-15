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

// Получаем __dirname (для ES Module)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const startServer = () => {
  const app = express();

  // ============================================================
  // 🛡 MIDDLEWARE (БЕЗОПАСНОСТЬ И НАСТРОЙКИ)
  // ============================================================

  // 1. Helmet: Защита заголовков. Отключаем CSP для работы инлайн-скриптов в админке.
  app.use(helmet({ contentSecurityPolicy: false }));

  // 2. Rate Limit: Защита от брутфорса паролей (100 запросов за 15 мин)
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // 3. Парсинг данных (JSON и формы)
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cors()); // Полезно, если фронт будет отдельно

  // 4. Сессии (храним состояние входа админа)
  app.use(
    session({
      secret: config.security.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: config.server.env === "production", // В проде только HTTPS
        maxAge: 24 * 60 * 60 * 1000, // Сессия на 24 часа
      },
    }),
  );

  // ============================================================
  // 🔐 AUTH GUARD (ПРОВЕРКА ДОСТУПА)
  // ============================================================
  const checkAuth = (req, res, next) => {
    if (req.session.isAdmin) {
      return next();
    }
    res
      .status(401)
      .json({ error: "⛔️ Доступ запрещен. Требуется авторизация." });
  };

  // ============================================================
  // 🚪 AUTH ROUTES (ВХОД / ВЫХОД)
  // ============================================================

  // Логин
  app.post("/api/login", (req, res) => {
    const { password } = req.body;
    // Хешируем присланный пароль и сверяем с конфигом
    const hash = crypto
      .createHash("sha256")
      .update(password || "")
      .digest("hex");

    if (hash === config.security.adminPassHash) {
      req.session.isAdmin = true;
      console.log(`🔑 [SERVER] Админ вошел с IP: ${req.ip}`);
      return res.json({ success: true });
    }

    console.warn(`⚠️ [SERVER] Неверный пароль с IP: ${req.ip}`);
    res.status(403).json({ error: "Неверный пароль" });
  });

  // Выход
  app.post("/api/logout", (req, res) => {
    req.session.destroy();
    res.json({ success: true });
  });

  // Проверка статуса (для фронтенда)
  app.get("/api/me", (req, res) => {
    res.json({ isAdmin: !!req.session.isAdmin });
  });

  // ============================================================
  // 📊 DATA API (БИЗНЕС-ЛОГИКА)
  // ============================================================

  // Получить текущие настройки (цены)
  app.get("/api/settings", checkAuth, async (req, res) => {
    try {
      const settings = await db.getSettings();
      res.json(settings);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Обновить цены (безопасная транзакция)
  app.post("/api/settings", checkAuth, async (req, res) => {
    const updates = req.body; // { wall_light: 5000, ... }

    try {
      const client = await db.getClient();
      await client.query("BEGIN");

      for (const [key, value] of Object.entries(updates)) {
        const numValue = parseFloat(value);
        if (!isNaN(numValue)) {
          // Upsert: Обновляем или вставляем новую настройку
          await client.query(
            `INSERT INTO settings (key, value) VALUES ($1, $2)
                         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [key, numValue],
          );
        }
      }

      await client.query("COMMIT");
      client.release();

      console.log("💰 [SERVER] Цены обновлены через админку");
      res.json({ success: true });
    } catch (e) {
      console.error("💥 [SERVER ERROR]", e);
      res.status(500).json({ error: "Ошибка обновления базы" });
    }
  });

  // Получить статистику для дашборда
  app.get("/api/stats", checkAuth, async (req, res) => {
    try {
      // Воронка продаж
      const statsRes = await db.query(`
                SELECT status, COUNT(*) as count, SUM(l.total_work_cost) as money 
                FROM orders o
                JOIN leads l ON o.lead_id = l.id
                GROUP BY status
            `);

      // Последние 10 заказов
      const recentRes = await db.query(`
                SELECT o.id, o.status, u.first_name, l.total_work_cost, o.created_at
                FROM orders o
                JOIN users u ON o.user_id = u.id
                JOIN leads l ON o.lead_id = l.id
                ORDER BY o.created_at DESC LIMIT 10
            `);

      res.json({
        funnel: statsRes.rows,
        recent: recentRes.rows,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================================
  // 🌍 STATIC FILES (ФРОНТЕНД)
  // ============================================================

  // Раздаем админку из папки public
  app.use(express.static(path.join(__dirname, "../public")));

  // Healthcheck для Docker
  app.get("/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // SPA Fallback (любой другой запрос ведет на admin.html)
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/admin.html"));
  });

  // ============================================================
  // 🚀 START
  // ============================================================
  app.listen(config.server.port, "0.0.0.0", () => {
    console.log(
      `🌐 [SERVER] Dashboard доступен на порту ${config.server.port}`,
    );
  });
};

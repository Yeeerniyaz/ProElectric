/**
 * @file src/app.js
 * @description Конфигурация Express приложения (API Gateway & CRM Backend).
 * Отвечает за обработку HTTP-запросов, API для админ-панели и раздачу статики.
 * Включает новые Enterprise-фичи: Broadcast, FSM Data Sync, Advanced Analytics.
 *
 * @module Application
 * @version 8.0.0 (Enterprise Backend Edition)
 * @author ProElectric Team
 */

import express from "express";
import session from "express-session";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

// --- CORE IMPORTS ---
import { config } from "./config.js";
import * as db from "./database/index.js";
import { bot } from "./bot.js"; // Импортируем бота для рассылок (Broadcast)

// --- SERVICES (Domain Logic) ---
import { UserService } from "./services/UserService.js";
import { OrderService } from "./services/OrderService.js";

// --- INITIALIZATION ---
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// 1. 🛡 SECURITY & MIDDLEWARE
// =============================================================================

// 1.1. HTTP Security Headers
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

// 1.2. CORS Policy
app.use(
  cors({
    origin: config.server.corsOrigin || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
  }),
);

// 1.3. Request Rate Limiting (DDoS Protection)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500, // Чуть увеличили лимит для активной работы в CRM
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "⛔ Слишком много запросов. Подождите пару минут." },
});
app.use("/api/", apiLimiter);

// 1.4. Body Parsing
app.use(express.json({ limit: "50mb" })); // Увеличили лимит для передачи картинок в рассылке
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// 1.5. Session Management
app.use(
  session({
    name: "proelectric.sid",
    secret: process.env.SESSION_SECRET || "enterprise_super_secret_key_2026",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 часа сессии
      sameSite: "lax",
    },
  }),
);

// 1.6. Static Files
app.use(express.static(path.join(__dirname, "../public")));

// =============================================================================
// 2. 🔐 AUTHENTICATION & ACCESS CONTROL
// =============================================================================

/**
 * Middleware: Проверка прав администратора
 */
const requireAdmin = (req, res, next) => {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.status(401).json({ error: "⛔ Доступ запрещен. Авторизуйтесь." });
};

// --- AUTH ROUTES ---

// Логин (Теперь используем связку Логин + Пароль из .env)
app.post("/api/auth/login", (req, res) => {
  const { login, password } = req.body;

  const validLogin = process.env.ADMIN_LOGIN || "admin";
  const validPass = process.env.ADMIN_PASS || "Qazplm01";

  if (login === validLogin && password === validPass) {
    req.session.isAdmin = true;
    req.session.loginTime = new Date();

    console.log(`[AUTH] Admin logged in successfully from IP: ${req.ip}`);
    return res.json({ success: true, message: "Welcome back, Boss!" });
  }

  console.warn(
    `[AUTH] Failed login attempt from IP: ${req.ip} | Login: ${login}`,
  );
  return res.status(401).json({ error: "Неверный логин или пароль" });
});

// Логаут
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Ошибка при выходе" });
    res.clearCookie("proelectric.sid");
    res.json({ success: true });
  });
});

// Проверка сессии (для фронтенда)
app.get("/api/auth/check", (req, res) => {
  res.json({
    authenticated: !!(req.session && req.session.isAdmin),
    serverTime: new Date(),
  });
});

// =============================================================================
// 3. 📊 API ROUTES (BUSINESS LOGIC)
// =============================================================================

/**
 * GET /api/dashboard/stats
 * Сводная статистика (Выручка, Лиды, Воронка)
 */
app.get("/api/dashboard/stats", requireAdmin, async (req, res) => {
  try {
    const [globalStats, funnelStats] = await Promise.all([
      UserService.getDashboardStats(),
      OrderService.getAdminStats(),
    ]);

    res.json({
      overview: {
        totalRevenue: globalStats.totalRevenue,
        totalUsers: globalStats.totalUsers,
        activeToday: globalStats.activeUsers24h,
        pendingOrders: funnelStats.metrics.activeCount,
      },
      funnel: funnelStats.breakdown,
      financials: funnelStats.metrics,
    });
  } catch (error) {
    console.error("[API] Stats Error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/orders
 * Список заказов (теперь вытаскиваем JSONB поля: адрес, коммент)
 */
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status || null;

    let query = `
      SELECT o.*, u.first_name as client_name, u.phone as client_phone 
      FROM orders o
      JOIN users u ON o.user_id = u.telegram_id
    `;
    const params = [];

    if (status && status !== "all") {
      query += " WHERE o.status = $1";
      params.push(status);
    }

    query += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/orders/:id/status
 * Изменение статуса заказа
 */
app.patch("/api/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    await OrderService.updateOrderStatus(id, status);
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/orders/:id/details
 * 🔥 СОХРАНЕНИЕ МЕТАДАННЫХ (Адрес, Комментарий, Причина отказа)
 */
app.patch("/api/orders/:id/details", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { key, value } = req.body; // key может быть 'address', 'comment', 'cancel_reason'

    if (!key)
      return res.status(400).json({ error: "Ключ обновления не передан" });

    const updatedDetails = await OrderService.updateOrderDetails(
      id,
      key,
      value,
    );
    res.json({ success: true, details: updatedDetails });
  } catch (error) {
    console.error("[API] Update Details Error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/settings
 * Получение текущих настроек цен
 */
app.get("/api/settings", requireAdmin, async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/settings
 * Обновление цены
 */
app.post("/api/settings", requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ error: "Missing 'key' or 'value'" });
    }

    const sql = `
      INSERT INTO settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET 
        value = EXCLUDED.value,
        updated_at = NOW()
      RETURNING *
    `;
    const result = await db.query(sql, [key, value]);
    res.json({ success: true, setting: result.rows[0] });
  } catch (error) {
    console.error("[API] Settings Update Error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/users
 * Список пользователей
 */
app.get("/api/users", requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const users = await UserService.getAllUsers(limit, offset);
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/users/role
 * Изменение роли
 */
app.post("/api/users/role", requireAdmin, async (req, res) => {
  try {
    const { userId, role } = req.body;
    const updatedUser = await UserService.changeUserRole(0, userId, role);
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// =============================================================================
// 4. 🚀 BROADCAST SYSTEM (РАССЫЛКА)
// =============================================================================

/**
 * POST /api/broadcast
 * 🔥 Массовая рассылка сообщений пользователям бота
 */
app.post("/api/broadcast", requireAdmin, async (req, res) => {
  try {
    const { text, imageUrl, targetRole } = req.body; // targetRole: 'all', 'user', 'manager', etc.

    if (!text)
      return res.status(400).json({ error: "Текст рассылки обязателен" });

    // 1. Получаем целевую аудиторию
    let query = `SELECT telegram_id FROM users`;
    let params = [];

    if (targetRole && targetRole !== "all") {
      query += ` WHERE role = $1`;
      params.push(targetRole);
    }

    const result = await db.query(query, params);
    const users = result.rows;

    if (users.length === 0) {
      return res.json({
        success: true,
        delivered: 0,
        message: "Нет пользователей для рассылки",
      });
    }

    let successCount = 0;
    let failCount = 0;

    // 2. Рассылаем сообщения (в фоне, чтобы не блокировать ответ админу, если юзеров много)
    // Оборачиваем в асинхронную функцию
    const sendMassMessage = async () => {
      for (const user of users) {
        try {
          if (imageUrl) {
            await bot.telegram.sendPhoto(user.telegram_id, imageUrl, {
              caption: text,
              parse_mode: "HTML",
            });
          } else {
            await bot.telegram.sendMessage(user.telegram_id, text, {
              parse_mode: "HTML",
            });
          }
          successCount++;

          // Пауза 50ms (Antispam Telegram Limit - 30 messages/sec)
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch (e) {
          console.warn(
            `[Broadcast] Failed to send to ${user.telegram_id}: ${e.message}`,
          );
          failCount++;
        }
      }
      console.log(
        `[Broadcast] Finished. Success: ${successCount}, Failed: ${failCount}`,
      );
    };

    // Запускаем процесс рассылки, не дожидаясь его полного окончания
    sendMassMessage();

    // Сразу отвечаем админу, что процесс запущен
    res.json({
      success: true,
      message: `Рассылка запущена для ${users.length} пользователей.`,
      estimatedTimeSec: Math.ceil(users.length * 0.05),
    });
  } catch (error) {
    console.error("[API] Broadcast Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 5. 🚑 ERROR HANDLING
// =============================================================================

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("🔥 [Express Error]:", err);
  res.status(500).json({
    error: "Internal Server Error",
    details: process.env.NODE_ENV === "production" ? null : err.message,
  });
});

export default app;

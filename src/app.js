/**
 * @file src/app.js
 * @description Конфигурация Express приложения (API Gateway).
 * Отвечает за обработку HTTP-запросов, API для админ-панели и раздачу статики.
 * Не запускает сервер (listen), а только экспортирует настроенный инстанс.
 *
 * @module Application
 * @version 6.2.0 (Senior Architect Edition)
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
// Отключаем CSP по умолчанию, чтобы не ломать инлайн-скрипты простой админки
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

// 1.2. CORS Policy
// Разрешаем запросы только с доверенных источников (в продакшене)
app.use(
  cors({
    origin: config.server.corsOrigin || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
  }),
);

// 1.3. Request Rate Limiting (DDoS Protection)
// Ограничиваем API: 300 запросов за 15 минут с одного IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "⛔ Too many requests, please try again later." },
});
app.use("/api/", apiLimiter);

// 1.4. Body Parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// 1.5. Session Management
// В продакшене для Highload обязательно использовать RedisStore (connect-redis)
// Здесь используем MemoryStore для простоты деплоя на одном инстансе
app.use(
  session({
    name: "proelectric.sid",
    secret: config.server.sessionSecret || "dev_super_secret_key_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: config.system.isProduction, // Требует HTTPS в продакшене
      httpOnly: true, // Защита от XSS
      maxAge: 24 * 60 * 60 * 1000, // 24 часа
      sameSite: "lax",
    },
  }),
);

// 1.6. Static Files
// Раздаем админку из папки public
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
  return res.status(401).json({ error: "⛔ Unauthorized access" });
};

// --- AUTH ROUTES ---

// Логин
app.post("/api/auth/login", (req, res) => {
  const { password } = req.body;

  // В реальном проекте хэшируем пароль и сравниваем (bcrypt)
  // Здесь берем пароль админа из переменной окружения
  if (password === config.admin.password) {
    req.session.isAdmin = true;
    req.session.loginTime = new Date();

    console.log(`[AUTH] Admin logged in from IP: ${req.ip}`);
    return res.json({ success: true, message: "Welcome back, Chief!" });
  }

  console.warn(`[AUTH] Failed login attempt from IP: ${req.ip}`);
  return res.status(401).json({ error: "Invalid password" });
});

// Логаут
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Logout failed" });
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
 * Сводная статистика для дашборда (P&L, Active Users, Orders)
 */
app.get("/api/dashboard/stats", requireAdmin, async (req, res) => {
  try {
    // Параллельный запрос к сервисам для скорости
    const [globalStats, funnelStats] = await Promise.all([
      UserService.getDashboardStats(),
      OrderService.getAdminStats(),
    ]);

    // Формируем единый объект ответа
    const response = {
      overview: {
        totalRevenue: globalStats.totalRevenue,
        totalUsers: globalStats.totalUsers,
        activeToday: globalStats.activeUsers24h,
        pendingOrders: funnelStats.metrics.activeCount, // В работе + новые
      },
      funnel: funnelStats.breakdown, // Воронка по статусам
      financials: funnelStats.metrics, // Потенциальная и реальная выручка
    };

    res.json(response);
  } catch (error) {
    console.error("[API] Stats Error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/orders
 * Список заказов с пагинацией и фильтрацией
 */
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status || null;

    let query = "SELECT * FROM orders";
    const params = [];

    if (status) {
      query += " WHERE status = $1";
      params.push(status);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/settings
 * Получение текущих настроек цен (Dynamic Pricing)
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
 * Обновление цены или параметра
 */
app.post("/api/settings", requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;

    // Валидация
    if (!key || value === undefined) {
      return res.status(400).json({ error: "Missing 'key' or 'value'" });
    }

    // Upsert в БД
    const sql = `
      INSERT INTO settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET 
        value = EXCLUDED.value,
        updated_at = NOW()
      RETURNING *
    `;

    const result = await db.query(sql, [key, value]);

    console.log(`[SETTINGS] Updated '${key}' to '${value}' by Admin`);
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
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const users = await UserService.getAllUsers(limit, offset);
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/users/role
 * Изменение роли пользователя
 */
app.post("/api/users/role", requireAdmin, async (req, res) => {
  try {
    const { userId, role } = req.body;
    // Используем фиктивный ID администратора (0), так как запрос идет из Web UI
    const updatedUser = await UserService.changeUserRole(0, userId, role);
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// =============================================================================
// 4. 🚑 ERROR HANDLING
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
    details: config.system.isProduction ? null : err.message,
  });
});

// Экспортируем приложение без запуска (listen будет в server.js)
export default app;

/**
 * @file src/app.js
 * @description Конфигурация Express приложения (API Gateway & ERP Backend v9.1.0).
 * Отвечает за обработку HTTP-запросов, маршрутизацию CRM и интеграцию с OrderService.
 * Поддерживает динамический прайс-лист и текстовую спецификацию (BOM).
 *
 * @module Application
 * @version 9.1.0 (Enterprise ERP Edition)
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
import { bot } from "./bot.js"; 

// --- SERVICES (Domain Logic) ---
import { UserService } from "./services/UserService.js";
import { OrderService } from "./services/OrderService.js";

// --- INITIALIZATION ---
const app = express();
app.set("trust proxy", 1);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// 1. 🛡 SECURITY & MIDDLEWARE
// =============================================================================

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(
  cors({
    origin: config.server.corsOrigin || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
  })
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000, 
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "⛔ Слишком много запросов. Подождите пару минут." },
});
app.use("/api/", apiLimiter);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use(
  session({
    name: "proelectric.sid",
    secret: config.server.sessionSecret || "enterprise_super_secret_key_v9",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: config.system.isProduction,
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 часа
      sameSite: "lax",
    },
  })
);

app.use(express.static(path.join(__dirname, "../public")));

// =============================================================================
// 2. 🔐 AUTHENTICATION & ACCESS CONTROL
// =============================================================================

const requireAdmin = (req, res, next) => {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.status(401).json({ error: "⛔ Доступ запрещен. Авторизуйтесь." });
};

app.get("/", (req, res) => {
  res.redirect("/admin.html");
});

app.post("/api/auth/login", (req, res) => {
  const { login, password } = req.body;
  const validLogin = process.env.ADMIN_LOGIN || "admin";
  const validPass = config.admin.password || "admin123";

  if (login === validLogin && password === validPass) {
    req.session.isAdmin = true;
    req.session.loginTime = new Date();
    console.log(`[AUTH] Admin logged in successfully from IP: ${req.ip}`);
    return res.json({ success: true, message: "Welcome back, Boss!" });
  }

  console.warn(`[AUTH] Failed login attempt from IP: ${req.ip} | Login: ${login}`);
  return res.status(401).json({ error: "Неверный логин или пароль" });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Ошибка при выходе" });
    res.clearCookie("proelectric.sid");
    res.json({ success: true });
  });
});

app.get("/api/auth/check", (req, res) => {
  res.json({
    authenticated: !!(req.session && req.session.isAdmin),
    serverTime: new Date(),
  });
});

// =============================================================================
// 3. 📊 ERP API ROUTES (BUSINESS LOGIC)
// =============================================================================

app.get("/api/dashboard/stats", requireAdmin, async (req, res) => {
  try {
    const [globalStats, funnelStats] = await Promise.all([
      UserService.getDashboardStats(),
      OrderService.getAdminStats(),
    ]);

    res.json({
      overview: {
        totalRevenue: funnelStats.metrics.totalRevenue,
        totalNetProfit: funnelStats.metrics.totalNetProfit, 
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

// =============================================================================
// 📦 4. ORDER MANAGEMENT (ORDERS API)
// =============================================================================

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

app.post("/api/orders", requireAdmin, async (req, res) => {
  try {
    const { clientName, clientPhone, area = 50, rooms = 2, wallType = 'wall_concrete' } = req.body;

    if (!clientName || !clientPhone) {
      return res.status(400).json({ error: "Имя и телефон обязательны" });
    }

    let userId;
    const existingUser = await db.query("SELECT telegram_id FROM users WHERE phone = $1 LIMIT 1", [clientPhone]);
    
    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].telegram_id;
    } else {
      userId = -Date.now(); 
      await db.query(
        "INSERT INTO users (telegram_id, first_name, username, phone, role) VALUES ($1, $2, $3, $4, 'user')",
        [userId, clientName, 'crm_lead', clientPhone]
      );
    }

    const estimate = await OrderService.calculateComplexEstimate(Number(area), Number(rooms), wallType);
    const order = await OrderService.createOrder(userId, estimate);

    res.json({ success: true, order });
  } catch (error) {
    console.error("[API] Create Manual Order Error:", error);
    res.status(500).json({ error: error.message });
  }
});

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

app.patch("/api/orders/:id/details", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: "Ключ обновления не передан" });

    // Этот метод теперь используется для обновления bom_text, comment и address
    const updatedDetails = await OrderService.updateOrderDetails(id, key, value);
    res.json({ success: true, details: updatedDetails });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 💸 5. FINANCIAL MANAGEMENT (ERP MODULE)
// =============================================================================

app.patch("/api/orders/:id/finance/price", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPrice } = req.body;
    
    if (!newPrice || isNaN(newPrice)) {
      return res.status(400).json({ error: "Укажите корректную новую цену" });
    }

    const financials = await OrderService.updateOrderFinalPrice(id, newPrice);
    res.json({ success: true, financials });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/orders/:id/finance/expense", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, category, comment } = req.body;

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "Сумма расхода должна быть больше 0" });
    }

    const financials = await OrderService.addOrderExpense(id, amount, category || "Расход", comment, "admin");
    res.json({ success: true, financials });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// ⚙️ 6. SYSTEM SETTINGS (DYNAMIC PRICING)
// =============================================================================

app.get("/api/settings", requireAdmin, async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 🔥 NEW: Выдача структурированного прайс-листа для рендера в CRM
 */
app.get("/api/pricelist", requireAdmin, async (req, res) => {
  try {
    const pricelist = await OrderService.getPublicPricelist();
    res.json(pricelist);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/settings", requireAdmin, async (req, res) => {
  try {
    const payload = req.body;
    
    // Поддержка массового сохранения (Bulk Update) для формы прайс-листа
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (item.key && item.value !== undefined) {
          await db.query(
            "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
            [item.key, item.value]
          );
        }
      }
      return res.json({ success: true, message: "Bulk update successful" });
    }

    // Обратная совместимость для сохранения одного ключа
    const { key, value } = payload;
    if (!key || value === undefined) return res.status(400).json({ error: "Missing 'key' or 'value'" });

    const result = await db.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW() RETURNING *",
      [key, value]
    );
    res.json({ success: true, setting: result.rows[0] });
  } catch (error) {
    console.error("[API] Settings Update Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 👥 7. STAFF & BROADCAST
// =============================================================================

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

app.post("/api/users/role", requireAdmin, async (req, res) => {
  try {
    const { userId, role } = req.body;
    const updatedUser = await UserService.changeUserRole(0, userId, role);
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/broadcast", requireAdmin, async (req, res) => {
  try {
    const { text, imageUrl, targetRole } = req.body; 

    if (!text) return res.status(400).json({ error: "Текст рассылки обязателен" });

    // Используем метод UserService для таргетинга
    const users = await UserService.getUsersForBroadcast(targetRole);

    if (users.length === 0) {
      return res.json({ success: true, delivered: 0, message: "Нет пользователей для рассылки" });
    }

    let successCount = 0;
    let failCount = 0;

    const sendMassMessage = async () => {
      for (const user of users) {
        try {
          if (imageUrl) {
            await bot.telegram.sendPhoto(user.telegram_id, imageUrl, { caption: text, parse_mode: "HTML" });
          } else {
            await bot.telegram.sendMessage(user.telegram_id, text, { parse_mode: "HTML" });
          }
          successCount++;
          await new Promise((resolve) => setTimeout(resolve, 50)); // Antispam 20 msg/sec
        } catch (e) {
          failCount++;
        }
      }
      console.log(`[Broadcast] Finished. Success: ${successCount}, Failed: ${failCount}`);
    };

    sendMassMessage(); // Запуск в фоне

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
// 🚑 8. ERROR HANDLING
// =============================================================================

app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

app.use((err, req, res, next) => {
  console.error("🔥 [Express Error]:", err);
  res.status(500).json({
    error: "Internal Server Error",
    details: config.system.isProduction ? null : err.message,
  });
});

export default app;
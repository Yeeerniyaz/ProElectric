/**
 * @file src/app.js
 * @description Конфигурация Express приложения (API Gateway & ERP Backend v10.7.0).
 * ИСПРАВЛЕНО: Защита ролей, изоляция заказов, Push-уведомления.
 * НОВОЕ: Расширенная финансовая аналитика (Timeline по месяцам и Рейтинг Бригад).
 *
 * @module Application
 * @version 10.7.0 (Enterprise Analytics, Cash Flow, Timeline & Lead Market Edition)
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
import { bot, getSocketIO } from "./bot.js";

// --- SERVICES ---
import { UserService } from "./services/UserService.js";
import { OrderService } from "./services/OrderService.js";

const app = express();
app.set("trust proxy", 1);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// 1. 🛡 SECURITY & MIDDLEWARE
// =============================================================================

app.use(
  helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }),
);

app.use(
  cors({
    origin: config.server.corsOrigin || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
  }),
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
    secret: process.env.SESSION_SECRET || "enterprise_super_secret_key_v9",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: "lax",
    },
  }),
);

app.use(express.static(path.join(__dirname, "../public")));

// =============================================================================
// 2. 🔐 AUTHENTICATION & RBAC
// =============================================================================

const requireAdmin = (req, res, next) => {
  if (
    req.session &&
    (req.session.isAdmin ||
      (req.session.user && ["owner", "admin"].includes(req.session.user.role)))
  )
    return next();
  return res
    .status(401)
    .json({ error: "⛔ Доступ запрещен. Требуются права Администратора." });
};

const requireManager = (req, res, next) => {
  if (
    req.session &&
    (req.session.isAdmin ||
      (req.session.user &&
        ["owner", "admin", "manager"].includes(req.session.user.role)))
  )
    return next();
  return res
    .status(401)
    .json({ error: "⛔ Доступ запрещен. Требуются права Бригадира." });
};

app.get("/", (req, res) => res.redirect("/admin.html"));

app.post("/api/auth/login", (req, res) => {
  const { login, password } = req.body;
  if (
    login === (process.env.ADMIN_LOGIN || "admin") &&
    password === (process.env.ADMIN_PASS || "Qazplm01")
  ) {
    req.session.isAdmin = true;
    req.session.loginTime = new Date();
    return res.json({ success: true, message: "Welcome back, Boss!" });
  }
  return res.status(401).json({ error: "Неверный логин или пароль" });
});

app.post("/api/auth/otp/request", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone)
      return res.status(400).json({ error: "Введите номер телефона" });

    const cleanPhone = phone.replace(/\D/g, "");
    const result = await db.query(
      "SELECT * FROM users WHERE REGEXP_REPLACE(phone, '\\D', '', 'g') LIKE '%' || $1 LIMIT 1",
      [cleanPhone],
    );

    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ error: "Пользователь с таким номером не найден" });
    const user = result.rows[0];
    if (!["owner", "admin", "manager"].includes(user.role))
      return res
        .status(403)
        .json({ error: "Доступ разрешен только персоналу" });

    const { otp } = await UserService.generateWebOTP(user.telegram_id);
    await bot.telegram.sendMessage(
      user.telegram_id,
      `🔐 <b>Вход в Web CRM</b>\nВаш код: <code>${otp}</code>\n<i>Действителен 15 минут.</i>`,
      { parse_mode: "HTML" },
    );

    res.json({ success: true, message: "Код отправлен в Telegram" });
  } catch (error) {
    res.status(500).json({ error: "Ошибка генерации кода" });
  }
});

app.post("/api/auth/otp/verify", async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp)
      return res.status(400).json({ error: "Телефон и код обязательны" });

    const user = await UserService.verifyWebOTP(phone, otp);
    if (!user)
      return res.status(401).json({ error: "Неверный или просроченный код" });

    req.session.user = {
      id: user.telegram_id,
      role: user.role,
      name: user.first_name,
      phone: user.phone,
    };
    res.json({ success: true, user: req.session.user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/auth/me", (req, res) => {
  if (req.session && req.session.user)
    return res.json({
      authenticated: true,
      user: req.session.user,
      isLegacy: false,
    });
  if (req.session && req.session.isAdmin)
    return res.json({
      authenticated: true,
      user: { role: "owner", name: "SuperAdmin" },
      isLegacy: true,
    });
  res.json({ authenticated: false });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("proelectric.sid");
    res.json({ success: true });
  });
});

// =============================================================================
// 3. 📊 DEEP ANALYTICS, TIMELINES & DASHBOARD
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
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/analytics/deep", requireAdmin, async (req, res) => {
  try {
    const avgQuery = await db.query(
      `SELECT COALESCE(AVG(total_price), 0) as avg_check, COALESCE(AVG(COALESCE((details->'financials'->>'net_profit')::numeric, total_price)), 0) as avg_margin FROM orders WHERE status = 'done'`,
    );
    const debtQuery = await db.query(
      `SELECT COALESCE(SUM(balance), 0) as total_debt FROM accounts WHERE type = 'brigade_acc' AND balance < 0`,
    );
    const expensesQuery = await db.query(
      `SELECT category, COALESCE(SUM(amount), 0) as total FROM object_expenses GROUP BY category ORDER BY total DESC`,
    );

    res.json({
      economics: {
        averageCheck: parseFloat(avgQuery.rows[0].avg_check || 0),
        averageMargin: parseFloat(avgQuery.rows[0].avg_margin || 0),
        totalBrigadeDebts: Math.abs(
          parseFloat(debtQuery.rows[0].total_debt || 0),
        ),
      },
      expenseBreakdown: expensesQuery.rows || [],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 НОВОЕ: Финансовый таймлайн (Доходы фирмы по месяцам)
app.get("/api/analytics/timeline", requireAdmin, async (req, res) => {
  try {
    const query = `
      SELECT 
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month,
        COALESCE(SUM(total_price), 0) as gross_revenue,
        COALESCE(SUM(COALESCE((details->'financials'->>'net_profit')::numeric, total_price)), 0) as net_profit,
        COUNT(id) as closed_orders
      FROM orders 
      WHERE status = 'done'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month DESC
      LIMIT 12;
    `;
    const result = await db.query(query);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 НОВОЕ: Эффективность и доходы в разрезе каждой бригады
app.get("/api/analytics/brigades", requireAdmin, async (req, res) => {
  try {
    const query = `
      SELECT 
        b.id, 
        b.name,
        COUNT(o.id) as closed_orders_count,
        COALESCE(SUM(o.total_price), 0) as total_revenue_brought,
        COALESCE(SUM(COALESCE((o.details->'financials'->>'net_profit')::numeric, o.total_price)), 0) as total_net_profit_brought,
        COALESCE(a.balance, 0) as current_balance
      FROM brigades b
      LEFT JOIN orders o ON b.id = o.brigade_id AND o.status = 'done'
      LEFT JOIN accounts a ON b.brigadier_id = a.user_id AND a.type = 'brigade_acc'
      GROUP BY b.id, b.name, a.balance
      ORDER BY total_net_profit_brought DESC;
    `;
    const result = await db.query(query);

    // Форматируем долг из баланса
    const formattedData = result.rows.map((row) => ({
      ...row,
      current_debt:
        row.current_balance < 0 ? Math.abs(parseFloat(row.current_balance)) : 0,
    }));

    res.json(formattedData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 🏗 4. BRIGADES MANAGEMENT (ERP CORE)
// =============================================================================

app.get("/api/brigades", requireAdmin, async (req, res) => {
  try {
    const brigades = await db.getBrigades();
    for (let b of brigades) {
      const acc = await db.query(
        "SELECT balance FROM accounts WHERE user_id = $1 AND type = 'brigade_acc' LIMIT 1",
        [b.brigadier_id],
      );
      b.balance = acc.rows.length > 0 ? parseFloat(acc.rows[0].balance) : 0;
    }
    res.json(brigades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/brigades", requireAdmin, async (req, res) => {
  try {
    const { name, brigadierId, profitPercentage } = req.body;
    if (!name || !brigadierId)
      return res.status(400).json({ error: "Название и ID обязательны" });
    const newBrigade = await db.createBrigade(
      name,
      brigadierId,
      profitPercentage || 40,
    );
    res.json({ success: true, brigade: newBrigade });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/brigades/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { profitPercentage, isActive } = req.body;
    const updated = await db.updateBrigade(id, profitPercentage, isActive);
    res.json({ success: true, brigade: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/brigades/:id/orders", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const orders = await OrderService.getBrigadeOrders(id);
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 📦 5. ORDER MANAGEMENT & LEAD MARKET
// =============================================================================

app.get("/api/orders", requireManager, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status || null;

    const isManager = req.session?.user?.role === "manager";
    const userId = req.session?.user?.id;

    let query = `
      SELECT o.*, u.first_name as client_name, u.phone as client_phone, b.name as brigade_name
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.telegram_id
      LEFT JOIN brigades b ON o.brigade_id = b.id
      WHERE 1=1
    `;
    const params = [];

    if (isManager) {
      const bRes = await db.query(
        "SELECT id FROM brigades WHERE brigadier_id = $1",
        [userId],
      );
      const brigadeId = bRes.rows.length > 0 ? bRes.rows[0].id : -1;
      params.push(brigadeId);
      query += ` AND o.brigade_id = $${params.length}`;
    }

    if (status && status !== "all") {
      params.push(status);
      query += ` AND o.status = $${params.length}`;
    }

    params.push(limit, offset);
    query += ` ORDER BY o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/orders", requireAdmin, async (req, res) => {
  try {
    const {
      clientName,
      clientPhone,
      area = 50,
      rooms = 2,
      wallType = "wall_concrete",
    } = req.body;
    if (!clientName || !clientPhone)
      return res.status(400).json({ error: "Имя и телефон обязательны" });

    let userId;
    const existingUser = await db.query(
      "SELECT telegram_id FROM users WHERE phone = $1 LIMIT 1",
      [clientPhone],
    );

    if (existingUser.rows.length > 0) userId = existingUser.rows[0].telegram_id;
    else {
      userId = -Date.now();
      await db.query(
        "INSERT INTO users (telegram_id, first_name, username, phone, role) VALUES ($1, $2, $3, $4, 'user')",
        [userId, clientName, "crm_lead", clientPhone],
      );
    }

    const estimate = await OrderService.calculateComplexEstimate(
      Number(area),
      Number(rooms),
      wallType,
    );
    const order = await OrderService.createOrder(userId, estimate);

    const io = getSocketIO();
    if (io) io.emit("new_order", order);

    // БРОДКАСТ БРИГАДАМ О НОВОМ ОБЪЕКТЕ
    try {
      const managersRes = await db.query(
        "SELECT telegram_id FROM users WHERE role = 'manager'",
      );
      const fmtPrice = new Intl.NumberFormat("ru-RU").format(order.total_price);
      for (const manager of managersRes.rows) {
        await bot.telegram
          .sendMessage(
            manager.telegram_id,
            `⚡️ <b>НОВЫЙ ОБЪЕКТ НА БИРЖЕ!</b>\n➖➖➖➖➖➖➖➖➖➖\n💰 <b>Смета:</b> ${fmtPrice} ₸\n📐 <b>Объем:</b> ${area} м² / Комнат: ${rooms}\n➖➖➖➖➖➖➖➖➖➖\n<i>Кто первый заберет, того и объект!</i>`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "✅ Забрать объект",
                      callback_data: `take_order_${order.id}`,
                    },
                  ],
                ],
              },
            },
          )
          .catch(() => {});
      }
    } catch (pushErr) {}

    res.json({ success: true, order });
  } catch (error) {
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
    const updatedDetails = await OrderService.updateOrderDetails(
      id,
      key,
      value,
    );
    res.json({ success: true, details: updatedDetails });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/orders/:id/assign", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { brigadeId } = req.body;
    await db.query(
      "UPDATE orders SET brigade_id = $1, status = 'work', updated_at = NOW() WHERE id = $2",
      [brigadeId, id],
    );

    // Отправляем пуш бригадиру
    const bRes = await db.query(
      "SELECT brigadier_id FROM brigades WHERE id = $1",
      [brigadeId],
    );
    if (bRes.rows.length > 0) {
      await bot.telegram
        .sendMessage(
          bRes.rows[0].brigadier_id,
          `🔔 <b>ШЕФ НАЗНАЧИЛ ВАМ ОБЪЕКТ!</b>\nОбъект <b>#${id}</b> принудительно добавлен в ваш список задач ("Мои объекты").`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
    }

    const io = getSocketIO();
    if (io)
      io.emit("order_updated", {
        orderId: id,
        status: "work",
        brigade_id: brigadeId,
      });

    res.json({ success: true, message: "Бригада назначена" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/orders/:id/bom", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updatedDetails = await OrderService.updateOrderDetails(
      id,
      "bom",
      req.body.newBomArray,
    );
    res.json({ success: true, bom: updatedDetails.bom });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/orders/:id/finalize", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.finalizeOrderAndDistributeProfit(id);
    const io = getSocketIO();
    if (io) io.emit("order_updated", { orderId: id, status: "done" });
    res.json({ success: true, distribution: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 💸 6. ORDER FINANCIAL MANAGEMENT & EXPENSES
// =============================================================================

app.patch("/api/orders/:id/finance/price", requireAdmin, async (req, res) => {
  try {
    const financials = await OrderService.updateOrderFinalPrice(
      req.params.id,
      req.body.newPrice,
    );
    res.json({ success: true, financials });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post(
  "/api/orders/:id/finance/expense",
  requireManager,
  async (req, res) => {
    try {
      const { amount, category, comment } = req.body;
      const financials = await OrderService.addOrderExpense(
        req.params.id,
        amount,
        category || "Расход",
        comment,
        req.session?.user?.id || "admin",
      );
      const io = getSocketIO();
      if (io)
        io.emit("expense_added", { orderId: req.params.id, amount, category });
      res.json({ success: true, financials });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// =============================================================================
// 🏢 7. CORPORATE FINANCE & CASH FLOW (GLOBAL)
// =============================================================================

app.get("/api/finance/accounts", requireAdmin, async (req, res) => {
  try {
    const accounts = await db.getAccounts();
    res.json(accounts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/finance/transactions", requireAdmin, async (req, res) => {
  try {
    const transactions = await db.getCompanyTransactions(
      parseInt(req.query.limit) || 100,
    );
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/finance/transactions", requireAdmin, async (req, res) => {
  try {
    const { accountId, amount, type, category, comment } = req.body;
    const transaction = await db.addCompanyTransaction({
      accountId,
      userId: req.session?.user?.id || 0,
      amount: parseFloat(amount),
      type,
      category: category || "Прочее",
      comment: comment || "",
    });
    res.json({ success: true, transaction });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/finance/incassation/approve", requireAdmin, async (req, res) => {
  try {
    const { brigadierId, amount } = req.body;
    const resAcc = await db.query(
      "SELECT id FROM accounts WHERE type = 'cash' ORDER BY id ASC LIMIT 1",
    );
    if (resAcc.rows.length === 0)
      return res.status(500).json({ error: "Главная Касса не найдена" });
    await db.processIncassation(
      brigadierId,
      parseFloat(amount),
      resAcc.rows[0].id,
    );
    res.json({ success: true, message: "Инкассация успешно проведена" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// ⚙️ 8. SYSTEM SETTINGS & DEVOPS
// =============================================================================

app.get("/api/settings", requireAdmin, async (req, res) => {
  try {
    res.json(await db.getSettings());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/pricelist", requireAdmin, async (req, res) => {
  try {
    res.json(await OrderService.getPublicPricelist());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/settings", requireAdmin, async (req, res) => {
  try {
    if (Array.isArray(req.body)) {
      await db.saveBulkSettings(req.body);
      return res.json({ success: true, message: "Bulk update successful" });
    }
    const result = await db.saveSetting(req.body.key, req.body.value);
    res.json({ success: true, setting: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/system/backup", requireAdmin, async (req, res) => {
  try {
    const dump = { timestamp: new Date().toISOString(), database: {} };
    const tables = [
      "users",
      "brigades",
      "orders",
      "settings",
      "object_expenses",
      "accounts",
      "transactions",
    ];
    for (const table of tables) {
      try {
        dump.database[table] = (await db.query(`SELECT * FROM ${table}`)).rows;
      } catch (e) {}
    }
    res.setHeader(
      "Content-disposition",
      `attachment; filename=ProElectric_Backup_${Date.now()}.json`,
    );
    res.setHeader("Content-type", "application/json");
    res.send(JSON.stringify(dump, null, 2));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 👥 9. STAFF & BROADCAST
// =============================================================================

app.get("/api/users", requireAdmin, async (req, res) => {
  try {
    res.json(
      await UserService.getAllUsers(
        parseInt(req.query.limit) || 100,
        parseInt(req.query.offset) || 0,
      ),
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/users/role", requireAdmin, async (req, res) => {
  try {
    const { userId, role } = req.body;

    const targetRes = await db.query(
      "SELECT role FROM users WHERE telegram_id = $1",
      [userId],
    );
    const targetRole = targetRes.rows[0]?.role;

    if (targetRole === "owner" && role !== "owner") {
      return res.status(403).json({
        error:
          "⛔ Критическая ошибка: Невозможно изменить роль Владельца системы.",
      });
    }

    if (
      req.session?.user?.role === "admin" &&
      (role === "admin" || role === "owner")
    ) {
      return res
        .status(403)
        .json({ error: "⛔ У вас нет прав назначать высшее руководство." });
    }

    const updatedUser = await UserService.changeUserRole(
      req.session?.user?.id || 0,
      userId,
      role,
    );
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/broadcast", requireAdmin, async (req, res) => {
  try {
    const { text, imageUrl, targetRole } = req.body;
    if (!text)
      return res.status(400).json({ error: "Текст рассылки обязателен" });

    let query = `SELECT telegram_id FROM users WHERE telegram_id > 0`;
    let params = [];
    if (targetRole && targetRole !== "all") {
      query += ` AND role = $1`;
      params.push(targetRole);
    }

    const result = await db.query(query, params);
    if (result.rows.length === 0)
      return res.json({
        success: true,
        delivered: 0,
        message: "Нет пользователей для рассылки",
      });

    const sendMassMessage = async () => {
      for (const user of result.rows) {
        try {
          if (imageUrl)
            await bot.telegram.sendPhoto(user.telegram_id, imageUrl, {
              caption: text,
              parse_mode: "HTML",
            });
          else
            await bot.telegram.sendMessage(user.telegram_id, text, {
              parse_mode: "HTML",
            });
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch (e) {}
      }
    };
    sendMassMessage();
    res.json({
      success: true,
      message: `Рассылка запущена для ${result.rows.length} пользователей.`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use((req, res) => res.status(404).json({ error: "Endpoint not found" }));
app.use((err, req, res, next) =>
  res.status(500).json({ error: "Internal Server Error" }),
);

export default app;

/**
 * @file src/app.js
 * @description Конфигурация Express приложения (API Gateway & ERP Backend v10.6.0).
 * Отвечает за обработку HTTP-запросов, маршрутизацию CRM, глубокую аналитику
 * и интеграцию с сервисами (Бригады, Инкассация, OTP Auth, WebSockets).
 * ИСПРАВЛЕНИЯ: Безопасный рендеринг аналитики, защита смены своей роли.
 * НОВОЕ: Авто-рассылка Push-уведомлений Бригадам при появлении новых объектов.
 *
 * @module Application
 * @version 10.6.0 (Enterprise Analytics, Cash Flow & Lead Market Edition)
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
import { bot, getSocketIO } from "./bot.js"; // Интеграция сокетов и бота

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
  }),
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
      maxAge: 24 * 60 * 60 * 1000, // 24 часа
      sameSite: "lax",
    },
  }),
);

app.use(express.static(path.join(__dirname, "../public")));

// =============================================================================
// 2. 🔐 AUTHENTICATION & RBAC (OTP & Legacy)
// =============================================================================

const requireAdmin = (req, res, next) => {
  if (
    req.session &&
    (req.session.isAdmin ||
      (req.session.user && ["owner", "admin"].includes(req.session.user.role)))
  ) {
    return next();
  }
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
  ) {
    return next();
  }
  return res
    .status(401)
    .json({ error: "⛔ Доступ запрещен. Требуются права Бригадира." });
};

app.get("/", (req, res) => {
  res.redirect("/admin.html");
});

app.post("/api/auth/login", (req, res) => {
  const { login, password } = req.body;
  const validLogin = process.env.ADMIN_LOGIN || "admin";
  const validPass = process.env.ADMIN_PASS || "Qazplm01";

  if (login === validLogin && password === validPass) {
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
        .json({ error: "Доступ в Web CRM разрешен только персоналу" });

    const { otp } = await UserService.generateWebOTP(user.telegram_id);
    await bot.telegram.sendMessage(
      user.telegram_id,
      `🔐 <b>Запрос на вход в Web CRM</b>\nВаш одноразовый пароль: <code>${otp}</code>\n<i>Действителен 15 минут. Никому не сообщайте!</i>`,
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
  if (req.session && req.session.user) {
    return res.json({
      authenticated: true,
      user: req.session.user,
      isLegacy: false,
    });
  } else if (req.session && req.session.isAdmin) {
    return res.json({
      authenticated: true,
      user: { role: "owner", name: "SuperAdmin" },
      isLegacy: true,
    });
  }
  res.json({ authenticated: false });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Ошибка при выходе" });
    res.clearCookie("proelectric.sid");
    res.json({ success: true });
  });
});

// =============================================================================
// 3. 📊 DEEP ANALYTICS & DASHBOARD (SAFE SQL ENGINE)
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
    // 1. Средний чек (AOV) и Средняя маржа с безопасным COALESCE
    const avgQuery = await db.query(`
      SELECT 
        COALESCE(AVG(total_price), 0) as avg_check,
        COALESCE(AVG(COALESCE((details->'financials'->>'net_profit')::numeric, total_price)), 0) as avg_margin
      FROM orders WHERE status = 'done'
    `);

    // 2. Дебиторская задолженность
    const debtQuery = await db.query(`
      SELECT COALESCE(SUM(balance), 0) as total_debt 
      FROM accounts WHERE type = 'brigade_acc' AND balance < 0
    `);

    // 3. Анализ расходов
    const expensesQuery = await db.query(`
      SELECT category, COALESCE(SUM(amount), 0) as total
      FROM object_expenses
      GROUP BY category
      ORDER BY total DESC
    `);

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
      return res
        .status(400)
        .json({ error: "Название и ID Бригадира обязательны" });

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
// 📦 5. ORDER MANAGEMENT (ADVANCED) & LEAD MARKET
// =============================================================================

app.get("/api/orders", requireManager, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status || null;

    let query = `
      SELECT o.*, u.first_name as client_name, u.phone as client_phone, b.name as brigade_name
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.telegram_id
      LEFT JOIN brigades b ON o.brigade_id = b.id
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

    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].telegram_id;
    } else {
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

    // --- 🔥 НОВОЕ: БРОДКАСТ БРИГАДАМ (БИРЖА ЛИДОВ) ---
    try {
      const managersRes = await db.query(
        "SELECT telegram_id FROM users WHERE role = 'manager'",
      );
      const fmtPrice = new Intl.NumberFormat("ru-RU").format(order.total_price);

      for (const manager of managersRes.rows) {
        await bot.telegram
          .sendMessage(
            manager.telegram_id,
            `⚡️ <b>НОВЫЙ ОБЪЕКТ НА БИРЖЕ!</b>\n➖➖➖➖➖➖➖➖➖➖\n` +
              `💰 <b>Смета:</b> ${fmtPrice} ₸\n` +
              `📐 <b>Объем:</b> ${area} м² / Комнат: ${rooms}\n` +
              `📍 <b>Адрес:</b> Уточняется (Оффлайн-заказ)\n➖➖➖➖➖➖➖➖➖➖\n` +
              `<i>Кто первый заберет, того и объект!</i>`,
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
    } catch (pushErr) {
      console.error("[API] Ошибка рассылки на Биржу:", pushErr);
    }

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
    if (!key)
      return res.status(400).json({ error: "Ключ обновления не передан" });

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
    const { newBomArray } = req.body;
    const updatedDetails = await OrderService.updateOrderDetails(
      id,
      "bom",
      newBomArray,
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
    const { id } = req.params;
    const { newPrice } = req.body;
    if (!newPrice || isNaN(newPrice))
      return res.status(400).json({ error: "Укажите корректную новую цену" });

    const financials = await OrderService.updateOrderFinalPrice(id, newPrice);
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
      const { id } = req.params;
      const { amount, category, comment } = req.body;
      if (!amount || isNaN(amount) || amount <= 0)
        return res
          .status(400)
          .json({ error: "Сумма расхода должна быть больше 0" });

      const userId = req.session?.user?.id || "admin";
      const financials = await OrderService.addOrderExpense(
        id,
        amount,
        category || "Расход",
        comment,
        userId,
      );

      const io = getSocketIO();
      if (io) io.emit("expense_added", { orderId: id, amount, category });

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
    const limit = parseInt(req.query.limit) || 100;
    const transactions = await db.getCompanyTransactions(limit);
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/finance/transactions", requireAdmin, async (req, res) => {
  try {
    const { accountId, amount, type, category, comment } = req.body;
    if (!accountId || !amount || isNaN(amount) || amount <= 0 || !type) {
      return res.status(400).json({ error: "Некорректные данные транзакции" });
    }

    const userId = req.session?.user?.id || 0;
    const transaction = await db.addCompanyTransaction({
      accountId,
      userId,
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
    if (!brigadierId || !amount)
      return res
        .status(400)
        .json({ error: "ID бригадира и сумма обязательны" });

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
    const settings = await db.getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
    if (Array.isArray(payload)) {
      await db.saveBulkSettings(payload);
      return res.json({ success: true, message: "Bulk update successful" });
    }
    const { key, value } = payload;
    if (!key || value === undefined)
      return res.status(400).json({ error: "Missing 'key' or 'value'" });

    const result = await db.saveSetting(key, value);
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
    const initiatorId = req.session?.user?.id;

    // ИСПРАВЛЕНИЕ: Защита от смены собственной роли через Web CRM
    if (String(initiatorId) === String(userId)) {
      return res
        .status(403)
        .json({ error: "⛔ Вы не можете изменить свою собственную роль" });
    }

    const updatedUser = await UserService.changeUserRole(
      initiatorId || 0,
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
    const users = result.rows;

    if (users.length === 0) {
      return res.json({
        success: true,
        delivered: 0,
        message: "Нет пользователей для рассылки",
      });
    }

    let successCount = 0,
      failCount = 0;
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
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch (e) {
          failCount++;
        }
      }
      console.log(
        `[Broadcast] Finished. Success: ${successCount}, Failed: ${failCount}`,
      );
    };

    sendMassMessage();
    res.json({
      success: true,
      message: `Рассылка запущена для ${users.length} пользователей.`,
      estimatedTimeSec: Math.ceil(users.length * 0.05),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// 🚑 10. ERROR HANDLING
// =============================================================================

app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

app.use((err, req, res, next) => {
  console.error("🔥 [Express Error]:", err);
  res.status(500).json({
    error: "Internal Server Error",
    details: process.env.NODE_ENV === "production" ? null : err.message,
  });
});

export default app;

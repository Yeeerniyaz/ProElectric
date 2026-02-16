/**
 * @file src/server.js
 * @description REST API Engine (ProElectro Enterprise).
 * Высокопроизводительный бэкенд для CRM с интеграцией финансового учета.
 * @version 8.0.0 (High-Performance Architecture)
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

// --- Вспомогательный мидлвар для обработки асинхронных ошибок ---
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

export const startServer = () => {
    const app = express();

    // =========================================================================
    // 🛡 БЕЗОПАСНОСТЬ И ИНФРАСТРУКТУРА
    // =========================================================================
    app.set("trust proxy", 1);
    
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                ...helmet.contentSecurityPolicy.getDefaultDirectives(),
                "script-src": ["'self'", "'unsafe-inline'", "unpkg.com"],
            },
        },
    }));

    app.use(cors({
        origin: config.server.env === "production" ? false : true,
        credentials: true,
    }));

    app.use(rateLimit({
        windowMs: 15 * 60 * 1000,
        max: config.server.env === "production" ? 1000 : 5000,
        message: { error: "Too many requests" }
    }));

    app.use(express.json({ limit: "1mb" }));
    app.use(express.urlencoded({ extended: true }));

    // Сессионный менеджмент (используем MemoryStore для MVP, но готов к Redis)
    app.use(session({
        name: "pro_session_id",
        secret: config.security.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            secure: config.server.env === "production",
            maxAge: 1000 * 60 * 60 * 24 * 7, // 7 дней
            sameSite: "lax",
        },
    }));

    // =========================================================================
    // 🔐 КОНТРОЛЬ ДОСТУПА
    // =========================================================================
    const requireAuth = (req, res, next) => {
        if (req.session?.isAdmin) return next();
        res.status(401).json({ error: "Unauthorized access" });
    };

    // =========================================================================
    // 🔑 AUTH ROUTES
    // =========================================================================
    app.post("/api/login", (req, res) => {
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: "Password required" });

        const hash = crypto.createHash("sha256").update(password).digest("hex");

        if (hash === config.security.adminPassHash) {
            req.session.isAdmin = true;
            req.session.userId = 999; // Системный ID админа
            return res.json({ success: true, role: "admin" });
        }
        res.status(403).json({ error: "Invalid credentials" });
    });

    app.post("/api/logout", (req, res) => {
        req.session.destroy(() => res.json({ success: true }));
    });

    app.get("/api/me", (req, res) => {
        res.json({ isAdmin: !!req.session?.isAdmin });
    });

    // =========================================================================
    // 📊 АНАЛИТИКА (KPI)
    // =========================================================================
    app.get("/api/analytics/kpi", requireAuth, asyncHandler(async (req, res) => {
        // Выполняем запросы параллельно для скорости
        const [finData, activeData, totalData] = await Promise.all([
            db.query(`SELECT 
                COALESCE(SUM(final_price), 0) as revenue, 
                COALESCE(SUM(final_profit), 0) as profit 
                FROM orders WHERE status = 'done'`),
            db.query(`SELECT COUNT(*) as count FROM orders WHERE status IN ('new', 'work', 'discuss')`),
            db.query(`SELECT 
                COUNT(*) as total, 
                COUNT(*) FILTER (WHERE status = 'done') as done 
                FROM orders`)
        ]);

        const stats = {
            revenue: parseFloat(finData.rows[0].revenue),
            profit: parseFloat(finData.rows[0].profit),
            activeOrders: parseInt(activeData.rows[0].count),
            totalOrders: parseInt(totalData.rows[0].total),
            conversion: totalData.rows[0].total > 0 
                ? ((totalData.rows[0].done / totalData.rows[0].total) * 100).toFixed(1) + "%" 
                : "0%"
        };

        res.json(stats);
    }));

    // =========================================================================
    // 🏗 УПРАВЛЕНИЕ ЗАКАЗАМИ
    // =========================================================================
    
    app.get("/api/orders", requireAuth, asyncHandler(async (req, res) => {
        const { status, limit = 50 } = req.query;
        
        const query = `
            SELECT o.*, 
                   u.first_name as client_name, u.phone as client_phone,
                   m.first_name as manager_name,
                   (SELECT COALESCE(SUM(amount), 0) FROM object_expenses WHERE order_id = o.id) as expenses_sum
            FROM orders o
            LEFT JOIN users u ON o.user_id = u.telegram_id
            LEFT JOIN users m ON o.assignee_id = m.telegram_id
            WHERE ($1 = 'all' OR o.status = $1)
            ORDER BY o.created_at DESC 
            LIMIT $2
        `;
        
        const result = await db.query(query, [status || 'all', limit]);
        res.json({ data: result.rows });
    }));

    // Создание заказа вручную
    app.post("/api/orders", requireAuth, asyncHandler(async (req, res) => {
        const { area, rooms, wallType, clientName, clientPhone, price } = req.body;
        
        const fakeId = -Math.floor(Date.now() / 1000); 
        await db.upsertUser(fakeId, clientName, 'manual', clientPhone);

        // Если цена не передана, рассчитываем по калькулятору
        const finalPrice = price || (await OrderService.calculateEstimate(area, rooms, wallType)).totals.grandTotal;

        const order = await db.createOrder(fakeId, { 
            city: 'Manual Entry', 
            serviceType: 'manual' 
        }, {
            params: { area, rooms, wallType },
            totals: { grandTotal: finalPrice }
        });

        res.json({ success: true, orderId: order.id });
    }));

    // Добавление расхода к объекту
    app.post("/api/orders/:id/expenses", requireAuth, asyncHandler(async (req, res) => {
        const { amount, category, comment } = req.body;
        const orderId = req.params.id;

        if (!amount || isNaN(amount)) return res.status(400).json({ error: "Invalid amount" });

        await db.addObjectExpense(orderId, amount, category, comment || "Web Admin");
        res.json({ success: true });
    }));

    // =========================================================================
    // 💰 ФИНАНСЫ И СЕТТИНГИ
    // =========================================================================
    
    app.get("/api/accounts", requireAuth, asyncHandler(async (req, res) => {
        const accounts = await db.getAccounts();
        res.json(accounts);
    }));

    app.get("/api/finance/history", requireAuth, asyncHandler(async (req, res) => {
        const result = await db.query(`
            SELECT t.*, a.name as account_name 
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            ORDER BY t.created_at DESC LIMIT 100
        `);
        res.json(result.rows);
    }));

    app.get("/api/settings", requireAuth, asyncHandler(async (req, res) => {
        const settings = await db.getSettings();
        res.json(settings);
    }));

    app.post("/api/settings", requireAuth, asyncHandler(async (req, res) => {
        const { key, value } = req.body;
        await db.query(`
            INSERT INTO settings (key, value, updated_at) 
            VALUES ($1, $2, NOW()) 
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `, [key, parseFloat(value)]);
        res.json({ success: true });
    }));

    // =========================================================================
    // 🌍 СТАТИКА И SPA
    // =========================================================================
    app.use(express.static(path.join(__dirname, "../public")));

    // Error Handler
    app.use((err, req, res, next) => {
        console.error(`💥 [SERVER ERROR] ${err.stack}`);
        res.status(err.status || 500).json({
            error: config.server.env === "production" ? "Internal Server Error" : err.message
        });
    });

    app.get("*", (req, res) => {
        res.sendFile(path.join(__dirname, "../public/admin.html"));
    });

    app.listen(config.server.port, "0.0.0.0", () => {
        console.log(`🚀 [SERVER] ProElectro Enterprise API online on port ${config.server.port}`);
    });
};
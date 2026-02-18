/**
 * @file src/handlers/AdminHandler.js
 * @description Контроллер панели администратора (Enterprise CRM Controller).
 * Реализует: Управление расходами, Умную отмену, Комментарии и P&L.
 * Архитектура: FSM (State Machine) для ввода данных.
 *
 * @author ProElectric Team
 * @version 7.1.0 (Senior Architect Edition)
 */

import { Markup } from "telegraf";
import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";
import * as db from "../database/index.js";
import os from "os";

// =============================================================================
// 🔧 INTERNAL CONSTANTS
// =============================================================================

const ROLES = Object.freeze({
  OWNER: "owner",
  ADMIN: "admin",
  MANAGER: "manager",
  USER: "user",
  BANNED: "banned",
});

const BUTTONS = Object.freeze({
  DASHBOARD: "📊 P&L Отчет",
  ORDERS: "📦 Управление заказами",
  SETTINGS: "⚙️ Настройки цен",
  STAFF: "👥 Персонал",
  SQL_CONSOLE: "👨‍💻 SQL Терминал",
  BACKUP: "💾 Бэкап базы",
  SERVER_STATS: "🖥 Состояние сервера",
  BACK: "🔙 В главное меню",
});

/**
 * Админские состояния (для ввода текста)
 */
const ADMIN_STATES = {
  IDLE: "IDLE",
  WAIT_EXPENSE: "WAIT_EXPENSE",
  WAIT_CANCEL_REASON: "WAIT_CANCEL_REASON",
  WAIT_COMMENT: "WAIT_COMMENT",
};

// =============================================================================
// 🎹 KEYBOARDS FACTORY
// =============================================================================

const AdminKeyboards = {
  mainMenu: (role) => {
    const buttons = [
      [BUTTONS.DASHBOARD, BUTTONS.ORDERS],
      [BUTTONS.SETTINGS, BUTTONS.STAFF],
    ];
    if (role === ROLES.OWNER) {
      buttons.push([BUTTONS.SQL_CONSOLE, BUTTONS.BACKUP]);
      buttons.push([BUTTONS.SERVER_STATS]);
    }
    buttons.push([BUTTONS.BACK]);
    return Markup.keyboard(buttons).resize();
  },

  /**
   * Меню управления заказом
   */
  orderControl: (orderId, status) => {
    const actions = [];

    if (status === "new") {
      actions.push([
        Markup.button.callback(
          "👷 Взять в работу",
          `status_${orderId}_processing`,
        ),
      ]);
      actions.push([
        Markup.button.callback("❌ Отменить", `cancel_menu_${orderId}`),
      ]); // Новое меню отмены
    } else if (status === "processing") {
      actions.push([
        Markup.button.callback("🛠 Начать монтаж", `status_${orderId}_work`),
      ]);
      actions.push([
        Markup.button.callback("↩️ Вернуть в новые", `status_${orderId}_new`),
      ]);
      actions.push([
        Markup.button.callback("❌ Отменить", `cancel_menu_${orderId}`),
      ]);
    } else if (status === "work") {
      actions.push([
        Markup.button.callback("✅ Завершить", `status_${orderId}_done`),
      ]);
      actions.push([
        Markup.button.callback(
          "💸 Добавить расход",
          `expense_start_${orderId}`,
        ),
      ]); // Ввод расхода
    } else if (status === "done") {
      actions.push([
        Markup.button.callback(
          "💸 Добавить расход",
          `expense_start_${orderId}`,
        ),
      ]);
    }

    // Всегда доступно
    actions.push([
      Markup.button.callback("💬 Комментарий", `comment_start_${orderId}`),
    ]);

    return Markup.inlineKeyboard(actions);
  },

  /**
   * Меню выбора инициатора отмены
   */
  cancelMenu: (orderId) =>
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "👤 Отменил Клиент",
          `cancel_confirm_${orderId}_client`,
        ),
        Markup.button.callback(
          "🏢 Отменила Фирма",
          `cancel_confirm_${orderId}_firm`,
        ),
      ],
      [Markup.button.callback("🔙 Назад", `back_to_order_${orderId}`)],
    ]),

  cancelInput: Markup.inlineKeyboard([
    [Markup.button.callback("❌ Отмена ввода", "admin_cancel_input")],
  ]),
};

// =============================================================================
// 🎮 CONTROLLER IMPLEMENTATION
// =============================================================================

export const AdminHandler = {
  /**
   * ===========================================================================
   * 1. 🚦 INPUT HANDLER (НОВОЕ: Обработка ввода текста админа)
   * ===========================================================================
   * Этот метод должен вызываться из bot.js при событии text
   */
  async handleAdminInput(ctx) {
    // Проверяем, есть ли активное состояние у админа
    const state = ctx.session.adminState;
    if (!state || state.action === ADMIN_STATES.IDLE) return false; // Не обрабатываем

    // Маршрутизация по состояниям
    if (state.action === ADMIN_STATES.WAIT_EXPENSE)
      return this.finalizeExpense(ctx);
    if (state.action === ADMIN_STATES.WAIT_CANCEL_REASON)
      return this.finalizeCancel(ctx);
    if (state.action === ADMIN_STATES.WAIT_COMMENT)
      return this.finalizeComment(ctx);

    return false;
  },

  async cancelInput(ctx) {
    ctx.session.adminState = { action: ADMIN_STATES.IDLE };
    await ctx.answerCbQuery("Ввод отменен");
    await ctx.editMessageText("❌ Действие отменено.");
  },

  /**
   * ===========================================================================
   * 2. 🚦 ENTRY POINT & MENU
   * ===========================================================================
   */

  async showAdminMenu(ctx) {
    try {
      const role = await UserService.getUserRole(ctx.from.id);
      if (![ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER].includes(role)) {
        return ctx.reply("⛔ Доступ запрещен.");
      }
      await ctx.replyWithHTML(
        `💼 <b>ПАНЕЛЬ УПРАВЛЕНИЯ</b>\nРоль: <code>${role.toUpperCase()}</code>`,
        AdminKeyboards.mainMenu(role),
      );
    } catch (e) {
      console.error(e);
    }
  },

  async handleMessage(ctx) {
    const text = ctx.message.text;
    const role = await UserService.getUserRole(ctx.from.id);
    if (![ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER].includes(role)) return;

    if (text === BUTTONS.DASHBOARD) return this.showDashboard(ctx);
    if (text === BUTTONS.ORDERS) return this.showOrdersInstruction(ctx);
    if (text === BUTTONS.SETTINGS) return this.showSettings(ctx);
    if (text === BUTTONS.STAFF) return this.showStaffList(ctx);
    if (text === BUTTONS.BACK)
      return ctx.reply("🏠 Главное меню", {
        reply_markup: {
          keyboard: [["🚀 Рассчитать стоимость"]],
          resize_keyboard: true,
        },
      }); // Упрощено

    if (role === ROLES.OWNER) {
      if (text === BUTTONS.SQL_CONSOLE) return this.showSQLInstruction(ctx);
      if (text === BUTTONS.BACKUP) return this.processBackup(ctx);
      if (text === BUTTONS.SERVER_STATS) return this.showServerStats(ctx);
    }

    // Команды
    if (text.startsWith("/order")) return this.findOrder(ctx);
    if (text.startsWith("/setprice")) return this.processSetPrice(ctx);
    if (text.startsWith("/setrole")) return this.processSetRole(ctx);
    if (text.startsWith("/sql")) return this.processSQL(ctx);
  },

  /**
   * ===========================================================================
   * 3. 📦 OMS: EXPENSES & COMMENTS (НОВЫЙ ФУНКЦИОНАЛ)
   * ===========================================================================
   */

  // --- 1. Добавление расхода ---
  async startAddExpense(ctx, orderId) {
    ctx.session.adminState = {
      action: ADMIN_STATES.WAIT_EXPENSE,
      orderId: orderId,
    };
    await ctx.replyWithHTML(
      `💸 <b>Добавление расхода к заказу #${orderId}</b>\n` +
        `Введите сумму (число) и (опционально) описание через пробел.\n` +
        `<i>Пример: 5000 Такси</i>`,
      AdminKeyboards.cancelInput,
    );
    await ctx.answerCbQuery();
  },

  async finalizeExpense(ctx) {
    const { orderId } = ctx.session.adminState;
    const input = ctx.message.text.trim().split(" ");
    const amount = parseFloat(input[0]);
    const note = input.slice(1).join(" ") || "Расход";

    if (isNaN(amount) || amount <= 0) {
      return ctx.reply(
        "⚠️ Введите корректное число (сумма). Попробуйте снова.",
      );
    }

    try {
      // Добавляем запись в массив expenses внутри JSONB details
      // Используем COALESCE чтобы создать массив, если его нет
      await db.query(
        `
        UPDATE orders 
        SET details = jsonb_set(
          COALESCE(details, '{}'), 
          '{expenses}', 
          COALESCE(details->'expenses', '[]') || $1::jsonb
        )
        WHERE id = $2
      `,
        [
          JSON.stringify({
            amount,
            note,
            date: new Date(),
            by: ctx.from.first_name,
          }),
          orderId,
        ],
      );

      ctx.session.adminState = { action: ADMIN_STATES.IDLE };
      await ctx.reply(
        `✅ Расход <b>${amount} ₸</b> (${note}) добавлен к заказу #${orderId}.`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка сохранения расхода.");
    }
  },

  // --- 2. Комментарии ---
  async startAddComment(ctx, orderId) {
    ctx.session.adminState = { action: ADMIN_STATES.WAIT_COMMENT, orderId };
    await ctx.reply(
      "💬 Напишите комментарий к заказу:",
      AdminKeyboards.cancelInput,
    );
    await ctx.answerCbQuery();
  },

  async finalizeComment(ctx) {
    const { orderId } = ctx.session.adminState;
    const text = ctx.message.text;

    try {
      await db.query(
        `
        UPDATE orders 
        SET details = jsonb_set(
          COALESCE(details, '{}'), 
          '{comments}', 
          COALESCE(details->'comments', '[]') || $1::jsonb
        )
        WHERE id = $2
      `,
        [
          JSON.stringify({ text, date: new Date(), by: ctx.from.first_name }),
          orderId,
        ],
      );

      ctx.session.adminState = { action: ADMIN_STATES.IDLE };
      await ctx.reply(`✅ Комментарий добавлен к заказу #${orderId}.`);
    } catch (e) {
      ctx.reply("❌ Ошибка.");
    }
  },

  // --- 3. Умная отмена ---
  async showCancelMenu(ctx, orderId) {
    await ctx.editMessageReplyMarkup(
      AdminKeyboards.cancelMenu(orderId).reply_markup,
    );
    await ctx.answerCbQuery();
  },

  async startCancelOrder(ctx, orderId, initiator) {
    const who = initiator === "client" ? "Клиентом" : "Фирмой";
    ctx.session.adminState = {
      action: ADMIN_STATES.WAIT_CANCEL_REASON,
      orderId,
      initiator,
    };

    await ctx.replyWithHTML(
      `❌ <b>Отмена заказа #${orderId} ${who}</b>\n` +
        `Укажите причину отмены (для статистики):`,
      AdminKeyboards.cancelInput,
    );
    await ctx.answerCbQuery();
  },

  async finalizeCancel(ctx) {
    const { orderId, initiator } = ctx.session.adminState;
    const reason = ctx.message.text;

    try {
      await db.query(
        `
        UPDATE orders 
        SET status = 'cancel', 
            details = jsonb_set(COALESCE(details, '{}'), '{cancel_info}', $1::jsonb),
            updated_at = NOW()
        WHERE id = $2
      `,
        [
          JSON.stringify({
            initiator,
            reason,
            date: new Date(),
            by: ctx.from.first_name,
          }),
          orderId,
        ],
      );

      ctx.session.adminState = { action: ADMIN_STATES.IDLE };
      await ctx.reply(`✅ Заказ #${orderId} отменен.\nПричина: ${reason}`);
    } catch (e) {
      ctx.reply("❌ Ошибка отмены.");
    }
  },

  // --- 4. Просмотр заказа (с расходами) ---
  async findOrder(ctx) {
    const parts = ctx.message.text.split(" ");
    const orderId = parts[1];
    if (!orderId) return ctx.reply("⚠️ /order ID");

    try {
      const res = await db.query(
        `
        SELECT o.*, u.first_name, u.phone 
        FROM orders o JOIN users u ON o.user_id = u.telegram_id 
        WHERE o.id = $1
      `,
        [orderId],
      );

      if (res.rows.length === 0) return ctx.reply("❌ Не найден.");
      const order = res.rows[0];
      const d = order.details || {};

      // Считаем расходы
      const expenses = (d.expenses || []).reduce(
        (acc, item) => acc + (item.amount || 0),
        0,
      );
      const comments = (d.comments || [])
        .map((c) => `— ${c.text} (${c.by})`)
        .join("\n");
      const cancelInfo = d.cancel_info
        ? `\n❌ <b>ОТМЕНА:</b> ${d.cancel_info.initiator === "client" ? "Клиент" : "Фирма"} (${d.cancel_info.reason})`
        : "";

      const msg =
        `📦 <b>ЗАКАЗ #${order.id}</b> | ${order.status.toUpperCase()}\n` +
        `👤 ${order.first_name} (${order.phone})\n` +
        `💰 Работа: ${order.total_price} ₸\n` +
        `💸 <b>Расходы: ${expenses} ₸</b>\n` +
        (expenses > 0
          ? `<i>(${(d.expenses || []).map((e) => e.amount).join("+")})</i>\n`
          : "") +
        (comments ? `\n💬 <b>Комментарии:</b>\n${comments}\n` : "") +
        cancelInfo;

      await ctx.replyWithHTML(
        msg,
        AdminKeyboards.orderControl(order.id, order.status),
      );
    } catch (e) {
      console.error(e);
      ctx.reply("Ошибка.");
    }
  },

  // Роутер Callback-ов
  async handleCallback(ctx, action) {
    // action пример: expense_start_123, cancel_menu_123
    const parts = action.split("_");
    const type = parts[0];

    // Парсим ID. Если формат type_subtype_ID
    // cancel_menu_123 -> type=cancel, parts[1]=menu, parts[2]=123

    if (action.startsWith("expense_start_")) {
      return this.startAddExpense(ctx, parts[2]);
    }
    if (action.startsWith("comment_start_")) {
      return this.startAddComment(ctx, parts[2]);
    }
    if (action.startsWith("cancel_menu_")) {
      return this.showCancelMenu(ctx, parts[2]);
    }
    if (action.startsWith("cancel_confirm_")) {
      // cancel_confirm_123_client
      return this.startCancelOrder(ctx, parts[2], parts[3]);
    }
    if (action.startsWith("back_to_order_")) {
      ctx.message = { text: `/order ${parts[3]}` }; // Хак для вызова findOrder
      return this.findOrder(ctx);
    }
    if (action === "admin_cancel_input") {
      return this.cancelInput(ctx);
    }
  },

  async handleOrderStatusChange(ctx, orderId, newStatus) {
    await OrderService.updateOrderStatus(orderId, newStatus);
    await ctx.answerCbQuery("Статус обновлен");
    // Обновляем view
    ctx.message = { text: `/order ${orderId}` };
    return this.findOrder(ctx);
  },

  async showDashboard(ctx) {
    const loading = await ctx.reply("⏳ Сбор аналитики...");

    try {
      // Сложный агрегирующий запрос для получения всей статистики за один раз
      const query = `
        SELECT 
          COUNT(*) as total_count,
          COUNT(*) FILTER (WHERE status = 'new') as new_count,
          COUNT(*) FILTER (WHERE status = 'processing') as processing_count,
          COUNT(*) FILTER (WHERE status = 'work') as work_count,
          COUNT(*) FILTER (WHERE status = 'done') as done_count,
          COUNT(*) FILTER (WHERE status = 'cancel') as cancel_count,
          COALESCE(SUM(total_price) FILTER (WHERE status = 'done'), 0) as revenue,
          COALESCE(SUM((details->'total'->>'material')::numeric) FILTER (WHERE status = 'done'), 0) as material_cost
        FROM orders
      `;

      const res = await db.query(query);
      const data = res.rows[0];

      // Вычисления KPI
      const revenue = parseFloat(data.revenue);
      const materials = parseFloat(data.material_cost);
      const grossProfit = revenue - materials;
      const margin =
        revenue > 0 ? ((grossProfit / revenue) * 100).toFixed(1) : 0;
      const conversion =
        data.total_count > 0
          ? ((data.done_count / data.total_count) * 100).toFixed(1)
          : 0;
      const aov =
        data.done_count > 0 ? (revenue / data.done_count).toFixed(0) : 0; // Average Order Value

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      const report =
        `📊 <b>ФИНАНСОВЫЙ ОТЧЕТ (Real-Time)</b>\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `💰 <b>ВЫРУЧКА:</b> ${fmt(revenue)} ₸\n` +
        `📉 <b>Расход (Мат.):</b> ${fmt(materials)} ₸\n` +
        `💎 <b>ПРИБЫЛЬ: ${fmt(grossProfit)} ₸</b> (Маржа: ${margin}%)\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `📈 <b>KPI Продаж:</b>\n` +
        `• Конверсия: <b>${conversion}%</b>\n` +
        `• Средний чек: <b>${fmt(aov)} ₸</b>\n` +
        `• Всего лидов: <b>${data.total_count}</b>\n\n` +
        `📂 <b>Воронка заказов:</b>\n` +
        `🆕 Новые: ${data.new_count}\n` +
        `👨‍🔧 В обработке: ${data.processing_count}\n` +
        `🛠 В работе: ${data.work_count}\n` +
        `✅ Завершены: ${data.done_count}\n` +
        `❌ Отмены: ${data.cancel_count}`;

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        null,
        report,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error(e);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        null,
        "❌ Ошибка формирования отчета.",
      );
    }
  },

  async showStaffList(ctx) {
    try {
      const res = await db.query(`
            SELECT telegram_id, first_name, username, role, created_at 
            FROM users 
            WHERE role IN ('owner', 'admin', 'manager')
            ORDER BY role DESC, created_at ASC
        `);

      if (res.rows.length === 0)
        return ctx.reply("👥 Список персонала пуст (кроме вас).");

      let msg = "👥 <b>КОМАНДА PRO ELECTRIC</b>\n\n";
      res.rows.forEach((u, i) => {
        const icon =
          u.role === "owner" ? "👑" : u.role === "admin" ? "🛡" : "💼";
        msg += `${i + 1}. ${icon} <b>${u.first_name}</b> (@${u.username || "NoLink"})\n`;
        msg += `   ID: <code>${u.telegram_id}</code> | Роль: ${u.role.toUpperCase()}\n\n`;
      });

      msg += `➖➖➖➖➖➖➖➖➖➖\n`;
      msg += `📝 <b>Назначить роль:</b>\n`;
      msg += `<code>/setrole ID ROLE</code>\n\n`;
      msg += `<i>Доступные роли: admin, manager, user, banned</i>`;

      await ctx.replyWithHTML(msg);
    } catch (e) {
      ctx.reply("❌ Ошибка загрузки списка персонала.");
    }
  },

   async showSettings(ctx) {
    try {
      const res = await db.query(
        "SELECT key, value, updated_at FROM settings ORDER BY key",
      );

      let msg = "⚙️ <b>ТЕКУЩИЕ ЦЕНЫ И НАСТРОЙКИ</b>\n\n";

      res.rows.forEach((row) => {
        const date = new Date(row.updated_at).toLocaleDateString("ru-RU");
        msg += `🔸 <b>${row.key}</b>: <code>${row.value}</code>\n`;
        msg += `   <i>(Обн: ${date})</i>\n`;
      });

      msg += `\n📝 <b>Изменить цену:</b>\n`;
      msg += `<code>/setprice key value</code>\n`;
      msg += `<i>Пример: /setprice price_cable 450</i>`;

      await ctx.replyWithHTML(msg);
    } catch (e) {
      ctx.reply("❌ Ошибка загрузки настроек.");
    }
  },

  async showDashboard(ctx) {
    // (Код дашборда из прошлой версии Senior Edition)
    const res = await db.query(
      `SELECT COUNT(*) as t, SUM(total_price) filter (where status='done') as r FROM orders`,
    );
    await ctx.reply(
      `💰 Выручка: ${res.rows[0].r || 0} ₸\n📦 Заказов: ${res.rows[0].t}`,
    );
  },

  async showOrdersInstruction(ctx) {
    await ctx.reply("Используйте /order ID");
  },
  async showSettings(ctx) {
    await ctx.reply("Используйте /setprice KEY VAL");
  },
  async showStaffList(ctx) {
    await ctx.reply("Используйте /setrole ID ROLE");
  },
  async showSQLInstruction(ctx) {
    await ctx.reply("/sql QUERY");
  },
  async processBackup(ctx) {
    await ctx.reply("Бэкап...");
  },
  async showServerStats(ctx) {
    await ctx.reply(`OS: ${os.type()}`);
  },
  async processSetPrice(ctx) {
    /* ... */
  },
  async processSetRole(ctx) {
    /* ... */
  },
  async processSQL(ctx) {
    try {
      await db.query(ctx.message.text.replace("/sql ", ""));
      ctx.reply("OK");
    } catch (e) {
      ctx.reply(e.message);
    }
  },
};

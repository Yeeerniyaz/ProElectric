/**
 * @file src/handlers/AdminHandler.js
 * @description Контроллер панели администратора (Enterprise CRM Controller).
 * Реализует полный цикл управления бизнесом, персоналом и системой.
 * Включает FSM (Finite State Machine) для безопасного ввода метаданных.
 * Архитектура: Monolithic Controller with Direct DB Access for Analytics.
 *
 * @author ProElectric Team
 * @version 7.5.0 (Senior Architect Edition)
 */

import { Markup } from "telegraf";
import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";
import * as db from "../database/index.js";
import os from "os";

// =============================================================================
// 🔧 INTERNAL CONSTANTS & CONFIGURATION
// =============================================================================

const ROLES = Object.freeze({
  OWNER: "owner",
  ADMIN: "admin",
  MANAGER: "manager",
  USER: "user",
  BANNED: "banned",
});

const BUTTONS = Object.freeze({
  // Главное меню
  DASHBOARD: "📊 P&L Отчет",
  ORDERS: "📦 Управление заказами",
  SETTINGS: "⚙️ Настройки цен",
  STAFF: "👥 Персонал",

  // Owner Exclusive
  SQL_CONSOLE: "👨‍💻 SQL Терминал",
  BACKUP: "💾 Бэкап базы",
  SERVER_STATS: "🖥 Состояние сервера",

  // Навигация
  BACK: "🔙 В главное меню",
  REFRESH: "🔄 Обновить данные",
});

// Состояния администратора (FSM) для ввода дополнительных данных
export const ADMIN_STATES = Object.freeze({
  IDLE: "IDLE",
  WAIT_ADDRESS: "WAIT_ADDRESS",
  WAIT_COMMENT: "WAIT_COMMENT",
});

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
   * Клавиатура управления конкретным заказом.
   * Динамически меняется в зависимости от статуса.
   */
  orderControl: (orderId, status) => {
    const actions = [];

    // Логика переходов (State Machine Transition UI)
    if (status === "new") {
      actions.push([
        Markup.button.callback(
          "👷 Взять в работу",
          `status_${orderId}_processing`,
        ),
      ]);
      // ИЗМЕНЕНИЕ: Теперь мы не просто отменяем, а спрашиваем причину
      actions.push([
        Markup.button.callback("❌ Отклонить", `prompt_cancel_${orderId}`),
      ]);
    } else if (status === "processing") {
      actions.push([
        Markup.button.callback("🛠 Начать монтаж", `status_${orderId}_work`),
      ]);
      actions.push([
        Markup.button.callback("❌ Отклонить", `prompt_cancel_${orderId}`),
      ]);
      actions.push([
        Markup.button.callback("↩️ Вернуть в новые", `status_${orderId}_new`),
      ]);
    } else if (status === "work") {
      actions.push([
        Markup.button.callback("✅ Завершить заказ", `status_${orderId}_done`),
      ]);
      actions.push([
        Markup.button.callback("💸 Добавить расход", `expense_${orderId}`),
      ]);
    } else if (status === "done") {
      actions.push([
        Markup.button.callback("📜 Скачать акт", `download_${orderId}`),
      ]);
    }

    // ИЗМЕНЕНИЕ: Кнопки добавления Адреса и Комментария доступны для всех активных статусов
    if (status !== "cancel" && status !== "archived") {
      actions.push([
        Markup.button.callback("📍 Указать адрес", `prompt_address_${orderId}`),
        Markup.button.callback("📝 Комментарий", `prompt_comment_${orderId}`),
      ]);
    }

    return Markup.inlineKeyboard(actions);
  },

  /**
   * Клавиатура выбора причины отказа
   */
  cancelReasonControl: (orderId) => {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "👤 Отказ: Клиент передумал",
          `cancel_reason_${orderId}_client`,
        ),
      ],
      [
        Markup.button.callback(
          "🏢 Отказ: Наша Фирма",
          `cancel_reason_${orderId}_firm`,
        ),
      ],
      [
        Markup.button.callback(
          "🔙 Вернуться к заказу",
          `refresh_order_${orderId}`,
        ),
      ],
    ]);
  },

  refresh: Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Обновить", "admin_refresh_dashboard")],
  ]),
};

// =============================================================================
// 🎮 CONTROLLER IMPLEMENTATION
// =============================================================================

export const AdminHandler = {
  /**
   * ===========================================================================
   * 1. 🚦 ENTRY POINT & ROUTING
   * ===========================================================================
   */

  async showAdminMenu(ctx) {
    try {
      const userId = ctx.from.id;
      const role = await UserService.getUserRole(userId);

      if (![ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER].includes(role)) {
        return ctx.reply(
          "⛔ <b>Доступ запрещен.</b>\nОбратитесь к администратору.",
          { parse_mode: "HTML" },
        );
      }

      // Сбрасываем любые зависшие стейты ввода
      if (ctx.session) ctx.session.adminState = ADMIN_STATES.IDLE;

      await ctx.replyWithHTML(
        `💼 <b>ПАНЕЛЬ УПРАВЛЕНИЯ</b>\n` +
          `👤 Пользователь: <b>${ctx.from.first_name}</b>\n` +
          `🔑 Уровень доступа: <code>${role.toUpperCase()}</code>\n\n` +
          `Выберите модуль управления:`,
        AdminKeyboards.mainMenu(role),
      );
    } catch (e) {
      console.error("[AdminHandler] Init Error:", e);
      ctx.reply("⚠️ Ошибка инициализации панели.");
    }
  },

  async handleMessage(ctx) {
    const text = ctx.message?.text;
    if (!text) return;

    const userId = ctx.from.id;
    const role = await UserService.getUserRole(userId);

    // Security Guard
    if (![ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER].includes(role)) return;

    // --- FSM (STATE MACHINE) INTERCEPTOR ---
    const state = ctx.session?.adminState || ADMIN_STATES.IDLE;

    // Прерывание ввода
    if (text === BUTTONS.BACK || text.toLowerCase() === "отмена") {
      if (state !== ADMIN_STATES.IDLE) {
        ctx.session.adminState = ADMIN_STATES.IDLE;
        await ctx.reply("❌ Действие отменено.");
        // Возвращаем главное меню админа или просто игнорируем, позволяя коду идти дальше
        if (text.toLowerCase() === "отмена") return;
      }
    }

    // Маршрутизация по состояниям
    if (state === ADMIN_STATES.WAIT_ADDRESS) {
      return this.processAddressInput(ctx);
    }
    if (state === ADMIN_STATES.WAIT_COMMENT) {
      return this.processCommentInput(ctx);
    }

    // --- REGULAR COMMAND ROUTER ---
    if (text === BUTTONS.DASHBOARD) return this.showDashboard(ctx);
    if (text === BUTTONS.ORDERS) return this.showOrdersInstruction(ctx);
    if (text === BUTTONS.SETTINGS) return this.showSettings(ctx);
    if (text === BUTTONS.STAFF) return this.showStaffList(ctx);

    // Owner Only Routes
    if (role === ROLES.OWNER) {
      if (text === BUTTONS.SQL_CONSOLE) return this.showSQLInstruction(ctx);
      if (text === BUTTONS.BACKUP) return this.processBackup(ctx);
      if (text === BUTTONS.SERVER_STATS) return this.showServerStats(ctx);
    }

    // Navigation
    if (text === BUTTONS.BACK) {
      return ctx.reply(
        "🏠 Главное меню",
        Markup.keyboard([
          ["🚀 Рассчитать стоимость"],
          ["📂 Мои заявки", "💰 Прайс-лист"],
          ["📞 Контакты", "ℹ️ Как мы работаем"],
          ["👑 Админ-панель"],
        ]).resize(),
      );
    }

    // Context Commands
    if (text.startsWith("/setprice")) return this.processSetPrice(ctx);
    if (text.startsWith("/setrole")) return this.processSetRole(ctx);
    if (text.startsWith("/sql") && role === ROLES.OWNER)
      return this.processSQL(ctx);
    if (text.startsWith("/order")) return this.findOrder(ctx);
  },

  /**
   * ===========================================================================
   * 2. 📊 ANALYTICS DASHBOARD (P&L)
   * ===========================================================================
   */

  async showDashboard(ctx) {
    const loading = await ctx.reply("⏳ Сбор аналитики...");

    try {
      const query = `
        SELECT 
          COUNT(*) as total_count,
          COUNT(*) FILTER (WHERE status = 'new') as new_count,
          COUNT(*) FILTER (WHERE status = 'processing') as processing_count,
          COUNT(*) FILTER (WHERE status = 'work') as work_count,
          COUNT(*) FILTER (WHERE status = 'done') as done_count,
          COUNT(*) FILTER (WHERE status = 'cancel') as cancel_count,
          COALESCE(SUM(total_price) FILTER (WHERE status = 'done'), 0) as revenue,
          COALESCE(SUM((details->'total'->>'material_info')::numeric) FILTER (WHERE status = 'done'), 0) as material_cost
        FROM orders
      `;

      const res = await db.query(query);
      const data = res.rows[0];

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
        data.done_count > 0 ? (revenue / data.done_count).toFixed(0) : 0;

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      const report =
        `📊 <b>ФИНАНСОВЫЙ ОТЧЕТ (Real-Time)</b>\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `💰 <b>ВЫРУЧКА (За работу):</b> ${fmt(revenue)} ₸\n` +
        `📉 <i>Расход (Мат. прогноз): ~${fmt(materials)} ₸</i>\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `📈 <b>KPI Продаж:</b>\n` +
        `• Конверсия: <b>${conversion}%</b>\n` +
        `• Средний чек (Работа): <b>${fmt(aov)} ₸</b>\n` +
        `• Всего лидов: <b>${data.total_count}</b>\n\n` +
        `📂 <b>Воронка заказов:</b>\n` +
        `🆕 Новые: ${data.new_count}\n` +
        `👨‍🔧 В обработке: ${data.processing_count}\n` +
        `🛠 В работе: ${data.work_count}\n` +
        `✅ Завершены: ${data.done_count}\n` +
        `❌ Отмены: ${data.cancel_count}`;

      // В зависимости от того, как вызвали (команда или коллбэк), обновляем или шлем новое
      if (ctx.callbackQuery) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          null,
          report,
          {
            parse_mode: "HTML",
            reply_markup: AdminKeyboards.refresh.reply_markup,
          },
        );
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loading.message_id,
          null,
          report,
          {
            parse_mode: "HTML",
            reply_markup: AdminKeyboards.refresh.reply_markup,
          },
        );
      }
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

  /**
   * ===========================================================================
   * 3. 📦 ORDER MANAGEMENT SYSTEM & METADATA
   * ===========================================================================
   */

  async showOrdersInstruction(ctx) {
    await ctx.replyWithHTML(
      `📦 <b>ЦЕНТР УПРАВЛЕНИЯ ЗАКАЗАМИ</b>\n\n` +
        `🔎 <b>Поиск заказа:</b>\n` +
        `Введите команду: <code>/order ID</code>\n` +
        `<i>Пример: /order 15</i>\n\n` +
        `📋 <b>Действия:</b>\n` +
        `• Смена статусов (New -> Work -> Done)\n` +
        `• Просмотр сметы и контактов\n` +
        `• Добавление адреса и комментариев\n` +
        `• Фиксация причин отмены`,
    );
  },

  async findOrder(ctx) {
    const text = ctx.message?.text || ctx.callbackQuery?.data; // Обработка и команд и коллбэков (refresh)
    let orderId;

    if (text.startsWith("/order")) {
      orderId = text.split(" ")[1];
    } else if (text.startsWith("refresh_order_")) {
      orderId = text.split("_")[2];
    }

    if (!orderId || isNaN(orderId)) {
      return ctx.reply(
        "⚠️ Некорректный ID заказа. Используйте: /order <число>",
      );
    }

    try {
      const res = await db.query(
        `SELECT o.*, u.first_name, u.username, u.phone 
             FROM orders o 
             JOIN users u ON o.user_id = u.telegram_id 
             WHERE o.id = $1`,
        [orderId],
      );

      if (res.rows.length === 0) {
        return ctx.reply("❌ Заказ не найден.");
      }

      const order = res.rows[0];
      const details = order.details || {};
      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      const statusEmoji = {
        new: "🆕",
        processing: "⏳",
        work: "🛠",
        done: "✅",
        cancel: "❌",
      };

      // ИЗМЕНЕНИЕ: Форматируем новые поля JSONB (Адрес, Коммент, Причина отказа)
      const addressLine = details.address
        ? `\n📍 <b>Адрес:</b> ${details.address}`
        : `\n📍 <b>Адрес:</b> <i>Не указан</i>`;
      const commentLine = details.comment
        ? `\n📝 <b>Комментарий:</b> <i>${details.comment}</i>`
        : ``;

      let cancelLine = ``;
      if (order.status === "cancel") {
        const reasonStr =
          details.cancel_reason === "client"
            ? "Отказ клиента"
            : details.cancel_reason === "firm"
              ? "Отказала фирма"
              : "Не указана";
        cancelLine = `\n⚠️ <b>Причина отмены:</b> ${reasonStr}\n`;
      }

      const info =
        `📦 <b>ЗАКАЗ #${order.id}</b>\n` +
        `Статус: <b>${statusEmoji[order.status] || "❓"} ${order.status.toUpperCase()}</b>\n` +
        `Дата: ${new Date(order.created_at).toLocaleString("ru-RU")}\n` +
        cancelLine +
        `\n👤 <b>Клиент:</b>\n` +
        `Имя: ${order.first_name}\n` +
        `Тел: <code>${order.phone || "Не указан"}</code>\n` +
        `TG: @${order.username || "N/A"}\n` +
        addressLine +
        commentLine +
        `\n\n` +
        `🏠 <b>Объект:</b>\n` +
        `Площадь: ${details.params?.area} м²\n` +
        `Комнат: ${details.params?.rooms}\n` +
        `Стены: ${details.params?.wallType}\n\n` +
        `💰 <b>Финансы:</b>\n` +
        `Стоимость работ: <b>${fmt(order.total_price)} ₸</b>\n` +
        `<i>Прогноз мат. (справочно): ~${fmt(details.total?.material_info || 0)} ₸</i>`;

      if (ctx.callbackQuery) {
        await ctx.editMessageText(info, {
          parse_mode: "HTML",
          reply_markup: AdminKeyboards.orderControl(order.id, order.status)
            .reply_markup,
        });
        await ctx.answerCbQuery();
      } else {
        await ctx.replyWithHTML(
          info,
          AdminKeyboards.orderControl(order.id, order.status),
        );
      }
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка при поиске заказа.");
    }
  },

  async handleOrderStatusChange(ctx, orderId, newStatus) {
    try {
      await db.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, orderId],
      );

      await ctx.answerCbQuery(`✅ Статус изменен: ${newStatus.toUpperCase()}`);

      // Авто-обновление карточки заказа
      ctx.callbackQuery.data = `refresh_order_${orderId}`;
      return this.findOrder(ctx);
    } catch (e) {
      console.error(e);
      ctx.answerCbQuery("❌ Ошибка смены статуса");
    }
  },

  // --- ACTIONS: ADDRESS & COMMENTS (FSM Logic) ---

  async promptAddress(ctx, orderId) {
    ctx.session.adminState = ADMIN_STATES.WAIT_ADDRESS;
    ctx.session.targetOrderId = orderId;
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `📍 <b>Заказ #${orderId}</b>\nВведите адрес объекта (Улица, Дом, Кв):\n<i>(Или напишите "Отмена")</i>`,
    );
  },

  async processAddressInput(ctx) {
    const orderId = ctx.session.targetOrderId;
    const address = ctx.message.text;

    try {
      await OrderService.updateOrderDetails(orderId, "address", address);
      ctx.session.adminState = ADMIN_STATES.IDLE;
      await ctx.reply(`✅ Адрес для заказа #${orderId} успешно сохранен.`);

      // Имитируем запрос для обновления карточки заказа
      ctx.message.text = `/order ${orderId}`;
      return this.findOrder(ctx);
    } catch (e) {
      ctx.reply("❌ Ошибка при сохранении адреса.");
    }
  },

  async promptComment(ctx, orderId) {
    ctx.session.adminState = ADMIN_STATES.WAIT_COMMENT;
    ctx.session.targetOrderId = orderId;
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `📝 <b>Заказ #${orderId}</b>\nВведите ваш комментарий (заметку):\n<i>(Или напишите "Отмена")</i>`,
    );
  },

  async processCommentInput(ctx) {
    const orderId = ctx.session.targetOrderId;
    const comment = ctx.message.text;

    try {
      await OrderService.updateOrderDetails(orderId, "comment", comment);
      ctx.session.adminState = ADMIN_STATES.IDLE;
      await ctx.reply(`✅ Комментарий к заказу #${orderId} успешно сохранен.`);

      ctx.message.text = `/order ${orderId}`;
      return this.findOrder(ctx);
    } catch (e) {
      ctx.reply("❌ Ошибка при сохранении комментария.");
    }
  },

  // --- ACTIONS: CANCEL ORDER (Split Reason) ---

  async promptCancel(ctx, orderId) {
    await ctx.editMessageText(
      `⚠️ <b>Подтверждение отмены заказа #${orderId}</b>\n\nУкажите, по чьей инициативе произошла отмена:`,
      {
        parse_mode: "HTML",
        reply_markup: AdminKeyboards.cancelReasonControl(orderId).reply_markup,
      },
    );
  },

  async processCancelReason(ctx, orderId, reason) {
    try {
      // 1. Сохраняем причину в JSONB
      await OrderService.updateOrderDetails(orderId, "cancel_reason", reason);
      // 2. Меняем статус на cancel
      await db.query(
        `UPDATE orders SET status = 'cancel', updated_at = NOW() WHERE id = $1`,
        [orderId],
      );

      await ctx.answerCbQuery("✅ Заказ успешно отменен.");

      ctx.callbackQuery.data = `refresh_order_${orderId}`;
      return this.findOrder(ctx);
    } catch (e) {
      console.error(e);
      ctx.answerCbQuery("❌ Ошибка отмены заказа");
    }
  },

  /**
   * ===========================================================================
   * 4. 👥 STAFF MANAGEMENT (RBAC)
   * ===========================================================================
   */

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

  async processSetRole(ctx) {
    const args = ctx.message.text.split(" ");
    if (args.length < 3) return ctx.reply("⚠️ Формат: /setrole <ID> <ROLE>");

    const targetId = args[1];
    const newRole = args[2].toLowerCase();
    const validRoles = Object.values(ROLES);

    if (!validRoles.includes(newRole)) {
      return ctx.reply(
        `❌ Недопустимая роль. Используйте: ${validRoles.join(", ")}`,
      );
    }

    try {
      if (String(targetId) === String(ctx.from.id)) {
        return ctx.reply("⛔ Нельзя менять роль самому себе.");
      }

      await UserService.changeUserRole(ctx.from.id, targetId, newRole);

      await ctx.reply(
        `✅ Пользователю <code>${targetId}</code> назначена роль <b>${newRole.toUpperCase()}</b>`,
        { parse_mode: "HTML" },
      );

      ctx.telegram
        .sendMessage(
          targetId,
          `⚡️ Ваши права в системе обновлены: <b>${newRole.toUpperCase()}</b>`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
    } catch (e) {
      ctx.reply(`❌ Ошибка: ${e.message}`);
    }
  },

  /**
   * ===========================================================================
   * 5. ⚙️ DYNAMIC PRICING ENGINE
   * ===========================================================================
   */

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
      msg += `<i>Пример: /setprice price_cable 450</i>\n\n`;

      // ИЗМЕНЕНИЕ: Добавлено четкое предупреждение для администратора
      msg += `⚠️ <b>ВНИМАНИЕ:</b> Любые изменения цен здесь <b>МОМЕНТАЛЬНО</b> применяются к калькулятору в боте для всех новых клиентов.`;

      await ctx.replyWithHTML(msg);
    } catch (e) {
      ctx.reply("❌ Ошибка загрузки настроек.");
    }
  },

  async processSetPrice(ctx) {
    const args = ctx.message.text.split(" ");
    if (args.length < 3) return ctx.reply("⚠️ Формат: /setprice <KEY> <VALUE>");

    const key = args[1];
    const value = args[2];

    try {
      await db.query(
        `
            INSERT INTO settings (key, value, updated_at) 
            VALUES ($1, $2, NOW()) 
            ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
        `,
        [key, value],
      );

      await ctx.reply(
        `✅ Настройка <b>${key}</b> успешно обновлена до <b>${value}</b>`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка записи в базу данных.");
    }
  },

  /**
   * ===========================================================================
   * 6. 🛠 DEVOPS TOOLS (OWNER ONLY)
   * ===========================================================================
   */

  async showServerStats(ctx) {
    const uptime = os.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    const memTotal = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
    const memFree = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
    const load = os.loadavg()[0].toFixed(2);

    try {
      const start = Date.now();
      await db.query("SELECT 1");
      const dbPing = Date.now() - start;

      await ctx.replyWithHTML(
        `🖥 <b>СИСТЕМНЫЙ МОНИТОР</b>\n` +
          `➖➖➖➖➖➖➖➖➖➖\n` +
          `⏱ <b>Uptime:</b> ${hours}ч ${minutes}м\n` +
          `💾 <b>RAM:</b> ${memFree} GB free / ${memTotal} GB total\n` +
          `⚙️ <b>CPU Load:</b> ${load}\n` +
          `🔌 <b>DB Ping:</b> ${dbPing}ms\n` +
          `🐧 <b>OS:</b> ${os.type()} ${os.release()}`,
      );
    } catch (e) {
      ctx.reply("❌ Ошибка получения метрик.");
    }
  },

  async processBackup(ctx) {
    const loading = await ctx.reply("💾 Создание полного дампа БД...");
    try {
      const tables = ["users", "orders", "settings"];
      const dump = { timestamp: new Date(), data: {} };

      for (const table of tables) {
        const res = await db.query(`SELECT * FROM ${table}`);
        dump.data[table] = res.rows;
      }

      const json = JSON.stringify(dump, null, 2);
      const buffer = Buffer.from(json, "utf-8");
      const filename = `backup_${new Date().toISOString().slice(0, 10)}.json`;

      await ctx.replyWithDocument(
        { source: buffer, filename: filename },
        { caption: "✅ Бэкап успешно создан." },
      );
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
    } catch (e) {
      ctx.reply(`❌ Ошибка бэкапа: ${e.message}`);
    }
  },

  async showSQLInstruction(ctx) {
    await ctx.replyWithHTML(
      `👨‍💻 <b>SQL TERMINAL</b>\n\n` +
        `Прямой доступ к базе данных Postgres.\n` +
        `⚠️ <b>Осторожно:</b> изменения необратимы.\n\n` +
        `📝 Введите запрос после команды /sql:\n` +
        `<code>/sql SELECT * FROM users LIMIT 5</code>`,
    );
  },

  async processSQL(ctx) {
    const query = ctx.message.text.replace(/^\/sql\s+/, "").trim();
    if (!query) return ctx.reply("⚠️ Запрос пуст.");

    const start = Date.now();
    try {
      const res = await db.query(query);
      const time = Date.now() - start;

      let msg = `✅ <b>SQL SUCCESS</b> (${time}ms)\n`;
      msg += `Rows affected: ${res.rowCount}\n\n`;

      if (res.rows.length > 0) {
        const json = JSON.stringify(res.rows, null, 2);
        if (json.length > 4000) {
          const buffer = Buffer.from(json, "utf-8");
          await ctx.replyWithDocument({
            source: buffer,
            filename: "query_result.json",
          });
        } else {
          msg += `<pre>${json}</pre>`;
          await ctx.replyWithHTML(msg);
        }
      } else {
        msg += `<i>(Нет данных для отображения)</i>`;
        await ctx.replyWithHTML(msg);
      }
    } catch (e) {
      await ctx.replyWithHTML(`❌ <b>SQL ERROR</b>\n<pre>${e.message}</pre>`);
    }
  },
};

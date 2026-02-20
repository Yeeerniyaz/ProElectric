/**
 * @file src/handlers/AdminHandler.js
 * @description Контроллер панели администратора (Enterprise Telegram Controller v10.1.0).
 * Управляет бизнес-процессами (Смена статусов, Дашборд, Роли, Настройки цен, Бригады).
 * Включает FSM для ввода метаданных заказа и инструменты DevOps (SQL, Backup).
 * Интегрирован с WebSockets для передачи real-time событий в Web CRM.
 * ДОБАВЛЕН БЛОК CASH FLOW: Подтверждение инкассации и списание долгов бригад.
 *
 * @module AdminHandler
 * @version 10.1.0 (Senior Architect Edition - ERP & WebSockets & Cash Flow)
 */

import { Markup } from "telegraf";
import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";
import * as db from "../database/index.js";
import { getSocketIO } from "../bot.js"; // Интеграция с WebSockets
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
  DASHBOARD: "📊 Финансовый Отчет",
  ORDERS: "📦 Реестр объектов",
  BRIGADES: "🏗 Управление Бригадами",
  SETTINGS: "⚙️ Настройки цен",
  STAFF: "👥 Персонал",
  SQL_CONSOLE: "👨‍💻 SQL Терминал",
  BACKUP: "💾 Дамп базы",
  SERVER_STATS: "🖥 Статус сервера",
  BACK: "🔙 В главное меню",
});

export const ADMIN_STATES = Object.freeze({
  IDLE: "IDLE",
  WAIT_ADDRESS: "WAIT_ADDRESS",
  WAIT_COMMENT: "WAIT_COMMENT",
});

const WALL_NAMES = Object.freeze({
  wall_gas: "Газоблок / ГКЛ",
  wall_brick: "Кирпич",
  wall_concrete: "Бетон / Монолит",
});

// =============================================================================
// 🎹 KEYBOARDS FACTORY
// =============================================================================

const AdminKeyboards = {
  mainMenu: (role) => {
    const buttons = [
      [BUTTONS.DASHBOARD, BUTTONS.ORDERS],
      [BUTTONS.BRIGADES, BUTTONS.SETTINGS],
      [BUTTONS.STAFF],
    ];

    if (role === ROLES.OWNER) {
      buttons.push([BUTTONS.SQL_CONSOLE, BUTTONS.BACKUP]);
      buttons.push([BUTTONS.SERVER_STATS]);
    }

    buttons.push([BUTTONS.BACK]);
    return Markup.keyboard(buttons).resize();
  },

  orderControl: (orderId, status) => {
    const actions = [];

    // FSM Статусов заказа (Стейт-машина)
    switch (status) {
      case "new":
      case "draft":
        actions.push([
          Markup.button.callback(
            "👷 Взять в расчет/замер",
            `status_${orderId}_processing`,
          ),
        ]);
        actions.push([
          Markup.button.callback(
            "❌ Отклонить (Отказ)",
            `prompt_cancel_${orderId}`,
          ),
        ]);
        break;
      case "processing":
        actions.push([
          Markup.button.callback("🛠 Начать монтаж", `status_${orderId}_work`),
        ]);
        actions.push([
          Markup.button.callback(
            "❌ Отклонить (Отказ)",
            `prompt_cancel_${orderId}`,
          ),
        ]);
        actions.push([
          Markup.button.callback("↩️ Вернуть в новые", `status_${orderId}_new`),
        ]);
        break;
      case "work":
        actions.push([
          Markup.button.callback(
            "✅ Завершить объект",
            `status_${orderId}_done`,
          ),
        ]);
        break;
    }

    if (!["cancel", "archived", "done"].includes(status)) {
      actions.push([
        Markup.button.callback("📍 Указать адрес", `prompt_address_${orderId}`),
        Markup.button.callback(
          "📝 Заметка (Внутр.)",
          `prompt_comment_${orderId}`,
        ),
      ]);
    }

    actions.push([
      Markup.button.callback("🔄 Обновить данные", `refresh_order_${orderId}`),
    ]);

    return Markup.inlineKeyboard(actions);
  },

  cancelReasonControl: (orderId) => {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "👤 Отказ по инициативе клиента",
          `cancel_reason_${orderId}_client`,
        ),
      ],
      [
        Markup.button.callback(
          "🏢 Отказ фирмы (нет мастеров/далеко)",
          `cancel_reason_${orderId}_firm`,
        ),
      ],
      [
        Markup.button.callback(
          "🔙 Назад к объекту",
          `refresh_order_${orderId}`,
        ),
      ],
    ]);
  },

  refresh: Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔄 Синхронизировать БД",
        "admin_refresh_dashboard",
      ),
    ],
  ]),
};

// =============================================================================
// 🎮 CONTROLLER IMPLEMENTATION
// =============================================================================

export const AdminHandler = {
  /**
   * 1. 🚦 ВХОД В ПАНЕЛЬ И МАРШРУТИЗАЦИЯ
   */
  async showAdminMenu(ctx) {
    try {
      const userId = ctx.from.id;
      const role = await UserService.getUserRole(userId);

      if (![ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER].includes(role)) {
        return ctx.reply(
          "⛔ <b>Доступ запрещен.</b> Уровень прав недостаточен.",
          { parse_mode: "HTML" },
        );
      }

      if (ctx.session) ctx.session.adminState = ADMIN_STATES.IDLE;

      await ctx.replyWithHTML(
        `💼 <b>ProElectric ERP Terminal</b>\n` +
          `👤 Пользователь: <b>${ctx.from.first_name}</b>\n` +
          `🔑 Уровень доступа: <code>${role.toUpperCase()}</code>\n\n` +
          `Выберите директорию для управления системой:`,
        AdminKeyboards.mainMenu(role),
      );
    } catch (e) {
      console.error("[AdminHandler] Init Error:", e);
      ctx.reply("⚠️ Критическая ошибка инициализации панели управления.");
    }
  },

  async handleMessage(ctx) {
    const text = ctx.message?.text;
    if (!text) return;

    const userId = ctx.from.id;
    const role = await UserService.getUserRole(userId);

    if (![ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER].includes(role)) return;

    const state = ctx.session?.adminState || ADMIN_STATES.IDLE;

    // Глобальная отмена действий
    if (text === BUTTONS.BACK || text.toLowerCase() === "отмена") {
      if (state !== ADMIN_STATES.IDLE) {
        ctx.session.adminState = ADMIN_STATES.IDLE;
        await ctx.reply("❌ Процесс прерван.");
        if (text.toLowerCase() === "отмена") return;
      }
    }

    // Обработка FSM состояний
    if (state === ADMIN_STATES.WAIT_ADDRESS)
      return this.processAddressInput(ctx);
    if (state === ADMIN_STATES.WAIT_COMMENT)
      return this.processCommentInput(ctx);

    // Маршрутизация по кнопкам
    switch (text) {
      case BUTTONS.DASHBOARD:
        return this.showDashboard(ctx);
      case BUTTONS.ORDERS:
        return this.showOrdersInstruction(ctx);
      case BUTTONS.BRIGADES:
        return this.showBrigadesInstruction(ctx);
      case BUTTONS.SETTINGS:
        return this.showSettings(ctx);
      case BUTTONS.STAFF:
        return this.showStaffList(ctx);
      case BUTTONS.BACK:
        return ctx.reply(
          "🏠 Главное меню",
          Markup.keyboard([
            ["🚀 Рассчитать стоимость"],
            ["📂 Мои заявки", "💰 Прайс-лист"],
            ["📞 Контакты", "ℹ️ Как мы работаем"],
            ["👑 Админ-панель", "🔑 Доступ в Web CRM"],
          ]).resize(),
        );
    }

    // Owner / Admin Exclusive Routes
    if ([ROLES.OWNER, ROLES.ADMIN].includes(role)) {
      if (text.startsWith("/addbrigade")) return this.processAddBrigade(ctx);
    }

    // Owner Exclusive Routes
    if (role === ROLES.OWNER) {
      if (text === BUTTONS.SQL_CONSOLE) return this.showSQLInstruction(ctx);
      if (text === BUTTONS.BACKUP) return this.processBackup(ctx);
      if (text === BUTTONS.SERVER_STATS) return this.showServerStats(ctx);
      if (text.startsWith("/sql")) return this.processSQL(ctx);
    }

    // Текстовые команды
    if (text.startsWith("/setprice")) return this.processSetPrice(ctx);
    if (text.startsWith("/setrole")) return this.processSetRole(ctx);
    if (text.startsWith("/order")) return this.findOrder(ctx);
  },

  /**
   * 2. 📊 ERP ДАШБОРД (NET PROFIT CALCULUS v9.1)
   */
  async showDashboard(ctx) {
    let loadingMsgId;
    if (!ctx.callbackQuery) {
      const loading = await ctx.reply(
        "⏳ Агрегация финансовых данных из базы...",
      );
      loadingMsgId = loading.message_id;
    }

    try {
      // Прямой запрос с вычислением JSONB полей для максимальной производительности
      const query = `
        SELECT 
          COUNT(*) as total_count,
          COUNT(*) FILTER (WHERE status IN ('new', 'draft')) as new_count,
          COUNT(*) FILTER (WHERE status = 'processing') as processing_count,
          COUNT(*) FILTER (WHERE status = 'work') as work_count,
          COUNT(*) FILTER (WHERE status = 'done') as done_count,
          COUNT(*) FILTER (WHERE status = 'cancel') as cancel_count,
          COALESCE(SUM(total_price) FILTER (WHERE status = 'done'), 0) as gross_revenue,
          COALESCE(SUM(COALESCE((details->'financials'->>'net_profit')::numeric, total_price)) FILTER (WHERE status = 'done'), 0) as net_profit,
          COALESCE(SUM((details->'financials'->>'total_expenses')::numeric) FILTER (WHERE status = 'done'), 0) as total_expenses
        FROM orders
      `;

      const res = await db.query(query);
      const data = res.rows[0];

      const gross = parseFloat(data.gross_revenue);
      const net = parseFloat(data.net_profit);
      const expenses = parseFloat(data.total_expenses);

      const margin = gross > 0 ? ((net / gross) * 100).toFixed(1) : 0;
      const conversion =
        data.total_count > 0
          ? ((data.done_count / data.total_count) * 100).toFixed(1)
          : 0;

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      const report =
        `📊 <b>СВОДКА PROELECTRIC (Real-Time)</b>\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `💵 Оборот (Выручка): <b>${fmt(gross)} ₸</b>\n` +
        `📉 Сумма расходов: <b style="color:red">${fmt(expenses)} ₸</b>\n` +
        `💎 <b>ЧИСТАЯ ПРИБЫЛЬ: ${fmt(net)} ₸</b>\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `📈 <b>Бизнес Метрики:</b>\n` +
        `• Маржинальность: <b>${margin}%</b>\n` +
        `• Конверсия (Win Rate): <b>${conversion}%</b>\n` +
        `• Всего лидов в системе: <b>${data.total_count}</b>\n\n` +
        `📂 <b>Пайплайн объектов:</b>\n` +
        `🆕 Новые: ${data.new_count}\n` +
        `👨‍🔧 На замере: ${data.processing_count}\n` +
        `🛠 На монтаже: ${data.work_count}\n` +
        `✅ Завершены: ${data.done_count}\n` +
        `❌ Отказы: ${data.cancel_count}`;

      if (ctx.callbackQuery) {
        try {
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
          await ctx.answerCbQuery("✅ Данные синхронизированы");
        } catch (editError) {
          if (
            editError.description &&
            editError.description.includes("message is not modified")
          ) {
            await ctx.answerCbQuery("🔄 Данные актуальны (изменений нет)", {
              show_alert: false,
            });
          } else {
            console.error(editError);
            await ctx.answerCbQuery("❌ Ошибка обновления интерфейса");
          }
        }
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMsgId,
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
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery("❌ Ошибка БД");
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMsgId,
          null,
          "❌ Ошибка формирования P&L отчета.",
        );
      }
    }
  },

  /**
   * 3. 📦 УПРАВЛЕНИЕ ЗАКАЗАМИ (ERP INTEGRATION)
   */
  async showOrdersInstruction(ctx) {
    await ctx.replyWithHTML(
      `📦 <b>РЕЕСТР ОБЪЕКТОВ</b>\n\n` +
        `Для управления объектом введите команду <code>/order ID</code>.\n` +
        `<i>Пример: /order 15</i>\n\n` +
        `Карточка заказа содержит полную финансовую аналитику, смету и спецификацию материалов (BOM). ` +
        `Для добавления чеков и расходов используйте Web CRM.`,
    );
  },

  async findOrder(ctx) {
    const text = ctx.message?.text || ctx.callbackQuery?.data;
    let orderId;

    if (text.startsWith("/order")) {
      orderId = text.split(" ")[1];
    } else if (text.startsWith("refresh_order_")) {
      orderId = text.split("_")[2];
    }

    if (!orderId || isNaN(orderId)) {
      return ctx.reply("⚠️ Укажите валидный числовой ID. Пример: /order 15");
    }

    try {
      const res = await db.query(
        `SELECT o.*, u.first_name, u.username, u.phone, b.name as brigade_name 
         FROM orders o 
         JOIN users u ON o.user_id = u.telegram_id 
         LEFT JOIN brigades b ON o.brigade_id = b.id
         WHERE o.id = $1`,
        [orderId],
      );

      if (res.rows.length === 0)
        return ctx.reply(`❌ Объект #${orderId} не найден в БД.`);

      const order = res.rows[0];
      const details = order.details || {};
      const params = details.params || {};

      const financials = details.financials || {
        final_price: order.total_price,
        total_expenses: 0,
        net_profit: order.total_price,
        expenses: [],
      };

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);
      const wallName =
        WALL_NAMES[params.wallType] || params.wallType || "Не указано";
      const statusEmoji = {
        new: "🆕",
        processing: "⏳",
        work: "🛠",
        done: "✅",
        cancel: "❌",
      };

      const addressLine = details.address
        ? `\n📍 <b>Локация:</b> ${details.address}`
        : `\n📍 <b>Локация:</b> <i>Не указана</i>`;
      const commentLine = details.comment
        ? `\n📝 <b>Заметка:</b> <i>${details.comment}</i>`
        : ``;

      let cancelLine = ``;
      if (order.status === "cancel") {
        const reasonStr =
          details.cancel_reason === "client"
            ? "Инициатива клиента"
            : details.cancel_reason === "firm"
              ? "Отказ фирмы"
              : "Причина не указана";
        cancelLine = `\n⚠️ <b>Отказ:</b> ${reasonStr}\n`;
      }

      const bomCount = details.bom?.length || 0;
      const bomIndicator =
        bomCount > 0 ? `\n📦 <i>BOM Спецификация: ${bomCount} поз.</i>` : "";

      const areaInfo = order.area || params.area || 0;

      const brigadeLine = order.brigade_name
        ? `\n👷‍♂️ <b>Бригада:</b> ${order.brigade_name}`
        : `\n👷‍♂️ <b>Бригада:</b> <i>Свободный объект (Биржа)</i>`;

      const info =
        `🏢 <b>ОБЪЕКТ #${order.id}</b>\n` +
        `Статус: <b>${statusEmoji[order.status] || "❓"} ${order.status.toUpperCase()}</b>\n` +
        `Создан: ${new Date(order.created_at).toLocaleString("ru-RU")}\n` +
        cancelLine +
        `\n👤 <b>Заказчик:</b>\n` +
        `Имя: ${order.first_name}\n` +
        `Тел: <code>${order.phone || "Не указан"}</code>\n` +
        `Telegram: @${order.username || "Нет"}\n` +
        addressLine +
        commentLine +
        `\n\n` +
        `🏗 <b>Технические данные:</b>\n` +
        `Площадь: ${areaInfo} м² | Комнат: ${params.rooms || 0}\n` +
        `Стены: ${wallName}` +
        brigadeLine +
        bomIndicator +
        `\n\n` +
        `💸 <b>Финансовый контроллер:</b>\n` +
        `Итого клиенту: <b>${fmt(financials.final_price)} ₸</b>\n` +
        `Затраты фирмы: <b>${fmt(financials.total_expenses)} ₸</b> <i>(Чеков: ${financials.expenses?.length || 0})</i>\n` +
        `<b>ЧИСТАЯ ПРИБЫЛЬ: ${fmt(financials.net_profit)} ₸</b>`;

      if (ctx.callbackQuery) {
        try {
          await ctx.editMessageText(info, {
            parse_mode: "HTML",
            reply_markup: AdminKeyboards.orderControl(order.id, order.status)
              .reply_markup,
          });
          await ctx.answerCbQuery();
        } catch (e) {
          if (
            e.description &&
            e.description.includes("message is not modified")
          ) {
            await ctx.answerCbQuery("🔄 Данные объекта актуальны");
          }
        }
      } else {
        await ctx.replyWithHTML(
          info,
          AdminKeyboards.orderControl(order.id, order.status),
        );
      }
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка извлечения данных объекта.");
    }
  },

  async handleOrderStatusChange(ctx, orderId, newStatus) {
    try {
      await db.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, orderId],
      );

      const io = getSocketIO();
      if (io) {
        io.emit("order_updated", { orderId, status: newStatus });
      }

      await ctx.answerCbQuery(
        `✅ Статус изменен на: ${newStatus.toUpperCase()}`,
      );

      ctx.callbackQuery.data = `refresh_order_${orderId}`;
      return this.findOrder(ctx);
    } catch (e) {
      ctx.answerCbQuery("❌ Ошибка транзакции статуса");
    }
  },

  async promptAddress(ctx, orderId) {
    ctx.session.adminState = ADMIN_STATES.WAIT_ADDRESS;
    ctx.session.targetOrderId = orderId;
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `📍 <b>Локация объекта #${orderId}</b>\nВведите адрес (улица, дом, квартира):\n<i>Для отмены введите "Отмена"</i>`,
    );
  },

  async processAddressInput(ctx) {
    const orderId = ctx.session.targetOrderId;
    try {
      await OrderService.updateOrderDetails(
        orderId,
        "address",
        ctx.message.text,
      );
      ctx.session.adminState = ADMIN_STATES.IDLE;

      const io = getSocketIO();
      if (io) io.emit("order_updated", { orderId, address_updated: true });

      await ctx.reply(`✅ Адрес успешно зафиксирован.`);
      ctx.message.text = `/order ${orderId}`;
      return this.findOrder(ctx);
    } catch (e) {
      ctx.reply("❌ Ошибка записи JSONB.");
    }
  },

  async promptComment(ctx, orderId) {
    ctx.session.adminState = ADMIN_STATES.WAIT_COMMENT;
    ctx.session.targetOrderId = orderId;
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `📝 <b>Заметка к объекту #${orderId}</b>\nВведите текст (видит только персонал):\n<i>Для отмены введите "Отмена"</i>`,
    );
  },

  async processCommentInput(ctx) {
    const orderId = ctx.session.targetOrderId;
    try {
      await OrderService.updateOrderDetails(
        orderId,
        "comment",
        ctx.message.text,
      );
      ctx.session.adminState = ADMIN_STATES.IDLE;
      await ctx.reply(`✅ Заметка сохранена.`);
      ctx.message.text = `/order ${orderId}`;
      return this.findOrder(ctx);
    } catch (e) {
      ctx.reply("❌ Сбой записи в базу.");
    }
  },

  async promptCancel(ctx, orderId) {
    await ctx.editMessageText(
      `⚠️ <b>Фиксация отказа по объекту #${orderId}</b>\nУкажите инициатора для сохранения чистоты аналитики:`,
      {
        parse_mode: "HTML",
        reply_markup: AdminKeyboards.cancelReasonControl(orderId).reply_markup,
      },
    );
  },

  async processCancelReason(ctx, orderId, reason) {
    try {
      await OrderService.updateOrderDetails(orderId, "cancel_reason", reason);
      await db.query(
        `UPDATE orders SET status = 'cancel', updated_at = NOW() WHERE id = $1`,
        [orderId],
      );

      const io = getSocketIO();
      if (io) io.emit("order_updated", { orderId, status: "cancel" });

      await ctx.answerCbQuery("✅ Отказ оформлен.");

      ctx.callbackQuery.data = `refresh_order_${orderId}`;
      return this.findOrder(ctx);
    } catch (e) {
      ctx.answerCbQuery("❌ Ошибка отмены заказа");
    }
  },

  /**
   * 3.5 🏗 УПРАВЛЕНИЕ БРИГАДАМИ (ERP)
   */
  async showBrigadesInstruction(ctx) {
    try {
      const res = await db.query("SELECT * FROM brigades ORDER BY id ASC");
      const brigades = res.rows;

      let msg = `🏗 <b>УПРАВЛЕНИЕ БРИГАДАМИ (ERP)</b>\n\n`;

      if (brigades.length === 0) {
        msg += `<i>Бригады пока не созданы.</i>\n\n`;
      } else {
        brigades.forEach((b) => {
          msg += `🔹 <b>${b.name}</b> (ID: ${b.id})\n`;
          msg += `   Бригадир ID: <code>${b.brigadier_id}</code> | Доля: ${b.profit_percentage}%\n`;
          msg += `   Статус: ${b.is_active ? "✅ Активна" : "❌ Неактивна"}\n\n`;
        });
      }

      msg += `<b>Как добавить новую бригаду:</b>\n`;
      msg += `Используйте команду:\n<code>/addbrigade [Название] [ID_Бригадира] [Процент_Прибыли]</code>\n`;
      msg += `<i>Пример: /addbrigade Монтажники Альфа 123456789 40</i>\n`;
      msg += `\n⚠️ <i>Бригадир автоматически получит роль MANAGER и системный счет в кассе компании.</i>`;

      await ctx.replyWithHTML(msg);
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка загрузки списка бригад.");
    }
  },

  async processAddBrigade(ctx) {
    const text = ctx.message.text.replace("/addbrigade", "").trim();
    const parts = text.split(" ");

    if (parts.length < 3) {
      return ctx.reply(
        "⚠️ Синтаксис: /addbrigade <Название> <ID_Бригадира> <Процент>\nПример: /addbrigade Монтажники Альфа 123456789 45",
      );
    }

    const percentage = parseFloat(parts.pop());
    const brigadierId = parseInt(parts.pop());
    const name = parts.join(" ");

    if (isNaN(percentage) || isNaN(brigadierId) || !name) {
      return ctx.reply(
        "❌ Ошибка парсинга. Убедитесь, что ID и Процент являются числами.",
      );
    }

    try {
      const newBrigade = await db.createBrigade(name, brigadierId, percentage);
      await ctx.replyWithHTML(
        `✅ <b>Бригада "${newBrigade.name}" успешно создана!</b>\n` +
          `Счет бригады автоматически открыт.\n` +
          `Пользователю <code>${brigadierId}</code> выданы права доступа "MANAGER".`,
      );
    } catch (e) {
      ctx.reply(`❌ Ошибка создания бригады: ${e.message}`);
    }
  },

  /**
   * 4. 👥 ПЕРСОНАЛ (RBAC Control)
   */
  async showStaffList(ctx) {
    try {
      const res = await db.query(`
        SELECT telegram_id, first_name, username, role 
        FROM users WHERE role IN ('owner', 'admin', 'manager')
        ORDER BY role DESC
      `);

      let msg = "👥 <b>МАТРИЦА ПЕРСОНАЛА</b>\n\n";
      res.rows.forEach((u, i) => {
        const icon =
          u.role === "owner" ? "👑" : u.role === "admin" ? "🛡" : "👷‍♂️";
        msg += `${i + 1}. ${icon} <b>${u.first_name}</b> (@${u.username || "Нет"})\n   ID: <code>${u.telegram_id}</code> | Роль: ${u.role.toUpperCase()}\n\n`;
      });

      msg += `Для изменения роли:\n<code>/setrole ID ROLE</code>\n<i>Доступно: admin, manager, user, banned</i>`;
      await ctx.replyWithHTML(msg);
    } catch (e) {
      ctx.reply("❌ Ошибка чтения таблицы пользователей.");
    }
  },

  async processSetRole(ctx) {
    const args = ctx.message.text.split(" ");
    if (args.length < 3) return ctx.reply("⚠️ Синтаксис: /setrole <ID> <ROLE>");
    const targetId = args[1],
      newRole = args[2].toLowerCase();

    try {
      if (String(targetId) === String(ctx.from.id))
        return ctx.reply(
          "⛔ Архитектурный запрет: нельзя изменить роль самому себе.",
        );
      await UserService.changeUserRole(ctx.from.id, targetId, newRole);
      await ctx.reply(
        `✅ ID <code>${targetId}</code> успешно переведен в группу <b>${newRole.toUpperCase()}</b>`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      ctx.reply(`❌ Отклонено: ${e.message}`);
    }
  },

  /**
   * 5. ⚙️ НАСТРОЙКИ (Dynamic Configuration v10.0.0)
   */
  async showSettings(ctx) {
    try {
      const pricelist = await OrderService.getPublicPricelist();

      let msg = "⚙️ <b>ПАНЕЛЬ УПРАВЛЕНИЯ ЦЕНАМИ</b>\n\n";
      msg +=
        "Для изменения цены используйте команду:\n<code>/setprice [ключ] [цена]</code>\n\n";

      if (Array.isArray(pricelist)) {
        pricelist.forEach((section) => {
          msg += `🔸 <b>${section.category}</b>\n`;
          section.items.forEach((item) => {
            msg += `▪️ ${item.name}: <b>${item.currentPrice} ${item.unit}</b>\n`;
            msg += `   Ключ: <code>${item.key}</code>\n`;
          });
          msg += `\n`;
        });
      } else {
        msg += "⚠️ Прайс-лист пуст или имеет неверный формат.";
      }

      await ctx.replyWithHTML(msg);
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка доступа к таблице конфигурации.");
    }
  },

  async processSetPrice(ctx) {
    const args = ctx.message.text.split(" ");
    if (args.length < 3)
      return ctx.reply(
        "⚠️ Синтаксис: /setprice <KEY> <VALUE>\nПример: /setprice price_drill_concrete 600",
      );
    try {
      await db.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [args[1], args[2]],
      );

      const io = getSocketIO();
      if (io) io.emit("settings_updated", { key: args[1], value: args[2] });

      await ctx.reply(
        `✅ Прайс-лист обновлен!\nКлюч <b>${args[1]}</b> = <b>${args[2]}</b>.\n\nИзменения моментально применены в Web CRM и Калькуляторе.`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      ctx.reply("❌ Ошибка I/O базы данных.");
    }
  },

  /**
   * 6. 🛠 DEVOPS (Owner Exclusives)
   */
  async showServerStats(ctx) {
    const memFree = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
    const memTotal = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
    const start = Date.now();
    await db.query("SELECT 1"); // DB Ping
    const ping = Date.now() - start;

    await ctx.replyWithHTML(
      `🖥 <b>HARDWARE & NETWORK СТАТИСТИКА</b>\n` +
        `⏱ Uptime: ${(os.uptime() / 3600).toFixed(1)} часов\n` +
        `💾 Память (RAM): ${memFree} GB свободно из ${memTotal} GB\n` +
        `🔌 PostgreSQL Latency: ${ping} ms\n` +
        `🐧 Архитектура ОС: ${os.type()} ${os.release()} (${os.arch()})`,
    );
  },

  async processBackup(ctx) {
    const loading = await ctx.reply(
      "💾 Инициализация создания Snapshot'а базы данных (v10.0.0)...",
    );
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
          dump.database[table] = (
            await db.query(`SELECT * FROM ${table}`)
          ).rows;
        } catch (e) {
          /* Игнорируем отсутствие таблицы */
        }
      }

      const buffer = Buffer.from(JSON.stringify(dump, null, 2), "utf-8");
      await ctx.replyWithDocument({
        source: buffer,
        filename: `ProElectric_DB_Dump_${Date.now()}.json`,
      });
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
    } catch (e) {
      ctx.reply(`❌ Критический сбой создания дампа: ${e.message}`);
    }
  },

  async showSQLInstruction(ctx) {
    await ctx.replyWithHTML(
      `👨‍💻 <b>POSTGRESQL ТЕРМИНАЛ</b>\n` +
        `Прямой доступ к ядру СУБД. Выполняй любые валидные SQL запросы.\n` +
        `⚠️ <b>Внимание:</b> DML операции (UPDATE, DELETE) выполняются без подтверждения.\n\n` +
        `Синтаксис:\n<code>/sql SELECT id, total_price FROM orders LIMIT 3;</code>`,
    );
  },

  async processSQL(ctx) {
    const query = ctx.message.text.replace(/^\/sql\s+/, "").trim();
    if (!query) return;
    try {
      const start = Date.now();
      const res = await db.query(query);
      let msg = `✅ <b>QUERY EXECUTED</b> (${Date.now() - start} ms)\nRows affected/returned: ${res.rowCount}\n\n`;

      if (res.rows && res.rows.length > 0) {
        const json = JSON.stringify(res.rows, null, 2);
        if (json.length > 3000) {
          await ctx.replyWithDocument({
            source: Buffer.from(json),
            filename: "query_result.json",
          });
        } else {
          await ctx.replyWithHTML(msg + `<pre>${json}</pre>`);
        }
      } else {
        await ctx.replyWithHTML(
          msg + "<i>Запрос выполнен успешно. Пустой возврат (0 строк).</i>",
        );
      }
    } catch (e) {
      await ctx.replyWithHTML(
        `❌ <b>POSTGRES ERROR</b>\n<pre>${e.message}</pre>`,
      );
    }
  },

  // =============================================================================
  // 7. 💸 ИНКАССАЦИЯ (CASH FLOW - NEW)
  // =============================================================================

  /**
   * Подтверждение получения выручки от бригадира.
   * Вызывает финансовую транзакцию, которая списывает долг бригады и зачисляет деньги Владельцу.
   */
  async approveIncassation(ctx, brigadierId, amount) {
    try {
      const fmtAmount = new Intl.NumberFormat("ru-RU").format(amount);

      // Ищем ID счета Владельца (Главная Касса / Наличные)
      const resAcc = await db.query(
        "SELECT id FROM accounts WHERE type = 'cash' ORDER BY id ASC LIMIT 1",
      );
      if (resAcc.rows.length === 0) {
        return ctx.answerCbQuery(
          "❌ Ошибка: Системный счет 'Главная Касса' не найден.",
          { show_alert: true },
        );
      }
      const ownerAccountId = resAcc.rows[0].id;

      // Запускаем строгую SQL транзакцию списания долга
      await db.processIncassation(
        brigadierId,
        parseFloat(amount),
        ownerAccountId,
      );

      // Обновляем сообщение Владельца (чтобы нельзя было нажать дважды)
      await ctx.editMessageText(
        ctx.callbackQuery.message.text +
          `\n\n✅ <b>СТАТУС: ПОДТВЕРЖДЕНО</b>\nДеньги (${fmtAmount} ₸) успешно зачислены в кассу. Долг бригады списан.`,
        { parse_mode: "HTML" },
      );

      // Отправляем радостное уведомление Бригадиру
      await ctx.telegram
        .sendMessage(
          brigadierId,
          `✅ <b>Шеф подтвердил получение ${fmtAmount} ₸!</b>\nСумма успешно списана с вашего долга. Баланс обновлен.`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});

      await ctx.answerCbQuery("✅ Инкассация успешно проведена!");
    } catch (e) {
      console.error("Ошибка подтверждения инкассации:", e);
      ctx.answerCbQuery(`❌ Ошибка базы данных: ${e.message}`, {
        show_alert: true,
      });
    }
  },

  /**
   * Отклонение перевода (если Шеф не получил деньги на Kaspi)
   */
  async rejectIncassation(ctx, brigadierId, amount) {
    try {
      const fmtAmount = new Intl.NumberFormat("ru-RU").format(amount);

      // Меняем интерфейс кнопки на Отклонено
      await ctx.editMessageText(
        ctx.callbackQuery.message.text +
          `\n\n❌ <b>СТАТУС: ОТКЛОНЕНО</b>\nВы указали, что деньги не поступали на ваш счет.`,
        { parse_mode: "HTML" },
      );

      // Уведомляем Бригадира, что перевод не прошел
      await ctx.telegram
        .sendMessage(
          brigadierId,
          `❌ <b>Внимание! Шеф отклонил инкассацию на сумму ${fmtAmount} ₸.</b>\nДолг не списан. Пожалуйста, свяжитесь с руководством для уточнения статуса перевода.`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});

      await ctx.answerCbQuery("❌ Вы отклонили перевод.");
    } catch (e) {
      console.error("Ошибка отклонения инкассации:", e);
      ctx.answerCbQuery("❌ Системная ошибка.");
    }
  },
};

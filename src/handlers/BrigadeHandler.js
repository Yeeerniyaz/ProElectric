/**
 * @file src/handlers/BrigadeHandler.js
 * @description Контроллер интерфейса Бригадиров (ERP Brigade Module v10.0.0).
 * Отвечает за:
 * 1. Биржу заказов (просмотр и взятие свободных лидов).
 * 2. Управление своими объектами (добавление расходов, запрос авансов).
 * 3. Просмотр баланса бригады.
 *
 * @module BrigadeHandler
 * @version 10.0.0 (Enterprise ERP Edition)
 */

import { Markup } from "telegraf";
import { UserService, ROLES } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";
import * as db from "../database/index.js";
import { getSocketIO } from "../bot.js";

// =============================================================================
// 🔧 CONSTANTS & FSM STATES
// =============================================================================

export const BRIGADE_STATES = Object.freeze({
  IDLE: "IDLE",
  WAIT_EXPENSE_AMOUNT: "WAIT_EXPENSE_AMOUNT",
  WAIT_EXPENSE_COMMENT: "WAIT_EXPENSE_COMMENT",
  WAIT_ADVANCE_AMOUNT: "WAIT_ADVANCE_AMOUNT",
});

const BUTTONS = Object.freeze({
  MARKET: "💼 Биржа заказов",
  MY_OBJECTS: "🛠 Мои объекты",
  FINANCE: "💸 Финансы и Авансы",
  BACK: "🔙 В главное меню",
});

// =============================================================================
// 🎹 KEYBOARDS
// =============================================================================

const Keyboards = {
  menu: Markup.keyboard([
    [BUTTONS.MARKET, BUTTONS.MY_OBJECTS],
    [BUTTONS.FINANCE],
    [BUTTONS.BACK],
  ]).resize(),

  orderActions: (orderId) => Markup.inlineKeyboard([
    [Markup.button.callback("🧾 Добавить расход (Чек)", `add_expense_${orderId}`)],
    [Markup.button.callback("💰 Запросить аванс", `req_advance_${orderId}`)],
  ]),

  takeOrderAction: (orderId) => Markup.inlineKeyboard([
    [Markup.button.callback("✅ Взять в работу", `take_order_${orderId}`)]
  ]),
};

// =============================================================================
// 🎮 CONTROLLER IMPLEMENTATION
// =============================================================================

export const BrigadeHandler = {
  /**
   * 1. 🚦 ВХОД И РОУТИНГ
   */
  async showMenu(ctx) {
    try {
      const role = await UserService.getUserRole(ctx.from.id);
      if (role !== ROLES.MANAGER && role !== ROLES.OWNER && role !== ROLES.ADMIN) {
        return ctx.reply("⛔ Доступ запрещен. Вы не являетесь бригадиром.");
      }

      if (ctx.session) ctx.session.brigadeState = BRIGADE_STATES.IDLE;

      const brigade = await db.getBrigadeByManagerId(ctx.from.id);
      const brigadeInfo = brigade 
        ? `\n👷‍♂️ Ваша бригада: <b>${brigade.name}</b> (Доля: ${brigade.profit_percentage}%)` 
        : `\n⚠️ <i>Внимание: Вы пока не привязаны ни к одной бригаде! Обратитесь к администратору.</i>`;

      await ctx.replyWithHTML(
        `🛠 <b>ПАНЕЛЬ БРИГАДИРА (ERP)</b>${brigadeInfo}\n\nВыберите нужный раздел:`,
        Keyboards.menu
      );
    } catch (e) {
      console.error("[BrigadeHandler] Init Error:", e);
      ctx.reply("❌ Системная ошибка загрузки панели бригады.");
    }
  },

  async handleMessage(ctx) {
    const text = ctx.message?.text;
    if (!text) return;

    const state = ctx.session?.brigadeState || BRIGADE_STATES.IDLE;

    // Глобальная отмена
    if (text === BUTTONS.BACK || text.toLowerCase() === "отмена") {
      if (state !== BRIGADE_STATES.IDLE) {
        ctx.session.brigadeState = BRIGADE_STATES.IDLE;
        await ctx.reply("❌ Действие отменено.");
        if (text.toLowerCase() === "отмена") return;
      }
    }

    // FSM Роутинг
    if (state === BRIGADE_STATES.WAIT_EXPENSE_AMOUNT) return this.processExpenseAmount(ctx);
    if (state === BRIGADE_STATES.WAIT_EXPENSE_COMMENT) return this.processExpenseComment(ctx);
    if (state === BRIGADE_STATES.WAIT_ADVANCE_AMOUNT) return this.processAdvanceAmount(ctx);

    // Роутинг по кнопкам
    switch (text) {
      case BUTTONS.MARKET:
        return this.showMarket(ctx);
      case BUTTONS.MY_OBJECTS:
        return this.showMyObjects(ctx);
      case BUTTONS.FINANCE:
        return this.showFinance(ctx);
      case BUTTONS.BACK:
        return ctx.reply("🏠 Главное меню", 
          Markup.keyboard([
            ["🚀 Рассчитать стоимость"],
            ["📂 Мои заявки", "💰 Прайс-лист"],
            ["📞 Контакты", "ℹ️ Как мы работаем"],
            ["👑 Админ-панель", "🔑 Доступ в Web CRM"],
            ["👷 Панель Бригадира"]
          ]).resize()
        );
    }
  },

  /**
   * 2. 💼 БИРЖА ЗАКАЗОВ (Лиды со статусом NEW)
   */
  async showMarket(ctx) {
    try {
      const brigade = await db.getBrigadeByManagerId(ctx.from.id);
      if (!brigade) return ctx.reply("⚠️ Доступ к бирже закрыт: вы не состоите в активной бригаде.");

      const orders = await OrderService.getAvailableNewOrders();
      if (!orders || orders.length === 0) {
        return ctx.reply("📭 В данный момент свободных заказов на бирже нет.");
      }

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      await ctx.replyWithHTML(`💼 <b>ДОСТУПНЫЕ ОБЪЕКТЫ НА БИРЖЕ (${orders.length} шт.):</b>\n<i>Внимательно изучите смету перед тем, как брать в работу.</i>`);

      for (const o of orders) {
        const addr = o.details?.address ? o.details.address : "Не указан";
        const msg = 
          `🆕 <b>Объект #${o.id}</b>\n` +
          `📍 Адрес: ${addr}\n` +
          `💰 Сумма по смете: <b>${fmt(o.total_price)} ₸</b>\n` +
          `📅 Создан: ${new Date(o.created_at).toLocaleDateString("ru-RU")}`;

        await ctx.replyWithHTML(msg, Keyboards.takeOrderAction(o.id));
      }
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка загрузки биржи.");
    }
  },

  async takeOrder(ctx, orderId) {
    try {
      const brigade = await db.getBrigadeByManagerId(ctx.from.id);
      if (!brigade) return ctx.answerCbQuery("❌ Вы не состоите в бригаде.");

      const order = await OrderService.getOrderById(orderId);
      if (!order || order.status !== 'new') {
        return ctx.answerCbQuery("⚠️ Заказ уже забрали или он недоступен.", { show_alert: true });
      }

      await OrderService.assignOrderToBrigade(orderId, brigade.id);

      // SOCKET EMIT
      const io = getSocketIO();
      if (io) io.emit('order_updated', { orderId, status: 'work', brigade_id: brigade.id });

      await ctx.editMessageText(
        `✅ <b>Объект #${orderId} успешно взят в работу!</b>\nВаша бригада: ${brigade.name}\nСтатус изменен на В РАБОТЕ.`,
        { parse_mode: "HTML" }
      );
      await ctx.answerCbQuery("✅ Заказ ваш!");
    } catch (e) {
      console.error(e);
      ctx.answerCbQuery("❌ Ошибка привязки заказа.");
    }
  },

  /**
   * 3. 🛠 УПРАВЛЕНИЕ СВОИМИ ОБЪЕКТАМИ (Расходы и Авансы)
   */
  async showMyObjects(ctx) {
    try {
      const brigade = await db.getBrigadeByManagerId(ctx.from.id);
      if (!brigade) return ctx.reply("⚠️ Вы не состоите в бригаде.");

      const orders = await OrderService.getBrigadeOrders(brigade.id);
      const activeOrders = orders.filter(o => o.status === 'work' || o.status === 'processing');

      if (activeOrders.length === 0) {
        return ctx.reply("📭 У вашей бригады сейчас нет активных объектов в работе.");
      }

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);
      await ctx.replyWithHTML(`🛠 <b>ВАШИ АКТИВНЫЕ ОБЪЕКТЫ:</b>`);

      for (const o of activeOrders) {
        const netProfit = o.details?.financials?.net_profit || o.total_price;
        const expenses = o.details?.financials?.total_expenses || 0;
        
        const msg = 
          `🏢 <b>Объект #${o.id}</b> | <b>В РАБОТЕ</b>\n` +
          `💰 Итого по смете: ${fmt(o.total_price)} ₸\n` +
          `📉 Внесено расходов: ${fmt(expenses)} ₸\n` +
          `💎 Текущая прибыль: <b>${fmt(netProfit)} ₸</b>\n` +
          `<i>(Ваша доля по завершению: ${brigade.profit_percentage}%)</i>`;

        await ctx.replyWithHTML(msg, Keyboards.orderActions(o.id));
      }
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка загрузки ваших объектов.");
    }
  },

  /**
   * 4. 📉 ДОБАВЛЕНИЕ РАСХОДОВ (FSM)
   */
  async promptExpense(ctx, orderId) {
    ctx.session.brigadeState = BRIGADE_STATES.WAIT_EXPENSE_AMOUNT;
    ctx.session.targetOrderId = orderId;
    ctx.session.expenseType = "Материалы (Чек)";
    
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `🧾 <b>Добавление расхода (Чек) к объекту #${orderId}</b>\n\n` +
      `Введите сумму расхода цифрами (например: <code>15000</code>):\n` +
      `<i>Для отмены напишите "Отмена"</i>`
    );
  },

  async processExpenseAmount(ctx) {
    const amount = parseFloat(ctx.message.text.replace(/\s/g, ''));
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("⚠️ Пожалуйста, введите корректную сумму цифрами.");
    }

    ctx.session.expenseAmount = amount;
    ctx.session.brigadeState = BRIGADE_STATES.WAIT_EXPENSE_COMMENT;

    await ctx.replyWithHTML(
      `📝 Сумма: <b>${amount} ₸</b>.\nТеперь напишите комментарий (на что потрачено, номер чека):\n` +
      `<i>Для отмены напишите "Отмена"</i>`
    );
  },

  async processExpenseComment(ctx) {
    const comment = ctx.message.text;
    const orderId = ctx.session.targetOrderId;
    const amount = ctx.session.expenseAmount;
    const category = ctx.session.expenseType; // "Материалы (Чек)" или "Аванс"

    try {
      await OrderService.addOrderExpense(orderId, amount, category, comment, ctx.from.id);
      
      // SOCKET EMIT
      const io = getSocketIO();
      if (io) io.emit('expense_added', { orderId, amount, category });

      ctx.session.brigadeState = BRIGADE_STATES.IDLE;
      await ctx.reply(`✅ <b>Успешно!</b> ${category} на сумму ${amount} ₸ добавлен к объекту #${orderId}.`, { parse_mode: "HTML" });
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка записи расхода в базу.");
    }
  },

  /**
   * 5. 💰 ЗАПРОС АВАНСА (FSM)
   */
  async promptAdvance(ctx, orderId) {
    ctx.session.brigadeState = BRIGADE_STATES.WAIT_EXPENSE_AMOUNT; // Используем тот же флоу ввода суммы
    ctx.session.targetOrderId = orderId;
    ctx.session.expenseType = "Аванс Бригаде"; // Меняем категорию
    
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `💰 <b>Запрос Аванса по объекту #${orderId}</b>\n\n` +
      `Аванс вычитается из чистой прибыли объекта.\n` +
      `Введите сумму аванса цифрами (например: <code>50000</code>):\n` +
      `<i>Для отмены напишите "Отмена"</i>`
    );
  },

  /**
   * 6. 💸 ФИНАНСЫ (Баланс Бригады)
   */
  async showFinance(ctx) {
    try {
      // Ищем счет бригады в таблице accounts (где type = 'brigade_acc' и user_id = brigadier_id)
      const res = await db.query(
        "SELECT * FROM accounts WHERE user_id = $1 AND type = 'brigade_acc' LIMIT 1",
        [ctx.from.id]
      );

      if (res.rows.length === 0) {
        return ctx.reply("⚠️ У вас еще нет системного счета бригады. Он создается автоматически при выполнении первого заказа.");
      }

      const account = res.rows[0];
      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      await ctx.replyWithHTML(
        `💸 <b>ФИНАНСОВЫЙ СЧЕТ БРИГАДЫ</b>\n➖➖➖➖➖➖➖➖➖➖\n` +
        `💼 Счет: <b>${account.name}</b>\n` +
        `💎 Зарабоно всего: <b>${fmt(account.balance)} ₸</b>\n➖➖➖➖➖➖➖➖➖➖\n` +
        `<i>* Зарабоно всего пополняется автоматически при переводе объекта в статус "Завершен" (вычисляется ваша доля от чистой прибыли).</i>`
      );
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка загрузки финансов.");
    }
  }
};
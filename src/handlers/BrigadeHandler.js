/**
 * @file src/handlers/BrigadeHandler.js
 * @description Контроллер интерфейса Бригадиров (ERP Brigade Module v10.1.0).
 * Отвечает за:
 * 1. Биржу заказов.
 * 2. Управление своими объектами (расходы).
 * 3. Статистику заработка (без контроля личных счетов).
 * 4. Учет Долга перед компанией и процесс передачи денег (Инкассация).
 *
 * @module BrigadeHandler
 * @version 10.1.0 (Enterprise ERP Edition - Cash Flow)
 */

import { Markup } from "telegraf";
import { UserService, ROLES } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";
import * as db from "../database/index.js";
import { getSocketIO } from "../bot.js";
import { config } from "../config.js";

// =============================================================================
// 🔧 CONSTANTS & FSM STATES
// =============================================================================

export const BRIGADE_STATES = Object.freeze({
  IDLE: "IDLE",
  WAIT_EXPENSE_AMOUNT: "WAIT_EXPENSE_AMOUNT",
  WAIT_EXPENSE_COMMENT: "WAIT_EXPENSE_COMMENT",
  WAIT_ADVANCE_AMOUNT: "WAIT_ADVANCE_AMOUNT",
  WAIT_INCASSATION_AMOUNT: "WAIT_INCASSATION_AMOUNT",
});

const BUTTONS = Object.freeze({
  MARKET: "💼 Биржа заказов",
  MY_OBJECTS: "🛠 Мои объекты",
  FINANCE: "💸 Сверка и Выручка",
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

  orderActions: (orderId) =>
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🧾 Добавить чек (Расход)",
          `add_expense_${orderId}`,
        ),
      ],
      [
        Markup.button.callback(
          "✅ ЗАВЕРШИТЬ ОБЪЕКТ",
          `finish_order_${orderId}`,
        ),
      ],
    ]),

  takeOrderAction: (orderId) =>
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Взять в работу", `take_order_${orderId}`)],
    ]),

  financeActions: () =>
    Markup.inlineKeyboard([
      [Markup.button.callback("💸 Передать долю Шефу", `start_incassation`)],
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
      if (
        role !== ROLES.MANAGER &&
        role !== ROLES.OWNER &&
        role !== ROLES.ADMIN
      ) {
        return ctx.reply("⛔ Доступ запрещен. Вы не являетесь бригадиром.");
      }

      if (ctx.session) ctx.session.brigadeState = BRIGADE_STATES.IDLE;

      const brigade = await db.getBrigadeByManagerId(ctx.from.id);
      const brigadeInfo = brigade
        ? `\n👷‍♂️ Ваша бригада: <b>${brigade.name}</b> (Ваша доля: ${brigade.profit_percentage}%)`
        : `\n⚠️ <i>Внимание: Вы пока не привязаны ни к одной бригаде! Обратитесь к шефу.</i>`;

      await ctx.replyWithHTML(
        `🛠 <b>ПАНЕЛЬ БРИГАДИРА</b>${brigadeInfo}\n\nВыберите нужный раздел:`,
        Keyboards.menu,
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
    if (state === BRIGADE_STATES.WAIT_EXPENSE_AMOUNT)
      return this.processExpenseAmount(ctx);
    if (state === BRIGADE_STATES.WAIT_EXPENSE_COMMENT)
      return this.processExpenseComment(ctx);
    if (state === BRIGADE_STATES.WAIT_INCASSATION_AMOUNT)
      return this.processIncassationAmount(ctx);

    // Роутинг по кнопкам
    switch (text) {
      case BUTTONS.MARKET:
        return this.showMarket(ctx);
      case BUTTONS.MY_OBJECTS:
        return this.showMyObjects(ctx);
      case BUTTONS.FINANCE:
        return this.showFinance(ctx);
      case BUTTONS.BACK:
        return ctx.reply(
          "🏠 Главное меню",
          Markup.keyboard([
            ["🚀 Рассчитать стоимость"],
            ["📂 Мои заявки", "💰 Прайс-лист"],
            ["📞 Контакты", "ℹ️ Как мы работаем"],
            ["👑 Админ-панель", "🔑 Доступ в Web CRM"],
            ["👷 Панель Бригадира"],
          ]).resize(),
        );
    }
  },

  /**
   * 2. 💼 БИРЖА ЗАКАЗОВ (Лиды со статусом NEW)
   */
  async showMarket(ctx) {
    try {
      const brigade = await db.getBrigadeByManagerId(ctx.from.id);
      if (!brigade)
        return ctx.reply(
          "⚠️ Доступ закрыт: вы не состоите в активной бригаде.",
        );

      const orders = await OrderService.getAvailableNewOrders();
      if (!orders || orders.length === 0) {
        return ctx.reply("📭 В данный момент свободных заказов на бирже нет.");
      }

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      await ctx.replyWithHTML(
        `💼 <b>ДОСТУПНЫЕ ОБЪЕКТЫ НА БИРЖЕ (${orders.length} шт.):</b>\n<i>Внимательно изучите смету перед тем, как брать в работу.</i>`,
      );

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
      if (!order || order.status !== "new") {
        return ctx.answerCbQuery("⚠️ Заказ уже забрали или он недоступен.", {
          show_alert: true,
        });
      }

      await OrderService.assignOrderToBrigade(orderId, brigade.id);

      const io = getSocketIO();
      if (io)
        io.emit("order_updated", {
          orderId,
          status: "work",
          brigade_id: brigade.id,
        });

      await ctx.editMessageText(
        `✅ <b>Объект #${orderId} успешно взят в работу!</b>\nВаша бригада: ${brigade.name}\nСтатус изменен на В РАБОТЕ.`,
        { parse_mode: "HTML" },
      );
      await ctx.answerCbQuery("✅ Заказ ваш!");
    } catch (e) {
      console.error(e);
      ctx.answerCbQuery("❌ Ошибка привязки заказа.");
    }
  },

  /**
   * 3. 🛠 УПРАВЛЕНИЕ СВОИМИ ОБЪЕКТАМИ
   */
  async showMyObjects(ctx) {
    try {
      const brigade = await db.getBrigadeByManagerId(ctx.from.id);
      if (!brigade) return ctx.reply("⚠️ Вы не состоите в бригаде.");

      const orders = await OrderService.getBrigadeOrders(brigade.id);
      const activeOrders = orders.filter(
        (o) => o.status === "work" || o.status === "processing",
      );

      if (activeOrders.length === 0) {
        return ctx.reply(
          "📭 У вашей бригады сейчас нет активных объектов в работе.",
        );
      }

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);
      await ctx.replyWithHTML(
        `🛠 <b>ВАШИ АКТИВНЫЕ ОБЪЕКТЫ:</b>\n<i>Вносите чеки за материалы своевременно, чтобы правильно рассчитать прибыль!</i>`,
      );

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
   * 4. 📉 ДОБАВЛЕНИЕ РАСХОДОВ (ЧЕКОВ)
   */
  async promptExpense(ctx, orderId) {
    ctx.session.brigadeState = BRIGADE_STATES.WAIT_EXPENSE_AMOUNT;
    ctx.session.targetOrderId = orderId;
    ctx.session.expenseType = "Материалы (Чек)";

    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `🧾 <b>Добавление расхода (Чек) к объекту #${orderId}</b>\n\n` +
        `Введите сумму расхода цифрами (например: <code>15000</code>):\n` +
        `<i>Для отмены напишите "Отмена"</i>`,
    );
  },

  async processExpenseAmount(ctx) {
    const amount = parseFloat(ctx.message.text.replace(/\s/g, ""));
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("⚠️ Пожалуйста, введите корректную сумму цифрами.");
    }

    ctx.session.expenseAmount = amount;
    ctx.session.brigadeState = BRIGADE_STATES.WAIT_EXPENSE_COMMENT;

    await ctx.replyWithHTML(
      `📝 Сумма: <b>${amount} ₸</b>.\nТеперь напишите комментарий (на что потрачено, номер чека):\n` +
        `<i>Для отмены напишите "Отмена"</i>`,
    );
  },

  async processExpenseComment(ctx) {
    const comment = ctx.message.text;
    const orderId = ctx.session.targetOrderId;
    const amount = ctx.session.expenseAmount;
    const category = ctx.session.expenseType;

    try {
      await OrderService.addOrderExpense(
        orderId,
        amount,
        category,
        comment,
        ctx.from.id,
      );

      const io = getSocketIO();
      if (io) io.emit("expense_added", { orderId, amount, category });

      ctx.session.brigadeState = BRIGADE_STATES.IDLE;
      await ctx.reply(
        `✅ <b>Успешно!</b> ${category} на сумму ${amount} ₸ добавлен к объекту #${orderId}.`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка записи расхода в базу.");
    }
  },

  /**
   * 5. 📊 СТАТИСТИКА И ДОЛГИ (Вместо Балансов)
   */
  async showFinance(ctx) {
    try {
      // Ищем системный ID для расчетов
      const resAcc = await db.query(
        "SELECT id FROM accounts WHERE user_id = $1 AND type = 'brigade_acc' LIMIT 1",
        [ctx.from.id],
      );

      if (resAcc.rows.length === 0) {
        return ctx.reply(
          "⚠️ Ваша статистика пока пуста. Завершите хотя бы один объект.",
        );
      }

      const accountId = resAcc.rows[0].id;
      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      // Считаем Заработано (Только личная прибыль бригады) и Долг Шефу из истории
      const txRes = await db.query(
        `
        SELECT 
          COALESCE(SUM(amount) FILTER (WHERE category = 'Заработок'), 0) as total_earned,
          COALESCE(SUM(amount) FILTER (WHERE category = 'Удержание'), 0) as total_held,
          COALESCE(SUM(amount) FILTER (WHERE category = 'Инкассация' AND type = 'income'), 0) as total_returned
        FROM transactions WHERE account_id = $1
      `,
        [accountId],
      );

      const data = txRes.rows[0];
      const earned = parseFloat(data.total_earned);

      // Долг = (Удержанные деньги клиентов) минус (Переданные Шефу)
      const debt =
        parseFloat(data.total_held) - parseFloat(data.total_returned);

      let msg = `📊 <b>СТАТИСТИКА БРИГАДЫ</b>\n➖➖➖➖➖➖➖➖➖➖\n`;
      msg += `💰 <b>Всего заработано: ${fmt(earned)} ₸</b>\n`;
      msg += `<i>(Ваш чистый заработок за все время работы)</i>\n\n`;

      if (debt > 0) {
        msg += `🔴 <b>ДОЛГ ПЕРЕД ШЕФОМ: ${fmt(debt)} ₸</b>\n`;
        msg += `<i>(Это доля компании с завершенных объектов. Пожалуйста, передайте их Шефу.)</i>\n➖➖➖➖➖➖➖➖➖➖`;
      } else {
        msg += `⚪️ <b>Долгов перед компанией нет.</b>\n➖➖➖➖➖➖➖➖➖➖`;
      }

      await ctx.replyWithHTML(msg, Keyboards.financeActions());
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка загрузки статистики.");
    }
  },

  /**
   * 6. 🚚 ИНКАССАЦИЯ (Передача денег Шефу)
   */
  async promptIncassation(ctx) {
    ctx.session.brigadeState = BRIGADE_STATES.WAIT_INCASSATION_AMOUNT;
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `💸 <b>Передача доли Шефу</b>\n\n` +
        `Вы перевели деньги на Kaspi Шефу или отдали наличными?\n` +
        `Введите переданную сумму (цифрами, например <code>50000</code>):\n` +
        `<i>Для отмены напишите "Отмена"</i>`,
    );
  },

  async processIncassationAmount(ctx) {
    const amount = parseFloat(ctx.message.text.replace(/\s/g, ""));
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("⚠️ Введите корректную сумму цифрами.");
    }

    ctx.session.brigadeState = BRIGADE_STATES.IDLE;
    const brigadierId = ctx.from.id;
    const brigade = await db.getBrigadeByManagerId(brigadierId);
    const ownerId = config.bot.ownerId; // Ваш ID из .env

    if (!ownerId) {
      return ctx.reply("⚠️ Системная ошибка: ID Владельца не настроен.");
    }

    try {
      // Вычисляем текущий долг для красивого уведомления Шефу
      const resAcc = await db.query(
        "SELECT id FROM accounts WHERE user_id = $1 AND type = 'brigade_acc' LIMIT 1",
        [brigadierId],
      );
      const accId = resAcc.rows[0]?.id;

      let currentDebt = 0;
      if (accId) {
        const txRes = await db.query(
          `
             SELECT COALESCE(SUM(amount) FILTER (WHERE category = 'Удержание'), 0) - 
                    COALESCE(SUM(amount) FILTER (WHERE category = 'Инкассация' AND type = 'income'), 0) as debt 
             FROM transactions WHERE account_id = $1
           `,
          [accId],
        );
        currentDebt = parseFloat(txRes.rows[0].debt);
      }
      const remainingDebt = currentDebt - amount;

      // Отправляем МАКСИМАЛЬНО подробное уведомление Владельцу
      await ctx.telegram.sendMessage(
        ownerId,
        `💰 <b>ИНКАССАЦИЯ (Передача денег)</b>\n➖➖➖➖➖➖➖➖➖➖\n` +
          `👷‍♂️ Бригада: <b>${brigade?.name || ctx.from.first_name}</b>\n` +
          `💸 Передает вам: <b>${new Intl.NumberFormat("ru-RU").format(amount)} ₸</b>\n\n` +
          `📉 Было долга: ${new Intl.NumberFormat("ru-RU").format(currentDebt)} ₸\n` +
          `Остаток долга (если подтвердите): <b>${new Intl.NumberFormat("ru-RU").format(remainingDebt)} ₸</b>\n➖➖➖➖➖➖➖➖➖➖\n` +
          `<i>Нажмите "Подтвердить", если вы действительно получили эти деньги.</i>`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "✅ Подтвердить получение",
              `app_inc_${brigadierId}_${amount}`,
            ),
          ],
          [
            Markup.button.callback(
              "❌ Деньги не поступали",
              `rej_inc_${brigadierId}_${amount}`,
            ),
          ],
        ]),
      );

      await ctx.replyWithHTML(
        `✅ <b>Запрос отправлен Шефу!</b>\nСумма ${new Intl.NumberFormat("ru-RU").format(amount)} ₸ будет списана с вашего долга сразу после того, как Шеф нажмет "Подтвердить".`,
      );
    } catch (e) {
      console.error("Ошибка отправки инкассации:", e);
      ctx.reply("❌ Ошибка отправки запроса Шефу.");
    }
  },

  /**
   * 7. ✅ ЗАВЕРШЕНИЕ ОБЪЕКТА
   */
  async finishOrder(ctx, orderId) {
    try {
      await ctx.answerCbQuery("⏳ Закрытие объекта и расчет долей...");

      // СЛОЖНАЯ ТРАНЗАКЦИЯ: Распределяет прибыль и вешает долг на бригаду
      const result = await db.finalizeOrderAndDistributeProfit(orderId);

      const io = getSocketIO();
      if (io) io.emit("order_updated", { orderId, status: "done" });

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      await ctx.editMessageText(
        `✅ <b>Объект #${orderId} успешно ЗАВЕРШЕН.</b>\n➖➖➖➖➖➖➖➖➖➖\n` +
          `💰 Вы заработали: <b>+${fmt(result.brigadeShare)} ₸</b>\n` +
          `🔴 Долг Шефу (его доля): <b>-${fmt(result.ownerShare)} ₸</b>\n➖➖➖➖➖➖➖➖➖➖\n` +
          `<i>Доля Шефа добавлена в ваш долг. Зайдите в раздел "Сверка и Выручка", чтобы передать деньги.</i>`,
        { parse_mode: "HTML" },
      );

      // Уведомление Шефу (Вам)
      const ownerId = config.bot.ownerId;
      if (ownerId) {
        ctx.telegram
          .sendMessage(
            ownerId,
            `🔔 <b>ОБЪЕКТ #${orderId} ЗАВЕРШЕН!</b>\n` +
              `Бригадир закрыл заказ.\n` +
              `Доля компании <b>${fmt(result.ownerShare)} ₸</b> записана в долг бригады. Ждите перевод.`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});
      }
    } catch (e) {
      console.error(e);
      ctx.answerCbQuery(`❌ Ошибка завершения заказа: ${e.message}`, {
        show_alert: true,
      });
    }
  },
};

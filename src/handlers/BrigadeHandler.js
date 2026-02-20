/**
 * @file src/handlers/BrigadeHandler.js
 * @description Контроллер интерфейса Бригадиров (ERP Brigade Module v10.9.1).
 * Отвечает за: Биржу заказов, Управление своими объектами, Статистику, Инкассацию.
 * ДОБАВЛЕНО: Инлайн-кнопки для перевода в статус "В замере" и "В работе".
 * ДОБАВЛЕНО: Кнопка и машина состояний (FSM) для изменения итоговой цены объекта.
 *
 * @module BrigadeHandler
 * @version 10.9.1 (Enterprise ERP Edition - Full Manager Control)
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
  WAIT_INCASSATION_AMOUNT: "WAIT_INCASSATION_AMOUNT",
  WAIT_ORDER_NEW_PRICE: "WAIT_ORDER_NEW_PRICE", // 🔥 НОВОЕ: Состояние для ввода цены
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

  // 🔥 ИСПРАВЛЕНО: Динамическая клавиатура в зависимости от статуса заказа
  orderActions: (orderId, currentStatus) => {
    const buttons = [];

    // Кнопки смены статуса
    if (currentStatus !== "processing") {
      buttons.push([
        Markup.button.callback(
          "📐 Перевести 'В замер'",
          `set_status_processing_${orderId}`,
        ),
      ]);
    }
    if (currentStatus !== "work") {
      buttons.push([
        Markup.button.callback(
          "🛠 Перевести 'В работу'",
          `set_status_work_${orderId}`,
        ),
      ]);
    }

    // Кнопки финансов
    buttons.push([
      Markup.button.callback("💰 Изменить цену", `prompt_price_${orderId}`),
      Markup.button.callback(
        "🧾 Добавить чек (Расход)",
        `add_expense_${orderId}`,
      ),
    ]);

    // Делегирование и отказ
    buttons.push([
      Markup.button.callback("❌ Отказаться", `refuse_order_${orderId}`),
      Markup.button.callback("🤝 Передать", `prompt_transfer_${orderId}`),
    ]);

    // Закрытие объекта
    buttons.push([
      Markup.button.callback("✅ ЗАВЕРШИТЬ ОБЪЕКТ", `finish_order_${orderId}`),
    ]);

    return Markup.inlineKeyboard(buttons);
  },

  takeOrderAction: (orderId) =>
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "✅ Забрать объект себе",
          `take_order_${orderId}`,
        ),
      ],
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
    if (state === BRIGADE_STATES.WAIT_ORDER_NEW_PRICE)
      return this.processOrderNewPrice(ctx); // 🔥 НОВОЕ: Обработчик цены

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
        const area = o.area || o.details?.params?.area || 0;
        const msg =
          `🆕 <b>Объект #${o.id}</b>\n` +
          `📍 Адрес: ${addr}\n` +
          `📐 Объем: ${area} м²\n` +
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
      if (!brigade)
        return ctx.answerCbQuery("❌ Вы не состоите в бригаде.", {
          show_alert: true,
        });

      const order = await OrderService.getOrderById(orderId);
      if (!order || order.status !== "new") {
        return ctx.answerCbQuery("⚠️ Заказ уже забрали или он недоступен.", {
          show_alert: true,
        });
      }

      // Переводим заказ сразу в processing (В замере), чтобы мастер мог съездить и оценить
      await db.query(
        "UPDATE orders SET brigade_id = $1, status = 'processing', updated_at = NOW() WHERE id = $2 AND status = 'new'",
        [brigade.id, orderId],
      );

      const io = getSocketIO();
      if (io)
        io.emit("order_updated", {
          orderId,
          status: "processing",
          brigade_id: brigade.id,
        });

      await ctx.editMessageText(
        `✅ <b>Объект #${orderId} успешно взят!</b>\nВаша бригада: ${brigade.name}\nТекущий статус: <b>В ЗАМЕРЕ</b>.\n\nЗаказ перемещен в раздел "🛠 Мои объекты". Сделайте замер и установите итоговую цену!`,
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
      await ctx.replyWithHTML(`🛠 <b>ВАШИ АКТИВНЫЕ ОБЪЕКТЫ:</b>`);

      for (const o of activeOrders) {
        const netProfit =
          o.details?.financials?.net_profit !== undefined
            ? o.details.financials.net_profit
            : o.total_price;
        const expenses = o.details?.financials?.total_expenses || 0;
        const statusLocal =
          o.status === "processing"
            ? "📐 В ЗАМЕРЕ (Оценка)"
            : "🛠 В РАБОТЕ (Монтаж)";

        const msg =
          `🏢 <b>Объект #${o.id}</b> | ${statusLocal}\n` +
          `💰 Договорная цена: ${fmt(o.total_price)} ₸\n` +
          `📉 Внесено расходов (Чеки): ${fmt(expenses)} ₸\n` +
          `💎 Ваша расчетная доля: <b>${fmt(netProfit * (brigade.profit_percentage / 100))} ₸</b>`;

        await ctx.replyWithHTML(msg, Keyboards.orderActions(o.id, o.status));
      }
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка загрузки ваших объектов.");
    }
  },

  /**
   * 🔥 3.1 ИЗМЕНЕНИЕ СТАТУСА (В замере / В работе)
   */
  async setOrderStatus(ctx, orderId, newStatus) {
    try {
      const brigade = await db.getBrigadeByManagerId(ctx.from.id);
      if (!brigade) return ctx.answerCbQuery("❌ Вы не состоите в бригаде.");

      await OrderService.updateOrderStatus(orderId, newStatus);
      const io = getSocketIO();
      if (io) io.emit("order_updated", { orderId, status: newStatus });

      const statusName =
        newStatus === "processing" ? "📐 В ЗАМЕРЕ" : "🛠 В РАБОТЕ";

      await ctx.answerCbQuery(`✅ Статус изменен на "${statusName}"`);
      await ctx.editMessageText(
        `✅ <b>Статус объекта #${orderId} успешно обновлен!</b>\nТекущая стадия: <b>${statusName}</b>\n\n<i>Для дальнейших действий вернитесь в "Мои объекты".</i>`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error("Ошибка смены статуса:", e);
      ctx.answerCbQuery("❌ Ошибка смены статуса");
    }
  },

  /**
   * 🔥 3.2 ИЗМЕНЕНИЕ ИТОГОВОЙ ЦЕНЫ
   */
  async promptPrice(ctx, orderId) {
    ctx.session.brigadeState = BRIGADE_STATES.WAIT_ORDER_NEW_PRICE;
    ctx.session.targetOrderId = orderId;
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `💰 <b>Изменение договорной цены для объекта #${orderId}</b>\n\n` +
        `Введите окончательную сумму, о которой вы договорились с клиентом после замера (цифрами, например: <code>150000</code>):\n` +
        `<i>Для отмены напишите "Отмена"</i>`,
    );
  },

  async processOrderNewPrice(ctx) {
    const amount = parseFloat(ctx.message.text.replace(/\s/g, ""));
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("⚠️ Пожалуйста, введите корректную сумму цифрами.");
    }
    const orderId = ctx.session.targetOrderId;

    try {
      await OrderService.updateOrderFinalPrice(orderId, amount);
      ctx.session.brigadeState = BRIGADE_STATES.IDLE;

      const io = getSocketIO();
      if (io) io.emit("order_updated", { orderId });

      await ctx.reply(
        `✅ <b>Цена успешно обновлена!</b>\nНовая итоговая сумма объекта #${orderId}: <b>${new Intl.NumberFormat("ru-RU").format(amount)} ₸</b>.`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error("Ошибка изменения цены:", e);
      ctx.reply("❌ Ошибка при обновлении цены в базе данных.");
    }
  },

  /**
   * 3.5 🔄 ОТКАЗ И ПЕРЕДАЧА ЗАКАЗА
   */
  async refuseOrder(ctx, orderId) {
    try {
      const brigade = await db.getBrigadeByManagerId(ctx.from.id);
      if (!brigade) return ctx.answerCbQuery("❌ Вы не состоите в бригаде.");

      const order = await OrderService.getOrderById(orderId);
      if (!order || order.brigade_id !== brigade.id) {
        return ctx.answerCbQuery("⚠️ Это не ваш заказ или он уже закрыт.", {
          show_alert: true,
        });
      }

      await db.query(
        "UPDATE orders SET brigade_id = NULL, status = 'new', updated_at = NOW() WHERE id = $1",
        [orderId],
      );

      const io = getSocketIO();
      if (io)
        io.emit("order_updated", { orderId, status: "new", brigade_id: null });

      await ctx.editMessageText(
        `❌ <b>Вы отказались от объекта #${orderId}</b>.\nОн возвращен на биржу и доступен другим бригадам.`,
        { parse_mode: "HTML" },
      );
      await ctx.answerCbQuery("✅ Заказ возвращен на биржу");

      const ownerId = await db.getSystemOwnerId();
      if (ownerId) {
        await ctx.telegram
          .sendMessage(
            ownerId,
            `⚠️ Бригада <b>${brigade.name}</b> отказалась от объекта #${orderId}. Заказ возвращен на биржу.`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});
      }
    } catch (e) {
      console.error("Ошибка отказа от заказа:", e);
      ctx.answerCbQuery("❌ Системная ошибка.");
    }
  },

  async promptTransfer(ctx, orderId) {
    try {
      const brigade = await db.getBrigadeByManagerId(ctx.from.id);
      if (!brigade) return ctx.answerCbQuery("❌ Ошибка бригады.");

      const res = await db.query(
        "SELECT * FROM brigades WHERE is_active = true AND id != $1 ORDER BY name ASC",
        [brigade.id],
      );
      const otherBrigades = res.rows;

      if (otherBrigades.length === 0) {
        return ctx.answerCbQuery(
          "⚠️ Нет других активных бригад для передачи.",
          { show_alert: true },
        );
      }

      const buttons = otherBrigades.map((b) => [
        Markup.button.callback(
          `➡️ Передать: ${b.name}`,
          `exec_transfer_${orderId}_${b.id}`,
        ),
      ]);
      buttons.push([
        Markup.button.callback("🔙 Отмена", `cancel_transfer_${orderId}`),
      ]);

      await ctx.editMessageText(
        `🤝 <b>Кому вы хотите передать объект #${orderId}?</b>\nВыберите бригаду из списка ниже:`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } },
      );
      await ctx.answerCbQuery();
    } catch (e) {
      console.error(e);
      ctx.answerCbQuery("❌ Ошибка загрузки списка бригад.");
    }
  },

  async executeTransfer(ctx, orderId, targetBrigadeId) {
    try {
      const myBrigade = await db.getBrigadeByManagerId(ctx.from.id);
      const targetBrigadeRes = await db.query(
        "SELECT * FROM brigades WHERE id = $1",
        [targetBrigadeId],
      );

      if (targetBrigadeRes.rows.length === 0)
        return ctx.answerCbQuery("❌ Целевая бригада не найдена.");
      const targetBrigade = targetBrigadeRes.rows[0];

      await db.query(
        "UPDATE orders SET brigade_id = $1, updated_at = NOW() WHERE id = $2",
        [targetBrigade.id, orderId],
      );

      const io = getSocketIO();
      if (io)
        io.emit("order_updated", { orderId, brigade_id: targetBrigade.id });

      await ctx.editMessageText(
        `✅ <b>Объект #${orderId} успешно передан бригаде "${targetBrigade.name}".</b>\nОн пропадет из вашего списка.`,
        { parse_mode: "HTML" },
      );

      await ctx.telegram
        .sendMessage(
          targetBrigade.brigadier_id,
          `🎁 <b>Вам передали объект!</b>\nБригада <b>${myBrigade.name}</b> передала вам в работу объект <b>#${orderId}</b>.\nПроверьте раздел "🛠 Мои объекты".`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});

      await ctx.answerCbQuery("✅ Успешно передано");
    } catch (e) {
      console.error("Ошибка передачи:", e);
      ctx.answerCbQuery("❌ Ошибка при передаче объекта.");
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
    if (isNaN(amount) || amount <= 0)
      return ctx.reply("⚠️ Пожалуйста, введите корректную сумму цифрами.");

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
   * 5. 📊 СТАТИСТИКА И ДОЛГИ
   */
  async showFinance(ctx) {
    try {
      const resAcc = await db.query(
        "SELECT id FROM accounts WHERE user_id = $1 AND type = 'brigade_acc' LIMIT 1",
        [ctx.from.id],
      );
      if (resAcc.rows.length === 0)
        return ctx.reply(
          "⚠️ Ваша статистика пока пуста. Завершите хотя бы один объект.",
        );

      const accountId = resAcc.rows[0].id;
      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

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
      const debt =
        parseFloat(data.total_held) - parseFloat(data.total_returned);

      let msg = `📊 <b>СТАТИСТИКА БРИГАДЫ</b>\n➖➖➖➖➖➖➖➖➖➖\n`;
      msg += `💰 <b>Всего заработано: ${fmt(earned)} ₸</b>\n<i>(Ваш чистый заработок)</i>\n\n`;

      if (debt > 0) {
        msg += `🔴 <b>ДОЛГ ПЕРЕД ШЕФОМ: ${fmt(debt)} ₸</b>\n<i>(Доля компании с завершенных объектов)</i>\n➖➖➖➖➖➖➖➖➖➖`;
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
   * 6. 🚚 ИНКАССАЦИЯ
   */
  async promptIncassation(ctx) {
    ctx.session.brigadeState = BRIGADE_STATES.WAIT_INCASSATION_AMOUNT;
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `💸 <b>Передача доли Шефу</b>\n\nВведите переданную сумму (цифрами, например <code>50000</code>):\n<i>Для отмены напишите "Отмена"</i>`,
    );
  },

  async processIncassationAmount(ctx) {
    const amount = parseFloat(ctx.message.text.replace(/\s/g, ""));
    if (isNaN(amount) || amount <= 0)
      return ctx.reply("⚠️ Введите корректную сумму цифрами.");

    ctx.session.brigadeState = BRIGADE_STATES.IDLE;
    const brigadierId = ctx.from.id;
    const brigade = await db.getBrigadeByManagerId(brigadierId);

    const ownerId = await db.getSystemOwnerId();
    if (!ownerId) return ctx.reply("⚠️ Системная ошибка: Владелец не найден.");

    try {
      const resAcc = await db.query(
        "SELECT id FROM accounts WHERE user_id = $1 AND type = 'brigade_acc' LIMIT 1",
        [brigadierId],
      );
      let currentDebt = 0;
      if (resAcc.rows[0]?.id) {
        const txRes = await db.query(
          `SELECT COALESCE(SUM(amount) FILTER (WHERE category = 'Удержание'), 0) - COALESCE(SUM(amount) FILTER (WHERE category = 'Инкассация' AND type = 'income'), 0) as debt FROM transactions WHERE account_id = $1`,
          [resAcc.rows[0].id],
        );
        currentDebt = parseFloat(txRes.rows[0].debt);
      }

      await ctx.telegram.sendMessage(
        ownerId,
        `💰 <b>ИНКАССАЦИЯ (Передача денег)</b>\n➖➖➖➖➖➖➖➖➖➖\n👷‍♂️ Бригада: <b>${brigade?.name || ctx.from.first_name}</b>\n💸 Передает: <b>${new Intl.NumberFormat("ru-RU").format(amount)} ₸</b>\n📉 Остаток долга: <b>${new Intl.NumberFormat("ru-RU").format(currentDebt - amount)} ₸</b>\n➖➖➖➖➖➖➖➖➖➖`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "✅ Подтвердить получение",
              `app_inc_${brigadierId}_${amount}`,
            ),
          ],
          [
            Markup.button.callback(
              "❌ Не поступали",
              `rej_inc_${brigadierId}_${amount}`,
            ),
          ],
        ]),
      );
      await ctx.replyWithHTML(
        `✅ <b>Запрос отправлен Шефу!</b>\nСумма будет списана с долга после его подтверждения.`,
      );
    } catch (e) {
      console.error("Ошибка инкассации:", e);
      ctx.reply("❌ Ошибка отправки запроса.");
    }
  },

  /**
   * 7. ✅ ЗАВЕРШЕНИЕ ОБЪЕКТА
   */
  async finishOrder(ctx, orderId) {
    try {
      await ctx.answerCbQuery("⏳ Закрытие объекта и расчет долей...");

      const result = await db.finalizeOrderAndDistributeProfit(orderId);
      const io = getSocketIO();
      if (io) io.emit("order_updated", { orderId, status: "done" });

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);
      await ctx.editMessageText(
        `✅ <b>Объект #${orderId} ЗАВЕРШЕН.</b>\n➖➖➖➖➖➖➖➖➖➖\n💰 Вы заработали: <b>+${fmt(result.brigadeShare)} ₸</b>\n🔴 Долг Шефу: <b>-${fmt(result.ownerShare)} ₸</b>\n➖➖➖➖➖➖➖➖➖➖\n<i>Доля Шефа добавлена в ваш долг.</i>`,
        { parse_mode: "HTML" },
      );

      const ownerId = await db.getSystemOwnerId();
      if (ownerId) {
        ctx.telegram
          .sendMessage(
            ownerId,
            `🔔 <b>ОБЪЕКТ #${orderId} ЗАВЕРШЕН!</b>\nБригадир закрыл заказ.\nДоля компании <b>${fmt(result.ownerShare)} ₸</b> записана в долг бригады.`,
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

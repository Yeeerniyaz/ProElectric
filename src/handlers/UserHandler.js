/**
 * @file src/handlers/UserHandler.js
 * @description Обработчик взаимодействия с клиентом.
 * Реализует машину состояний (FSM) для пошагового расчета сметы.
 * Весь текст вынесен в constants.js.
 * @module UserHandler
 * @version 5.0.0 (Senior Production Ready)
 */

import { OrderService } from "../services/OrderService.js";
import { UserService } from "../services/UserService.js";
import { KEYBOARDS, MESSAGES, BUTTONS } from "../constants.js";

// Перечисление состояний пользователя (Finite State Machine)
const USER_STATES = {
  IDLE: "IDLE", // Свободен
  CALC_WAIT_AREA: "WAIT_AREA", // Ждет ввод площади
  CALC_WAIT_WALL: "WAIT_WALL", // Ждет выбор стен
  CALC_WAIT_ROOMS: "WAIT_ROOMS", // Ждет ввод комнат
  CONTACT_WAIT_MSG: "WAIT_MSG", // Ждет сообщение в поддержку
};

export const UserHandler = {
  /**
   * 🚀 Запуск бота (/start).
   * Регистрирует пользователя и показывает главное меню.
   */
  async startCommand(ctx) {
    try {
      // 1. Регистрация/Обновление пользователя (Upsert)
      await UserService.registerOrUpdateUser(ctx.from);

      // 2. Сброс состояния
      this.clearSession(ctx);

      // 3. Приветствие из констант
      const userName = ctx.from.first_name || "Гость";
      await ctx.replyWithMarkdown(
        MESSAGES.USER.WELCOME(userName),
        KEYBOARDS.MAIN_MENU,
      );
    } catch (error) {
      console.error("[UserHandler] Start Error:", error);
    }
  },

  /**
   * 🏁 Старт режима расчета (Wizard Step 1).
   */
  async enterCalculationMode(ctx) {
    ctx.session.state = USER_STATES.CALC_WAIT_AREA;
    ctx.session.calcData = {}; // Инициализация буфера данных

    await ctx.replyWithMarkdown(
      MESSAGES.USER.WIZARD_STEP_1_AREA,
      KEYBOARDS.CANCEL_MENU,
    );
  },

  /**
   * 📨 Маршрутизатор текстовых сообщений.
   * Распределяет входящий текст в зависимости от состояния state.
   */
  async handleTextMessage(ctx) {
    const text = ctx.message.text;
    const state = ctx.session.state || USER_STATES.IDLE;

    // Глобальные перехватчики (Кнопки меню и отмена)
    if (Object.values(BUTTONS.common).includes(text) || text === "/cancel") {
      return this.returnToMainMenu(ctx);
    }

    // Switch-машина состояний
    switch (state) {
      case USER_STATES.CALC_WAIT_AREA:
        return this.processAreaInput(ctx, text);

      case USER_STATES.CALC_WAIT_ROOMS:
        return this.processRoomsInput(ctx, text);

      case USER_STATES.CONTACT_WAIT_MSG:
        return this.processSupportMessage(ctx, text);

      case USER_STATES.IDLE:
      default:
        return ctx.replyWithMarkdown(
          MESSAGES.USER.UNKNOWN_COMMAND,
          KEYBOARDS.MAIN_MENU,
        );
    }
  },

  /**
   * 🔢 Обработка ввода площади (Шаг 1 -> Шаг 2).
   */
  async processAreaInput(ctx, text) {
    // Заменяем запятую на точку для валидности float
    const area = parseFloat(text.replace(",", "."));

    // Строгая валидация (Validation Layer)
    if (isNaN(area) || area <= 0 || area > 1000) {
      return ctx.replyWithMarkdown(MESSAGES.USER.WIZARD_ERROR_AREA);
    }

    // Сохранение в сессию
    ctx.session.calcData.area = area;

    // Переход к следующему состоянию
    ctx.session.state = USER_STATES.CALC_WAIT_WALL;

    await ctx.replyWithMarkdown(
      MESSAGES.USER.WIZARD_STEP_2_WALL,
      KEYBOARDS.WALL_TYPES, // Inline клавиатура
    );
  },

  /**
   * 🧱 Обработка выбора стен (Callback Query).
   * Вызывается из bot.js при нажатии inline-кнопки.
   */
  async handleWallSelection(ctx) {
    const wallType = ctx.match[0]; // Данные из кнопки

    // Проверка актуальности сессии
    if (ctx.session.state !== USER_STATES.CALC_WAIT_WALL) {
      return ctx.answerCbQuery(MESSAGES.USER.SESSION_EXPIRED);
    }

    ctx.session.calcData.wallType = wallType;

    // Переход к следующему состоянию
    ctx.session.state = USER_STATES.CALC_WAIT_ROOMS;

    // UI UX: Убираем кнопки, чтобы не засорять чат, и подтверждаем выбор
    await ctx.editMessageText(`✅ Выбрано: ${this.getWallLabel(wallType)}`);

    await ctx.replyWithMarkdown(
      MESSAGES.USER.WIZARD_STEP_3_ROOMS,
      KEYBOARDS.CANCEL_MENU,
    );
    await ctx.answerCbQuery();
  },

  /**
   * 🏠 Обработка ввода комнат и Финальный Расчет (Шаг 3 -> Финиш).
   */
  async processRoomsInput(ctx, text) {
    const rooms = parseInt(text);

    if (isNaN(rooms) || rooms < 1 || rooms > 20) {
      return ctx.replyWithMarkdown(MESSAGES.USER.WIZARD_ERROR_ROOMS);
    }

    ctx.session.calcData.rooms = rooms;

    await ctx.replyWithMarkdown(MESSAGES.USER.CALCULATION_PROCESS);

    try {
      const { area, wallType } = ctx.session.calcData;

      // Вызов бизнес-логики (Business Logic Layer)
      const result = await OrderService.calculateComplexEstimate(
        area,
        rooms,
        wallType,
      );

      // Сохраняем результат во временную сессию (для кнопки "Заказать")
      ctx.session.lastResult = result;
      ctx.session.state = USER_STATES.IDLE; // Расчет окончен

      // Генерация текста чека через константы
      const invoiceText = MESSAGES.USER.estimateResult(
        area,
        this.getWallLabel(wallType),
        rooms,
        result.total.work.toLocaleString(),
        result.total.material.toLocaleString(),
        result.total.grandTotal.toLocaleString(),
      );

      await ctx.replyWithMarkdown(invoiceText, KEYBOARDS.ESTIMATE_ACTIONS);
    } catch (error) {
      console.error("[UserHandler] Calc Error:", error);
      await ctx.replyWithMarkdown(MESSAGES.USER.CALCULATION_ERROR);
      this.returnToMainMenu(ctx);
    }
  },

  /**
   * 💾 Сохранение заказа в БД.
   */
  async saveOrderAction(ctx) {
    const result = ctx.session.lastResult;

    if (!result) {
      return ctx.replyWithMarkdown(MESSAGES.USER.SESSION_EXPIRED);
    }

    try {
      // Создание записи в БД
      const order = await OrderService.createOrder(ctx.from.id, result);

      await ctx.editMessageText(MESSAGES.USER.SAVE_ORDER_SUCCESS(order.id), {
        parse_mode: "Markdown",
      });

      // Уведомление администраторам (Observer Pattern)
      await this.notifyAdminsNewOrder(ctx, order, result.total.grandTotal);
    } catch (error) {
      console.error("[UserHandler] Save Error:", error);
      await ctx.replyWithMarkdown(MESSAGES.USER.SAVE_ORDER_ERROR);
    }
  },

  /**
   * 🔔 Приватный метод: Рассылка уведомлений админам.
   */
  async notifyAdminsNewOrder(ctx, order, totalSum) {
    const adminIds = await UserService.getAdminIdsForNotification();
    const userLink = ctx.from.username
      ? `@${ctx.from.username}`
      : ctx.from.first_name;

    // Получаем телефон, если есть в профиле (необязательно)
    const userProfile = await UserService.getUserProfile(ctx.from.id);
    const phone = userProfile.phone || "Не указан";

    const msg = MESSAGES.USER.NEW_ORDER_ADMIN(
      order.id,
      userLink,
      phone,
      totalSum.toLocaleString(),
    );

    for (const adminId of adminIds) {
      try {
        await ctx.telegram.sendMessage(adminId, msg);
      } catch (e) {
        /* ignore block */
      }
    }
  },

  /**
   * 📂 Просмотр истории заказов.
   */
  async showMyOrders(ctx) {
    const orders = await OrderService.getUserOrders(ctx.from.id);

    if (!orders || orders.length === 0) {
      return ctx.replyWithMarkdown(MESSAGES.USER.NO_ORDERS);
    }

    let msg = MESSAGES.USER.MY_ORDERS_HEADER;
    orders.forEach((order, index) => {
      const date = new Date(order.created_at).toLocaleDateString();
      msg += `${index + 1}. 📅 ${date} — **${parseInt(order.total_price).toLocaleString()} ₸**\n`;
    });

    await ctx.replyWithMarkdown(msg);
  },

  /**
   * ℹ️ Инфо о компании.
   */
  async showAbout(ctx) {
    await ctx.replyWithMarkdown(MESSAGES.USER.ABOUT_US);
  },

  /**
   * 📞 Переход в режим поддержки.
   */
  async enterContactMode(ctx) {
    ctx.session.state = USER_STATES.CONTACT_WAIT_MSG;
    await ctx.replyWithMarkdown(
      MESSAGES.USER.CONTACT_PROMPT,
      KEYBOARDS.CANCEL_MENU,
    );
  },

  /**
   * 📩 Обработка сообщения в поддержку.
   */
  async processSupportMessage(ctx, text) {
    const adminIds = await UserService.getAdminIdsForNotification();
    const userLink = ctx.from.username
      ? `@${ctx.from.username}`
      : ctx.from.first_name;

    const msg = MESSAGES.USER.SUPPORT_MSG_ADMIN(userLink, text);

    for (const adminId of adminIds) {
      try {
        await ctx.telegram.sendMessage(adminId, msg);
      } catch (e) {}
    }

    await ctx.replyWithMarkdown(MESSAGES.USER.CONTACT_SENT);
    this.returnToMainMenu(ctx);
  },

  /**
   * 🏠 Возврат в главное меню.
   */
  returnToMainMenu(ctx) {
    this.clearSession(ctx);
    return ctx.replyWithMarkdown(
      MESSAGES.USER.RETURN_MAIN,
      KEYBOARDS.MAIN_MENU,
    );
  },

  /**
   * 🧹 Сброс сессии.
   */
  clearSession(ctx) {
    if (!ctx.session) ctx.session = {};
    ctx.session.state = USER_STATES.IDLE;
    ctx.session.calcData = {};
    ctx.session.lastResult = null;
  },

  /**
   * 🏷️ Хелпер: Человекочитаемый тип стен.
   */
  getWallLabel(type) {
    const map = {
      wall_concrete: "Бетон (Монолит)",
      wall_brick: "Кирпич",
      wall_gas: "Газоблок",
    };
    return map[type] || "Стандарт";
  },
};

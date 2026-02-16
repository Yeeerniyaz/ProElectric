/**
 * @file src/handlers/UserHandler.js
 * @description Контроллер взаимодействия с пользователем (Presentation Layer).
 * Реализует машину состояний (FSM) для калькулятора, меню и поддержку.
 * @module UserHandler
 * @version 6.0.0 (Senior Production Ready)
 */

import { OrderService } from "../services/OrderService.js";
import { UserService } from "../services/UserService.js";
import { AdminHandler } from "./AdminHandler.js";
import { KEYBOARDS, MESSAGES, BUTTONS, TEXTS, ROLES } from "../constants.js";
import { getSettings } from "../database/repository.js";

// =============================================================================
// 🏗 СОСТОЯНИЯ (FINITE STATE MACHINE)
// =============================================================================
const USER_STATES = {
  IDLE: "IDLE", // Обычный режим меню
  CALC_WAIT_AREA: "WAIT_AREA", // Ожидание ввода площади
  CALC_WAIT_WALL: "WAIT_WALL", // Ожидание выбора стен
  CALC_WAIT_ROOMS: "WAIT_ROOMS", // Ожидание ввода комнат
  CONTACT_WAIT_MSG: "WAIT_MSG", // Ожидание сообщения в поддержку
};

// =============================================================================
// 🎮 ГЛАВНЫЙ КОНТРОЛЛЕР (USER HANDLER)
// =============================================================================
export const UserHandler = {
  /**
   * 🚀 Команда /start.
   * Регистрирует пользователя и инициализирует сессию.
   */
  async startCommand(ctx) {
    try {
      await ctx.sendChatAction("typing");

      // 1. Регистрация / Обновление данных пользователя (Upsert)
      // Получаем актуальную роль пользователя из БД
      const user = await UserService.registerOrUpdateUser(ctx.from);
      const userRole = user ? user.role : ROLES.CLIENT;

      // 2. Сброс состояния (Hard Reset)
      this.clearSession(ctx);

      // 3. Приветствие
      const userName = ctx.from.first_name || "Гость";

      // Используем HTML для жирного текста
      await ctx.replyWithHTML(TEXTS.welcome(userName), {
        reply_markup: KEYBOARDS.MAIN_MENU(userRole),
      });
    } catch (error) {
      console.error("[UserHandler] Start Error:", error);
      await ctx.reply("⚠️ Произошла ошибка при запуске. Попробуйте позже.");
    }
  },

  /**
   * 📨 Главный маршрутизатор текстовых сообщений (Router).
   * Определяет, что делать с входящим текстом в зависимости от состояния и роли.
   */
  async handleTextMessage(ctx) {
    const text = ctx.message.text;
    const session = ctx.session || {};
    const state = session.state || USER_STATES.IDLE;

    try {
      // 1. ГЛОБАЛЬНЫЕ ПЕРЕХВАТЧИКИ (Global Interceptors)
      // Кнопки "Главное меню", "Отмена" и команда /cancel работают всегда
      if (BUTTONS.common.includes(text) || text === "/cancel") {
        return this.returnToMainMenu(ctx);
      }

      // 2. АДМИНСКИЕ КНОПКИ (Admin Router Delegation)
      // Если нажата кнопка из админ-панели, передаем управление в AdminHandler
      if (
        [
          BUTTONS.ADMIN_PANEL,
          BUTTONS.ADMIN_STATS,
          BUTTONS.ADMIN_SETTINGS,
          BUTTONS.ADMIN_STAFF,
          BUTTONS.MANAGER_OBJECTS,
          BUTTONS.MANAGER_CASH,
        ].includes(text) ||
        text.startsWith("/")
      ) {
        return AdminHandler.handleMessage(ctx);
      }

      // 3. ОБРАБОТКА МЕНЮ (Idle State)
      if (state === USER_STATES.IDLE) {
        switch (text) {
          case BUTTONS.CALCULATOR:
            return this.enterCalculationMode(ctx);

          case BUTTONS.ORDERS:
            return this.showMyOrders(ctx);

          case BUTTONS.PRICE_LIST:
            return this.showPriceList(ctx);

          case BUTTONS.CONTACTS:
            return this.showContacts(ctx); // Новая функция без адреса

          // Дополнительные "мелкие" функции, если текст совпадет
          case "ℹ️ О нас":
            return this.showAbout(ctx);
        }
      }

      // 4. МАШИНА СОСТОЯНИЙ (Wizard Steps)
      switch (state) {
        case USER_STATES.CALC_WAIT_AREA:
          return this.processAreaInput(ctx, text);

        case USER_STATES.CALC_WAIT_ROOMS:
          return this.processRoomsInput(ctx, text);

        case USER_STATES.CONTACT_WAIT_MSG:
          return this.processSupportMessage(ctx, text);

        default:
          // Если состояние неизвестно или команда не распознана
          // Просто обновляем меню, чтобы у пользователя были правильные кнопки
          return this.returnToMainMenu(ctx, MESSAGES.USER.UNKNOWN_COMMAND);
      }
    } catch (error) {
      console.error("[UserHandler] Message Error:", error);
      await ctx.reply("⚠️ Ошибка обработки сообщения.");
    }
  },

  /**
   * 🖱 Маршрутизатор Inline-кнопок (Callback Query).
   */
  async handleCallback(ctx) {
    const data = ctx.callbackQuery.data;

    try {
      // Выбор стен (в процессе расчета)
      if (data.startsWith("wall_")) {
        return this.handleWallSelection(ctx);
      }

      // Действия после расчета
      if (data === "action_save_order") {
        return this.saveOrderAction(ctx);
      }

      if (data === "action_contact") {
        return this.enterContactMode(ctx);
      }

      await ctx.answerCbQuery(); // Убираем часики загрузки
    } catch (error) {
      console.error("[UserHandler] Callback Error:", error);
      await ctx.answerCbQuery("⚠️ Ошибка обработки кнопки");
    }
  },

  // ===========================================================================
  // 📐 БЛОК: КАЛЬКУЛЯТОР (WIZARD)
  // ===========================================================================

  /**
   * Шаг 0: Вход в режим расчета.
   */
  async enterCalculationMode(ctx) {
    this.clearSession(ctx); // Чистим старые данные
    ctx.session.state = USER_STATES.CALC_WAIT_AREA;
    ctx.session.calcData = {}; // Инициализируем буфер

    await ctx.reply(MESSAGES.USER.WIZARD_STEP_1_AREA, {
      reply_markup: KEYBOARDS.CANCEL_MENU,
    });
  },

  /**
   * Шаг 1: Обработка площади -> Переход к Стенам.
   */
  async processAreaInput(ctx, text) {
    // Валидация: заменяем запятую на точку, парсим число
    const area = parseFloat(text.replace(",", "."));

    // Проверка на дурака (Validation Layer)
    if (isNaN(area) || area <= 0 || area > 5000) {
      return ctx.replyWithMarkdown(MESSAGES.USER.WIZARD_ERROR_AREA);
    }

    ctx.session.calcData.area = area;
    ctx.session.state = USER_STATES.CALC_WAIT_WALL;

    await ctx.reply(MESSAGES.USER.WIZARD_STEP_2_WALL, {
      reply_markup: KEYBOARDS.WALL_TYPES,
    });
  },

  /**
   * Шаг 2: Обработка стен -> Переход к Комнатам.
   */
  async handleWallSelection(ctx) {
    const wallType = ctx.match[0]; // Получаем данные из callback_data

    // Защита от старых нажатий (если сессия истекла)
    if (ctx.session.state !== USER_STATES.CALC_WAIT_WALL) {
      return ctx.answerCbQuery(MESSAGES.USER.SESSION_EXPIRED, {
        show_alert: true,
      });
    }

    ctx.session.calcData.wallType = wallType;
    ctx.session.state = USER_STATES.CALC_WAIT_ROOMS;

    // UX: Редактируем сообщение с кнопками, чтобы нельзя было нажать повторно
    const wallName = this.getWallLabel(wallType);
    await ctx.editMessageText(`✅ Стены: <b>${wallName}</b>`, {
      parse_mode: "HTML",
    });

    await ctx.reply(MESSAGES.USER.WIZARD_STEP_3_ROOMS, {
      reply_markup: KEYBOARDS.CANCEL_MENU,
    });
    await ctx.answerCbQuery();
  },

  /**
   * Шаг 3: Обработка комнат -> Финальный расчет.
   */
  async processRoomsInput(ctx, text) {
    const rooms = parseInt(text);

    if (isNaN(rooms) || rooms < 1 || rooms > 50) {
      return ctx.reply(MESSAGES.USER.WIZARD_ERROR_ROOMS);
    }

    ctx.session.calcData.rooms = rooms;

    // Показываем "думаю..."
    await ctx.sendChatAction("typing");
    const processingMsg = await ctx.reply(MESSAGES.USER.CALCULATION_PROCESS);

    try {
      const { area, wallType } = ctx.session.calcData;

      // Вызов сервиса (Business Logic)
      const result = await OrderService.calculateComplexEstimate(
        area,
        rooms,
        wallType,
      );

      // Сохраняем результат в сессию (чтобы можно было оформить заказ)
      ctx.session.lastResult = result;
      ctx.session.state = USER_STATES.IDLE; // Выходим из режима ввода

      // Формируем чек
      // Используем шаблон из TEXTS или MESSAGES
      const invoiceText = TEXTS.estimateResult(
        "PREVIEW", // ID заказа пока нет
        result,
        wallType,
      );

      // Удаляем сообщение "Считаю..."
      await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);

      // Отправляем результат с кнопками действий
      await ctx.replyWithHTML(invoiceText, {
        reply_markup: KEYBOARDS.ESTIMATE_ACTIONS,
      });
    } catch (error) {
      console.error("[UserHandler] Calc Logic Error:", error);
      await ctx.reply(MESSAGES.USER.CALCULATION_ERROR);
      this.returnToMainMenu(ctx);
    }
  },

  // ===========================================================================
  // ⚡️ БЛОК: ДЕЙСТВИЯ (ACTIONS)
  // ===========================================================================

  /**
   * ✅ Сохранение заказа в БД.
   */
  async saveOrderAction(ctx) {
    const result = ctx.session.lastResult;

    if (!result) {
      return ctx.answerCbQuery(MESSAGES.USER.SESSION_EXPIRED, {
        show_alert: true,
      });
    }

    try {
      await ctx.sendChatAction("typing");

      // Создаем заказ через сервис
      const order = await OrderService.createOrder(ctx.from.id, result);

      // Редактируем сообщение (убираем кнопки "Сохранить", чтобы не дублировать)
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

      await ctx.replyWithMarkdown(MESSAGES.USER.SAVE_ORDER_SUCCESS(order.id));

      // Уведомление админам (Observer)
      this.notifyAdminsNewOrder(ctx, order, result.total.grandTotal);
    } catch (error) {
      console.error("[UserHandler] Save Order Error:", error);
      await ctx.reply(MESSAGES.USER.SAVE_ORDER_ERROR);
    }

    await ctx.answerCbQuery();
  },

  /**
   * 📞 Вход в режим "Вопрос менеджеру".
   */
  async enterContactMode(ctx) {
    ctx.session.state = USER_STATES.CONTACT_WAIT_MSG;
    await ctx.reply(MESSAGES.USER.CONTACT_PROMPT, {
      reply_markup: KEYBOARDS.CANCEL_MENU,
    });
    if (ctx.callbackQuery) await ctx.answerCbQuery();
  },

  /**
   * 📨 Отправка сообщения в поддержку.
   */
  async processSupportMessage(ctx, text) {
    if (text.length < 5) {
      return ctx.reply(
        "⚠️ Сообщение слишком короткое. Опишите вопрос подробнее.",
      );
    }

    try {
      const adminIds = await UserService.getAdminIdsForNotification();
      const userLink = ctx.from.username
        ? `@${ctx.from.username}`
        : `ID:${ctx.from.id}`;
      const msg = MESSAGES.USER.SUPPORT_MSG_ADMIN(userLink, text);

      // Рассылка всем админам
      for (const adminId of adminIds) {
        await ctx.telegram.sendMessage(adminId, msg).catch(() => {});
      }

      await ctx.reply(MESSAGES.USER.CONTACT_SENT);
      this.returnToMainMenu(ctx);
    } catch (e) {
      await ctx.reply("Ошибка отправки сообщения.");
    }
  },

  // ===========================================================================
  // ℹ️ БЛОК: ИНФОРМАЦИЯ И МЕНЮ
  // ===========================================================================

  /**
   * 💰 Показ прайс-листа.
   */
  async showPriceList(ctx) {
    await ctx.sendChatAction("typing");
    try {
      // Получаем актуальные настройки из БД, чтобы прайс был свежим
      // Вместо await OrderService.getSettings()
      const settings = (await getSettings())
        ? await OrderService.getSettings()
        : {};

      // Используем шаблон TEXTS.priceList
      await ctx.replyWithHTML(TEXTS.priceList(settings));
    } catch (e) {
      // Если ошибка, выводим дефолтный
      await ctx.replyWithHTML(TEXTS.priceList({}));
    }
  },

  /**
   * 📞 Показ контактов (БЕЗ АДРЕСА).
   */
  async showContacts(ctx) {
    // Формируем кастомное сообщение без адреса, как ты просил
    const contactMsg =
      `📞 <b>Наши контакты:</b>\n\n` +
      `👤 Главный инженер: @yeeerniyaz\n` +
      `📱 Телефон: +7 (777) 123-45-67\n` +
      `🕒 Режим работы: 09:00 - 20:00\n` +
      `💬 <i>Пишите в любое время!</i>`;

    await ctx.replyWithHTML(contactMsg);
  },

  /**
   * ℹ️ О нас (Мелкая функция).
   */
  async showAbout(ctx) {
    await ctx.replyWithMarkdown(MESSAGES.USER.ABOUT_US);
  },

  /**
   * 📂 Мои заказы.
   */
  async showMyOrders(ctx) {
    await ctx.sendChatAction("typing");
    const orders = await OrderService.getUserOrders(ctx.from.id);

    if (!orders || orders.length === 0) {
      return ctx.reply(MESSAGES.USER.NO_ORDERS);
    }

    let msg = MESSAGES.USER.MY_ORDERS_HEADER;
    orders.forEach((order, index) => {
      const date = new Date(order.created_at).toLocaleDateString();
      const price = parseInt(order.total_price).toLocaleString();
      const statusIcon =
        order.status === "new" ? "🆕" : order.status === "done" ? "✅" : "⚙️";

      msg += `${index + 1}. ${statusIcon} <b>${date}</b> — ${price} ₸\n`;
    });

    await ctx.replyWithMarkdown(msg);
  },

  // ===========================================================================
  // 🛠 ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ (HELPERS)
  // ===========================================================================

  /**
   * 🏠 Возврат в главное меню.
   * Умный метод: сам определяет роль пользователя для правильных кнопок.
   */
  async returnToMainMenu(ctx, customMessage = null) {
    this.clearSession(ctx);

    // Быстрый запрос роли
    let role = ROLES.CLIENT;
    try {
      const user = await ctx.reply(text, {
        reply_markup: KEYBOARDS.MAIN_MENU(role),
      });
      if (user) role = user.role;
    } catch (e) {}

    const text = customMessage || MESSAGES.USER.RETURN_MAIN;

    // Если сообщение вызвано callback-ом, используем reply, иначе обычный ответ
    await ctx.reply(text, KEYBOARDS.MAIN_MENU(role));
  },

  /**
   * 🧹 Очистка сессии.
   */
  clearSession(ctx) {
    if (!ctx.session) ctx.session = {};
    ctx.session.state = USER_STATES.IDLE;
    ctx.session.calcData = {};
    ctx.session.lastResult = null;
  },

  /**
   * 🏷 Текстовое описание стен.
   */
  getWallLabel(type) {
    const map = {
      wall_concrete: "Бетон (Монолит)",
      wall_brick: "Кирпич",
      wall_gas: "Газоблок",
    };
    return map[type] || "Стандарт";
  },

  /**
   * 🔔 Уведомление админов (Private).
   */
  async notifyAdminsNewOrder(ctx, order, totalSum) {
    try {
      const adminIds = await UserService.getAdminIdsForNotification();
      const userLink = ctx.from.username
        ? `@${ctx.from.username}`
        : ctx.from.first_name;

      // Пытаемся получить телефон из профиля
      const profile = await UserService.getUserProfile(ctx.from.id);
      const phone = profile?.phone || "Не указан";

      const msg = MESSAGES.USER.NEW_ORDER_ADMIN(
        order.id,
        userLink,
        phone,
        totalSum.toLocaleString(),
      );

      for (const adminId of adminIds) {
        await ctx.telegram
          .sendMessage(adminId, msg)
          .catch((e) => console.error("Admin send error", e));
      }
    } catch (e) {
      console.error("Notify Error", e);
    }
  },
};

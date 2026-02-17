/**
 * @file src/handlers/UserHandler.js
 * @description Обработчик действий пользователя (Client Side Controller).
 * Реализует полный цикл взаимодействия с акцентом на продажу услуг (Labor Only).
 * Цены теперь полностью динамические и берутся из базы данных через Service Layer.
 *
 * @author ProElectric Team
 * @version 6.2.0 (Senior Architect Edition)
 */

import { Markup } from "telegraf";
import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";

// =============================================================================
// 🔧 INTERNAL CONFIGURATION & CONSTANTS
// =============================================================================

/**
 * ID Владельца для критических уведомлений.
 */
const OWNER_ID = process.env.OWNER_ID || 123456789;

/**
 * Машина состояний (FSM).
 */
const USER_STATES = Object.freeze({
  IDLE: "IDLE",
  WAIT_PHONE: "WAIT_PHONE",
  CALC_AREA: "CALC_WAIT_AREA",
  CALC_WALL: "CALC_WAIT_WALL",
  CALC_ROOMS: "CALC_WAIT_ROOMS",
});

/**
 * Тексты кнопок.
 */
const BUTTONS = Object.freeze({
  CALCULATE: "🚀 Рассчитать стоимость",
  ORDERS: "📂 Мои заявки",
  PRICE_LIST: "💰 Прайс-лист",
  CONTACTS: "📞 Контакты",
  HOW_WORK: "ℹ️ Как мы работаем",
  BACK: "🔙 Назад",
  CANCEL: "❌ Отмена",
  SHARE_PHONE: "📱 Отправить мой номер телефона",
});

/**
 * Текстовые шаблоны.
 */
const TEXTS = {
  welcome: (name) =>
    `👋 Привет, ${name}!\n\n` +
    `🤖 Я — <b>Pro Electric Bot</b>.\n` +
    `Помогу быстро рассчитать стоимость электромонтажных работ.\n` +
    `Нажмите кнопку ниже, чтобы начать расчет.`,

  authRequest:
    `🔒 <b>Авторизация</b>\n\n` +
    `Для доступа к функциям бота, пожалуйста, подтвердите ваш номер телефона.`,

  howWeWork:
    `<b>🛠 НАШИ СТАНДАРТЫ</b>\n` +
    `➖➖➖➖➖➖➖➖➖➖\n` +
    `✅ <b>Монтаж:</b> Только ГОСТ, только хардкор (ГМЛ, ВВГ-нг-LS).\n` +
    `✅ <b>Чистота:</b> Работаем с пылесосом и штроборезом.\n` +
    `✅ <b>Договор:</b> Официальная гарантия 5 лет.\n` +
    `✅ <b>Оплата:</b> Поэтапная, по факту выполненных работ.`,

  estimateFooter:
    `\n⚠️ <b>ВАЖНОЕ ПРИМЕЧАНИЕ:</b>\n` +
    `1. Указанная сумма — <b>ПРЕДВАРИТЕЛЬНАЯ</b> и только за <b>РАБОТУ</b>.\n` +
    `2. Стоимость черновых материалов (кабель, гофра, подрозетники) рассчитывается отдельно по факту закупа.\n` +
    `3. Точная смета составляется инженером после выезда на объект.`,
};

// =============================================================================
// 🎹 KEYBOARDS FACTORY
// =============================================================================

const Keyboards = {
  mainMenu: (role) => {
    const buttons = [
      [BUTTONS.CALCULATE],
      [BUTTONS.ORDERS, BUTTONS.PRICE_LIST],
      [BUTTONS.CONTACTS, BUTTONS.HOW_WORK],
    ];
    if (["admin", "owner", "manager"].includes(role)) {
      buttons.push(["👑 Админ-панель"]);
    }
    return Markup.keyboard(buttons).resize();
  },

  requestPhone: Markup.keyboard([[Markup.button.contact(BUTTONS.SHARE_PHONE)]])
    .resize()
    .oneTime(),

  cancel: Markup.keyboard([[BUTTONS.CANCEL]]).resize(),

  wallSelection: Markup.inlineKeyboard([
    [Markup.button.callback("🧱 Газоблок / ГКЛ", "wall_gas")],
    [Markup.button.callback("🧱 Кирпич", "wall_brick")],
    [Markup.button.callback("🏗 Бетон / Монолит", "wall_concrete")],
  ]),

  estimateActions: Markup.inlineKeyboard([
    [Markup.button.callback("✅ Оформить выезд инженера", "action_save_order")],
    [
      Markup.button.callback("🔄 Пересчитать", "action_recalc"),
      Markup.button.url("💬 WhatsApp", "https://wa.me/77766066323"),
    ],
  ]),
};

// =============================================================================
// 🎮 CONTROLLER IMPLEMENTATION
// =============================================================================

export const UserHandler = {
  /**
   * ===========================================================================
   * 1. 🏁 INITIALIZATION & AUTH
   * ===========================================================================
   */

  async startCommand(ctx) {
    try {
      const telegramUser = ctx.from;
      const dbUser = await UserService.registerOrUpdateUser(telegramUser);
      if (!dbUser) return;

      if (!dbUser.phone) {
        ctx.session.state = USER_STATES.WAIT_PHONE;
        return ctx.replyWithHTML(TEXTS.authRequest, Keyboards.requestPhone);
      }

      await this.showMainMenu(ctx, dbUser.role);
    } catch (error) {
      console.error("[UserHandler] Start Error:", error);
      ctx.reply("⚠️ Ошибка системы. Попробуйте позже.");
    }
  },

  async handleContact(ctx) {
    try {
      if (ctx.session.state !== USER_STATES.WAIT_PHONE) return;

      const contact = ctx.message.contact;
      if (contact && contact.user_id === ctx.from.id) {
        await UserService.updateUserPhone(ctx.from.id, contact.phone_number);

        ctx.telegram
          .sendMessage(
            OWNER_ID,
            `🔔 <b>РЕГИСТРАЦИЯ ЛИДА</b>\n👤 ${ctx.from.first_name}\n📱 ${contact.phone_number}`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});

        ctx.session.state = USER_STATES.IDLE;
        await ctx.reply("✅ Доступ открыт!", {
          reply_markup: { remove_keyboard: true },
        });
        await this.showMainMenu(ctx, "user");
      } else {
        await ctx.reply("⛔ Нажмите кнопку для отправки контакта.");
      }
    } catch (error) {
      console.error("[UserHandler] Contact Error:", error);
    }
  },

  async showMainMenu(ctx, role = "user") {
    await ctx.replyWithHTML(
      TEXTS.welcome(ctx.from.first_name),
      Keyboards.mainMenu(role),
    );
  },

  /**
   * ===========================================================================
   * 2. 🚦 MESSAGE ROUTER
   * ===========================================================================
   */

  async handleTextMessage(ctx) {
    try {
      const text = ctx.message.text;
      const state = ctx.session.state || USER_STATES.IDLE;

      switch (text) {
        case BUTTONS.CALCULATE:
          return this.enterCalculationMode(ctx);
        case BUTTONS.PRICE_LIST:
          return this.showPriceList(ctx);
        case BUTTONS.ORDERS:
          return this.showMyOrders(ctx);
        case BUTTONS.CONTACTS:
          return ctx.replyWithHTML(
            "📞 <b>Контакты:</b>\nГл. Инженер Ернияз: +7 (776) 606-63-23",
            Markup.inlineKeyboard([
              [
                Markup.button.url(
                  "💬 Написать в WhatsApp",
                  "https://wa.me/77766066323",
                ),
              ],
            ]),
          );
        case BUTTONS.HOW_WORK:
          return ctx.replyWithHTML(TEXTS.howWeWork);
        case BUTTONS.BACK:
        case BUTTONS.CANCEL:
          return this.returnToMainMenu(ctx);
      }

      if (state === USER_STATES.WAIT_PHONE) return ctx.reply("👇 Жду контакт.");
      if (state === USER_STATES.CALC_AREA) return this.processAreaInput(ctx);
      if (state === USER_STATES.CALC_ROOMS) return this.processRoomsInput(ctx);
    } catch (error) {
      console.error("[UserHandler] Router Error:", error);
    }
  },

  /**
   * ===========================================================================
   * 3. 🧮 CALCULATION WIZARD
   * ===========================================================================
   */

  async enterCalculationMode(ctx) {
    ctx.session.state = USER_STATES.CALC_AREA;
    ctx.session.calcData = {};
    await ctx.reply(
      "📏 <b>Шаг 1/3:</b> Введите площадь помещения (м²):",
      Keyboards.cancel,
    );
  },

  async processAreaInput(ctx) {
    const area = parseFloat(ctx.message.text.replace(",", "."));
    if (isNaN(area) || area < 5 || area > 5000) {
      return ctx.reply("⚠️ Введите число от 5 до 5000.");
    }
    ctx.session.calcData.area = area;
    ctx.session.state = USER_STATES.CALC_WALL;
    await ctx.reply(
      "🧱 <b>Шаг 2/3:</b> Из чего стены?",
      Keyboards.wallSelection,
    );
  },

  async handleWallSelection(ctx) {
    if (ctx.session.state !== USER_STATES.CALC_WALL)
      return ctx.answerCbQuery("⚠️ Старая сессия.");

    ctx.session.calcData.wallType = ctx.match[0];
    ctx.session.state = USER_STATES.CALC_ROOMS;

    await ctx.answerCbQuery();
    await ctx.reply("🚪 <b>Шаг 3/3:</b> Сколько комнат?", Keyboards.cancel);
  },

  async processRoomsInput(ctx) {
    const rooms = parseInt(ctx.message.text);
    if (isNaN(rooms) || rooms < 1 || rooms > 50)
      return ctx.reply("⚠️ Введите целое число.");

    const data = ctx.session.calcData;
    data.rooms = rooms;

    const estimate = await OrderService.calculateComplexEstimate(
      data.area,
      data.rooms,
      data.wallType,
    );
    ctx.session.lastEstimate = estimate;

    const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);
    const wallNames = {
      wall_gas: "Газоблок",
      wall_brick: "Кирпич",
      wall_concrete: "Бетон",
    };

    const invoice =
      `📋 <b>ПРЕДВАРИТЕЛЬНЫЙ РАСЧЕТ</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `🏠 <b>Объект:</b> ${data.area} м² / ${data.rooms} комн.\n` +
      `🧱 <b>Стены:</b> ${wallNames[data.wallType]}\n\n` +
      `🛠 <b>ВИДЫ РАБОТ:</b>\n` +
      `• Электроточки: ~${estimate.volume.points} шт.\n` +
      `• Штробление: ~${estimate.volume.strobe} м.\n` +
      `• Прокладка кабеля: ~${estimate.volume.cable} м.\n` +
      `• Сборка щита: ~${estimate.volume.modules} модулей\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `💰 <b>ИТОГО ЗА РАБОТУ: ${fmt(estimate.total.work)} ₸</b>\n` +
      TEXTS.estimateFooter;

    ctx.session.state = USER_STATES.IDLE;
    await ctx.replyWithHTML(invoice, Keyboards.estimateActions);
  },

  /**
   * ===========================================================================
   * 4. 💾 ACTIONS & ORDERS
   * ===========================================================================
   */

  async saveOrderAction(ctx) {
    try {
      const estimate = ctx.session.lastEstimate;
      if (!estimate) return ctx.answerCbQuery("⚠️ Расчет устарел.");

      const order = await OrderService.createOrder(ctx.from.id, estimate);

      await ctx.answerCbQuery("✅ Заявка принята!");
      await ctx.editMessageText(
        `✅ <b>Заявка #${order.id} оформлена!</b>\n\n` +
          `Инженер свяжется с вами для уточнения времени замера.\n` +
          `Предварительная смета сохранена в разделе "Мои заявки".`,
        { parse_mode: "HTML" },
      );

      const userLink = ctx.from.username
        ? `@${ctx.from.username}`
        : `ID ${ctx.from.id}`;
      await ctx.telegram.sendMessage(
        OWNER_ID,
        `🆕 <b>НОВЫЙ ЛИД #${order.id}</b>\n` +
          `👤 Клиент: ${userLink} (${ctx.from.first_name})\n` +
          `💰 Работа: <b>${new Intl.NumberFormat("ru-RU").format(estimate.total.work)} ₸</b>\n` +
          `📦 Материал (прогноз): ${new Intl.NumberFormat("ru-RU").format(estimate.total.material)} ₸\n` +
          `🏠 Инфо: ${estimate.params.area}м² / ${estimate.params.wallType}`,
        { parse_mode: "HTML" },
      );

      ctx.session.lastEstimate = null;
      ctx.session.calcData = null;
    } catch (error) {
      console.error("[UserHandler] Save Error:", error);
      ctx.reply("❌ Ошибка сохранения.");
    }
  },

  async showMyOrders(ctx) {
    try {
      const orders = await OrderService.getUserOrders(ctx.from.id);
      if (!orders || orders.length === 0)
        return ctx.reply("📂 История заказов пуста.");

      const statusMap = {
        new: "🆕 Ожидает звонка",
        processing: "👨‍🔧 В обработке",
        work: "🛠 В работе",
        done: "✅ Завершен",
        cancel: "❌ Отменен",
      };

      const list = orders
        .map((o) => {
          const date = new Date(o.created_at).toLocaleDateString("ru-RU");
          const status = statusMap[o.status] || o.status;
          const price = new Intl.NumberFormat("ru-RU").format(o.total_price);
          return `<b>Заказ #${o.id}</b> (${date})\nСтатус: ${status}\nСумма: ${price} ₸`;
        })
        .join("\n\n");

      await ctx.replyWithHTML(`📂 <b>ВАШИ ЗАЯВКИ:</b>\n\n${list}`);
    } catch (e) {
      ctx.reply("Ошибка загрузки.");
    }
  },

  /**
   * 💰 ДИНАМИЧЕСКИЙ ПРАЙС-ЛИСТ
   * Берет актуальные цены из OrderService (который берет их из БД).
   */
  async showPriceList(ctx) {
    try {
      // Запрашиваем публичный прайс у сервиса
      const prices = await OrderService.getPublicPricelist();

      await ctx.replyWithHTML(
        `💰 <b>СТОИМОСТЬ РАБОТ (2026)</b>\n` +
          `<i>(Актуально на сегодня)</i>\n\n` +
          `<b>⛏ Черновой этап (Штробление):</b>\n` +
          `• Бетон: <b>${prices.strobeConcrete} ₸/м</b>\n` +
          `• Кирпич: <b>${prices.strobeBrick} ₸/м</b>\n` +
          `• Газоблок: <b>${prices.strobeGas} ₸/м</b>\n\n` +
          `<b>🕳 Высверливание подрозетников:</b>\n` +
          `• Бетон: <b>${prices.drillConcrete} ₸/шт</b>\n` +
          `• Кирпич: <b>${prices.drillBrick} ₸/шт</b>\n` +
          `• Газоблок: <b>${prices.drillGas} ₸/шт</b>\n\n` +
          `<b>🔌 Монтаж:</b>\n` +
          `• Прокладка кабеля: <b>${prices.cable} ₸/м</b>\n` +
          `• Установка механизмов: <b>${prices.socket} ₸/шт</b>\n` +
          `• Сборка щита: <b>${prices.shield} ₸/модуль</b>\n\n` +
          `<i>* Цены указаны за работу, без учета материалов.</i>`,
      );
    } catch (error) {
      console.error("[UserHandler] PriceList Error:", error);
      ctx.reply("⚠️ Не удалось загрузить прайс. Попробуйте позже.");
    }
  },

  async returnToMainMenu(ctx) {
    ctx.session.state = USER_STATES.IDLE;
    await this.showMainMenu(ctx);
  },
};

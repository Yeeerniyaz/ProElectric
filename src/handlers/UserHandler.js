/**
 * @file src/handlers/UserHandler.js
 * @description Обработчик действий пользователя (Client Side Controller).
 * Реализует полный цикл взаимодействия с акцентом на продажу услуг.
 * Исправлены ошибки с кнопками, состояниями и уведомлениями.
 *
 * @author ProElectric Team
 * @version 6.6.0 (Stable Senior Edition)
 */

import { Markup } from "telegraf";
import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";

// =============================================================================
// 🔧 INTERNAL CONFIGURATION
// =============================================================================

/**
 * ID Владельца. Используем твой ID как fallback, чтобы ошибки не падали.
 */
const OWNER_ID = process.env.OWNER_ID || 2041384570;

/**
 * Состояния пользователя (FSM).
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
 * Должны совпадать с TRIGGERS в bot.js.
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
  ADMIN_PANEL: "👑 Админ-панель",
});

// =============================================================================
// 🎹 KEYBOARDS FACTORY
// =============================================================================

const Keyboards = {
  /**
   * Главное меню.
   * Адаптируется под роль пользователя.
   */
  mainMenu: (role = "user") => {
    const buttons = [
      [BUTTONS.CALCULATE],
      [BUTTONS.ORDERS, BUTTONS.PRICE_LIST],
      [BUTTONS.CONTACTS, BUTTONS.HOW_WORK],
    ];

    // Добавляем кнопку админки только для персонала
    if (["owner", "admin", "manager"].includes(role)) {
      buttons.push([BUTTONS.ADMIN_PANEL]);
    }

    return Markup.keyboard(buttons).resize();
  },

  /**
   * Кнопка запроса телефона.
   * FIX: Используем правильный формат объекта для Telegraf 4.x
   */
  requestPhone: Markup.keyboard([
    [{ text: BUTTONS.SHARE_PHONE, request_contact: true }],
  ])
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
   * 1. 🏁 INITIALIZATION (Start & Auth)
   * ===========================================================================
   */

  async startCommand(ctx) {
    try {
      // 1. Сброс состояния (FIX: Решает проблему "зависшего" бота)
      if (ctx.session) {
        ctx.session.state = USER_STATES.IDLE;
        ctx.session.calcData = {};
      }

      // 2. Регистрация / Обновление данных пользователя
      let role = "user";
      try {
        const dbUser = await UserService.registerOrUpdateUser(ctx.from);
        if (dbUser) {
          role = dbUser.role;

          // Если нет телефона, требуем его (блокируем меню)
          if (!dbUser.phone) {
            ctx.session.state = USER_STATES.WAIT_PHONE;
            return ctx.replyWithHTML(
              `👋 Привет, ${ctx.from.first_name}!\n\n` +
                `🔒 <b>Авторизация</b>\n` +
                `Для доступа к расчету сметы, пожалуйста, подтвердите ваш номер телефона кнопкой ниже.`,
              Keyboards.requestPhone,
            );
          }
        }
      } catch (dbError) {
        console.error("[UserHandler] Auth Warning:", dbError.message);
        // Если БД упала, пускаем как юзера, чтобы бот не "молчал"
      }

      // 3. Показ меню
      await this.showMainMenu(ctx, role);
    } catch (error) {
      console.error("[UserHandler] Start Critical Error:", error);
      ctx.reply("⚠️ Произошел сбой. Напишите /start для перезагрузки.");
    }
  },

  async showMainMenu(ctx, role = "user") {
    await ctx.replyWithHTML(
      `👋 <b>Добро пожаловать в Pro Electric!</b>\n\n` +
        `Я помогу рассчитать предварительную стоимость электромонтажных работ.\n` +
        `Выберите действие в меню:`,
      Keyboards.mainMenu(role),
    );
  },

  async handleContact(ctx) {
    try {
      // Игнорируем контакты, если мы их не ждем
      if (ctx.session.state !== USER_STATES.WAIT_PHONE) return;

      const contact = ctx.message.contact;
      // Проверка: контакт должен принадлежать отправителю
      if (contact && contact.user_id === ctx.from.id) {
        await UserService.updateUserPhone(ctx.from.id, contact.phone_number);

        // Уведомление админу (безопасно)
        ctx.telegram
          .sendMessage(
            OWNER_ID,
            `🔔 <b>РЕГИСТРАЦИЯ</b>\n👤 ${ctx.from.first_name}\n📱 ${contact.phone_number}`,
            { parse_mode: "HTML" },
          )
          .catch((e) => console.warn("Admin notification failed:", e.message));

        ctx.session.state = USER_STATES.IDLE;
        await ctx.reply("✅ Спасибо! Доступ открыт.", {
          reply_markup: { remove_keyboard: true },
        });
        await this.showMainMenu(ctx, "user");
      } else {
        await ctx.reply("⛔ Пожалуйста, используйте кнопку снизу.");
      }
    } catch (error) {
      console.error("[UserHandler] Contact Error:", error);
    }
  },

  /**
   * ===========================================================================
   * 2. 🚦 MESSAGE ROUTER
   * ===========================================================================
   */

  async handleTextMessage(ctx) {
    try {
      const text = ctx.message.text;
      const state = ctx.session?.state || USER_STATES.IDLE;

      // Глобальные команды меню (работают всегда)
      switch (text) {
        case BUTTONS.CALCULATE:
          return this.enterCalculationMode(ctx);
        case BUTTONS.PRICE_LIST:
          return this.showPriceList(ctx);
        case BUTTONS.ORDERS:
          return this.showMyOrders(ctx);
        case BUTTONS.CONTACTS:
          return ctx.replyWithHTML(
            `📞 <b>Наши Контакты:</b>\n\n` +
              `👷‍♂️ Гл. Инженер: <b>Ернияз</b>\n` +
              `📱 Телефон: <a href="tel:+77766066323">+7 (776) 606-63-23</a>\n` +
              `📍 Город: Алматы`,
            Markup.inlineKeyboard([
              [Markup.button.url("💬 WhatsApp", "https://wa.me/77766066323")],
            ]),
          );
        case BUTTONS.HOW_WORK:
          return ctx.replyWithHTML(
            `<b>🛠 КАК МЫ РАБОТАЕМ</b>\n` +
              `1️⃣ <b>Предварительный расчет:</b> Вы делаете тут, в боте.\n` +
              `2️⃣ <b>Замер:</b> Инженер приезжает, смотрит стены, корректирует смету.\n` +
              `3️⃣ <b>Договор:</b> Фиксируем цены и гарантию 5 лет.\n` +
              `4️⃣ <b>Монтаж:</b> Черновой этап → Чистовой этап.`,
          );
        case BUTTONS.BACK:
        case BUTTONS.CANCEL:
          return this.returnToMainMenu(ctx);
      }

      // Обработка состояний (Wizard)
      if (state === USER_STATES.WAIT_PHONE) {
        return ctx.reply("👇 Нажмите кнопку 'Отправить телефон' для входа.");
      }
      if (state === USER_STATES.CALC_AREA) {
        return this.processAreaInput(ctx);
      }
      if (state === USER_STATES.CALC_ROOMS) {
        return this.processRoomsInput(ctx);
      }

      // Если ничего не подошло
      // ctx.reply("🤖 Я не понял команду. Воспользуйтесь меню.");
    } catch (error) {
      console.error("[UserHandler] Router Error:", error);
    }
  },

  /**
   * ===========================================================================
   * 3. 🧮 CALCULATION LOGIC
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
    const input = ctx.message.text.replace(",", ".");
    const area = parseFloat(input);

    if (isNaN(area) || area < 5 || area > 5000) {
      return ctx.reply("⚠️ Пожалуйста, введите число от 5 до 5000.");
    }

    ctx.session.calcData.area = area;
    ctx.session.state = USER_STATES.CALC_WALL;
    await ctx.reply(
      "🧱 <b>Шаг 2/3:</b> Из какого материала стены?",
      Keyboards.wallSelection,
    );
  },

  async handleWallSelection(ctx) {
    // Проверка сессии (чтобы не жали старые кнопки)
    if (ctx.session.state !== USER_STATES.CALC_WALL) {
      return ctx.answerCbQuery("⚠️ Расчет был прерван. Начните заново.");
    }

    ctx.session.calcData.wallType = ctx.match[0]; // wall_brick etc.
    ctx.session.state = USER_STATES.CALC_ROOMS;

    await ctx.answerCbQuery();
    await ctx.reply(
      "🚪 <b>Шаг 3/3:</b> Сколько у вас комнат?",
      Keyboards.cancel,
    );
  },

  async processRoomsInput(ctx) {
    const rooms = parseInt(ctx.message.text);
    if (isNaN(rooms) || rooms < 1 || rooms > 50) {
      return ctx.reply("⚠️ Введите целое число (например: 2).");
    }

    const data = ctx.session.calcData;
    data.rooms = rooms;

    // Расчет через сервис
    const estimate = await OrderService.calculateComplexEstimate(
      data.area,
      data.rooms,
      data.wallType,
    );
    ctx.session.lastEstimate = estimate;

    // Форматирование
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
      `🛠 <b>ОБЪЕМЫ РАБОТ (Примерно):</b>\n` +
      `• Электроточки: ${estimate.volume.points} шт.\n` +
      `• Штробление: ${estimate.volume.strobe} м.\n` +
      `• Кабель (ГОСТ): ${estimate.volume.cable} м.\n` +
      `• Автоматы в щит: ${estimate.volume.modules} шт.\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `💰 <b>СТОИМОСТЬ РАБОТ: ${fmt(estimate.total.work)} ₸</b>\n\n` +
      `<i>⚠️ Это предварительный расчет. Точная смета составляется инженером после осмотра объекта.</i>`;

    ctx.session.state = USER_STATES.IDLE;
    await ctx.replyWithHTML(invoice, Keyboards.estimateActions);
  },

  /**
   * ===========================================================================
   * 4. 💾 SAVE & ORDERS
   * ===========================================================================
   */

  async saveOrderAction(ctx) {
    try {
      const estimate = ctx.session.lastEstimate;
      if (!estimate) return ctx.answerCbQuery("⚠️ Время сессии истекло.");

      // Создаем заказ в БД
      const order = await OrderService.createOrder(ctx.from.id, estimate);

      // 1. Сначала отвечаем юзеру (чтобы интерфейс не висел)
      await ctx.answerCbQuery("✅ Заявка создана!");
      await ctx.editMessageText(
        `✅ <b>Заявка #${order.id} принята!</b>\n\n` +
          `Мы свяжемся с вами в ближайшее время для уточнения деталей.\n` +
          `Статус заявки можно проверить в разделе "Мои заявки".`,
        { parse_mode: "HTML" },
      );

      // Очистка
      ctx.session.lastEstimate = null;
      ctx.session.calcData = null;

      // 2. Уведомление Владельцу (фоном, с защитой от ошибок)
      const userLink = ctx.from.username
        ? `@${ctx.from.username}`
        : `ID ${ctx.from.id}`;

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      ctx.telegram
        .sendMessage(
          OWNER_ID,
          `🆕 <b>НОВЫЙ ЗАКАЗ #${order.id}</b>\n` +
            `👤 ${ctx.from.first_name} (${userLink})\n` +
            `💰 <b>${fmt(estimate.total.work)} ₸</b>\n` +
            `🏠 ${estimate.params.area}м², ${estimate.params.wallType}`,
          { parse_mode: "HTML" },
        )
        .catch((e) =>
          console.warn(
            `⚠️ Failed to notify owner about order #${order.id}: ${e.message}`,
          ),
        );
    } catch (error) {
      console.error("[UserHandler] Save Error:", error);
      ctx.reply("❌ Не удалось сохранить заявку. Попробуйте позже.");
    }
  },

  async showMyOrders(ctx) {
    try {
      const orders = await OrderService.getUserOrders(ctx.from.id);
      if (!orders || orders.length === 0) {
        return ctx.reply("📂 У вас пока нет активных заявок.");
      }

      const statusMap = {
        new: "🆕 Новый",
        processing: "⏳ В обработке",
        work: "🔨 В работе",
        done: "✅ Выполнен",
        cancel: "❌ Отменен",
      };

      const list = orders
        .map(
          (o) =>
            `<b>Заказ #${o.id}</b> | ${statusMap[o.status] || o.status}\n` +
            `Сумма: ${new Intl.NumberFormat("ru-RU").format(o.total_price)} ₸`,
        )
        .join("\n\n");

      await ctx.replyWithHTML(`📂 <b>ИСТОРИЯ ЗАЯВОК:</b>\n\n${list}`);
    } catch (e) {
      ctx.reply("Ошибка получения данных.");
    }
  },

  async showPriceList(ctx) {
    try {
      // Пытаемся получить актуальные цены, или берем дефолт
      let p = {
        cable: 350,
        socket: 1200,
        strobeConcrete: 2000,
      };

      try {
        if (OrderService.getPublicPricelist) {
          p = { ...p, ...(await OrderService.getPublicPricelist()) };
        }
      } catch (e) {
        console.warn("Failed to fetch prices from DB, using defaults.");
      }

      await ctx.replyWithHTML(
        `💰 <b>ПРАЙС-ЛИСТ 2026</b>\n\n` +
          `🔹 Штробление (бетон): <b>${p.strobeConcrete} ₸/м</b>\n` +
          `🔹 Прокладка кабеля: <b>${p.cable} ₸/м</b>\n` +
          `🔹 Установка розетки: <b>${p.socket} ₸/шт</b>\n\n` +
          `<i>Полный прайс уточняйте у инженера.</i>`,
      );
    } catch (e) {
      ctx.reply("⚠️ Прайс временно недоступен.");
    }
  },

  /**
   * Возврат в меню и сброс состояния
   */
  async returnToMainMenu(ctx) {
    ctx.session.state = USER_STATES.IDLE;
    // Определяем роль (если в сессии нет, пробуем 'user', startCommand исправит при перезапуске)
    await this.showMainMenu(ctx, "user");
  },
};

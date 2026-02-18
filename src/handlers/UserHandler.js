/**
 * @file src/handlers/UserHandler.js
 * @description Обработчик действий пользователя (Client Side Controller).
 * Реализует полный цикл взаимодействия с акцентом на продажу услуг.
 * Включает систему отслеживания "брошенных корзин" (Abandoned Cart).
 *
 * @author ProElectric Team
 * @version 7.2.0 (Senior Architect Edition)
 */

import { Markup } from "telegraf";
import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";

// =============================================================================
// 🔧 INTERNAL CONFIGURATION
// =============================================================================

/**
 * ID Владельца. Используется для отправки уведомлений о новых лидах и заказах.
 */
const OWNER_ID = process.env.OWNER_ID || 2041384570;

/**
 * Система отложенных уведомлений (Брошенная корзина).
 * Хранит ID таймеров для каждого пользователя.
 */
const PENDING_NOTIFICATIONS = new Map();
const ABANDONED_TIMEOUT_MS = 15 * 60 * 1000; // 15 минут (в миллисекундах)

/**
 * Состояния пользователя (FSM - Конечный автомат).
 */
const USER_STATES = Object.freeze({
  IDLE: "IDLE",
  WAIT_PHONE: "WAIT_PHONE",
  CALC_AREA: "CALC_WAIT_AREA",
  CALC_WALL: "CALC_WAIT_WALL",
  CALC_ROOMS: "CALC_WAIT_ROOMS",
});

/**
 * Тексты кнопок. Должны совпадать с TRIGGERS в bot.js.
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
   * Главное меню. Адаптируется под роль пользователя (RBAC).
   */
  mainMenu: (role = "user") => {
    const buttons = [
      [BUTTONS.CALCULATE],
      [BUTTONS.ORDERS, BUTTONS.PRICE_LIST],
      [BUTTONS.CONTACTS, BUTTONS.HOW_WORK],
    ];

    // Добавляем кнопку админки только для управляющего персонала
    if (["owner", "admin", "manager"].includes(role)) {
      buttons.push([BUTTONS.ADMIN_PANEL]);
    }

    return Markup.keyboard(buttons).resize();
  },

  /**
   * Кнопка запроса телефона.
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
      // 1. Сброс состояния (Решает проблему "зависшего" бота)
      if (ctx.session) {
        ctx.session.state = USER_STATES.IDLE;
        ctx.session.calcData = {};
      }

      // Очищаем таймер брошенной корзины, если он был
      if (PENDING_NOTIFICATIONS.has(ctx.from.id)) {
        clearTimeout(PENDING_NOTIFICATIONS.get(ctx.from.id));
        PENDING_NOTIFICATIONS.delete(ctx.from.id);
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

  /**
   * Перехват отправки контакта.
   * Отправляет максимально подробный отчет Владельцу о новом лиде.
   */
  async handleContact(ctx) {
    try {
      if (ctx.session.state !== USER_STATES.WAIT_PHONE) return;

      const contact = ctx.message.contact;

      // Проверка: контакт должен принадлежать отправителю
      if (contact && contact.user_id === ctx.from.id) {
        await UserService.updateUserPhone(ctx.from.id, contact.phone_number);

        // Формируем уведомление для Владельца со всеми данными
        const userLink = ctx.from.username
          ? `@${ctx.from.username}`
          : `Без Username`;

        ctx.telegram
          .sendMessage(
            OWNER_ID,
            `🔔 <b>РЕГИСТРАЦИЯ НОВОГО КЛИЕНТА</b>\n` +
              `➖➖➖➖➖➖➖➖➖➖\n` +
              `👤 <b>Имя:</b> ${ctx.from.first_name}\n` +
              `🔗 <b>Username:</b> ${userLink}\n` +
              `🆔 <b>ID:</b> <code>${ctx.from.id}</code>\n` +
              `📱 <b>Телефон:</b> <code>${contact.phone_number}</code>\n` +
              `➖➖➖➖➖➖➖➖➖➖\n` +
              `<i>Клиент успешно авторизован и получил доступ к калькулятору.</i>`,
            { parse_mode: "HTML" },
          )
          .catch((e) => console.warn("Admin notification failed:", e.message));

        ctx.session.state = USER_STATES.IDLE;
        await ctx.reply("✅ Спасибо! Номер успешно привязан. Доступ открыт.", {
          reply_markup: { remove_keyboard: true },
        });

        // Получаем актуальную роль и показываем меню
        const role = await UserService.getUserRole(ctx.from.id);
        await this.showMainMenu(ctx, role);
      } else {
        await ctx.reply(
          "⛔ Пожалуйста, используйте кнопку снизу для отправки именно вашего контакта.",
        );
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

      // Глобальные команды меню
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

      // Маршрутизация по стейтам FSM
      if (state === USER_STATES.WAIT_PHONE) {
        return ctx.reply("👇 Нажмите кнопку 'Отправить телефон' для входа.");
      }
      if (state === USER_STATES.CALC_AREA) {
        return this.processAreaInput(ctx);
      }
      if (state === USER_STATES.CALC_ROOMS) {
        return this.processRoomsInput(ctx);
      }
    } catch (error) {
      console.error("[UserHandler] Router Error:", error);
    }
  },

  /**
   * ===========================================================================
   * 3. 🧮 CALCULATION LOGIC (FSM WIZARD)
   * ===========================================================================
   */

  async enterCalculationMode(ctx) {
    ctx.session.state = USER_STATES.CALC_AREA;
    ctx.session.calcData = {};

    // Очищаем старый таймер брошенной корзины при новом расчете
    if (PENDING_NOTIFICATIONS.has(ctx.from.id)) {
      clearTimeout(PENDING_NOTIFICATIONS.get(ctx.from.id));
      PENDING_NOTIFICATIONS.delete(ctx.from.id);
    }

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
    if (ctx.session.state !== USER_STATES.CALC_WALL) {
      return ctx.answerCbQuery("⚠️ Расчет был прерван. Начните заново.");
    }

    ctx.session.calcData.wallType = ctx.match[0];
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

    // Вызываем логику расчета из OrderService
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
      `🛠 <b>ОБЪЕМЫ РАБОТ (Примерно):</b>\n` +
      `• Электроточки: ${estimate.volume.points} шт.\n` +
      `• Штробление: ${estimate.volume.strobe} м.\n` +
      `• Кабель (ГОСТ): ${estimate.volume.cable} м.\n` +
      `• Автоматы в щит: ${estimate.volume.modules} шт.\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `💰 <b>СТОИМОСТЬ РАБОТ: ${fmt(estimate.total.work)} ₸</b>\n\n` +
      `<i>⚠️ Обратите внимание: Это стоимость ТОЛЬКО ЗА РАБОТУ. Материалы закупаются отдельно по чекам или спецификации после выезда инженера на замер (Примерный прогноз на материалы: ~${fmt(estimate.total.material_info)} ₸).</i>\n\n` +
      `<i>Нажмите "Оформить выезд инженера", чтобы зафиксировать заявку.</i>`;

    ctx.session.state = USER_STATES.IDLE;
    await ctx.replyWithHTML(invoice, Keyboards.estimateActions);

    // =========================================================
    // ⏰ ЗАПУСК ТАЙМЕРА БРОШЕННОЙ КОРЗИНЫ (АВТО-ФОЛЛОУАП)
    // =========================================================

    // Удаляем предыдущий таймер на всякий случай
    if (PENDING_NOTIFICATIONS.has(ctx.from.id)) {
      clearTimeout(PENDING_NOTIFICATIONS.get(ctx.from.id));
    }

    // Создаем новый таймер. Если юзер не нажмет "Оформить" за 15 минут, прилетит алерт
    const timeoutId = setTimeout(async () => {
      try {
        const userProfile = await UserService.getUserProfile(ctx.from.id);
        const userLink = ctx.from.username
          ? `@${ctx.from.username}`
          : `Без Username`;

        await ctx.telegram.sendMessage(
          OWNER_ID,
          `⚠️ <b>БРОШЕННАЯ СМЕТА (Отвал на этапе цены)</b>\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `👤 <b>Клиент:</b> ${ctx.from.first_name}\n` +
            `🔗 <b>Username:</b> ${userLink}\n` +
            `📱 <b>Телефон:</b> <code>${userProfile?.phone || "Не указан"}</code>\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `🏠 <b>Объект:</b> ${data.area} м² / ${data.rooms} комн. (${wallNames[data.wallType]})\n` +
            `💰 <b>Сумма работ: ${fmt(estimate.total.work)} ₸</b>\n\n` +
            `<i>💡 Совет: Клиент рассчитал стоимость, но не стал оформлять заявку. Свяжитесь с ним, чтобы отработать возражения или предложить бесплатный замер!</i>`,
          { parse_mode: "HTML" },
        );
      } catch (e) {
        console.error("Failed to send abandoned cart notification", e);
      } finally {
        PENDING_NOTIFICATIONS.delete(ctx.from.id);
      }
    }, ABANDONED_TIMEOUT_MS);

    // Сохраняем ID таймера в память
    PENDING_NOTIFICATIONS.set(ctx.from.id, timeoutId);
  },

  /**
   * ===========================================================================
   * 4. 💾 SAVE & ORDERS
   * ===========================================================================
   */

  async saveOrderAction(ctx) {
    try {
      const estimate = ctx.session.lastEstimate;
      if (!estimate)
        return ctx.answerCbQuery(
          "⚠️ Время сессии истекло. Начните расчет заново.",
        );

      // 🛑 ОТМЕНЯЕМ ТАЙМЕР БРОШЕННОЙ КОРЗИНЫ (Клиент успешно оформил заказ)
      if (PENDING_NOTIFICATIONS.has(ctx.from.id)) {
        clearTimeout(PENDING_NOTIFICATIONS.get(ctx.from.id));
        PENDING_NOTIFICATIONS.delete(ctx.from.id);
      }

      // Создаем заказ в БД
      const order = await OrderService.createOrder(ctx.from.id, estimate);

      // Вытягиваем профиль юзера, чтобы получить телефон для отчета
      const userProfile = await UserService.getUserProfile(ctx.from.id);

      // 1. Сообщение пользователю
      await ctx.answerCbQuery("✅ Заявка создана!");
      await ctx.editMessageText(
        `✅ <b>Заявка #${order.id} принята!</b>\n\n` +
          `Мы свяжемся с вами в ближайшее время для уточнения деталей и согласования времени замера.\n` +
          `Статус заявки можно проверять в разделе "Мои заявки".`,
        { parse_mode: "HTML" },
      );

      ctx.session.lastEstimate = null;
      ctx.session.calcData = null;

      // 2. Детальный отчет Владельцу (Все данные в одном сообщении)
      const userLink = ctx.from.username
        ? `@${ctx.from.username}`
        : `Без Username`;
      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);
      const wallNames = {
        wall_gas: "Газоблок",
        wall_brick: "Кирпич",
        wall_concrete: "Бетон",
      };

      ctx.telegram
        .sendMessage(
          OWNER_ID,
          `🆕 <b>НОВЫЙ ЗАКАЗ #${order.id}</b>\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `👤 <b>Клиент:</b> ${ctx.from.first_name}\n` +
            `🔗 <b>Username:</b> ${userLink}\n` +
            `🆔 <b>ID:</b> <code>${ctx.from.id}</code>\n` +
            `📱 <b>Телефон:</b> <code>${userProfile?.phone || "Не указан"}</code>\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `🏠 <b>Объект:</b>\n` +
            `• Площадь: ${estimate.params.area} м²\n` +
            `• Комнат: ${estimate.params.rooms}\n` +
            `• Стены: ${wallNames[estimate.params.wallType] || estimate.params.wallType}\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `💰 <b>Сумма работ: ${fmt(estimate.total.work)} ₸</b>\n` +
            `📦 Прогноз материалов: ~${fmt(estimate.total.material_info)} ₸\n\n` +
            `<i>Перейдите в админ-панель (или используйте команду /order ${order.id}), чтобы взять заказ в работу.</i>`,
          { parse_mode: "HTML" },
        )
        .catch((e) =>
          console.warn(
            `⚠️ Failed to notify owner about order #${order.id}: ${e.message}`,
          ),
        );
    } catch (error) {
      console.error("[UserHandler] Save Error:", error);
      ctx.answerCbQuery("❌ Ошибка").catch(() => {});
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
            `Сумма работ: ${new Intl.NumberFormat("ru-RU").format(o.total_price)} ₸`,
        )
        .join("\n\n");

      await ctx.replyWithHTML(`📂 <b>ИСТОРИЯ ЗАЯВОК:</b>\n\n${list}`);
    } catch (e) {
      ctx.reply("Ошибка получения данных.");
    }
  },

  /**
   * 📋 Вывод актуального прайс-листа прямо из Базы Данных.
   */
  async showPriceList(ctx) {
    try {
      // Подтягиваем свежие данные из БД
      let p = await OrderService.getPublicPricelist();

      await ctx.replyWithHTML(
        `💰 <b>АКТУАЛЬНЫЙ ПРАЙС-ЛИСТ</b>\n\n` +
          `<b>🧱 Черновые работы:</b>\n` +
          `🔹 Штробление (Бетон): <b>${p.strobeConcrete} ₸/м</b>\n` +
          `🔹 Штробление (Кирпич): <b>${p.strobeBrick} ₸/м</b>\n` +
          `🔹 Штробление (Газоблок): <b>${p.strobeGas} ₸/м</b>\n` +
          `🔹 Точка подрозетника (Бетон): <b>${p.drillConcrete} ₸/шт</b>\n\n` +
          `<b>⚡️ Монтажные работы:</b>\n` +
          `🔹 Прокладка кабеля: <b>${p.cable} ₸/м</b>\n` +
          `🔹 Установка розетки/выкл.: <b>${p.socket} ₸/шт</b>\n` +
          `🔹 Сборка щита (за 1 модуль): <b>${p.shield} ₸/шт</b>\n\n` +
          `<i>* Указаны базовые цены за работу. Точная смета формируется после выезда инженера на замер. Материалы оплачиваются отдельно по чекам.</i>`,
      );
    } catch (e) {
      console.error(e);
      ctx.reply(
        "⚠️ Прайс-лист временно недоступен. Ведутся технические работы.",
      );
    }
  },

  /**
   * 🔙 Возврат в главное меню
   */
  async returnToMainMenu(ctx) {
    if (ctx.session) ctx.session.state = USER_STATES.IDLE;
    const role = await UserService.getUserRole(ctx.from.id);
    await this.showMainMenu(ctx, role);
  },
};

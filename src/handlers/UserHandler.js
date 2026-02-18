/**
 * @file src/handlers/UserHandler.js
 * @description Обработчик клиентской части (Client Controller v9.0.0 Enterprise).
 * Управляет воронкой продаж "Лид -> Предварительный расчет -> Оформление".
 * Интегрирован с финансовым ядром, генератором BOM и системой удержания (Abandoned Cart).
 *
 * @module UserHandler
 * @version 9.0.0 (Senior Architect Edition)
 */

import { Markup } from "telegraf";
import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";

// =============================================================================
// 🔧 INTERNAL CONFIGURATION & STATE MACHINE
// =============================================================================

const OWNER_ID = process.env.OWNER_ID || 2041384570;

// Система "Брошенная корзина" (Abandoned Cart Analytics)
const PENDING_NOTIFICATIONS = new Map();
const ABANDONED_TIMEOUT_MS = 15 * 60 * 1000; // 15 минут

const USER_STATES = Object.freeze({
  IDLE: "IDLE",
  WAIT_PHONE: "WAIT_PHONE",
  CALC_AREA: "CALC_WAIT_AREA",
  CALC_WALL: "CALC_WAIT_WALL",
  CALC_ROOMS: "CALC_WAIT_ROOMS",
});

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
  mainMenu: (role = "user") => {
    const buttons = [
      [BUTTONS.CALCULATE],
      [BUTTONS.ORDERS, BUTTONS.PRICE_LIST],
      [BUTTONS.CONTACTS, BUTTONS.HOW_WORK],
    ];

    if (["owner", "admin", "manager"].includes(role)) {
      buttons.push([BUTTONS.ADMIN_PANEL]);
    }

    return Markup.keyboard(buttons).resize();
  },

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
   * 1. 🏁 INITIALIZATION & AUTH (IDENTITY MODULE)
   * ===========================================================================
   */

  async startCommand(ctx) {
    try {
      if (ctx.session) {
        ctx.session.state = USER_STATES.IDLE;
        ctx.session.calcData = {};
      }

      // Очистка таймеров при рестарте
      if (PENDING_NOTIFICATIONS.has(ctx.from.id)) {
        clearTimeout(PENDING_NOTIFICATIONS.get(ctx.from.id));
        PENDING_NOTIFICATIONS.delete(ctx.from.id);
      }

      let role = "user";
      try {
        const dbUser = await UserService.registerOrUpdateUser(ctx.from);
        if (dbUser) {
          role = dbUser.role;

          // Жесткая проверка телефона для доступа к функциям CRM
          if (!dbUser.phone) {
            ctx.session.state = USER_STATES.WAIT_PHONE;
            return ctx.replyWithHTML(
              `👋 Привет, <b>${ctx.from.first_name}</b>!\n\n` +
                `🔒 <b>Верификация профиля</b>\n` +
                `Для доступа к инженерному калькулятору, пожалуйста, подтвердите ваш номер телефона, нажав кнопку ниже.`,
              Keyboards.requestPhone,
            );
          }
        }
      } catch (dbError) {
        console.error("[UserHandler] Auth Error:", dbError.message);
      }

      await this.showMainMenu(ctx, role);
    } catch (error) {
      console.error("[UserHandler] Start Command Error:", error);
      ctx.reply(
        "⚠️ Критический сбой системы. Отправьте /start для перезагрузки сессии.",
      );
    }
  },

  async showMainMenu(ctx, role = "user") {
    await ctx.replyWithHTML(
      `👋 <b>Добро пожаловать в ProElectric!</b>\n\n` +
        `Автоматизированная система оценки электромонтажных работ.\n` +
        `Выберите необходимое действие:`,
      Keyboards.mainMenu(role),
    );
  },

  async handleContact(ctx) {
    try {
      if (ctx.session.state !== USER_STATES.WAIT_PHONE) return;
      const contact = ctx.message.contact;

      if (contact && contact.user_id === ctx.from.id) {
        await UserService.updateUserPhone(ctx.from.id, contact.phone_number);

        const userLink = ctx.from.username
          ? `@${ctx.from.username}`
          : `Без Username`;

        // Немедленный алерт Владельцу о новом лиде
        ctx.telegram
          .sendMessage(
            OWNER_ID,
            `🔔 <b>РЕГИСТРАЦИЯ НОВОГО КЛИЕНТА</b>\n` +
              `➖➖➖➖➖➖➖➖➖➖\n` +
              `👤 <b>Имя:</b> ${ctx.from.first_name}\n` +
              `🔗 <b>Telegram:</b> ${userLink}\n` +
              `🆔 <b>ID:</b> <code>${ctx.from.id}</code>\n` +
              `📱 <b>Телефон:</b> <code>${contact.phone_number}</code>\n` +
              `➖➖➖➖➖➖➖➖➖➖\n` +
              `<i>Пользователь успешно прошел верификацию.</i>`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});

        ctx.session.state = USER_STATES.IDLE;
        await ctx.reply(
          "✅ Отлично! Ваш номер успешно привязан. Доступ в систему открыт.",
          { reply_markup: { remove_keyboard: true } },
        );

        const role = await UserService.getUserRole(ctx.from.id);
        await this.showMainMenu(ctx, role);
      } else {
        await ctx.reply(
          "⛔ Пожалуйста, используйте специальную кнопку меню для отправки именно вашего системного контакта.",
        );
      }
    } catch (error) {
      console.error("[UserHandler] Handle Contact Error:", error);
    }
  },

  /**
   * ===========================================================================
   * 2. 🚦 ROUTER & STATIC CONTENT
   * ===========================================================================
   */

  async handleTextMessage(ctx) {
    try {
      const text = ctx.message.text;
      const state = ctx.session?.state || USER_STATES.IDLE;

      // Глобальный роутинг кнопок
      switch (text) {
        case BUTTONS.CALCULATE:
          return this.enterCalculationMode(ctx);
        case BUTTONS.PRICE_LIST:
          return this.showPriceList(ctx);
        case BUTTONS.ORDERS:
          return this.showMyOrders(ctx);
        case BUTTONS.CONTACTS:
          return ctx.replyWithHTML(
            `📞 <b>НАШИ КОНТАКТЫ:</b>\n\n` +
              `👷‍♂️ Главный Инженер: <b>Ернияз</b>\n` +
              `📱 Связь: <a href="tel:+77766066323">+7 (776) 606-63-23</a>\n` +
              `📍 Базирование: г. Алматы`,
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
          return ctx.replyWithHTML(
            `<b>🛠 РЕГЛАМЕНТ РАБОТЫ</b>\n\n` +
              `1️⃣ <b>Предварительный расчет:</b> Вы формируете ТЗ через этот бот.\n` +
              `2️⃣ <b>Инженерный замер:</b> Специалист изучает объект, согласовывает точки и формирует точную спецификацию.\n` +
              `3️⃣ <b>Договор:</b> Юридическая фиксация сметы и гарантийных обязательств.\n` +
              `4️⃣ <b>Монтаж:</b> Выполнение чернового, а затем чистового этапа работ.`,
          );
        case BUTTONS.BACK:
        case BUTTONS.CANCEL:
          return this.returnToMainMenu(ctx);
      }

      // Обработка FSM состояний ввода калькулятора
      if (state === USER_STATES.WAIT_PHONE)
        return ctx.reply(
          "👇 Для работы с ботом требуется нажать кнопку 'Отправить телефон'.",
        );
      if (state === USER_STATES.CALC_AREA) return this.processAreaInput(ctx);
      if (state === USER_STATES.CALC_ROOMS) return this.processRoomsInput(ctx);
    } catch (error) {
      console.error("[UserHandler] Text Router Error:", error);
    }
  },

  /**
   * ===========================================================================
   * 3. 🧮 ERP CALCULATOR WIZARD (v9.0 Engine)
   * ===========================================================================
   */

  async enterCalculationMode(ctx) {
    ctx.session.state = USER_STATES.CALC_AREA;
    ctx.session.calcData = {};

    if (PENDING_NOTIFICATIONS.has(ctx.from.id)) {
      clearTimeout(PENDING_NOTIFICATIONS.get(ctx.from.id));
      PENDING_NOTIFICATIONS.delete(ctx.from.id);
    }

    await ctx.replyWithHTML(
      "📏 <b>Шаг 1 из 3:</b>\nВведите общую площадь помещения в квадратных метрах (число):",
      Keyboards.cancel,
    );
  },

  async processAreaInput(ctx) {
    const input = ctx.message.text.replace(",", ".");
    const area = parseFloat(input);

    if (isNaN(area) || area < 5 || area > 5000) {
      return ctx.reply(
        "⚠️ Ошибка валидации: площадь должна быть числом от 5 до 5000 м².",
      );
    }

    ctx.session.calcData.area = area;
    ctx.session.state = USER_STATES.CALC_WALL;
    await ctx.replyWithHTML(
      "🧱 <b>Шаг 2 из 3:</b>\nВыберите основной материал конструктива стен:",
      Keyboards.wallSelection,
    );
  },

  async handleWallSelection(ctx) {
    if (ctx.session.state !== USER_STATES.CALC_WALL) {
      return ctx.answerCbQuery(
        "⚠️ Сессия расчета устарела. Запустите калькулятор заново.",
      );
    }

    ctx.session.calcData.wallType = ctx.match[0];
    ctx.session.state = USER_STATES.CALC_ROOMS;

    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      "🚪 <b>Шаг 3 из 3:</b>\nУкажите количество комнат (учитывая кухню, если она изолирована):",
      Keyboards.cancel,
    );
  },

  async processRoomsInput(ctx) {
    const rooms = parseInt(ctx.message.text);
    if (isNaN(rooms) || rooms < 1 || rooms > 50) {
      return ctx.reply(
        "⚠️ Ошибка валидации: введите целое число комнат (например: 2).",
      );
    }

    const data = ctx.session.calcData;
    data.rooms = rooms;

    // Вызов ERP-ядра v9.0 для генерации сложной сметы
    const estimate = await OrderService.calculateComplexEstimate(
      data.area,
      data.rooms,
      data.wallType,
    );
    ctx.session.lastEstimate = estimate;

    const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

    // estimate.params.wallType уже содержит человекочитаемое название благодаря маппингу в OrderService
    const invoice =
      `📋 <b>ПРЕДВАРИТЕЛЬНАЯ СМЕТА v9.0</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `🏠 <b>Параметры:</b> ${data.area} м² / ${data.rooms} комн.\n` +
      `🧱 <b>Конструктив:</b> ${estimate.params.wallType}\n\n` +
      `🛠 <b>ИНЖЕНЕРНЫЕ ОБЪЕМЫ:</b>\n` +
      `• Электроточки: <b>${estimate.volume.points} шт.</b> (вкл. розеток: ${estimate.volume.detailedPoints.sockets})\n` +
      `• Штробление трасс: <b>${estimate.volume.strobe} м.</b>\n` +
      `• Кабельные линии: <b>${estimate.volume.cable} м.</b>\n` +
      `• Коммутационный щит: <b>${estimate.volume.modules} мод.</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `💰 <b>СТОИМОСТЬ МОНТАЖА: ${fmt(estimate.total.work)} ₸</b>\n\n` +
      `📦 <i>Информация по закупкам:\nСистема сгенерировала BIM-спецификацию (BOM) чернового материала на сумму ~${fmt(estimate.total.material_info)} ₸. Финальный список формируется после физического замера.</i>\n\n` +
      `<i>Для фиксации предварительной сметы нажмите «Оформить выезд инженера».</i>`;

    ctx.session.state = USER_STATES.IDLE;
    await ctx.replyWithHTML(invoice, Keyboards.estimateActions);

    // =========================================================
    // ⏰ АНАЛИТИКА УДЕРЖАНИЯ (ABANDONED CART TRIGGER)
    // =========================================================

    if (PENDING_NOTIFICATIONS.has(ctx.from.id))
      clearTimeout(PENDING_NOTIFICATIONS.get(ctx.from.id));

    const timeoutId = setTimeout(async () => {
      try {
        const userProfile = await UserService.getUserProfile(ctx.from.id);
        const userLink = ctx.from.username ? `@${ctx.from.username}` : `Скрыт`;

        await ctx.telegram.sendMessage(
          OWNER_ID,
          `⚠️ <b>АЛЕРТ: БРОШЕННАЯ КОРЗИНА</b>\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `👤 <b>Клиент:</b> ${ctx.from.first_name}\n` +
            `🔗 <b>Telegram:</b> ${userLink}\n` +
            `📱 <b>Телефон:</b> <code>${userProfile?.phone || "Нет данных"}</code>\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `🏠 <b>Данные:</b> ${data.area} м² / ${data.rooms} комн. (${estimate.params.wallType})\n` +
            `💰 <b>Сумма работ: ${fmt(estimate.total.work)} ₸</b>\n\n` +
            `<i>💡 Аналитика: Клиент сделал расчет 15 минут назад, но не нажал кнопку оформления. Свяжитесь с ним для подогрева лида!</i>`,
          { parse_mode: "HTML" },
        );
      } catch (e) {
        console.error("Failed to execute abandoned cart trigger", e);
      } finally {
        PENDING_NOTIFICATIONS.delete(ctx.from.id);
      }
    }, ABANDONED_TIMEOUT_MS);

    PENDING_NOTIFICATIONS.set(ctx.from.id, timeoutId);
  },

  /**
   * ===========================================================================
   * 4. 💾 ЗАВЕРШЕНИЕ СДЕЛКИ И ИНФОБЛОКИ
   * ===========================================================================
   */

  async saveOrderAction(ctx) {
    try {
      const estimate = ctx.session.lastEstimate;
      if (!estimate)
        return ctx.answerCbQuery(
          "⚠️ Время сессии истекло. Пожалуйста, сделайте расчет заново.",
        );

      // Очищаем таймер брошенной корзины - клиент конвертировался!
      if (PENDING_NOTIFICATIONS.has(ctx.from.id)) {
        clearTimeout(PENDING_NOTIFICATIONS.get(ctx.from.id));
        PENDING_NOTIFICATIONS.delete(ctx.from.id);
      }

      // Создаем заказ в БД с инициализацией финансового блока (financials)
      const order = await OrderService.createOrder(ctx.from.id, estimate);
      const userProfile = await UserService.getUserProfile(ctx.from.id);

      await ctx.answerCbQuery("✅ Объект успешно зарегистрирован в базе!");
      await ctx.editMessageText(
        `✅ <b>Заявка на объект #${order.id} подтверждена!</b>\n\n` +
          `Инженерный отдел свяжется с вами для согласования удобного времени выезда на замер.\n` +
          `Контролировать статус объекта можно в разделе "Мои заявки".`,
        { parse_mode: "HTML" },
      );

      // Очистка сессии калькулятора
      ctx.session.lastEstimate = null;
      ctx.session.calcData = null;

      const userLink = ctx.from.username ? `@${ctx.from.username}` : `Скрыт`;
      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      // Рапорт Владельцу о закрытии лида в сделку
      ctx.telegram
        .sendMessage(
          OWNER_ID,
          `🆕 <b>РЕГИСТРАЦИЯ НОВОГО ОБЪЕКТА #${order.id}</b>\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `👤 <b>Заказчик:</b> ${ctx.from.first_name}\n` +
            `🔗 <b>Telegram:</b> ${userLink}\n` +
            `📱 <b>Контакт:</b> <code>${userProfile?.phone || "Нет данных"}</code>\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `🏠 <b>Геометрия:</b> ${estimate.params.area} м² | ${estimate.params.rooms} комн.\n` +
            `🧱 <b>Конструктив:</b> ${estimate.params.wallType}\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `💰 <b>Расчетная база (Работа): ${fmt(estimate.total.work)} ₸</b>\n` +
            `📦 <i>BOM Спецификация сгенерирована: ${estimate.bom ? estimate.bom.length : 0} позиций (~${fmt(estimate.total.material_info)} ₸)</i>\n\n` +
            `<i>⚡️ Подробная финансовая карточка доступна в Web CRM.</i>`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
    } catch (error) {
      console.error("[UserHandler] Save Order Error:", error);
      ctx.answerCbQuery("❌ Системный сбой").catch(() => {});
      ctx.reply(
        "❌ Произошла ошибка базы данных. Попробуйте оформить заявку позже.",
      );
    }
  },

  async showMyOrders(ctx) {
    try {
      const orders = await OrderService.getUserOrders(ctx.from.id);
      if (!orders || orders.length === 0) {
        return ctx.reply(
          "📂 В данный момент у вас нет активных или завершенных объектов.",
        );
      }

      const statusMap = {
        new: "🆕 В обработке (Ожидание)",
        processing: "⏳ Назначен замер",
        work: "🔨 В процессе монтажа",
        done: "✅ Успешно сдан",
        cancel: "❌ Отменен/Отказ",
      };

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      const list = orders
        .map((o) => {
          // Читаем финальную договорную цену, если она была изменена админом в Web CRM
          const finalPrice =
            o.details?.financials?.final_price || o.total_price;
          return (
            `<b>Объект #${o.id}</b> | ${statusMap[o.status] || o.status}\n` +
            `Договорная стоимость: ${fmt(finalPrice)} ₸\n` +
            `<i>Дата: ${new Date(o.created_at).toLocaleDateString("ru-RU")}</i>`
          );
        })
        .join("\n\n");

      await ctx.replyWithHTML(`📂 <b>РЕЕСТР ВАШИХ ОБЪЕКТОВ:</b>\n\n${list}`);
    } catch (e) {
      console.error("[UserHandler] Show Orders Error:", e);
      ctx.reply("⚠️ Ошибка синхронизации с базой данных.");
    }
  },

  async showPriceList(ctx) {
    try {
      const p = await OrderService.getPublicPricelist();

      await ctx.replyWithHTML(
        `💰 <b>БАЗОВЫЙ ПРАЙС-ЛИСТ (v9.0)</b>\n\n` +
          `<b>🧱 Подготовка (Черновая стадия):</b>\n` +
          `🔹 Штроба (Бетон/Монолит): <b>${p.strobeConcrete} ₸/м</b>\n` +
          `🔹 Штроба (Кирпич): <b>${p.strobeBrick} ₸/м</b>\n` +
          `🔹 Штроба (Газоблок/ГКЛ): <b>${p.strobeGas} ₸/м</b>\n` +
          `🔹 Бурение лунки под точку: <b>${p.drillConcrete}</b>\n\n` +
          `<b>⚡️ Монтаж (Инженерия):</b>\n` +
          `🔹 Прокладка кабельной трассы: <b>${p.cable} ₸/м</b>\n` +
          `🔹 Монтаж механизма розетки/выкл.: <b>${p.socket} ₸/шт</b>\n` +
          `🔹 Сборка и коммутация щита: <b>${p.shield}</b>\n\n` +
          `<i>* Прайс является базовым. Финальная смета формируется алгоритмом с учетом надбавок за гофру, кабель-каналы и конфигурацию конкретного объекта.</i>`,
      );
    } catch (e) {
      console.error("[UserHandler] Pricelist Error:", e);
      ctx.reply("⚠️ Модуль выгрузки прайс-листа временно недоступен.");
    }
  },

  async returnToMainMenu(ctx) {
    if (ctx.session) {
      ctx.session.state = USER_STATES.IDLE;
      ctx.session.calcData = null;
      ctx.session.lastEstimate = null;
    }
    const role = await UserService.getUserRole(ctx.from.id);
    await this.showMainMenu(ctx, role);
  },
};

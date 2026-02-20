/**
 * @file src/handlers/UserHandler.js
 * @description Обработчик клиентской части (Client Controller v10.9.2 Enterprise).
 * Управляет воронкой продаж "Лид -> Предварительный расчет -> Оформление".
 * ИСПРАВЛЕНО: Полный переход на Inline-клавиатуры (запрет текстового ввода команд).
 *
 * @module UserHandler
 * @version 10.9.2 (Senior Architect Edition - Inline Only)
 */

import { Markup } from "telegraf";
import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";
import * as db from "../database/index.js";
import { getSocketIO } from "../bot.js";

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

// =============================================================================
// 🎹 KEYBOARDS FACTORY (INLINE ONLY)
// =============================================================================

const Keyboards = {
  // 🔥 Главное меню теперь полностью Inline
  mainMenuInline: (role = "user") => {
    const buttons = [
      [Markup.button.callback("🚀 Рассчитать стоимость", "cmd_calculate")],
      [
        Markup.button.callback("📂 Мои заявки", "cmd_orders"),
        Markup.button.callback("💰 Прайс-лист", "cmd_pricelist"),
      ],
      [
        Markup.button.callback("📞 Контакты", "cmd_contacts"),
        Markup.button.callback("ℹ️ Как мы работаем", "cmd_how_work"),
      ],
    ];

    if (["owner", "admin"].includes(role)) {
      buttons.push([
        Markup.button.callback(
          "🔑 Доступ в Web CRM (Владелец)",
          "cmd_web_auth",
        ),
      ]);
    }

    if (role === "manager") {
      buttons.push([
        Markup.button.callback("👷 Панель Бригадира", "cmd_brigade_panel"),
      ]);
      buttons.push([
        Markup.button.callback("🔑 Доступ в Web CRM", "cmd_web_auth"),
      ]);
    }

    return Markup.inlineKeyboard(buttons);
  },

  // ⚠️ Единственное исключение: Telegram требует обычную клавиатуру для запроса контакта
  requestPhone: Markup.keyboard([
    [{ text: "📱 Отправить мой номер телефона", request_contact: true }],
  ])
    .resize()
    .oneTime(),

  cancelInline: Markup.inlineKeyboard([
    [Markup.button.callback("❌ Отмена", "cmd_cancel")],
  ]),

  wallSelection: Markup.inlineKeyboard([
    [Markup.button.callback("🧱 Газоблок / ГКЛ", "wall_gas")],
    [Markup.button.callback("🧱 Кирпич", "wall_brick")],
    [Markup.button.callback("🏗 Бетон / Монолит", "wall_concrete")],
  ]),

  estimateActions: Markup.inlineKeyboard([
    [Markup.button.callback("✅ Оформить выезд инженера", "action_save_order")],
    [
      Markup.button.callback("🔄 Пересчитать", "cmd_calculate"),
      Markup.button.url("💬 WhatsApp", "https://wa.me/77066066323"),
    ],
  ]),

  userOrderActions: (orderId, status) => {
    const buttons = [];
    if (status === "new") {
      buttons.push([
        Markup.button.callback(
          "❌ Отменить заказ",
          `user_cancel_order_${orderId}`,
        ),
      ]);
    } else if (status === "processing" || status === "work") {
      buttons.push([
        Markup.button.callback(
          "👨‍💼 Связаться с Руководителем",
          `user_ping_boss_${orderId}`,
        ),
      ]);
    }
    return buttons.length > 0 ? Markup.inlineKeyboard(buttons) : null;
  },
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

      if (PENDING_NOTIFICATIONS.has(ctx.from.id)) {
        clearTimeout(PENDING_NOTIFICATIONS.get(ctx.from.id));
        PENDING_NOTIFICATIONS.delete(ctx.from.id);
      }

      let role = "user";
      try {
        const dbUser = await UserService.registerOrUpdateUser(ctx.from);
        if (dbUser) {
          role = dbUser.role;

          if (!dbUser.phone) {
            ctx.session.state = USER_STATES.WAIT_PHONE;
            return ctx.replyWithHTML(
              `👋 Привет, <b>${ctx.from.first_name}</b>!\n\n` +
                `🔒 <b>Верификация профиля</b>\n` +
                `Для доступа к системе, пожалуйста, подтвердите ваш номер телефона.`,
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

  async showMainMenu(ctx, role = "user", isEdit = false) {
    const text =
      `👋 <b>Добро пожаловать в ProElectric!</b>\n\n` +
      `Автоматизированная система управления электромонтажными работами.\n` +
      `Выберите необходимое действие ниже:`;

    if (isEdit) {
      // Если это ответ на callback (нажатие кнопки Назад)
      await ctx
        .editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: Keyboards.mainMenuInline(role).reply_markup,
        })
        .catch(() => {});
    } else {
      // Удаляем старую текстовую клавиатуру (если вдруг осталась) и шлем инлайн
      await ctx.replyWithHTML(text, {
        reply_markup: { remove_keyboard: true },
      });
      await ctx.replyWithHTML("Главное меню:", Keyboards.mainMenuInline(role));
    }
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

        ctx.telegram
          .sendMessage(
            OWNER_ID,
            `🔔 <b>РЕГИСТРАЦИЯ НОВОГО КЛИЕНТА</b>\n➖➖➖➖➖➖➖➖➖➖\n` +
              `👤 <b>Имя:</b> ${ctx.from.first_name}\n` +
              `🔗 <b>Telegram:</b> ${userLink}\n` +
              `📱 <b>Телефон:</b> <code>${contact.phone_number}</code>\n➖➖➖➖➖➖➖➖➖➖`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});

        ctx.session.state = USER_STATES.IDLE;

        // Удаляем кнопку отправки контакта
        await ctx.reply(
          "✅ Отлично! Ваш номер успешно привязан. Доступ в систему открыт.",
          { reply_markup: { remove_keyboard: true } },
        );

        const role = await UserService.getUserRole(ctx.from.id);
        await this.showMainMenu(ctx, role);
      } else {
        await ctx.reply(
          "⛔ Пожалуйста, используйте специальную кнопку меню для отправки именно вашего контакта.",
        );
      }
    } catch (error) {
      console.error("[UserHandler] Handle Contact Error:", error);
    }
  },

  /**
   * ===========================================================================
   * 2. 🚦 TEXT INPUT ROUTER (FSM ONLY)
   * ===========================================================================
   */
  async handleTextMessage(ctx) {
    try {
      const state = ctx.session?.state || USER_STATES.IDLE;

      // Теперь текстовые сообщения обрабатываются ТОЛЬКО если бот ждет ввода площади или комнат
      if (state === USER_STATES.WAIT_PHONE) {
        return ctx.reply(
          "👇 Пожалуйста, нажмите кнопку 'Отправить телефон' внизу экрана.",
        );
      }
      if (state === USER_STATES.CALC_AREA) return this.processAreaInput(ctx);
      if (state === USER_STATES.CALC_ROOMS) return this.processRoomsInput(ctx);

      // Если бот ничего не ждет, а юзер пишет текст — игнорируем или мягко просим использовать меню
      if (state === USER_STATES.IDLE) {
        return ctx.reply(
          "👇 Пожалуйста, используйте кнопки меню выше (или напишите /start для перезапуска).",
        );
      }
    } catch (error) {
      console.error("[UserHandler] Text Router Error:", error);
    }
  },

  /**
   * ===========================================================================
   * 3. 🔐 WEB AUTH (OTP GENERATOR)
   * ===========================================================================
   */
  async generateWebOTP(ctx) {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const { otp, phone } = await UserService.generateWebOTP(ctx.from.id);

      const message =
        `🔐 <b>Доступ в Web CRM</b>\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `👤 <b>Ваш логин:</b> <code>${phone}</code>\n` +
        `🔑 <b>Временный пароль:</b> <code>${otp}</code>\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `<i>⏳ Пароль действительен 15 минут. Никому не сообщайте этот код!</i>`;

      await ctx.replyWithHTML(message);
    } catch (error) {
      await ctx.reply(`❌ Ошибка доступа: ${error.message}`);
    }
  },

  /**
   * ===========================================================================
   * 4. 🧮 ERP CALCULATOR WIZARD
   * ===========================================================================
   */

  async enterCalculationMode(ctx) {
    await ctx.answerCbQuery().catch(() => {});
    ctx.session.state = USER_STATES.CALC_AREA;
    ctx.session.calcData = {};

    if (PENDING_NOTIFICATIONS.has(ctx.from.id)) {
      clearTimeout(PENDING_NOTIFICATIONS.get(ctx.from.id));
      PENDING_NOTIFICATIONS.delete(ctx.from.id);
    }

    await ctx.replyWithHTML(
      "📏 <b>Шаг 1 из 3:</b>\nВведите общую площадь помещения в квадратных метрах (число):",
      Keyboards.cancelInline,
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
    await ctx.editMessageText(
      "🚪 <b>Шаг 3 из 3:</b>\nУкажите количество комнат (учитывая кухню, если она изолирована):",
      { parse_mode: "HTML", reply_markup: Keyboards.cancelInline.reply_markup },
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

    const estimate = await OrderService.calculateComplexEstimate(
      data.area,
      data.rooms,
      data.wallType,
    );
    ctx.session.lastEstimate = estimate;

    const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);
    const bomCount = estimate.bom?.length || 0;

    const invoice =
      `📋 <b>ПРЕДВАРИТЕЛЬНАЯ СМЕТА v10.0.0</b>\n` +
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
      `📦 <i>Информация по закупкам:\nСистема сгенерировала спецификацию (BOM) чернового материала на сумму ~${fmt(estimate.total.material_info)} ₸ (${bomCount} позиций). Точный список материалов мы согласуем после инженерного замера.</i>\n\n` +
      `<i>Для фиксации предварительной сметы нажмите «Оформить выезд инженера».</i>`;

    ctx.session.state = USER_STATES.IDLE;
    await ctx.replyWithHTML(invoice, Keyboards.estimateActions);

    if (PENDING_NOTIFICATIONS.has(ctx.from.id))
      clearTimeout(PENDING_NOTIFICATIONS.get(ctx.from.id));

    const timeoutId = setTimeout(async () => {
      try {
        const userProfile = await UserService.getUserProfile(ctx.from.id);
        const userLink = ctx.from.username ? `@${ctx.from.username}` : `Скрыт`;

        await ctx.telegram.sendMessage(
          OWNER_ID,
          `⚠️ <b>АЛЕРТ: БРОШЕННАЯ КОРЗИНА</b>\n➖➖➖➖➖➖➖➖➖➖\n` +
            `👤 <b>Клиент:</b> ${ctx.from.first_name}\n` +
            `🔗 <b>Telegram:</b> ${userLink}\n` +
            `📱 <b>Телефон:</b> <code>${userProfile?.phone || "Нет данных"}</code>\n➖➖➖➖➖➖➖➖➖➖\n` +
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
   * 5. 💾 ЗАВЕРШЕНИЕ СДЕЛКИ И УПРАВЛЕНИЕ ЗАКАЗАМИ
   * ===========================================================================
   */

  async saveOrderAction(ctx) {
    try {
      const estimate = ctx.session.lastEstimate;
      if (!estimate)
        return ctx.answerCbQuery(
          "⚠️ Время сессии истекло. Пожалуйста, сделайте расчет заново.",
        );

      if (PENDING_NOTIFICATIONS.has(ctx.from.id)) {
        clearTimeout(PENDING_NOTIFICATIONS.get(ctx.from.id));
        PENDING_NOTIFICATIONS.delete(ctx.from.id);
      }

      const order = await OrderService.createOrder(ctx.from.id, estimate);
      const userProfile = await UserService.getUserProfile(ctx.from.id);

      await ctx.answerCbQuery("✅ Объект успешно зарегистрирован!");
      await ctx.editMessageText(
        `✅ <b>Заявка на объект #${order.id} подтверждена!</b>\n\n` +
          `Инженерный отдел свяжется с вами для согласования удобного времени выезда на замер.\n` +
          `Контролировать статус объекта можно в разделе "Мои заявки".`,
        { parse_mode: "HTML" },
      );

      ctx.session.lastEstimate = null;
      ctx.session.calcData = null;

      const userLink = ctx.from.username ? `@${ctx.from.username}` : `Скрыт`;
      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);
      const bomCount = estimate.bom?.length || 0;

      ctx.telegram
        .sendMessage(
          OWNER_ID,
          `🆕 <b>РЕГИСТРАЦИЯ НОВОГО ОБЪЕКТА #${order.id}</b>\n➖➖➖➖➖➖➖➖➖➖\n` +
            `👤 <b>Заказчик:</b> ${ctx.from.first_name}\n` +
            `🔗 <b>Telegram:</b> ${userLink}\n` +
            `📱 <b>Контакт:</b> <code>${userProfile?.phone || "Нет данных"}</code>\n➖➖➖➖➖➖➖➖➖➖\n` +
            `🏠 <b>Геометрия:</b> ${estimate.params.area} м² | ${estimate.params.rooms} комн.\n` +
            `🧱 <b>Конструктив:</b> ${estimate.params.wallType}\n➖➖➖➖➖➖➖➖➖➖\n` +
            `💰 <b>Расчетная база (Работа): ${fmt(estimate.total.work)} ₸</b>\n` +
            `📦 <i>BOM Спецификация сгенерирована: ${bomCount} позиций (~${fmt(estimate.total.material_info)} ₸)</i>\n\n` +
            `<i>⚡️ Подробная финансовая карточка доступна в Web CRM.</i>`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
    } catch (error) {
      console.error("[UserHandler] Save Order Error:", error);
      ctx.answerCbQuery("❌ Системный сбой").catch(() => {});
    }
  },

  async showMyOrders(ctx) {
    try {
      await ctx.answerCbQuery().catch(() => {});
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

      await ctx.replyWithHTML(`📂 <b>РЕЕСТР ВАШИХ ОБЪЕКТОВ:</b>`);

      for (const o of orders) {
        const finalPrice = o.details?.financials?.final_price ?? o.total_price;
        const msg =
          `<b>Объект #${o.id}</b> | ${statusMap[o.status] || o.status}\n` +
          `💰 Договорная стоимость: <b>${fmt(finalPrice)} ₸</b>\n` +
          `📅 Дата создания: <i>${new Date(o.created_at).toLocaleDateString("ru-RU")}</i>`;

        const keyboard = Keyboards.userOrderActions(o.id, o.status);

        if (keyboard) {
          await ctx.replyWithHTML(msg, keyboard);
        } else {
          await ctx.replyWithHTML(msg);
        }
        await new Promise((res) => setTimeout(res, 100));
      }
    } catch (e) {
      console.error("[UserHandler] Show Orders Error:", e);
      ctx.reply("⚠️ Ошибка синхронизации с базой данных.");
    }
  },

  async cancelOrderByUser(ctx, orderId) {
    try {
      const order = await OrderService.getOrderById(orderId);
      if (!order || order.user_id !== ctx.from.id) {
        return ctx.answerCbQuery("⚠️ Это не ваш заказ или он не найден.", {
          show_alert: true,
        });
      }
      if (order.status !== "new") {
        return ctx.answerCbQuery(
          "⚠️ Этот заказ уже обрабатывается. Отмена невозможна.",
          { show_alert: true },
        );
      }

      await OrderService.updateOrderStatus(orderId, "cancel");

      const io = getSocketIO();
      if (io) io.emit("order_updated", { orderId, status: "cancel" });

      await ctx.editMessageText(
        `❌ <b>Объект #${orderId} успешно отменен.</b>\nЗаявка отозвана и удалена из очереди бригад.`,
        { parse_mode: "HTML" },
      );
      await ctx.answerCbQuery("✅ Заказ отменен");

      ctx.telegram
        .sendMessage(
          OWNER_ID,
          `⚠️ <b>ОТМЕНА ЗАКАЗА КЛИЕНТОМ</b>\nКлиент отменил свой объект <b>#${orderId}</b>.`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
    } catch (e) {
      console.error("Ошибка отмены клиентом:", e);
      ctx.answerCbQuery("❌ Ошибка при отмене заказа.");
    }
  },

  async pingBoss(ctx, orderId) {
    try {
      const order = await OrderService.getOrderById(orderId);
      if (!order || order.user_id !== ctx.from.id)
        return ctx.answerCbQuery("⚠️ Ошибка доступа.");

      await ctx.telegram
        .sendMessage(
          OWNER_ID,
          `🔔 <b>ВНИМАНИЕ! ЗАПРОС ОТ КЛИЕНТА</b>\n➖➖➖➖➖➖➖➖➖➖\n` +
            `Клиент по объекту <b>#${orderId}</b> просит вас срочно связаться с ним!\n` +
            `Его Telegram: @${ctx.from.username || "Скрыт"}\n➖➖➖➖➖➖➖➖➖➖`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});

      await ctx.answerCbQuery(
        "✅ Руководитель уведомлен и скоро свяжется с вами!",
        { show_alert: true },
      );
    } catch (e) {
      console.error("Ошибка пинга шефа:", e);
      ctx.answerCbQuery("❌ Системная ошибка. Попробуйте позже.");
    }
  },

  async showPriceList(ctx) {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const pricelist = await OrderService.getPublicPricelist();
      let msg = `💰 <b>СИСТЕМНЫЙ ПРАЙС-ЛИСТ (v10.0.0)</b>\n\n`;

      if (Array.isArray(pricelist)) {
        pricelist.forEach((section) => {
          msg += `<b>${section.category}</b>\n`;
          section.items.forEach((item) => {
            msg += `🔹 ${item.name}: <b>${item.currentPrice} ${item.unit}</b>\n`;
          });
          msg += `\n`;
        });
      } else {
        msg +=
          `<b>🧱 Подготовка (Черновая стадия):</b>\n` +
          `🔹 Штроба (Бетон/Монолит): <b>${pricelist.strobeConcrete} ₸/м</b>\n` +
          `🔹 Бурение лунки под точку: <b>${pricelist.drillConcrete}</b>\n\n` +
          `<b>⚡️ Монтаж (Инженерия):</b>\n` +
          `🔹 Прокладка кабельной трассы: <b>${pricelist.cable} ₸/м</b>\n` +
          `🔹 Монтаж механизма розетки/выкл.: <b>${pricelist.socket} ₸/шт</b>\n`;
      }

      msg += `<i>* Прайс является базовым. Финальная смета формируется алгоритмом.</i>`;
      await ctx.replyWithHTML(msg);
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
    await this.showMainMenu(ctx, role, true);
  },
};

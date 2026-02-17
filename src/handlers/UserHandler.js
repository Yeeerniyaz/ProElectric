/**
 * @file src/handlers/UserHandler.js
 * @description Обработчик действий обычного пользователя.
 * Реализует бизнес-логику: Регистрация, Калькулятор сметы, Оформление заявки.
 *
 * @author ProElectric Team
 * @version 9.0 (Enterprise Edition)
 */

import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";
import {
  KEYBOARDS,
  BUTTONS,
  TEXTS,
  USER_STATES,
  MESSAGES,
} from "../constants.js";
import { config } from "../config.js";

// ID Владельца для уведомлений о новых лидах (ОБЯЗАТЕЛЬНО ПРОВЕРЬ!)
// В реальном проекте лучше вынести это в .env (process.env.OWNER_ID)
const OWNER_ID = 123456789;

export const UserHandler = {
  /**
   * ===========================================================================
   * 1. 🏁 ТОЧКА ВХОДА И РЕГИСТРАЦИЯ
   * ===========================================================================
   */

  /**
   * Обработка команды /start
   * Проверяет регистрацию пользователя. Если нет телефона - принуждает отправить.
   * @param {object} ctx - Контекст Telegraf
   */
  async startCommand(ctx) {
    try {
      const user = ctx.from;
      console.log(`[USER START] User: ${user.id} (${user.first_name})`);

      // 1. Получаем данные пользователя из базы
      let dbUser = await UserService.getUser(user.id);

      // 2. Если пользователя нет - регистрируем его (но пока без телефона)
      if (!dbUser) {
        dbUser = await UserService.registerUser(user);
        console.log(`[USER REG] New user registered: ${user.id}`);
      }

      // 3. БЛОКИРОВКА: Если у пользователя не заполнен телефон - не пускаем дальше
      if (!dbUser.phone_number) {
        // Устанавливаем состояние ожидания контакта
        ctx.session.state = USER_STATES.WAIT_PHONE;

        return ctx.reply(
          `👋 Добро пожаловать, ${user.first_name}!\n\n` +
            `🤖 Я — <b>Pro Electric Bot</b>, ваш помощник в расчете стоимости электромонтажа.\n\n` +
            `🔒 Для доступа к калькулятору и прайсу, пожалуйста, <b>подтвердите ваш номер телефона</b>.\n` +
            `Это нужно для связи с инженером в случае заявки.`,
          {
            parse_mode: "HTML",
            reply_markup: KEYBOARDS.PHONE_REQUEST, // Специальная кнопка
          },
        );
      }

      // 4. Если телефон есть - показываем Главное Меню
      await this.showMainMenu(ctx, dbUser.role);
    } catch (error) {
      console.error("[UserHandler] Error in startCommand:", error);
      ctx.reply("Произошла системная ошибка. Попробуйте позже.");
    }
  },

  /**
   * Обработка полученного контакта (телефонного номера)
   * Финализирует регистрацию.
   */
  async handleContact(ctx) {
    try {
      // Проверка состояния (действительно ли мы ждем телефон?)
      const session = ctx.session || {};
      if (session.state !== USER_STATES.WAIT_PHONE) {
        return; // Игнорируем случайные контакты
      }

      const contact = ctx.message.contact;
      const userId = ctx.from.id;

      // Валидация: Контакт должен принадлежать отправителю
      if (contact && contact.user_id === userId) {
        // 1. Сохраняем номер в базу
        await UserService.updatePhone(userId, contact.phone_number);
        console.log(
          `[USER PHONE] User ${userId} updated phone: ${contact.phone_number}`,
        );

        // 2. 🔥 ЛИД-МАГНИТ: Уведомляем владельца (Тебя) о новом клиенте
        try {
          await ctx.telegram.sendMessage(
            OWNER_ID,
            `🔔 <b>НОВЫЙ КЛИЕНТ!</b>\n\n` +
              `👤 Имя: <a href="tg://user?id=${userId}">${ctx.from.first_name}</a>\n` +
              `📱 Тел: <code>${contact.phone_number}</code>\n` +
              `📅 Дата: ${new Date().toLocaleString("ru-RU")}`,
            { parse_mode: "HTML" },
          );
        } catch (notifyError) {
          console.error(
            "[UserHandler] Failed to notify owner:",
            notifyError.message,
          );
        }

        // 3. Сбрасываем состояние и пускаем в меню
        ctx.session.state = USER_STATES.IDLE;

        await ctx.reply("✅ Отлично! Регистрация завершена.", {
          reply_markup: { remove_keyboard: true },
        });
        await this.showMainMenu(ctx, "user");
      } else {
        await ctx.reply(
          "⚠️ Пожалуйста, нажмите кнопку <b>'Отправить мой номер телефона'</b> внизу экрана.",
          { parse_mode: "HTML" },
        );
      }
    } catch (error) {
      console.error("[UserHandler] Error in handleContact:", error);
    }
  },

  /**
   * Отображение Главного Меню
   * Адаптируется под роль пользователя (Добавляет админку если нужно)
   */
  async showMainMenu(ctx, role = "user") {
    try {
      await ctx.replyWithHTML(TEXTS.welcome(ctx.from.first_name), {
        reply_markup: KEYBOARDS.MAIN_MENU(role),
      });
    } catch (error) {
      console.error("[UserHandler] Menu Error:", error);
    }
  },

  /**
   * ===========================================================================
   * 2. 🎮 ГЛАВНЫЙ РОУТЕР СООБЩЕНИЙ (State Machine)
   * ===========================================================================
   */

  async handleTextMessage(ctx) {
    try {
      const text = ctx.message.text;
      const session = ctx.session || {}; // Безопасное чтение сессии
      const state = session.state || USER_STATES.IDLE;

      console.log(`[MSG] User ${ctx.from.id} [${state}]: ${text}`);

      // --- 2.1 ГЛОБАЛЬНЫЕ КНОПКИ МЕНЮ (Работают всегда) ---

      if (text === BUTTONS.CALCULATE) return this.enterCalculationMode(ctx);
      if (text === BUTTONS.PRICE_LIST) return this.showPriceList(ctx);

      if (text === BUTTONS.CONTACTS) {
        // Отправляем контакты с Inline-кнопкой WhatsApp
        return ctx.replyWithHTML(TEXTS.contacts, {
          reply_markup: KEYBOARDS.CONTACT_ACTIONS,
        });
      }

      if (text === BUTTONS.HOW_WORK) {
        return ctx.replyWithHTML(TEXTS.howWeWork);
      }

      if (text === BUTTONS.ORDERS) return this.showMyOrders(ctx);

      // Кнопки навигации
      if (text === BUTTONS.BACK || text === BUTTONS.CANCEL)
        return this.returnToMainMenu(ctx);

      // --- 2.2 ЛОГИКА СОСТОЯНИЙ (Wizard Steps) ---

      // Если пользователь "застрял" на регистрации
      if (state === USER_STATES.WAIT_PHONE) {
        return ctx.reply(
          "👇 Пожалуйста, завершите регистрацию, нажав кнопку внизу.",
        );
      }

      // Калькулятор: Шаг 1 (Площадь) -> Шаг 2
      if (state === USER_STATES.CALC_WAIT_AREA) {
        return this.processAreaInput(ctx);
      }

      // Калькулятор: Шаг 3 (Комнаты) -> Финиш
      if (state === USER_STATES.CALC_WAIT_ROOMS) {
        return this.processRoomsInput(ctx);
      }

      // Если состояние IDLE и текст не распознан - можно просто игнорировать или показать меню
      // return this.showMainMenu(ctx);
    } catch (error) {
      console.error("[UserHandler] Text Error:", error);
    }
  },

  /**
   * ===========================================================================
   * 3. 🧮 КАЛЬКУЛЯТОР СМЕТЫ (Business Logic)
   * ===========================================================================
   */

  // --- Шаг 0: Старт ---
  async enterCalculationMode(ctx) {
    ctx.session.state = USER_STATES.CALC_WAIT_AREA;
    ctx.session.calcData = {}; // Инициализируем объект данных
    await ctx.reply(MESSAGES.USER.WIZARD_STEP_1_AREA, {
      reply_markup: KEYBOARDS.CANCEL_MENU,
    });
  },

  // --- Шаг 1: Обработка Площади ---
  async processAreaInput(ctx) {
    // Парсим число (заменяем запятую на точку для удобства)
    const rawText = ctx.message.text.replace(",", ".");
    const area = parseFloat(rawText);

    if (isNaN(area) || area <= 0 || area > 5000) {
      return ctx.reply(
        "⚠️ Пожалуйста, введите корректную площадь числом (например: <b>45</b> или <b>70.5</b>)",
        { parse_mode: "HTML" },
      );
    }

    ctx.session.calcData.area = area;

    // Переход к следующему шагу
    ctx.session.state = USER_STATES.CALC_WAIT_WALL;
    await ctx.reply(MESSAGES.USER.WIZARD_STEP_2_WALL, {
      reply_markup: KEYBOARDS.WALL_TYPES,
    });
  },

  // --- Шаг 2: Обработка стен (Inline Callback) ---
  // Этот метод вызывается из server.js/bot.js через bot.action
  async handleWallSelection(ctx) {
    try {
      const session = ctx.session || {};

      // Защита от старых нажатий (если сессия истекла)
      if (session.state !== USER_STATES.CALC_WAIT_WALL) {
        return ctx.answerCbQuery("⚠️ Сессия истекла. Начните расчет заново.");
      }

      session.calcData.wallType = ctx.match[0]; // Получаем wall_brick / wall_gas ...

      // Переход к следующему шагу
      session.state = USER_STATES.CALC_WAIT_ROOMS;

      await ctx.answerCbQuery(); // Убираем часики загрузки
      await ctx.reply(MESSAGES.USER.WIZARD_STEP_3_ROOMS, {
        reply_markup: KEYBOARDS.CANCEL_MENU,
      });
    } catch (error) {
      console.error("[UserHandler] Wall Select Error:", error);
    }
  },

  // --- Шаг 3: Обработка комнат и ФИНАЛЬНЫЙ РАСЧЕТ ---
  async processRoomsInput(ctx) {
    const rooms = parseInt(ctx.message.text);

    if (isNaN(rooms) || rooms <= 0 || rooms > 50) {
      return ctx.reply(
        "⚠️ Введите корректное количество комнат целым числом (например: 2).",
      );
    }

    const data = ctx.session.calcData;
    data.rooms = rooms;

    // 🔥 ВЫЗОВ БИЗНЕС-ЛОГИКИ (Service Layer)
    // Мы не считаем деньги здесь, мы делегируем это OrderService
    const estimate = await OrderService.calculateEstimate(data);

    // Сохраняем расчет в сессию (чтобы потом можно было сохранить в БД)
    ctx.session.lastEstimate = estimate;

    // Формирование красивого чека
    const wallName = this._getWallName(data.wallType); // Вспомогательный метод

    const invoiceText =
      `📋 <b>ПРЕДВАРИТЕЛЬНЫЙ РАСЧЕТ</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `🏠 <b>Объект:</b> ${data.area} м², ${data.rooms} комн.\n` +
      `🧱 <b>Стены:</b> ${wallName}\n\n` +
      `⚡️ <b>СТОИМОСТЬ РАБОТ (УСЛУГИ):</b>\n` +
      `• Электроточки (~${estimate.pointsCount} шт): <b>${estimate.pricePoints.toLocaleString()} ₸</b>\n` +
      `• Штробление стен: <b>${estimate.priceStrobe.toLocaleString()} ₸</b>\n` +
      `• Прокладка кабеля: <b>${estimate.priceCableWork.toLocaleString()} ₸</b>\n` +
      `• Сборка электрощита: <b>${estimate.pricePanel.toLocaleString()} ₸</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `💰 <b>ИТОГО ЗА РАБОТУ: ${estimate.totalWorkPrice.toLocaleString()} ₸</b>\n\n` +
      `📦 <b>РАСХОДНЫЕ МАТЕРИАЛЫ (Ориентировочно):</b>\n` +
      `• Кабель (ВВГ-нг-LS): ~${estimate.cableMeters} м.\n` +
      `• Гофра ПВХ: ~${estimate.corrugationMeters} м.\n` +
      `<i>* Материалы не входят в стоимость работ и оплачиваются по факту закупа.</i>\n` +
      TEXTS.estimateFooter;

    // Сброс состояния
    ctx.session.state = USER_STATES.IDLE;

    // Отправляем с кнопками действий (Оформить / Пересчитать)
    await ctx.replyWithHTML(invoiceText, {
      reply_markup: KEYBOARDS.ESTIMATE_ACTIONS,
    });
  },

  /**
   * ===========================================================================
   * 4. 💿 ДЕЙСТВИЯ (Сохранение, Просмотр)
   * ===========================================================================
   */

  /**
   * Сохранение заказа в Базу Данных (конверсия лида)
   */
  async saveOrder(ctx) {
    try {
      // Проверка наличия данных
      if (!ctx.session.lastEstimate) {
        return ctx.answerCbQuery("⚠️ Данные устарели. Рассчитайте заново.");
      }

      // Создаем запись в БД
      // Важно: мы сохраняем полную стоимость работ в total_price
      const orderData = {
        ...ctx.session.lastEstimate,
        total_price: ctx.session.lastEstimate.totalWorkPrice,
      };

      const orderId = await OrderService.createOrder(ctx.from.id, orderData);

      await ctx.answerCbQuery("✅ Заявка успешно создана!");

      // Ответ клиенту
      await ctx.editMessageText(
        `✅ <b>Заявка #${orderId} принята в работу!</b>\n\n` +
          `Спасибо за доверие. Я (Ернияз, Главный инженер) уже получил ваше уведомление.\n` +
          `Свяжусь с вами в ближайшее время для уточнения деталей выезда на замер.`,
        { parse_mode: "HTML" },
      );

      // 🔥 ВАЖНО: Уведомление Владельцу
      try {
        const userLink = ctx.from.username
          ? `@${ctx.from.username}`
          : `ID: ${ctx.from.id}`;
        await ctx.telegram.sendMessage(
          OWNER_ID,
          `🆕 <b>НОВЫЙ ЗАКАЗ #${orderId}</b>\n` +
            `➖➖➖➖➖➖➖➖\n` +
            `💰 Сумма (Работа): <b>${orderData.total_price.toLocaleString()} ₸</b>\n` +
            `👤 Клиент: <b>${ctx.from.first_name}</b> (${userLink})\n` +
            `🏠 Объект: ${orderData.area} м² / ${ctx.session.calcData.wallType}`,
          { parse_mode: "HTML" },
        );
      } catch (notifyErr) {
        console.error("Owner notification failed:", notifyErr);
      }

      // Очищаем временные данные
      ctx.session.lastEstimate = null;
      ctx.session.calcData = null;
    } catch (error) {
      console.error("Save Order Error:", error);
      ctx.reply("Ошибка сохранения заявки.");
    }
  },

  /**
   * Показ истории расчетов пользователя
   */
  async showMyOrders(ctx) {
    try {
      const orders = await OrderService.getUserOrders(ctx.from.id);

      if (!orders || orders.length === 0) {
        return ctx.reply("📂 У вас пока нет сохраненных расчетов.");
      }

      // Формируем список (последние 10)
      const list = orders
        .slice(0, 10)
        .map((o) => {
          const date = new Date(o.created_at).toLocaleDateString("ru-RU");
          const price = parseInt(o.total_price).toLocaleString();
          // Эмодзи статуса
          let icon = "🆕";
          if (o.status === "work") icon = "🛠";
          if (o.status === "done") icon = "✅";
          if (o.status === "cancel") icon = "❌";

          return `${icon} <b>Заказ #${o.id}</b> от ${date}\n💰 ${price} ₸`;
        })
        .join("\n\n");

      await ctx.replyWithHTML(`📂 <b>ВАШИ ЗАЯВКИ:</b>\n\n${list}`);
    } catch (error) {
      console.error("Show Orders Error:", error);
      ctx.reply("Не удалось загрузить список.");
    }
  },

  async showPriceList(ctx) {
    // Здесь можно в будущем загружать цены из БД
    await ctx.replyWithHTML(
      "💰 <b>БАЗОВЫЙ ПРАЙС-ЛИСТ</b>\n\n" +
        "• Точка (бетон): 2500 ₸\n" +
        "• Точка (кирпич): 1500 ₸\n" +
        "• Точка (газоблок): 1000 ₸\n" +
        "• Прокладка кабеля: 350 ₸/м\n" +
        "• Штроба (бетон): 2000 ₸/м\n\n" +
        "<i>Полный прайс уточняйте у инженера.</i>",
    );
  },

  // --- Утилиты ---

  async returnToMainMenu(ctx) {
    ctx.session.state = USER_STATES.IDLE;
    let role = "user";
    try {
      // Пытаемся получить актуальную роль (вдруг админ дал права)
      const u = await UserService.getUser(ctx.from.id);
      if (u) role = u.role;
    } catch (e) {}

    await this.showMainMenu(ctx, role);
  },

  async cancelCalculation(ctx) {
    await ctx.answerCbQuery("Действие отменено");
    await this.returnToMainMenu(ctx);
  },

  // Приватный хелпер для названий стен
  _getWallName(type) {
    const map = {
      wall_gas: "Газоблок / ГКЛ (Мягкие)",
      wall_brick: "Кирпич (Средние)",
      wall_concrete: "Бетон / Монолит (Твердые)",
    };
    return map[type] || "Неизвестно";
  },
};

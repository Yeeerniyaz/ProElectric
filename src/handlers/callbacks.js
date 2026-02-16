/**
 * @file src/handlers/callbacks.js
 * @description Обработчик Inline-кнопок (Callback Query Controller).
 * Реализует паттерн Action Dispatcher для маршрутизации событий:
 * калькулятор, прием заказов, финансовые операции.
 * @version 9.0.0 (Dispatcher Pattern & Constants Integration)
 */

import { bot } from "../core.js";
import { db } from "../db.js";
import { sessions, notifyAdmin } from "./messages.js";
import { OrderService } from "../services/OrderService.js";
import { TEXTS, BUTTONS, ROLES, STATUS_LABELS } from "../constants.js"; // Подключаем константы

// =============================================================================
// 🛠 UTILITIES
// =============================================================================

/**
 * Безопасный ответ на callback (гасит спиннер загрузки)
 */
const safeAnswer = async (queryId, text = null, showAlert = false) => {
  try {
    await bot.answerCallbackQuery(queryId, { text, show_alert: showAlert });
  } catch (e) {
    // Игнорируем ошибку "query is too old"
  }
};

const fmtMoney = (val) =>
  new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(val);

// =============================================================================
// 🎮 ACTION HANDLERS (CONTROLLERS)
// =============================================================================

const ActionHandlers = {
  /**
   * 🧱 Выбор стены в калькуляторе
   * Action: wall_{type}
   */
  async onWallSelect({ chatId, user, args, msgId, queryId }) {
    const [wallType] = args;
    const session = sessions.get(chatId);

    // 1. Валидация сессии
    if (!session || !session.data.area || !session.data.rooms) {
      return safeAnswer(
        queryId,
        "⚠️ Сессия истекла. Начните расчет заново.",
        true,
      );
    }

    await safeAnswer(queryId);

    try {
      // 2. Расчет сметы (получаем настройки из БД для актуальных цен)
      const settings = await db.getSettings();

      // Логика расчета перенесена в Helper внутри, чтобы не дублировать код
      // Но для точности лучше использовать OrderService, если там есть метод
      // Пока реализуем расчет здесь или вынесем в utils
      const wallFactor =
        {
          wall_light: 1.0,
          wall_brick: 1.3,
          wall_concrete: 1.6,
        }[wallType] || 1.2;

      const area = session.data.area;
      const rooms = session.data.rooms;

      const estimatedPoints = Math.ceil(area * 0.8) + rooms * 2;
      const estimatedStrobe = Math.ceil(area * 1.2);

      const pricePoint = settings.price_socket_install || 2000;
      const priceStrobe = settings.price_strobe_brick || 1000;

      const pointsCost = estimatedPoints * pricePoint;
      const strobeCost = estimatedStrobe * priceStrobe * wallFactor;
      const panelCost = 15000; // Щиток

      const total =
        Math.ceil((pointsCost + strobeCost + panelCost) / 1000) * 1000;

      const details = {
        points: estimatedPoints,
        strobe: estimatedStrobe,
        wallFactor,
      };

      // 3. Создание заказа
      const order = await OrderService.createOrder(user.telegram_id, {
        area,
        rooms,
        wallType,
        totalPrice: total,
        details,
      });

      // 4. Формирование чека
      const wallNames = {
        wall_light: "ГКЛ/Блок",
        wall_brick: "Кирпич",
        wall_concrete: "Бетон",
      };
      const receipt =
        `✅ <b>ПРЕДВАРИТЕЛЬНЫЙ РАСЧЕТ</b>\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `📐 Площадь: ${area} м² (${rooms} комн.)\n` +
        `🧱 Стены: ${wallNames[wallType]}\n` +
        `🔌 Точек (прим.): ~${details.points} шт\n` +
        `🏗 Штроб (прим.): ~${details.strobe} м\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `💰 <b>ИТОГО: ~${fmtMoney(total)}</b>\n\n` +
        `<i>* Заявка <b>#${order.id}</b> создана. Менеджер свяжется с вами!</i>`;

      await bot.editMessageText(receipt, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "HTML",
      });

      // 5. Уведомление админов
      const adminMsg =
        `⚡️ <b>НОВЫЙ ЛИД (БОТ)</b>\n` +
        `🆔 #${order.id}\n` +
        `👤 ${user.first_name} (@${user.username || "нет_юзера"})\n` +
        `💰 ~${fmtMoney(total)}`;

      await notifyAdmin(adminMsg, order.id);

      sessions.delete(chatId); // Очистка
    } catch (e) {
      console.error("Calc Error:", e);
      await safeAnswer(queryId, "Ошибка расчета", true);
    }
  },

  /**
   * 🙋‍♂️ Менеджер берет заказ
   * Action: take_order_{id}
   */
  async onOrderTake({ chatId, userId, user, args, msgId, queryId, msgText }) {
    const [orderId] = args;

    // Проверка прав
    if (![ROLES.ADMIN, ROLES.MANAGER].includes(user.role)) {
      return safeAnswer(queryId, "⛔️ У вас нет прав!", true);
    }

    try {
      // Атомарный захват заказа (чтобы не взяли двое)
      const result = await db.query(
        `UPDATE orders SET assignee_id = $1, status = 'work', updated_at = NOW() 
                 WHERE id = $2 AND assignee_id IS NULL RETURNING id`,
        [userId, orderId],
      );

      if (result.rowCount === 0) {
        return safeAnswer(
          queryId,
          "⚠️ Заказ уже занят другим менеджером!",
          true,
        );
      }

      // Обновляем сообщение (убираем кнопку)
      const updatedText =
        msgText + `\n\n✅ <b>Взят в работу:</b> ${user.first_name}`;
      await bot.editMessageText(updatedText, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      });

      await safeAnswer(queryId, "🚀 Заказ ваш! Удачной работы.");

      // Уведомляем менеджера в ЛС
      await bot.sendMessage(
        userId,
        `👷‍♂️ <b>Вы назначены на объект #${orderId}</b>\nСвяжитесь с клиентом.`,
        { parse_mode: "HTML" },
      );

      // Уведомляем клиента (если есть ID)
      const order = await db.getOrderById(orderId);
      if (order && order.user_id) {
        bot
          .sendMessage(
            order.user_id,
            `✅ <b>ВАШ ЗАКАЗ #${orderId} ПРИНЯТ!</b>\n` +
              `Мастер: ${user.first_name}\nСкоро с вами свяжутся.`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});
      }
    } catch (e) {
      console.error("TakeOrder Error:", e);
      await safeAnswer(queryId, "Ошибка БД", true);
    }
  },

  /**
   * 💸 Добавить расход (Старт)
   * Action: add_expense_{id}
   */
  async onExpenseAdd({ chatId, args, queryId }) {
    const [orderId] = args;

    // Стартуем сессию визарда (логика в messages.js)
    sessions.set(chatId, {
      step: "EXPENSE_AMOUNT",
      data: { orderId },
      startTime: Date.now(),
    });

    await safeAnswer(queryId);
    await bot.sendMessage(
      chatId,
      `💸 <b>РАСХОД ПО ЗАКАЗУ #${orderId}</b>\nВведите сумму (только цифры):`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: BUTTONS.CANCEL, callback_data: "cancel_op" }],
          ],
        },
      },
    );
  },

  /**
   * 🏁 Начать закрытие заказа
   * Action: close_order_start_{id}
   */
  async onCloseStart({ chatId, args, queryId }) {
    const [orderId] = args;

    sessions.set(chatId, {
      step: "FINISH_SUM",
      data: { orderId },
      startTime: Date.now(),
    });

    await safeAnswer(queryId);
    await bot.sendMessage(
      chatId,
      `🏁 <b>ЗАКРЫТИЕ ЗАКАЗА #${orderId}</b>\nВведите итоговую сумму от клиента:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: BUTTONS.CANCEL, callback_data: "cancel_op" }],
          ],
        },
      },
    );
  },

  /**
   * 💳 Финализация (Выбор кошелька)
   * Action: wallet_{id}
   */
  async onWalletSelect({ chatId, userId, args, msgId, queryId }) {
    const [walletId] = args;
    const session = sessions.get(chatId);

    if (!session || !session.data.finalSum || !session.data.orderId) {
      return safeAnswer(queryId, "⚠️ Ошибка сессии. Повторите.", true);
    }

    try {
      await safeAnswer(queryId);

      const { finalSum, orderId } = session.data;

      // Выполняем проводку
      await OrderService.closeOrder(orderId, finalSum, walletId);

      // Обновляем сообщение
      await bot.editMessageText(
        `💰 Принято: <b>${fmtMoney(finalSum)}</b>\n✅ Заказ #${orderId} успешно закрыт!`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "HTML",
        },
      );

      // Уведомление в канал (через config)
      if (process.env.CHANNEL_ID) {
        const report =
          `🏁 <b>ЗАКАЗ ЗАКРЫТ (#${orderId})</b>\n` +
          `➖➖➖➖➖➖➖➖\n` +
          `💰 Выручка: <b>${fmtMoney(finalSum)}</b>\n` +
          `💼 Касса ID: ${walletId}\n` +
          `👤 Закрыл: ${session.data.user_name || "Менеджер"}`;

        // Пытаемся отправить
        bot
          .sendMessage(process.env.CHANNEL_ID, report, { parse_mode: "HTML" })
          .catch(() => {});
      }

      sessions.delete(chatId);
    } catch (e) {
      console.error("CloseOrder Error:", e);
      await safeAnswer(queryId, "Ошибка закрытия", true);
    }
  },

  /**
   * ❌ Отмена операции
   */
  async onCancel({ chatId, msgId, queryId }) {
    sessions.delete(chatId);
    await safeAnswer(queryId, "Отменено");
    await bot.editMessageText("❌ Операция отменена.", {
      chat_id: chatId,
      message_id: msgId,
    });
  },
};

// =============================================================================
// 🚀 DISPATCHER ROUTER
// =============================================================================

export const setupCallbackHandlers = () => {
  bot.on("callback_query", async (query) => {
    const { id: queryId, data, message, from } = query;
    const chatId = message.chat.id;

    // Определяем Handler и аргументы
    let handlerName = null;
    let args = [];

    if (data.startsWith("wall_")) {
      handlerName = "onWallSelect";
      args = [data]; // Передаем весь ключ, например "wall_brick" (парсинг внутри)
      // Fix: в ActionHandlers ожидается args[0] как тип стены.
      // ActionHandlers.onWallSelect ждет args[0].
      // Передадим так:
      args = [data.replace("wall_", "wall_")]; // хак, чтобы передать 'wall_brick'
    } else if (data.startsWith("take_order_")) {
      handlerName = "onOrderTake";
      args = [data.replace("take_order_", "")];
    } else if (data.startsWith("add_expense_")) {
      handlerName = "onExpenseAdd";
      args = [data.replace("add_expense_", "")];
    } else if (data.startsWith("close_order_start_")) {
      handlerName = "onCloseStart";
      args = [data.replace("close_order_start_", "")];
    } else if (data.startsWith("wallet_")) {
      handlerName = "onWalletSelect";
      args = [data.replace("wallet_", "")];
    } else if (data === "cancel_op") {
      handlerName = "onCancel";
    }

    // Если нашли хендлер — выполняем
    if (handlerName && ActionHandlers[handlerName]) {
      try {
        // Подгружаем юзера (для прав и имени)
        const user = await db.upsertUser(
          from.id,
          from.first_name,
          from.username,
        );

        // Инжектим зависимости
        await ActionHandlers[handlerName]({
          chatId,
          userId: from.id,
          user,
          args,
          msgId: message.message_id,
          queryId,
          msgText: message.text,
        });
      } catch (e) {
        console.error(`Handler Fatal [${handlerName}]:`, e);
        await safeAnswer(queryId, "🔥 Внутренняя ошибка", true);
      }
    } else {
      // Неизвестный коллбек
      await safeAnswer(queryId);
    }
  });

  console.log("✅ [CALLBACKS] Dispatcher initialized.");
};

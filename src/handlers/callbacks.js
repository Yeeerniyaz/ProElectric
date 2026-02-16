/**
 * @file src/handlers/callbacks.js
 * @description Обработчик Inline-кнопок (Callback Query Controller).
 * Реализует паттерн Action Dispatcher для маршрутизации событий:
 * калькулятор, прием заказов, финансовые операции.
 * @version 8.3.0 (Dispatcher Pattern)
 */

import { bot } from "../core.js";
import { db } from "../db.js";
import { sessions, notifyAdmin } from "./messages.js";
import { OrderService } from "../services/OrderService.js";

// =============================================================================
// 🛠 UTILITIES
// =============================================================================

/**
 * Безопасный ответ на callback (чтобы кнопка не крутилась вечно)
 */
const safeAnswer = async (queryId, text = null, showAlert = false) => {
  try {
    await bot.answerCallbackQuery(queryId, { text, show_alert: showAlert });
  } catch (e) {
    // Игнорируем ошибку, если queryId устарел
  }
};

const formatKZT = (num) =>
  new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(num);

// =============================================================================
// 🎮 ACTION HANDLERS
// =============================================================================

const ActionHandlers = {
  /**
   * 🧱 Выбор стены в калькуляторе
   * Action: wall_{type}
   */
  async onWallSelect({ chatId, userId, user, args, msgId, queryId }) {
    const [wallType] = args;
    const session = sessions.get(chatId);

    // 1. Валидация сессии
    if (!session || !session.data.area || !session.data.rooms) {
      return safeAnswer(
        queryId,
        "⚠️ Сессия истекла. Начните расчет заново (/start)",
        true,
      );
    }

    await safeAnswer(queryId);

    // 2. Расчет сметы через Service Layer
    const estimate = await OrderService.calculateEstimate(
      session.data.area,
      session.data.rooms,
      wallType,
    );

    // 3. Создание заказа (статус 'new', но без подтверждения менеджера)
    // Передаем контекст пользователя
    const order = await OrderService.createOrder(user, estimate, {
      city: user.city || "Алматы",
      serviceType: "electric_calculator",
    });

    // 4. Формирование ответа (Используем единый форматтер из сервиса)
    const messageText = OrderService.formatEstimateMessage(estimate);

    // 5. Отправка результата
    await bot.sendMessage(chatId, messageText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📝 Оформить заявку на замер",
              callback_data: `confirm_order_${order.id}`,
            },
          ],
        ],
      },
    });

    // Очищаем сессию, так как расчет окончен
    sessions.delete(chatId);
  },

  /**
   * ✅ Подтверждение заказа клиентом
   * Action: confirm_order_{orderId}
   */
  async onOrderConfirm({ chatId, userId, user, args, msgId, queryId }) {
    const [orderId] = args;

    await safeAnswer(queryId, "✅ Заявка отправлена!");

    // Убираем кнопку, чтобы не нажали дважды
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      {
        chat_id: chatId,
        message_id: msgId,
      },
    );

    await bot.sendMessage(
      chatId,
      `✅ <b>Ваша заявка #${orderId} принята!</b>\n\n` +
        `👨‍🔧 Менеджер свяжется с вами в ближайшее время для согласования времени замера.`,
      { parse_mode: "HTML" },
    );

    // Уведомляем админов
    const adminText =
      `🔥 <b>НОВЫЙ ЛИД #${orderId}</b>\n` +
      `👤 Клиент: <a href="tg://user?id=${userId}">${user.first_name}</a>\n` +
      `📞 Тел: ${user.phone || "Не указан"}\n` +
      `<i>Ожидает распределения...</i>`;

    await notifyAdmin(adminText, orderId);
  },

  /**
   * 🙋‍♂️ Менеджер берет заказ в работу
   * Action: take_order_{orderId}
   */
  async onOrderTake({ chatId, userId, user, args, msgId, queryId, msgText }) {
    const [orderId] = args;

    try {
      // Атомарное обновление в БД через SQL
      const result = await db.query(
        `UPDATE orders 
                 SET assignee_id = $1, status = 'work', updated_at = NOW() 
                 WHERE id = $2 AND assignee_id IS NULL 
                 RETURNING id`,
        [userId, orderId],
      );

      if (result.rowCount === 0) {
        return safeAnswer(
          queryId,
          "⚠️ Этот заказ уже занят другим менеджером!",
          true,
        );
      }

      // Обновляем сообщение в админском чате
      const updatedText =
        msgText + `\n\n✅ <b>Взял в работу:</b> ${user.first_name}`;
      await bot.editMessageText(updatedText, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] }, // Убираем кнопку
      });

      await bot.sendMessage(
        userId,
        `👷‍♂️ <b>Вы назначены на объект #${orderId}</b>\n` +
          `Свяжитесь с клиентом и договоритесь о замере.`,
        { parse_mode: "HTML" },
      );

      await safeAnswer(queryId, "🚀 Заказ закреплен за вами!");
    } catch (e) {
      console.error("Take Order Error:", e);
      await safeAnswer(queryId, "❌ Ошибка базы данных", true);
    }
  },

  /**
   * 💸 Добавление расхода (Начало сцены)
   * Action: add_expense_{orderId}
   */
  async onExpenseAdd({ chatId, args, queryId }) {
    const [orderId] = args;

    // Инициализируем сессию
    sessions.set(chatId, {
      step: "EXPENSE_AMOUNT",
      data: { orderId },
      startTime: Date.now(),
    });

    await safeAnswer(queryId);
    await bot.sendMessage(
      chatId,
      `💸 <b>РАСХОД ПО ОБЪЕКТУ #${orderId}</b>\n\n` +
        `Введите сумму расхода (только цифры):`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Отмена", callback_data: "cancel_op" }],
          ],
        },
      },
    );
  },

  /**
   * 🏁 Начало закрытия заказа
   * Action: close_order_start_{orderId}
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
      `💰 <b>ЗАКРЫТИЕ ЗАКАЗА #${orderId}</b>\n\n` +
        `Введите фактическую сумму, которую <b>заплатил клиент</b>:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Отмена", callback_data: "cancel_op" }],
          ],
        },
      },
    );
  },

  /**
   * 💳 Выбор кошелька и финализация
   * Action: wallet_{walletId}
   */
  async onWalletSelect({ chatId, userId, args, msgId, queryId }) {
    const [walletId] = args;
    const session = sessions.get(chatId);

    if (!session || !session.data.finalSum || !session.data.orderId) {
      return safeAnswer(
        queryId,
        "⚠️ Ошибка сессии. Повторите процедуру.",
        true,
      );
    }

    try {
      await safeAnswer(queryId);

      // Вызываем сложную бизнес-логику в Service Layer
      const res = await OrderService.completeOrder(
        session.data.orderId,
        session.data.finalSum,
        walletId,
        userId,
      );

      const report =
        `✅ <b>ОБЪЕКТ #${session.data.orderId} УСПЕШНО ЗАКРЫТ!</b>\n` +
        `➖➖➖➖➖➖➖➖➖\n` +
        `💰 <b>Выручка:</b> ${formatKZT(session.data.finalSum)}\n` +
        `📉 <b>Расходы:</b> -${formatKZT(res.expenses)}\n` +
        `💵 <b>Чистая прибыль:</b> ${formatKZT(res.profit)}\n\n` +
        `👷‍♂️ <b>Мастеру:</b> ${formatKZT(res.masterShare)}\n` +
        `🏢 <b>В бизнес:</b> ${formatKZT(res.businessShare)}`;

      await bot.editMessageText(report, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "HTML",
      });

      sessions.delete(chatId);
    } catch (e) {
      console.error("Close Order Error:", e);
      await safeAnswer(queryId, "❌ Ошибка при закрытии заказа.", true);
    }
  },

  /**
   * ❌ Отмена операции
   * Action: cancel_op
   */
  async onCancel({ chatId, msgId, queryId }) {
    sessions.delete(chatId);
    await safeAnswer(queryId, "Операция отменена");
    await bot.editMessageText("❌ Действие отменено.", {
      chat_id: chatId,
      message_id: msgId,
    });
  },
};

// =============================================================================
// 🚀 DISPATCHER LOGIC
// =============================================================================

export const setupCallbackHandlers = () => {
  bot.on("callback_query", async (query) => {
    const { id: queryId, data, message, from } = query;
    const chatId = message.chat.id;
    const userId = from.id;

    // Определяем тип действия и аргументы
    // Пример data: "confirm_order_123" -> action="confirm_order", args=["123"]
    // Пример data: "wall_concrete" -> action="wall", args=["concrete"]

    let handlerKey = null;
    let args = [];

    if (data.startsWith("wall_")) {
      handlerKey = "onWallSelect";
      args = [data.replace("wall_", "")];
    } else if (data.startsWith("confirm_order_")) {
      handlerKey = "onOrderConfirm";
      args = [data.replace("confirm_order_", "")];
    } else if (data.startsWith("take_order_")) {
      handlerKey = "onOrderTake";
      args = [data.replace("take_order_", "")];
    } else if (data.startsWith("add_expense_")) {
      handlerKey = "onExpenseAdd";
      args = [data.replace("add_expense_", "")];
    } else if (data.startsWith("close_order_start_")) {
      handlerKey = "onCloseStart";
      args = [data.replace("close_order_start_", "")];
    } else if (data.startsWith("wallet_")) {
      handlerKey = "onWalletSelect";
      args = [data.replace("wallet_", "")];
    } else if (data === "cancel_op") {
      handlerKey = "onCancel";
    }

    if (handlerKey && ActionHandlers[handlerKey]) {
      try {
        // Подгружаем пользователя один раз для всех хендлеров
        // Чтобы знать роль, имя и т.д.
        const user = await db.upsertUser(
          userId,
          from.first_name,
          from.username,
        );

        // Вызываем хендлер
        await ActionHandlers[handlerKey]({
          chatId,
          userId,
          user,
          args,
          msgId: message.message_id,
          queryId,
          msgText: message.text,
        });
      } catch (e) {
        console.error(`Handler Error [${handlerKey}]:`, e);
        await safeAnswer(queryId, "🔥 Произошла ошибка сервера", true);
      }
    } else {
      console.warn(`Unknown callback data: ${data}`);
      await safeAnswer(queryId); // Просто гасим спиннер
    }
  });
};

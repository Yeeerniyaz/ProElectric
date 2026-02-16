/**
 * @file src/handlers/callbacks.js
 * @description Inline Button Callback Handler.
 * Implements logic for calculator, order management, and expense tracking.
 * Refactored for modularity and robustness.
 * @version 8.0.0 (Senior Refactor)
 */

import { bot } from "../core.js";
import { OrderService } from "../services/OrderService.js";
import { sessions, notifyAdmin } from "./messages.js";
import { db } from "../db.js";

// Utility for currency formatting
const formatKZT = (num) =>
  new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(num);

// --- Handler Functions ---

/**
 * Handles the calculator wall selection step.
 */
const handleCalculatorWallSelection = async (chatId, userId, wallType, messageId, callbackQueryId) => {
  const session = sessions.get(chatId);

  if (!session || !session.data.area || !session.data.rooms) {
    return bot.answerCallbackQuery(callbackQueryId, {
      text: "⚠️ Session expired. Please start the calculation again.",
      show_alert: true,
    });
  }

  await bot.answerCallbackQuery(callbackQueryId);

  const estimate = await OrderService.calculateEstimate(
    session.data.area,
    session.data.rooms,
    wallType
  );

  const order = await OrderService.createOrder(userId, estimate);

  const wallNames = {
    light: "Газоблок (Легкий)",
    brick: "Кирпич (Средний)",
    concrete: "Бетон (Сложный)",
  };

  const resultText =
    `⚡️ <b>ПРЕДВАРИТЕЛЬНЫЙ РАСЧЕТ</b>\n` +
    `➖➖➖➖➖➖➖➖➖\n` +
    `🏠 <b>Объект:</b> ${estimate.params.area} м², ${estimate.params.rooms} комн.\n` +
    `🧱 <b>Стены:</b> ${wallNames[wallType] || wallType}\n` +
    `🔌 <b>Точки (свет/розетки):</b> ~${estimate.volume.points} шт.\n\n` +
    `🛠 <b>Работы:</b> ~${formatKZT(estimate.costs.work)}\n` +
    `📦 <b>Материал (черновой):</b> ~${formatKZT(estimate.costs.material)}\n` +
    `➖➖➖➖➖➖➖➖➖\n` +
    `🏁 <b>ИТОГО ПОД КЛЮЧ: ~${formatKZT(estimate.costs.total)}</b>\n\n` +
    `<i>ℹ️ Это ориентировочная цена. Финальная стоимость определяется мастером после замера.</i>`;

  await bot.sendMessage(chatId, resultText, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📝 Вызвать мастера на замер", callback_data: `confirm_order_${order.id}` }],
      ],
    },
  });

  sessions.delete(chatId);
};

/**
 * Handles order confirmation by the client.
 */
const handleOrderConfirmation = async (chatId, userId, fromName, orderId, messageId, callbackQueryId) => {
  await bot.answerCallbackQuery(callbackQueryId, { text: "✅ Заявка отправлена!" });

  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId,
    message_id: messageId,
  });

  await bot.sendMessage(chatId,
    "✅ <b>Спасибо! Ваша заявка принята.</b>\n\n" +
    "👨‍🔧 Наш мастер свяжется с вами в ближайшее время для уточнения деталей.",
    { parse_mode: "HTML" }
  );

  const orderInfo =
    `🔥 <b>НОВАЯ ЗАЯВКА #${orderId}</b>\n` +
    `👤 Клиент: <a href="tg://user?id=${userId}">${fromName}</a>\n` +
    `📞 Контакт: Требуется запросить`;

  await notifyAdmin(orderInfo, orderId);

  // Auto-assignment fallback
  setTimeout(async () => {
    const masterId = await OrderService.autoAssignMaster(orderId);
    if (masterId) {
      await bot.sendMessage(masterId, `⚠️ <b>АВТО-НАЗНАЧЕНИЕ!</b>\nЗаказ #${orderId} передан вам, так как никто не взял его вовремя.`);
    }
  }, 30 * 60 * 1000);
};

/**
 * Handles a manager taking an order.
 */
const handleTakeOrder = async (chatId, userId, fromName, orderId, messageText, messageId, callbackQueryId) => {
  try {
    await OrderService.assignMaster(orderId, userId);

    const takenMsg = messageText + `\n\n✅ <b>Взял в работу:</b> ${fromName}`;
    await bot.editMessageText(takenMsg, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
    });

    await bot.sendMessage(userId,
      `👷‍♂️ <b>Вы назначены на объект #${orderId}</b>\n` +
      `Свяжитесь с клиентом и договоритесь о замере.`,
      { parse_mode: "HTML" }
    );

    await bot.answerCallbackQuery(callbackQueryId, { text: "🚀 Заказ ваш!" });
  } catch (e) {
    console.error("Take Order Error:", e);
    await bot.answerCallbackQuery(callbackQueryId, {
      text: "❌ Ошибка. Возможно, заказ уже взят.",
      show_alert: true,
    });
  }
};

/**
 * Initiates the expense addition flow.
 */
const handleAddExpenseStart = async (chatId, orderId, callbackQueryId) => {
  sessions.set(chatId, {
    step: "EXPENSE_AMOUNT",
    data: { orderId: orderId },
  });

  await bot.answerCallbackQuery(callbackQueryId);
  await bot.sendMessage(chatId,
    `💸 <b>РАСХОД ПО ЗАКАЗУ #${orderId}</b>\n\n` +
    `Введите сумму расхода (тенге):`,
    {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel_op" }]] },
      parse_mode: "HTML",
    }
  );
};

/**
 * Initiates the order closing flow.
 */
const handleCloseOrderStart = async (chatId, orderId, callbackQueryId) => {
  sessions.set(chatId, {
    step: "FINISH_SUM",
    data: { orderId: orderId },
  });

  await bot.answerCallbackQuery(callbackQueryId);
  await bot.sendMessage(chatId,
    `💰 <b>ЗАКРЫТИЕ ЗАКАЗА #${orderId}</b>\n\n` +
    `Введите итоговую сумму, которую <b>фактически</b> заплатил клиент (цифрами):`,
    {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel_op" }]] },
      parse_mode: "HTML",
    }
  );
};

/**
 * Handles wallet selection and finalizes order.
 */
const handleWalletSelection = async (chatId, userId, walletId, messageId, callbackQueryId) => {
  const session = sessions.get(chatId);

  if (!session || !session.data.finalSum || !session.data.orderId) {
    return bot.answerCallbackQuery(callbackQueryId, { text: "Session Error", show_alert: true });
  }

  const res = await OrderService.completeOrder(
    session.data.orderId,
    session.data.finalSum,
    walletId,
    userId
  );

  await bot.answerCallbackQuery(callbackQueryId);

  const report =
    `✅ <b>ОБЪЕКТ #${session.data.orderId} ЗАКРЫТ!</b>\n` +
    `➖➖➖➖➖➖➖➖➖\n` +
    `💰 <b>Касса:</b> +${formatKZT(session.data.finalSum)}\n` +
    `📉 <b>Расходы объекта:</b> -${formatKZT(res.expenses)}\n` +
    `💵 <b>Чистая прибыль:</b> ${formatKZT(res.profit)}\n` +
    `👷‍♂️ <b>Твоя доля (80%):</b> ${formatKZT(res.masterSalary)}\n` +
    `🏢 <b>В фирму (20%):</b> ${formatKZT(res.profit - res.masterSalary)}`;

  await bot.editMessageText(report, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "HTML",
  });

  sessions.delete(chatId);
};

/**
 * Handles cancellation of operations.
 */
const handleCancelOperation = async (chatId, messageId) => {
  sessions.delete(chatId);
  await bot.editMessageText("❌ Операция отменена.", {
    chat_id: chatId,
    message_id: messageId,
  });
};

// --- Main Setup Function ---

export const setupCallbackHandlers = () => {
  bot.on("callback_query", async (query) => {
    const { id: callbackQueryId, data, message, from } = query;
    const chatId = message.chat.id;
    const userId = from.id;

    try {
      // 1. Calculator: Wall Selection
      if (data.startsWith("wall_")) {
        const wallType = data.split("_")[1];
        await handleCalculatorWallSelection(chatId, userId, wallType, message.message_id, callbackQueryId);
        return;
      }

      // 2. Client: Confirm Order
      if (data.startsWith("confirm_order_")) {
        const orderId = data.split("_")[2];
        await handleOrderConfirmation(chatId, userId, from.first_name, orderId, message.message_id, callbackQueryId);
        return;
      }

      // 3. Manager: Take Order
      if (data.startsWith("take_order_")) {
        const orderId = data.split("_")[2];
        await handleTakeOrder(chatId, userId, from.first_name, orderId, message.text, message.message_id, callbackQueryId);
        return;
      }

      // 4. Manager: Add Expense
      if (data.startsWith("add_expense_")) {
        const orderId = data.split("_")[2];
        await handleAddExpenseStart(chatId, orderId, callbackQueryId);
        return;
      }

      // 5. Manager: Start Close Order
      if (data.startsWith("close_order_start_")) {
        const orderId = data.split("_")[2];
        await handleCloseOrderStart(chatId, orderId, callbackQueryId);
        return;
      }

      // 6. Manager: Select Wallet (Finalize)
      if (data.startsWith("wallet_")) {
        const walletId = data.split("_")[1];
        await handleWalletSelection(chatId, userId, walletId, message.message_id, callbackQueryId);
        return;
      }

      // 7. Cancel Operation
      if (data === "cancel_op") {
        await handleCancelOperation(chatId, message.message_id);
        return;
      }

    } catch (error) {
      console.error("💥 [CALLBACK ERROR]", error);
      await bot.answerCallbackQuery(callbackQueryId, {
        text: "❌ Произошла системная ошибка.",
      });
    }
  });
};
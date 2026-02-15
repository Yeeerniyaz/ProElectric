/**
 * @file src/handlers/callbacks.js
 * @description Контроллер обработки нажатий.
 * Использует OrderService для логики.
 * @version 6.0.0 (Clean Architecture)
 */

import { bot } from "../core.js";
import { OrderService } from "../services/OrderService.js";
import { STATUS_CONFIG } from "../constants.js";
import { sessions, notifyAdmin, handleAdminCommand } from "./messages.js";

// Хелпер для форматирования денег (UI only)
const formatKZT = (num) =>
  new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(num);

export const setupCallbackHandlers = () => {
  bot.on("callback_query", async (query) => {
    const { id: callbackQueryId, data, message, from } = query;
    const chatId = message.chat.id;
    const userId = from.id;

    try {
      // ====================================================
      // 1. АДМИНКА
      // ====================================================
      if (data.startsWith("adm_")) {
        const cmd = data.split("_")[1];
        await bot.answerCallbackQuery(callbackQueryId);
        return await handleAdminCommand(message, [null, cmd]);
      }

      // ====================================================
      // 2. УПРАВЛЕНИЕ СТАТУСАМИ (STATUS WORKFLOW)
      // ====================================================
      if (data.startsWith("status_")) {
        const [_, newStatus, orderId] = data.split("_");
        const cfg = STATUS_CONFIG[newStatus];

        if (!cfg || !orderId)
          return bot.answerCallbackQuery(callbackQueryId, {
            text: "❌ Ошибка данных",
          });

        // Вызываем Сервис (Логика там)
        const financeData = await OrderService.updateStatus(
          orderId,
          newStatus,
          userId,
        );

        // Обновляем UI
        const time = new Date().toLocaleTimeString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
        });
        const cleanBody = (message.text || "")
          .replace(/^.*(СТАТУС|Мастер|Обновлено):.*\n/gm, "")
          .trim();

        const updatedContent =
          `${cfg.icon} <b>СТАТУС: ${cfg.label}</b>\n` +
          `👷‍♂️ <b>Мастер:</b> ${from.first_name}\n` +
          `⏰ <b>Обновлено:</b> ${time}\n\n` +
          `${cleanBody}`;

        await bot.editMessageText(updatedContent, {
          chat_id: chatId,
          message_id: message.message_id,
          parse_mode: "HTML",
          reply_markup: message.reply_markup,
        });

        // Если вернулись финансовые данные — значит заказ закрыт
        if (financeData) {
          const msg =
            `💰 <b>ЗАКАЗ #${orderId} ЗАКРЫТ!</b>\n` +
            `💸 <b>Сумма:</b> ${formatKZT(financeData.total)}\n` +
            `🏢 <b>Бизнес (${financeData.percents.business}%):</b> ${formatKZT(financeData.businessShare)}\n` +
            `👷‍♂️ <b>Оклад (${financeData.percents.staff}%):</b> ${formatKZT(financeData.staffShare)}\n\n` +
            `<i>Переведите средства между счетами в Dashboard.</i>`;
          await bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
        }

        return bot.answerCallbackQuery(callbackQueryId, {
          text: `✅ Статус: ${cfg.label}`,
        });
      }

      // ====================================================
      // 3. ВЗЯТЬ В РАБОТУ (CLAIM)
      // ====================================================
      if (data.startsWith("take_order_")) {
        const orderId = data.split("_")[2];

        try {
          const master = await OrderService.takeOrder(orderId, userId);

          const finalMsg =
            message.text + `\n\n✅ <b>В работе у:</b> ${master.first_name}`;
          await bot.editMessageText(finalMsg, {
            chat_id: chatId,
            message_id: message.message_id,
            parse_mode: "HTML",
          });

          return bot.answerCallbackQuery(callbackQueryId, {
            text: "🚀 Успешно!",
          });
        } catch (e) {
          if (e.message === "ACCESS_DENIED") {
            return bot.answerCallbackQuery(callbackQueryId, {
              text: "⛔️ Нет прав",
              show_alert: true,
            });
          }
          throw e;
        }
      }

      // ====================================================
      // 4. КАЛЬКУЛЯТОР (ESTIMATOR)
      // ====================================================
      if (data.startsWith("wall_")) {
        const wallType = data.split("_")[1];
        const session = sessions.get(chatId);

        if (!session?.data?.area) {
          return bot.answerCallbackQuery(callbackQueryId, {
            text: "⚠️ Сессия истекла",
            show_alert: true,
          });
        }

        await bot.answerCallbackQuery(callbackQueryId);
        await bot.sendChatAction(chatId, "typing");

        // 1. Считаем (через Сервис)
        const estimate = await OrderService.calculateEstimate(
          session.data.area,
          wallType,
        );

        // 2. Сохраняем Лид (через Сервис)
        const leadId = await OrderService.createLead(userId, estimate);

        // 3. Рисуем ответ
        const wallNames = {
          light: "ГКЛ/Газоблок",
          medium: "Кирпич",
          heavy: "Бетон",
        };
        const txt =
          `⚡️ <b>СМЕТА</b>\n` +
          `🏢 Объект: ${estimate.area} м²\n` +
          `🧱 Стены: ${wallNames[wallType]}\n\n` +
          `🛠 Работа: ~${formatKZT(estimate.costs.work)}\n` +
          `🔌 Материал: ~${formatKZT(estimate.costs.material)}\n` +
          `🏁 <b>ИТОГО: ~${formatKZT(estimate.costs.total)}</b>`;

        await bot.sendMessage(chatId, txt, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📝 Оформить заявку",
                  callback_data: `order_chat_${leadId}`,
                },
              ],
            ],
          },
        });
        sessions.reset(chatId);
        return;
      }

      // ====================================================
      // 5. СОЗДАНИЕ ЗАКАЗА
      // ====================================================
      if (data.startsWith("order_")) {
        const [_, type, leadId] = data.split("_");
        await bot.answerCallbackQuery(callbackQueryId);

        const result = await OrderService.createOrder(userId, leadId);

        await bot.sendMessage(
          chatId,
          "✅ <b>Заявка принята!</b>\nМенеджер свяжется с вами.",
          { parse_mode: "HTML" },
        );

        await notifyAdmin(
          `🔥 <b>НОВЫЙ ЗАКАЗ #${result.orderId}</b>\n` +
            `👤 Клиент: ${result.user.first_name}\n` +
            `📱 Тел: <code>${result.user.phone || "-"}</code>\n` +
            `💰 Сумма: ${formatKZT(result.lead.total_work_cost)}`,
          result.orderId,
        );
      }
    } catch (error) {
      console.error("💥 [CALLBACK ERROR]", error);
      await bot.answerCallbackQuery(callbackQueryId, {
        text: "Ошибка сервера",
      });
    }
  });
};

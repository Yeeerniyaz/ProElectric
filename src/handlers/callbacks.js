/**
 * @file src/handlers/callbacks.js
 * @description Обработчик нажатий на кнопки (Inline Buttons).
 * Исправлена критическая ошибка sessions.reset -> sessions.delete.
 * @version 6.2.0 (Final Fix)
 */

import { bot } from "../bot.js"; // bot.js-тен импорттаймыз (Polling сол жақта)
import { OrderService } from "../services/OrderService.js";
import { STATUS_CONFIG } from "../constants.js";
import { sessions, notifyAdmin, handleAdminCommand } from "./messages.js";

// Ақшаны әдемі көрсету (KZT)
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
      // 1. АДМИНКА (Admin Actions)
      // ====================================================
      if (data.startsWith("adm_")) {
        const cmd = data.split("_")[1];
        await bot.answerCallbackQuery(callbackQueryId);
        return await handleAdminCommand(message, [null, cmd]);
      }

      // ====================================================
      // 2. СТАТУС ТАПСЫРЫС (Status Change)
      // ====================================================
      if (data.startsWith("status_")) {
        const [_, newStatus, orderId] = data.split("_");
        const cfg = STATUS_CONFIG[newStatus];

        if (!cfg || !orderId)
          return bot.answerCallbackQuery(callbackQueryId, {
            text: "❌ Қате деректер",
          });

        // 1. Service арқылы статус өзгерту
        const financeData = await OrderService.updateStatus(
          orderId,
          newStatus,
          userId,
        );

        // 2. Хабарламаны жаңарту (UI)
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

        // 3. Егер статус DONE болса - Қаржылық есепті шығару
        if (financeData) {
          const msg =
            `💰 <b>ЗАКАЗ #${orderId} ЖАБЫЛДЫ!</b>\n` +
            `💸 <b>Жалпы сома:</b> ${formatKZT(financeData.total)}\n` +
            `🏢 <b>Бизнес (${financeData.percents.business}%):</b> ${formatKZT(financeData.businessShare)}\n` +
            `👷‍♂️ <b>Оклад (${financeData.percents.staff}%):</b> ${formatKZT(financeData.staffShare)}\n\n` +
            `<i>Қаражат автоматты түрде бөлінді.</i>`;
          await bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
        }

        return bot.answerCallbackQuery(callbackQueryId, {
          text: `✅ Статус: ${cfg.label}`,
        });
      }

      // ====================================================
      // 3. ЗАКАЗДЫ АЛУ (Take Order)
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
            text: "🚀 Сәтті алынды!",
          });
        } catch (e) {
          if (e.message === "ACCESS_DENIED") {
            return bot.answerCallbackQuery(callbackQueryId, {
              text: "⛔️ Тек менеджерлерге рұқсат",
              show_alert: true,
            });
          }
          throw e; // Басқа қате болса логқа жібереміз
        }
      }

      // ====================================================
      // 4. КАЛЬКУЛЯТОР (Calculator)
      // ====================================================
      if (data.startsWith("wall_")) {
        const wallType = data.split("_")[1];
        const session = sessions.get(chatId);

        if (!session?.data?.area) {
          return bot.answerCallbackQuery(callbackQueryId, {
            text: "⚠️ Сессия ескірді. Қайта бастаңыз.",
            show_alert: true,
          });
        }

        await bot.answerCallbackQuery(callbackQueryId);

        // 1. Есептеу
        const estimate = await OrderService.calculateEstimate(
          session.data.area,
          wallType,
        );
        // 2. Лид сақтау
        const leadId = await OrderService.createLead(userId, estimate);

        // 3. Нәтижені шығару
        const wallNames = {
          light: "ГКЛ/Газоблок",
          medium: "Кирпич",
          heavy: "Бетон/Монолит",
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

        // 🔥 МАҢЫЗДЫ ТҮЗЕТУ: reset() ЕМЕС, delete()
        sessions.delete(chatId);
        return;
      }

      // ====================================================
      // 5. ЗАКАЗ РАСТАУ (Confirm Order)
      // ====================================================
      if (data.startsWith("order_")) {
        const leadId = data.split("_")[2];
        await bot.answerCallbackQuery(callbackQueryId);

        const result = await OrderService.createOrder(userId, leadId);

        await bot.sendMessage(
          chatId,
          "✅ <b>Заявка қабылданды!</b>\nМенеджер сізбен жақын арада хабарласады.",
          { parse_mode: "HTML" },
        );

        // Админдерге хабарлау
        await notifyAdmin(
          `🔥 <b>ЖАҢА ЗАКАЗ #${result.orderId}</b>\n` +
            `👤 Клиент: ${result.user.first_name} (@${result.user.username || "- "})\n` +
            `📱 Тел: <code>${result.user.phone || "-"}</code>\n` +
            `💰 Болжам: ${formatKZT(result.lead.total_work_cost)}`,
          result.orderId,
        );
      }
    } catch (error) {
      console.error("💥 [CALLBACK ERROR]", error);
      await bot.answerCallbackQuery(callbackQueryId, {
        text: "Сервер қатесі. Кейінірек көріңіз.",
      });
    }
  });
};
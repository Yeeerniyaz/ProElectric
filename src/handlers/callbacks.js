/**
 * @file src/handlers/callbacks.js
 * @description Обработчик нажатий на кнопки (Inline Buttons).
 * Полная локализация на Русский язык 🇷🇺.
 * "Смета" заменена на "Предварительный расчет".
 * Добавлена логика внесения расходов.
 * @version 7.2.0 (Expenses & Wording Fix)
 */

import { bot } from "../core.js";
import { OrderService } from "../services/OrderService.js";
import { sessions, notifyAdmin } from "./messages.js";
import { db } from "../db.js";

// Форматирование денег (KZT)
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
      // 1. КАЛЬКУЛЯТОР: ВЫБОР СТЕН (CLIENT SIDE)
      // ====================================================
      if (data.startsWith("wall_")) {
        const wallType = data.split("_")[1]; // light, brick, concrete
        const session = sessions.get(chatId);

        // Проверка сессии (чтобы не упало)
        if (!session || !session.data.area || !session.data.rooms) {
          return bot.answerCallbackQuery(callbackQueryId, {
            text: "⚠️ Время сессии истекло. Начните расчет заново.",
            show_alert: true,
          });
        }

        await bot.answerCallbackQuery(callbackQueryId);

        // 1. Считаем смету
        const estimate = await OrderService.calculateEstimate(
            session.data.area,
            session.data.rooms,
            wallType
        );

        // 2. Создаем заказ в БД (статус NEW)
        const order = await OrderService.createOrder(userId, estimate);

        // 3. Красивый вывод клиенту
        const wallNames = {
            light: "Газоблок (Легкий)",
            brick: "Кирпич (Средний)",
            concrete: "Бетон (Сложный)"
        };

        const resultText =
          `⚡️ <b>ПРЕДВАРИТЕЛЬНЫЙ РАСЧЕТ</b>\n` +
          `➖➖➖➖➖➖➖➖➖\n` +
          `🏠 <b>Объект:</b> ${estimate.params.area} м², ${estimate.params.rooms} комн.\n` +
          `🧱 <b>Стены:</b> ${wallNames[wallType]}\n` +
          `🔌 <b>Точки (свет/розетки):</b> ~${estimate.volume.points} шт.\n\n` +
          `🛠 <b>Работы:</b> ~${formatKZT(estimate.costs.work)}\n` +
          `📦 <b>Материал (черновой):</b> ~${formatKZT(estimate.costs.material)}\n` +
          `➖➖➖➖➖➖➖➖➖\n` +
          `🏁 <b>ИТОГО ПОД КЛЮЧ: ~${formatKZT(estimate.costs.total)}</b>\n\n` +
          `<i>ℹ️ Это ориентировочная цена. Финальная стоимость определяется мастером после замера.</i>`;

        // Отправляем клиенту
        await bot.sendMessage(chatId, resultText, {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[
                    { text: "📝 Вызвать мастера на замер", callback_data: `confirm_order_${order.id}` }
                ]]
            }
        });

        // Чистим сессию
        sessions.delete(chatId);
        return;
      }

      // ====================================================
      // 2. ПОДТВЕРЖДЕНИЕ ЗАКАЗА (CLIENT SIDE)
      // ====================================================
      if (data.startsWith("confirm_order_")) {
        const orderId = data.split("_")[2];
        await bot.answerCallbackQuery(callbackQueryId, { text: "✅ Заявка отправлена!" });

        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
            chat_id: chatId, 
            message_id: message.message_id 
        });

        await bot.sendMessage(chatId, 
            "✅ <b>Спасибо! Ваша заявка принята.</b>\n\n" +
            "👨‍🔧 Наш мастер свяжется с вами в ближайшее время для уточнения деталей.",
            { parse_mode: "HTML" }
        );

        // Уведомление в Админ-Чат
        const orderInfo = 
            `🔥 <b>НОВАЯ ЗАЯВКА #${orderId}</b>\n` +
            `👤 Клиент: <a href="tg://user?id=${userId}">${from.first_name}</a>\n` +
            `📞 Контакт: Требуется запросить`; 
            
        await notifyAdmin(orderInfo, orderId); // Передаем ID для кнопки "Взять"
        
        // Запускаем таймер авто-назначения (если никто не возьмет через 30 мин)
        setTimeout(async () => {
             const masterId = await OrderService.autoAssignMaster(orderId);
             if (masterId) {
                 await bot.sendMessage(masterId, `⚠️ <b>АВТО-НАЗНАЧЕНИЕ!</b>\nЗаказ #${orderId} передан вам, так как никто не взял его вовремя.`);
             }
        }, 30 * 60 * 1000);
      }

      // ====================================================
      // 3. МЕНЕДЖЕР: ВЗЯТЬ ЗАКАЗ (ADMIN SIDE)
      // ====================================================
      if (data.startsWith("take_order_")) {
        const orderId = data.split("_")[2];

        try {
          await OrderService.assignMaster(orderId, userId);

          // Обновляем сообщение в админке
          const takenMsg = message.text + `\n\n✅ <b>Взял в работу:</b> ${from.first_name}`;
          await bot.editMessageText(takenMsg, {
            chat_id: chatId,
            message_id: message.message_id,
            parse_mode: "HTML"
          });

          // Пишем лично менеджеру
          await bot.sendMessage(userId, 
            `👷‍♂️ <b>Вы назначены на объект #${orderId}</b>\n` +
            `Свяжитесь с клиентом и договоритесь о замере.`,
            { parse_mode: "HTML" }
          );

          return bot.answerCallbackQuery(callbackQueryId, { text: "🚀 Заказ ваш!" });

        } catch (e) {
            console.error(e);
            return bot.answerCallbackQuery(callbackQueryId, { 
                text: "❌ Ошибка. Возможно, заказ уже взят.", 
                show_alert: true 
            });
        }
      }

      // ====================================================
      // 4. МЕНЕДЖЕР: ДОБАВЛЕНИЕ РАСХОДА (ADD EXPENSE)
      // ====================================================
      if (data.startsWith("add_expense_")) {
        const orderId = data.split("_")[2];
        
        // Запоминаем, что юзер хочет добавить расход к этому заказу
        sessions.set(chatId, {
            step: "EXPENSE_AMOUNT",
            data: { orderId: orderId }
        });

        await bot.answerCallbackQuery(callbackQueryId);
        await bot.sendMessage(chatId, 
            `💸 <b>РАСХОД ПО ЗАКАЗУ #${orderId}</b>\n\n` +
            `Введите сумму расхода (тенге):`, 
            { 
                reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel_op" }]] }, 
                parse_mode: "HTML" 
            }
        );
      }

      // ====================================================
      // 5. МЕНЕДЖЕР: НАЧАЛО ЗАКРЫТИЯ (START CLOSE)
      // ====================================================
      if (data.startsWith("close_order_start_")) {
          const orderId = data.split("_")[2];
          
          sessions.set(chatId, { 
              step: "FINISH_SUM", 
              data: { orderId: orderId } 
          });

          await bot.answerCallbackQuery(callbackQueryId);
          await bot.sendMessage(chatId, 
              `💰 <b>ЗАКРЫТИЕ ЗАКАЗА #${orderId}</b>\n\n` +
              `Введите итоговую сумму, которую <b>фактически</b> заплатил клиент (цифрами):`,
              { reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel_op" }]] }, parse_mode: "HTML" }
          );
      }

      // ====================================================
      // 6. МЕНЕДЖЕР: ЗАКРЫТИЕ СДЕЛКИ (ВЫБОР КОШЕЛЬКА)
      // ====================================================
      if (data.startsWith("wallet_")) {
         const walletId = data.split("_")[1];
         const session = sessions.get(chatId);

         if (!session || !session.data.finalSum || !session.data.orderId) {
             return bot.answerCallbackQuery(callbackQueryId, { text: "Ошибка сессии", show_alert: true });
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
            message_id: message.message_id,
            parse_mode: "HTML"
         });

         sessions.delete(chatId);
      }

      // ====================================================
      // 7. ОБЩАЯ ОТМЕНА (CANCEL)
      // ====================================================
      if (data === "cancel_op") {
          sessions.delete(chatId);
          await bot.editMessageText("❌ Операция отменена.", { chat_id: chatId, message_id: message.message_id });
      }

    } catch (error) {
      console.error("💥 [CALLBACK ERROR]", error);
      await bot.answerCallbackQuery(callbackQueryId, {
        text: "❌ Произошла системная ошибка.",
      });
    }
  });
};
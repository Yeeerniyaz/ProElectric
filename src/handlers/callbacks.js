import { bot } from "../core.js";
import { db } from "../db.js";
// 🔥 Импортируем всё необходимое
import { handleAdminCommand, sessions, notifyAdmin, KB } from "./messages.js";
import { STATUS_CONFIG } from "../constants.js";

// Утилита для красивого форматирования денег (1 000 000 ₸)
const formatKZT = (num) => {
  return new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(num);
};

export const setupCallbackHandlers = () => {
  bot.on("callback_query", async (query) => {
    const { id, data, message, from } = query;
    const chatId = message.chat.id;

    try {
      // ====================================================
      // 1. АДМИН-ПУЛЬТ (ЛОГИКА ИЗ КАНАЛА)
      // ====================================================
      if (data.startsWith("adm_")) {
        const cmd = data.split("_")[1]; // stats, new, list...
        await bot.answerCallbackQuery(id);

        // 🔥 UX: Показываем, что бот работает
        bot.sendChatAction(chatId, "typing");
        console.log(`🔘 [ADMIN] Нажата кнопка: ${cmd} в чате ${chatId}`);

        await handleAdminCommand(message, [null, cmd]);
        return;
      }

      // ====================================================
      // 2. СМЕНА СТАТУСА (АВТО-НАЗНАЧЕНИЕ ОТВЕТСТВЕННОГО)
      // ====================================================
      if (data.startsWith("status_")) {
        const [_, action, orderId] = data.split("_"); // Деструктуризация
        const cfg = STATUS_CONFIG[action];

        if (cfg && orderId) {
          // Обновляем статус И назначаем того, кто нажал
          await db.query(
            `
                        UPDATE orders 
                        SET status = $1, 
                            assignee_id = (SELECT id FROM users WHERE telegram_id = $2),
                            updated_at = NOW() 
                        WHERE id = $3
                    `,
            [action, from.id, orderId],
          );

          // Чистим текст сообщения от старых заголовков
          const originalText = message.text || "";
          const cleanedText = originalText
            .replace(/^.*(СТАТУС|Ответственный):.*\n\n/g, "")
            .replace(/^.*СТАТУС:.*\n\n/g, "");

          const time = new Date().toLocaleTimeString("ru-RU", {
            hour: "2-digit",
            minute: "2-digit",
          });

          const updatedText =
            `${cfg.icon} <b>СТАТУС: ${cfg.label}</b>\n` +
            `👷‍♂️ <b>Ответственный: ${from.first_name}</b> (обн. ${time})\n\n` +
            `${cleanedText}`;

          try {
            await bot.editMessageText(updatedText, {
              chat_id: chatId,
              message_id: message.message_id,
              parse_mode: "HTML",
              reply_markup: message.reply_markup,
            });
            await bot.answerCallbackQuery(id, {
              text: `✅ Статус: ${cfg.label}`,
            });
          } catch (e) {
            // Игнорируем ошибку, если текст не изменился
            await bot.answerCallbackQuery(id);
          }
        }
        return;
      }

      // ====================================================
      // 3. ЯВНОЕ ВЗЯТИЕ ЗАКАЗА (КНОПКА "ВЗЯТЬ В РАБОТУ")
      // ====================================================
      if (data.startsWith("take_order_")) {
        const orderId = data.split("_")[2];
        const userId = from.id;

        // Проверка прав
        const userRes = await db.query(
          "SELECT id, role, first_name FROM users WHERE telegram_id = $1",
          [userId],
        );
        const user = userRes.rows[0];

        if (!user || (user.role !== "admin" && user.role !== "manager")) {
          return bot.answerCallbackQuery(id, {
            text: "⛔️ У вас нет прав.",
            show_alert: true,
          });
        }

        // Назначаем
        await db.query(
          "UPDATE orders SET assignee_id = $1, status = $2 WHERE id = $3",
          [user.id, "work", orderId],
        );

        const originalText = message.text || "";
        const updatedText =
          originalText + `\n\n✅ <b>Заказ принял: ${user.first_name}</b>`;

        await bot.editMessageText(updatedText, {
          chat_id: chatId,
          message_id: message.message_id,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] }, // Убираем кнопку
        });

        return bot.answerCallbackQuery(id, {
          text: "✅ Вы назначены ответственным!",
        });
      }

      // ====================================================
      // 4. КАЛЬКУЛЯТОР (СЕССИЯ И РАСЧЕТ)
      // ====================================================
      const session = sessions.get(chatId);

      // Если сессия протухла
      if (!session && data.startsWith("wall_")) {
        return bot.answerCallbackQuery(id, {
          text: "⚠️ Начните новый расчет /start",
          show_alert: true,
        });
      }

      if (data.startsWith("wall_")) {
        bot.sendChatAction(chatId, "typing"); // UX

        session.data.wallType = data.replace("wall_", "");
        session.step = "IDLE";

        // 1. Технический расчет (материалы)
        const area = session.data.area;
        const estCable = Math.ceil(area * 4.5); // 4.5м кабеля на м2
        const estPoints = Math.ceil(area * 0.8); // 0.8 точек на м2
        const estShield = Math.ceil(area / 6) + 8; // Размер щита

        // 2. Финансовый расчет (цены)
        // Дефолтные цены (Fallback)
        let prices = {
          wall_light: 4500,
          wall_medium: 5500,
          wall_heavy: 7500,
          material_m2: 4000,
        };

        // Пытаемся взять из базы
        try {
          const dbPrices = await db.getSettings();
          if (Object.keys(dbPrices).length > 0)
            prices = { ...prices, ...dbPrices };
        } catch (e) {
          console.error("Calc Price Error:", e.message);
        }

        const pricePerPoint = prices[`wall_${session.data.wallType}`];
        const totalWork = estPoints * pricePerPoint;
        const totalMat = area * prices.material_m2;
        const totalSum = totalWork + totalMat;

        const wallLabel = {
          light: "Газоблок/ГКЛ",
          medium: "Кирпич",
          heavy: "Бетон/Монолит",
        }[session.data.wallType];

        // 3. Сохранение Лида
        const userRes = await db.query(
          "SELECT id FROM users WHERE telegram_id = $1",
          [from.id],
        );
        let leadId = null;
        if (userRes.rows.length > 0) {
          const insert = await db.query(
            `INSERT INTO leads (user_id, area, wall_type, total_work_cost, total_mat_cost) 
                         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [
              userRes.rows[0].id,
              area,
              session.data.wallType,
              totalWork,
              totalMat,
            ],
          );
          leadId = insert.rows[0].id;
        }

        // 4. Результат
        const result =
          `⚡️ <b>СМЕТА (Объект ${area} м²)</b>\n\n` +
          `🧱 <b>Стены:</b> ${wallLabel}\n` +
          `📋 <b>Материалы (ориентир):</b>\n • Кабель: ~${estCable}м\n • Точки: ~${estPoints}шт\n • Щит: ~${estShield} мод.\n\n` +
          `💵 <b>Работа:</b> ${formatKZT(totalWork)}\n🔌 <b>Материал:</b> ~${formatKZT(totalMat)}\n` +
          `➖➖➖➖\n💰 <b>ИТОГО: ~${formatKZT(totalSum)}</b>\n\n` +
          `<i>*Цена примерная. Точная смета — после замера.</i>`;

        await bot.sendMessage(chatId, result, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "💬 Обсудить в WhatsApp",
                  callback_data: `create_order_wa_${leadId}`,
                },
              ],
              [
                {
                  text: "👷‍♂️ Записаться на замер",
                  callback_data: `create_order_call_${leadId}`,
                },
              ],
            ],
          },
        });

        sessions.delete(chatId);
        // 🔥 Возвращаем меню, чтобы юзер не потерялся
        await bot.sendMessage(
          chatId,
          "👇 <b>Что делаем дальше?</b>",
          KB.MAIN_MENU,
        );

        return bot.answerCallbackQuery(id);
      }

      // ====================================================
      // 5. СОЗДАНИЕ ЗАКАЗА
      // ====================================================
      if (data.startsWith("create_order_")) {
        const [, , type, leadId] = data.split("_"); // wa или call
        bot.sendChatAction(chatId, "typing");

        const userQuery = await db.query(
          "SELECT id, username, phone, first_name FROM users WHERE telegram_id = $1",
          [from.id],
        );
        const userData = userQuery.rows[0];

        if (!userData)
          return bot.answerCallbackQuery(id, {
            text: "Ошибка: Нажмите /start",
          });

        // Создаем заказ в БД
        const orderRes = await db.query(
          `INSERT INTO orders (user_id, lead_id, status) VALUES ($1, $2, 'new') RETURNING id`,
          [userData.id, leadId],
        );
        const newOrderId = orderRes.rows[0].id;

        // Ответ клиенту
        let clientMsg =
          "✅ <b>Заявка принята!</b>\nМенеджер свяжется с вами в ближайшее время.";
        if (type === "wa")
          clientMsg =
            "✅ <b>Переходим в WhatsApp...</b>\n👉 https://wa.me/77066066323"; // Твой номер

        await bot.sendMessage(chatId, clientMsg, { parse_mode: "HTML" });

        // Уведомление Админу
        const leadInfo = await db.query(
          "SELECT area, total_work_cost FROM leads WHERE id = $1",
          [leadId],
        );
        const lead = leadInfo.rows[0];

        await notifyAdmin(
          `🔥 <b>НОВЫЙ ЗАКАЗ #${newOrderId}</b>\n` +
            `👤 <b>Клиент:</b> ${userData.first_name} (@${userData.username || "нет"})\n` +
            `📱 <b>Тел:</b> <code>${userData.phone}</code>\n` +
            `💰 <b>Смета:</b> ~${formatKZT(lead.total_work_cost)}\n` +
            `🎯 <b>Тип:</b> ${type === "wa" ? "WhatsApp" : "Замер"}`,
          newOrderId,
        );
        return bot.answerCallbackQuery(id);
      }
    } catch (error) {
      console.error("💥 [CALLBACK ERROR]", error);
      await bot.answerCallbackQuery(id, { text: "❌ Ошибка сервера" });
    }
  });
};

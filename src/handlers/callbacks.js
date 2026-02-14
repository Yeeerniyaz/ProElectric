import { bot } from "../core.js";
import { db } from "../db.js";
// 🔥 Импортируем всё необходимое сразу
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

        console.log(`🔘 [ADMIN] Нажата кнопка: ${cmd} в чате ${chatId}`);

        // Делегируем выполнение в messages.js
        await handleAdminCommand(message, [null, cmd]);
        return;
      }

      // ====================================================
      // 2. СМЕНА СТАТУСА (АВТО-НАЗНАЧЕНИЕ ОТВЕТСТВЕННОГО)
      // ====================================================
      if (data.startsWith("status_")) {
        const parts = data.split("_");
        const action = parts[1]; // discuss, work, done, cancel
        const orderId = parts[2];
        const cfg = STATUS_CONFIG[action];

        if (cfg && orderId) {
          // Обновляем статус И назначаем того, кто нажал (assignee_id)
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

          // Формируем обновленный текст сообщения
          const originalText = message.text || "";
          // Чистим старые заголовки (чтобы не двоились)
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
              text: `✅ Вы взяли заказ: ${cfg.label}`,
            });
          } catch (e) {
            // Игнорируем ошибку "message not modified"
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

        // Проверка прав (только админы и менеджеры могут брать заказы)
        const userRes = await db.query(
          "SELECT id, role, first_name FROM users WHERE telegram_id = $1",
          [userId],
        );
        const user = userRes.rows[0];

        if (!user || (user.role !== "admin" && user.role !== "manager")) {
          return bot.answerCallbackQuery(id, {
            text: "⛔️ У вас нет прав брать заказы.",
            show_alert: true,
          });
        }

        // Назначаем статус "В работе" и ответственного
        await db.query(
          "UPDATE orders SET assignee_id = $1, status = $2 WHERE id = $3",
          [user.id, "work", orderId],
        );

        const originalText = message.text || "";
        const updatedText =
          originalText + `\n\n✅ <b>Заказ принял: ${user.first_name}</b>`;

        // Убираем кнопку "Взять в работу", чтобы не нажали второй раз
        await bot.editMessageText(updatedText, {
          chat_id: chatId,
          message_id: message.message_id,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        });

        return bot.answerCallbackQuery(id, {
          text: "✅ Вы назначены ответственным!",
        });
      }

      // ====================================================
      // 4. КАЛЬКУЛЯТОР (СЕССИЯ И РАСЧЕТ)
      // ====================================================

      const session = sessions.get(chatId);

      // Если сессия протухла, а кнопки старые
      if (!session && data.startsWith("wall_")) {
        return bot.answerCallbackQuery(id, {
          text: "⚠️ Сессия устарела. Нажмите /start для нового расчета.",
          show_alert: true,
        });
      }

      if (data.startsWith("wall_")) {
        session.data.wallType = data.replace("wall_", "");
        session.step = "IDLE";

        // --- 1. ТЕХНИЧЕСКИЙ РАСЧЕТ (КОЛИЧЕСТВО) ---
        const area = session.data.area;

        // 1. Кабель: берем 4.5м на квадрат. Это покроет розетки, свет и пару доп. линий.
        const estCable = Math.ceil(area * 4.5);

        // 2. Точки (подрозетники): 0.8 — золотая середина между комфортом и экономией.
        const estPoints = Math.ceil(area * 0.8);

        // 3. Щит: увеличил базу, так как современная автоматика (УЗО, реле напряжения) занимает место.
        // Для 40м2 ~ 14 мод, для 70м2 ~ 20 мод.
        const estShield = Math.ceil(area / 6) + 8;

        // --- 2. ФИНАНСОВЫЙ РАСЧЕТ (ДИНАМИЧЕСКИЙ) ---

        // Базовые цены (резерв на случай сбоя БД)
        let prices = {
          wall_light: 4500,
          wall_medium: 5500,
          wall_heavy: 7500,
          material_m2: 4000,
        };

        // 🔥 Получаем актуальные цены из базы (если есть)
        try {
          const dbPrices = await db.getSettings(); // Метод из db.js
          if (Object.keys(dbPrices).length > 0) {
            prices = { ...prices, ...dbPrices };
          }
        } catch (e) {
          console.error(
            "⚠️ [CALC] Не удалось получить цены из БД, используем стандартные.",
          );
        }

        // Выбираем цену под тип стен
        const pricePerPoint = prices[`wall_${session.data.wallType}`];
        const matCostM2 = prices["material_m2"];

        // Итоговая математика
        const totalWork = estPoints * pricePerPoint;
        const totalMat = area * matCostM2;
        const totalSum = totalWork + totalMat;

        const wallLabel = {
          light: "Газоблок/ГКЛ",
          medium: "Кирпич",
          heavy: "Бетон/Монолит",
        }[session.data.wallType];

        // --- 3. СОХРАНЕНИЕ ЛИДА ---
        const userRes = await db.query(
          "SELECT id FROM users WHERE telegram_id = $1",
          [from.id],
        );
        let leadId = null;

        if (userRes.rows.length > 0) {
          const insertRes = await db.query(
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
          leadId = insertRes.rows[0].id;
        }

        // --- 4. ОТПРАВКА СМЕТЫ ---
        const resultText =
          `⚡️ <b>СМЕТА НА ЭЛЕКТРОМОНТАЖ (${area} м²)</b>\n\n` +
          `🧱 <b>Стены:</b> ${wallLabel}\n` +
          `📋 <b>Материалы (примерно):</b>\n` +
          ` • Кабель ВВГнг-LS: ~${estCable} м\n` +
          ` • Подрозетники: ~${estPoints} шт\n` +
          ` • Щит в сборе: ~${estShield} модулей\n\n` +
          `💵 <b>Стоимость работ:</b> ${formatKZT(totalWork)}\n` +
          `🔌 <b>Стоимость материалов:</b> ~${formatKZT(totalMat)}\n` +
          `➖➖➖➖➖➖➖➖➖➖\n` +
          `💰 <b>ИТОГО ПОД КЛЮЧ: ~${formatKZT(totalSum)}</b>\n\n` +
          `<i>*Цена ориентировочная. Точная смета после замера.</i>`;

        await bot.sendMessage(chatId, resultText, {
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

        // Очищаем сессию и возвращаем меню
        sessions.delete(chatId);
        await bot.sendMessage(
          chatId,
          "👇 <b>Что делаем дальше?</b>",
          KB.MAIN_MENU,
        );

        return bot.answerCallbackQuery(id);
      }

      // ====================================================
      // 5. СОЗДАНИЕ ЗАКАЗА (КЛИЕНТ НАЖАЛ "ЗАКАЗАТЬ")
      // ====================================================
      if (data.startsWith("create_order_")) {
        const parts = data.split("_");
        const type = parts[2]; // wa или call
        const leadId = parts[3];

        const user = await db.query(
          "SELECT id, username, phone, first_name FROM users WHERE telegram_id = $1",
          [from.id],
        );
        if (user.rows.length === 0)
          return bot.answerCallbackQuery(id, { text: "Ошибка пользователя" });
        const userData = user.rows[0];

        // Создаем заказ
        const orderRes = await db.query(
          `INSERT INTO orders (user_id, lead_id, status) VALUES ($1, $2, 'new') RETURNING id`,
          [userData.id, leadId],
        );
        const newOrderId = orderRes.rows[0].id;

        // Ответ клиенту
        let msgClient =
          "✅ <b>Заявка принята!</b>\nМастер свяжется с вами в ближайшее время.";
        if (type === "wa")
          msgClient =
            "✅ <b>Переходим в WhatsApp...</b>\n👉 https://wa.me/77066066323";

        await bot.sendMessage(chatId, msgClient, { parse_mode: "HTML" });

        // Получаем детали для админа
        const leadInfo = await db.query(
          "SELECT area, total_work_cost FROM leads WHERE id = $1",
          [leadId],
        );
        const lead = leadInfo.rows[0];

        // 🔥 Уведомляем админа (функция из messages.js)
        await notifyAdmin(
          `🔥 <b>НОВЫЙ ЗАКАЗ #${newOrderId}</b>\n` +
            `👤 <b>Клиент:</b> ${userData.first_name} (@${userData.username || "нет_юзера"})\n` +
            `📱 <b>Тел:</b> <code>${userData.phone}</code>\n` +
            `📐 <b>Объект:</b> ${lead.area} м²\n` +
            `💰 <b>Смета:</b> ~${formatKZT(lead.total_work_cost)}\n` +
            `🎯 <b>Действие:</b> ${type === "wa" ? "WhatsApp" : "Замер"}`,
          newOrderId,
        );

        return bot.answerCallbackQuery(id);
      }
    } catch (error) {
      console.error("💥 [CALLBACK FATAL ERROR]", error);
      await bot.answerCallbackQuery(id, { text: "❌ Произошла ошибка" });
    }
  });
};

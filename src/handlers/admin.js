/**
 * @file src/handlers/admin.js
 * @description Модуль Администратора.
 * Управление персоналом, финансами, настройками и рассылками.
 * @module AdminHandlers
 */

import { bot } from "../core.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { KEYBOARDS, ROLES } from "../constants.js";
import { OrderService } from "../services/OrderService.js";

// Форматтер денег (KZT)
const formatMoney = (num) =>
  new Intl.NumberFormat("ru-KZ", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(num);

// =============================================================================
// 🛡 MIDDLEWARE (Проверка прав)
// =============================================================================

const checkAdmin = async (msg) => {
  const user = await db.upsertUser(msg.from.id, msg.from.first_name);
  if (user.role !== ROLES.ADMIN) {
    await bot.sendMessage(
      msg.chat.id,
      "⛔️ <b>Доступ запрещен.</b>\nЭта команда только для владельца.",
      { parse_mode: "HTML" },
    );
    return false;
  }
  return true;
};

// =============================================================================
// 🎮 HANDLERS
// =============================================================================

export const setupAdminHandlers = () => {
  // 1. ВХОД В АДМИНКУ
  // -------------------------------------------------------------------------
  const openAdminPanel = async (msg) => {
    if (!(await checkAdmin(msg))) return;

    await bot.sendMessage(
      msg.chat.id,
      `👑 <b>ПАНЕЛЬ УПРАВЛЕНИЯ</b>\n` +
        `Добро пожаловать, Шеф! Системы работают штатно.\n` +
        `Выберите действие:`,
      {
        parse_mode: "HTML",
        reply_markup: KEYBOARDS.admin,
      },
    );
  };

  bot.onText(/\/admin/, openAdminPanel);
  bot.onText(/👑 Админ-панель/, openAdminPanel);

  // 2. СТАТИСТИКА (KPI + КАССЫ)
  // -------------------------------------------------------------------------
  bot.onText(/📊 Статистика \(KPI\)/, async (msg) => {
    if (!(await checkAdmin(msg))) return;

    // 1. Общие цифры (Прибыль по закрытым заказам)
    const kpi = await db.getKPI();
    const activeOrders = await OrderService.getActiveOrders(null, "admin");

    // 2. Деньги на руках (Сумма всех кошельков)
    const accounts = await db.getAccounts(null, "admin");
    const totalCash = accounts.reduce(
      (sum, acc) => sum + parseFloat(acc.balance),
      0,
    );

    let cashText = "";
    accounts.forEach((acc) => {
      cashText += `▫️ ${acc.name}: <b>${formatMoney(acc.balance)}</b>\n`;
    });

    const text =
      `📊 <b>ФИНАНСОВЫЙ ОТЧЕТ</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `💰 <b>Оборот (Грязными):</b> ${formatMoney(kpi.revenue)}\n` +
      `📈 <b>Чистая прибыль:</b> ${formatMoney(kpi.profit)}\n` +
      `🔨 <b>Объектов в работе:</b> ${activeOrders.length}\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `🏦 <b>ДЕНЬГИ В КАССАХ (ВСЕГО: ${formatMoney(totalCash)}):</b>\n` +
      `${cashText}\n` +
      `<i>Данные обновлены: ${new Date().toLocaleTimeString()}</i>`;

    await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
  });

  // 3. СОТРУДНИКИ (HR)
  // -------------------------------------------------------------------------
  bot.onText(/👥 Сотрудники/, async (msg) => {
    if (!(await checkAdmin(msg))) return;

    const employees = await db.getEmployees();

    if (employees.length === 0) {
      return bot.sendMessage(
        msg.chat.id,
        "🤷‍♂️ Сотрудников пока нет.\nДобавьте их командой /setrole.",
      );
    }

    let text = "<b>👥 КОМАНДА PROELECTRO:</b>\n\n";
    employees.forEach((u, i) => {
      const icon = u.role === ROLES.ADMIN ? "👑" : "👷‍♂️";
      const link = u.username
        ? `@${u.username}`
        : `ID: <code>${u.telegram_id}</code>`;
      text += `${i + 1}. ${icon} <b>${u.first_name}</b> (${link}) — ${u.role.toUpperCase()}\n`;
    });

    text +=
      `\n⚙️ <b>Управление:</b>\n` +
      `Чтобы назначить менеджера:\n` +
      `<code>/setrole ID manager</code>\n\n` +
      `Чтобы уволить (сделать клиентом):\n` +
      `<code>/setrole ID client</code>`;

    await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
  });

  // 4. НАЗНАЧЕНИЕ РОЛЕЙ (Magic Command)
  // -------------------------------------------------------------------------
  bot.onText(/\/setrole (\d+) (admin|manager|client)/, async (msg, match) => {
    if (!(await checkAdmin(msg))) return;

    const targetId = match[1];
    const newRole = match[2];

    try {
      // Имя для кассы (если создается)
      const name = `Sotrudnik_${targetId}`;

      await db.promoteUser(targetId, newRole, name);

      await bot.sendMessage(
        msg.chat.id,
        `✅ Роль обновлена!\nID: <code>${targetId}</code> → <b>${newRole.toUpperCase()}</b>`,
        { parse_mode: "HTML" },
      );

      // Уведомляем сотрудника
      try {
        await bot.sendMessage(
          targetId,
          `🎉 <b>Обновление прав доступа!</b>\n` +
            `Ваша роль изменена на: <b>${newRole.toUpperCase()}</b>.\n` +
            `Перезапустите бота командой /start, чтобы обновить меню.`,
          { parse_mode: "HTML" },
        );
      } catch (e) {
        /* Игнор блока */
      }
    } catch (e) {
      console.error(e);
      await bot.sendMessage(msg.chat.id, "❌ Ошибка при обновлении роли.");
    }
  });

  // 5. РАССЫЛКА (Broadcast)
  // -------------------------------------------------------------------------
  bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    if (!(await checkAdmin(msg))) return;

    const text = match[1];
    const res = await db.query("SELECT telegram_id FROM users");
    const users = res.rows;

    await bot.sendMessage(
      msg.chat.id,
      `📣 Начинаю рассылку для ${users.length} пользователей...`,
    );

    let success = 0;
    for (const u of users) {
      try {
        await bot.sendMessage(
          u.telegram_id,
          `📢 <b>НОВОСТИ PROELECTRO:</b>\n\n${text}`,
          { parse_mode: "HTML" },
        );
        success++;
      } catch (e) {
        /* Блок */
      }
    }

    await bot.sendMessage(
      msg.chat.id,
      `✅ Рассылка завершена. Доставлено: ${success}/${users.length}`,
    );
  });

  bot.onText(/📣 Рассылка/, async (msg) => {
    if (!(await checkAdmin(msg))) return;
    await bot.sendMessage(
      msg.chat.id,
      "✍️ Чтобы сделать рассылку, напишите:\n<code>/broadcast Ваш текст новости</code>",
      { parse_mode: "HTML" },
    );
  });

  // 6. СОЗДАНИЕ ЗАКАЗА ВРУЧНУЮ (Manual Order)
  // -------------------------------------------------------------------------
  bot.onText(/\/neworder ([+]?\d+) (\d+) (\d+)/, async (msg, match) => {
    if (!(await checkAdmin(msg))) return;

    const phone = match[1];
    const area = parseInt(match[2]);
    const price = parseInt(match[3]);
    const clientName = "Заказчик (Ручной)";

    try {
      const order = await OrderService.createManualOrder(msg.from.id, {
        clientName,
        clientPhone: phone,
        area,
        price,
      });

      await bot.sendMessage(
        msg.chat.id,
        `✅ <b>Заказ #${order.id} создан!</b>\n` +
          `👤 Клиент: ${phone}\n` +
          `🏠 Площадь: ${area} м²\n` +
          `💰 Сумма: ${formatMoney(price)}`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error(e);
      await bot.sendMessage(msg.chat.id, "❌ Ошибка создания заказа.");
    }
  });

  // Подсказка
  bot.onText(/\/help_admin/, async (msg) => {
    if (!(await checkAdmin(msg))) return;
    await bot.sendMessage(
      msg.chat.id,
      `🛠 <b>ШПАРГАЛКА АДМИНА:</b>\n\n` +
        `1. <b>Назначить роль:</b>\n/setrole ID role\n(role: admin, manager, client)\n\n` +
        `2. <b>Создать заказ вручную:</b>\n/neworder Телефон Площадь Цена\nПример: <code>/neworder +77771112233 55 250000</code>\n\n` +
        `3. <b>Рассылка:</b>\n/broadcast Текст`,
      { parse_mode: "HTML" },
    );
  });

  bot.onText(/\/myid/, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    // Получаем роль из базы
    const user = await db.upsertUser(userId, msg.from.first_name);

    let text =
      `🆔 <b>ИНФО О ПОЛЬЗОВАТЕЛЕ:</b>\n` +
      `ID: <code>${userId}</code>\n` +
      `Роль: <b>${user.role.toUpperCase()}</b>\n` +
      `Чат: <code>${chatId}</code>`;

    if (userId === config.bot.ownerId) {
      text += `\n👑 <i>Система опознала вас как Владельца.</i>`;
    }

    bot.sendMessage(chatId, text, { parse_mode: "HTML" });
  });

  // 2. SYSTEM CHECK (Только для Админа)
  bot.onText(/\/ping/, async (msg) => {
    if (msg.from.id !== config.bot.ownerId) return;

    const start = Date.now();
    const settings = await db.getSettings(); // Проверка связи с БД
    const dbTime = Date.now() - start;

    const status =
      `🟢 <b>SYSTEM ONLINE</b>\n` +
      `🌍 Env: ${config.system.env}\n` +
      `🐘 DB Latency: ${dbTime}ms\n` +
      `💰 Loaded Prices: ${Object.keys(settings).length}`;

    bot.sendMessage(msg.chat.id, status, { parse_mode: "HTML" });
  });
};

/**
 * @file src/handlers/AdminHandler.js
 * @description Контроллер панели администратора (Enterprise CRM Controller).
 * Реализует: Финансовый дашборд, Управление персоналом (RBAC), SQL-терминал, Бэкапы.
 * Архитектура: Self-Contained (все константы внутри).
 *
 * @author ProElectric Team
 * @version 6.5.0 (Owner Edition)
 */

import { Markup } from "telegraf";
import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";
import * as db from "../database/index.js";

// =============================================================================
// 🔧 INTERNAL CONSTANTS & CONFIGURATION
// =============================================================================

/**
 * Роли пользователей (дублируем для автономности, либо берем из UserService если он экспортирует)
 * Для надежности определим локально маппинг.
 */
const ROLES = Object.freeze({
  OWNER: "owner",
  ADMIN: "admin",
  MANAGER: "manager",
  USER: "user",
  BANNED: "banned",
});

/**
 * Тексты кнопок (Admin UI).
 */
const BUTTONS = Object.freeze({
  // Главная
  DASHBOARD: "📊 P&L Отчет",
  ORDERS: "📦 Управление заказами",
  SETTINGS: "⚙️ Настройки цен",
  STAFF: "👥 Персонал",

  // Owner Specific
  SQL_CONSOLE: "👨‍💻 SQL Терминал",
  BACKUP: "💾 Бэкап базы",

  // Навигация
  BACK: "🔙 В главное меню",
  REFRESH: "🔄 Обновить",
});

/**
 * Клавиатуры (Admin Keyboards Factory).
 */
const AdminKeyboards = {
  /**
   * Главное меню админа.
   * Динамически добавляет кнопки Владельца.
   */
  mainMenu: (role) => {
    const buttons = [
      [BUTTONS.DASHBOARD, BUTTONS.ORDERS],
      [BUTTONS.SETTINGS, BUTTONS.STAFF],
    ];

    // 🔒 Эксклюзив для Владельца
    if (role === ROLES.OWNER) {
      buttons.push([BUTTONS.SQL_CONSOLE, BUTTONS.BACKUP]);
    }

    buttons.push([BUTTONS.BACK]);
    return Markup.keyboard(buttons).resize();
  },

  /**
   * Меню управления заказом (Inline).
   */
  orderActions: (orderId) =>
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🛠 В работу", `status_${orderId}_work`),
        Markup.button.callback("✅ Завершить", `status_${orderId}_done`),
      ],
      [
        Markup.button.callback("❌ Отменить", `status_${orderId}_cancel`),
        Markup.button.callback("💰 Расход", `expense_${orderId}`),
      ],
    ]),
};

// =============================================================================
// 🎮 CONTROLLER IMPLEMENTATION
// =============================================================================

export const AdminHandler = {
  /**
   * ===========================================================================
   * 1. 🚦 ГЛАВНОЕ МЕНЮ И РОУТИНГ
   * ===========================================================================
   */

  /**
   * Точка входа в админку.
   */
  async showAdminMenu(ctx) {
    try {
      const userId = ctx.from.id;
      const role = await UserService.getUserRole(userId);

      // Проверка прав (Middleware level check)
      if (![ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER].includes(role)) {
        return ctx.reply(
          "⛔ <b>Доступ запрещен.</b>\nЭта секция только для персонала.",
          { parse_mode: "HTML" },
        );
      }

      const title =
        role === ROLES.OWNER
          ? "👑 ЦЕНТР УПРАВЛЕНИЯ (OWNER)"
          : "💼 ПАНЕЛЬ МЕНЕДЖЕРА";

      await ctx.replyWithHTML(
        `<b>${title}</b>\n` +
          `Система работает в штатном режиме.\n` +
          `Выберите раздел:`,
        AdminKeyboards.mainMenu(role),
      );
    } catch (e) {
      console.error("[AdminHandler] Menu Error:", e);
    }
  },

  /**
   * Роутер текстовых сообщений Админки.
   */
  async handleMessage(ctx) {
    const text = ctx.message.text;
    const userId = ctx.from.id;

    // 1. Проверяем права перед выполнением любой команды
    const role = await UserService.getUserRole(userId);
    if (![ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER].includes(role)) return;

    // 2. Маршрутизация
    switch (text) {
      case BUTTONS.DASHBOARD:
        return this.showDashboard(ctx);
      case BUTTONS.ORDERS:
        return this.showOrdersInstruction(ctx);
      case BUTTONS.SETTINGS:
        return this.showSettingsInstruction(ctx);
      case BUTTONS.STAFF:
        return this.showStaffInstruction(ctx);

      // Owner Only Routes
      case BUTTONS.SQL_CONSOLE:
        return role === ROLES.OWNER
          ? this.showSQLInstruction(ctx)
          : ctx.reply("⛔ Доступно только Владельцу.");
      case BUTTONS.BACKUP:
        return role === ROLES.OWNER
          ? this.processBackup(ctx)
          : ctx.reply("⛔ Доступно только Владельцу.");

      case BUTTONS.BACK:
        return ctx.reply(
          "Выход в главное меню.",
          Markup.keyboard([
            ["🚀 Рассчитать стоимость"],
            ["📂 Мои заявки", "💰 Прайс-лист"],
            ["📞 Контакты", "ℹ️ Как мы работаем"],
            ["👑 Админ-панель"],
          ]).resize(),
        );

      default:
        // Если это не команда меню, возможно это контекстная команда (например SQL)
        if (text.startsWith("/sql") && role === ROLES.OWNER)
          return this.processSQL(ctx);
      // return ctx.reply("⚠️ Используйте кнопки меню.");
    }
  },

  /**
   * ===========================================================================
   * 2. 💰 ФИНАНСОВЫЙ ДАШБОРД (P&L)
   * ===========================================================================
   */

  async showDashboard(ctx) {
    const msg = await ctx.reply("⏳ Агрегация финансовых данных...");
    try {
      // Получаем сводку через UserService (он там дергает 3 запроса параллельно)
      // Или пишем прямой SQL для детального P&L
      const res = await db.query(`
          SELECT 
            COUNT(*) as total_orders,
            SUM(CASE WHEN status = 'done' THEN total_price ELSE 0 END) as gross_revenue,
            SUM(CASE WHEN status = 'done' THEN (details->'total'->>'material')::numeric ELSE 0 END) as mat_cost
          FROM orders
      `);

      const data = res.rows[0];
      const revenue = parseFloat(data.gross_revenue || 0);
      const materials = parseFloat(data.mat_cost || 0); // Это примерная себестоимость из сметы
      const profit = revenue - materials; // Грязная прибыль

      const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

      const report =
        `📊 <b>ФИНАНСОВЫЙ ОТЧЕТ (P&L)</b>\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `📦 <b>Всего заказов:</b> ${data.total_orders}\n` +
        `💰 <b>Оборот (Выручка):</b> ${fmt(revenue)} ₸\n` +
        `📉 <b>Материалы (Est.):</b> ${fmt(materials)} ₸\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `💎 <b>ГРЯЗНАЯ ПРИБЫЛЬ: ${fmt(profit)} ₸</b>\n` +
        `<i>* Данные основаны на статусе 'done'.</i>`;

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        null,
        report,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Ошибка расчета P&L.");
    }
  },

  /**
   * ===========================================================================
   * 3. 👨‍💻 SQL ТЕРМИНАЛ (OWNER ONLY)
   * ===========================================================================
   */

  async showSQLInstruction(ctx) {
    await ctx.replyWithHTML(
      `👨‍💻 <b>SQL КОНСОЛЬ (Direct Access)</b>\n\n` +
        `Позволяет выполнять произвольные запросы к базе данных.\n` +
        `⚠️ <b>ВНИМАНИЕ:</b> Вы имеете полные права. ` +
        `Команды <code>DROP</code>, <code>DELETE</code>, <code>TRUNCATE</code> необратимы!\n\n` +
        `📝 <b>Синтаксис:</b>\n` +
        `<code>/sql SELECT * FROM users LIMIT 5</code>\n` +
        `<code>/sql UPDATE users SET role='admin' WHERE telegram_id=123</code>`,
    );
  },

  async processSQL(ctx) {
    // 1. Парсинг
    const queryText = ctx.message.text.replace(/^\/sql\s+/, "").trim();
    if (!queryText)
      return ctx.reply("⚠️ Введите SQL запрос после команды /sql");

    // 2. Логирование безопасности
    console.warn(`[SECURITY] SQL Executed by ${ctx.from.id}: ${queryText}`);

    const start = Date.now();
    try {
      // 3. Выполнение
      const res = await db.query(queryText);
      const duration = Date.now() - start;

      // 4. Форматирование результата
      let message = `✅ <b>SQL SUCCESS</b> (${duration}ms)\n`;
      message += `Affected Rows: ${res.rowCount}\n\n`;

      if (res.command === "SELECT" && res.rows.length > 0) {
        const json = JSON.stringify(res.rows, null, 2);

        // Если ответ слишком большой для Телеграма (4096 символов)
        if (json.length > 3500) {
          const buffer = Buffer.from(json, "utf-8");
          await ctx.replyWithDocument({
            source: buffer,
            filename: `sql_result_${Date.now()}.json`,
          });
          return;
        } else {
          message += `<pre>${json}</pre>`;
        }
      } else if (res.rows.length === 0 && res.command === "SELECT") {
        message += `<i>(Пустой результат)</i>`;
      }

      await ctx.replyWithHTML(message);
    } catch (e) {
      await ctx.replyWithHTML(`❌ <b>SQL ERROR</b>\n<pre>${e.message}</pre>`);
    }
  },

  /**
   * ===========================================================================
   * 4. 💾 БЭКАП СИСТЕМЫ (OWNER ONLY)
   * ===========================================================================
   */

  async processBackup(ctx) {
    try {
      await ctx.reply("💾 Создаю дамп базы данных...");

      // В реальном проекте тут можно использовать pg_dump через child_process
      // Но в рамках Node.js драйвера мы можем выгрузить основные таблицы в JSON

      const tables = ["users", "orders", "settings"];
      const dump = {};

      for (const table of tables) {
        const res = await db.query(`SELECT * FROM ${table}`);
        dump[table] = res.rows;
      }

      const json = JSON.stringify(dump, null, 2);
      const buffer = Buffer.from(json, "utf-8");

      const date = new Date().toISOString().slice(0, 10);
      await ctx.replyWithDocument(
        {
          source: buffer,
          filename: `backup_proelectric_${date}.json`,
        },
        {
          caption: `✅ <b>Полный бэкап системы</b>\nТаблицы: ${tables.join(", ")}`,
        },
      );
    } catch (e) {
      ctx.reply(`❌ Ошибка бэкапа: ${e.message}`);
    }
  },

  /**
   * ===========================================================================
   * 5. 👥 УПРАВЛЕНИЕ ПЕРСОНАЛОМ
   * ===========================================================================
   */

  async showStaffInstruction(ctx) {
    await ctx.replyWithHTML(
      `👥 <b>УПРАВЛЕНИЕ КОМАНДОЙ</b>\n\n` +
        `Чтобы назначить роль, используйте команду:\n` +
        `<code>/setrole ID ROLE</code>\n\n` +
        `<b>Доступные роли:</b>\n` +
        `🔹 <code>admin</code> — Полный доступ (кроме SQL)\n` +
        `🔹 <code>manager</code> — Управление заказами\n` +
        `🔹 <code>user</code> — Снять права (обычный клиент)\n` +
        `🚫 <code>banned</code> — Заблокировать доступ\n\n` +
        `<i>Пример: /setrole 123456789 manager</i>`,
    );
  },

  // Этот метод должен вызываться из server.js через bot.hears(/^\/setrole/...)
  async processSetRole(ctx) {
    // Проверка на Владельца или Админа
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    const parts = ctx.message.text.split(" "); // /setrole 123 admin
    if (parts.length < 3) return ctx.reply("⚠️ Формат: /setrole ID ROLE");

    const targetId = parts[1];
    const newRole = parts[2].toLowerCase();

    try {
      const result = await UserService.changeUserRole(
        ctx.from.id,
        targetId,
        newRole,
      );
      await ctx.reply(
        `✅ <b>Успешно!</b>\nПользователь ${targetId} теперь <b>${newRole.toUpperCase()}</b>.`,
      );

      // Уведомляем жертву/счастливчика
      ctx.telegram
        .sendMessage(
          targetId,
          `⚡️ Ваши права в системе обновлены: <b>${newRole.toUpperCase()}</b>`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});
    } catch (e) {
      ctx.reply(`❌ Ошибка: ${e.message}`);
    }
  },

  /**
   * ===========================================================================
   * 6. ⚙️ НАСТРОЙКИ (ЦЕНООБРАЗОВАНИЕ)
   * ===========================================================================
   */

  async showSettingsInstruction(ctx) {
    await ctx.replyWithHTML(
      `⚙️ <b>НАСТРОЙКИ ЦЕН</b>\n` +
        `Изменение цен влияет на ВСЕ новые расчеты мгновенно.\n\n` +
        `Команда: <code>/setprice KEY VALUE</code>\n\n` +
        `<b>Основные ключи:</b>\n` +
        `🔸 <code>price_strobe_concrete</code> (Штроба бетон)\n` +
        `🔸 <code>price_cable</code> (Кабель м.п.)\n` +
        `🔸 <code>price_shield_module</code> (Щит, модуль)\n` +
        `🔸 <code>material_factor</code> (Коэф. материалов, напр 0.45)\n\n` +
        `<i>Пример: /setprice price_cable 400</i>`,
    );
  },

  // Вызывается из server.js
  async processSetPrice(ctx) {
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    const parts = ctx.message.text.split(" ");
    if (parts.length < 3) return ctx.reply("⚠️ Формат: /setprice KEY VALUE");

    const key = parts[1];
    const value = parts[2];

    try {
      // Прямой SQL UPSERT в таблицу settings
      await db.query(
        `
        INSERT INTO settings (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
      `,
        [key, value],
      );

      await ctx.reply(`✅ Цена <b>${key}</b> установлена: <b>${value}</b>`, {
        parse_mode: "HTML",
      });
    } catch (e) {
      ctx.reply("❌ Ошибка записи в БД.");
    }
  },

  /**
   * ===========================================================================
   * 7. 📦 УПРАВЛЕНИЕ ЗАКАЗАМИ
   * ===========================================================================
   */

  async showOrdersInstruction(ctx) {
    await ctx.replyWithHTML(
      `📦 <b>УПРАВЛЕНИЕ ЗАКАЗАМИ</b>\n` +
        `Напишите <code>/order ID</code> чтобы открыть меню управления заказом.\n\n` +
        `Или используйте поиск: <code>/findorder Имя</code>`,
    );
  },

  // Обработка инлайн-кнопок статусов (из server.js bot.action)
  async handleOrderStatusChange(ctx, orderId, newStatus) {
    try {
      await OrderService.updateOrderStatus(orderId, newStatus);
      await ctx.answerCbQuery(`Статус изменен на ${newStatus}`);
      await ctx.editMessageText(
        `✅ Заказ #${orderId} переведен в статус: <b>${newStatus.toUpperCase()}</b>`,
        { parse_mode: "HTML" },
      );

      // Можно уведомить клиента здесь
    } catch (e) {
      await ctx.answerCbQuery("Ошибка обновления");
    }
  },
};

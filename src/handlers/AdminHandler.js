/**
 * @file src/handlers/AdminHandler.js
 * @description Контроллер панели администратора (Presentation Layer).
 * Реализует полный набор инструментов для управления бизнесом через Telegram.
 * @module AdminHandler
 * @version 5.0.0 (Senior Edition)
 */

import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";
import * as db from "../database/index.js"; // Прямой доступ для бэкапов и настроек
import { MESSAGES, KEYBOARDS, BUTTONS, ROLES, DB_KEYS } from "../constants.js";

// =============================================================================
// 🛠 ВСПОМОГАТЕЛЬНЫЕ УТИЛИТЫ (HELPERS)
// =============================================================================

/**
 * Асинхронная пауза.
 * Используется в рассылках, чтобы не превысить лимиты Telegram API (30 msg/sec).
 * @param {number} ms - Миллисекунды
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Форматирование даты.
 * @returns {string} Пример: "16.02.2026 14:30"
 */
const nowStr = () => new Date().toLocaleString("ru-RU");

// =============================================================================
// 🎮 ГЛАВНЫЙ КОНТРОЛЛЕР (ADMIN HANDLER)
// =============================================================================

export const AdminHandler = {
  /**
   * 🚦 Главный маршрутизатор (Router).
   * Перехватывает сообщения от UserHandler, если они относятся к админке.
   *
   * @param {Object} ctx - Контекст Telegraf
   */
  async handleMessage(ctx) {
    const text = ctx.message.text;
    const userId = ctx.from.id;

    // 1. SECURITY CHECK (Middleware Pattern)
    // Проверяем права при каждом действии. Даже если кнопка осталась в чате,
    // разжалованный админ не сможет ей воспользоваться.
    const isAdmin = await UserService.isAdmin(userId);
    if (!isAdmin) {
      console.warn(`[Security] Unauthorized admin access attempt by ${userId}`);
      return ctx.reply("⛔ <b>Доступ запрещен.</b>\nУ вас недостаточно прав.", {
        parse_mode: "HTML",
      });
    }

    try {
      // Показываем статус "печатает...", чтобы админ видел реакцию бота
      await ctx.sendChatAction("typing");

      // 2. ОБРАБОТКА КНОПОК МЕНЮ (Menu Handlers)
      switch (text) {
        case BUTTONS.ADMIN_PANEL:
          return this.showAdminMenu(ctx);

        case BUTTONS.ADMIN_STATS:
          return this.showDashboard(ctx);

        case BUTTONS.ADMIN_SETTINGS:
          return this.showSettingsInstruction(ctx);

        case BUTTONS.ADMIN_STAFF:
          return this.showStaffInstruction(ctx);

        case BUTTONS.BACK:
          // Возврат в пользовательское меню (обрабатывается в UserHandler,
          // но здесь можно добавить логику выхода из админки)
          return ctx.reply(
            "Вы вышли из панели администратора.",
            KEYBOARDS.MAIN_MENU("admin"), // Возвращаем меню с правами админа
          );
      }

      // 3. ОБРАБОТКА КОМАНД (Command Handlers)
      if (text.startsWith("/setprice")) return this.processSetPrice(ctx);
      if (text.startsWith("/setrole")) return this.processSetRole(ctx);
      if (text.startsWith("/broadcast")) return this.processBroadcast(ctx);
      if (text.startsWith("/backup")) return this.processBackup(ctx);
      if (text.startsWith("/finduser")) return this.processFindUser(ctx);
      if (text.startsWith("/findorder")) return this.processFindOrder(ctx);

      // 4. FALLBACK (Если команда не распознана, но мы в админке)
      await ctx.reply(
        "⚙️ <b>Панель Администратора</b>\nВыберите действие в меню или введите команду.",
        KEYBOARDS.ADMIN_MENU,
      );
    } catch (error) {
      console.error("[AdminHandler] Critical Error:", error);
      await ctx.reply(
        "⚠️ <b>Внутренняя ошибка сервера.</b>\nМы уже записали лог и работаем над испровлением.",
        { parse_mode: "HTML" },
      );
    }
  },

  // ===========================================================================
  // 📊 БЛОК: СТАТИСТИКА И ДАШБОРД
  // ===========================================================================

  /**
   * 🏠 Отображение главного меню админа.
   */
  async showAdminMenu(ctx) {
    await ctx.reply(MESSAGES.ADMIN.PANEL_WELCOME, KEYBOARDS.ADMIN_MENU);
  },

  /**
   * 📈 Генерация и показ бизнес-дашборда.
   * Собирает агрегированные данные из UserService.
   */
  async showDashboard(ctx) {
    const loadingMsg = await ctx.reply("⏳ <i>Собираю данные...</i>", {
      parse_mode: "HTML",
    });

    try {
      const stats = await UserService.getDashboardStats();

      // Формирование отчета
      const report =
        `📊 <b>БИЗНЕС-ДАШБОРД</b>\n` +
        `➖➖➖➖➖➖➖➖➖\n` +
        `👥 <b>Аудитория:</b>\n` +
        `• Всего пользователей: <b>${stats.totalUsers}</b>\n` +
        `• Активных (24ч): <b>${stats.activeUsers24h}</b>\n\n` +
        `💰 <b>Финансы (Выполненные):</b>\n` +
        `• Общая выручка: <b>${stats.totalRevenue.toLocaleString()} ₸</b>\n\n` +
        `<i>Для детального отчета по заказам используйте CRM.</i>\n` +
        `➖➖➖➖➖➖➖➖➖\n` +
        `🕒 Обновлено: ${nowStr()}`;

      // Удаляем сообщение "Загрузка" и отправляем отчет
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
      await ctx.replyWithHTML(report);
    } catch (error) {
      console.error("Dashboard Error:", error);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        "❌ Не удалось загрузить статистику.",
      );
    }
  },

  // ===========================================================================
  // 🛠 БЛОК: НАСТРОЙКИ СИСТЕМЫ (SETTINGS)
  // ===========================================================================

  /**
   * ℹ️ Инструкция по изменению цен.
   * Динамически генерирует список доступных ключей из DB_KEYS.
   */
  async showSettingsInstruction(ctx) {
    // Превращаем объект ключей в список для копирования
    const keysList = Object.values(DB_KEYS)
      .map((k) => `<code>${k}</code>`)
      .join("\n");

    const msg =
      `🛠 <b>Управление тарифами (Live Config)</b>\n\n` +
      `Позволяет менять цены "на лету" без перезагрузки бота.\n\n` +
      `<b>Синтаксис:</b>\n` +
      `<code>/setprice КЛЮЧ ЦЕНА</code>\n\n` +
      `<b>Пример:</b>\n` +
      `<code>/setprice price_cable 450</code>\n\n` +
      `🔑 <b>Доступные ключи:</b>\n${keysList}\n\n` +
      `💾 <i>Для создания резервной копии настроек введите /backup</i>`;

    await ctx.replyWithHTML(msg);
  },

  /**
   * 💵 Команда: Изменение настройки (/setprice).
   */
  async processSetPrice(ctx) {
    const parts = ctx.message.text.split(" ");

    // Валидация аргументов
    if (parts.length !== 3) {
      return ctx.reply(
        "⚠️ <b>Ошибка формата!</b>\nИспользуйте: <code>/setprice key value</code>",
        { parse_mode: "HTML" },
      );
    }

    const key = parts[1];
    const value = parseInt(parts[2]);

    // Валидация ключа (защита от опечаток и мусора в БД)
    if (!Object.values(DB_KEYS).includes(key)) {
      return ctx.reply(
        `❌ <b>Неверный ключ.</b>\nКлюч <code>${key}</code> не найден в системе.`,
        { parse_mode: "HTML" },
      );
    }

    // Валидация значения
    if (isNaN(value)) {
      return ctx.reply("❌ <b>Ошибка значения.</b>\nЦена должна быть числом.", {
        parse_mode: "HTML",
      });
    }

    try {
      // UPSERT запрос (Вставка или Обновление)
      await db.query(
        "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
        [key, value.toString()],
      );

      await ctx.reply(
        `✅ <b>Настройка обновлена!</b>\n\n` +
          `🔑 Параметр: <code>${key}</code>\n` +
          `💰 Новое значение: <b>${value}</b>\n\n` +
          `<i>Изменения вступили в силу моментально.</i>`,
        { parse_mode: "HTML" },
      );
    } catch (error) {
      await ctx.reply(`❌ Ошибка базы данных: ${error.message}`);
    }
  },

  /**
   * 💾 Команда: Создание и скачивание бэкапа (/backup).
   * Выгружает таблицу settings в JSON файл.
   */
  async processBackup(ctx) {
    await ctx.sendChatAction("upload_document");

    try {
      const res = await db.query("SELECT * FROM settings ORDER BY key ASC");
      const jsonData = JSON.stringify(res.rows, null, 2);
      const filename = `proelectric_config_${new Date().toISOString().split("T")[0]}.json`;

      await ctx.replyWithDocument(
        {
          source: Buffer.from(jsonData, "utf-8"),
          filename: filename,
        },
        {
          caption: `🔒 <b>Резервная копия настроек</b>\n📅 Дата: ${nowStr()}\n📦 Параметров: ${res.rowCount}`,
          parse_mode: "HTML",
        },
      );
    } catch (error) {
      await ctx.reply("❌ Не удалось создать резервную копию.");
    }
  },

  // ===========================================================================
  // 👥 БЛОК: УПРАВЛЕНИЕ ПЕРСОНАЛОМ (HR)
  // ===========================================================================

  /**
   * ℹ️ Инструкция по ролям.
   */
  async showStaffInstruction(ctx) {
    const msg =
      `👮‍♂️ <b>Управление персоналом (RBAC)</b>\n\n` +
      `<b>Синтаксис:</b>\n` +
      `<code>/setrole ID РОЛЬ</code>\n\n` +
      `<b>Доступные роли:</b>\n` +
      `👑 <code>admin</code> — Администратор (Управление заказами и персоналом)\n` +
      `👷 <code>manager</code> — Менеджер (Только свои заказы)\n` +
      `👤 <code>user</code> — Клиент (Доступ к калькулятору)\n\n` +
      `<b>Пример:</b>\n` +
      `<code>/setrole 123456789 manager</code>\n\n` +
      `🔍 <i>Найти пользователя: /finduser имя</i>`;

    await ctx.replyWithHTML(msg);
  },

  /**
   * 👑 Команда: Назначение роли (/setrole).
   */
  async processSetRole(ctx) {
    const parts = ctx.message.text.split(" ");

    if (parts.length !== 3) {
      return ctx.reply(
        "⚠️ <b>Ошибка формата.</b>\nПример: <code>/setrole 123456789 manager</code>",
        { parse_mode: "HTML" },
      );
    }

    const targetId = parseInt(parts[1]);
    const newRole = parts[2].toLowerCase();

    if (isNaN(targetId)) {
      return ctx.reply("❌ ID пользователя должен быть числом.");
    }

    try {
      // Вызываем Service Layer для выполнения бизнес-логики (с проверками прав)
      const result = await UserService.changeUserRole(
        ctx.from.id,
        targetId,
        newRole,
      );

      await ctx.reply(
        `✅ <b>Права доступа изменены!</b>\n\n` +
          `👤 Пользователь ID: <code>${targetId}</code>\n` +
          `🔰 Старая роль: <s>${result.oldRole?.toUpperCase() || "N/A"}</s>\n` +
          `🔑 Новая роль: <b>${result.newRole.toUpperCase()}</b>`,
        { parse_mode: "HTML" },
      );

      // Уведомляем пользователя (Friendly UI)
      try {
        await ctx.telegram.sendMessage(
          targetId,
          `🎉 <b>Обновление прав доступа!</b>\n\nВам назначена роль: <b>${newRole.toUpperCase()}</b>.\nДля обновления интерфейса введите /start`,
          { parse_mode: "HTML" },
        );
      } catch (e) {
        /* Игнорируем, если бот заблокирован пользователем */
      }
    } catch (error) {
      // UserService выбросит читаемую ошибку (например, "Нельзя разжаловать Владельца")
      await ctx.reply(`❌ <b>Ошибка:</b> ${error.message}`, {
        parse_mode: "HTML",
      });
    }
  },

  /**
   * 🔍 Команда: Поиск пользователя (/finduser).
   */
  async processFindUser(ctx) {
    const query = ctx.message.text.replace("/finduser", "").trim();
    if (!query || query.length < 2) {
      return ctx.reply("⚠️ Введите имя, логин или телефон (мин. 2 символа).");
    }

    const users = await UserService.findUsers(query);

    if (users.length === 0) {
      return ctx.reply("🤷‍♂️ Пользователи не найдены.");
    }

    let msg = `🔍 <b>Результаты поиска (${users.length}):</b>\n\n`;
    users.forEach((u) => {
      msg += `👤 <b>${u.first_name}</b> (@${u.username || "нет"})\n`;
      msg += `🆔 <code>${u.telegram_id}</code> | 🔰 ${u.role}\n`;
      msg += `📱 ${u.phone || "Нет телефона"}\n`;
      msg += `➖➖➖➖➖➖➖➖\n`;
    });

    await ctx.replyWithHTML(msg);
  },

  // ===========================================================================
  // 📢 БЛОК: КОММУНИКАЦИЯ (BROADCAST)
  // ===========================================================================

  /**
   * 📢 Команда: Массовая рассылка (/broadcast).
   */
  async processBroadcast(ctx) {
    const text = ctx.message.text.replace("/broadcast", "").trim();

    if (!text) {
      return ctx.reply(
        "⚠️ <b>Ошибка.</b> Введите текст сообщения.\nПример: <code>/broadcast Скидки сегодня!</code>",
        { parse_mode: "HTML" },
      );
    }

    const confirmMsg = await ctx.reply("⏳ <i>Подготовка к рассылке...</i>", {
      parse_mode: "HTML",
    });

    // Получаем всех пользователей
    // (В будущем можно добавить аргумент для фильтра: /broadcast admins Text)
    const targetIds = await UserService.getUsersForBroadcast("all");

    let success = 0;
    let blocked = 0;
    let failed = 0;

    // Итеративная отправка с задержкой (Rate Limiting)
    for (const userId of targetIds) {
      try {
        await ctx.telegram.sendMessage(
          userId,
          `📢 <b>Новости ProElectric</b>\n\n${text}`,
          { parse_mode: "HTML" },
        );
        success++;
      } catch (e) {
        if (e.code === 403) {
          blocked++; // Пользователь заблокировал бота
        } else {
          failed++; // Другая ошибка
        }
      }
      // Пауза 35мс (~28 сообщений в секунду), чтобы быть вежливым к API Telegram
      await sleep(35);
    }

    // Финальный отчет
    const report =
      `✅ <b>Рассылка завершена!</b>\n\n` +
      `📨 Отправлено успешно: <b>${success}</b>\n` +
      `🚫 Бот заблокирован: <b>${blocked}</b>\n` +
      `⚠️ Ошибки доставки: <b>${failed}</b>\n` +
      `👥 Всего получателей: <b>${targetIds.length}</b>`;

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      confirmMsg.message_id,
      null,
      report,
      { parse_mode: "HTML" },
    );
  },

  // ===========================================================================
  // 📦 БЛОК: ЗАКАЗЫ (ORDERS)
  // ===========================================================================

  /**
   * 🔍 Команда: Поиск заказа (/findorder ID).
   */
  async processFindOrder(ctx) {
    const parts = ctx.message.text.split(" ");
    const orderId = parseInt(parts[1]);

    if (!orderId || isNaN(orderId)) {
      return ctx.reply(
        "⚠️ введите ID заказа.\nПример: <code>/findorder 5</code>",
        {
          parse_mode: "HTML",
        },
      );
    }

    try {
      const order = await OrderService.getOrderById(orderId);
      if (!order) {
        return ctx.reply("❌ Заказ не найден.");
      }

      // Получаем инфо о клиенте
      const user = await UserService.getUserProfile(order.user_id);
      const userName = user ? user.first_name : "Неизвестный";
      const userPhone = user ? user.phone : "Нет";

      const msg =
        `📦 <b>Заказ #${order.id}</b>\n` +
        `👤 Клиент: ${userName} (${userPhone})\n` +
        `💰 Сумма: <b>${parseInt(order.total_price).toLocaleString()} ₸</b>\n` +
        `📅 Дата: ${new Date(order.created_at).toLocaleString()}\n` +
        `📊 Статус: <code>${order.status}</code>\n\n` +
        `<i>Для изменения статуса используйте Web-админку.</i>`;

      await ctx.replyWithHTML(msg);
    } catch (e) {
      ctx.reply("Ошибка поиска заказа.");
    }
  },
};

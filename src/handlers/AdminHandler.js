/**
 * @file src/handlers/AdminHandler.js
 * @description Обработчик административных функций.
 * Реализует логику управления бизнесом, персоналом и настройками.
 * Полностью отделен от текстового контента (использует constants.js).
 * @module AdminHandler
 * @version 4.5.0 (Senior Production Ready)
 */

import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";
import * as db from "../database/repository.js";
import { MESSAGES, KEYBOARDS, ROLES, DB_KEYS } from "../constants.js";

export const AdminHandler = {
  /**
   * 🚪 Вход в панель администратора.
   * Проверяет права доступа (RBAC) перед отображением меню.
   * @param {Object} ctx - Контекст Telegraf
   */
  async enterAdminPanel(ctx) {
    const userId = ctx.from.id;

    // 1. Строгая проверка прав доступа
    const isAdmin = await UserService.isAdmin(userId);

    if (!isAdmin) {
      return ctx.replyWithMarkdown(MESSAGES.ADMIN.ACCESS_DENIED);
    }

    // 2. Отображаем меню управления
    await ctx.replyWithMarkdown(
      MESSAGES.ADMIN.PANEL_WELCOME,
      KEYBOARDS.ADMIN_MENU,
    );
  },

  /**
   * 📊 Генерация и отображение статистики бизнеса.
   * Агрегирует данные из базы (OrderService) и показывает отчет.
   */
  async showStatistics(ctx) {
    // Повторная верификация прав (Security Layer)
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    // Уведомление о начале долгой операции
    await ctx.replyWithMarkdown(MESSAGES.ADMIN.STATS_LOADING);

    try {
      // Parallel Execution: Запускаем независимые запросы параллельно для ускорения
      const [stats, allUsers] = await Promise.all([
        OrderService.getAdminStats(),
        UserService.getAllUsers(1, 0), // Оптимизация: получаем список, чтобы узнать длину
      ]);

      const usersCount = allUsers.length;

      // Формируем отчет, используя шаблон из констант
      const reportText = MESSAGES.ADMIN.statsReport(
        usersCount,
        stats.newOrdersCount,
        stats.potentialRevenue.toLocaleString(),
        stats.totalOrdersChecked,
      );

      await ctx.replyWithMarkdown(reportText);
    } catch (error) {
      console.error("[AdminHandler] Stats Error:", error);
      await ctx.replyWithMarkdown(MESSAGES.ADMIN.STATS_ERROR);
    }
  },

  /**
   * 👥 Повышение прав пользователя (Promote User).
   * Позволяет назначать администраторов и менеджеров.
   * Команда: /setrole <ID> <ROLE>
   */
  async promoteUser(ctx) {
    // Получаем профиль инициатора запроса
    const initiatorUser = await db.getUserByTelegramId(ctx.from.id);

    // Валидация: Только Владелец (Owner) может менять роли
    if (initiatorUser.role !== ROLES.OWNER) {
      return ctx.replyWithMarkdown(MESSAGES.ADMIN.ONLY_OWNER_ACCESS);
    }

    const args = ctx.message.text.split(" ");

    // Валидация формата команды
    if (args.length !== 3) {
      return ctx.replyWithMarkdown(MESSAGES.ADMIN.ROLE_FORMAT_ERROR);
    }

    const targetId = parseInt(args[1]);
    const newRole = args[2].toLowerCase();

    try {
      // Вызываем сервис для обновления роли в БД
      const updatedUser = await UserService.changeUserRole(
        ctx.from.id,
        targetId,
        newRole,
      );

      // 1. Уведомляем админа об успехе
      await ctx.replyWithMarkdown(
        MESSAGES.ADMIN.roleUpdateSuccess(
          updatedUser.first_name,
          targetId,
          newRole,
        ),
      );

      // 2. Уведомляем целевого пользователя (если возможно)
      try {
        await ctx.telegram.sendMessage(
          targetId,
          MESSAGES.ADMIN.roleNotificationUser(newRole),
        );
      } catch (e) {
        // Игнорируем ошибку доставки (пользователь мог заблокировать бота)
        console.warn(`[AdminHandler] Не удалось уведомить user ${targetId}`);
      }
    } catch (error) {
      await ctx.replyWithMarkdown(
        MESSAGES.ADMIN.roleUpdateError(error.message),
      );
    }
  },

  /**
   * 🏷️ Динамическое обновление цен (Hot Config Update).
   * Позволяет менять бизнес-параметры без деплоя.
   * Команда: /setprice <KEY> <VALUE>
   */
  async updatePriceSetting(ctx) {
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    const args = ctx.message.text.split(" ");

    // Если аргументов недостаточно, показываем справку
    if (args.length !== 3) {
      // Динамически формируем список ключей для подсказки
      const keysList = Object.values(DB_KEYS)
        .map((k) => `\`${k}\``)
        .join(", ");

      return ctx.replyWithMarkdown(MESSAGES.ADMIN.PRICE_HELP(keysList));
    }

    const key = args[1];
    const value = args[2];

    try {
      // Сохраняем настройку в БД
      await db.saveSetting(key, value);

      await ctx.replyWithMarkdown(
        MESSAGES.ADMIN.priceUpdateSuccess(key, value),
      );
    } catch (error) {
      console.error("[AdminHandler] Price Update Error:", error);
      await ctx.replyWithMarkdown(MESSAGES.ADMIN.priceUpdateError);
    }
  },

  /**
   * 📢 Система массовой рассылки (Broadcast).
   * Отправляет сообщение всем пользователям из базы.
   * Команда: /broadcast <TEXT>
   */
  async broadcastMessage(ctx) {
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    const messageParts = ctx.message.text.split(" ");

    // Проверка на пустой текст
    if (messageParts.length < 2) {
      return ctx.replyWithMarkdown(MESSAGES.ADMIN.BROADCAST_HELP);
    }

    // Собираем текст сообщения (убираем команду)
    const textToSend = messageParts.slice(1).join(" ");

    await ctx.replyWithMarkdown(MESSAGES.ADMIN.BROADCAST_START);

    // Получаем список всех пользователей (Batch Processing)
    // При большом количестве (>10к) здесь следует использовать курсор БД
    const allUsers = await UserService.getAllUsers(2000, 0);

    let successCount = 0;
    let failCount = 0;

    const formattedMessage = MESSAGES.ADMIN.broadcastHeader(textToSend);

    // Итерация по пользователям
    for (const user of allUsers) {
      try {
        await ctx.telegram.sendMessage(user.telegram_id, formattedMessage, {
          parse_mode: "Markdown",
        });
        successCount++;

        // Anti-Flood защита (пауза 30мс)
        await new Promise((resolve) => setTimeout(resolve, 30));
      } catch (e) {
        failCount++; // Ошибка доставки (юзер заблокировал бота)
      }
    }

    // Финальный отчет администратору
    await ctx.replyWithMarkdown(
      MESSAGES.ADMIN.broadcastReport(successCount, failCount),
    );
  },

  /**
   * 💾 Резервное копирование настроек (Backup).
   * Выгружает текущие настройки БД в JSON-файл.
   */
  async downloadDatabase(ctx) {
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    try {
      const settings = await db.getSettings();
      const jsonString = JSON.stringify(settings, null, 2);

      const dateStr = new Date().toISOString().split("T")[0];
      const fileName = MESSAGES.ADMIN.BACKUP_FILENAME(dateStr);

      await ctx.replyWithDocument({
        source: Buffer.from(jsonString),
        filename: fileName,
      });
    } catch (error) {
      console.error("[AdminHandler] Backup Error:", error);
      await ctx.replyWithMarkdown(MESSAGES.ADMIN.BACKUP_ERROR);
    }
  },
};

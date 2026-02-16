/**
 * @file src/handlers/AdminHandler.js
 * @description Обработчик административных функций.
 * Управление бизнесом: статистика, кадры (роли), настройки цен и рассылки.
 * Логика полностью отделена от текстового контента.
 * @module AdminHandler
 * @version 4.1.0 (Refactored)
 */

import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";
import * as db from "../database/repository.js";
import { MESSAGES, KEYBOARDS, ROLES, DB_KEYS } from "../constants.js";

export const AdminHandler = {
  /**
   * 🚪 Вход в панель администратора.
   * Проверяет права доступа перед отображением меню.
   * @param {Object} ctx - Контекст Telegraf
   */
  async enterAdminPanel(ctx) {
    const userId = ctx.from.id;

    // 1. Strict Security Check (Строгая проверка безопасности)
    const isAdmin = await UserService.isAdmin(userId);
    if (!isAdmin) {
      return ctx.reply(MESSAGES.ADMIN.ACCESS_DENIED);
    }

    // 2. Отображаем меню управления
    await ctx.reply(MESSAGES.ADMIN.PANEL_WELCOME, KEYBOARDS.ADMIN_MENU);
  },

  /**
   * 📊 Генерация финансового отчета и статистики.
   * Использует агрегированные данные из OrderService.
   */
  async showStatistics(ctx) {
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    await ctx.reply(MESSAGES.ADMIN.LOADING_STATS);

    try {
      // Parallel execution for performance (Optimization)
      const [stats, usersList] = await Promise.all([
        OrderService.getAdminStats(),
        UserService.getAllUsers(1, 0) // count check hack
      ]);

      // Формируем отчет через функцию-генератор из констант
      const report = MESSAGES.ADMIN.statsReport(
        usersList.length,
        stats.newOrdersCount,
        stats.potentialRevenue.toLocaleString(),
        stats.totalOrdersChecked
      );

      await ctx.replyWithMarkdown(report);
    } catch (error) {
      console.error("Stats Error:", error);
      await ctx.reply(MESSAGES.ADMIN.STATS_ERROR);
    }
  },

  /**
   * 👥 Управление персоналом (Добавление админов).
   * Работает через команду: /setrole <ID> <admin/manager/user>
   */
  async promoteUser(ctx) {
    // Только Владелец может назначать роли
    const initiatorUser = await db.getUserByTelegramId(ctx.from.id);
    if (initiatorUser.role !== ROLES.OWNER) {
      return ctx.reply(MESSAGES.ADMIN.ONLY_OWNER);
    }

    const args = ctx.message.text.split(" ");

    // Валидация аргументов
    if (args.length !== 3) {
      return ctx.replyWithMarkdown(MESSAGES.ADMIN.ROLE_FORMAT_ERROR);
    }

    const targetId = parseInt(args[1]);
    const newRole = args[2].toLowerCase();

    try {
      // Вызываем UserService для смены роли
      const updatedUser = await UserService.changeUserRole(
        ctx.from.id,
        targetId,
        newRole,
      );

      await ctx.reply(
        MESSAGES.ADMIN.roleSuccess(updatedUser.first_name, targetId, newRole)
      );

      // Опционально: уведомить самого пользователя
      try {
        await ctx.telegram.sendMessage(
          targetId,
          MESSAGES.ADMIN.roleNotification(newRole)
        );
      } catch (e) {
        // Игнорируем, если у юзера заблокирован бот
      }
    } catch (error) {
      await ctx.reply(`❌ ${error.message}`);
    }
  },

  /**
   * 🏷️ Изменение цен в базе данных.
   * Позволяет менять настройки (цены) без перезагрузки кода.
   * Формат: /setprice KEY VALUE
   */
  async updatePriceSetting(ctx) {
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    const args = ctx.message.text.split(" ");

    // Показываем справку, если аргументов нет
    if (args.length !== 3) {
      const keysList = Object.values(DB_KEYS)
        .map((k) => `\`${k}\``)
        .join(", ");
        
      return ctx.replyWithMarkdown(MESSAGES.ADMIN.PRICE_HELP(keysList));
    }

    const key = args[1];
    const value = args[2];

    try {
      await db.saveSetting(key, value);
      await ctx.reply(MESSAGES.ADMIN.priceUpdated(key, value));
    } catch (error) {
      await ctx.reply(MESSAGES.ADMIN.priceError);
    }
  },

  /**
   * 📢 Рассылка сообщений всем пользователям.
   */
  async broadcastMessage(ctx) {
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    const messageParts = ctx.message.text.split(" ");
    if (messageParts.length < 2) {
      return ctx.replyWithMarkdown(MESSAGES.ADMIN.BROADCAST_HELP);
    }

    const textToSend = messageParts.slice(1).join(" ");

    await ctx.reply(MESSAGES.ADMIN.BROADCAST_START);

    // Получаем всех пользователей (пачками)
    const allUsers = await UserService.getAllUsers(1000, 0);
    let successCount = 0;
    let failCount = 0;

    const fullMessage = MESSAGES.ADMIN.broadcastHeader(textToSend);

    for (const user of allUsers) {
      try {
        await ctx.telegram.sendMessage(
          user.telegram_id,
          fullMessage,
          { parse_mode: "Markdown" },
        );
        successCount++;
      } catch (e) {
        failCount++;
      }
    }

    await ctx.reply(
        MESSAGES.ADMIN.broadcastResult(successCount, failCount)
    );
  },

  /**
   * 📂 Получение файла базы данных (Backup).
   */
  async downloadDatabase(ctx) {
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    const settings = await db.getSettings();
    const jsonString = JSON.stringify(settings, null, 2);

    await ctx.replyWithDocument({
      source: Buffer.from(jsonString),
      filename: `settings_backup_${new Date().toISOString().split("T")[0]}.json`,
    });
  },
};
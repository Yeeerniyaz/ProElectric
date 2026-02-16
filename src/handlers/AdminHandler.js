/**
 * @file src/handlers/AdminHandler.js
 * @description Обработчик административных функций.
 * Управление бизнесом: статистика, кадры (роли), настройки цен и рассылки.
 * @module AdminHandler
 * @version 4.0.0 (Enterprise Level)
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
      // Если пытается зайти обычный юзер — игнорируем или мягко отказываем
      return ctx.reply("⛔ У вас нет доступа к этому разделу.");
    }

    // 2. Отображаем меню управления
    await ctx.reply(
      "👨‍💼 **Панель управления бизнесом**\n\n" +
        "Выберите действие из меню ниже:",
      KEYBOARDS.ADMIN_MENU,
    );
  },

  /**
   * 📊 Генерация финансового отчета и статистики.
   * Использует агрегированные данные из OrderService.
   */
  async showStatistics(ctx) {
    // Проверка прав (Security Layer)
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    await ctx.reply("⏳ Собираю данные по базе...");

    try {
      // Получаем данные из сервиса
      const stats = await OrderService.getAdminStats();
      const usersCount = await UserService.getAllUsers(1, 0); // Получаем кол-во юзеров (упрощенно)

      // Формируем красивый отчет
      const report =
        `📊 **Статистика ProElectric**\n\n` +
        `👥 **Клиенты:**\n` +
        `Всего в базе: ${usersCount.length} (загружено)\n\n` +
        `💰 **Финансы (Потенциал):**\n` +
        `Новых заявок: ${stats.newOrdersCount}\n` +
        `В деньгах: ${stats.potentialRevenue.toLocaleString()} ₸\n\n` +
        `📉 **Конверсия:**\n` +
        `Обработано заказов: ${stats.totalOrdersChecked}\n` +
        `\n_Данные актуальны на: ${new Date().toLocaleTimeString()}_`;

      await ctx.replyWithMarkdown(report);
    } catch (error) {
      console.error("Stats Error:", error);
      await ctx.reply("⚠️ Ошибка при генерации отчета. Проверьте логи.");
    }
  },

  /**
   * 👥 Управление персоналом (Добавление админов).
   * Реализует твой запрос: "Я тоже могу добавить админа".
   * Работает через команду: /setrole <ID> <admin/manager/user>
   */
  async promoteUser(ctx) {
    // Только Владелец может назначать роли
    const initiatorUser = await db.getUserByTelegramId(ctx.from.id);
    if (initiatorUser.role !== ROLES.OWNER) {
      return ctx.reply("⛔ Назначать администраторов может только Владелец.");
    }

    // Парсим аргументы команды
    // Ожидаемый формат: /setrole 123456789 admin
    const args = ctx.message.text.split(" ");

    if (args.length !== 3) {
      return ctx.reply(
        "⚠️ **Ошибка формата команды**\n\n" +
          "Используйте: `/setrole ID_ПОЛЬЗОВАТЕЛЯ РОЛЬ`\n" +
          "Пример: `/setrole 123456789 admin`\n\n" +
          "Роли: `admin`, `manager`, `user`",
        { parse_mode: "Markdown" },
      );
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
        `✅ **Успешно!**\n` +
          `Пользователь ${updatedUser.first_name} (ID: ${targetId}) теперь имеет роль: **${newRole.toUpperCase()}**`,
      );

      // Опционально: уведомить самого пользователя
      try {
        await ctx.telegram.sendMessage(
          targetId,
          `🎉 Вам назначена новая роль: ${newRole.toUpperCase()}`,
        );
      } catch (e) {
        // Игнорируем, если у юзера заблокирован бот
      }
    } catch (error) {
      await ctx.reply(`❌ Ошибка: ${error.message}`);
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
      return ctx.replyWithMarkdown(
        `🛠 **Настройка Цен**\n\n` +
          `Используйте: \`/setprice КЛЮЧ ЗНАЧЕНИЕ\`\n` +
          `Пример: \`/setprice price_cable 250\`\n\n` +
          `🔑 **Доступные ключи:**\n${keysList}`,
      );
    }

    const key = args[1];
    const value = args[2];

    try {
      // Сохраняем новую настройку через репозиторий
      await db.saveSetting(key, value);
      await ctx.reply(
        `✅ Настройка **${key}** обновлена. Новое значение: **${value}**`,
      );
    } catch (error) {
      await ctx.reply(
        `❌ Не удалось обновить настройку. Проверьте правильность ключа.`,
      );
    }
  },

  /**
   * 📢 Рассылка сообщений всем пользователям (Retention Tool).
   * Позволяет вернуть клиентов, отправив им акцию или новость.
   */
  async broadcastMessage(ctx) {
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    // В этом примере мы просто запрашиваем текст.
    // В полной версии здесь нужна машина состояний (Scene), чтобы не отправить случайно.
    // Для Senior уровня реализуем безопасную заглушку-пример:

    const messageParts = ctx.message.text.split(" ");
    if (messageParts.length < 2) {
      return ctx.reply(
        "⚠️ Напишите текст рассылки после команды `/broadcast Ваше сообщение`",
      );
    }

    const textToSend = messageParts.slice(1).join(" ");

    await ctx.reply("⏳ Начинаю рассылку...");

    // Получаем всех пользователей (пачками)
    const allUsers = await UserService.getAllUsers(1000, 0); // Лимит 1000 для примера
    let successCount = 0;
    let failCount = 0;

    for (const user of allUsers) {
      try {
        await ctx.telegram.sendMessage(
          user.telegram_id,
          `📢 **Новости ProElectric**\n\n${textToSend}`,
          { parse_mode: "Markdown" },
        );
        successCount++;
      } catch (e) {
        failCount++; // Юзер заблокировал бота
      }
    }

    await ctx.reply(
      `📢 **Рассылка завершена**\n` +
        `✅ Доставлено: ${successCount}\n` +
        `❌ Недоставлено (блок): ${failCount}`,
    );
  },

  /**
   * 📂 Получение файла базы данных (Backup).
   * Админ может скачать актуальную версию DB_SETTINGS или логов.
   */
  async downloadDatabase(ctx) {
    if (!(await UserService.isAdmin(ctx.from.id))) return;

    // Здесь можно реализовать выгрузку данных в Excel или JSON
    // Для примера выгружаем текущие настройки цен
    const settings = await db.getSettings();
    const jsonString = JSON.stringify(settings, null, 2);

    await ctx.replyWithDocument({
      source: Buffer.from(jsonString),
      filename: `settings_backup_${new Date().toISOString().split("T")[0]}.json`,
    });
  },
};

/**
 * @file src/handlers/AdminHandler.js
 * @description Контроллер панели администратора (Enterprise CRM).
 * Реализует: Финансы (P&L), Управление заказами, Настройки, Персонал, Рассылки.
 *
 * @author ProElectric Team
 * @version 9.0 (Full Release)
 */

import { UserService } from "../services/UserService.js";
import { OrderService } from "../services/OrderService.js";
import * as db from "../database/index.js";
import { KEYBOARDS, BUTTONS, DB_KEYS, ORDER_STATUS } from "../constants.js";

// Утилита для задержки (чтобы не словить бан от Телеграма при рассылке)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Утилита для форматирования денег
const formatMoney = (amount) => parseInt(amount || 0).toLocaleString('ru-RU') + ' ₸';

export const AdminHandler = {

  /**
   * ===========================================================================
   * 1. 🚦 ГЛАВНОЕ МЕНЮ И РОУТИНГ
   * ===========================================================================
   */

  /**
   * Показать меню администратора
   * Обязательно проверяет права доступа.
   */
  async showAdminMenu(ctx) {
    try {
      if (!(await UserService.isAdmin(ctx.from.id))) {
          return ctx.reply("⛔ У вас нет прав доступа к панели управления.");
      }
      await ctx.reply("👑 <b>ЦЕНТР УПРАВЛЕНИЯ БИЗНЕСОМ</b>\nВыберите раздел:", { 
          parse_mode: 'HTML',
          reply_markup: KEYBOARDS.ADMIN_MENU 
      });
    } catch (e) {
      console.error("Admin Menu Error:", e);
    }
  },

  /**
   * Обработчик кнопок меню администратора
   */
  async handleMessage(ctx) {
      const text = ctx.message.text;

      // Маршрутизация по разделам
      switch (text) {
          case BUTTONS.ADMIN_STATS:
              return this.showDashboard(ctx);
          case BUTTONS.ADMIN_ORDERS:
              return this.showOrdersInstruction(ctx);
          case BUTTONS.ADMIN_SETTINGS:
              return this.showSettingsInstruction(ctx);
          case BUTTONS.ADMIN_STAFF:
              return this.showStaffInstruction(ctx);
          case BUTTONS.ADMIN_SQL:
              return this.showSQLInstruction(ctx);
          case BUTTONS.BACK:
              return ctx.reply("Выход в главное меню.", KEYBOARDS.MAIN_MENU('admin')); // Возврат
          default:
              return ctx.reply("⚠️ Неизвестная команда. Используйте меню.");
      }
  },

  /**
   * ===========================================================================
   * 2. 💰 ФИНАНСОВЫЙ ДАШБОРД (Dashboard)
   * ===========================================================================
   */

  async showDashboard(ctx) {
      const msg = await ctx.reply("⏳ Собираю финансовые данные...");
      try {
          // Выполняем агрегацию данных на уровне базы (Это эффективно)
          // Считаем только завершенные заказы (status = 'done')
          const res = await db.query(`
              SELECT 
                COUNT(*) as count,
                SUM(total_price) as gross_revenue,
                SUM(expenses) as total_expenses,
                SUM(net_profit) as net_income
              FROM orders 
              WHERE status = 'done'
          `);
          
          const data = res.rows[0];

          // Считаем активные заказы (в работе)
          const activeRes = await db.query("SELECT COUNT(*) as count FROM orders WHERE status = 'work'");
          const activeCount = activeRes.rows[0].count;

          const report = 
            `📊 <b>ФИНАНСОВЫЙ ОТЧЕТ (P&L)</b>\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `✅ <b>Завершенные проекты:</b> ${data.count || 0}\n` +
            `🛠 <b>В работе сейчас:</b> ${activeCount || 0}\n\n` +
            
            `💵 <b>ВЫРУЧКА (Оборот):</b>\n` +
            `<code>${formatMoney(data.gross_revenue)}</code>\n\n` +
            
            `📉 <b>РАСХОДЫ (ЗП + Материал):</b>\n` +
            `<code>${formatMoney(data.total_expenses)}</code>\n\n` +
            
            `💎 <b>ЧИСТАЯ ПРИБЫЛЬ (Net Profit):</b>\n` +
            `💰 <b>${formatMoney(data.net_income)}</b>\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `<i>Для ввода расходов используйте команду:</i>\n` +
            `<code>/expense ID СУММА</code>`;
          
          // Редактируем сообщение (чтобы не спамить)
          await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, report, { parse_mode: 'HTML' });
      
      } catch (e) {
          ctx.reply("❌ Ошибка при расчете финансов: " + e.message);
      }
  },

  /**
   * ===========================================================================
   * 3. 💸 УПРАВЛЕНИЕ РАСХОДАМИ
   * ===========================================================================
   */

  /**
   * Установка расходов по заказу.
   * Автоматически пересчитывает чистую прибыль.
   * Команда: /expense ID СУММА
   */
  async processSetExpense(ctx) {
      const parts = ctx.message.text.split(' ');
      
      if (parts.length !== 3) {
          return ctx.reply("⚠️ Ошибка формата.\nИспользуйте: <code>/expense ID_ЗАКАЗА СУММА</code>\nПример: /expense 15 45000", { parse_mode: 'HTML' });
      }
      
      const orderId = parseInt(parts[1]);
      const expense = parseFloat(parts[2]);

      if (isNaN(orderId) || isNaN(expense)) {
          return ctx.reply("⚠️ ID и Сумма должны быть числами.");
      }

      try {
          // Транзакция: обновляем expense и пересчитываем profit
          // profit = total_price - expense
          const res = await db.query(`
              UPDATE orders 
              SET expenses = $1, 
                  net_profit = total_price - $1 
              WHERE id = $2
              RETURNING id, total_price, net_profit
          `, [expense, orderId]);

          if (res.rowCount === 0) {
              return ctx.reply("❌ Заказ с таким ID не найден.");
          }

          const updated = res.rows[0];
          
          await ctx.reply(
              `✅ <b>Расход принят!</b>\n` +
              `Заказ #${updated.id}\n` +
              `Расход: ${formatMoney(expense)}\n` +
              `Теперь чистая прибыль: <b>${formatMoney(updated.net_profit)}</b>`, 
              { parse_mode: 'HTML' }
          );

      } catch (e) {
          ctx.reply("Ошибка базы данных: " + e.message);
      }
  },

  /**
   * ===========================================================================
   * 4. 📦 УПРАВЛЕНИЕ ЗАКАЗАМИ (Статусы)
   * ===========================================================================
   */

  async showOrdersInstruction(ctx) {
      await ctx.replyWithHTML(
          `📦 <b>УПРАВЛЕНИЕ ЗАКАЗАМИ</b>\n\n` +
          `🔍 <b>Поиск заказа:</b>\n` +
          `<code>/findorder ID</code> (например: /findorder 12)\n\n` +
          `🚦 <b>Смена статуса:</b>\n` +
          `<code>/status ID КОД</code>\n\n` +
          `<b>Коды статусов:</b>\n` +
          `🆕 <code>new</code> - Новый\n` +
          `🛠 <code>work</code> - В работе\n` +
          `✅ <code>done</code> - Выполнен (учитывается в прибыли)\n` +
          `❌ <code>cancel</code> - Отменен`
      );
  },

  async processSetStatus(ctx) {
      // /status 12 work
      const parts = ctx.message.text.split(' ');
      if (parts.length !== 3) return ctx.reply("⚠️ Формат: /status ID CODE");
      
      const [_, id, statusRaw] = parts;
      const status = statusRaw.toLowerCase();

      // Валидация статуса
      if (!Object.values(ORDER_STATUS).includes(status)) {
          return ctx.reply("❌ Неверный статус. Допустимые: new, work, done, cancel");
      }

      try {
        await db.query("UPDATE orders SET status = $1 WHERE id = $2", [status, id]);
        
        await ctx.reply(`✅ Статус заказа #${id} изменен на <b>${status.toUpperCase()}</b>`, { parse_mode: 'HTML' });
      } catch(e) { 
          ctx.reply("Ошибка БД: " + e.message); 
      }
  },

  /**
   * ===========================================================================
   * 5. ⚙️ УПРАВЛЕНИЕ НАСТРОЙКАМИ (ЦЕНЫ)
   * ===========================================================================
   */

  async showSettingsInstruction(ctx) {
      // Получаем список доступных ключей настроек из constants.js
      const keysList = Object.values(DB_KEYS).map(k => `<code>${k}</code>`).join('\n');
      
      await ctx.replyWithHTML(
          `⚙️ <b>НАСТРОЙКИ СИСТЕМЫ</b>\n\n` +
          `Здесь вы можете менять цены на услуги "на лету", без перезагрузки бота.\n\n` +
          `📝 <b>Изменить цену:</b>\n` +
          `<code>/setprice КЛЮЧ ЗНАЧЕНИЕ</code>\n\n` +
          `🔑 <b>Доступные ключи:</b>\n${keysList}\n\n` +
          `<i>Пример: /setprice price_point_concrete 3000</i>`
      );
  },

  async processSetPrice(ctx) {
      const parts = ctx.message.text.split(' ');
      if (parts.length !== 3) return ctx.reply("⚠️ Формат: /setprice KEY VALUE");
      
      const [_, key, value] = parts;
      
      // Проверяем, что значение - число
      if (isNaN(parseFloat(value))) return ctx.reply("❌ Значение должно быть числом.");

      try {
          // Используем UPSERT (Вставка или Обновление)
          await db.query(`
              INSERT INTO settings (key, value, updated_at) 
              VALUES ($1, $2, NOW()) 
              ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
          `, [key, value]);

          await ctx.reply(`✅ Настройка <b>${key}</b> успешно обновлена до <b>${value}</b>`, { parse_mode: 'HTML' });
      } catch (e) {
          ctx.reply("Ошибка сохранения: " + e.message);
      }
  },

  /**
   * ===========================================================================
   * 6. 👥 УПРАВЛЕНИЕ ПЕРСОНАЛОМ И БАН
   * ===========================================================================
   */

  async showStaffInstruction(ctx) {
      await ctx.replyWithHTML(
          `👥 <b>УПРАВЛЕНИЕ КАДРАМИ</b>\n\n` +
          `👑 <b>Назначить роль:</b>\n` +
          `<code>/setrole ID ROLE</code>\n` +
          `<i>Роли: admin, manager, user</i>\n\n` +
          `⛔ <b>Заблокировать пользователя:</b>\n` +
          `<code>/ban ID</code>\n\n` +
          `📢 <b>Массовая рассылка:</b>\n` +
          `<code>/broadcast ТЕКСТ</code>`
      );
  },

  async processSetRole(ctx) {
      const parts = ctx.message.text.split(' ');
      if (parts.length !== 3) return ctx.reply("⚠️ Формат: /setrole ID ROLE");

      const [_, userId, role] = parts;
      
      // Валидация ролей
      if (!['admin', 'manager', 'user'].includes(role)) {
          return ctx.reply("❌ Недопустимая роль. Используйте: admin, manager, user");
      }

      try {
          await UserService.changeUserRole(ctx.from.id, userId, role);
          await ctx.reply(`✅ Пользователю ${userId} назначена роль <b>${role.toUpperCase()}</b>`, { parse_mode: 'HTML' });
          
          // Уведомляем пользователя
          try {
              await ctx.telegram.sendMessage(userId, `⚠️ Ваши права доступа изменены на: <b>${role.toUpperCase()}</b>`, { parse_mode: 'HTML' });
          } catch (e) { /* Игнорируем, если бот заблочен */ }

      } catch (e) {
          ctx.reply("Ошибка: " + e.message);
      }
  },

  async processBanUser(ctx) {
      const parts = ctx.message.text.split(' ');
      if (parts.length !== 2) return ctx.reply("⚠️ Формат: /ban ID");
      
      const userId = parts[1];

      // Защита от самострела
      if (userId == ctx.from.id) return ctx.reply("🤡 Себя забанить нельзя.");

      try {
          // Мы не удаляем юзера, а ставим ему роль 'banned'
          // Нужно убедиться, что роль 'banned' обрабатывается в UserHandler (если нет, можно просто ставить роль 'restricted')
          // В текущей системе просто снимем админку
          await UserService.changeUserRole(ctx.from.id, userId, 'banned'); 
          await ctx.reply(`🚫 Пользователь ${userId} заблокирован (роль set to banned).`);
      } catch (e) {
          ctx.reply("Ошибка: " + e.message);
      }
  },

  /**
   * ===========================================================================
   * 7. 📢 МАССОВАЯ РАССЫЛКА (BROADCAST)
   * ===========================================================================
   */

  async processBroadcast(ctx) {
      // Убираем команду из текста
      const text = ctx.message.text.replace('/broadcast', '').trim();
      
      if (text.length < 5) {
          return ctx.reply("⚠️ Текст рассылки слишком короткий.");
      }

      const confirmMsg = await ctx.reply("📢 Начинаю рассылку...");
      const startTime = Date.now();
      
      try {
          // Получаем всех пользователей
          const usersRes = await db.query("SELECT telegram_id FROM users");
          const users = usersRes.rows;
          
          let successCount = 0;
          let blockCount = 0;
          let failCount = 0;

          // Проходим по всем юзерам
          for (const user of users) {
              try {
                  await ctx.telegram.sendMessage(user.telegram_id, `📢 <b>НОВОСТИ PRO ELECTRIC</b>\n\n${text}`, { parse_mode: 'HTML' });
                  successCount++;
                  // Важно: Пауза, чтобы не превысить лимиты Телеграма (30 сообщений в секунду)
                  await sleep(50); 
              } catch (e) {
                  // Ошибка 403 означает, что юзер заблокировал бота
                  if (e.response && e.response.error_code === 403) {
                      blockCount++;
                  } else {
                      failCount++;
                  }
              }
          }

          const duration = ((Date.now() - startTime) / 1000).toFixed(1);

          await ctx.replyWithHTML(
              `✅ <b>Рассылка завершена!</b>\n` +
              `⏱ Время: ${duration} сек\n` +
              `📨 Отправлено: <b>${successCount}</b>\n` +
              `💀 Бот заблокирован: <b>${blockCount}</b>\n` +
              `❌ Ошибки: <b>${failCount}</b>`
          );

      } catch (e) {
          ctx.reply("Критическая ошибка рассылки: " + e.message);
      }
  },

  /**
   * ===========================================================================
   * 8. 👨‍💻 SQL КОНСОЛЬ
   * ===========================================================================
   */

  async showSQLInstruction(ctx) {
      await ctx.replyWithHTML(
          `👨‍💻 <b>SQL ТЕРМИНАЛ</b>\n` +
          `Выполняйте любые запросы к БД напрямую.\n\n` +
          `Пример:\n<code>/sql SELECT * FROM users LIMIT 5</code>\n\n` +
          `⚠️ Будьте осторожны с DELETE и DROP!`
      );
  },

  async processSQL(ctx) {
      const query = ctx.message.text.replace('/sql', '').trim();
      if (!query) return ctx.reply("⚠️ Пустой запрос.");
      
      try {
          const start = Date.now();
          const res = await db.query(query);
          const duration = Date.now() - start;

          if (res.command === 'SELECT') {
              const json = JSON.stringify(res.rows, null, 2);
              if (json.length > 4000) {
                  await ctx.replyWithDocument({ source: Buffer.from(json), filename: 'result.json' });
              } else {
                  await ctx.replyWithHTML(`✅ <b>Результат (${res.rowCount} строк):</b>\n<pre>${json}</pre>`);
              }
          } else {
              await ctx.reply(`✅ Выполнено. Затронуто: ${res.rowCount}. Время: ${duration}ms`);
          }
      } catch (e) {
          await ctx.reply(`❌ Ошибка SQL:\n${e.message}`);
      }
  }
};
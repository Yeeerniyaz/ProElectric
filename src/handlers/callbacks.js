/**
 * @file src/handlers/callbacks.js
 * @description Обработчик Inline-кнопок (Callback Queries).
 * Реализует логику умного калькулятора, управление заказами и финансовые триггеры ERP.
 * @version 5.0.0 (Senior Architect Edition)
 */

import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { STATUS_CONFIG, ORDER_STATUS } from '../constants.js';
import { sessions, notifyAdmin, KB, handleAdminCommand } from './messages.js';

// =============================================================================
// 📊 СЕРВИСНЫЕ УТИЛИТЫ (HELPERS)
// =============================================================================

/**
 * Профессиональное форматирование валюты для финансовых документов
 */
const formatKZT = (num) => {
    return new Intl.NumberFormat('ru-KZ', {
        style: 'currency',
        currency: 'KZT',
        maximumFractionDigits: 0
    }).format(num);
};

/**
 * Логирование действий пользователей для аудита (Audit Trail)
 */
const auditLog = (userId, action, data) => {
    console.log(`[AUDIT] User:${userId} | Action:${action} | Data:${JSON.stringify(data)}`);
};

// =============================================================================
// 🎮 ОСНОВНОЙ МОДУЛЬ ОБРАБОТКИ
// =============================================================================

/**
 * Регистрация всех callback-хендлеров
 * @description Центральный узел обработки нажатий на кнопки в Telegram
 */
export const setupCallbackHandlers = () => {
    
    bot.on('callback_query', async (query) => {
        const { id: callbackQueryId, data, message, from } = query;
        const chatId = message.chat.id;
        const userId = from.id; // telegram_id

        try {
            // ---------------------------------------------------------
            // 1. АДМИНИСТРАТИВНЫЙ СЛОЙ (ADMIN LAYER)
            // ---------------------------------------------------------
            if (data.startsWith('adm_')) {
                const cmd = data.split('_')[1];
                auditLog(userId, 'ADMIN_ACCESS', { command: cmd });
                
                await bot.answerCallbackQuery(callbackQueryId);
                return await handleAdminCommand(message, [null, cmd]);
            }

            // ---------------------------------------------------------
            // 2. УПРАВЛЕНИЕ ЗАКАЗАМИ И СТАТУСАМИ (ORDER LIFECYCLE)
            // ---------------------------------------------------------
            if (data.startsWith('status_')) {
                const [_, newStatus, orderId] = data.split('_');
                const cfg = STATUS_CONFIG[newStatus];

                if (!cfg || !orderId) {
                    return bot.answerCallbackQuery(callbackQueryId, { text: "❌ Ошибка: Данные повреждены", show_alert: true });
                }

                // 1. Обновляем статус и ответственного атомарно
                await db.query(
                    `UPDATE orders SET status = $1, assignee_id = $2, updated_at = NOW() WHERE id = $3`,
                    [newStatus, userId, orderId]
                );

                // 2. UI: Обновляем карточку заказа в чате
                const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                const originalText = message.text || '';
                
                // Используем Regex для очистки старых заголовков статуса
                const cleanBody = originalText.replace(/^.*(СТАТУС|Мастер|Обновлено):.*\n/gm, '').trim();
                
                const updatedContent = 
                    `${cfg.icon} <b>СТАТУС: ${cfg.label}</b>\n` +
                    `👷‍♂️ <b>Мастер:</b> ${from.first_name}\n` +
                    `⏰ <b>Обновлено:</b> ${time}\n\n` +
                    `${cleanBody}`;

                await bot.editMessageText(updatedContent, {
                    chat_id: chatId,
                    message_id: message.message_id,
                    parse_mode: 'HTML',
                    reply_markup: message.reply_markup // Сохраняем кнопки управления
                });

                // 🔥 ФИНАНСОВЫЙ ТРИГГЕР ERP: Автоматизация при закрытии заказа
                if (newStatus === ORDER_STATUS.DONE) {
                    await handleOrderCompletion(chatId, orderId, userId);
                }

                return bot.answerCallbackQuery(callbackQueryId, { text: `✅ Статус изменен на ${cfg.label}` });
            }

            // ---------------------------------------------------------
            // 3. ПРИНЯТИЕ В РАБОТУ (CLAIM LOGIC)
            // ---------------------------------------------------------
            if (data.startsWith('take_order_')) {
                const orderId = data.split('_')[2];

                // RBAC: Проверка прав (только админы и менеджеры)
                const userRes = await db.query('SELECT role, first_name FROM users WHERE telegram_id = $1', [userId]);
                const user = userRes.rows[0];

                if (!user || !['admin', 'manager'].includes(user.role)) {
                    return bot.answerCallbackQuery(callbackQueryId, { text: "⛔️ У вас нет прав для управления заказами", show_alert: true });
                }

                await db.query(
                    `UPDATE orders SET assignee_id = $1, status = 'work', updated_at = NOW() WHERE id = $2`,
                    [userId, orderId]
                );

                const finalMsg = message.text + `\n\n✅ <b>Заказ взял в работу:</b> ${user.first_name}`;

                await bot.editMessageText(finalMsg, {
                    chat_id: chatId,
                    message_id: message.message_id,
                    parse_mode: 'HTML'
                });

                return bot.answerCallbackQuery(callbackQueryId, { text: "🚀 Вы назначены ответственным!" });
            }

            // ---------------------------------------------------------
            // 4. УМНЫЙ КАЛЬКУЛЯТОР (SMART ESTIMATOR)
            // ---------------------------------------------------------
            if (data.startsWith('wall_')) {
                const wallType = data.split('_')[1];
                const session = sessions.get(chatId);

                if (!session || !session.data.area) {
                    return bot.answerCallbackQuery(callbackQueryId, { text: "⚠️ Сессия истекла. Начните заново с /start", show_alert: true });
                }

                await bot.answerCallbackQuery(callbackQueryId);
                await bot.sendChatAction(chatId, 'typing');

                const area = session.data.area;
                const prices = await db.getSettings();

                // 📐 БИЗНЕС-ЛОГИКА РАСЧЕТА (Senior Algorithm)
                const wallFactor = { light: 1.0, medium: 1.25, heavy: 1.6 }[wallType] || 1;
                
                // Детализация объемов (эвристика на основе м2)
                const volume = {
                    points: Math.ceil(area * 0.85),       // Розетки/выключатели
                    strobe: Math.ceil(area * 0.6),       // Штробление
                    cable: Math.ceil(area * 4.8),        // Кабельные трассы
                    boxes: Math.ceil(area * 0.85)        // Подрозетники
                };

                // Стоимость работ
                const costs = {
                    work: (
                        (volume.points * (prices.work_point || 1500)) +
                        (volume.strobe * (prices.work_strobe || 1500) * wallFactor) +
                        (volume.cable * (prices.work_cable || 450)) +
                        (prices.work_shield_install || 18000)
                    ),
                    materials: Math.ceil(area * (prices.material_m2 || 4500))
                };

                const totalWork = Math.ceil(costs.work);
                const totalMat = costs.materials;
                const grandTotal = totalWork + totalMat;

                // Сохранение Лида в БД для воронки продаж
                const leadId = await db.createLead(userId, {
                    area, wallType, totalWork, totalMat
                });

                const wallLabel = { light: 'ГКЛ/Газоблок', medium: 'Кирпич', heavy: 'Бетон/Монолит' }[wallType];

                const estimateText = 
                    `⚡️ <b>СМЕТА НА ЭЛЕКТРОМОНТАЖ</b>\n` +
                    `➖➖➖➖➖➖➖➖➖➖\n` +
                    `🏢 <b>Объект:</b> ${area} м²\n` +
                    `🧱 <b>Стены:</b> ${wallLabel}\n\n` +
                    `🛠 <b>Работа (чел/час):</b> ~${formatKZT(totalWork)}\n` +
                    `🔌 <b>Материалы (черновые):</b> ~${formatKZT(totalMat)}\n` +
                    `➖➖➖➖➖➖➖➖➖➖\n` +
                    `🏁 <b>ИТОГО ПОД КЛЮЧ: ~${formatKZT(grandTotal)}</b>\n\n` +
                    `<i>*Цена является ориентировочной. Итоговая сумма фиксируется в договоре после замера.</i>`;

                await bot.sendMessage(chatId, estimateText, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "👷‍♂️ Записаться на замер", callback_data: `order_call_${leadId}` }],
                            [{ text: "💬 Обсудить с инженером", callback_data: `order_chat_${leadId}` }]
                        ]
                    }
                });

                sessions.reset(chatId); // Очищаем стейт после завершения расчетов
                return;
            }

            // ---------------------------------------------------------
            // 5. ОФОРМЛЕНИЕ ЗАКАЗА (CONVERSION)
            // ---------------------------------------------------------
            if (data.startsWith('order_')) {
                const [_, type, leadId] = data.split('_');
                await bot.answerCallbackQuery(callbackQueryId);
                await bot.sendChatAction(chatId, 'typing');

                try {
                    // Создаем официальный заказ из лида
                    const result = await db.createOrder(userId, leadId);
                    
                    const confirmationMsg = type === 'call' 
                        ? "✅ <b>Заявка на замер принята!</b>\nСпециалист перезвонит вам в течение 15 минут для согласования времени."
                        : "✅ <b>Заявка передана инженеру!</b>\nМы напишем вам в Telegram для обсуждения деталей проекта.";

                    await bot.sendMessage(chatId, confirmationMsg, { parse_mode: 'HTML' });

                    // 🚨 Уведомление в CRM-группу (Админ-канал)
                    await notifyAdmin(
                        `🔥 <b>НОВЫЙ ЗАКАЗ #${result.orderId}</b>\n` +
                        `➖➖➖➖➖➖➖➖➖➖\n` +
                        `👤 <b>Клиент:</b> ${result.user.first_name} (@${result.user.username || 'n/a'})\n` +
                        `📱 <b>Телефон:</b> <code>${result.user.phone || 'Не подтвержден'}</code>\n` +
                        `📐 <b>Смета:</b> ${formatKZT(result.lead.total_work_cost)}\n` +
                        `🎯 <b>Тип заявки:</b> ${type === 'call' ? 'Выездной замер' : 'Консультация'}`,
                        result.orderId
                    );

                } catch (e) {
                    console.error('CONVERSION_ERROR:', e);
                    await bot.sendMessage(chatId, "❌ <b>Упс! Что-то пошло не так.</b>\nПожалуйста, отправьте ваш номер телефона через меню «Контакты», и мы поможем вручную.");
                }
            }

        } catch (error) {
            console.error('💥 [CALLBACK_FATAL]', error);
            await bot.answerCallbackQuery(callbackQueryId, { text: "❌ Системная ошибка. Попробуйте позже." });
        }
    });
};

// =============================================================================
// 💸 ФИНАНСОВЫЕ ХЕНДЛЕРЫ (ERP INTEGRATION)
// =============================================================================

/**
 * Обработка завершения заказа и уведомление о распределении финансов
 * @param {number} chatId 
 * @param {number} orderId 
 * @param {number} userId 
 */
async function handleOrderCompletion(chatId, orderId, userId) {
    try {
        // Получаем данные заказа для финансовых расчетов
        const res = await db.query(`
            SELECT l.total_work_cost, u.first_name 
            FROM orders o 
            JOIN leads l ON o.lead_id = l.id 
            JOIN users u ON o.user_id = u.telegram_id
            WHERE o.id = $1
        `, [orderId]);
        
        const orderData = res.rows[0];
        const prices = await db.getSettings();

        // Расчет долей (Оклад / Бизнес)
        const businessPercent = (prices.business_percent || 20) / 100;
        const staffPercent = (prices.staff_percent || 80) / 100;
        
        const toBusiness = Math.floor(orderData.total_work_cost * businessPercent);
        const toStaff = Math.floor(orderData.total_work_cost * staffPercent);

        const financeNotify = 
            `💰 <b>Заказ #${orderId} ЗАКРЫТ!</b>\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `💸 <b>Сумма к распределению:</b> ${formatKZT(orderData.total_work_cost)}\n\n` +
            `🏢 <b>В фонд бизнеса (${prices.business_percent}%):</b> ${formatKZT(toBusiness)}\n` +
            `👷‍♂️ <b>В фонд оклада (${prices.staff_percent}%):</b> ${formatKZT(toStaff)}\n\n` +
            `<i>Пожалуйста, подтвердите получение средств в Dashboard и выполните перевод между счетами.</i>`;

        await bot.sendMessage(chatId, financeNotify, { parse_mode: 'HTML' });
        
        auditLog(userId, 'ORDER_COMPLETED_FINANCE', { orderId, amount: orderData.total_work_cost });

    } catch (e) {
        console.error('FINANCE_TRIGGER_ERROR:', e);
    }
}
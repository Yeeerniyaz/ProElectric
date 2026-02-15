import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { handleAdminCommand, sessions, notifyAdmin, KB } from './messages.js';
import { STATUS_CONFIG } from '../constants.js';

// Утилита для красивого форматирования денег
const formatKZT = (num) => {
    return new Intl.NumberFormat('ru-KZ', {
        style: 'currency',
        currency: 'KZT',
        maximumFractionDigits: 0
    }).format(num);
};

export const setupCallbackHandlers = () => {
    bot.on('callback_query', async (query) => {
        const { id, data, message, from } = query;
        const chatId = message.chat.id;

        try {
            // ====================================================
            // 1. АДМИН-ПУЛЬТ (ЛОГИКА ИЗ КАНАЛА)
            // ====================================================
            if (data.startsWith('adm_')) {
                const cmd = data.split('_')[1];
                await bot.answerCallbackQuery(id);
                bot.sendChatAction(chatId, 'typing');
                await handleAdminCommand(message, [null, cmd]);
                return;
            }

            // ====================================================
            // 2. СМЕНА СТАТУСА (АВТО-НАЗНАЧЕНИЕ ОТВЕТСТВЕННОГО)
            // ====================================================
            if (data.startsWith('status_')) {
                const [_, action, orderId] = data.split('_');
                const cfg = STATUS_CONFIG[action];

                if (cfg && orderId) {
                    await db.query(
                        `UPDATE orders 
                         SET status = $1, assignee_id = $2, updated_at = NOW() 
                         WHERE id = $3`,
                        [action, from.id, orderId]
                    );

                    const originalText = message.text || '';
                    const cleanedText = originalText
                        .replace(/^.*(СТАТУС|Ответственный):.*\n\n/g, '')
                        .replace(/^.*СТАТУС:.*\n\n/g, '');

                    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                    
                    const updatedText = 
                        `${cfg.icon} <b>СТАТУС: ${cfg.label}</b>\n` +
                        `👷‍♂️ <b>Ответственный: ${from.first_name}</b> (обн. ${time})\n\n` +
                        `${cleanedText}`;

                    try {
                        await bot.editMessageText(updatedText, {
                            chat_id: chatId,
                            message_id: message.message_id,
                            parse_mode: 'HTML',
                            reply_markup: message.reply_markup
                        });
                        await bot.answerCallbackQuery(id, { text: `✅ Статус: ${cfg.label}` });
                    } catch (e) {
                        await bot.answerCallbackQuery(id);
                    }
                }
                return;
            }

            // ====================================================
            // 3. ВЗЯТЬ В РАБОТУ (ДЛЯ МЕНЕДЖЕРОВ)
            // ====================================================
            if (data.startsWith('take_order_')) {
                const orderId = data.split('_')[2];
                const userId = from.id; // telegram_id

                // Проверка прав
                const userRes = await db.query('SELECT role, first_name FROM users WHERE telegram_id = $1', [userId]);
                const user = userRes.rows[0];

                if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
                    return bot.answerCallbackQuery(id, { text: '⛔️ У вас нет прав.', show_alert: true });
                }

                await db.query(
                    'UPDATE orders SET assignee_id = $1, status = $2 WHERE id = $3',
                    [userId, 'work', orderId]
                );

                const originalText = message.text || '';
                const updatedText = originalText + `\n\n✅ <b>Заказ принял: ${user.first_name}</b>`;

                await bot.editMessageText(updatedText, {
                    chat_id: chatId,
                    message_id: message.message_id,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [] }
                });

                return bot.answerCallbackQuery(id, { text: '✅ Вы назначены ответственным!' });
            }

            // ====================================================
            // 4. УМНЫЙ КАЛЬКУЛЯТОР (DETAILED ESTIMATION)
            // ====================================================
            const session = sessions.get(chatId);

            if (!session && data.startsWith('wall_')) {
                return bot.answerCallbackQuery(id, { text: '⚠️ Начните новый расчет /start', show_alert: true });
            }

            if (data.startsWith('wall_')) {
                bot.sendChatAction(chatId, 'typing');
                session.data.wallType = data.replace('wall_', '');
                
                const area = session.data.area;
                const prices = await db.getSettings();

                // --- 1. РАСЧЕТ ОБЪЕМОВ ---
                const qtyPoints = Math.ceil(area * 0.8);      // Точек (розеток/выкл)
                const qtyLamps = Math.ceil(area / 12);        // Светильников
                const qtyCable = Math.ceil(area * 4.5);       // Метров кабеля
                const qtyStrobe = Math.ceil(area * 0.5);      // Метров штробы (примерно)
                const qtyShield = Math.ceil(area / 10) + 4;   // Модулей в щите
                const qtyJunction = Math.ceil(area / 15);     // Распаечных коробок

                // --- 2. РАСЧЕТ СТОИМОСТИ РАБОТ ---
                const costPoints = qtyPoints * (prices.work_point || 1500);
                const costBoxes = qtyPoints * (prices.work_box || 1000); // Подрозетники под точки
                const costLamps = qtyLamps * (prices.work_lamp || 3000);
                const costCable = qtyCable * (prices.work_cable || 400);
                const costStrobe = qtyStrobe * (prices.work_strobe || 1500);
                const costShieldWork = qtyShield * (prices.work_automaton || 2500) + (prices.work_shield_install || 5000);
                const costJunction = qtyJunction * (prices.work_junction || 2500);
                
                // Добавляем коэффициент за сложность стен (для штробы и подрозетников)
                let wallFactor = 1; 
                if (session.data.wallType === 'medium') wallFactor = 1.2; // Кирпич дороже
                if (session.data.wallType === 'heavy') wallFactor = 1.5;  // Бетон еще дороже
                
                // Корректируем грязные работы на коэффициент стены
                const totalDirtyWork = (costStrobe + costBoxes) * wallFactor;
                const totalCleanWork = costPoints + costLamps + costCable + costShieldWork + costJunction;
                
                const totalWork = Math.ceil(totalDirtyWork + totalCleanWork);
                const totalMat = area * (prices.material_m2 || 4000);
                const totalSum = totalWork + totalMat;

                const wallLabel = {
                    light: 'Газоблок/ГКЛ',
                    medium: 'Кирпич',
                    heavy: 'Бетон/Монолит'
                }[session.data.wallType];

                // Сохранение Лида
                const leadId = await db.createLead(from.id, {
                    area, wallType: session.data.wallType, totalWork, totalMat
                });

                // --- 3. ГЕНЕРАЦИЯ ЧЕКА ---
                const result = 
                    `⚡️ <b>ПРЕДВАРИТЕЛЬНАЯ СМЕТА</b>\n` +
                    `🏢 Объект: ${area} м² | Стены: ${wallLabel}\n\n` +
                    
                    `🛠 <b>РАБОТЫ (ДЕТАЛИЗАЦИЯ):</b>\n` +
                    `├ Точки (~${qtyPoints} шт): ${formatKZT(costPoints + costBoxes)}\n` +
                    `├ Освещение (~${qtyLamps} шт): ${formatKZT(costLamps)}\n` +
                    `├ Кабель (~${qtyCable} м): ${formatKZT(costCable)}\n` +
                    `├ Штробление (~${qtyStrobe} м): ${formatKZT(costStrobe * wallFactor)}\n` +
                    `├ Сборка щита (~${qtyShield} мод): ${formatKZT(costShieldWork)}\n` +
                    `└ Распайка (~${qtyJunction} шт): ${formatKZT(costJunction)}\n\n` +
                    
                    `💰 <b>ВСЕГО РАБОТА:</b> ${formatKZT(totalWork)}\n` +
                    `🔌 <b>МАТЕРИАЛ (Черновой):</b> ~${formatKZT(totalMat)}\n` +
                    `➖➖➖➖➖➖➖➖\n` +
                    `🏁 <b>ИТОГО ПОД КЛЮЧ: ~${formatKZT(totalSum)}</b>\n\n` +
                    `<i>*Расчет предварительный. Точная смета составляется после выезда инженера.</i>`;

                await bot.sendMessage(chatId, result, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '👤 Связаться с менеджером', callback_data: `create_order_chat_${leadId}` }],
                            [{ text: '👷‍♂️ Записаться на замер', callback_data: `create_order_call_${leadId}` }]
                        ]
                    }
                });

                sessions.delete(chatId);
                await bot.sendMessage(chatId, '👇 <b>Что делаем дальше?</b>', KB.MAIN_MENU);
                return bot.answerCallbackQuery(id);
            }

            // ====================================================
            // 5. СОЗДАНИЕ ЗАКАЗА
            // ====================================================
            if (data.startsWith('create_order_')) {
                const [,, type, leadId] = data.split('_'); // chat или call
                bot.sendChatAction(chatId, 'typing');

                try {
                    const { orderId, user, lead } = await db.createOrder(from.id, leadId);

                    let clientMsg = '✅ <b>Заявка принята!</b>\nМенеджер напишет вам в Telegram в ближайшее время.';
                    let typeLabel = 'Консультация (ТГ)';

                    if (type === 'call') {
                        clientMsg = '✅ <b>Вы записаны на замер!</b>\nМы свяжемся для уточнения времени.';
                        typeLabel = 'Замер';
                    }

                    await bot.sendMessage(chatId, clientMsg, { parse_mode: 'HTML' });

                    // Уведомление Админу
                    await notifyAdmin(
                        `🔥 <b>НОВЫЙ ЗАКАЗ #${orderId}</b>\n` +
                        `👤 <b>Клиент:</b> ${user.first_name} (@${user.username || 'нет'})\n` +
                        `📱 <b>Тел:</b> <code>${user.phone || 'Не указан'}</code>\n` +
                        `💰 <b>Смета:</b> ~${formatKZT(lead.total_work_cost)}\n` +
                        `🎯 <b>Тип:</b> ${typeLabel}`, 
                        orderId
                    );
                    return bot.answerCallbackQuery(id);
                } catch (e) {
                    console.error('Create Order Error:', e);
                    return bot.answerCallbackQuery(id, { text: '❌ Ошибка сервера', show_alert: true });
                }
            }

        } catch (error) {
            console.error('💥 [CALLBACK ERROR]', error);
            await bot.answerCallbackQuery(id, { text: '❌ Ошибка сервера' });
        }
    });
};
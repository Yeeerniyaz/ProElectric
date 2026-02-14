import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { sessions, notifyAdmin } from './messages.js';

const formatKZT = (num) => {
    return new Intl.NumberFormat('ru-KZ', { 
        style: 'currency', 
        currency: 'KZT', 
        maximumFractionDigits: 0 
    }).format(num);
};

export const setupCallbackHandlers = () => {
    
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;
        const messageId = query.message.message_id;

        // --- ЛОГИКА CRM: ОБРАБОТКА СТАТУСОВ ПО ID ЗАКАЗА ---
        if (data.startsWith('status_')) {
            const parts = data.split('_'); // [status, type, leadId]
            const statusDb = parts[1];
            const leadId = parts[2];

            const labels = {
                'discuss': { text: 'В ОБСУЖДЕНИИ', icon: '🗣' },
                'work': { text: 'В РАБОТЕ', icon: '🏗' },
                'done': { text: 'РЕШЕНО', icon: '✅' },
                'cancel': { text: 'ОТКАЗ', icon: '❌' }
            };

            const statusCfg = labels[statusDb];
            if (statusCfg && leadId) {
                try {
                    // Обновляем статус в базе для конкретного ID заказа
                    await db.query('UPDATE leads SET status = $1 WHERE id = $2', [statusDb, leadId]);

                    const originalText = query.message.text || "";
                    const cleanedText = originalText.replace(/^.*СТАТУС:.*\n\n/g, '');
                    const updatedText = `${statusCfg.icon} <b>СТАТУС: ${statusCfg.text}</b>\n\n${cleanedText}`;

                    if (originalText !== updatedText) {
                        await bot.editMessageText(updatedText, {
                            chat_id: chatId,
                            message_id: messageId,
                            parse_mode: 'HTML',
                            reply_markup: query.message.reply_markup 
                        });
                    }
                    return bot.answerCallbackQuery(query.id, { text: `Заказ #${leadId}: ${statusCfg.text}` });
                } catch (e) {
                    console.error('CRM Update Error:', e.message);
                    return bot.answerCallbackQuery(query.id);
                }
            }
        }

        // --- ОБЫЧНАЯ ЛОГИКА БОТА ---
        const session = sessions.get(chatId);
        if (!session) {
            return bot.answerCallbackQuery(query.id, { text: '⚠️ Сессия устарела. Введите /start' });
        }

        try {
            if (data.startsWith('wall_')) {
                session.data.wallType = data.replace('wall_', '');
                session.step = 'IDLE'; 
                
                const area = session.data.area;
                const estCable = Math.ceil(area * 5);
                const estPoints = Math.ceil(area * 0.9);
                const estShield = Math.ceil(area / 15) + 4;
                const matCostM2 = 4000;

                const settings = await db.getSettings();
                
                const wallPrices = {
                    'light': parseInt(settings.wall_light) || 4500,
                    'medium': parseInt(settings.wall_medium) || 5500,
                    'heavy': parseInt(settings.wall_heavy) || 7500
                };

                const pricePerPoint = wallPrices[session.data.wallType] || 5500;
                const totalWork = estPoints * pricePerPoint;
                const totalMat = area * matCostM2;
                const totalSum = totalWork + totalMat;

                const wallLabel = { 'light': 'Легкие', 'medium': 'Средние', 'heavy': 'Тяжелые' }[session.data.wallType];

                // 1. Отправляем расчет клиенту
                await bot.sendMessage(chatId, `✅ <b>ПОЛНЫЙ РАСЧЕТ ДЛЯ ${area} м²</b>\n\n...`, { 
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🟢 Обсудить в WhatsApp', callback_data: 'contact_wa' }],
                            [{ text: '👷‍♂️ Записаться на замер', callback_data: 'contact_call' }]
                        ]
                    }
                });

                // 2. Сохраняем в базу и ПОЛУЧАЕМ ID нового заказа (RETURNING id)
                const userRes = await db.query('SELECT id FROM users WHERE telegram_id = $1', [query.from.id]);
                let leadId = null;
                if (userRes.rows.length > 0) {
                    const insertRes = await db.query(
                        `INSERT INTO leads (user_id, area, wall_type, total_work_cost, total_mat_cost)
                         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                        [userRes.rows[0].id, area, session.data.wallType, totalWork, totalMat]
                    );
                    leadId = insertRes.rows[0].id;
                }

                // 3. Уведомление в канал с ПРИВЯЗКОЙ к ID заказа
                await notifyAdmin(
                    `💰 <b>НОВЫЙ РАСЧЕТ #${leadId || '?' }</b>\n` +
                    `👤 @${query.from.username || 'скрыт'}\n` +
                    `📐 Объект: ${area} м² (${wallLabel})\n` +
                    `💵 Работа: ${formatKZT(totalWork)}`,
                    leadId // Теперь кнопки будут знать ID лида
                );

                session.data = {};
                sessions.set(chatId, session);
                return bot.answerCallbackQuery(query.id);
            }

            if (data.startsWith('contact_')) {
                const type = data.split('_')[1];
                const user = await db.query('SELECT phone FROM users WHERE telegram_id = $1', [query.from.id]);
                const phone = user.rows[0]?.phone || 'Номер не найден';

                await bot.sendMessage(chatId, '🚀 Заявка принята!');
                
                await notifyAdmin(
                    `🔥 <b>НУЖЕН КОНТАКТ!</b>\n` +
                    `Способ: ${type.toUpperCase()}\n` +
                    `👤 Клиент: @${query.from.username || 'скрыт'}\n` +
                    `📱 Тел: <code>${phone}</code>`,
                    null
                );
                
                return bot.answerCallbackQuery(query.id);
            }

        } catch (error) {
            console.error('💥 [CALLBACK ERROR]', error);
            bot.answerCallbackQuery(query.id, { text: '❌ Ошибка' });
        }
    });
};
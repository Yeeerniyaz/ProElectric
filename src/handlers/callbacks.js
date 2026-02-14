import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { sessions, notifyAdmin } from './messages.js';
import { ORDER_STATUS, STATUS_CONFIG } from '../constants.js'; // Импорт констант

// Форматтер валюты (для красоты: 1 000 000 ₸)
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

        // --- 1. АДМИНКА: УПРАВЛЕНИЕ ЗАКАЗАМИ (ИЗМЕНЕНИЕ СТАТУСА) ---
        if (data.startsWith('status_')) {
            const parts = data.split('_'); // [status, action, orderId]
            const action = parts[1]; // discuss, work, done, cancel
            const orderId = parts[2];

            // Берем настройки статуса из constants.js или локального объекта (для надежности)
            // Лучше использовать импорт, но если constants.js не подцепился, оставим фоллбэк:
            const labels = {
                'discuss': { text: 'В ОБСУЖДЕНИИ', icon: '🗣' },
                'work': { text: 'В РАБОТЕ', icon: '🏗' },
                'done': { text: 'РЕШЕНО', icon: '✅' },
                'cancel': { text: 'ОТКАЗ', icon: '❌' }
            };

            const cfg = STATUS_CONFIG && STATUS_CONFIG[action] 
                ? { text: STATUS_CONFIG[action].label, icon: STATUS_CONFIG[action].icon } 
                : labels[action];

            if (cfg && orderId) {
                try {
                    // Обновляем статус ИМЕННО В ТАБЛИЦЕ ORDERS
                    await db.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2', [action, orderId]);

                    const originalText = query.message.text || "";
                    // Убираем старый статус из текста (первую строку с иконкой)
                    const cleanedText = originalText.replace(/^.*СТАТУС:.*\n\n/g, '');
                    const updatedText = `${cfg.icon} <b>СТАТУС: ${cfg.text}</b>\n\n${cleanedText}`;

                    // Пытаемся обновить сообщение
                    await bot.editMessageText(updatedText, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML',
                        reply_markup: query.message.reply_markup 
                    });
                    
                    return bot.answerCallbackQuery(query.id, { text: `Заказ #${orderId}: ${cfg.text}` });

                } catch (e) {
                    // ИГНОРИРУЕМ ошибку "message is not modified" (это значит, статус уже стоит)
                    if (e.message && e.message.includes('message is not modified')) {
                        return bot.answerCallbackQuery(query.id, { text: '✅ Статус уже обновлен' });
                    }
                    
                    console.error('CRM Order Update Error:', e.message);
                    return bot.answerCallbackQuery(query.id, { text: '⚠️ Ошибка обновления' });
                }
            }
        }

        const session = sessions.get(chatId);
        
        // Если сессия протухла, а юзер пытается что-то нажать
        if (!session && data.startsWith('wall_')) {
             return bot.answerCallbackQuery(query.id, { text: '⚠️ Время вышло. Нажмите /start для нового расчета.' });
        }

        try {
            // --- 2. КЛИЕНТ ДЕЛАЕТ РАСЧЕТ (СОХРАНЯЕМ ТИХО В LEADS) ---
            if (data.startsWith('wall_')) {
                session.data.wallType = data.replace('wall_', '');
                session.step = 'IDLE';
                
                // --- МАТЕМАТИКА РАСЧЕТА ---
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
                const wallLabel = { 'light': 'Газоблок/ГКЛ', 'medium': 'Кирпич', 'heavy': 'Бетон/Монолит' }[session.data.wallType];
                // --------------------------

                // Сохраняем в LEADS
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

                const resultText = 
                    `⚡️ <b>СМЕТА НА ЭЛЕКТРОМОНТАЖ (${area} м²)</b>\n\n` +
                    `🧱 <b>Стены:</b> ${wallLabel}\n` +
                    `📋 <b>Материалы (примерно):</b>\n` +
                    ` • Кабель ВВГнг-LS: ~${estCable} м\n` +
                    ` • Подрозетники: ~${estPoints} шт\n` +
                    ` • Щит в сборе: ~${estShield} модулей\n\n` +
                    `💵 <b>Стоимость работ:</b> ${formatKZT(totalWork)}\n` +
                    `🔌 <b>Стоимость материалов:</b> ~${formatKZT(totalMat)}\n` +
                    `➖➖➖➖➖➖➖➖➖➖\n` +
                    `💰 <b>ИТОГО ПОД КЛЮЧ: ~${formatKZT(totalSum)}</b>\n\n` +
                    `<i>*Цена ориентировочная. Точная смета после замера.</i>`;

                await bot.sendMessage(chatId, resultText, { 
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💬 Обсудить в WhatsApp', callback_data: `create_order_wa_${leadId}` }],
                            [{ text: '👷‍♂️ Записаться на замер', callback_data: `create_order_call_${leadId}` }]
                        ]
                    }
                });
                
                sessions.set(chatId, session);
                return bot.answerCallbackQuery(query.id);
            }

            // --- 3. КЛИЕНТ НАЖАЛ "ЗАКАЗАТЬ" ---
            if (data.startsWith('create_order_')) {
                const parts = data.split('_'); 
                const type = parts[2]; 
                const leadId = parts[3];

                const user = await db.query('SELECT id, username, phone, first_name FROM users WHERE telegram_id = $1', [query.from.id]);
                if (user.rows.length === 0) return;
                const userData = user.rows[0];

                const orderRes = await db.query(
                    `INSERT INTO orders (user_id, lead_id, status) VALUES ($1, $2, 'new') RETURNING id`,
                    [userData.id, leadId]
                );
                const newOrderId = orderRes.rows[0].id;

                let msgClient = '✅ <b>Заявка принята!</b>\nМастер свяжется с вами в ближайшее время.';
                if (type === 'wa') msgClient = '✅ <b>Переходим в WhatsApp...</b>\n👉 https://wa.me/77066066323';
                
                await bot.sendMessage(chatId, msgClient, { parse_mode: 'HTML' });

                const leadInfo = await db.query('SELECT area, total_work_cost FROM leads WHERE id = $1', [leadId]);
                const lead = leadInfo.rows[0];

                await notifyAdmin(
                    `🔥 <b>НОВЫЙ ЗАКАЗ #${newOrderId}</b>\n` +
                    `👤 <b>Клиент:</b> ${userData.first_name} (@${userData.username || 'нет_юзера'})\n` +
                    `📱 <b>Тел:</b> <code>${userData.phone}</code>\n` +
                    `📐 <b>Объект:</b> ${lead.area} м²\n` +
                    `💰 <b>Смета:</b> ~${formatKZT(lead.total_work_cost)}\n` +
                    `🎯 <b>Действие:</b> ${type === 'wa' ? 'Нажал WhatsApp' : 'Запросил замер'}`,
                    newOrderId
                );

                return bot.answerCallbackQuery(query.id);
            }

        } catch (error) {
            console.error('💥 [CALLBACK ERROR]', error);
            bot.answerCallbackQuery(query.id, { text: '❌ Ошибка' });
        }
    });
};
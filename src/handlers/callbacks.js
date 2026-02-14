import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { sessions, notifyAdmin, handleAdminCommand } from './messages.js'; // 🔥 Добавил handleAdminCommand
import { STATUS_CONFIG } from '../constants.js';

// Форматтер валюты (1 000 000 ₸)
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
                const cmd = data.split('_')[1]; // stats, new, list...
                
                // Убираем часики
                await bot.answerCallbackQuery(id);
                
                // Логируем нажатие
                console.log(`🔘 [ADMIN] Нажата кнопка: ${cmd} в чате ${chatId}`);

                // Вызываем логику команд из messages.js
                // Передаем message и фейковый match, как будто это текстовая команда
                await handleAdminCommand(message, [null, cmd]);
                return;
            }

            // ====================================================
            // 2. УПРАВЛЕНИЕ ЗАКАЗАМИ (ИЗМЕНЕНИЕ СТАТУСА)
            // ====================================================
            if (data.startsWith('status_')) {
                const parts = data.split('_'); // [status, action, orderId]
                const action = parts[1]; // discuss, work, done, cancel
                const orderId = parts[2];

                const cfg = STATUS_CONFIG[action];

                if (cfg && orderId) {
                    // Обновляем статус в БД
                    await db.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2', [action, orderId]);

                    // Формируем новый текст сообщения
                    const originalText = message.text || "";
                    // Убираем старую строку статуса, если она была
                    const cleanedText = originalText.replace(/^.*СТАТУС:.*\n\n/g, '');
                    // Добавляем новую, красивую строку статуса + дату
                    const time = new Date().toLocaleTimeString('ru-RU', {hour: '2-digit', minute:'2-digit'});
                    const updatedText = `${cfg.icon} <b>СТАТУС: ${cfg.label} (обн. ${time})</b>\n\n${cleanedText}`;

                    try {
                        await bot.editMessageText(updatedText, {
                            chat_id: chatId,
                            message_id: message.message_id,
                            parse_mode: 'HTML',
                            reply_markup: message.reply_markup // Оставляем кнопки на месте
                        });
                        await bot.answerCallbackQuery(id, { text: `✅ Статус: ${cfg.label}` });
                    } catch (e) {
                        // Игнорируем ошибку, если текст не изменился
                        if (!e.message.includes('message is not modified')) {
                            console.error('Update Msg Error:', e.message);
                        }
                        await bot.answerCallbackQuery(id);
                    }
                }
                return;
            }

            // Проверка сессии для калькулятора
            const session = sessions.get(chatId);
            
            // Если сессии нет, а юзер тыкает кнопки стен
            if (!session && data.startsWith('wall_')) {
                 return bot.answerCallbackQuery(id, { 
                     text: '⚠️ Сессия устарела. Нажмите /start для нового расчета.', 
                     show_alert: true 
                 });
            }

            // ====================================================
            // 3. КАЛЬКУЛЯТОР (ВЫБОР СТЕН И РАСЧЕТ)
            // ====================================================
            if (data.startsWith('wall_')) {
                session.data.wallType = data.replace('wall_', '');
                session.step = 'IDLE';
                
                // --- МАТЕМАТИКА ---
                const area = session.data.area;
                const estCable = Math.ceil(area * 5); 
                const estPoints = Math.ceil(area * 0.9); 
                const estShield = Math.ceil(area / 15) + 4; 
                const matCostM2 = 4000; 

                // Получаем настройки цен (если есть метод, иначе фоллбэк)
                let wallPrices = { 'light': 4500, 'medium': 5500, 'heavy': 7500 };
                try {
                    // Если у тебя в db.js нет getSettings, этот блок просто пропустится
                    // const settings = await db.getSettings(); 
                    // if (settings) wallPrices = { ...wallPrices, ...settings };
                } catch (e) { console.log('Using default prices'); }

                const pricePerPoint = wallPrices[session.data.wallType] || 5500;
                const totalWork = estPoints * pricePerPoint;
                const totalMat = area * matCostM2;
                const totalSum = totalWork + totalMat;
                
                const wallLabel = { 'light': 'Газоблок/ГКЛ', 'medium': 'Кирпич', 'heavy': 'Бетон/Монолит' }[session.data.wallType];

                // Сохраняем в LEADS
                const userRes = await db.query('SELECT id FROM users WHERE telegram_id = $1', [from.id]);
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
                
                // Очищаем сессию, но не удаляем, чтобы не ломать логику (или удаляем sessions.delete(chatId))
                sessions.delete(chatId);
                return bot.answerCallbackQuery(id);
            }

            // ====================================================
            // 4. СОЗДАНИЕ ЗАКАЗА (КЛИЕНТ НАЖАЛ КНОПКУ)
            // ====================================================
            if (data.startsWith('create_order_')) {
                const parts = data.split('_'); 
                const type = parts[2]; // wa или call
                const leadId = parts[3];

                const user = await db.query('SELECT id, username, phone, first_name FROM users WHERE telegram_id = $1', [from.id]);
                if (user.rows.length === 0) return bot.answerCallbackQuery(id, { text: 'Ошибка пользователя' });
                const userData = user.rows[0];

                // Создаем заказ со статусом NEW
                const orderRes = await db.query(
                    `INSERT INTO orders (user_id, lead_id, status) VALUES ($1, $2, 'new') RETURNING id`,
                    [userData.id, leadId]
                );
                const newOrderId = orderRes.rows[0].id;

                let msgClient = '✅ <b>Заявка принята!</b>\nМастер свяжется с вами в ближайшее время.';
                if (type === 'wa') msgClient = '✅ <b>Переходим в WhatsApp...</b>\n👉 https://wa.me/77066066323';
                
                await bot.sendMessage(chatId, msgClient, { parse_mode: 'HTML' });

                // Получаем данные для админа
                const leadInfo = await db.query('SELECT area, total_work_cost FROM leads WHERE id = $1', [leadId]);
                const lead = leadInfo.rows[0];

                // Уведомляем админа в группу
                await notifyAdmin(
                    `🔥 <b>НОВЫЙ ЗАКАЗ #${newOrderId}</b>\n` +
                    `👤 <b>Клиент:</b> ${userData.first_name} (@${userData.username || 'нет_юзера'})\n` +
                    `📱 <b>Тел:</b> <code>${userData.phone}</code>\n` +
                    `📐 <b>Объект:</b> ${lead.area} м²\n` +
                    `💰 <b>Смета:</b> ~${formatKZT(lead.total_work_cost)}\n` +
                    `🎯 <b>Действие:</b> ${type === 'wa' ? 'Нажал WhatsApp' : 'Запросил замер'}`,
                    newOrderId // Передаем ID, чтобы notifyAdmin добавил кнопки управления
                );

                return bot.answerCallbackQuery(id);
            }

        } catch (error) {
            console.error('💥 [CALLBACK ERROR]', error);
            await bot.answerCallbackQuery(id, { text: '❌ Произошла ошибка' });
        }
    });
};
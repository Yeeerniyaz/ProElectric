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

        // --- ЛОГИКА CRM: ОБРАБОТКА СТАТУСОВ В КАНАЛЕ ---
        if (String(chatId) === String(config.bot.groupId)) {
            let statusText = '';
            let icon = '';

            switch (data) {
                case 'status_discuss': statusText = 'В ОБСУЖДЕНИИ'; icon = '🗣'; break;
                case 'status_work':    statusText = 'В РАБОТЕ';     icon = '🏗'; break;
                case 'status_done':    statusText = 'РЕШЕНО';       icon = '✅'; break;
                case 'status_cancel':  statusText = 'ОТКАЗ';        icon = '❌'; break;
            }

            if (statusText) {
                let originalText = query.message.text || "";
                // Очищаем текст от предыдущих меток статуса, если они были
                originalText = originalText.replace(/^.*СТАТУС:.*\n\n/g, '');

                const updatedText = `${icon} <b>СТАТУС: ${statusText}</b>\n\n${originalText}`;

                try {
                    await bot.editMessageText(updatedText, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML',
                        reply_markup: query.message.reply_markup // Оставляем кнопки управления
                    });
                    return bot.answerCallbackQuery(query.id, { text: `Статус: ${statusText}` });
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
            // Расчет сметы по типу стен
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

                const resultText = 
                    `✅ <b>ПОЛНЫЙ РАСЧЕТ ДЛЯ ${area} м²</b>\n\n` +
                    `🧱 Стены: <b>${wallLabel}</b>\n` +
                    `🛠 <b>Примерная спецификация:</b>\n` +
                    `— Кабель (ВВГнг-LS): <b>~${estCable} м.</b>\n` +
                    `— Электроточки (подрозетники): <b>~${estPoints} шт.</b>\n` +
                    `— Щит (автоматы/модули): <b>~${estShield} мод.</b>\n\n` +
                    `🛠 <b>Работа: ~${formatKZT(totalWork)}</b>\n` +
                    `🔌 <b>Материалы: ~${formatKZT(totalMat)}</b>\n` +
                    `➖➖➖➖➖➖➖➖\n` +
                    `💰 <b>ИТОГО: ~${formatKZT(totalSum)}</b>`;

                await bot.sendMessage(chatId, resultText, { 
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🟢 Обсудить в WhatsApp', callback_data: 'contact_wa' }],
                            [{ text: '👷‍♂️ Записаться на замер', callback_data: 'contact_call' }]
                        ]
                    }
                });

                const userRes = await db.query('SELECT id FROM users WHERE telegram_id = $1', [query.from.id]);
                if (userRes.rows.length > 0) {
                    await db.query(
                        `INSERT INTO leads (user_id, area, wall_type, total_work_cost, total_mat_cost)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [userRes.rows[0].id, area, session.data.wallType, totalWork, totalMat]
                    );
                }

                await notifyAdmin(
                    `💰 <b>НОВЫЙ РАСЧЕТ</b>\n` +
                    `👤 @${query.from.username || 'скрыт'}\n` +
                    `📐 Объект: ${area} м² (${wallLabel})\n` +
                    `💵 Работа: ${formatKZT(totalWork)}`
                );

                session.data = {};
                sessions.set(chatId, session);
                return bot.answerCallbackQuery(query.id);
            }

            // Запросы контактов
            if (data.startsWith('contact_')) {
                const type = data.split('_')[1];
                const user = await db.query('SELECT phone FROM users WHERE telegram_id = $1', [query.from.id]);
                const phone = user.rows[0]?.phone || 'Номер не найден';

                let responseMsg = '🚀 Заявка принята! Мастер свяжется с вами.';
                if (type === 'wa') responseMsg = '✅ WhatsApp: https://wa.me/77066066323';
                if (type === 'tg') responseMsg = '✅ Telegram: @yeeeerniyaz';

                await bot.sendMessage(chatId, responseMsg);
                
                await notifyAdmin(
                    `🔥 <b>НУЖЕН КОНТАКТ!</b>\n` +
                    `Способ: ${type.toUpperCase()}\n` +
                    `👤 Клиент: @${query.from.username || 'скрыт'}\n` +
                    `📱 Тел: <code>${phone}</code>`
                );
                
                return bot.answerCallbackQuery(query.id);
            }

        } catch (error) {
            console.error('💥 [CALLBACK ERROR]', error);
            bot.answerCallbackQuery(query.id, { text: '❌ Ошибка' });
        }
    });
};
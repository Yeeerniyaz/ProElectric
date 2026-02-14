import { bot } from '../core.js';
import { db } from '../db.js';
import { sessions, notifyAdmin } from './messages.js';

/**
 * 🛠 Форматтер валюты (Казахстанский тенге)
 * Использование международного стандарта Intl для точности расчетов.
 */
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
        const session = sessions.get(chatId);

        // Fail-safe: защита от нажатий на старые кнопки после перезапуска
        if (!session) {
            return bot.answerCallbackQuery(query.id, { text: '⚠️ Сессия устарела. Введите /start' });
        }

        try {
            // --- ЭТАП 2: ВЫБОР СТЕН (Три уровня сложности) ---
            if (data.startsWith('wall_')) {
                session.data.wallType = data.replace('wall_', '');
                session.step = 'IDLE'; // Сбрасываем в ожидание для корректной работы меню
                
                const area = session.data.area;

                // 🧮 ЭМПИРИЧЕСКИЙ РАСЧЕТ (Профессиональные коэффициенты)
                const estCable = Math.ceil(area * 5);        // В среднем 5 метров на 1 м²
                const estPoints = Math.ceil(area * 0.9);     // В среднем 0.9 точки на 1 м²
                const estShield = Math.ceil(area / 15) + 4;  // Автоматы (1 на 15м² + 4 силовых)
                const matCostM2 = 4000;                      // Средняя цена черновых материалов на м² в Алматы

                // Тянем цены из БД или используем рыночные дефолты
                const settings = await db.getSettings();
                
                const wallPrices = {
                    'light': parseInt(settings.wall_light) || 4500,   // Газоблок/ГКЛ
                    'medium': parseInt(settings.wall_medium) || 5500,  // Кирпич
                    'heavy': parseInt(settings.wall_heavy) || 7500    // Монолит/Бетон
                };

                const pricePerPoint = wallPrices[session.data.wallType] || 5500;
                const totalWork = estPoints * pricePerPoint;
                const totalMat = area * matCostM2;
                const totalSum = totalWork + totalMat;

                const wallLabel = { 'light': 'Легкие', 'medium': 'Средние', 'heavy': 'Тяжелые' }[session.data.wallType];

                // 📄 ФОРМИРОВАНИЕ ПОДРОБНОЙ СМЕТЫ
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
                    `💰 <b>ИТОГО: ~${formatKZT(totalSum)}</b>\n\n` +
                    `<i>⚠️ Смета предварительная (+-15%). Точный расчет возможен только после замера на объекте.</i>`;

                await bot.sendMessage(chatId, resultText, { 
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🟢 Обсудить в WhatsApp', callback_data: 'contact_wa' }],
                            [{ text: '👷‍♂️ Записаться на замер', callback_data: 'contact_call' }]
                        ]
                    }
                });

                // --- СОХРАНЕНИЕ И УВЕДОМЛЕНИЕ ---
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
                    `💵 Работа: ${formatKZT(totalWork)}\n` +
                    `🔌 Материалы: ${formatKZT(totalMat)}`
                );

                // Очищаем временные данные, оставляем сессию в IDLE
                session.data = {};
                sessions.set(chatId, session);
                
                return bot.answerCallbackQuery(query.id);
            }

            // --- ОБРАБОТКА КОНТАКТОВ (WA / TG / ЗВОНОК) ---
            if (data.startsWith('contact_')) {
                const type = data.split('_')[1];
                const user = await db.query('SELECT phone FROM users WHERE telegram_id = $1', [query.from.id]);
                const phone = user.rows[0]?.phone || 'Номер не найден';

                let responseMsg = '🚀 Заявка принята! Мастер свяжется с вами в ближайшее время.';
                if (type === 'wa') responseMsg = '✅ Переходите в чат WhatsApp: https://wa.me/77066066323';
                if (type === 'tg') responseMsg = '✅ Пишите мастеру в Telegram: @yeeeerniyaz';

                await bot.sendMessage(chatId, responseMsg);
                
                // Моментальное уведомление в канал с активной ссылкой
                await notifyAdmin(
                    `🔥 <b>НУЖЕН КОНТАКТ!</b>\n` +
                    `Способ: ${type.toUpperCase()}\n` +
                    `👤 Клиент: @${query.from.username || 'скрыт'}\n` +
                    `📱 Тел: <code>${phone}</code>\n` +
                    `<i>Пожалуйста, свяжитесь с клиентом.</i>`
                );
                
                return bot.answerCallbackQuery(query.id);
            }

        } catch (error) {
            console.error('💥 [CALLBACK ERROR]', error);
            bot.answerCallbackQuery(query.id, { text: '❌ Ошибка в обработке' });
        }
    });
};
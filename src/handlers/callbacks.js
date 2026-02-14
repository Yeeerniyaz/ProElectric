import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { sessions } from './messages.js';

/**
 * 🛠 Форматтер валюты (Казахстанский тенге)
 * Senior-подход: использование международного стандарта Intl для точности
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

        // Проверка сессии: защита от падения, если юзер нажал кнопку после перезагрузки сервера
        if (!session) {
            return bot.answerCallbackQuery(query.id, { text: '⚠️ Сессия устарела. Введите /start' });
        }

        try {
            // --- ШАГ 2: ВЫБОР СТЕН -> ПЕРЕХОД К ТИПУ МОНТАЖА ---
            if (data.startsWith('wall_')) {
                session.data.wallType = data.replace('wall_', '');
                session.step = 'WAITING_FOR_MOUNTING';
                sessions.set(chatId, session);

                await bot.editMessageText(
                    `🧱 Стены: <b>${session.data.wallType.toUpperCase()}</b>\n\n` +
                    `<b>Шаг 3/5: Тип монтажа</b>\nГде прокладываем основные трассы?`, 
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '☁️ По потолку (в гофре)', callback_data: 'mount_ceiling' }],
                                [{ text: '🚜 По полу (в стяжке)', callback_data: 'mount_floor' }]
                            ]
                        }
                    }
                );
                return bot.answerCallbackQuery(query.id);
            }

            // --- ШАГ 3: ТИП МОНТАЖА -> ВЫБОР БРЕНДА ---
            if (data.startsWith('mount_')) {
                session.data.mountingType = data.replace('mount_', '');
                session.step = 'WAITING_FOR_BRAND';
                sessions.set(chatId, session);

                await bot.editMessageText(
                    `⚙️ Монтаж: <b>${session.data.mountingType === 'ceiling' ? 'ПОТОЛОК' : 'ПОЛ'}</b>\n\n` +
                    `<b>Шаг 4/5: Уровень оборудования</b>\nВыбери надежность и бюджет:`, 
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🥉 Эконом (IEK / Karat)', callback_data: 'brand_economy' }],
                                [{ text: '🥈 Стандарт (Schneider / Resi9)', callback_data: 'brand_standard' }],
                                [{ text: '🥇 Премиум (ABB / Hager)', callback_data: 'brand_premium' }]
                            ]
                        }
                    }
                );
                return bot.answerCallbackQuery(query.id);
            }

            // --- ШАГ 4: ВЫБОР БРЕНДА И ФИНАЛЬНЫЙ РАСЧЕТ ---
            if (data.startsWith('brand_')) {
                session.data.brandLevel = data.replace('brand_', '');
                bot.sendChatAction(chatId, 'typing');

                // 🧮 ТЯНЕМ АКТУАЛЬНЫЕ ЦЕНЫ ИЗ ТВОЕГО "ДАШБОРДА" (SQL Settings)
                const settings = await db.getSettings();
                
                // 1. Расчет работы (Цена точки * Коэффициент монтажа * Кол-во точек)
                const basePrice = settings[`wall_${session.data.wallType}`] || 4500;
                const markup = settings[`markup_${session.data.mountingType}`] || 1.0;
                const pointsCount = Math.ceil(session.data.area * 1.5); // Эвристика: ~1.5 точки на м2
                const totalWork = pointsCount * basePrice * markup;

                // 2. Расчет материалов (Цена за м2 в зависимости от бренда)
                const matPriceKey = `mat_m2_${session.data.brandLevel}`;
                const matPricePerM2 = settings[matPriceKey] || 2500;
                const totalMat = session.data.area * matPricePerM2;

                const totalSum = totalWork + totalMat;

                // --- СОХРАНЕНИЕ ЛИДА В БД ДЛЯ АНАЛИТИКИ ---
                const userRes = await db.query('SELECT id FROM users WHERE telegram_id = $1', [query.from.id]);
                if (userRes.rows.length > 0) {
                    await db.query(
                        `INSERT INTO leads (user_id, area, wall_type, mounting_type, brand_level, total_work_cost, total_mat_cost)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [userRes.rows[0].id, session.data.area, session.data.wallType, session.data.mountingType, session.data.brandLevel, totalWork, totalMat]
                    );
                }

                const resultText = 
                    `✅ <b>Ваш расчет готов!</b>\n\n` +
                    `📐 Площадь: ${session.data.area} м²\n` +
                    `🧱 Стены: ${session.data.wallType}\n` +
                    `⚡️ Класс: ${session.data.brandLevel.toUpperCase()}\n` +
                    `➖➖➖➖➖➖➖➖\n` +
                    `🛠 <b>Работа: ~${formatKZT(totalWork)}</b>\n` +
                    `🔌 <b>Материалы: ~${formatKZT(totalMat)}</b>\n` +
                    `➖➖➖➖➖➖➖➖\n` +
                    `💰 <b>ИТОГО: ~${formatKZT(totalSum)}</b>\n\n` +
                    `<i>⚠️ Это предварительная смета (+-15%). Мы работаем честно: оплата за работу и материалы раздельно.</i>`;

                await bot.sendMessage(chatId, resultText, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📦 Заказать закуп под ключ (30к)', callback_data: 'order_procurement' }],
                            [{ text: '👷‍♂️ Вызвать инженера на замер', callback_data: 'order_zamer' }]
                        ]
                    }
                });

                sessions.delete(chatId); // Задача выполнена — очищаем память
                return bot.answerCallbackQuery(query.id);
            }

            // --- ОБРАБОТКА ЗАЯВОК (Замер / Закуп) ---
            if (data === 'order_zamer' || data === 'order_procurement') {
                const isProcurement = data === 'order_procurement';
                await bot.sendMessage(chatId, '🚀 Заявка принята! Инженер свяжется с вами в течение 15 минут.');
                
                if (config.bot.groupId) {
                    bot.sendMessage(config.bot.groupId, 
                        `🔥 <b>ГОРЯЧИЙ ЛИД: ${isProcurement ? 'ЗАКУП' : 'ЗАМЕР'}</b>\n` +
                        `👤 Клиент: @${query.from.username || 'скрыт'}\n` +
                        `📱 ID: <code>${query.from.id}</code>\n` +
                        `Уже авторизован, можно звонить!`, 
                        { parse_mode: 'HTML' }
                    );
                }
                return bot.answerCallbackQuery(query.id, { text: 'Отправлено!' });
            }

        } catch (error) {
            console.error('💥 [CALLBACK ERROR]', error);
            bot.answerCallbackQuery(query.id, { text: '❌ Ошибка в расчетах' });
        }
    });
};
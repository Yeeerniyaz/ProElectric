import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../bot.js';
import { sessions } from './messages.js'; // Берем данные о площади из сессии

/**
 * 🛠 Хелпер для форматирования денег (пр: 150 000 ₸)
 */
const formatCurrency = (num) => {
    return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT' }).format(num);
};

export const setupCallbackHandlers = () => {
    
    // Слушаем нажатия инлайн-кнопок
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;
        const messageId = query.message.message_id;

        // Получаем текущую сессию пользователя
        const session = sessions.get(chatId);

        if (!session) {
            return bot.answerCallbackQuery(query.id, { text: '⚠️ Сессия устарела. Введите /start' });
        }

        try {
            // --- ШАГ 2: ВЫБОР СТЕН ---
            if (session.step === 'WAITING_FOR_WALLS' && data.startsWith('wall_')) {
                const wallType = data.replace('wall_', ''); // brick, concrete, block
                session.data.wallType = wallType;
                
                // Следующий шаг: Выбор метода сборки
                session.step = 'WAITING_FOR_METHOD';
                sessions.set(chatId, session);

                // Редактируем старое сообщение (UX лучше, чем слать новое)
                await bot.editMessageText(
                    `🧱 Стены: <b>${wallType.toUpperCase()}</b>\n\n` +
                    `<b>Шаг 3/3: Метод сборки</b>\n` +
                    `Как будем собирать схему?`, 
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📦 Распредкоробки (Классика)', callback_data: 'method_box' }],
                                [{ text: '⚡️ Без коробок (В щит, дороже)', callback_data: 'method_shield' }]
                            ]
                        }
                    }
                );
                return bot.answerCallbackQuery(query.id);
            }

            // --- ШАГ 3: ВЫБОР МЕТОДА И РАСЧЕТ ---
            if (session.step === 'WAITING_FOR_METHOD' && data.startsWith('method_')) {
                const methodType = data.replace('method_', ''); // box, shield
                session.data.methodType = methodType;

                // ⏳ Отправляем "печатает...", пока считаем математику
                bot.sendChatAction(chatId, 'typing');

                // --- 💰 ФИНАНСОВОЕ ЯДРО ---
                // Тянем актуальные цены из БД (таблица settings)
                const settingsRes = await db.query('SELECT key, value FROM settings');
                const settings = {};
                settingsRes.rows.forEach(row => settings[row.key] = parseFloat(row.value));

                // 1. Базовая цена за точку (зависит от стен)
                let basePrice = settings[`wall_${session.data.wallType}`] || 3500;
                
                // 2. Наценка за метод (если коробки - дешевле/стандарт, если щит - дороже)
                // Допустим, в базе stored: markup_box = 1.0, markup_shield = 1.3
                // Если настроек нет, берем дефолт
                let markup = methodType === 'shield' ? 1.3 : 1.0; 
                if (methodType === 'box' && settings['markup_box']) markup = settings['markup_box'];

                // 3. Формула сметы (Эвристика: Площадь * ~1.5 точки на м2 * Цену)
                // Это упрощенная модель для бота. В реальности точек может быть больше.
                const pointsPerM2 = 1.5; 
                const estimatedPoints = Math.ceil(session.data.area * pointsPerM2);
                
                let totalWorkCost = estimatedPoints * basePrice * markup;
                
                // Черновые материалы (кабель, гофра) ~ 1200 тг/м2
                const materialCost = session.data.area * (settings['cable_cost_per_m2'] || 1200);

                const totalEstimate = totalWorkCost + materialCost;

                // --- СОХРАНЕНИЕ В БД ---
                // Пишем в историю, чтобы ты видел лиды
                const userRes = await db.query('SELECT id FROM users WHERE telegram_id = $1', [query.from.id]);
                if (userRes.rows.length > 0) {
                    await db.query(
                        `INSERT INTO leads (user_id, area, wall_type, method_type, estimated_price)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [userRes.rows[0].id, session.data.area, session.data.wallType, methodType, totalEstimate]
                    );
                }

                // --- ОТПРАВКА РЕЗУЛЬТАТА ---
                const resultText = 
                    `✅ <b>Расчет готов!</b>\n\n` +
                    `📐 Площадь: ${session.data.area} м²\n` +
                    `🧱 Стены: ${session.data.wallType}\n` +
                    `⚙️ Метод: ${methodType === 'box' ? 'С коробками' : 'Лучевая (без коробок)'}\n` +
                    `➖➖➖➖➖➖➖➖\n` +
                    `💼 Работа: ~${formatCurrency(totalWorkCost)}\n` +
                    `🔌 Черновые материалы: ~${formatCurrency(materialCost)}\n` +
                    `➖➖➖➖➖➖➖➖\n` +
                    `💰 <b>ИТОГО ПОД КЛЮЧ: ~${formatCurrency(totalEstimate)}</b>\n\n` +
                    `<i>⚠️ Это предварительный расчет (+-15%). Точная смета только после замера.</i>\n\n` +
                    `Нажмите кнопку ниже, чтобы пригласить инженера на замер.`;

                await bot.sendMessage(chatId, resultText, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: '👷‍♂️ Вызвать на замер (Бесплатно)', callback_data: 'order_zamer' }]]
                    }
                });

                // Очищаем сессию (задача выполнена)
                sessions.delete(chatId);
                
                return bot.answerCallbackQuery(query.id);
            }

            // --- ЗАЯВКА НА ЗАМЕР ---
            if (data === 'order_zamer') {
                await bot.sendMessage(chatId, '✅ Заявка принята! Инженер свяжется с вами в течение 15 минут.');
                
                // Уведомление тебе в группу
                if (config.groupId) {
                    bot.sendMessage(config.groupId, 
                        `🔥 <b>ГОРЯЧИЙ ЛИД! (Заявка на замер)</b>\n` +
                        `Клиент: @${query.from.username} (ID: ${query.from.id})\n` +
                        `Хочет замер! Срочно звонить!`,
                        { parse_mode: 'HTML' }
                    );
                }
                return bot.answerCallbackQuery(query.id, { text: 'Отправлено!' });
            }

        } catch (error) {
            console.error('[CALLBACK ERROR]', error);
            bot.answerCallbackQuery(query.id, { text: 'Ошибка вычислений' });
        }
    });
};
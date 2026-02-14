import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';

// Хранилище сессий для управления шагами пользователя
export const sessions = new Map();

/**
 * 📢 Senior-уведомитель для канала ProElectro LEAD
 * isLead: если true — добавляем кнопки CRM, если false — просто текст (для регистраций)
 */
export const notifyAdmin = async (text, isLead = false) => {
    if (!config.bot.groupId) return;

    const options = { parse_mode: 'HTML' };

    if (isLead) {
        options.reply_markup = {
            inline_keyboard: [
                [
                    { text: '🗣 Обсуждение', callback_data: 'status_discuss' },
                    { text: '🏗 В работе', callback_data: 'status_work' }
                ],
                [
                    { text: '✅ Решено', callback_data: 'status_done' },
                    { text: '❌ Отказ', callback_data: 'status_cancel' }
                ]
            ]
        };
    }

    try {
        await bot.sendMessage(config.bot.groupId, text, options);
    } catch (e) {
        console.error('⚠️ [NOTIFY ERROR]:', e.message);
    }
};

const KB = {
    MAIN_MENU: {
        reply_markup: {
            keyboard: [
                ['⚡️ Рассчитать смету', '📂 Мои расчеты'],
                ['💬 Обратная связь', 'ℹ️ О компании']
            ],
            resize_keyboard: true
        }
    },
    CONTACT: {
        reply_markup: {
            keyboard: [[{ text: '📱 Отправить свой контакт', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    }
};

export const setupMessageHandlers = () => {
    // СЕКРЕТНАЯ КОМАНДА: Выгрузка списка всех лидов для тебя
    bot.onText(/\/list/, async (msg) => {
        // Доступ только для Ернияза
        if (msg.from.id.toString() !== "2041384570") return;

        try {
            const res = await db.query(`
                SELECT u.first_name, u.phone, l.area, l.total_work_cost, l.created_at 
                FROM leads l 
                JOIN users u ON l.user_id = u.id 
                ORDER BY l.created_at DESC LIMIT 20
            `);

            if (res.rows.length === 0) {
                return bot.sendMessage(msg.chat.id, "📭 Список лидов пока пуст.");
            }

            let response = "📋 <b>ПОСЛЕДНИЕ 20 ЗАЯВОК:</b>\n\n";
            res.rows.forEach((row, i) => {
                const date = new Date(row.created_at).toLocaleDateString('ru-RU');
                response += `${i + 1}. 👤 ${row.first_name} | 📱 <code>${row.phone}</code>\n`;
                response += `   📐 ${row.area}м² | 💰 ~${Math.round(row.total_work_cost).toLocaleString()}₸ | 📅 ${date}\n\n`;
            });

            await bot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });
        } catch (e) {
            console.error('💥 [LIST ERROR]:', e);
        }
    });

    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            const res = await db.query('SELECT phone FROM users WHERE telegram_id = $1', [msg.from.id]);
            if (res.rows.length > 0 && res.rows[0].phone) {
                sessions.set(chatId, { step: 'IDLE', data: {} });
                await bot.sendMessage(chatId, `Салам, ${msg.from.first_name}! Объект ждет? Давай посчитаем.`, KB.MAIN_MENU);
            } else {
                await bot.sendMessage(chatId, '👋 Привет! Я бот ProElectro. Подтверди номер, чтобы пользоваться калькулятором.', KB.CONTACT);
            }
        } catch (e) {
            console.error('💥 [START ERROR]:', e);
        }
    });

    bot.on('contact', async (msg) => {
        const chatId = msg.chat.id;
        if (msg.contact.user_id !== msg.from.id) return;
        
        try {
            await db.upsertUser(msg.from.id, msg.from.first_name, msg.from.username, msg.contact.phone_number);
            sessions.set(chatId, { step: 'IDLE', data: {} });
            
            // Простое уведомление без кнопок CRM
            await notifyAdmin(
                `🆕 <b>НОВЫЙ ПОЛЬЗОВАТЕЛЬ</b>\n` +
                `👤 Имя: ${msg.from.first_name}\n` +
                `📱 Тел: <code>${msg.contact.phone_number}</code>\n` +
                `🔗 Линк: @${msg.from.username || 'скрыт'}`,
                false
            );
            
            await bot.sendMessage(chatId, '✅ Доступ открыт! Теперь ты можешь рассчитать смету.', KB.MAIN_MENU);
        } catch (e) {
            console.error('💥 [CONTACT ERROR]:', e);
        }
    });

    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/') || msg.contact) return;
        const chatId = msg.chat.id;
        let session = sessions.get(chatId) || { step: 'IDLE', data: {} };

        if (msg.text === '⚡️ Рассчитать смету') {
            session.step = 'WAITING_FOR_AREA';
            sessions.set(chatId, session);
            
            // Уведомление о проявленном интересе (без кнопок)
            await notifyAdmin(`🔍 @${msg.from.username || msg.from.id} зашел в калькулятор...`, false);
            
            await bot.sendMessage(chatId, '📏 Введите площадь помещения в м² (например, 65):', {
                reply_markup: { remove_keyboard: true }
            });
            return;
        }

        if (msg.text === '💬 Обратная связь') {
            await bot.sendMessage(chatId, 'Как вам удобнее связаться с мастером?', {
                reply_markup: { 
                    inline_keyboard: [
                        [{ text: '🟢 Написать в WhatsApp', callback_data: 'contact_wa' }],
                        [{ text: '🔵 Написать в Telegram', callback_data: 'contact_tg' }],
                        [{ text: '📞 Жду обратной связи', callback_data: 'contact_call' }]
                    ]
                }
            });
            return;
        }

        if (msg.text === '📂 Мои расчеты') {
            try {
                const res = await db.query(
                    'SELECT area, total_work_cost, created_at FROM leads WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1) ORDER BY created_at DESC LIMIT 3',
                    [msg.from.id]
                );
                
                if (res.rows.length === 0) {
                    return bot.sendMessage(chatId, 'У вас пока нет сохраненных расчетов.', KB.MAIN_MENU);
                }
                
                let text = '📂 <b>Ваши последние расчеты:</b>\n\n';
                res.rows.forEach((r, i) => {
                    text += `${i+1}. ${r.area} м² — ${Math.round(r.total_work_cost).toLocaleString()} ₸\n`;
                });
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML' }, KB.MAIN_MENU);
            } catch (e) {
                console.error('💥 [HISTORY ERROR]:', e);
            }
            return;
        }

        if (session.step === 'WAITING_FOR_AREA') {
            const area = parseFloat(msg.text.replace(',', '.'));
            if (isNaN(area) || area <= 0) {
                return bot.sendMessage(chatId, '⚠️ Введите корректное число (площадь).');
            }
            session.data.area = area;
            session.step = 'WAITING_FOR_WALLS';
            sessions.set(chatId, session);

            await bot.sendMessage(chatId, `Объект: ${area} м². Какая сложность стен?`, {
                reply_markup: { 
                    inline_keyboard: [
                        [{ text: '🟢 Легкие (Газоблок/ГКЛ)', callback_data: 'wall_light' }],
                        [{ text: '🟡 Средние (Кирпич)', callback_data: 'wall_medium' }],
                        [{ text: '🔴 Тяжелые (Монолит/Бетон)', callback_data: 'wall_heavy' }]
                    ]
                }
            });
        }
    });
};
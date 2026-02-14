import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';

// Хранилище сессий для управления шагами пользователя
export const sessions = new Map();

/**
 * 📢 Senior-уведомитель для канала ProElectro LEAD
 * leadId: передаем ID из базы, чтобы кнопки управляли конкретным заказом
 */
export const notifyAdmin = async (text, leadId = null) => {
    if (!config.bot.groupId) return;

    const options = { parse_mode: 'HTML' };

    if (leadId) {
        options.reply_markup = {
            inline_keyboard: [
                [
                    { text: '🗣 Обсуждение', callback_data: `status_discuss_${leadId}` },
                    { text: '🏗 В работе', callback_data: `status_work_${leadId}` }
                ],
                [
                    { text: '✅ Решено', callback_data: `status_done_${leadId}` },
                    { text: '❌ Отказ', callback_data: `status_cancel_${leadId}` }
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
    
    // --- ГРУППА АДМИН-КОМАНД (stats, new, discuss, work, done, cancel, list) ---
    bot.onText(/\/(stats|new|discuss|work|done|cancel|list)/, async (msg, match) => {
        if (msg.from.id.toString() !== "2041384570") return;
        const cmd = match[1];

        try {
            if (cmd === 'stats') {
                const res = await db.query(`
                    SELECT status, COUNT(*), SUM(total_work_cost) as total 
                    FROM leads GROUP BY status
                `);
                
                let statsMsg = "📊 <b>АНАЛИТИКА PROELECTRO:</b>\n\n";
                const labels = {
                    'new': '🆕 Новые', 'discuss': '🗣 Обсуждение', 
                    'work': '🏗 В работе', 'done': '✅ Решено', 'cancel': '❌ Отказ'
                };

                let grandTotal = 0;
                res.rows.forEach(r => {
                    const label = labels[r.status] || r.status;
                    const sum = Math.round(r.total || 0);
                    statsMsg += `${label}: <b>${r.count} шт.</b> (~${sum.toLocaleString()} ₸)\n`;
                    if (r.status !== 'cancel') grandTotal += sum;
                });
                
                statsMsg += `\n💰 Потенциал (без отказов): <b>${grandTotal.toLocaleString()} ₸</b>`;
                return bot.sendMessage(msg.chat.id, statsMsg, { parse_mode: 'HTML' });
            }

            const statusFilter = cmd === 'list' ? '%' : cmd;
            const res = await db.query(`
                SELECT l.id, u.first_name, u.phone, l.area, l.total_work_cost, l.status, l.created_at 
                FROM leads l 
                JOIN users u ON l.user_id = u.id 
                WHERE l.status LIKE $1 
                ORDER BY l.created_at DESC LIMIT 20
            `, [statusFilter]);

            if (res.rows.length === 0) {
                return bot.sendMessage(msg.chat.id, `📭 Категория [${cmd.toUpperCase()}] пуста.`);
            }

            let response = `📋 <b>СПИСОК [${cmd.toUpperCase()}]:</b>\n\n`;
            res.rows.forEach((row, i) => {
                const date = new Date(row.created_at).toLocaleDateString('ru-RU');
                response += `${i + 1}. ID: ${row.id} | 👤 ${row.first_name}\n`;
                response += `   📱 <code>${row.phone}</code> | 📐 ${row.area}м²\n`;
                response += `   💰 ~${Math.round(row.total_work_cost).toLocaleString()}₸ | [${row.status}] | ${date}\n\n`;
            });

            await bot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });
        } catch (e) {
            console.error('💥 [CRM CMD ERROR]:', e);
        }
    });

    // --- СТАНДАРТНЫЕ ФУНКЦИИ ---
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
        } catch (e) { console.error(e); }
    });

    bot.on('contact', async (msg) => {
        const chatId = msg.chat.id;
        if (msg.contact.user_id !== msg.from.id) return;
        await db.upsertUser(msg.from.id, msg.from.first_name, msg.from.username, msg.contact.phone_number);
        sessions.set(chatId, { step: 'IDLE', data: {} });
        
        await notifyAdmin(
            `🆕 <b>НОВЫЙ ПОЛЬЗОВАТЕЛЬ</b>\n` +
            `👤 Имя: ${msg.from.first_name}\n` +
            `📱 Тел: <code>${msg.contact.phone_number}</code>`,
            null // Тут кнопок CRM не нужно
        );
        
        await bot.sendMessage(chatId, '✅ Доступ открыт!', KB.MAIN_MENU);
    });

    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/') || msg.contact) return;
        const chatId = msg.chat.id;
        let session = sessions.get(chatId) || { step: 'IDLE', data: {} };

        if (msg.text === '⚡️ Рассчитать смету') {
            session.step = 'WAITING_FOR_AREA';
            sessions.set(chatId, session);
            await bot.sendMessage(chatId, '📏 Введите площадь помещения в м²:', { reply_markup: { remove_keyboard: true } });
            return;
        }

        if (msg.text === '📂 Мои расчеты') {
            const res = await db.query('SELECT area, total_work_cost FROM leads WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1) ORDER BY created_at DESC LIMIT 3', [msg.from.id]);
            if (res.rows.length === 0) return bot.sendMessage(chatId, 'Расчетов нет.', KB.MAIN_MENU);
            let text = '📂 <b>Ваши последние расчеты:</b>\n\n';
            res.rows.forEach(r => text += `— ${r.area} м²: ~${Math.round(r.total_work_cost).toLocaleString()} ₸\n`);
            await bot.sendMessage(chatId, text, { parse_mode: 'HTML' }, KB.MAIN_MENU);
            return;
        }

        if (session.step === 'WAITING_FOR_AREA') {
            const area = parseFloat(msg.text.replace(',', '.'));
            if (isNaN(area) || area <= 0) return bot.sendMessage(chatId, '⚠️ Введите число.');
            session.data.area = area;
            session.step = 'WAITING_FOR_WALLS';
            sessions.set(chatId, session);
            await bot.sendMessage(chatId, `Объект: ${area} м². Какая сложность стен?`, {
                reply_markup: { inline_keyboard: [
                    [{ text: '🟢 Легкие', callback_data: 'wall_light' }],
                    [{ text: '🟡 Средние', callback_data: 'wall_medium' }],
                    [{ text: '🔴 Тяжелые', callback_data: 'wall_heavy' }]
                ]}
            });
        }
    });
};
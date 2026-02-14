import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { ORDER_STATUS, STATUS_CONFIG } from '../constants.js';

// 1. Экспортируем сессии, чтобы callbacks.js мог читать данные калькулятора
export const sessions = new Map();

/**
 * Уведомление в админ-чат
 */
export const notifyAdmin = async (text, orderId = null) => {
    if (!config.bot.groupId) return;
    const options = { parse_mode: 'HTML' };

    if (orderId) {
        options.reply_markup = {
            inline_keyboard: [
                [
                    { text: '🗣 Обсуждение', callback_data: `status_${ORDER_STATUS.DISCUSS}_${orderId}` },
                    { text: '🏗 В работе',    callback_data: `status_${ORDER_STATUS.WORK}_${orderId}` }
                ],
                [
                    { text: '✅ Решено',      callback_data: `status_${ORDER_STATUS.DONE}_${orderId}` },
                    { text: '❌ Отказ',       callback_data: `status_${ORDER_STATUS.CANCEL}_${orderId}` }
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

// Клавиатуры
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
    },
    ADMIN_INLINE: {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📊 Статистика', callback_data: 'adm_stats' },
                    { text: '🆕 Новые', callback_data: 'adm_new' }
                ],
                [
                    { text: '💬 Обсуждение', callback_data: 'adm_discuss' },
                    { text: '⚡️ В работе', callback_data: 'adm_work' }
                ],
                [
                    { text: '✅ Готово', callback_data: 'adm_done' },
                    { text: '📋 Весь список', callback_data: 'adm_list' }
                ]
            ]
        },
        parse_mode: 'HTML'
    }
};

// ============================================================
// 2. ЛОГИКА АДМИНА (ВЫНЕСЕНА НАРУЖУ + EXPORT)
// ============================================================
export const handleAdminCommand = async (msg, match) => {
    const cmd = match[1];
    // В канале msg.chat.id может быть числом, приводим к строке
    const chatId = msg.chat.id.toString();
    const myAdminId = "2041384570";
    const groupAdminId = config.bot.groupId ? config.bot.groupId.toString() : '';

    const isPrivateAdmin = msg.from && msg.from.id.toString() === myAdminId;
    const isGroupAdmin = groupAdminId && chatId === groupAdminId;

    // Для кнопок msg.from может не быть, поэтому проверяем чат
    if (!isPrivateAdmin && !isGroupAdmin) {
        console.log(`❌ [ACCESS DENIED] ChatID: ${chatId}`);
        return;
    }

    console.log(`👇 [DEBUG] Команда /${cmd} принята в чате ${chatId}`);

    try {
        // --- СТАТИСТИКА (/stats) ---
        if (cmd === 'stats') {
            const res = await db.query(`
                SELECT o.status, COUNT(*), SUM(l.total_work_cost) as total 
                FROM orders o
                JOIN leads l ON o.lead_id = l.id
                GROUP BY o.status
            `);
            
            let statsMsg = "📊 <b>ВОРОНКА ПРОДАЖ (ORDERS):</b>\n\n";
            let grandTotal = 0;

            res.rows.forEach(r => {
                const cfg = STATUS_CONFIG[r.status] || { label: r.status, icon: '❓' };
                const sum = Math.round(r.total || 0);
                statsMsg += `${cfg.icon} ${cfg.label}: <b>${r.count} шт.</b> (~${sum.toLocaleString()} ₸)\n`;
                if (r.status !== ORDER_STATUS.CANCEL) grandTotal += sum;
            });
            
            statsMsg += `\n💰 <b>ПОТЕНЦИАЛ: ~${grandTotal.toLocaleString()} ₸</b>`;
            return bot.sendMessage(chatId, statsMsg, { parse_mode: 'HTML' });
        }

        // --- СПИСКИ ЗАКАЗОВ (/list, /new...) ---
        const statusFilter = cmd === 'list' ? '%' : cmd;
        const res = await db.query(`
            SELECT o.id, u.first_name, u.phone, l.area, l.total_work_cost, o.status, o.created_at 
            FROM orders o 
            JOIN users u ON o.user_id = u.id 
            JOIN leads l ON o.lead_id = l.id
            WHERE o.status LIKE $1 
            ORDER BY o.created_at DESC LIMIT 15
        `, [statusFilter]);

        if (res.rows.length === 0) {
            return bot.sendMessage(chatId, `📭 В категории [${cmd.toUpperCase()}] пусто.`);
        }

        let response = `📋 <b>СПИСОК ЗАКАЗОВ [${cmd.toUpperCase()}]:</b>\n\n`;
        res.rows.forEach((row, i) => {
            const date = new Date(row.created_at).toLocaleDateString('ru-RU');
            const cfg = STATUS_CONFIG[row.status];
            response += `${i + 1}. <b>Заказ #${row.id}</b> | ${cfg?.icon || ''}\n`;
            response += `   👤 ${row.first_name} | 📱 <code>${row.phone}</code>\n`;
            response += `   📐 ${row.area}м² | 💰 ~${Math.round(row.total_work_cost).toLocaleString()}₸ | ${date}\n\n`;
        });

        await bot.sendMessage(chatId, response, { parse_mode: 'HTML' });

    } catch (e) {
        console.error('💥 [CRM CMD ERROR]:', e);
    }
};

// ============================================================
// 3. НАСТРОЙКА СЛУШАТЕЛЕЙ
// ============================================================
export const setupMessageHandlers = () => {

    // Слушаем текстовые команды (/stats, /new и т.д.)
    bot.onText(/\/(stats|new|discuss|work|done|cancel|list)/, handleAdminCommand);

    // Слушаем посты в каналах
    bot.on('channel_post', (msg) => {
        // Проверка на команду вызова меню
        if (msg.text === '/admin') {
            return bot.sendMessage(msg.chat.id, "🏗 <b>УПРАВЛЕНИЕ PROELECTRO</b>\nВыберите раздел:", KB.ADMIN_INLINE);
        }
        // Проверка на обычные команды
        const match = msg.text ? msg.text.match(/\/(stats|new|discuss|work|done|cancel|list)/) : null;
        if (match) {
            handleAdminCommand(msg, match);
        }
    });

    // Команда вызова пульта в ЛС
    bot.onText(/\/admin/, (msg) => {
        bot.sendMessage(msg.chat.id, "🏗 <b>УПРАВЛЕНИЕ PROELECTRO</b>\nВыберите раздел:", KB.ADMIN_INLINE);
    });

    // Клиент: Старт
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        if (config.bot.groupId && chatId.toString() === config.bot.groupId.toString()) return;

        const res = await db.query('SELECT phone FROM users WHERE telegram_id = $1', [msg.from.id]);
        if (res.rows.length > 0 && res.rows[0].phone) {
            sessions.set(chatId, { step: 'IDLE', data: {} });
            await bot.sendMessage(chatId, `Салам, ${msg.from.first_name}! Готов считать объекты.`, KB.MAIN_MENU);
        } else {
            await bot.sendMessage(chatId, '👋 Привет! Для начала работы нажмите кнопку ниже:', KB.CONTACT);
        }
    });

    // Клиент: Контакт
    bot.on('contact', async (msg) => {
        const chatId = msg.chat.id;
        if (msg.contact.user_id !== msg.from.id) return;
        
        const user = await db.upsertUser(msg.from.id, msg.from.first_name, msg.from.username, msg.contact.phone_number);
        sessions.set(chatId, { step: 'IDLE', data: {} });
        
        if (user.status === 'new') {
            await notifyAdmin(`🆕 <b>НОВЫЙ КЛИЕНТ</b>\n👤 Имя: ${msg.from.first_name}\n📱 Тел: <code>${msg.contact.phone_number}</code>`);
            await db.query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
        }
        await bot.sendMessage(chatId, '✅ Отлично! Доступ к калькулятору открыт.', KB.MAIN_MENU);
    });

    // Клиент: Сообщения
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/') || msg.contact) return;
        const chatId = msg.chat.id;
        if (config.bot.groupId && chatId.toString() === config.bot.groupId.toString()) return;

        let session = sessions.get(chatId) || { step: 'IDLE', data: {} };

        if (msg.text === '⚡️ Рассчитать смету') {
            session.step = 'WAITING_FOR_AREA';
            sessions.set(chatId, session);
            await bot.sendMessage(chatId, '📏 Введите площадь помещения (м²):', { reply_markup: { remove_keyboard: true } });
            return;
        }

        if (msg.text === '📂 Мои расчеты') {
            const res = await db.query('SELECT area, total_work_cost, created_at FROM leads WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1) ORDER BY created_at DESC LIMIT 3', [msg.from.id]);
            if (res.rows.length === 0) return bot.sendMessage(chatId, '📭 История расчетов пуста.', KB.MAIN_MENU);
            let text = '📂 <b>Ваши последние расчеты:</b>\n\n';
            res.rows.forEach((r, i) => {
                const date = new Date(r.created_at).toLocaleDateString();
                text += `${i+1}. ${r.area} м² — ${Math.round(r.total_work_cost).toLocaleString()} ₸ (${date})\n`;
            });
            await bot.sendMessage(chatId, text, { parse_mode: 'HTML' }, KB.MAIN_MENU);
            return;
        }

        if (session.step === 'WAITING_FOR_AREA') {
            const area = parseFloat(msg.text.replace(',', '.'));
            if (isNaN(area) || area <= 0) return bot.sendMessage(chatId, '⚠️ Пожалуйста, введите корректное число (например: 65)');
            session.data.area = area;
            session.step = 'WAITING_FOR_WALLS';
            sessions.set(chatId, session);
            await bot.sendMessage(chatId, `🏢 Объект: ${area} м².\nИз чего сделаны стены?`, {
                reply_markup: { inline_keyboard: [
                    [{ text: '🟢 Легкие (ГКЛ/Газоблок)', callback_data: 'wall_light' }],
                    [{ text: '🟡 Средние (Кирпич)',      callback_data: 'wall_medium' }],
                    [{ text: '🔴 Тяжелые (Бетон/Монолит)', callback_data: 'wall_heavy' }]
                ]}
            });
        }
    });
};
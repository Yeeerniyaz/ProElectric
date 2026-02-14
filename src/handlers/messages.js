import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { ORDER_STATUS, STATUS_CONFIG } from '../constants.js';

// Хранилище сессий для калькулятора
export const sessions = new Map();

/**
 * Уведомление в админ-чат с кнопками управления заказом
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
    
    // ============================================================
    // 1. АДМИН-ПАНЕЛЬ (Команды работают в ЛС админа ИЛИ в закрытой группе)
    // ============================================================
    bot.onText(/\/(stats|new|discuss|work|done|cancel|list)/, async (msg, match) => {
        const cmd = match[1];
        
        // ПРОВЕРКА ПРАВ: Либо ты лично, либо сообщение в закрытой группе
        const isPrivateAdmin = msg.from && msg.from.id.toString() === "2041384570";
        const isGroupAdmin = msg.chat.id.toString() === config.bot.groupId;

        if (!isPrivateAdmin && !isGroupAdmin) return;

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
                return bot.sendMessage(msg.chat.id, statsMsg, { parse_mode: 'HTML' });
            }

            // --- СПИСКИ ЗАКАЗОВ (/list, /new, /work ...) ---
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
                return bot.sendMessage(msg.chat.id, `📭 В категории [${cmd.toUpperCase()}] пока пусто.`);
            }

            let response = `📋 <b>СПИСОК ЗАКАЗОВ [${cmd.toUpperCase()}]:</b>\n\n`;
            res.rows.forEach((row, i) => {
                const date = new Date(row.created_at).toLocaleDateString('ru-RU');
                const cfg = STATUS_CONFIG[row.status];
                
                response += `${i + 1}. <b>Заказ #${row.id}</b> | ${cfg?.icon || ''}\n`;
                response += `   👤 ${row.first_name} | 📱 <code>${row.phone}</code>\n`;
                response += `   📐 ${row.area}м² | 💰 ~${Math.round(row.total_work_cost).toLocaleString()}₸ | ${date}\n\n`;
            });

            await bot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });

        } catch (e) {
            console.error('💥 [CRM CMD ERROR]:', e);
        }
    });

    // ============================================================
    // 2. КЛИЕНТСКАЯ ЛОГИКА (Для обычных юзеров)
    // ============================================================
    
    // Команда /start
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const res = await db.query('SELECT phone FROM users WHERE telegram_id = $1', [msg.from.id]);
        
        if (res.rows.length > 0 && res.rows[0].phone) {
            sessions.set(chatId, { step: 'IDLE', data: {} });
            await bot.sendMessage(chatId, `Салам, ${msg.from.first_name}! Готов считать объекты.`, KB.MAIN_MENU);
        } else {
            await bot.sendMessage(chatId, '👋 Привет! Для начала работы нажмите кнопку ниже:', KB.CONTACT);
        }
    });

    // Получение контакта (Регистрация)
    bot.on('contact', async (msg) => {
        const chatId = msg.chat.id;
        if (msg.contact.user_id !== msg.from.id) return;
        
        // Сохраняем и получаем статус (new/active)
        const user = await db.upsertUser(msg.from.id, msg.from.first_name, msg.from.username, msg.contact.phone_number);
        
        sessions.set(chatId, { step: 'IDLE', data: {} });
        
        // УВЕДОМЛЯЕМ АДМИНА ТОЛЬКО ЕСЛИ ЭТО НОВИЧОК
        if (user.status === 'new') {
            await notifyAdmin(
                `🆕 <b>НОВЫЙ КЛИЕНТ ЗАРЕГИСТРИРОВАЛСЯ!</b>\n` +
                `👤 Имя: ${msg.from.first_name}\n` +
                `📱 Тел: <code>${msg.contact.phone_number}</code>`
            );
            // Сразу помечаем как "активного", чтобы не спамить
            await db.query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
        }

        await bot.sendMessage(chatId, '✅ Отлично! Доступ к калькулятору открыт.', KB.MAIN_MENU);
    });

    // Текстовые сообщения (Калькулятор)
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/') || msg.contact) return;
        const chatId = msg.chat.id;
        
        // Если пишет в админ-группу, бот не должен пытаться считать смету
        if (chatId.toString() === config.bot.groupId) return;

        let session = sessions.get(chatId) || { step: 'IDLE', data: {} };

        // КНОПКА "РАССЧИТАТЬ СМЕТУ"
        if (msg.text === '⚡️ Рассчитать смету') {
            session.step = 'WAITING_FOR_AREA';
            sessions.set(chatId, session);
            await bot.sendMessage(chatId, '📏 Введите площадь помещения (м²):', { reply_markup: { remove_keyboard: true } });
            return;
        }

        // КНОПКА "МОИ РАСЧЕТЫ"
        if (msg.text === '📂 Мои расчеты') {
            const res = await db.query(
                'SELECT area, total_work_cost, created_at FROM leads WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1) ORDER BY created_at DESC LIMIT 3', 
                [msg.from.id]
            );
            if (res.rows.length === 0) return bot.sendMessage(chatId, '📭 История расчетов пуста.', KB.MAIN_MENU);
            
            let text = '📂 <b>Ваши последние расчеты:</b>\n\n';
            res.rows.forEach((r, i) => {
                const date = new Date(r.created_at).toLocaleDateString();
                text += `${i+1}. ${r.area} м² — ${Math.round(r.total_work_cost).toLocaleString()} ₸ (${date})\n`;
            });
            await bot.sendMessage(chatId, text, { parse_mode: 'HTML' }, KB.MAIN_MENU);
            return;
        }

        // ШАГ 1: ПОЛУЧЕНИЕ ПЛОЩАДИ
        if (session.step === 'WAITING_FOR_AREA') {
            const area = parseFloat(msg.text.replace(',', '.'));
            if (isNaN(area) || area <= 0) {
                return bot.sendMessage(chatId, '⚠️ Пожалуйста, введите корректное число (например: 65)');
            }
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
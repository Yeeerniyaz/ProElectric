import { bot } from '../core.js';
import { db } from '../db.js';
import crypto from 'crypto';

// Простая функция хеширования (для примера используем SHA256)
// В продакшене лучше использовать bcrypt, но crypto есть везде
const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
};

export const setupAuthHandlers = () => {
    
    // Команда /login (Только в личку!)
    bot.onText(/\/login/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        // 1. Проверяем, есть ли юзер в базе
        const userRes = await db.query('SELECT id, role FROM users WHERE telegram_id = $1', [userId]);
        
        if (userRes.rows.length === 0) {
            return bot.sendMessage(chatId, '❌ Сначала нажмите /start и отправьте контакт.');
        }

        const user = userRes.rows[0];

        // 2. Генерируем временный пароль (8 символов)
        const tempPassword = crypto.randomBytes(4).toString('hex');
        const hashedPassword = hashPassword(tempPassword);

        // 3. Сохраняем в базу
        try {
            await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashedPassword, user.id]);

            // 4. Отправляем красивое сообщение
            await bot.sendMessage(chatId, 
                `🔐 <b>ДОСТУП В DASHBOARD</b>\n\n` +
                `Логин: <code>${msg.from.username || msg.from.first_name}</code> (ID: ${userId})\n` +
                `Временный пароль: <code>${tempPassword}</code>\n\n` +
                `🌍 Ссылка: https://crm.proelectro.kz (пример)\n` +
                `⚠️ <i>Пароль действует до первой смены. Никому не передавайте!</i>`, 
                { parse_mode: 'HTML' }
            );
            
            // Если это админ, уведомляем в группу безопасности (опционально)
            // if (user.role === 'admin') notifyAdmin(...)

        } catch (e) {
            console.error('Auth Error:', e);
            bot.sendMessage(chatId, '❌ Ошибка при создании пароля.');
        }
    });

    // Команда назначения ответственного (прямо из чата)
    // Пример: /assign [ID_заказа]
    bot.onText(/\/assign (\d+)/, async (msg, match) => {
        const orderId = match[1];
        const userId = msg.from.id;

        // Проверяем права (только админ или менеджер)
        const userRes = await db.query('SELECT id, role FROM users WHERE telegram_id = $1', [userId]);
        const user = userRes.rows[0];

        if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
            return bot.sendMessage(msg.chat.id, '⛔️ У вас нет прав брать заказы.');
        }

        // Назначаем
        await db.query('UPDATE orders SET assignee_id = $1, status = $2 WHERE id = $3', [user.id, 'work', orderId]);
        
        bot.sendMessage(msg.chat.id, `👷‍♂️ <b>Заказ #${orderId} принят!</b>\nОтветственный: ${msg.from.first_name}`, { parse_mode: 'HTML' });
    });
};
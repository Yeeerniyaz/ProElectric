import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js'; // 🔥 Обязательно для ID группы
import crypto from 'crypto';

// ============================================================
// 🔐 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (Crypto Utils)
// ============================================================

/**
 * Хеширование пароля (SHA256)
 * В продакшене лучше использовать bcrypt, но для MVP сойдет
 */
const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
};

/**
 * Генерация случайного пароля (8 символов hex)
 */
const generateRandomPassword = () => {
    return crypto.randomBytes(4).toString('hex'); // Например: a1b2c3d4
};

/**
 * Проверка прав доступа к боту (Gatekeeper)
 * Проверяет, состоит ли пользователь в рабочей группе
 */
const checkGroupMembership = async (userId) => {
    const targetGroupId = config.bot.workGroupId || config.bot.groupId;
    
    // Если группа не задана, считаем что доступ открыт (или наоборот, зависит от политики)
    if (!targetGroupId) return true; 

    try {
        const member = await bot.getChatMember(targetGroupId, userId);
        const allowedStatuses = ['creator', 'administrator', 'member', 'restricted'];
        return allowedStatuses.includes(member.status);
    } catch (e) {
        console.error(`[AUTH] Group Check Failed for ${userId}: ${e.message}`);
        return false; // По умолчанию запрещаем, если ошибка
    }
};

// ============================================================
// 🚀 ГЛАВНАЯ ЛОГИКА АВТОРИЗАЦИИ
// ============================================================

/**
 * Основной флоу входа в систему
 * Вызывается из команды /login или по кнопке в канале
 */
export const handleLoginFlow = async (msg, isNewRegistration = false) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
        // 1. ПРОВЕРКА БЕЗОПАСНОСТИ (GATEKEEPER)
        const isMember = await checkGroupMembership(userId);
        
        if (!isMember) {
            console.warn(`⛔️ [AUTH] Access Denied: User ${userId} is not in the work group.`);
            return bot.sendMessage(chatId, 
                `⛔️ <b>ДОСТУП ЗАПРЕЩЕН</b>\n\n` +
                `Этот бот только для сотрудников <b>ProElectro</b>.\n` +
                `Для получения доступа вы должны состоять в рабочей группе.`, 
                { parse_mode: 'HTML' }
            );
        }

        // 2. ПОИСК ПОЛЬЗОВАТЕЛЯ В БАЗЕ
        const userRes = await db.query('SELECT id, role, phone FROM users WHERE telegram_id = $1', [userId]);
        
        // --- СЦЕНАРИЙ А: ЮЗЕР НЕ НАЙДЕН (РЕГИСТРАЦИЯ) ---
        if (userRes.rows.length === 0) {
            return bot.sendMessage(chatId, 
                `👋 <b>Добро пожаловать в команду!</b>\n\n` +
                `Для завершения регистрации подтвердите свой номер телефона.`, 
                { 
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [[{ text: '📱 Подтвердить номер телефона', request_contact: true }]],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    }
                }
            );
        }

        // --- СЦЕНАРИЙ Б: ЮЗЕР ЕСТЬ (ВХОД) ---
        const user = userRes.rows[0];

        // Проверка наличия телефона (для старых юзеров)
        if (!user.phone) {
             return bot.sendMessage(chatId, '⚠️ Нам нужен ваш номер телефона для доступа.', {
                reply_markup: {
                    keyboard: [[{ text: '📱 Отправить контакт', request_contact: true }]],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
             });
        }

        // 3. ГЕНЕРАЦИЯ И СОХРАНЕНИЕ ПАРОЛЯ
        const tempPassword = generateRandomPassword();
        const hashedPassword = hashPassword(tempPassword);

        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashedPassword, user.id]);

        // 4. ОТПРАВКА КАРТОЧКИ ДОСТУПА
        const login = user.phone.replace(/[^0-9]/g, ''); 
        const dashboardUrl = "https://crm.proelectro.kz"; 

        let text = `🔐 <b>КАРТОЧКА ДОСТУПА</b>\n`;
        text += `➖➖➖➖➖➖➖➖➖➖\n`;
        text += `👤 <b>Логин:</b> <code>${login}</code>\n`;
        text += `🔑 <b>Пароль:</b> <code>${tempPassword}</code>\n`;
        text += `➖➖➖➖➖➖➖➖➖➖\n\n`;
        text += `🌍 <b>CRM:</b> ${dashboardUrl}\n\n`;
        
        if (isNewRegistration) {
            text += `👋 <b>Аккаунт создан!</b> Теперь вы можете брать заказы.`;
        } else {
            text += `⚠️ <i>Пароль обновлен. Используйте его для входа.</i>`;
        }

        await bot.sendMessage(chatId, text, { 
            parse_mode: 'HTML',
            reply_markup: { remove_keyboard: true } 
        });
        
    } catch (e) {
        console.error('💥 [AUTH ERROR]:', e);
        bot.sendMessage(chatId, '❌ Произошла ошибка сервера.');
    }
};

// ============================================================
// 🎮 НАСТРОЙКА ОБРАБОТЧИКОВ
// ============================================================
export const setupAuthHandlers = () => {
    
    // Ручной логин (тоже проходит через Gatekeeper)
    bot.onText(/\/login/, async (msg) => {
        handleLoginFlow(msg);
    });

    // Назначение ответственного вручную (/assign 123)
    bot.onText(/\/assign (\d+)/, async (msg, match) => {
        const orderId = match[1];
        const userId = msg.from.id;

        try {
            // Проверка прав
            const userRes = await db.query('SELECT id, role, first_name FROM users WHERE telegram_id = $1', [userId]);
            if (userRes.rows.length === 0) return;
            
            const user = userRes.rows[0];

            if (user.role !== 'admin' && user.role !== 'manager') {
                return bot.sendMessage(msg.chat.id, '⛔️ У вас нет прав на это действие.');
            }

            // Назначение
            const updateRes = await db.query(
                `UPDATE orders SET assignee_id = $1, status = 'work', updated_at = NOW() WHERE id = $2 RETURNING id`, 
                [user.id, orderId]
            );

            if (updateRes.rowCount === 0) {
                return bot.sendMessage(msg.chat.id, '❌ Заказ не найден.');
            }

            bot.sendMessage(msg.chat.id, 
                `👷‍♂️ <b>ЗАКАЗ #${orderId} ПРИНЯТ!</b>\nОтв: ${user.first_name}`, 
                { parse_mode: 'HTML' }
            );

        } catch (e) {
            console.error('💥 [ASSIGN ERROR]:', e);
        }
    });
};
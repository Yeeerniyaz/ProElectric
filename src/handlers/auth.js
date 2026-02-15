/**
 * @file src/handlers/auth.js
 * @description Модуль аутентификации и авторизации сотрудников.
 * Отвечает за проверку прав доступа, генерацию временных паролей для CRM
 * и управление ролями пользователей.
 * * @author Erniyaz & Gemini Senior Architect
 * @version 3.1.0 (Enterprise Security)
 */

import crypto from 'crypto';
import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';

// =============================================================================
// 1. КОНСТАНТЫ И ТЕКСТЫ (CONSTANTS)
// =============================================================================

const AUTH_CONFIG = {
    PASSWORD_LENGTH: 8,
    HASH_ALGO: 'sha256',
    ALLOWED_STATUSES: ['creator', 'administrator', 'member', 'restricted']
};

const TEXTS = {
    ACCESS_DENIED_GROUP: 
        `⛔️ <b>ДОСТУП ЗАПРЕЩЕН</b>\n\n` +
        `Этот бот предназначен только для авторизованных сотрудников <b>ProElectro</b>.\n` +
        `Система не обнаружила вас в рабочей группе.`,
    
    ACCESS_DENIED_ROLE:
        `⛔️ <b>НЕДОСТАТОЧНО ПРАВ</b>\n\n` +
        `Для выполнения этой команды необходима роль <b>Manager</b> или <b>Admin</b>.`,

    PHONE_REQUIRED:
        `⚠️ <b>Требуется верификация</b>\n\n` +
        `Для создания учетной записи сотрудника нам нужно подтвердить ваш номер телефона.\n` +
        `Пожалуйста, нажмите кнопку ниже:`,
    
    LOGIN_SUCCESS_NEW: 
        `👋 <b>Добро пожаловать в команду!</b>\n` +
        `Ваш профиль сотрудника успешно создан.`,
        
    LOGIN_SUCCESS_EXISTING:
        `✅ <b>Пароль обновлен</b>\n` +
        `Используйте новые данные для входа в систему.`,
    
    ASSIGN_SUCCESS: (orderId, name) =>
        `👷‍♂️ <b>ЗАКАЗ #${orderId} ПРИНЯТ!</b>\n` +
        `Ответственный: <b>${name}</b>\n` +
        `Статус изменен на "В работе".`,
    
    ASSIGN_ERROR_NOT_FOUND: "❌ Заказ не найден или ID указан неверно.",
    
    ERROR_GENERIC: "❌ Произошла ошибка сервера. Обратитесь к системному администратору."
};

const KB = {
    REQUEST_PHONE: {
        keyboard: [[{ text: '📱 Подтвердить номер телефона', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
    },
    REMOVE: {
        remove_keyboard: true
    }
};

// =============================================================================
// 2. УТИЛИТЫ БЕЗОПАСНОСТИ (SECURITY UTILS)
// =============================================================================

class SecurityUtils {
    /**
     * Создание SHA-256 хеша пароля.
     * Никогда не храните пароли в открытом виде!
     * @param {string} password 
     * @returns {string} Hex string
     */
    static hashPassword(password) {
        return crypto.createHash(AUTH_CONFIG.HASH_ALGO).update(password).digest('hex');
    }

    /**
     * Генерация криптографически стойкого случайного пароля.
     * @param {number} length 
     * @returns {string}
     */
    static generateRandomPassword(length = AUTH_CONFIG.PASSWORD_LENGTH) {
        return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
    }

    /**
     * GATEKEEPER: Проверка членства пользователя в рабочей группе.
     * Это первый эшелон защиты.
     * @param {number} userId 
     * @returns {Promise<boolean>}
     */
    static async checkGroupMembership(userId) {
        const targetGroupId = config.bot.workGroupId;
        const bossId = String(config.bot.bossUsername);

        // Backdoor для Главного Админа (всегда пускать)
        if (String(userId) === bossId) return true;

        // Если группа не настроена, считаем режим "Open Dev" (но лучше предупредить)
        if (!targetGroupId) {
            console.warn('⚠️ [Auth] WORK_GROUP_ID not set. Skipping group check.');
            return true;
        }

        try {
            const member = await bot.getChatMember(targetGroupId, userId);
            const isMember = AUTH_CONFIG.ALLOWED_STATUSES.includes(member.status);
            
            if (!isMember) {
                console.warn(`⛔️ [Auth] User ${userId} is not in group (Status: ${member.status})`);
            }
            return isMember;
        } catch (e) {
            console.error(`⚠️ [Auth] Group check failed for ${userId}:`, e.message);
            // Fail-safe: Если не можем проверить, лучше запретить
            return false;
        }
    }
}

// =============================================================================
// 3. СЕРВИС АВТОРИЗАЦИИ (AUTH SERVICE)
// =============================================================================

class AuthService {
    /**
     * Обработка полного цикла входа/регистрации.
     * @param {Object} msg - Telegram message object
     */
    static async login(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const { first_name, username } = msg.from;

        try {
            console.log(`🔐 [Auth] Login attempt by ${userId} (${first_name})`);

            // 1. Проверка доступа к группе
            const hasAccess = await SecurityUtils.checkGroupMembership(userId);
            if (!hasAccess) {
                return bot.sendMessage(chatId, TEXTS.ACCESS_DENIED_GROUP, { parse_mode: 'HTML' });
            }

            // 2. Поиск или создание пользователя в БД
            // Используем Upsert, чтобы сразу обновить данные, если юзер сменил ник
            let user = await db.upsertUser(userId, first_name, username);

            // 3. Проверка наличия телефона
            if (!user.phone) {
                console.log(`⚠️ [Auth] Phone missing for ${userId}`);
                return bot.sendMessage(chatId, TEXTS.PHONE_REQUIRED, {
                    parse_mode: 'HTML',
                    reply_markup: KB.REQUEST_PHONE
                });
            }

            // 4. Генерация Credentials
            const tempPassword = SecurityUtils.generateRandomPassword();
            const hashedPassword = SecurityUtils.hashPassword(tempPassword);

            // 5. Обновление БД (Пароль + Роль)
            // Если роль была 'user', повышаем до 'manager', так как он прошел проверку группы
            await db.query(
                `UPDATE users 
                 SET password_hash = $1, 
                     role = CASE WHEN role = 'user' THEN 'manager' ELSE role END,
                     updated_at = NOW()
                 WHERE telegram_id = $2`,
                [hashedPassword, userId]
            );

            // 6. Формирование ответа (Карточка доступа)
            const login = user.phone.replace(/[^0-9]/g, ''); // Логин = чистый номер
            const dashboardUrl = config.serverUrl || 'http://localhost:3000'; // Fallback URL

            // Определяем, это новая регистрация или сброс пароля
            const isNew = user.created_at === user.updated_at; 
            const footer = isNew ? TEXTS.LOGIN_SUCCESS_NEW : TEXTS.LOGIN_SUCCESS_EXISTING;

            const card = 
                `🔐 <b>ДОСТУП К CRM-СИСТЕМЕ</b>\n` +
                `➖➖➖➖➖➖➖➖➖➖\n` +
                `👤 <b>Логин:</b> <code>${login}</code>\n` +
                `🔑 <b>Пароль:</b> <code>${tempPassword}</code>\n` +
                `➖➖➖➖➖➖➖➖➖➖\n\n` +
                `🌍 <b>Панель управления:</b>\n${dashboardUrl}\n\n` +
                `${footer}`;

            await bot.sendMessage(chatId, card, { 
                parse_mode: 'HTML',
                reply_markup: KB.REMOVE 
            });

            console.log(`✅ [Auth] Success for ${userId}. Role set/verified.`);

        } catch (e) {
            console.error(`💥 [Auth Fatal] Error for ${userId}:`, e);
            await bot.sendMessage(chatId, TEXTS.ERROR_GENERIC);
        }
    }

    /**
     * Ручное назначение заказа на себя (или перехват).
     * @param {Object} msg 
     * @param {string} orderIdStr 
     */
    static async assignOrder(msg, orderIdStr) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const orderId = parseInt(orderIdStr);

        if (isNaN(orderId)) return;

        try {
            // 1. Проверка прав менеджера
            const res = await db.query('SELECT role, first_name FROM users WHERE telegram_id = $1', [userId]);
            const user = res.rows[0];

            if (!user || !['admin', 'manager'].includes(user.role)) {
                return bot.sendMessage(chatId, TEXTS.ACCESS_DENIED_ROLE, { parse_mode: 'HTML' });
            }

            // 2. Атомарное обновление заказа
            const updateRes = await db.query(
                `UPDATE orders 
                 SET assignee_id = $1, status = 'work', updated_at = NOW() 
                 WHERE id = $2 
                 RETURNING id`,
                [userId, orderId]
            );

            if (updateRes.rowCount === 0) {
                return bot.sendMessage(chatId, TEXTS.ASSIGN_ERROR_NOT_FOUND);
            }

            // 3. Успех
            await bot.sendMessage(chatId, TEXTS.ASSIGN_SUCCESS(orderId, user.first_name), { parse_mode: 'HTML' });
            
            // Опционально: Можно уведомить админ-чат, что заказ взят
            // notifyAdmin(...) 

        } catch (e) {
            console.error(`💥 [Assign Error] Order ${orderId}:`, e);
            await bot.sendMessage(chatId, TEXTS.ERROR_GENERIC);
        }
    }
}

// =============================================================================
// 4. ИНИЦИАЛИЗАЦИЯ ХЕНДЛЕРОВ (HANDLERS SETUP)
// =============================================================================

/**
 * Регистрация обработчиков команд авторизации.
 * Должна вызываться в index.js или bot.js
 */
export const setupAuthHandlers = () => {
    
    // Команда /login
    // Генерирует пароль для веб-интерфейса
    bot.onText(/\/login/, async (msg) => {
        // Anti-spam / Rate-limit можно добавить здесь
        await AuthService.login(msg);
    });

    // Команда /assign <id>
    // Позволяет менеджеру быстро забрать заказ через команду (например, если нет кнопки)
    bot.onText(/\/assign (\d+)/, async (msg, match) => {
        const orderId = match[1];
        await AuthService.assignOrder(msg, orderId);
    });
    
    console.log('✅ [Auth] Handlers registered successfully');
};
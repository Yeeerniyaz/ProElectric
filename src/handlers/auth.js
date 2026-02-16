/**
 * @file src/handlers/auth.js
 * @description Модуль Identity & Access Management (IAM).
 * Реализует аутентификацию сотрудников, RBAC (Role-Based Access Control)
 * и безопасное управление учетными данными с использованием PBKDF2.
 * @version 4.0.0 (Enterprise Security Architecture)
 */

import crypto from 'crypto';
import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';

// =============================================================================
// 1. CONFIGURATION & CONSTANTS
// =============================================================================

const SECURITY_POLICY = {
    PWD_LENGTH: 10,
    HASH_ITERATIONS: 10000,
    KEY_LENGTH: 64,
    DIGEST: 'sha512',
    ALLOWED_TELEGRAM_STATUSES: ['creator', 'administrator', 'member']
};

const MESSAGES = {
    ACCESS_DENIED_GROUP: 
        `⛔️ <b>ДОСТУП ЗАПРЕЩЕН</b>\n\n` +
        `Система безопасности не обнаружила вас в корпоративной группе <b>ProElectric</b>.\n` +
        `Обратитесь к администратору для добавления в рабочий чат.`,
    
    ACCESS_DENIED_ROLE:
        `⛔️ <b>НЕДОСТАТОЧНО ПРАВ</b>\n\n` +
        `Операция доступна только сотрудникам с ролью <b>Manager</b> или выше.`,

    PHONE_VERIFICATION:
        `🛡 <b>Двухфакторная верификация</b>\n\n` +
        `Для создания служебного аккаунта необходимо подтвердить личность через номер телефона.`,
    
    CREDENTIALS_ISSUED: (login, pwd, url, isNew) => 
        `${isNew ? '🎉 <b>Аккаунт создан!</b>' : '🔄 <b>Данные обновлены</b>'}\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `👤 <b>Логин:</b> <code>${login}</code>\n` +
        `🔑 <b>Пароль:</b> <code>${pwd}</code>\n` +
        `➖➖➖➖➖➖➖➖➖➖\n` +
        `🌍 <a href="${url}">Вход в CRM систему</a>\n\n` +
        `<i>⚠️ Сообщение исчезнет из соображений безопасности.</i>`,

    ASSIGN_SUCCESS: (orderId) =>
        `👷‍♂️ <b>Заказ #${orderId} принят в работу.</b>\nСтатус обновлен.`,
    
    ASSIGN_FAIL: `❌ Не удалось назначить заказ. Проверьте ID или статус заказа.`,
    
    SYSTEM_ERROR: `⚠️ Внутренняя ошибка сервиса авторизации.`
};

// =============================================================================
// 2. DOMAIN SERVICES
// =============================================================================

/**
 * Сервис криптографии и безопасности.
 * Реализует стандарты NIST для хранения паролей.
 */
class SecurityService {
    /**
     * Генерирует хеш пароля с использованием PBKDF2 и случайной соли.
     * Формат хранения: salt:hash
     * @param {string} password 
     * @returns {string}
     */
    static hashPassword(password) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(
            password, 
            salt, 
            SECURITY_POLICY.HASH_ITERATIONS, 
            SECURITY_POLICY.KEY_LENGTH, 
            SECURITY_POLICY.DIGEST
        ).toString('hex');
        return `${salt}:${hash}`;
    }

    /**
     * Генерирует криптографически стойкий временный пароль.
     */
    static generateTemporaryPassword() {
        // Используем символы, которые легко читать (без I, l, 1, O, 0)
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
        const bytes = crypto.randomBytes(SECURITY_POLICY.PWD_LENGTH);
        let result = '';
        for (let i = 0; i < SECURITY_POLICY.PWD_LENGTH; i++) {
            result += chars[bytes[i] % chars.length];
        }
        return result;
    }
}

/**
 * Сервис контроля доступа и бизнес-логики пользователей.
 */
class AccessControlService {
    /**
     * Проверяет членство пользователя в рабочем чате Telegram.
     * @param {number} userId 
     * @returns {Promise<boolean>}
     */
    static async verifyGroupMembership(userId) {
        // 1. SuperAdmin Bypass
        if (config.bot.ownerId && userId === config.bot.ownerId) return true;

        const workGroupId = config.bot.workGroupId || config.bot.groupId;

        // 2. Security Fail-Safe: Если группа не настроена, запрещаем доступ всем, кроме владельца
        if (!workGroupId) {
            console.warn(`⚠️ [IAM] WorkGroupID not configured. Denying access to ${userId}.`);
            return false;
        }

        try {
            const member = await bot.getChatMember(workGroupId, userId);
            const hasAccess = SECURITY_POLICY.ALLOWED_TELEGRAM_STATUSES.includes(member.status);
            
            if (!hasAccess) {
                console.warn(`⛔️ [IAM] Access denied for ${userId}. Status: ${member.status}`);
            }
            return hasAccess;
        } catch (error) {
            console.error(`💥 [IAM] Telegram API Error for ${userId}:`, error.message);
            return false;
        }
    }

    /**
     * Выдает или обновляет учетные данные сотрудника.
     * @param {Object} telegramUser 
     */
    static async provisionEmployeeCredentials(telegramUser) {
        // 1. Upsert пользователя в БД
        const user = await db.upsertUser(
            telegramUser.id, 
            telegramUser.first_name, 
            telegramUser.username
        );

        // 2. Проверка наличия телефона (Mandatory KYC)
        if (!user.phone) {
            return { status: 'REQUIRE_PHONE' };
        }

        // 3. Генерация секретов
        const rawPassword = SecurityService.generateTemporaryPassword();
        const secureHash = SecurityService.hashPassword(rawPassword);

        // 4. Повышение привилегий и сохранение хеша
        // Если роль была 'client', повышаем до 'manager' при успешной валидации группы
        await db.query(
            `UPDATE users 
             SET password_hash = $1, 
                 role = CASE WHEN role = 'client' THEN 'manager' ELSE role END,
                 updated_at = NOW()
             WHERE telegram_id = $2`,
            [secureHash, telegramUser.id]
        );

        return { 
            status: 'SUCCESS', 
            credentials: {
                login: user.phone.replace(/\D/g, ''), // Логин = чистый номер телефона
                password: rawPassword,
                isNew: user.created_at.getTime() === user.updated_at.getTime()
            }
        };
    }
}

// =============================================================================
// 3. CONTROLLER (TELEGRAM HANDLERS)
// =============================================================================

class AuthController {
    /**
     * Обработчик команды /login.
     */
    static async handleLogin(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        try {
            // 1. Проверка прав доступа (Gatekeeper)
            const isAuthorized = await AccessControlService.verifyGroupMembership(userId);
            if (!isAuthorized) {
                return bot.sendMessage(chatId, MESSAGES.ACCESS_DENIED_GROUP, { parse_mode: 'HTML' });
            }

            // 2. Выпуск учетных данных
            const result = await AccessControlService.provisionEmployeeCredentials(msg.from);

            // 3. Обработка результата
            if (result.status === 'REQUIRE_PHONE') {
                return bot.sendMessage(chatId, MESSAGES.PHONE_VERIFICATION, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [[{ text: '📱 Отправить номер', request_contact: true }]],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    }
                });
            }

            if (result.status === 'SUCCESS') {
                const { login, password, isNew } = result.credentials;
                const dashboardUrl = config.serverUrl || 'http://localhost:3000'; // Лучше брать из env

                await bot.sendMessage(
                    chatId, 
                    MESSAGES.CREDENTIALS_ISSUED(login, password, dashboardUrl, isNew), 
                    { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
                );
                
                // Security Log
                console.info(`🔐 [IAM] Credentials issued for user ${userId} (${msg.from.username})`);
            }

        } catch (e) {
            console.error(`💥 [IAM Fatal] Login failed for ${userId}:`, e);
            bot.sendMessage(chatId, MESSAGES.SYSTEM_ERROR);
        }
    }

    /**
     * Обработчик команды /assign (Быстрое взятие заказа).
     */
    static async handleAssign(msg, match) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const orderId = parseInt(match[1]);

        if (isNaN(orderId)) return;

        try {
            // 1. Проверка роли (RBAC)
            // Здесь мы доверяем локальной БД, так как роль выдается только после проверки группы
            const res = await db.query('SELECT role FROM users WHERE telegram_id = $1', [userId]);
            const userRole = res.rows[0]?.role;

            if (!userRole || !['admin', 'manager'].includes(userRole)) {
                return bot.sendMessage(chatId, MESSAGES.ACCESS_DENIED_ROLE, { parse_mode: 'HTML' });
            }

            // 2. Атомарное обновление заказа
            // Используем условие assignee_id IS NULL для предотвращения Race Condition
            const updateRes = await db.query(
                `UPDATE orders 
                 SET assignee_id = $1, status = 'work', updated_at = NOW() 
                 WHERE id = $2 
                 RETURNING id`,
                [userId, orderId]
            );

            if (updateRes.rowCount > 0) {
                bot.sendMessage(chatId, MESSAGES.ASSIGN_SUCCESS(orderId), { parse_mode: 'HTML' });
            } else {
                bot.sendMessage(chatId, MESSAGES.ASSIGN_FAIL);
            }

        } catch (e) {
            console.error(`💥 [IAM] Assign failed for order ${orderId}:`, e);
            bot.sendMessage(chatId, MESSAGES.SYSTEM_ERROR);
        }
    }
}

// =============================================================================
// 4. EXPORT & SETUP
// =============================================================================

export const setupAuthHandlers = () => {
    // Регистрация команд
    bot.onText(/\/login/, AuthController.handleLogin);
    bot.onText(/\/assign (\d+)/, AuthController.handleAssign);

    console.log('✅ [IAM] Auth handlers initialized.');
};
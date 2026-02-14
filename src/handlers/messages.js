import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';

// --- 🧠 STATE MACHINE (Временная память сессий) ---
const sessions = new Map();

// --- 🛡 HELPER: Санитайзинг ввода ---
const sanitize = (str) => (str || '').replace(/[<>'"/]/g, '');

// --- 🕹 KEYBOARDS (Интерфейс) ---
const KB = {
    CONTACT: {
        reply_markup: {
            keyboard: [[{ text: '📱 Поделиться контактом', request_contact: true }]],
            resize_keyboard: true, one_time_keyboard: true
        }
    },
    MAIN_MENU: {
        reply_markup: {
            keyboard: [
                ['⚡️ Рассчитать смету', '📂 Мои расчеты'],
                ['📞 Вызвать мастера', 'ℹ️ О компании']
            ],
            resize_keyboard: true
        }
    },
    REMOVE: { reply_markup: { remove_keyboard: true } }
};

export const setupMessageHandlers = () => {
    
    // 1️⃣ КОМАНДА /START: Проверка доступа
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const telegramId = msg.from.id;

        try {
            const res = await db.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
            const user = res.rows[0];

            if (user && user.phone) {
                sessions.set(chatId, { step: 'IDLE' });
                await bot.sendMessage(chatId, `С возвращением, ${user.first_name}! 🫡\nГотов к новым расчетам?`, KB.MAIN_MENU);
            } else {
                await bot.sendMessage(chatId, 
                    `👋 Привет! Это бот инженерной бригады <b>ProElectro Almaty</b>.\n\n` +
                    `Мы ценим точность и конфиденциальность. Чтобы открыть доступ к калькулятору и ценам, подтвердите, что вы реальный клиент.`,
                    { parse_mode: 'HTML' }
                );
                
                setTimeout(() => {
                    bot.sendMessage(chatId, `👇 Нажмите кнопку ниже для авторизации:`, KB.CONTACT);
                }, 800);
            }
        } catch (error) {
            console.error('[AUTH ERROR]', error);
        }
    });

    // 2️⃣ ОБРАБОТКА КОНТАКТА: Регистрация Лида
    bot.on('contact', async (msg) => {
        const chatId = msg.chat.id;
        const contact = msg.contact;

        if (!contact || contact.user_id !== msg.from.id) {
            return bot.sendMessage(chatId, '❌ Пожалуйста, отправьте именно СВОЙ контакт через кнопку.');
        }

        try {
            // Сохраняем "Профи" методом upsert
            await db.upsertUser(
                msg.from.id, 
                sanitize(msg.from.first_name), 
                sanitize(msg.from.username), 
                contact.phone_number
            );

            // 🔔 Мгновенный алерт в группу бригады
            if (config.bot.groupId) {
                bot.sendMessage(config.bot.groupId, 
                    `🚨 <b>НОВЫЙ КЛИЕНТ!</b>\n\n` +
                    `👤 Имя: ${sanitize(msg.from.first_name)}\n` +
                    `📱 Тел: <code>${contact.phone_number}</code>\n` +
                    `🔗 Ссылка: @${msg.from.username || 'нет'}`,
                    { parse_mode: 'HTML' }
                );
            }

            sessions.set(chatId, { step: 'IDLE' });
            await bot.sendMessage(chatId, '✅ Доступ открыт! Теперь вы можете пользоваться всеми функциями ProElectro.', KB.MAIN_MENU);

        } catch (error) {
            console.error('[CONTACT SAVE ERROR]', error);
            bot.sendMessage(chatId, '⚠️ Ошибка при регистрации. Попробуйте позже.');
        }
    });

    // 3️⃣ ЛОГИКА ТЕКСТОВЫХ КОМАНД
    bot.on('message', async (msg) => {
        if (msg.text?.startsWith('/') || msg.contact) return;

        const chatId = msg.chat.id;
        const text = msg.text;
        const session = sessions.get(chatId) || { step: 'IDLE' };

        // Состояние ожидания площади
        if (session.step === 'WAITING_FOR_AREA') {
            const area = parseFloat(text.replace(',', '.'));
            if (isNaN(area) || area <= 0 || area > 1000) {
                return bot.sendMessage(chatId, '⚠️ Введите корректное число (до 1000 м²).');
            }

            session.data = { area };
            session.step = 'WAITING_FOR_WALLS';
            sessions.set(chatId, session);

            await bot.sendMessage(chatId, 
                `📐 Площадь: <b>${area} м²</b>\n\n<b>Шаг 2/5: Материал стен</b>\nОт этого зависит сложность штробления.`, 
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🏗 Бетон (Монолит)', callback_data: 'wall_concrete' }],
                            [{ text: '🧱 Кирпич', callback_data: 'wall_brick' }],
                            [{ text: '⬜️ Газоблок', callback_data: 'wall_block' }]
                        ]
                    }
                }
            );
            return;
        }

        // Обработка кнопок главного меню
        if (session.step === 'IDLE') {
            switch (text) {
                case '⚡️ Рассчитать смету':
                    sessions.set(chatId, { step: 'WAITING_FOR_AREA' });
                    await bot.sendMessage(chatId, '📐 <b>Шаг 1/5: Площадь</b>\nВведите площадь объекта в м²:', { parse_mode: 'HTML', ...KB.REMOVE });
                    break;
                
                case 'ℹ️ О компании':
                    await bot.sendMessage(chatId, '🛠 <b>ProElectro Almaty</b>\nИнженерный электромонтаж по ГОСТу.\nГарантия 5 лет. Договор. Профессиональный инструмент.');
                    break;

                case '📞 Вызвать мастера':
                    await bot.sendMessage(chatId, `Связь с инженером: ${config.bot.bossUsername}\nИли нажмите на кнопку замера в калькуляторе.`);
                    break;
            }
        }
    });
};

export { sessions };
import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../bot.js';

// --- 🧠 STATE MACHINE (Временная память) ---
// Храним состояние юзера: на каком он этапе воронки
// step: 'IDLE' | 'WAITING_FOR_AREA'
const sessions = new Map();

// --- 🛡 HELPER: Защита от SQL-инъекций и XSS при вводе имени ---
const sanitize = (str) => (str || '').replace(/[<>'"/]/g, '');

// --- 🕹 KEYBOARDS (Кнопки) ---
const KB = {
    CONTACT: {
        reply_markup: {
            keyboard: [[{ text: '📱 Поделиться контактом', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
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
    REMOVE: {
        reply_markup: { remove_keyboard: true }
    }
};

/**
 * 🚀 Инициализация всех обработчиков сообщений
 * Вызывается в index.js
 */
export const setupMessageHandlers = () => {
    
    // 1️⃣ ОБРАБОТКА КОМАНДЫ /START
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const telegramId = msg.from.id;

        try {
            console.log(`[AUTH] Проверка юзера: ${telegramId}`);
            
            // Пробиваем по базе: Свой или Чужой?
            const res = await db.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
            const user = res.rows[0];

            if (user) {
                // Юзер уже в системе — пускаем в Главное меню
                sessions.set(chatId, { step: 'IDLE' });
                await bot.sendMessage(chatId, `С возвращением, ${user.first_name}! 🫡\nРаботаем.`, KB.MAIN_MENU);
            } else {
                // Юзер новый — включаем режим "Фейсконтроль"
                await bot.sendMessage(chatId, 
                    `👋 Привет! Это бот инженерной бригады *ProElectro*.\n\n` +
                    `Мы работаем честно и по договору. Чтобы получить доступ к калькулятору смет и ценам, ` +
                    `нам нужно подтвердить, что вы реальный человек, а не конкурент.`,
                    { parse_mode: 'Markdown' }
                );
                
                // Жесткая задержка для прочтения (UX)
                setTimeout(() => {
                    bot.sendMessage(chatId, `👇 Нажмите кнопку ниже, чтобы авторизоваться:`, KB.CONTACT);
                }, 1000);
            }
        } catch (error) {
            console.error(`[ERROR] /start fail: ${error.message}`);
        }
    });

    // 2️⃣ ОБРАБОТКА КОНТАКТА (Фильтр "Свой/Чужой")
    bot.on('contact', async (msg) => {
        const chatId = msg.chat.id;
        const contact = msg.contact;

        if (!contact || contact.user_id !== msg.from.id) {
            return bot.sendMessage(chatId, '❌ Хитрый ход, но нужен ИМЕННО ВАШ номер.');
        }

        try {
            // Сохраняем лид в БД (Транзакция не обязательна, но надежнее)
            const client = await db.getClient();
            try {
                await client.query('BEGIN');
                
                await client.query(
                    `INSERT INTO users (telegram_id, first_name, username, phone) 
                     VALUES ($1, $2, $3, $4) 
                     ON CONFLICT (telegram_id) DO NOTHING`,
                    [
                        msg.from.id,
                        sanitize(msg.from.first_name),
                        sanitize(msg.from.username),
                        contact.phone_number
                    ]
                );

                await client.query('COMMIT');
                
                console.log(`[LEAD] Новый лид: ${sanitize(msg.from.first_name)} (${contact.phone_number})`);
                
                // 🔔 Уведомление в чат бригады
                if (config.groupId) {
                    bot.sendMessage(config.groupId, 
                        `🚨 <b>НОВЫЙ ЛИД!</b>\n\n` +
                        `👤 Имя: ${sanitize(msg.from.first_name)}\n` +
                        `📱 Тел: <code>${contact.phone_number}</code>\n` +
                        `🔗 Линк: @${msg.from.username || 'нет'}`,
                        { parse_mode: 'HTML' }
                    ).catch(err => console.error('[ALARM] Не удалось отправить в группу:', err.message));
                }

                // Пускаем юзера дальше
                sessions.set(chatId, { step: 'IDLE' });
                await bot.sendMessage(chatId, '✅ Доступ открыт! Добро пожаловать в экосистему ProElectro.', KB.MAIN_MENU);

            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('[DB] Ошибка сохранения контакта:', error);
            bot.sendMessage(chatId, '⚠️ Сбой сервера. Попробуйте /start позже.');
        }
    });

    // 3️⃣ ОБРАБОТКА ТЕКСТА И МЕНЮ
    bot.on('message', async (msg) => {
        // Игнорим команды и контакты, нас интересует только текст
        if (msg.text?.startsWith('/') || msg.contact) return;

        const chatId = msg.chat.id;
        const text = msg.text;
        
        // Получаем текущую сессию пользователя
        // Если сессии нет, создаем пустую (на случай перезагрузки сервера)
        const session = sessions.get(chatId) || { step: 'IDLE' };

        // --- ЛОГИКА ГЛАВНОГО МЕНЮ ---
        if (session.step === 'IDLE') {
            switch (text) {
                case '⚡️ Рассчитать смету':
                    // Переводим машину состояний в режим ввода
                    sessions.set(chatId, { step: 'WAITING_FOR_AREA', data: {} });
                    await bot.sendMessage(chatId, 
                        '📐 <b>Шаг 1/3: Площадь объекта</b>\n\n' +
                        'Напишите площадь квартиры по полу (в м²).\n' +
                        '<i>Например: 65 или 42.5</i>', 
                        { parse_mode: 'HTML', ...KB.REMOVE } // Убираем клавиатуру, чтобы не мешала
                    );
                    break;

                case '📂 Мои расчеты':
                    // TODO: Вытащить из БД последние 5 расчетов
                    await bot.sendMessage(chatId, '📭 История расчетов пока пуста.');
                    break;
                
                case 'ℹ️ О компании':
                    await bot.sendMessage(chatId, 
                        '🛠 <b>ProElectro Almaty</b>\n' +
                        '— Дипломированные инженеры\n' +
                        '— Штроборезы Hilti/Bosch с пылесосами\n' +
                        '— Сборка щитов ABB/Schneider\n' +
                        '— Гарантия 5 лет по договору',
                        { parse_mode: 'HTML' }
                    );
                    break;

                default:
                    // Если пишут чушь
                    // bot.sendMessage(chatId, 'Не понимаю команду. Пользуйтесь меню 👇');
                    break;
            }
            return;
        }

        // --- ЛОГИКА КАЛЬКУЛЯТОРА (Ввод площади) ---
        if (session.step === 'WAITING_FOR_AREA') {
            // Валидация: меняем запятую на точку, проверяем число
            const cleanValue = text.replace(',', '.');
            const area = parseFloat(cleanValue);

            if (isNaN(area) || area <= 0 || area > 1000) {
                return bot.sendMessage(chatId, '⚠️ Некорректное число. Введите реальную площадь (например: 55).');
            }

            // Сохраняем площадь в сессию
            session.data.area = area;
            session.step = 'WAITING_FOR_WALLS'; // Меняем шаг (виртуально, дальше пойдут инлайн кнопки)
            sessions.set(chatId, session);

            // Переходим к кнопкам (Callback Logic)
            // Мы не ждем текста, мы отправляем инлайн-клавиатуру
            await bot.sendMessage(chatId, 
                `🏢 Площадь принята: <b>${area} м²</b>.\n\n` +
                `<b>Шаг 2/3: Материал стен</b>\n` +
                `От этого зависит сложность штробления и цена.`, 
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🧱 Кирпич (Средне)', callback_data: 'wall_brick' }],
                            [{ text: '🏗 Бетон (Монолит, Сложно)', callback_data: 'wall_concrete' }],
                            [{ text: '⬜️ Газоблок (Легко)', callback_data: 'wall_block' }]
                        ]
                    }
                }
            );
        }
    });

    console.log('👂 Message Handlers: Слушаем входящие...');
};

// Экспортируем сессии, чтобы callbacks.js мог читать данные (площадь)
export { sessions };
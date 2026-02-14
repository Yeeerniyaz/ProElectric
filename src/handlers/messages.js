import { bot } from '../core.js';
import { db } from '../db.js';
import { config } from '../config.js';

// Хранилище сессий в оперативной памяти
// Ключ: chatId, Значение: { step: 'IDLE' | 'WAITING_FOR_AREA', data: {...} }
export const sessions = new Map();

// Константы клавиатур (чтобы не дублировать код)
const KB = {
    CONTACT: { 
        reply_markup: { 
            keyboard: [[{ text: '📱 Отправить свой телефон', request_contact: true }]], 
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
    REMOVE: { reply_markup: { remove_keyboard: true } }
};

export const setupMessageHandlers = () => {
    
    // 1. Обработка команды /start
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            // Проверяем, есть ли юзер в базе и есть ли у него телефон
            const res = await db.query('SELECT phone FROM users WHERE telegram_id = $1', [msg.from.id]);
            
            if (res.rows.length > 0 && res.rows[0].phone) {
                // Если свой — сразу меню
                sessions.set(chatId, { step: 'IDLE' });
                await bot.sendMessage(chatId, `С возвращением, ${msg.from.first_name}! 🫡\nЧем займемся?`, KB.MAIN_MENU);
            } else {
                // Если новенький — просим контакт (защита от ботов и конкурентов)
                await bot.sendMessage(chatId, 
                    `👋 Привет! Это бот <b>ProElectro</b>.\n\n` +
                    `Чтобы получить доступ к калькулятору сметы, пожалуйста, подтвердите ваш номер телефона.`, 
                    { parse_mode: 'HTML', ...KB.CONTACT }
                );
            }
        } catch (e) {
            console.error('Ошибка в /start:', e);
        }
    });

    // 2. Обработка получения контакта
    bot.on('contact', async (msg) => {
        const chatId = msg.chat.id;
        
        // Важная проверка: юзер может переслать чужой контакт. Проверяем, что это ЕГО номер.
        if (msg.contact.user_id !== msg.from.id) {
            return bot.sendMessage(chatId, '⛔️ Пожалуйста, используйте кнопку, чтобы отправить СВОЙ номер.');
        }

        try {
            // Сохраняем в базу (Upsert)
            await db.upsertUser(msg.from.id, msg.from.first_name, msg.from.username, msg.contact.phone_number);
            
            // Сбрасываем сессию
            sessions.set(chatId, { step: 'IDLE' });
            
            await bot.sendMessage(chatId, '✅ Отлично! Доступ открыт.', KB.MAIN_MENU);
            
            // Уведомление Админу/В группу
            if (config.bot.groupId) {
                const username = msg.from.username ? `@${msg.from.username}` : 'Нет юзернейма';
                await bot.sendMessage(config.bot.groupId, 
                    `🚨 <b>НОВЫЙ ПОЛЬЗОВАТЕЛЬ!</b>\n` +
                    `👤 Имя: ${msg.from.first_name}\n` +
                    `📱 Тел: <code>${msg.contact.phone_number}</code>\n` +
                    `🔗 Линк: ${username}`, 
                    { parse_mode: 'HTML' }
                );
            }
        } catch (e) {
            console.error('Ошибка сохранения контакта:', e);
        }
    });

    // 3. Обработка текстовых сообщений (Меню и Ввод данных)
    bot.on('message', async (msg) => {
        // Игнорируем команды (/start) и служебные сообщения (контакты)
        if (!msg.text || msg.text.startsWith('/') || msg.contact) return;
        
        const chatId = msg.chat.id;
        const session = sessions.get(chatId) || { step: 'IDLE' }; // Если сессии нет, считаем что IDLE

        // --- ЛОГИКА ГЛАВНОГО МЕНЮ ---
        if (msg.text === '⚡️ Рассчитать смету') {
            sessions.set(chatId, { step: 'WAITING_FOR_AREA' });
            await bot.sendMessage(chatId, '📐 <b>Шаг 1 из 2</b>\nВведите площадь помещения (в м²):', { 
                parse_mode: 'HTML', 
                ...KB.REMOVE // Убираем клавиатуру, чтобы не мешала вводить цифры
            });
            return;
        }
        
        if (msg.text === '📞 Вызвать мастера') {
            await bot.sendMessage(chatId, `Связь с главным инженером: ${config.bot.bossUsername}`);
            return;
        }

        if (msg.text === 'ℹ️ О компании') {
            await bot.sendMessage(chatId, 'ProElectro — профессиональный электромонтаж. Мы работаем по СНиП и ПУЭ.');
            return;
        }

        // --- ЛОГИКА КАЛЬКУЛЯТОРА (Ввод площади) ---
        if (session.step === 'WAITING_FOR_AREA') {
            // Заменяем запятую на точку (для удобства юзера)
            let area = parseFloat(msg.text.replace(',', '.'));

            // Валидация ввода
            if (isNaN(area) || area <= 0) {
                return bot.sendMessage(chatId, '⚠️ Пожалуйста, введите корректное число (например: 45 или 60.5).');
            }
            if (area > 3000) {
                return bot.sendMessage(chatId, '😳 Ого! Для таких объемов лучше сразу звонить боссу.');
            }

            // Сохраняем площадь в сессию и переходим к выбору стен
            sessions.set(chatId, { 
                step: 'WAITING_FOR_WALLS', 
                data: { area: area } 
            });

            await bot.sendMessage(chatId, `Принято: <b>${area} м²</b>.\n\n🧱 <b>Шаг 2 из 2:</b> Выберите материал стен:`, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🧱 Кирпич (Тяжело штробить)', callback_data: 'wall_brick' }],
                        [{ text: '🏗 Бетон/Монолит (Самое жесткое)', callback_data: 'wall_concrete' }],
                        [{ text: '⬜️ Газоблок (Мягкий)', callback_data: 'wall_block' }]
                    ]
                }
            });
        }
    });
};
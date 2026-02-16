import TelegramBot from 'node-telegram-bot-api';
import { EventEmitter } from 'events';
import { config } from './config.js';

if (!config.bot?.token) throw new Error('BOT_TOKEN missing');

// Экспортируем константу bot ПЕРВОЙ, чтобы другие модули её видели
export const bot = new TelegramBot(config.bot.token, {
    polling: false, // Выключено, запустим вручную в bot.js
    request: { agentOptions: { keepAlive: true, maxSockets: 50 } }
});

// Исправляем лимит слушателей через прототип (решает TypeError)
try {
    EventEmitter.prototype.setMaxListeners.call(bot, 100);
} catch (e) {}

console.log('✅ [CORE] Бот инициализирован');
import TelegramBot from 'node-telegram-bot-api';

//import 'dotenv/config'; // Автоматически подтягивает всё из .env
import TelegramBot from 'node-telegram-bot-api';

// Достаем токен из секретного места
const token = process.env.TELEGRAM_TOKEN;

// Защита от дурака: если забыли создать .env
if (!token) {
  console.error('⚡️ ФАТАЛЬНАЯ ОШИБКА: Токен не найден! Проверь файл .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const mainMenu = {
  reply_markup: {
    keyboard: [
      ['🧮 Примерный расчет', '⚡️ Прайс-лист'],
      ['🏠 Умный дом', '📞 Вызвать на замер']
    ],
    resize_keyboard: true
  }
};

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'друг';

  const welcomeText = `Салам, ${userName}! ⚡️ 
Добро пожаловать к специалистам по электромонтажу и Умным домам. 

Выбери нужный пункт в меню ниже 👇`;

  bot.sendMessage(chatId, welcomeText, mainMenu);
});

console.log('⚡️ Бот ProElectro KZ запущен (PRO-режим с .env) и ждет клиентов!');
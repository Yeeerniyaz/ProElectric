/**
 * @file src/core.js
 * @description Ядро бота (Core Instance Factory).
 * Инициализирует экземпляр TelegramBot с оптимизированными сетевыми настройками.
 * Реализует паттерн Singleton для доступа к API.
 * @version 6.0.0 (High-Performance Core)
 */

import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";

// =============================================================================
// ⚙️ SYSTEM CONFIGURATION
// =============================================================================

if (!config.bot.token) {
  console.error("🔥 [CORE FATAL] BOT_TOKEN is missing in configuration.");
  process.exit(1);
}

/**
 * Настройки HTTP-клиента (оптимизация сети).
 * Включаем Keep-Alive для переиспользования TCP-соединений.
 */
const requestOptions = {
  agentOptions: {
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 50,
  },
  // Тайм-аут запроса (чтобы бот не вис при проблемах сети Telegram)
  timeout: 30000,
};

/**
 * Конфигурация Polling (используется, если Controller выберет этот режим).
 */
const pollingOptions = {
  interval: 300, // Short-polling interval (ms)
  autoStart: false, // ⚠️ ВАЖНО: Контроль запуска делегирован в src/bot.js
  params: {
    timeout: 10, // Long-polling timeout (sec)
  },
};

// =============================================================================
// 🤖 BOT INSTANCE
// =============================================================================

console.log(`🏗 [CORE] Инициализация ядра бота (${config.system.env})...`);

export const bot = new TelegramBot(config.bot.token, {
  polling: false, // По умолчанию выключено. Включается в src/bot.js
  request: requestOptions,
  // baseApiUrl: '...' // Можно добавить прокси-сервер API при необходимости
});

// Увеличиваем лимит слушателей, чтобы избежать MemoryLeakWarning
// при большом количестве хендлеров
bot.setMaxListeners(30);

// =============================================================================
// 🛡 SYSTEM-LEVEL ERROR HANDLING
// =============================================================================

/**
 * Глобальный перехватчик ошибок процесса.
 * Предотвращает падение контейнера из-за необработанных промисов.
 */
const setupProcessSafety = () => {
  process.on("unhandledRejection", (reason, promise) => {
    // Логируем, но не крашим процесс в проде (в деве можно крашить для отладки)
    console.error("🔥 [FATAL] Unhandled Rejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    console.error("🔥 [FATAL] Uncaught Exception:", error);
    // Критическая ошибка -> Restart Policy контейнера перезапустит процесс
    process.exit(1);
  });

  // Graceful Shutdown сигналы обрабатываются в src/bot.js контроллером
};

setupProcessSafety();

console.log(`✅ [CORE] Ядро готово. Instance ID: ${Date.now().toString(36)}`);

/**
 * @file src/bot.js
 * @description Bot Orchestrator (Controller).
 * Управляет жизненным циклом Telegram-бота, стратегией запуска (Polling/Webhook),
 * регистрацией middleware и глобальной обработкой ошибок.
 * @version 5.0.0 (Enterprise Architecture)
 */

import { bot } from "./core.js";
import { config } from "./config.js";

// Импорт слоев обработки (Layers)
import { setupAuthHandlers } from "./handlers/auth.js"; // Layer 1: Security & Identity
import { setupAdminHandlers } from "./handlers/admin.js"; // Layer 2: Administrative Control
import { setupCallbackHandlers } from "./handlers/callbacks.js"; // Layer 3: Interactive UI
import { setupMessageHandlers } from "./handlers/messages.js"; // Layer 4: Business Logic & Wizard

// =============================================================================
// 🛡 GLOBAL ERROR BOUNDARY
// =============================================================================

const setupErrorHandling = () => {
  // Перехват ошибок поллинга (сеть, токен и т.д.)
  bot.on("polling_error", (error) => {
    // Игнорируем частые ошибки сети, чтобы не засорять логи
    if (error.code === "EFATAL" || error.code === "ETIMEDOUT") return;
    console.error(`💥 [BOT POLLING ERROR] ${error.code}: ${error.message}`);
  });

  // Перехват ошибок вебхука
  bot.on("webhook_error", (error) => {
    console.error(`💥 [BOT WEBHOOK ERROR] ${error.code}: ${error.message}`);
  });

  // Глобальный перехват необработанных ошибок внутри хендлеров
  bot.on("error", (error) => {
    console.error(`💥 [BOT GENERAL ERROR]`, error);
  });
};

// =============================================================================
// 🚀 LAUNCH STRATEGIES
// =============================================================================

/**
 * Стратегия запуска: Long Polling (для разработки)
 */
const launchPolling = async () => {
  try {
    // Обязательно удаляем вебхук перед поллингом, иначе Telegram не будет отдавать апдейты
    await bot.deleteWebHook();
    console.log("🧹 [BOT] Вебхуки очищены. Запуск Long Polling...");

    // В библиотеке node-telegram-bot-api поллинг запускается автоматически,
    // если в конструкторе (core.js) polling: true.
    // Если там false, можно вызвать bot.startPolling() здесь.
  } catch (e) {
    console.warn("⚠️ [BOT] Warning during webhook cleanup:", e.message);
  }
};

/**
 * Стратегия запуска: Webhook (для продакшена)
 * @note Требует HTTPS и настройки домена в config.js
 */
const launchWebhook = async () => {
  const { url, port, path } = config.bot.webhook || {};
  if (!url) {
    console.error(
      "❌ [BOT FATAL] Webhook URL not configured. Falling back to polling.",
    );
    return launchPolling();
  }

  try {
    await bot.setWebHook(`${url}${path}`);
    console.log(`🚀 [BOT] Webhook установлен: ${url}${path}`);
  } catch (e) {
    console.error("💥 [BOT FATAL] Failed to set webhook:", e.message);
  }
};

// =============================================================================
// 🧠 INITIALIZATION PIPELINE
// =============================================================================

export const BotController = {
  /**
   * Инициализация и запуск бота.
   */
  async init() {
    console.log("🤖 [BOT] Starting initialization sequence...");
    const start = Date.now();

    // 1. Setup Error Boundaries
    setupErrorHandling();

    // 2. Register Handlers (Middleware Pipeline)
    // Порядок критически важен: от специфичного к общему.
    try {
      console.log("📦 [BOT] Registering handlers...");

      setupAuthHandlers(); // 1. Проверка прав (/login, /assign)
      setupAdminHandlers(); // 2. Админка (/admin, /broadcast)
      setupCallbackHandlers(); // 3. Инлайн кнопки (действия)
      setupMessageHandlers(); // 4. Текст, меню и визарды (все остальное)

      console.log("✅ [BOT] Handlers registered successfully.");
    } catch (e) {
      console.error("💥 [BOT FATAL] Handler registration failed:", e);
      process.exit(1); // Не запускаемся, если логика сломана
    }

    // 3. Channel Post Bridging
    // Позволяет боту обрабатывать команды в каналах так же, как в личке
    bot.on("channel_post", (msg) => {
      // Защита от бесконечного цикла (если бот пишет сам себе)
      if (msg.from && msg.from.id === config.bot.id) return;
      bot.emit("message", msg);
    });

    // 4. Launch Strategy Execution
    // Если в конфиге NODE_ENV = production, можно включать вебхук.
    // Для текущей задачи по умолчанию используем Polling.
    const useWebhook =
      config.system?.env === "production" && config.bot.webhook?.enabled;

    if (useWebhook) {
      await launchWebhook();
    } else {
      await launchPolling();
    }

    const duration = Date.now() - start;
    console.log(
      `✅ [BOT] System Online (${duration}ms). Mode: ${useWebhook ? "Webhook" : "Polling"}`,
    );
  },

  /**
   * Graceful Shutdown
   * Останавливает получение обновлений.
   */
  async stop() {
    console.log("🛑 [BOT] Stopping...");
    try {
      await bot.stopPolling();
      console.log("🛑 [BOT] Polling stopped.");
    } catch (e) {
      // Игнорируем ошибки при остановке
    }
  },
};

// Экспортируем метод init для совместимости с index.js
export const initBot = BotController.init;

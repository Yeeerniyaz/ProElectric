/**
 * @file src/bot.js
 * @description Bot Orchestrator (Controller).
 * Архитектурное решение уровня Enterprise.
 * Реализует паттерны: Singleton, Failover Strategy, Middleware Pipeline.
 * * @author Erniyaz & AI Partner
 * @version 6.0.0 (God Mode)
 */

import { bot } from "./core.js";
import { config } from "./config.js";

// Импорт слоев обработки (Business Logic Layers)
import { setupAuthHandlers } from "./handlers/auth.js";      // Layer 1: Security
import { setupAdminHandlers } from "./handlers/admin.js";    // Layer 2: Administration
import { setupCallbackHandlers } from "./handlers/callbacks.js"; // Layer 3: Interaction
import { setupMessageHandlers } from "./handlers/messages.js";   // Layer 4: General Logic

// =============================================================================
// 🛡 SECURITY & STABILITY BOUNDARIES
// =============================================================================

const setupErrorHandling = () => {
  // Обработка критических ошибок поллинга
  bot.on("polling_error", (error) => {
    // Подавляем шум в логах от сетевых сбоев
    const ignoreCodes = ["EFATAL", "ETIMEDOUT", "ECONNRESET"];
    if (ignoreCodes.includes(error.code)) return;
    
    console.error(`💥 [BOT POLLING] ${error.code || 'Unknown'}: ${error.message}`);
  });

  // Обработка ошибок вебхука
  bot.on("webhook_error", (error) => {
    console.error(`💥 [BOT WEBHOOK] Error: ${error.message}`);
  });

  // Глобальный catch для асинхронных ошибок внутри хендлеров
  bot.on("error", (error) => {
    console.error(`☠️ [BOT CRITICAL] Uncaught exception inside bot instance:`, error);
  });
};

// =============================================================================
// 🚀 LAUNCH STRATEGIES (STRATEGY PATTERN)
// =============================================================================

/**
 * Запуск через Long Polling.
 * Используется для Dev-режима или как Fallback для Prod.
 */
const launchPolling = async (reason = "Direct request") => {
  try {
    // 1. Очищаем вебхук (Telegram не даст полить, если висит хук)
    await bot.deleteWebHook();
    console.log(`🧹 [BOT] Вебхук удален. Причина: ${reason}`);

    // 2. Оптимизированные параметры поллинга
    const pollingOptions = {
      polling: {
        interval: 300,      // Задержка между запросами (мс)
        autoStart: true,    // Авто-старт
        params: {
          timeout: 10       // Long polling timeout (сек)
        }
      }
    };

    // 3. 🔥 ФИКС: Явный запуск поллинга, так как в core.js polling: false
    await bot.startPolling(pollingOptions);
    
    console.log("🚀 [BOT] Long Polling успешно запущен и слушает эфир...");
  } catch (e) {
    console.error("☠️ [BOT FATAL] Не удалось запустить Polling:", e.message);
    process.exit(1); // Если даже поллинг не встал — тушим свет
  }
};

/**
 * Запуск через Webhook.
 * @returns {Promise<boolean>} Успешно ли запустился
 */
const launchWebhook = async () => {
  const { url, port, path, enabled } = config.bot.webhook || {};
  
  if (!enabled || !url) {
    console.warn("⚠️ [BOT] Webhook конфиг не найден или выключен.");
    return false; 
  }

  try {
    // Формируем полный URL
    const webhookUrl = `${url}${path}`;
    await bot.setWebHook(webhookUrl);
    console.log(`🚀 [BOT] Webhook активирован: ${webhookUrl}`);
    return true;
  } catch (e) {
    console.error(`⚠️ [BOT] Ошибка установки Webhook: ${e.message}`);
    return false; // Возвращаем false для активации Fallback
  }
};

// =============================================================================
// 🧠 BOT CONTROLLER (SINGLETON)
// =============================================================================

export const BotController = {
  /**
   * Главная точка входа.
   * Инициализирует пайплайн обработки и выбирает стратегию запуска.
   */
  async init() {
    console.log("\n🤖 [BOT] System initialization sequence started...");
    const start = Date.now();

    // 1. Установка ловушек ошибок (First Line of Defense)
    setupErrorHandling();

    // 2. Регистрация Middleware (Важен порядок!)
    try {
      setupAuthHandlers();     // Кто ты?
      setupAdminHandlers();    // Ты босс?
      setupCallbackHandlers(); // Куда тыкнул?
      setupMessageHandlers();  // Чё написал?
      
      console.log("📦 [BOT] Все модули (Handlers) загружены.");
    } catch (e) {
      console.error("❌ [BOT] Ошибка при регистрации хендлеров:", e);
      process.exit(1);
    }

    // 3. Мост для каналов (Channel Post Bridging)
    // Превращает посты в каналах в обычные сообщения (с осторожностью)
    bot.on("channel_post", (msg) => {
      if (msg.from?.id === config.bot.id) return; // Игнор самоспама
      // Можно добавить проверку ID канала, если нужно
      bot.emit("message", msg);
    });

    // 4. Выбор стратегии запуска (Smart Launch)
    const isProduction = config.system?.env === "production";
    let launchSuccess = false;

    if (isProduction) {
      console.log("🌍 [BOT] Обнаружен Production environment.");
      launchSuccess = await launchWebhook();
      
      if (!launchSuccess) {
        console.warn("🔄 [BOT] Переключение на Polling (Fallback Strategy)...");
        await launchPolling("Webhook failed or disabled");
      }
    } else {
      console.log("👨‍💻 [BOT] Обнаружен Dev/Local environment.");
      await launchPolling("Dev Mode");
    }

    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`✅ [BOT] System Online. Ready to serve. (${duration}s)\n`);
  },

  /**
   * Мягкая остановка (Graceful Shutdown)
   */
  async stop() {
    console.log("🛑 [BOT] Получен сигнал остановки...");
    try {
      await bot.stopPolling();
      // Если был вебхук, его можно удалить, но обычно это не обязательно при рестарте
      console.log("💤 [BOT] Бот ушел в спящий режим.");
    } catch (e) {
      console.error("⚠️ [BOT] Ошибка при остановке:", e.message);
    }
  }
};

// Экспорт для index.js
export const initBot = BotController.init;
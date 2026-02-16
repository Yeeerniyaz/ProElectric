/**
 * @file src/bot.js
 * @description Bot Orchestrator (Controller).
 * Ядро системы. Реализует паттерны: Singleton, Event Normalization, Failover Strategy.
 * Отвечает за жизнеобеспечение бота и маршрутизацию трафика (ЛС <-> Каналы).
 *
 * @author Erniyaz & AI Partner
 * @version 7.0.0 (Event Horizon)
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
    const ignoreCodes = ["EFATAL", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH"];
    if (ignoreCodes.includes(error.code)) return;
    
    console.error(`💥 [BOT POLLING] ${error.code || 'Unknown'}: ${error.message}`);
  });

  // Обработка ошибок вебхука
  bot.on("webhook_error", (error) => {
    console.error(`💥 [BOT WEBHOOK] Error: ${error.message}`);
  });

  // Глобальный щит от падений
  bot.on("error", (error) => {
    console.error(`☠️ [BOT CRITICAL] Uncaught exception inside bot instance:`, error);
  });
};

// =============================================================================
// 🌉 CHANNEL BRIDGE (EVENT NORMALIZER)
// =============================================================================

/**
 * Нормализует события из каналов, превращая их в понятные для бота сообщения.
 * Это позволяет использовать общие хендлеры для команд в каналах.
 */
const setupChannelBridging = () => {
  bot.on("channel_post", (msg) => {
    // 1. Защита от петель (игнорируем сообщения от самого бота)
    if (msg.from && msg.from.is_bot && msg.from.id === config.bot.id) return;
    
    // 2. Игнорируем сервисные сообщения (смена названия, закреп и т.д.)
    if (!msg.text && !msg.caption) return;

    // 3. 🛠 ПАТЧИНГ СООБЩЕНИЯ (CRITICAL)
    // В каналах часто нет поля 'from'. Эмулируем его, чтобы хендлеры не падали.
    if (!msg.from) {
      msg.from = {
        id: msg.chat.id,        // ID отправителя = ID канала
        first_name: msg.chat.title || "Channel Admin",
        username: msg.chat.username,
        is_bot: false,
        is_channel_post: true   // Маркер для логики
      };
    }

    // 4. Добавляем мета-данные контекста
    msg.context_type = 'channel';
    
    // 5. Логируем входящую активность из канала
    const textPreview = (msg.text || msg.caption || "").substring(0, 20);
    console.log(`📢 [CHANNEL BRIDGE] Post from ${msg.chat.title} (#${msg.chat.id}): "${textPreview}..."`);

    // 6. Пробрасываем в основной пайплайн обработки
    bot.emit("message", msg);
  });
};

// =============================================================================
// 🚀 LAUNCH STRATEGIES
// =============================================================================

const launchPolling = async (reason = "Direct request") => {
  try {
    // Гарантированная зачистка перед стартом
    await bot.deleteWebHook();
    console.log(`🧹 [BOT] Вебхук сброшен. Режим: Polling. Причина: ${reason}`);

    const pollingOptions = {
      polling: {
        interval: 300,      // Реактивность vs Нагрузка
        autoStart: true,
        params: { timeout: 10 }
      }
    };

    // Принудительный запуск (override polling: false in core)
    await bot.startPolling(pollingOptions);
    console.log("🚀 [BOT] Long Polling Engine: ONLINE");
    
  } catch (e) {
    console.error("☠️ [BOT FATAL] Ошибка запуска Polling:", e.message);
    process.exit(1);
  }
};

const launchWebhook = async () => {
  const { url, path, enabled } = config.bot.webhook || {};
  
  if (!enabled || !url) {
    console.warn("⚠️ [BOT] Webhook конфиг отсутствует. Переход к плану Б.");
    return false; 
  }

  try {
    const webhookUrl = `${url}${path}`;
    await bot.setWebHook(webhookUrl);
    console.log(`🚀 [BOT] Webhook Engine: ONLINE (${webhookUrl})`);
    return true;
  } catch (e) {
    console.error(`⚠️ [BOT] Webhook failed: ${e.message}`);
    return false;
  }
};

// =============================================================================
// 🧠 SYSTEM CONTROLLER
// =============================================================================

export const BotController = {
  async init() {
    console.log("\n🤖 [BOT] System initialization sequence...");
    const start = Date.now();

    // 1. Error Boundaries
    setupErrorHandling();

    // 2. Channel Bridge (Важно подключить ДО хендлеров или параллельно)
    setupChannelBridging();

    // 3. Register Middleware Layers
    try {
      setupAuthHandlers();     // Security Layer
      setupAdminHandlers();    // Admin Layer
      setupCallbackHandlers(); // UI Layer
      setupMessageHandlers();  // Business Logic Layer
      
      console.log("📦 [BOT] Middleware pipeline assembled.");
    } catch (e) {
      console.error("❌ [BOT] Middleware crash:", e);
      process.exit(1);
    }

    // 4. Launch Logic
    const isProduction = config.system?.env === "production";
    let launched = false;

    if (isProduction) {
      console.log("🌍 [ENV] Production detected.");
      launched = await launchWebhook();
      if (!launched) {
        console.warn("🔄 [FAILOVER] Activating Polling fallback...");
        await launchPolling("Webhook failover");
      }
    } else {
      console.log("👨‍💻 [ENV] Development detected.");
      await launchPolling("Dev Mode");
    }

    const t = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`✅ [BOT] SYSTEM READY. Latency check: ${t}s\n`);
  },

  async stop() {
    console.log("🛑 [BOT] Shutdown sequence initiated...");
    try {
      await bot.stopPolling();
      console.log("💤 [BOT] System parked.");
    } catch (e) {
      console.error("⚠️ [BOT] Shutdown error:", e.message);
    }
  }
};

export const initBot = BotController.init;
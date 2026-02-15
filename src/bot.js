import { bot } from "./core.js";
import { setupMessageHandlers } from "./handlers/messages.js";
import { setupCallbackHandlers } from "./handlers/callbacks.js";
import { setupAuthHandlers } from "./handlers/auth.js";

/**
 * Инициализация и запуск логики бота
 * @description Собирает все хендлеры и запускает безопасный Long Polling
 */
export const initBot = async () => {
  console.log("🤖 [BOT] Инициализация подсистем...");

  // 1. Подключаем слои логики (Controller Layer)
  // Важен порядок: сначала сообщения, потом колбэки, потом auth
  setupMessageHandlers();
  setupCallbackHandlers();
  setupAuthHandlers();

  // 2. Предварительная очистка (Best Practice)
  // 🔥 Удаляем вебхук перед запуском поллинга.
  // Это спасает от ошибки "409 Conflict", если предыдущая сессия зависла.
  try {
    await bot.deleteWebHook();
    console.log("🧹 [BOT] Вебхук успешно очищен.");
  } catch (e) {
    console.warn("⚠️ [BOT] Ошибка очистки вебхука (не критично):", e.message);
  }

  // 3. Запуск Long Polling (Конфигурация для High Load)
  console.log("🚀 [BOT] Запуск Long Polling...");

  // Мы не используем .then(), так как startPolling возвращает Promise,
  // но сам процесс идет в фоне. Настройки ниже делают бота отзывчивым.
  bot.startPolling({
    restart: true, // Перезапускать при потере соединения
    polling: {
      interval: 300, // Проверять обновления каждые 300мс (быстро и без нагрузки)
      autoStart: true,
      params: {
        timeout: 10, // Длинный запрос висит 10 сек (экономия трафика)
      },
    },
  });

  console.log("✅ [BOT] Система активна и принимает команды.");

  // 4. Глобальный перехват ошибок Telegram API (Error Boundary)
  bot.on("polling_error", (error) => {
    // Фильтруем шум: ошибки сети (ETIMEDOUT) — это норма, не паникуем
    if (
      error.code === "ETIMEDOUT" ||
      error.code === "EFATAL" ||
      error.code === "ECONNRESET"
    ) {
      // Можно просто игнорировать или писать warn, чтобы не засорять логи
      // console.warn(`⚠️ [NET] Нестабильная сеть: ${error.code}`);
      return;
    }
    console.error(
      `💥 [TELEGRAM ERROR] Code: ${error.code} | Msg: ${error.message}`,
    );
  });

  bot.on("webhook_error", (error) => {
    console.error(`💥 [WEBHOOK ERROR] ${error.code}: ${error.message}`);
  });
};

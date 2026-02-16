import { initDB } from "./src/db.js";
import { initBot } from "./src/bot.js";
import { config } from "./src/config.js";

async function bootstrap() {
  console.clear();
  console.log("========================================");
  console.log("🔌  P R O E L E C T R O   B O T  ");
  console.log("========================================");

  try {
    // 1. БАЗА ДАННЫХ
    await initDB();

    // 2. TELEGRAM BOT (Только бот, сервер отключен)
    await initBot();

    console.log("\n✅ [SYSTEM] БОТ ЗАПУЩЕН И ГОТОВ К РАБОТЕ!");
    console.log("========================================\n");

  } catch (error) {
    console.error("\n💥 [SYSTEM FATAL] КРИТИЧЕСКИЙ СБОЙ:");
    console.error(error);
    process.exit(1);
  }
}

bootstrap();
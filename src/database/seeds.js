/**
 * @file src/database/seeds.js
 * @description Модуль начального наполнения базы данных (Data Seeding Layer).
 * Отвечает за загрузку значений по умолчанию (дефолтных цен) при первом старте.
 * @module DatabaseSeeds
 * @version 1.0.0 (Senior Level)
 */

import { DB_KEYS, PRICING } from "../constants.js";

/**
 * Заполнить базу данных начальными значениями.
 * Выполняется в рамках транзакции инициализации.
 *
 * @param {import('pg').PoolClient} client - Клиент базы данных из пула
 * @returns {Promise<void>}
 */
export const seedData = async (client) => {
  console.log("⏳ [DB SEEDS] Проверка и загрузка начальных цен...");

  /**
   * Список настроек для загрузки.
   * Массив массивов: [Ключ в БД, Значение по умолчанию].
   * Значения берутся из файла constants.js, чтобы не было дублирования "магических чисел".
   */
  const defaultSettings = [
    // --- Черновые работы (Rough Work) ---
    // Штробление
    [DB_KEYS.STROBE_CONCRETE, PRICING.rough.strobeConcrete],
    [DB_KEYS.STROBE_BRICK, PRICING.rough.strobeBrick],
    [DB_KEYS.STROBE_GAS, PRICING.rough.strobeGas],

    // Сверление
    [DB_KEYS.DRILL_CONCRETE, PRICING.rough.drillConcrete],
    [DB_KEYS.DRILL_BRICK, PRICING.rough.drillBrick],
    [DB_KEYS.DRILL_GAS, PRICING.rough.drillGas],

    // Монтаж черновых точек
    [DB_KEYS.CABLE, PRICING.common.cable], // Кабель
    [DB_KEYS.BOX_INSTALL, PRICING.common.boxInstall], // Подрозетник
    [DB_KEYS.BOX_ASSEMBLY, PRICING.common.boxAssembly], // Распайка

    // --- Чистовые работы (Finish Work) ---
    [DB_KEYS.SOCKET_INSTALL, PRICING.common.socketInstall], // Розетка/Выключатель
    [DB_KEYS.SHIELD_MODULE, PRICING.common.shieldModule], // Модуль щита

    // --- Коэффициенты (Factors) ---
    [DB_KEYS.MAT_FACTOR, PRICING.common.matFactor], // Процент на материалы
  ];

  let insertedCount = 0;

  // Проходим по каждой настройке и пытаемся записать в базу
  for (const [key, value] of defaultSettings) {
    // SQL запрос с защитой от перезаписи.
    // ON CONFLICT (key) DO NOTHING означает:
    // Если запись с таким ключом (например, 'price_cable') уже существует,
    // база данных просто проигнорирует этот запрос.
    // Это сохраняет изменения, сделанные администратором вручную.
    const res = await client.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value],
    );

    // res.rowCount будет 1, если запись вставилась, и 0, если она уже была
    if (res.rowCount > 0) {
      insertedCount++;
    }
  }

  if (insertedCount > 0) {
    console.log(`✅ [DB SEEDS] Добавлено ${insertedCount} новых настроек.`);
  } else {
    console.log("✅ [DB SEEDS] Все настройки уже существуют. Пропуск.");
  }
};

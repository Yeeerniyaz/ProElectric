/**
 * @file src/database/index.js
 * @description Фасад базы данных (Database Entry Point).
 * * Отвечает за:
 * 1. Экспорт всех методов репозитория (единая точка доступа для Сервисов).
 * 2. Инициализацию схемы БД (DDL) при старте.
 * 3. Наполнение начальными данными (Seeding).
 * * Архитектура: Code-First Migration / Self-Healing Schema.
 *
 * @module Database
 * @version 6.2.0 (Senior Architect Edition)
 * @author ProElectric Team
 */

import { getClient, closePool, query } from "./connection.js";

// Ре-экспортируем все методы репозитория, чтобы сервисы импортировали их отсюда
// import { getUser, createOrder } from '../database/index.js';
export * from "./repository.js";
export { closePool };

// =============================================================================
// 🛠 SCHEMA DEFINITION (DDL)
// =============================================================================

/**
 * SQL-скрипты для создания таблиц.
 * Используем IF NOT EXISTS для безопасности перезапусков.
 */
const SCHEMA_SQL = `
  -- 1. Таблица Пользователей (CRM)
  CREATE TABLE IF NOT EXISTS users (
    telegram_id BIGINT PRIMARY KEY, -- Telegram ID как первичный ключ
    first_name TEXT,
    username TEXT,
    phone TEXT,
    role TEXT DEFAULT 'user',       -- Роли: user, admin, manager, owner, banned
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  -- 2. Таблица Заказов (Orders)
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(telegram_id),
    status TEXT DEFAULT 'new',      -- Статусы: new, processing, work, done, cancel
    total_price NUMERIC(12, 2) DEFAULT 0,
    details JSONB DEFAULT '{}',     -- Храним всю смету (объемы, стены) в JSONB
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  -- 3. Таблица Настроек (Dynamic Pricing)
  -- Key-Value хранилище для цен, чтобы менять их без деплоя кода
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
  );
  
  -- Индексы для ускорения поиска
  CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
`;

// =============================================================================
// 🌱 SEEDING DATA (DEFAULTS)
// =============================================================================

/**
 * Базовые настройки цен.
 * Применяются только если таблица пустая или ключа нет.
 */
const DEFAULT_SETTINGS = [
  // --- Черновые работы ---
  ["price_strobe_concrete", "2000"], // Штроба бетон
  ["price_strobe_brick", "1200"], // Штроба кирпич
  ["price_strobe_gas", "800"], // Штроба газоблок

  ["price_drill_concrete", "2500"], // Точка бетон
  ["price_drill_brick", "1500"], // Точка кирпич
  ["price_drill_gas", "1000"], // Точка газоблок

  // --- Монтаж ---
  ["price_cable", "350"], // Прокладка кабеля
  ["price_box_install", "500"], // Вмазка подрозетника
  ["price_socket_install", "1200"], // Установка механизма
  ["price_shield_module", "2500"], // Сборка щита (1 модуль)

  // --- Коэффициенты ---
  ["material_factor", "0.45"], // Материалы = 45% от работ
];

// =============================================================================
// 🚀 INITIALIZATION LOGIC
// =============================================================================

/**
 * Инициализация базы данных.
 * Запускает транзакцию для создания схемы и посева данных.
 * Должна быть вызвана перед стартом сервера.
 */
export const initDB = async () => {
  const client = await getClient(); // Берем клиента из пула для транзакции

  try {
    console.log("🛠 Checking database integrity...");
    await client.query("BEGIN");

    // 1. Накатываем схему
    await client.query(SCHEMA_SQL);

    // 2. Сидинг (Наполнение) настроек
    // Используем Prepared Statements внутри цикла для безопасности
    for (const [key, val] of DEFAULT_SETTINGS) {
      await client.query(
        `
        INSERT INTO settings (key, value) 
        VALUES ($1, $2)
        ON CONFLICT (key) DO NOTHING
      `,
        [key, val],
      );
    }

    // 3. Создаем владельца (если нужно, опционально)
    // Здесь можно добавить логику "если нет админов, назначить ID из env владельцем"

    await client.query("COMMIT");
    console.log("✅ Database initialized successfully (Schema + Seeds).");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("🔥 FATAL: Database initialization failed!");
    console.error(error);
    throw error; // Пробрасываем ошибку выше, чтобы остановить запуск приложения
  } finally {
    client.release(); // Обязательно возвращаем клиента в пул
  }
};

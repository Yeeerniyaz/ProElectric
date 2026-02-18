/**
 * @file src/database/index.js
 * @description Фасад базы данных (Database Entry Point v9.1.0 Enterprise).
 * Отвечает за:
 * 1. Экспорт всех методов репозитория (единая точка доступа для Сервисов).
 * 2. Инициализацию полной ERP схемы БД (DDL) при старте (вкл. Финансы и Чеки).
 * 3. Наполнение начальными данными (Seeding) под новый динамический прайс.
 *
 * Архитектура: Code-First Migration / Self-Healing Schema.
 *
 * @module Database
 * @version 9.1.0 (Senior Architect Edition)
 * @author ProElectric Team
 */

import { getClient, closePool, query } from "./connection.js";

// Ре-экспортируем все методы репозитория, чтобы сервисы импортировали их отсюда
export * from "./repository.js";

// Экспортируем ядро коннектов для прямых вызовов из Сервисов
export { closePool, query, getClient };

// =============================================================================
// 🛠 SCHEMA DEFINITION (DDL - ENTERPRISE ERP MODULE)
// =============================================================================

/**
 * Полные SQL-скрипты для создания всех таблиц системы.
 * Используем IF NOT EXISTS для безопасного обновления на живую.
 */
const SCHEMA_SQL = `
  -- 1. ТАБЛИЦА ПОЛЬЗОВАТЕЛЕЙ (CRM CORE)
  CREATE TABLE IF NOT EXISTS users (
    telegram_id BIGINT PRIMARY KEY,
    first_name TEXT,
    username TEXT,
    phone TEXT,
    role TEXT DEFAULT 'user',       -- Роли: user, admin, manager, owner, banned
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  -- 2. ТАБЛИЦА ЗАКАЗОВ (BUSINESS CORE)
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(telegram_id),
    status TEXT DEFAULT 'new',      -- Статусы: new, processing, work, done, cancel
    total_price NUMERIC(12, 2) DEFAULT 0,
    details JSONB DEFAULT '{}',     -- JSONB хранилище: BOM-спецификация и financials
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  -- 3. ТАБЛИЦА НАСТРОЕК (DYNAMIC PRICING)
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
  );

  -- 4. ТАБЛИЦА РАСХОДОВ ПО ОБЪЕКТАМ (OBJECT EXPENSES - NEW)
  -- Детализированный учет затрат под конкретный заказ.
  CREATE TABLE IF NOT EXISTS object_expenses (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL,
    category VARCHAR(100),          -- Категория: Материалы, Транспорт, Прочее
    comment TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );

  -- 5. ТАБЛИЦА ФИНАНСОВЫХ СЧЕТОВ (ACCOUNTS - NEW ERP)
  CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(telegram_id),
    name VARCHAR(255) NOT NULL,
    balance NUMERIC(12, 2) DEFAULT 0,
    type VARCHAR(50) DEFAULT 'cash',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  -- 6. ТАБЛИЦА ТРАНЗАКЦИЙ (TRANSACTIONS - NEW ERP)
  CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES accounts(id),
    user_id BIGINT REFERENCES users(telegram_id),
    amount NUMERIC(12, 2) NOT NULL,
    type VARCHAR(50) NOT NULL,
    category VARCHAR(100),
    comment TEXT,
    order_id INTEGER REFERENCES orders(id),
    created_at TIMESTAMP DEFAULT NOW()
  );
  
  -- ИНДЕКСЫ ДЛЯ УСКОРЕНИЯ АНАЛИТИКИ
  CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_expenses_order ON object_expenses(order_id);
`;

// =============================================================================
// 🌱 SEEDING DATA (DEFAULTS FOR v9.1.0)
// =============================================================================

/**
 * Базовые настройки цен, синхронизированные с OrderService.js v9.1.0.
 * Применяются (UPSERT) при старте, если ключа еще нет в базе.
 */
const DEFAULT_SETTINGS = [
  // --- Черновые работы (Подготовка) ---
  ["price_strobe_concrete", "1000"],
  ["price_strobe_brick", "700"],
  ["price_strobe_gas", "500"],
  ["price_drill_concrete", "500"],

  // --- Кабельные трассы ---
  ["price_cable_base", "455"],
  ["price_cable_corrugated", "200"],
  ["price_cable_channel", "90"],

  // --- Электроточки и Оборудование ---
  ["price_point_socket", "800"],
  ["price_point_box", "1200"],
  ["price_point_chandelier", "3500"],

  // --- Сборка электрощита ---
  ["price_shield_base_24", "9000"],
  ["price_shield_extra_module", "500"],

  // --- Финансовые Коэффициенты ---
  ["material_factor", "0.45"], // Эвристика: стоимость материалов = 45% от стоимости работ
];

// =============================================================================
// 🚀 INITIALIZATION LOGIC
// =============================================================================

/**
 * Инициализация базы данных (Запуск DDL и Seeding).
 * Запускает транзакцию для безопасного создания схемы и посева данных.
 * Должна быть вызвана строго перед стартом HTTP-сервера и Telegram-бота.
 */
export const initDB = async () => {
  const client = await getClient(); // Захватываем изолированный коннект из пула

  try {
    console.log(
      "🛠 [DB Module] Checking database integrity for v9.1.0 Enterprise...",
    );
    await client.query("BEGIN"); // Старт транзакции

    // 1. Накатываем полную схему
    await client.query(SCHEMA_SQL);

    // 2. Сидинг (Наполнение) системных настроек и цен
    for (const [key, val] of DEFAULT_SETTINGS) {
      await client.query(
        `
        INSERT INTO settings (key, value, updated_at) 
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO NOTHING
      `,
        [key, val],
      );
    }

    await client.query("COMMIT"); // Фиксация транзакции
    console.log(
      "✅ [DB Module] Database initialized successfully (Schema + Seeds updated).",
    );
  } catch (error) {
    await client.query("ROLLBACK"); // Откат в случае сбоя
    console.error("🔥 [DB Module] FATAL: Database initialization failed!");
    console.error(error);
    throw error; // Блокируем старт приложения (Fast Fail)
  } finally {
    client.release(); // Обязательное освобождение коннекта обратно в пул
  }
};

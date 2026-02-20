/**
 * @file src/database/schema.js
 * @description Слой определения схемы базы данных (Schema Definition Layer).
 * Отвечает за создание таблиц, индексов, ограничений (constraints) и связей.
 * Реализует паттерн "Code First" миграций с проверкой идемпотентности.
 * * Включает таблицы для:
 * - Пользователей (CRM) + Web OTP Auth
 * - Настроек системы (Dynamic Config)
 * - Бригад (ERP)
 * - Заказов и Смет (Business Core)
 * - Финансов и Транзакций (Accounting)
 * - PL/pgSQL Триггеры для WebSockets
 * ДОБАВЛЕНО: Таблица `user_sessions` для вечных сессий (connect-pg-simple).
 * * @module DatabaseSchema
 * @version 10.9.5 (Enterprise Standard - Original Layout)
 */

import { query } from "./connection.js";

/**
 * 🛠 Инициализация и обновление структуры базы данных.
 * Выполняется при старте приложения. Гарантирует наличие всех необходимых таблиц.
 * Использует SQL-конструкцию `IF NOT EXISTS` для безопасного повторного запуска.
 * * @returns {Promise<void>}
 * @throws {Error} Если невозможно подключиться к БД или выполнить DDL запросы.
 */
export const createTables = async () => {
  try {
    console.log(
      "🔄 [DB Schema] Запуск проверки целостности структуры базы данных...",
    );

    // =====================================================================
    // 0. ТАБЛИЦА СЕССИЙ (ДЛЯ ВЕЧНОЙ АВТОРИЗАЦИИ WEB CRM / APK) - NEW
    // =====================================================================
    await query(`
      CREATE TABLE IF NOT EXISTS "user_sessions" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
      );
    `);
    await query(
      `CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "user_sessions" ("expire");`,
    );

    // =====================================================================
    // 1. ТАБЛИЦА ПОЛЬЗОВАТЕЛЕЙ (USERS)
    // =====================================================================
    // Ядро CRM-системы. Хранит данные всех, кто взаимодействовал с ботом.
    // Используется BIGINT для telegram_id, так как int4 может переполниться.
    await query(`
            CREATE TABLE IF NOT EXISTS users (
                telegram_id BIGINT PRIMARY KEY,       -- Уникальный ID от Telegram
                first_name VARCHAR(255),              -- Имя пользователя
                username VARCHAR(255),                -- Юзернейм (без @)
                phone VARCHAR(50),                    -- Контактный номер (если предоставлен)
                role VARCHAR(50) DEFAULT 'user',      -- Роль (RBAC): 'owner', 'admin', 'manager', 'user'
                language_code VARCHAR(10) DEFAULT 'ru', -- Язык интерфейса
                is_blocked BOOLEAN DEFAULT FALSE,     -- Флаг: заблокировал ли пользователь бота
                last_active TIMESTAMP DEFAULT NOW(),  -- Дата последней активности (для метрик Retention)
                created_at TIMESTAMP DEFAULT NOW(),   -- Дата первой регистрации
                updated_at TIMESTAMP DEFAULT NOW()    -- Дата последнего обновления профиля
            );
        `);

    // Индекс для быстрой фильтрации по ролям (для админ-панели и рассылок)
    await query(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);`);

    // NEW: Безопасное добавление колонок для WEB OTP AUTH (Self-Healing)
    await query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS web_password VARCHAR(255);`,
    );
    await query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS web_password_expires TIMESTAMP;`,
    );

    // =====================================================================
    // 1.5. ТАБЛИЦА БРИГАД (BRIGADES - NEW ERP)
    // =====================================================================
    // Управление подрядчиками и распределение прибыли
    await query(`
            CREATE TABLE IF NOT EXISTS brigades (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                brigadier_id BIGINT REFERENCES users(telegram_id),
                profit_percentage NUMERIC(5, 2) DEFAULT 40.00,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);

    // =====================================================================
    // 2. ТАБЛИЦА НАСТРОЕК (SETTINGS)
    // =====================================================================
    // Хранит динамические параметры конфигурации (Key-Value Store).
    // Позволяет Администратору менять цены и коэффициенты без перезагрузки сервера.
    await query(`
            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(100) PRIMARY KEY,         -- Уникальный ключ настройки (напр. 'price_cable')
                value TEXT NOT NULL,                  -- Значение (всегда строка, парсится на уровне приложения)
                description TEXT,                     -- Описание настройки для администратора
                updated_at TIMESTAMP DEFAULT NOW()    -- Дата последнего изменения
            );
        `);

    // =====================================================================
    // 3. ТАБЛИЦА ЗАКАЗОВ (ORDERS)
    // =====================================================================
    // Основная бизнес-сущность. Хранит историю расчетов и реальных заявок.
    // Использует JSONB для хранения детализированной сметы, что позволяет
    // менять алгоритм расчета без изменения схемы БД (NoSQL-like подход).
    await query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,                -- Внутренний уникальный номер заказа
                user_id BIGINT REFERENCES users(telegram_id), -- Ссылка на клиента (Внешний ключ)
                assignee_id BIGINT REFERENCES users(telegram_id), -- Ответственный менеджер (опционально)
                
                status VARCHAR(50) DEFAULT 'new',     -- Статус: 'new', 'pending', 'completed', 'canceled'
                
                -- Основные параметры объекта (для быстрого поиска без парсинга JSON)
                area INTEGER,                         -- Площадь помещения (м²)
                
                -- Финансовые показатели
                total_price NUMERIC(12, 2) NOT NULL,  -- Итоговая сумма для клиента (с копейками)
                final_profit NUMERIC(12, 2),          -- Чистая прибыль компании (после вычета расходов)
                
                -- Детализация (Смета)
                -- Хранит полный объект расчета: { 
                --   wallType: 'concrete', 
                --   rooms: 2, 
                --   volumes: { cable: 100, points: 20... }, 
                --   breakdown: { work: 50000, material: 20000 } 
                -- }
                details JSONB,
                
                created_at TIMESTAMP DEFAULT NOW(),   -- Дата создания заявки
                updated_at TIMESTAMP DEFAULT NOW()    -- Дата последнего обновления статуса
            );
        `);

    // NEW: Добавляем привязку к бригаде и индекс для ускорения выборки
    await query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS brigade_id INTEGER REFERENCES brigades(id);`,
    );
    await query(
      `CREATE INDEX IF NOT EXISTS idx_orders_brigade ON orders(brigade_id);`,
    );

    // Индексы для ускорения выборок "Мои заказы" и аналитических отчетов
    await query(
      `CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);`,
    );
    await query(
      `CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);`,
    );
    await query(
      `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);`,
    );

    // =====================================================================
    // 4. ТАБЛИЦА ФИНАНСОВЫХ СЧЕТОВ (ACCOUNTS)
    // =====================================================================
    // Учет касс сотрудников и счетов компании.
    await query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id SERIAL PRIMARY KEY,
                user_id BIGINT REFERENCES users(telegram_id), -- Владелец счета (если персональная касса)
                name VARCHAR(255) NOT NULL,           -- Название счета (напр. "Касса Офис", "Карта Kaspi")
                balance NUMERIC(12, 2) DEFAULT 0,     -- Текущий баланс
                type VARCHAR(50) DEFAULT 'cash',      -- Тип: 'cash', 'bank', 'crypto', 'virtual', 'brigade_acc'
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);

    // =====================================================================
    // 5. ТАБЛИЦА ТРАНЗАКЦИЙ (TRANSACTIONS)
    // =====================================================================
    // История всех движений денежных средств (Double-Entry Bookkeeping element).
    await query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                account_id INTEGER REFERENCES accounts(id), -- Ссылка на счет
                user_id BIGINT REFERENCES users(telegram_id), -- Инициатор операции
                
                amount NUMERIC(12, 2) NOT NULL,       -- Сумма операции (+ приход, - расход)
                type VARCHAR(50) NOT NULL,            -- Тип: 'income', 'expense', 'transfer'
                category VARCHAR(100),                -- Категория: 'Зарплата', 'Материалы', 'Оплата заказа'
                comment TEXT,                         -- Комментарий
                
                order_id INTEGER REFERENCES orders(id), -- Привязка к заказу (если есть)
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

    // =====================================================================
    // 6. ТАБЛИЦА РАСХОДОВ ПО ОБЪЕКТАМ (OBJECT EXPENSES)
    // =====================================================================
    // Детализированный учет затрат под конкретный заказ для расчета маржинальности.
    await query(`
            CREATE TABLE IF NOT EXISTS object_expenses (
                id SERIAL PRIMARY KEY,
                order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE, -- Привязка к заказу
                amount NUMERIC(12, 2) NOT NULL,       -- Сумма расхода
                category VARCHAR(100),                -- Категория (Такси, Обед, Расходники)
                comment TEXT,                         -- Пояснение
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

    // =====================================================================
    // 7. ТРИГГЕРЫ REAL-TIME WEBSOCKETS (PL/pgSQL)
    // =====================================================================
    // Оповещение при изменении статуса заказа
    await query(`
            CREATE OR REPLACE FUNCTION notify_order_update() RETURNS trigger AS $$
            BEGIN
              PERFORM pg_notify('order_updates', json_build_object('order_id', NEW.id, 'status', NEW.status)::text);
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

    await query(`DROP TRIGGER IF EXISTS order_update_trigger ON orders;`);
    await query(`
            CREATE TRIGGER order_update_trigger 
            AFTER UPDATE OF status ON orders 
            FOR EACH ROW EXECUTE PROCEDURE notify_order_update();
        `);

    // Оповещение при изменении настроек цен (прайса)
    await query(`
            CREATE OR REPLACE FUNCTION notify_setting_update() RETURNS trigger AS $$
            BEGIN
              PERFORM pg_notify('settings_updates', json_build_object('key', NEW.key, 'value', NEW.value)::text);
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

    await query(`DROP TRIGGER IF EXISTS setting_update_trigger ON settings;`);
    await query(`
            CREATE TRIGGER setting_update_trigger 
            AFTER UPDATE OF value ON settings 
            FOR EACH ROW EXECUTE PROCEDURE notify_setting_update();
        `);

    console.log(
      "✅ [DB Schema] Структура базы данных успешно синхронизирована (версия 10.9.5 Enterprise).",
    );
  } catch (error) {
    console.error(
      "❌ [DB Schema] Критическая ошибка при инициализации схемы:",
      error,
    );
    console.error(
      "⚠️ Совет: Проверьте настройки подключения в .env и доступность PostgreSQL.",
    );
    // Пробрасываем ошибку выше, чтобы остановить запуск приложения, так как без БД работа невозможна
    throw error;
  }
};

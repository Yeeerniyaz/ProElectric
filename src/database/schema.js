/**
 * @file src/database/schema.js
 * @description Слой определения схемы базы данных (Schema Definition Layer).
 * Отвечает за создание таблиц, индексов и связей.
 * Обеспечивает идемпотентность (безопасный повторный запуск).
 * @module DatabaseSchema
 * @version 1.0.0 (Senior Level)
 */

/**
 * Функция создания структуры таблиц.
 * Выполняется последовательно в рамках одной транзакции.
 * Использует конструкцию IF NOT EXISTS для безопасных миграций.
 *
 * @param {import('pg').PoolClient} client - Клиент базы данных из пула, находящийся в транзакции
 * @returns {Promise<void>}
 */
export const createTables = async (client) => {
    console.log("⏳ [DB SCHEMA] Начало проверки и создания структуры таблиц...");

    // =========================================================================
    // 1. ТАБЛИЦА ПОЛЬЗОВАТЕЛЕЙ (USERS)
    // =========================================================================
    // Хранит информацию о всех, кто когда-либо писал боту.
    await client.query(`
        CREATE TABLE IF NOT EXISTS users (
            telegram_id BIGINT PRIMARY KEY, -- Уникальный ID от Telegram (BIGINT т.к. ID большие)
            first_name TEXT,                -- Имя пользователя
            username TEXT,                  -- Юзернейм (без @)
            phone TEXT,                     -- Номер телефона (если поделился)
            role TEXT DEFAULT 'client',     -- Роль: 'admin', 'manager', 'client'
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        );
    `);

    // =========================================================================
    // 2. ТАБЛИЦА НАСТРОЕК (SETTINGS)
    // =========================================================================
    // Хранит динамические параметры (цены, коэффициенты), которые можно менять из админки.
    await client.query(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, -- Уникальный ключ (например, 'price_cable')
            value TEXT NOT NULL,  -- Значение (всегда строка, парсится в коде)
            updated_at TIMESTAMP DEFAULT NOW()
        );
    `);

    // =========================================================================
    // 3. ТАБЛИЦА ЗАКАЗОВ (ORDERS)
    // =========================================================================
    // Основная сущность бизнес-процесса.
    await client.query(`
        CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY, -- Внутренний номер заказа
            user_id BIGINT REFERENCES users(telegram_id), -- Заказчик (Внешний ключ)
            assignee_id BIGINT REFERENCES users(telegram_id), -- Исполнитель (Менеджер/Мастер)
            status TEXT DEFAULT 'new', -- Статус: 'new', 'discuss', 'work', 'done', 'cancel'
            
            -- Основные параметры объекта
            area INTEGER, -- Площадь помещения в м²
            
            -- Финансы
            total_price NUMERIC(12, 2), -- Итоговая смета клиенту (12 цифр, 2 знака после запятой)
            final_profit NUMERIC(12, 2), -- Чистая прибыль компании (после вычета расходов)
            
            -- Детализация расчета (Смета)
            -- Храним полную структуру расчета (объемы работ, материалов) в JSON формате.
            -- Это позволяет гибко менять алгоритм калькулятора без изменения схемы БД.
            details JSONB, 
            
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        );
    `);

    // =========================================================================
    // 4. ТАБЛИЦА ФИНАНСОВЫХ СЧЕТОВ (ACCOUNTS)
    // =========================================================================
    // Кассы сотрудников и общие счета компании.
    await client.query(`
        CREATE TABLE IF NOT EXISTS accounts (
            id SERIAL PRIMARY KEY,
            user_id BIGINT REFERENCES users(telegram_id), -- Владелец счета (если есть)
            name TEXT NOT NULL,             -- Название (например, "Касса Ернияз")
            balance NUMERIC(12, 2) DEFAULT 0, -- Текущий баланс
            type TEXT DEFAULT 'cash',       -- Тип: 'cash' (наличные), 'card' (карта), 'virtual'
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        );
    `);

    // =========================================================================
    // 5. ТАБЛИЦА ТРАНЗАКЦИЙ (TRANSACTIONS)
    // =========================================================================
    // История всех движений денег. Ни одна копейка не должна пройти мимо этой таблицы.
    await client.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            account_id INTEGER REFERENCES accounts(id), -- С какого/на какой счет
            user_id BIGINT REFERENCES users(telegram_id), -- Кто инициатор операции
            amount NUMERIC(12, 2) NOT NULL, -- Сумма операции
            type TEXT NOT NULL,             -- Тип: 'income' (приход), 'expense' (расход)
            category TEXT,                  -- Категория: 'Оплата заказа', 'Зарплата', 'Материалы'
            comment TEXT,                   -- Комментарий к операции
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    // =========================================================================
    // 6. ТАБЛИЦА РАСХОДОВ ПО ОБЪЕКТАМ (OBJECT EXPENSES)
    // =========================================================================
    // Учет затрат конкретно под заказ (такси, закуп материала, обеды).
    // Позволяет высчитать чистую прибыль (Маржу) по каждому объекту.
    await client.query(`
        CREATE TABLE IF NOT EXISTS object_expenses (
            id SERIAL PRIMARY KEY,
            order_id INTEGER REFERENCES orders(id), -- Привязка к конкретному заказу
            amount NUMERIC(12, 2) NOT NULL,         -- Сумма расхода
            category TEXT,                          -- Категория расхода
            comment TEXT,                           -- Пояснение
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    console.log("✅ [DB SCHEMA] Структура базы данных успешно проверена и обновлена.");
};
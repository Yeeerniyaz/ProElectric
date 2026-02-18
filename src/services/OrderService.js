/**
 * @file src/services/OrderService.js
 * @description Сервис бизнес-логики заказов (Core Business Logic).
 * Отвечает за:
 * 1. Сложный инженерный расчет сметы (Complex Estimation).
 * 2. Динамическое ценообразование на основе данных из БД.
 * 3. Управление жизненным циклом заказа (State Machine).
 * 4. Финансовую аналитику и воронку продаж.
 * 5. Управление метаданными заказа (Адреса, Комментарии, Причины отказа).
 *
 * Архитектура: Self-Contained Module (все константы и правила внутри).
 *
 * @module OrderService
 * @version 6.5.0 (Enterprise CRM Edition)
 */

import * as db from "../database/index.js";

// =============================================================================
// 1. 🚦 STATE MACHINE & CONFIGURATION
// =============================================================================

/**
 * Расширенная модель статусов заказа.
 * Покрывает весь жизненный цикл от клика в боте до сдачи объекта.
 */
export const ORDER_STATUS = Object.freeze({
  // --- Pre-Sale (Лиды) ---
  DRAFT: "draft", // Технический статус: расчет создан, но не сохранен
  NEW: "new", // Клиент нажал "Оформить". Требует реакции менеджера.

  // --- Sales (Продажа) ---
  PROCESSING: "processing", // Менеджер взял в работу (звонок/переписка)
  CONFIRMED: "confirmed", // Замер согласован или договор подписан
  ON_HOLD: "on_hold", // Пауза (клиент думает, нет доступа к объекту)

  // --- Production (Стройка) ---
  WORK: "work", // Мастера вышли на объект
  MATERIAL_WAIT: "material", // Простой: ожидание чистовых материалов

  // --- Closing (Сдача) ---
  PENDING_PAYMENT: "payment", // Работы выполнены, акт подписан, ждем оплату
  DONE: "done", // Успех: деньги в кассе, проект закрыт

  // --- Negative / Archive ---
  CANCELED: "cancel", // Отказ клиента или невозможность выполнения
  DISPUTE: "dispute", // Конфликтная ситуация, нужен Арбитраж (Владелец)
  ARCHIVED: "archived", // Исторические данные, скрытые из оперативки
});

/**
 * Ключи настроек в таблице `settings` (Database Mapping).
 * Именно по этим ключам мы ищем цены в базе.
 */
const DB_KEYS = Object.freeze({
  // --- 1. Сложность: Газоблок (Soft) ---
  STROBE_GAS: "price_strobe_gas", // Штроба (ГБ)
  DRILL_GAS: "price_drill_gas", // Точка (ГБ)

  // --- 2. Сложность: Кирпич (Medium) ---
  STROBE_BRICK: "price_strobe_brick", // Штроба (Кирпич)
  DRILL_BRICK: "price_drill_brick", // Точка (Кирпич)

  // --- 3. Сложность: Бетон (Hard) ---
  STROBE_CONCRETE: "price_strobe_concrete", // Штроба (Бетон)
  DRILL_CONCRETE: "price_drill_concrete", // Точка (Бетон)

  // --- Общие работы ---
  CABLE: "price_cable", // Прокладка кабеля (м)
  BOX_INSTALL: "price_box_install", // Вмазка подрозетника (шт)
  SOCKET_INSTALL: "price_socket_install", // Установка механизма (шт)
  SHIELD_MODULE: "price_shield_module", // Сборка щита (за модуль)

  // --- Глобальные коэффициенты ---
  MAT_FACTOR: "material_factor", // Доля материалов от суммы работ (справочно)
});

/**
 * Инженерные эвристики (Heuristics).
 * Формулы расчета объемов на основе статистики реальных объектов.
 */
const ESTIMATE_RULES = Object.freeze({
  cablePerSqm: 6.5, // 6.5м кабеля на 1м² площади
  strobeFactor: 0.9, // 0.9м штробы на 1м² площади
  pointsPerSqm: 0.8, // 0.8 точек на 1м² (база)
  modulesPerRoom: 2, // +2 точки на комнату (нагрузка)
  boxesPerRoom: 1.5, // 1.5 распредкоробки на комнату
  minShieldModules: 12, // Минимальный щит (даже на студию)
  shieldModulesStep: 15, // +1 модуль за каждые 15м² сверх 40м²
});

/**
 * Цены по умолчанию (Fallback Strategy).
 * Используются ТОЛЬКО если база данных вернула NULL или недоступна.
 * Значения в тенге (KZT).
 */
const DEFAULT_PRICING = Object.freeze({
  rough: {
    strobeConcrete: 2000,
    strobeBrick: 1200,
    strobeGas: 800,
    drillConcrete: 2500,
    drillBrick: 1500,
    drillGas: 1000,
  },
  common: {
    boxInstall: 500,
    cable: 350,
    socketInstall: 1200,
    shieldModule: 2500,
    matFactor: 0.45, // 45% от стоимости работ
  },
});

// =============================================================================
// 2. 🧠 BUSINESS LOGIC IMPLEMENTATION
// =============================================================================

export const OrderService = {
  // Экспорт констант для использования в контроллерах
  ORDER_STATUS,

  /**
   * 🏗 Полный расчет сметы (Complex Estimate).
   * ИЗМЕНЕНИЕ: Теперь мы считаем ТОЛЬКО стоимость работ.
   * Материалы клиент закупает сам после замера (выводятся лишь справочно).
   *
   * @param {number} area - Площадь (м²)
   * @param {number} rooms - Комнат (шт)
   * @param {string} wallType - Тип стен ('wall_gas', 'wall_brick', 'wall_concrete')
   */
  async calculateComplexEstimate(area, rooms, wallType) {
    // 1. Загрузка цен (Dynamic Pricing)
    const settings = await db.getSettings();

    // Хелпер для безопасного получения цены (DB -> Fallback)
    const getPrice = (dbKey, fallbackValue) => {
      const val = parseFloat(settings[dbKey]);
      return !isNaN(val) && val > 0 ? val : fallbackValue;
    };

    // 2. Определение тарифов по сложности (Complexity Strategy)
    let priceStrobe = 0;
    let priceDrill = 0;

    switch (wallType) {
      case "wall_gas":
        priceStrobe = getPrice(
          DB_KEYS.STROBE_GAS,
          DEFAULT_PRICING.rough.strobeGas,
        );
        priceDrill = getPrice(
          DB_KEYS.DRILL_GAS,
          DEFAULT_PRICING.rough.drillGas,
        );
        break;
      case "wall_brick":
        priceStrobe = getPrice(
          DB_KEYS.STROBE_BRICK,
          DEFAULT_PRICING.rough.strobeBrick,
        );
        priceDrill = getPrice(
          DB_KEYS.DRILL_BRICK,
          DEFAULT_PRICING.rough.drillBrick,
        );
        break;
      case "wall_concrete":
      default:
        priceStrobe = getPrice(
          DB_KEYS.STROBE_CONCRETE,
          DEFAULT_PRICING.rough.strobeConcrete,
        );
        priceDrill = getPrice(
          DB_KEYS.DRILL_CONCRETE,
          DEFAULT_PRICING.rough.drillConcrete,
        );
        break;
    }

    // Загрузка общих расценок
    const priceCable = getPrice(DB_KEYS.CABLE, DEFAULT_PRICING.common.cable);
    const priceBox = getPrice(
      DB_KEYS.BOX_INSTALL,
      DEFAULT_PRICING.common.boxInstall,
    );
    const priceSocket = getPrice(
      DB_KEYS.SOCKET_INSTALL,
      DEFAULT_PRICING.common.socketInstall,
    );
    const priceShield = getPrice(
      DB_KEYS.SHIELD_MODULE,
      DEFAULT_PRICING.common.shieldModule,
    );
    const matFactor = getPrice(
      DB_KEYS.MAT_FACTOR,
      DEFAULT_PRICING.common.matFactor,
    );

    // 3. Расчет объемов (Engineering Calc)
    const volCable = Math.ceil(area * ESTIMATE_RULES.cablePerSqm);
    const volStrobe = Math.ceil(area * ESTIMATE_RULES.strobeFactor);
    const volPoints = Math.ceil(
      area * ESTIMATE_RULES.pointsPerSqm +
        rooms * ESTIMATE_RULES.modulesPerRoom,
    );
    const volBoxes = Math.ceil(rooms * ESTIMATE_RULES.boxesPerRoom);
    const volShield = Math.max(
      ESTIMATE_RULES.minShieldModules,
      Math.ceil(12 + Math.max(0, area - 40) / ESTIMATE_RULES.shieldModulesStep),
    );

    // 4. Финансовая смета (Breakdown)
    const costStrobe = volStrobe * priceStrobe;
    const costDrilling = volPoints * priceDrill;
    const costCable = volCable * priceCable;
    const costBoxes = volBoxes * priceBox;
    const costSocket = volPoints * priceSocket;
    const costShield = volShield * priceShield;

    // Итого ТОЛЬКО Работа
    const totalWork =
      costStrobe +
      costDrilling +
      costCable +
      costBoxes +
      costSocket +
      costShield;

    // Округляем сумму работ до 500 тенге
    const grandTotalWork = Math.ceil(totalWork / 500) * 500;

    // Справочная информация по материалам (НЕ плюсуется в чек клиента)
    const infoMaterial = Math.ceil(grandTotalWork * matFactor);

    // 5. Формирование DTO
    return {
      params: { area, rooms, wallType },
      volume: {
        points: volPoints,
        strobe: volStrobe,
        cable: volCable,
        modules: volShield,
        boxes: volBoxes,
      },
      prices: {
        baseDrill: priceDrill,
        baseStrobe: priceStrobe,
      },
      breakdown: {
        points: costDrilling + costSocket,
        strobe: costStrobe,
        cable: costCable,
        shield: costShield,
        boxes: costBoxes,
      },
      total: {
        work: grandTotalWork, // Реальная сумма к оплате фирме
        material_info: infoMaterial, // Только для справки менеджеру/клиенту
        grandTotal: grandTotalWork, // Заменяем старый grandTotal на чистую работу, чтобы не сломать старый код
      },
    };
  },

  /**
   * 📋 Выгрузка актуального прайс-листа для клиента и админа (Прямо из БД).
   */
  async getPublicPricelist() {
    const settings = await db.getSettings();

    const getPrice = (dbKey, fallbackValue) => {
      const val = parseFloat(settings[dbKey]);
      return !isNaN(val) && val > 0 ? val : fallbackValue;
    };

    return {
      cable: getPrice(DB_KEYS.CABLE, DEFAULT_PRICING.common.cable),
      socket: getPrice(
        DB_KEYS.SOCKET_INSTALL,
        DEFAULT_PRICING.common.socketInstall,
      ),
      strobeConcrete: getPrice(
        DB_KEYS.STROBE_CONCRETE,
        DEFAULT_PRICING.rough.strobeConcrete,
      ),
      strobeBrick: getPrice(
        DB_KEYS.STROBE_BRICK,
        DEFAULT_PRICING.rough.strobeBrick,
      ),
      strobeGas: getPrice(DB_KEYS.STROBE_GAS, DEFAULT_PRICING.rough.strobeGas),
      drillConcrete: getPrice(
        DB_KEYS.DRILL_CONCRETE,
        DEFAULT_PRICING.rough.drillConcrete,
      ),
      shield: getPrice(
        DB_KEYS.SHIELD_MODULE,
        DEFAULT_PRICING.common.shieldModule,
      ),
    };
  },

  /**
   * 📝 Создание заказа (Conversion).
   * @param {number} userId - ID клиента
   * @param {Object} estimate - Результат расчета
   */
  async createOrder(userId, estimate) {
    const orderData = {
      area: estimate.params.area,
      price: estimate.total.work, // Четко фиксируем только стоимость работ
      details: estimate, // JSONB поле
    };

    return await db.createOrder(userId, orderData);
  },

  /**
   * 🔄 Смена статуса (Transition).
   */
  async updateOrderStatus(orderId, newStatus) {
    const valid = Object.values(ORDER_STATUS);
    if (!valid.includes(newStatus)) {
      throw new Error(`Invalid status: ${newStatus}`);
    }
    await db.query(
      "UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2",
      [newStatus, orderId],
    );
    return true;
  },

  /**
   * 📍 Сохранение дополнительных метаданных заказа (Адрес, Причина отмены, Комментарий).
   * ИЗМЕНЕНИЕ: Используем мощь JSONB базы PostgreSQL для гибкого добавления полей.
   *
   * @param {number} orderId - ID заказа
   * @param {string} key - Ключ в JSONB (например: 'address', 'cancel_reason', 'comment')
   * @param {any} value - Значение
   */
  async updateOrderDetails(orderId, key, value) {
    // 1. Получаем текущий заказ
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error("Заказ не найден в базе данных");

    // 2. Достаем текущий JSONB details и обогащаем его
    const details = order.details || {};
    details[key] = value;

    // 3. Сохраняем обновленный объект в базу
    await db.query(
      "UPDATE orders SET details = $1, updated_at = NOW() WHERE id = $2",
      [details, orderId],
    );

    return details;
  },

  /**
   * 📊 Аналитика воронки (Admin Dashboard).
   */
  async getAdminStats() {
    const result = await db.query(`
      SELECT status, COUNT(*) as count, SUM(total_price) as sum
      FROM orders
      GROUP BY status
    `);

    const stats = {};
    Object.values(ORDER_STATUS).forEach(
      (s) => (stats[s] = { count: 0, sum: 0 }),
    );

    let totalRevenue = 0;
    let potentialRevenue = 0;

    for (const row of result.rows) {
      const s = row.status;
      const val = {
        count: parseInt(row.count || 0),
        sum: parseFloat(row.sum || 0),
      };

      if (stats[s]) stats[s] = val;
      if (s === ORDER_STATUS.DONE) totalRevenue += val.sum;

      if (
        ![
          ORDER_STATUS.CANCELED,
          ORDER_STATUS.ARCHIVED,
          ORDER_STATUS.DRAFT,
        ].includes(s)
      ) {
        potentialRevenue += val.sum;
      }
    }

    return {
      breakdown: stats,
      metrics: {
        totalRevenue,
        potentialRevenue,
        activeCount:
          stats[ORDER_STATUS.WORK].count + stats[ORDER_STATUS.PROCESSING].count,
      },
    };
  },

  /**
   * ♻️ Retention: Поиск брошенных корзин.
   */
  async getAbandonedCarts() {
    return (
      await db.query(
        `
      SELECT o.id, o.user_id, u.first_name, o.total_price, o.created_at
      FROM orders o
      JOIN users u ON o.user_id = u.telegram_id
      WHERE o.status IN ($1, $2)
      AND o.created_at < NOW() - INTERVAL '24 hours'
      AND o.created_at > NOW() - INTERVAL '72 hours'
    `,
        [ORDER_STATUS.NEW, ORDER_STATUS.DRAFT],
      )
    ).rows;
  },

  /**
   * 📂 Получить заказы пользователя (History).
   */
  async getUserOrders(userId) {
    return (
      await db.query(
        `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [userId],
      )
    ).rows;
  },

  /**
   * 🔍 Получить заказ по ID.
   */
  async getOrderById(orderId) {
    return (await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId]))
      .rows[0];
  },

  /**
   * 👷 Найти свободных менеджеров/мастеров.
   */
  async getAvailableMasters() {
    return (
      await db.query(
        `SELECT telegram_id, first_name FROM users WHERE role = 'manager'`,
      )
    ).rows;
  },
};

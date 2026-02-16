/**
 * @file src/services/OrderService.js
 * @description Сервис бизнес-логики заказов.
 * Отвечает за сложные расчеты сметы, финансовые транзакции и управление жизненным циклом заказа.
 * Полностью зависит от настроек в БД (динамическое ценообразование).
 * @module OrderService
 * @version 4.0.0 (Enterprise Level)
 */

import * as db from "../database/repository.js";
import {
  DB_KEYS,
  PRICING,
  ESTIMATE_RULES,
  ORDER_STATUS,
  ROLES,
} from "../constants.js";

export const OrderService = {
  /**
   * 🧮 Глубокий расчет стоимости электромонтажа (Hard Calculation).
   * Учитывает тип стен, площадь, кол-во комнат и настройки из БД.
   * * @param {number} area - Площадь помещения (м²)
   * @param {number} rooms - Количество комнат
   * @param {string} wallType - Тип стен ('wall_gas', 'wall_brick', 'wall_concrete')
   * @returns {Promise<Object>} Полный объект сметы с детализацией для сохранения в БД
   */
  async calculateComplexEstimate(area, rooms, wallType) {
    // 1. Загружаем актуальные настройки цен из Базы Данных
    // Это позволяет Админу менять цены на лету без перезапуска бота
    const settings = await db.getSettings();

    // Вспомогатльная функция: берет цену из БД, если нет — из констант (фоллбек)
    const getPrice = (key, defaultVal) => {
      const val = parseFloat(settings[key]);
      return isNaN(val) ? defaultVal : val;
    };

    // 2. Определяем расценки в зависимости от выбранного типа стен
    let priceStrobeMeter = 0; // Цена штробы за метр
    let priceDrillPoint = 0; // Цена высверливания лунки за шт

    switch (wallType) {
      case "wall_gas": // Газоблок (Мягкие стены)
        priceStrobeMeter = getPrice(
          DB_KEYS.STROBE_GAS,
          PRICING.rough.strobeGas,
        );
        priceDrillPoint = getPrice(DB_KEYS.DRILL_GAS, PRICING.rough.drillGas);
        break;
      case "wall_brick": // Кирпич (Средние)
        priceStrobeMeter = getPrice(
          DB_KEYS.STROBE_BRICK,
          PRICING.rough.strobeBrick,
        );
        priceDrillPoint = getPrice(
          DB_KEYS.DRILL_BRICK,
          PRICING.rough.drillBrick,
        );
        break;
      case "wall_concrete": // Бетон (Жесткие)
      default:
        priceStrobeMeter = getPrice(
          DB_KEYS.STROBE_CONCRETE,
          PRICING.rough.strobeConcrete,
        );
        priceDrillPoint = getPrice(
          DB_KEYS.DRILL_CONCRETE,
          PRICING.rough.drillConcrete,
        );
        break;
    }

    // 3. Расчет объемов работ (Heuristic Algorithms)
    // Алгоритмы основаны на статистике реальных объектов (см. constants.js)

    // Кабель: Площадь * коэффициент (обычно 6.5м на 1м² пола)
    const volCable = Math.ceil(area * ESTIMATE_RULES.cablePerSqm);

    // Штроба: Обычно чуть меньше площади по полу
    const volStrobe = Math.ceil(area * ESTIMATE_RULES.strobeFactor);

    // Точки (Розетки + Выключатели): Площадь * 0.8 + по 2 на комнату
    const volPoints = Math.ceil(
      area * ESTIMATE_RULES.pointsPerSqm +
        rooms * ESTIMATE_RULES.modulesPerRoom,
    );

    // Распаечные коробки (примерно 1.5 на комнату)
    const volBoxes = Math.ceil(rooms * ESTIMATE_RULES.boxesPerRoom);

    // Модули в щите (Автоматы, УЗО): Минимум 12, плюс запас от площади
    // Логика: каждые 15м² добавляют 1 автомат
    const volShieldModules = Math.max(
      ESTIMATE_RULES.minShieldModules,
      Math.ceil(12 + (area - 40) / 15),
    );

    // 4. Финансовый расчет (Money Breakdown)

    // --- Черновые работы (Rough Work) ---
    const costStrobe = volStrobe * priceStrobeMeter; // Штробление
    const costDrilling = volPoints * priceDrillPoint; // Сверление подрозетников
    const costBoxesInstall =
      volBoxes * getPrice(DB_KEYS.BOX_INSTALL, PRICING.common.boxInstall); // Вмазка коробок
    const costCableLaying =
      volCable * getPrice(DB_KEYS.CABLE, PRICING.common.cable); // Прокладка кабеля

    // --- Чистовые работы (Finish Work) ---
    // Установка механизмов (розеток)
    const costSocketInstall =
      volPoints *
      getPrice(DB_KEYS.SOCKET_INSTALL, PRICING.common.socketInstall);
    // Сборка щита (за модуль)
    const costShieldAssembly =
      volShieldModules *
      getPrice(DB_KEYS.SHIELD_MODULE, PRICING.common.shieldModule);

    // Сумма за РАБОТУ
    const totalWorkCost =
      costStrobe +
      costDrilling +
      costBoxesInstall +
      costCableLaying +
      costSocketInstall +
      costShieldAssembly;

    // --- Материалы (Materials) ---
    // Считаем как процент от стоимости работ (из настроек БД или 40% по дефолту)
    const materialFactor = getPrice(
      DB_KEYS.MAT_FACTOR,
      PRICING.common.matFactor,
    );
    const totalMaterialCost = Math.ceil(totalWorkCost * materialFactor);

    // --- ИТОГО ---
    // Округляем до 500 тенге для красивой цифры
    const rawTotal = totalWorkCost + totalMaterialCost;
    const grandTotal = Math.ceil(rawTotal / 500) * 500;

    // 5. Формируем результат
    // Структура строго соответствует той, что ожидает constants.js -> estimateResult
    return {
      params: {
        area,
        rooms,
        wallType,
      },
      volume: {
        cable: volCable,
        strobe: volStrobe,
        points: volPoints,
        modules: volShieldModules,
        boxes: volBoxes,
      },
      breakdown: {
        // Детализация в деньгах для показа клиенту
        strobe: costStrobe,
        points: costDrilling + costSocketInstall, // Сверление + Установка
        cable: costCableLaying,
        shield: costShieldAssembly,
        boxes: costBoxesInstall,
      },
      total: {
        work: totalWorkCost,
        material: totalMaterialCost,
        grandTotal: grandTotal,
      },
    };
  },

  /**
   * 📝 Создание заказа в БД.
   * Сохраняет "снэпшот" (слепок) расчета на момент создания, чтобы изменение цен
   * в будущем не меняло стоимость старых заказов.
   * * @param {number} userId - ID пользователя Telegram
   * @param {Object} calculationResult - Результат работы calculateComplexEstimate
   * @returns {Promise<Object>} Созданный заказ
   */
  async createOrder(userId, calculationResult) {
    const orderData = {
      area: calculationResult.params.area,
      price: calculationResult.total.grandTotal,
      details: calculationResult, // Сохраняем весь JSON с расчетами
    };

    // Вызываем репозиторий
    return await db.createOrder(userId, orderData);
  },

  /**
   * 📊 Получение статистики для Админа.
   * Агрегирует данные по финансам и заказам.
   */
  async getAdminStats() {
    // Здесь можно добавить сложные SQL запросы через репозиторий
    // Пока реализуем базовый подсчет через получение всех заказов
    // (Для Highload проектов это нужно делать отдельным SQL COUNT запросом)

    // Получаем последние 100 заказов для анализа
    const result = await db.query(`
            SELECT status, total_price, created_at 
            FROM orders 
            ORDER BY created_at DESC 
            LIMIT 100
        `);

    let newOrders = 0;
    let incomePotential = 0;

    for (const order of result.rows) {
      if (order.status === ORDER_STATUS.NEW) {
        newOrders++;
        incomePotential += parseFloat(order.total_price || 0);
      }
    }

    return {
      totalOrdersChecked: result.rows.length,
      newOrdersCount: newOrders,
      potentialRevenue: incomePotential,
    };
  },

  /**
   * 🕵️‍♂️ "Ловушка" для удержания клиентов (Retention).
   * Находит пользователей, которые сделали расчет, но не заказали за последние 24 часа.
   * Позволяет боту автоматически написать им: "Вам нужна помощь?"
   * * @returns {Promise<Array>} Список пользователей
   */
  async getAbandonedCarts() {
    // Ищем заказы со статусом 'new', созданные более 24 часов назад, но менее 48
    const sql = `
            SELECT o.id, o.user_id, u.first_name, o.total_price
            FROM orders o
            JOIN users u ON o.user_id = u.telegram_id
            WHERE o.status = 'new' 
            AND o.created_at < NOW() - INTERVAL '24 hours'
            AND o.created_at > NOW() - INTERVAL '48 hours'
        `;
    const res = await db.query(sql);
    return res.rows;
  },

  /**
   * 🔍 Поиск заказа по ID (с проверкой прав).
   */
  async getOrderById(orderId) {
    const res = await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
    return res.rows[0];
  },

  /**
   * 📂 Получить историю заказов конкретного пользователя.
   */
  async getUserOrders(userId) {
    const res = await db.query(
      `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [userId],
    );
    return res.rows;
  },

  /**
   * 👷‍♂️ Найти всех свободных мастеров (для Админа).
   */
  async getAvailableMasters() {
    const res = await db.query(
      `SELECT telegram_id, first_name, phone FROM users WHERE role = $1`,
      [ROLES.MANAGER], // В данном контексте Manager выполняет роль Мастера/Прораба
    );
    return res.rows;
  },
};

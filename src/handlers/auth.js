import { bot } from "../core.js";
import { db } from "../db.js";
import { config } from "../config.js";
import crypto from "crypto";

// ============================================================
// 🔐 UTILS
// ============================================================

const hashPassword = (pw) =>
  crypto.createHash("sha256").update(pw).digest("hex");
const generateRandomPassword = () => crypto.randomBytes(4).toString("hex");

/**
 * Проверка прав доступа (Gatekeeper)
 */
const checkGroupMembership = async (userId) => {
  const targetGroupId = config.bot.workGroupId || config.bot.groupId;

  // Если группа не задана - считаем, что доступ открыт (Dev mode)
  if (!targetGroupId) return true;

  try {
    const member = await bot.getChatMember(targetGroupId, userId);
    return ["creator", "administrator", "member", "restricted"].includes(
      member.status,
    );
  } catch (e) {
    console.warn(
      `⚠️ [AUTH] Не удалось проверить статус в группе ${targetGroupId} для ${userId}:`,
      e.message,
    );
    // Если бот не админ в группе или юзера там нет — возвращаем false
    return false;
  }
};

// ============================================================
// 🚀 LOGIC
// ============================================================

/**
 * Основной флоу входа/регистрации
 */
export const handleLoginFlow = async (msg, isNewRegistration = false) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    // 1. GATEKEEPER: Проверка группы
    const isMember = await checkGroupMembership(userId);
    if (!isMember) {
      console.warn(`⛔️ [AUTH] Access Denied for ${userId}`);
      return bot.sendMessage(
        chatId,
        `⛔️ <b>ДОСТУП ЗАПРЕЩЕН</b>\n\n` +
          `Этот бот только для сотрудников <b>ProElectro</b>.\n` +
          `Вы должны состоять в рабочей группе.`,
        { parse_mode: "HTML" },
      );
    }

    // 2. Получаем свежие данные из БД
    // 🔥 Делаем это ВСЕГДА, чтобы убедиться, что телефон на месте
    const userRes = await db.query(
      "SELECT id, role, phone, username FROM users WHERE telegram_id = $1",
      [userId],
    );
    const user = userRes.rows[0];

    // --- СЦЕНАРИЙ 1: ЮЗЕРА НЕТ В БАЗЕ ---
    if (!user) {
      return bot.sendMessage(
        chatId,
        `👋 <b>Добро пожаловать!</b>\n\n` +
          `Вас нет в системе. Нажмите кнопку ниже для регистрации.`,
        {
          parse_mode: "HTML",
          reply_markup: {
            keyboard: [
              [{ text: "📱 Отправить свой контакт", request_contact: true }],
            ],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        },
      );
    }

    // --- СЦЕНАРИЙ 2: ЮЗЕР ЕСТЬ, НО НЕТ ТЕЛЕФОНА ---
    if (!user.phone) {
      console.log(`⚠️ [AUTH] У юзера ${userId} нет телефона. Просим снова.`);
      return bot.sendMessage(
        chatId,
        "⚠️ Нам нужен ваш номер телефона для создания учетной записи.\nПожалуйста, нажмите кнопку ниже:",
        {
          reply_markup: {
            keyboard: [
              [{ text: "📱 Отправить контакт", request_contact: true }],
            ],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        },
      );
    }

    // 3. ГЕНЕРАЦИЯ ПАРОЛЯ
    const tempPassword = generateRandomPassword();
    const hashedPassword = hashPassword(tempPassword);

    // Обновляем хеш в базе
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
      hashedPassword,
      user.id,
    ]);

    // 4. ГЕНЕРАЦИЯ КАРТОЧКИ
    // Логин = чистый телефон. Если вдруг телефона нет (хотя проверка выше не пустит), берем username.
    const login = user.phone
      ? user.phone.replace(/[^0-9]/g, "")
      : user.username || `id${user.id}`;
    const dashboardUrl = "https://crm.proelectro.kz";

    let text = `🔐 <b>КАРТОЧКА ДОСТУПА</b>\n`;
    text += `➖➖➖➖➖➖➖➖➖➖\n`;
    text += `👤 <b>Логин:</b> <code>${login}</code>\n`;
    text += `🔑 <b>Пароль:</b> <code>${tempPassword}</code>\n`;
    text += `➖➖➖➖➖➖➖➖➖➖\n\n`;
    text += `🌍 <b>CRM:</b> ${dashboardUrl}\n\n`;

    text += isNewRegistration
      ? `👋 <b>Аккаунт создан!</b> Теперь у вас есть доступ к заказам.`
      : `⚠️ <i>Пароль обновлен. Используйте его для входа.</i>`;

    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: { remove_keyboard: true }, // Убираем клавиатуру контактов
    });
  } catch (e) {
    console.error("💥 [AUTH ERROR]:", e);
    bot.sendMessage(
      chatId,
      "❌ Произошла ошибка при авторизации. Попробуйте позже.",
    );
  }
};

// ============================================================
// 🎮 HANDLERS
// ============================================================
export const setupAuthHandlers = () => {
  // Команда /login
  bot.onText(/\/login/, async (msg) => {
    handleLoginFlow(msg);
  });

  // Команда /assign (для ручного назначения)
  bot.onText(/\/assign (\d+)/, async (msg, match) => {
    const orderId = match[1];
    const userId = msg.from.id;

    try {
      const userRes = await db.query(
        "SELECT id, role, first_name FROM users WHERE telegram_id = $1",
        [userId],
      );
      const user = userRes.rows[0];

      if (!user || !["admin", "manager"].includes(user.role)) {
        return bot.sendMessage(msg.chat.id, "⛔️ У вас нет прав менеджера.");
      }

      // Обновляем заказ (используем метод из db.js если есть, или сырой SQL)
      const updateRes = await db.query(
        `UPDATE orders SET assignee_id = $1, status = 'work', updated_at = NOW() WHERE id = $2 RETURNING id`,
        [user.id, orderId],
      );

      if (updateRes.rowCount === 0) {
        return bot.sendMessage(msg.chat.id, "❌ Заказ не найден.");
      }

      bot.sendMessage(
        msg.chat.id,
        `👷‍♂️ <b>ЗАКАЗ #${orderId} ПРИНЯТ!</b>\nОтветственный: ${user.first_name}`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error("💥 [ASSIGN ERROR]:", e);
    }
  });
};

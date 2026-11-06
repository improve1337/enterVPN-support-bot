import { config } from "../config.js";
import type { TicketMessage, TicketRecord } from "../db.js";

const brand = config.brandName;

/**
 * Тексты уходят с `parse_mode: "HTML"`: в никах и юзернеймах часто встречается
 * `_`, который ломает Markdown. В HTML экранировать нужно только три символа.
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const fmtDate = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const statusLabel = (ticket: TicketRecord): string =>
  ticket.status === "open" ? "🟢 открыт" : "⚪️ закрыт";

const userLine = (ticket: TicketRecord): string =>
  `${escapeHtml(ticket.firstName ?? "без имени")} · <code>${ticket.userId}</code>${
    ticket.username ? ` · @${escapeHtml(ticket.username)}` : ""
  }`;

export const welcomeText = (name: string | null): string =>
  [
    `👋 Привет${name ? `, <b>${escapeHtml(name)}</b>` : ""}! Это поддержка ${brand}.`,
    "",
    "Создайте тикет и опишите свою проблему — оператор ответит вам здесь же в ближайшее время.",
    "",
    "Просто напишите сообщение, и я заведу обращение.",
  ].join("\n");

export const helpText = (): string =>
  [
    "❓ <b>Как это работает</b>",
    "",
    "1. Напишите сообщение — я создам тикет и передам его оператору.",
    "2. Все следующие сообщения добавятся в тот же тикет.",
    "3. Ответ оператора придёт сюда же.",
    "4. Когда вопрос решён, оператор закроет тикет. Новое сообщение создаст новый.",
    "",
    "«📋 Мои тикеты» — статус ваших обращений.",
  ].join("\n");

export const ticketPromptText = (): string =>
  [
    "🎫 <b>Новое обращение</b>",
    "",
    "Опишите проблему одним сообщением — передам оператору.",
  ].join("\n");

export const ticketCreatedText = (ticketId: number): string =>
  [
    `✅ Тикет <b>#${ticketId}</b> создан.`,
    "",
    "Оператор ответит здесь же. Можно писать дальше — сообщения добавятся в этот тикет.",
  ].join("\n");

export const ticketAppendedText = (ticketId: number): string =>
  `✅ Добавил в тикет <b>#${ticketId}</b>.`;

export const ticketListText = (
  tickets: readonly TicketRecord[],
  title = "📋 <b>Мои тикеты</b>",
): string => {
  if (tickets.length === 0) {
    return [
      title,
      "",
      "Обращений пока нет. Напишите сообщение — я создам тикет.",
    ].join("\n");
  }
  return [
    title,
    "",
    ...tickets.map(
      (ticket) =>
        `#${ticket.id} · ${statusLabel(ticket)} · ${fmtDate(ticket.updatedAt)}`,
    ),
  ].join("\n");
};

export const ticketCardText = (
  ticket: TicketRecord,
  messages: readonly TicketMessage[],
  total: number,
): string =>
  [
    `🎫 <b>Тикет #${ticket.id}</b>`,
    "",
    `Пользователь: ${userLine(ticket)}`,
    `Статус: ${statusLabel(ticket)}`,
    `Создан: ${fmtDate(ticket.createdAt)}`,
    `Обновлён: ${fmtDate(ticket.updatedAt)}`,
    `Сообщений: ${total}`,
    "",
    ...(messages.length
      ? [
          "Последние сообщения:",
          ...messages.map(
            (message) =>
              `${message.direction === "in" ? "👤" : "🛠"} ${
                message.text ? escapeHtml(message.text.slice(0, 120)) : "<i>вложение</i>"
              }`,
          ),
        ]
      : ["Сообщений пока нет."]),
  ].join("\n");

/** Заголовок, который уходит админу перед копией сообщения пользователя. */
export const ticketMirrorText = (ticket: TicketRecord): string =>
  [
    `📨 <b>Тикет #${ticket.id}</b> · ${statusLabel(ticket)}`,
    `От: ${userLine(ticket)}`,
    "",
    "Ответьте <b>ответом</b> на это сообщение или на следующее — текст уйдёт пользователю.",
  ].join("\n");

export const ticketClosedText = (ticketId: number): string =>
  `🔒 Тикет <b>#${ticketId}</b> закрыт.`;

export const ticketReopenedText = (ticketId: number): string =>
  `🔓 Тикет <b>#${ticketId}</b> снова открыт.`;

export const adminPanelText = (): string =>
  [
    "🛠 <b>Админка поддержки</b>",
    "",
    "• 🎫 Открытые тикеты — список и карточки",
    "• 🔎 Найти тикет — по @username или Telegram ID",
    "• 👥 Админы — добавить и снять права",
    "• 📊 Статистика",
    "",
    "Ответить пользователю можно <b>ответом</b> на сообщение с его обращением.",
  ].join("\n");

export const adminListText = (
  envIds: readonly number[],
  dbIds: readonly number[],
): string =>
  [
    "👥 <b>Админы</b>",
    "",
    ...(envIds.length
      ? [
          "Из <code>ADMIN_IDS</code> — снять через панель нельзя:",
          ...envIds.map((id) => `• <code>${id}</code>`),
          "",
        ]
      : []),
    ...(dbIds.length
      ? ["Назначены через панель:", ...dbIds.map((id) => `• <code>${id}</code>`)]
      : ["Назначенных через панель пока нет."]),
  ].join("\n");

export const adminAddPromptText = (): string =>
  [
    "➕ <b>Новый админ</b>",
    "",
    "Отправьте числовой Telegram ID — пользователь сразу получит доступ к админ-панели.",
    "",
    "Отмена — любая кнопка меню.",
  ].join("\n");

export const adminAddedText = (telegramId: number): string =>
  `✅ Пользователь <code>${telegramId}</code> теперь админ.`;

export const findPromptText = (): string =>
  [
    "🔎 <b>Поиск тикетов</b>",
    "",
    "Отправьте <code>@username</code> или числовой Telegram ID.",
    "",
    "Отмена — любая кнопка меню.",
  ].join("\n");

export const findEmptyText = (query: string): string =>
  [
    "🔎 <b>Поиск тикетов</b>",
    "",
    `По запросу <code>${escapeHtml(query)}</code> ничего не найдено.`,
  ].join("\n");

export const statsText = (data: {
  users: number;
  admins: number;
  openTickets: number;
  closedTickets: number;
  messages: number;
}): string =>
  [
    "📊 <b>Статистика</b>",
    "",
    `Пользователей: <b>${data.users}</b>`,
    `Открытых тикетов: <b>${data.openTickets}</b>`,
    `Закрытых тикетов: <b>${data.closedTickets}</b>`,
    `Сообщений в тикетах: <b>${data.messages}</b>`,
    `Админов в панели: <b>${data.admins}</b>`,
  ].join("\n");

export const ticketForUserClosedText = (ticketId: number): string =>
  [
    `🔒 Тикет <b>#${ticketId}</b> закрыт оператором.`,
    "",
    "Если понадобится помощь снова — просто напишите, я создам новый тикет.",
  ].join("\n");

export { fmtDate };

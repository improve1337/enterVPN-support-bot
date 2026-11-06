import { InlineKeyboard, Keyboard } from "grammy";
import type { TicketRecord } from "../db.js";

/** Подписи кнопок главного меню: используются и в клавиатуре, и в чистке чата. */
export const MAIN_MENU_LABELS = [
  "🎫 Написать в поддержку",
  "📋 Мои тикеты",
  "❓ Помощь",
] as const;

/** Кнопка админки — только для админов. */
export const ADMIN_MENU_LABEL = "🛠 Админка";

export const isMainMenuLabel = (text: string): boolean =>
  (MAIN_MENU_LABELS as readonly string[]).includes(text) ||
  text === ADMIN_MENU_LABEL;

export const mainKeyboard = (isAdmin: boolean): Keyboard => {
  const keyboard = new Keyboard()
    .text(MAIN_MENU_LABELS[0])
    .text(MAIN_MENU_LABELS[1])
    .row()
    .text(MAIN_MENU_LABELS[2]);
  if (isAdmin) keyboard.row().text(ADMIN_MENU_LABEL);
  return keyboard.resized().persistent();
};

export const adminKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text("🎫 Открытые тикеты", "t:list")
    .row()
    .text("🔎 Найти тикет", "t:find")
    .row()
    .text("👥 Админы", "adm:list")
    .row()
    .text("📊 Статистика", "adm:stats");

/** Снятие прав: админов из ADMIN_IDS убрать нельзя, их тут нет. */
export const adminsKeyboard = (removableIds: readonly number[]): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  for (const id of removableIds) {
    keyboard.text(`➖ ${id}`, `adm:del:${id}`).row();
  }
  return keyboard.text("⬅️ Назад", "adm:panel");
};

/** Короткая подпись тикета в списках. */
export const ticketLabel = (ticket: TicketRecord): string =>
  ticket.username ? `@${ticket.username}` : String(ticket.userId);

export const ticketsKeyboard = (
  tickets: readonly TicketRecord[],
  back = "adm:panel",
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  for (const ticket of tickets) {
    keyboard.text(`#${ticket.id} · ${ticketLabel(ticket)}`, `t:show:${ticket.id}`).row();
  }
  return keyboard.text("⬅️ Назад", back);
};

export const ticketKeyboard = (ticket: TicketRecord): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  if (ticket.status === "open") {
    keyboard.text("🔒 Закрыть тикет", `t:close:${ticket.id}`);
  } else {
    keyboard.text("🔓 Открыть заново", `t:open:${ticket.id}`);
  }
  return keyboard.row().text("⬅️ К списку", "t:list");
};

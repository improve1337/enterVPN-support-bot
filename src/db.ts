import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username    TEXT,
  first_name  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  telegram_id INTEGER PRIMARY KEY,
  added_by    INTEGER,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_states (
  telegram_id INTEGER PRIMARY KEY,
  state       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  username   TEXT,
  first_name TEXT,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL,
  direction  TEXT NOT NULL,
  author_id  INTEGER NOT NULL,
  text       TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages ON ticket_messages(ticket_id);

CREATE TABLE IF NOT EXISTS mirror (
  admin_chat_id    INTEGER NOT NULL,
  admin_message_id INTEGER NOT NULL,
  ticket_id        INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (admin_chat_id, admin_message_id)
);
`;

/** Путь к БД может лежать в ещё не созданной папке (./data). */
function ensureDatabaseDir(): void {
  if (config.databasePath === ":memory:") return;
  mkdirSync(dirname(config.databasePath), { recursive: true });
}

ensureDatabaseDir();

const raw = new DatabaseSync(config.databasePath);

export function initDatabase(): void {
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec(SCHEMA);
}

const nowIso = (): string => new Date().toISOString();

// --- Пользователи ---

export interface UserRecord {
  telegramId: number;
  username: string | null;
  firstName: string | null;
  createdAt: string;
}

interface UserRow {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  created_at: string;
}

const toUser = (row: UserRow): UserRecord => ({
  telegramId: Number(row.telegram_id),
  username: row.username,
  firstName: row.first_name,
  createdAt: row.created_at,
});

export function upsertUser(input: {
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
}): UserRecord {
  const existing = getUser(input.telegramId);
  if (existing) {
    raw
      .prepare("UPDATE users SET username = ?, first_name = ? WHERE telegram_id = ?")
      .run(
        input.username ?? existing.username,
        input.firstName ?? existing.firstName,
        input.telegramId,
      );
    return getUser(input.telegramId) as UserRecord;
  }
  raw
    .prepare(
      `INSERT INTO users (telegram_id, username, first_name, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.telegramId,
      input.username ?? null,
      input.firstName ?? null,
      nowIso(),
    );
  return getUser(input.telegramId) as UserRecord;
}

export function getUser(telegramId: number): UserRecord | undefined {
  const row = raw
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(telegramId) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

// --- Админы ---

export function addAdmin(telegramId: number, addedBy: number | null): void {
  raw
    .prepare(
      `INSERT INTO admins (telegram_id, added_by, created_at) VALUES (?, ?, ?)
       ON CONFLICT(telegram_id) DO NOTHING`,
    )
    .run(telegramId, addedBy, nowIso());
}

export function removeAdmin(telegramId: number): void {
  raw.prepare("DELETE FROM admins WHERE telegram_id = ?").run(telegramId);
}

export function isDbAdmin(telegramId: number): boolean {
  const row = raw
    .prepare("SELECT 1 AS ok FROM admins WHERE telegram_id = ?")
    .get(telegramId) as { ok: number } | undefined;
  return row !== undefined;
}

export function listAdminIds(): number[] {
  const rows = raw
    .prepare("SELECT telegram_id FROM admins ORDER BY created_at")
    .all() as unknown as { telegram_id: number }[];
  return rows.map((row) => Number(row.telegram_id));
}

// --- Состояния диалога ---

/** Чего бот ждёт от следующего сообщения пользователя. */
export type UserState = "admin_add" | "find_ticket";

export function setUserState(telegramId: number, state: UserState): void {
  raw
    .prepare(
      `INSERT INTO user_states (telegram_id, state, created_at) VALUES (?, ?, ?)
       ON CONFLICT(telegram_id)
       DO UPDATE SET state = excluded.state, created_at = excluded.created_at`,
    )
    .run(telegramId, state, nowIso());
}

export function getUserState(telegramId: number): UserState | undefined {
  const row = raw
    .prepare("SELECT state FROM user_states WHERE telegram_id = ?")
    .get(telegramId) as { state: string } | undefined;
  return row ? (row.state as UserState) : undefined;
}

export function clearUserState(telegramId: number): void {
  raw.prepare("DELETE FROM user_states WHERE telegram_id = ?").run(telegramId);
}

// --- Тикеты ---

export type TicketStatus = "open" | "closed";

export interface TicketRecord {
  id: number;
  userId: number;
  username: string | null;
  firstName: string | null;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
}

interface TicketRow {
  id: number;
  user_id: number;
  username: string | null;
  first_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const toTicket = (row: TicketRow): TicketRecord => ({
  id: Number(row.id),
  userId: Number(row.user_id),
  username: row.username,
  firstName: row.first_name,
  status: row.status as TicketStatus,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function getTicket(id: number): TicketRecord | undefined {
  const row = raw
    .prepare("SELECT * FROM tickets WHERE id = ?")
    .get(id) as TicketRow | undefined;
  return row ? toTicket(row) : undefined;
}

/** Открытый тикет пользователя: у одного человека он максимум один. */
export function findOpenTicket(userId: number): TicketRecord | undefined {
  const row = raw
    .prepare(
      "SELECT * FROM tickets WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
    )
    .get(userId) as TicketRow | undefined;
  return row ? toTicket(row) : undefined;
}

export function createTicket(input: {
  userId: number;
  username: string | null;
  firstName: string | null;
}): TicketRecord {
  const now = nowIso();
  raw
    .prepare(
      `INSERT INTO tickets (user_id, username, first_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?)`,
    )
    .run(input.userId, input.username, input.firstName, now, now);
  const row = raw
    .prepare("SELECT * FROM tickets WHERE id = last_insert_rowid()")
    .get() as unknown as TicketRow;
  return toTicket(row);
}

export function setTicketStatus(id: number, status: TicketStatus): void {
  raw
    .prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, nowIso(), id);
}

export function touchTicket(id: number): void {
  raw.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(nowIso(), id);
}

export function listTickets(status: TicketStatus, limit = 10): TicketRecord[] {
  const rows = raw
    .prepare(
      "SELECT * FROM tickets WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
    )
    .all(status, limit) as unknown as TicketRow[];
  return rows.map(toTicket);
}

/** Поиск тикетов по Telegram ID или @username. */
export function findTicketsByUser(query: string): TicketRecord[] {
  const trimmed = query.trim();
  const username = trimmed.replace(/^@/, "");
  const numeric = Number(username);
  const userId = Number.isInteger(numeric) && numeric > 0 ? numeric : -1;
  const rows = raw
    .prepare(
      `SELECT * FROM tickets
       WHERE user_id = ? OR lower(username) = lower(?)
       ORDER BY updated_at DESC LIMIT 10`,
    )
    .all(userId, username) as unknown as TicketRow[];
  return rows.map(toTicket);
}

// --- Сообщения тикета ---

export type MessageDirection = "in" | "out";

export interface TicketMessage {
  id: number;
  ticketId: number;
  direction: MessageDirection;
  authorId: number;
  text: string | null;
  createdAt: string;
}

interface TicketMessageRow {
  id: number;
  ticket_id: number;
  direction: string;
  author_id: number;
  text: string | null;
  created_at: string;
}

const toMessage = (row: TicketMessageRow): TicketMessage => ({
  id: Number(row.id),
  ticketId: Number(row.ticket_id),
  direction: row.direction as MessageDirection,
  authorId: Number(row.author_id),
  text: row.text,
  createdAt: row.created_at,
});

export function addTicketMessage(input: {
  ticketId: number;
  direction: MessageDirection;
  authorId: number;
  text: string | null;
}): void {
  raw
    .prepare(
      `INSERT INTO ticket_messages (ticket_id, direction, author_id, text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.ticketId,
      input.direction,
      input.authorId,
      input.text,
      nowIso(),
    );
  touchTicket(input.ticketId);
}

export function listTicketMessages(
  ticketId: number,
  limit = 3,
): TicketMessage[] {
  const rows = raw
    .prepare(
      `SELECT * FROM ticket_messages WHERE ticket_id = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(ticketId, limit) as unknown as TicketMessageRow[];
  return rows.map(toMessage).reverse();
}

export function countTicketMessages(ticketId: number): number {
  const row = raw
    .prepare("SELECT COUNT(*) AS c FROM ticket_messages WHERE ticket_id = ?")
    .get(ticketId) as { c: number } | undefined;
  return row ? Number(row.c) : 0;
}

// --- Связь сообщений в чате админа с тикетом ---

export function saveMirror(
  adminChatId: number,
  adminMessageId: number,
  ticketId: number,
): void {
  raw
    .prepare(
      `INSERT INTO mirror (admin_chat_id, admin_message_id, ticket_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(admin_chat_id, admin_message_id)
       DO UPDATE SET ticket_id = excluded.ticket_id`,
    )
    .run(adminChatId, adminMessageId, ticketId, nowIso());
}

export function findMirror(
  adminChatId: number,
  adminMessageId: number,
): number | undefined {
  const row = raw
    .prepare(
      "SELECT ticket_id FROM mirror WHERE admin_chat_id = ? AND admin_message_id = ?",
    )
    .get(adminChatId, adminMessageId) as { ticket_id: number } | undefined;
  return row ? Number(row.ticket_id) : undefined;
}

// --- Статистика ---

export function stats(): {
  users: number;
  admins: number;
  openTickets: number;
  closedTickets: number;
  messages: number;
} {
  const one = (sql: string): number => {
    const row = raw.prepare(sql).get() as { c: number } | undefined;
    return row ? Number(row.c) : 0;
  };
  return {
    users: one("SELECT COUNT(*) AS c FROM users"),
    admins: one("SELECT COUNT(*) AS c FROM admins"),
    openTickets: one("SELECT COUNT(*) AS c FROM tickets WHERE status = 'open'"),
    closedTickets: one("SELECT COUNT(*) AS c FROM tickets WHERE status = 'closed'"),
    messages: one("SELECT COUNT(*) AS c FROM ticket_messages"),
  };
}

export function closeDatabase(): void {
  raw.close();
}

export { raw as db };

import { createRequire } from "node:module";
import { pino } from "pino";
import { config } from "./config.js";

const isDev = config.nodeEnv !== "production";

const require = createRequire(import.meta.url);

/**
 * `pino-pretty` лежит в devDependencies. На хостинге ставится только
 * production-часть (`npm ci --omit=dev`), и pino падает с SYNC ERROR при
 * попытке загрузить отсутствующий транспорт. Поэтому проверяем наличие
 * пакета и при отсутствии пишем обычный JSON.
 */
function hasPinoPretty(): boolean {
  try {
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

/** `bot<id>:<secret>` — токен бота, его нельзя показывать в логах. */
const TOKEN_PATTERN = /bot\d+:[A-Za-z0-9_-]+/g;

/** Вырезает токен бота из строки перед записью в лог. */
export function sanitize(text: string): string {
  return text.replace(TOKEN_PATTERN, "bot<redacted>");
}

export interface ErrorInfo {
  name: string;
  message: string;
  code?: string;
}

/**
 * Достаёт информацию об ошибке: собирает сообщения по цепочке
 * (`error`/`cause`) и вырезает токен. Полезно, потому что grammY кладёт
 * в `cause` URL с токеном.
 */
export function errorInfo(error: unknown): ErrorInfo {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let name = "Error";
  let code: string | undefined;
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const node = current as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      error?: unknown;
      cause?: unknown;
    };
    if (typeof node.name === "string" && node.name && name === "Error") {
      name = node.name;
    }
    if (typeof node.message === "string" && node.message) {
      messages.push(node.message);
    }
    if (!code && typeof node.code === "string") code = node.code;
    current = node.error ?? node.cause;
  }

  const message = sanitize(messages.join(" | ") || String(error));
  return code ? { name, message, code } : { name, message };
}

const usePretty = isDev && hasPinoPretty();

if (isDev && !usePretty) {
  console.warn(
    "[logger] pino-pretty не найден — логи пойдут в JSON. Для читаемых логов установите devDependencies.",
  );
}

export const logger = pino({
  level: config.logLevel,
  ...(usePretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }
    : {}),
  redact: {
    paths: [
      "BOT_TOKEN",
      "token",
      "*.token",
      "authorization",
      "X-Secret",
      "*.secret",
    ],
    censor: "[redacted]",
  },
});

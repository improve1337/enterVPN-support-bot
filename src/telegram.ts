import type { Agent } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { Api, Bot } from "grammy";
import { config } from "./config.js";
import { errorInfo, logger } from "./logger.js";

const SOCKS_SCHEMES = new Set([
  "socks",
  "socks4",
  "socks4a",
  "socks5",
  "socks5h",
]);

/** Создаёт агент для HTTP(S)- или SOCKS-прокси по URL. */
export function createTelegramAgent(proxyUrl: string): Agent {
  let scheme: string;
  try {
    scheme = new URL(proxyUrl).protocol.replace(":", "").toLowerCase();
  } catch {
    throw new Error(
      `TELEGRAM_PROXY имеет неверный формат: "${proxyUrl}". Пример: socks5://127.0.0.1:1080`,
    );
  }
  if (scheme === "http" || scheme === "https") {
    return new HttpsProxyAgent(proxyUrl);
  }
  if (SOCKS_SCHEMES.has(scheme)) {
    return new SocksProxyAgent(proxyUrl);
  }
  throw new Error(
    `Неподдерживаемая схема прокси "${scheme}". Поддерживаются http, https, socks4, socks5.`,
  );
}

/**
 * Опции клиента grammY. Без прокси возвращает пустой объект — тогда grammY
 * использует свои значения по умолчанию (keep-alive, сжатие).
 */
export function buildClientOptions(): {
  baseFetchConfig?: {
    agent: Agent;
    compress: boolean;
    duplex: "half";
  };
} {
  if (!config.telegramProxy) return {};
  const agent = createTelegramAgent(config.telegramProxy);
  logger.info(
    { proxy: redactProxy(config.telegramProxy) },
    "Telegram Bot API через прокси",
  );
  return { baseFetchConfig: { agent, compress: true, duplex: "half" } };
}

/** Скрывает логин/пароль прокси в логах. */
function redactProxy(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    return "<невалидный url>";
  }
}

export type PreflightResult =
  | { ok: true; username: string }
  | { ok: false; reason: "unreachable" | "unauthorized" | "unknown"; message: string };

/**
 * Проверка доступа к Telegram до старта polling: иначе бот молча висит,
 * а причина (блокировка, неверный токен) остаётся невидимой.
 */
export async function preflight(
  bot: Bot,
  timeoutMs = 15_000,
): Promise<PreflightResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const me = await bot.api.getMe(controller.signal as never);
    return { ok: true, username: me.username ?? String(me.id) };
  } catch (error) {
    const info = errorInfo(error);
    const haystack = `${info.message} ${info.code ?? ""}`;
    if (/401|unauthorized/i.test(haystack)) {
      return { ok: false, reason: "unauthorized", message: info.message };
    }
    if (
      /abort|timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPROTO|socket hang up|fetch failed|network request/i.test(
        haystack,
      )
    ) {
      return { ok: false, reason: "unreachable", message: info.message };
    }
    return { ok: false, reason: "unknown", message: info.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Понятный текст для лога при недоступности Telegram. */
export function describePreflightFailure(result: PreflightResult): string {
  if (result.ok) return "";
  if (result.reason === "unauthorized") {
    return "Telegram ответил 401 — неверный BOT_TOKEN. Проверьте значение в .env.";
  }
  if (result.reason === "unreachable") {
    return [
      "Telegram Bot API недоступен с этой машины (соединение не устанавливается).",
      "Скорее всего, api.telegram.org блокируется провайдером.",
      "Решения:",
      "  1) включить VPN/прокси на ПК и перезапустить бота;",
      "  2) указать прокси в .env: TELEGRAM_PROXY=socks5://127.0.0.1:1080",
      "     (или http://user:pass@host:port);",
      "  3) запустить бота на сервере в ЕС, где Telegram доступен.",
      "Проверить блокировку: curl.exe -m 10 https://api.telegram.org/",
    ].join("\n");
  }
  return `Не удалось связаться с Telegram: ${result.message}`;
}

// --- Список команд для кнопки меню Telegram (☰) ---

const PUBLIC_COMMANDS = [
  { command: "start", description: "Главное меню" },
  { command: "tickets", description: "Мои тикеты" },
  { command: "help", description: "Помощь" },
];

const ADMIN_COMMANDS = [
  ...PUBLIC_COMMANDS,
  { command: "admin", description: "Админ-панель" },
  { command: "find", description: "Найти тикеты: /find @username или ID" },
  { command: "close", description: "Закрыть тикет: /close @username или ID" },
  { command: "open", description: "Открыть тикет: /open @username или ID" },
];

/**
 * Регистрирует список команд: по нему Telegram рисует кнопку меню (☰).
 * Обычным пользователям — базовые команды, админам — ещё и админские.
 */
export async function registerCommands(
  api: Api,
  adminIds: readonly number[],
): Promise<void> {
  try {
    await api.setMyCommands(PUBLIC_COMMANDS);
    for (const adminId of adminIds) {
      await api.setMyCommands(ADMIN_COMMANDS, {
        scope: { type: "chat", chat_id: adminId },
      });
    }
    logger.info({ admins: adminIds.length }, "список команд Telegram обновлён");
  } catch (error) {
    logger.warn({ err: errorInfo(error) }, "не удалось обновить список команд");
  }
}

/** Переключает список команд конкретного чата между админским и обычным. */
export async function syncChatCommands(
  api: Api,
  chatId: number,
  admin: boolean,
): Promise<void> {
  try {
    if (admin) {
      await api.setMyCommands(ADMIN_COMMANDS, {
        scope: { type: "chat", chat_id: chatId },
      });
      return;
    }
    // Возврат к списку команд по умолчанию.
    await api.deleteMyCommands({ scope: { type: "chat", chat_id: chatId } });
  } catch (error) {
    logger.warn(
      { err: errorInfo(error), chatId },
      "не удалось обновить команды чата",
    );
  }
}

import { createServer } from "node:http";
import { allAdminIds } from "./admins.js";
import { createBot } from "./bot.js";
import { config } from "./config.js";
import { closeDatabase, initDatabase } from "./db.js";
import { errorInfo, logger } from "./logger.js";
import {
  describePreflightFailure,
  preflight,
  registerCommands,
} from "./telegram.js";

/** Минимальный HTTP-сервер: хостингу нужен эндпоинт для проверки живости. */
function startHealthServer(): void {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  server.listen(config.port, config.host, () => {
    logger.info({ port: config.port }, "HTTP-сервер мониторинга запущен");
  });
}

async function main(): Promise<void> {
  initDatabase();
  const bot = createBot();

  logger.info(
    {
      admins: allAdminIds(),
      db: config.databasePath,
      proxy: config.telegramProxy ? "включён" : "нет",
    },
    `${config.brandName} поддержка: запуск`,
  );

  if (allAdminIds().length === 0) {
    logger.warn(
      "Нет ни одного админа: тикеты никому не передаются, админ-панель никому не видна. Задайте ADMIN_IDS в переменных окружения хостинга.",
    );
  }

  const check = await preflight(bot);
  if (!check.ok) {
    logger.error(describePreflightFailure(check));
    if (check.reason === "unauthorized") {
      closeDatabase();
      process.exit(1);
    }
    logger.warn(
      "Продолжаю запуск: /health будет доступен, но бот не сможет получать сообщения.",
    );
  } else {
    logger.info({ bot: `@${check.username}` }, "Telegram доступен");
    await registerCommands(bot.api, allAdminIds());
  }

  startHealthServer();
  await bot.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "остановка");
    try {
      await bot.stop();
    } catch {
      // Бот мог ещё не стартовать.
    }
    closeDatabase();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error({ err: errorInfo(error) }, "фатальная ошибка запуска");
  process.exit(1);
});

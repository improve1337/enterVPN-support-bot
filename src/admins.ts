import { config } from "./config.js";
import { isDbAdmin, listAdminIds } from "./db.js";

/**
 * Админ — либо ID из `ADMIN_IDS` в окружении, либо тот, кого назначили через
 * админ-панель. Список из окружения намеренно неудаляем: он остаётся доступом
 * даже если база обнулится или в ней что-то сломается.
 */
export const isAdmin = (telegramId: number): boolean =>
  config.adminIds.includes(telegramId) || isDbAdmin(telegramId);

/** ID из окружения не удаляются через панель — их показываем отдельно. */
export const isEnvAdmin = (telegramId: number): boolean =>
  config.adminIds.includes(telegramId);

/** Все получатели тикетов: окружение + назначенные в панели. */
export const allAdminIds = (): number[] =>
  Array.from(new Set([...config.adminIds, ...listAdminIds()]));

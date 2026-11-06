import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const boolFromString = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return def;
      const v = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(v)) return true;
      if (["0", "false", "no", "off"].includes(v)) return false;
      return def;
    });

const csv = (value: string | undefined): number[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n));

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  BOT_TOKEN: z.string().min(10, "BOT_TOKEN is required"),
  BOT_USERNAME: z.string().default(""),
  BRAND_NAME: z.string().default("EnterVPN"),
  ADMIN_IDS: z.string().optional(),
  ADMIN_ID: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_PATH: z.string().default("./data/support.db"),
  BANNER_PATH: z.string().default("./welcomepic.png"),
  TELEGRAM_PROXY: z.string().optional(),
  /** Сколько последних сообщений тикета показывать в карточке. */
  TICKET_TAIL: z.coerce.number().int().positive().default(3),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`Некорректная конфигурация окружения:\n${details}`);
}

const env = parsed.data;

const adminIds = Array.from(
  new Set([...csv(env.ADMIN_IDS), ...csv(env.ADMIN_ID)]),
);

export const config = {
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  botToken: env.BOT_TOKEN,
  brandName: env.BRAND_NAME,
  adminIds,
  port: env.PORT,
  host: env.HOST,
  databasePath: env.DATABASE_PATH,
  bannerPath: env.BANNER_PATH,
  telegramProxy: env.TELEGRAM_PROXY,
  botUsername: env.BOT_USERNAME,
  ticketTail: env.TICKET_TAIL,
} as const;

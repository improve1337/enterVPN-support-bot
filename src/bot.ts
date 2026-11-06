import {
  Bot,
  GrammyError,
  HttpError,
  InputFile,
  InlineKeyboard,
  type Context,
} from "grammy";
import { existsSync } from "node:fs";
import { allAdminIds, isAdmin, isEnvAdmin } from "./admins.js";
import { createMessageTracker } from "./chat-cleanup.js";
import { config } from "./config.js";
import {
  addAdmin,
  addTicketMessage,
  clearUserState,
  countTicketMessages,
  createTicket,
  findMirror,
  findOpenTicket,
  findTicketsByUser,
  getTicket,
  getUserState,
  listAdminIds,
  listTicketMessages,
  listTickets,
  removeAdmin,
  saveMirror,
  setTicketStatus,
  setUserState,
  stats,
  upsertUser,
  type TicketRecord,
  type TicketStatus,
} from "./db.js";
import { errorInfo, logger } from "./logger.js";
import { buildClientOptions, syncChatCommands } from "./telegram.js";
import {
  ADMIN_MENU_LABEL,
  adminKeyboard,
  adminsKeyboard,
  isMainMenuLabel,
  mainKeyboard,
  ticketKeyboard,
  ticketsKeyboard,
} from "./ui/keyboards.js";
import {
  adminAddPromptText,
  adminAddedText,
  adminListText,
  adminPanelText,
  findEmptyText,
  findPromptText,
  helpText,
  statsText,
  ticketAppendedText,
  ticketCardText,
  ticketClosedText,
  ticketCreatedText,
  ticketForUserClosedText,
  ticketListText,
  ticketMirrorText,
  ticketPromptText,
  ticketReopenedText,
  welcomeText,
} from "./ui/texts.js";

/** Поля ответа Telegram, по которым узнаётся отправленное сообщение. */
interface SentMessage {
  chat?: { id?: number };
  message_id?: number;
}

export function createBot(): Bot {
  const bot = new Bot(config.botToken, { client: buildClientOptions() });

  const tracker = createMessageTracker();

  /** Удаляет экраны, отправленные на прошлом шаге. */
  const cleanupChat = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const ids = tracker.take(chatId);
    if (ids.length === 0) return;
    await Promise.allSettled(
      ids.map((messageId) => ctx.api.deleteMessage(chatId, messageId)),
    );
  };

  // Запоминаем всё, что бот отправляет, чтобы убрать это при следующем действии.
  bot.api.config.use(async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    if (response.ok) {
      // Не все методы возвращают сообщение: copyMessage отдаёт только его id,
      // sendMediaGroup — массив, остальные — true. Проверяем форму ответа.
      const sent = response.result as unknown as SentMessage | undefined;
      const chatId = sent?.chat?.id;
      if (typeof chatId === "number" && typeof sent?.message_id === "number") {
        tracker.remember(chatId, sent.message_id);
      }
    }
    return response;
  });

  /**
   * Перед каждым действием убираем экраны прошлого шага. Сообщения самого
   * пользователя не удаляем — в них описание проблемы; исключение только
   * нажатия кнопок меню.
   */
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    const isMenuAction =
      ctx.callbackQuery !== undefined ||
      (text !== undefined && (text.startsWith("/") || isMainMenuLabel(text)));

    if (isMenuAction) {
      await cleanupChat(ctx);
      const chatId = ctx.chat?.id;
      if (
        chatId !== undefined &&
        ctx.message !== undefined &&
        text !== undefined &&
        isMainMenuLabel(text)
      ) {
        tracker.remember(chatId, ctx.message.message_id);
      }
      // Кнопка меню выходит из режима ввода ID админа и поиска.
      const userId = ctx.from?.id;
      if (userId !== undefined) clearUserState(userId);
    }
    await next();
  });

  const track = (ctx: Context): void => {
    if (!ctx.from) return;
    upsertUser({
      telegramId: ctx.from.id,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
    });
  };

  /** id отправителя; апдейты без `from` (каналы) для этого бота не ожидаются. */
  const fromId = (ctx: Context): number => {
    const from = ctx.from;
    if (!from) throw new Error("Апдейт без отправителя");
    return from.id;
  };

  /** Пропускает дальше только админов; остальным отвечает отказом. */
  const requireAdmin = async (ctx: Context): Promise<boolean> => {
    if (isAdmin(fromId(ctx))) return true;
    if (ctx.callbackQuery) {
      await ctx
        .answerCallbackQuery({ text: "Нет доступа", show_alert: true })
        .catch(() => undefined);
    } else {
      await ctx
        .reply("Команда доступна только администраторам.")
        .catch(() => undefined);
    }
    return false;
  };

  const replyHtml = async (
    ctx: Context,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> => {
    await ctx.reply(text, {
      parse_mode: "HTML",
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  };

  /**
   * Отправляет экран с главной клавиатурой. Такое сообщение нельзя удалять:
   * вместе с ним Telegram убирает и reply-клавиатуру. Поэтому старый экран
   * меню удаляем сами, а новый помечаем якорем и исключаем из общей чистки.
   */
  const sendMenu = async (
    ctx: Context,
    send: () => Promise<{ message_id: number }>,
  ): Promise<void> => {
    const chatId = ctx.chat?.id;
    const previous = chatId === undefined ? undefined : tracker.anchor(chatId);
    const sent = await send();
    if (chatId === undefined) return;
    tracker.setAnchor(chatId, sent.message_id);
    if (previous !== undefined && previous !== sent.message_id) {
      await ctx.api.deleteMessage(chatId, previous).catch(() => undefined);
    }
  };

  /** Приветствие с картинкой; если файла нет — обычный текст. */
  const sendWelcome = async (ctx: Context, name: string | null): Promise<void> => {
    const caption = welcomeText(name);
    const keyboard = mainKeyboard(ctx.from ? isAdmin(ctx.from.id) : false);
    if (existsSync(config.bannerPath)) {
      try {
        await sendMenu(ctx, () =>
          ctx.replyWithPhoto(new InputFile(config.bannerPath), {
            caption,
            parse_mode: "HTML",
            reply_markup: keyboard,
          }),
        );
        return;
      } catch (error) {
        logger.warn(
          { err: errorInfo(error) },
          "не удалось отправить картинку, отправляю текст",
        );
      }
    } else {
      logger.warn({ path: config.bannerPath }, "файл картинки не найден");
    }
    await sendMenu(ctx, () => ctx.reply(caption, { parse_mode: "HTML", reply_markup: keyboard }));
  };

  // --- Пользовательская часть ---

  bot.command("start", async (ctx) => {
    track(ctx);
    await sendWelcome(ctx, ctx.from?.first_name ?? null);
  });

  bot.command("help", (ctx) => replyHtml(ctx, helpText()));

  bot.command("tickets", async (ctx) => {
    track(ctx);
    await sendMyTickets(ctx);
  });

  bot.hears("🎫 Написать в поддержку", async (ctx) => {
    track(ctx);
    await replyHtml(ctx, ticketPromptText());
  });

  bot.hears("📋 Мои тикеты", async (ctx) => {
    track(ctx);
    await sendMyTickets(ctx);
  });

  bot.hears("❓ Помощь", (ctx) => replyHtml(ctx, helpText()));

  // --- Админка ---

  bot.hears(ADMIN_MENU_LABEL, async (ctx) => {
    track(ctx);
    if (!(await requireAdmin(ctx))) return;
    await replyHtml(ctx, adminPanelText(), adminKeyboard());
  });

  bot.command("admin", async (ctx) => {
    track(ctx);
    if (!(await requireAdmin(ctx))) return;
    await replyHtml(ctx, adminPanelText(), adminKeyboard());
  });

  bot.callbackQuery("adm:panel", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await replyHtml(ctx, adminPanelText(), adminKeyboard());
  });

  bot.callbackQuery("adm:stats", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await replyHtml(ctx, statsText(stats()), adminKeyboard());
  });

  bot.callbackQuery("adm:list", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await replyHtml(
      ctx,
      adminListText(config.adminIds, listAdminIds()),
      adminsKeyboard(listAdminIds()),
    );
  });

  bot.callbackQuery("adm:add", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    setUserState(fromId(ctx), "admin_add");
    await ctx.answerCallbackQuery();
    await replyHtml(ctx, adminAddPromptText());
  });

  bot.callbackQuery(/^adm:del:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const actor = fromId(ctx);
    const target = Number(ctx.match[1]);
    if (isEnvAdmin(target)) {
      await ctx.answerCallbackQuery({
        text: "Этот админ задан в ADMIN_IDS — снять нельзя",
        show_alert: true,
      });
      return;
    }
    removeAdmin(target);
    await syncChatCommands(ctx.api, target, false);
    await ctx.answerCallbackQuery({ text: `Права сняты: ${target}` });
    await replyHtml(
      ctx,
      adminListText(config.adminIds, listAdminIds()),
      adminsKeyboard(listAdminIds()),
    );
  });

  // --- Тикеты в админке ---

  bot.callbackQuery("t:list", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await sendOpenTickets(ctx);
  });

  bot.callbackQuery("t:find", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    setUserState(fromId(ctx), "find_ticket");
    await ctx.answerCallbackQuery();
    await replyHtml(ctx, findPromptText());
  });

  bot.callbackQuery(/^t:show:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await showTicketCard(ctx, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^t:close:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery({ text: `Тикет #${ctx.match[1]} закрыт` });
    await setTicketStatusAndNotify(ctx, Number(ctx.match[1]), "closed");
  });

  bot.callbackQuery(/^t:open:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery({ text: `Тикет #${ctx.match[1]} открыт` });
    await setTicketStatusAndNotify(ctx, Number(ctx.match[1]), "open");
  });

  bot.command("find", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const query = ctx.match.trim();
    if (!query) {
      await replyHtml(ctx, findPromptText());
      return;
    }
    await sendFoundTickets(ctx, query);
  });

  bot.command("close", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await toggleTicketByQuery(ctx, ctx.match.trim(), "closed");
  });

  bot.command("open", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await toggleTicketByQuery(ctx, ctx.match.trim(), "open");
  });

  /**
   * Ответ админа на сообщение тикета. Проверяется раньше кнопок меню: админ
   * может ответить текстом, который совпадает с подписью кнопки.
   */
  bot.filter(
    (ctx) => Boolean(ctx.message?.reply_to_message) && isAdmin(ctx.from?.id ?? 0),
    async (ctx) => {
      const message = ctx.message;
      const from = ctx.from;
      if (!message || !from || !message.reply_to_message) return;
      const ticketId = findMirror(from.id, message.reply_to_message.message_id);
      if (ticketId === undefined) return;
      const ticket = getTicket(ticketId);
      if (!ticket) return;

      addTicketMessage({
        ticketId,
        direction: "out",
        authorId: from.id,
        text: message.text ?? null,
      });
      try {
        await ctx.api.copyMessage(ticket.userId, from.id, message.message_id);
        await replyHtml(ctx, `✅ Ответ отправлен в тикет <b>#${ticketId}</b>.`);
      } catch (error) {
        logger.warn(
          { err: errorInfo(error), ticketId },
          "не удалось отправить ответ пользователю",
        );
        await replyHtml(
          ctx,
          "⚠️ Не удалось отправить ответ: возможно, пользователь заблокировал бота.",
        );
      }
    },
  );

  /**
   * Сообщения, которые не являются командами или кнопками меню: обращения
   * пользователей, ввод ID нового админа и поиск тикета.
   */
  bot.on("message", async (ctx) => {
    const message = ctx.message;
    const from = ctx.from;
    if (!message || !from) return;

    const state = getUserState(from.id);

    if (state === "admin_add") {
      clearUserState(from.id);
      if (!isAdmin(from.id)) return;
      const target = Number((message.text ?? "").trim());
      if (!Number.isInteger(target) || target <= 0) {
        await replyHtml(
          ctx,
          "Нужен числовой Telegram ID. Попробуйте снова через «🛠 Админка».",
        );
        return;
      }
      addAdmin(target, from.id);
      await syncChatCommands(ctx.api, target, true);
      await replyHtml(ctx, adminAddedText(target), adminKeyboard());
      try {
        const notice = await ctx.api.sendMessage(
          target,
          "🛠 Вам выдали доступ к админ-панели поддержки. Отправьте /start — в меню появится кнопка «🛠 Админка».",
        );
        tracker.forget(target, notice.message_id);
      } catch (error) {
        logger.warn(
          { err: errorInfo(error), target },
          "не удалось уведомить нового админа",
        );
      }
      return;
    }

    if (state === "find_ticket") {
      clearUserState(from.id);
      if (!isAdmin(from.id)) return;
      await sendFoundTickets(ctx, (message.text ?? "").trim());
      return;
    }

    await handleUserMessage(ctx);
  });

  bot.catch((error) => {
    logger.error(
      { updateId: error.ctx.update.update_id, err: errorInfo(error.error) },
      "ошибка обработки апдейта",
    );
    if (error.error instanceof GrammyError) {
      logger.error({ description: error.error.description }, "Telegram API");
    } else if (error.error instanceof HttpError) {
      logger.error({ cause: errorInfo(error.error.error) }, "сеть Telegram");
    }
  });

  // --- Вспомогательные функции ---

  async function sendMyTickets(ctx: Context): Promise<void> {
    const tickets = findTicketsByUser(String(fromId(ctx)));
    await replyHtml(ctx, ticketListText(tickets));
  }

  async function sendOpenTickets(ctx: Context): Promise<void> {
    const tickets = listTickets("open");
    await replyHtml(
      ctx,
      ticketListText(tickets, "🎫 <b>Открытые тикеты</b>"),
      ticketsKeyboard(tickets),
    );
  }

  async function sendFoundTickets(ctx: Context, query: string): Promise<void> {
    if (!query) {
      await replyHtml(ctx, findPromptText());
      return;
    }
    const tickets = findTicketsByUser(query);
    if (tickets.length === 0) {
      await replyHtml(ctx, findEmptyText(query));
      return;
    }
    await replyHtml(
      ctx,
      ticketListText(tickets, `🔎 <b>Найдено по «${query}»</b>`),
      ticketsKeyboard(tickets, "adm:panel"),
    );
  }

  async function showTicketCard(ctx: Context, ticketId: number): Promise<void> {
    const ticket = getTicket(ticketId);
    if (!ticket) {
      await replyHtml(ctx, "Тикет не найден.");
      return;
    }
    const messages = listTicketMessages(ticketId, config.ticketTail);
    const total = countTicketMessages(ticketId);
    await replyHtml(
      ctx,
      ticketCardText(ticket, messages, total),
      ticketKeyboard(ticket),
    );
  }

  async function setTicketStatusAndNotify(
    ctx: Context,
    ticketId: number,
    status: TicketStatus,
  ): Promise<void> {
    const ticket = getTicket(ticketId);
    if (!ticket) {
      await replyHtml(ctx, "Тикет не найден.");
      return;
    }
    setTicketStatus(ticketId, status);
    if (status === "closed") {
      try {
        await ctx.api.sendMessage(ticket.userId, ticketForUserClosedText(ticketId), {
          parse_mode: "HTML",
        });
      } catch (error) {
        logger.warn(
          { err: errorInfo(error), ticketId },
          "не удалось уведомить пользователя о закрытии тикета",
        );
      }
    }
    await showTicketCard(ctx, ticketId);
  }

  /** Закрывает открытый или открывает последний закрытый тикет пользователя. */
  async function toggleTicketByQuery(
    ctx: Context,
    query: string,
    status: TicketStatus,
  ): Promise<void> {
    if (!query) {
      await replyHtml(ctx, "Укажите @username или Telegram ID.");
      return;
    }
    const tickets = findTicketsByUser(query);
    const target =
      status === "closed"
        ? tickets.find((ticket) => ticket.status === "open")
        : tickets.find((ticket) => ticket.status === "closed");
    if (!target) {
      await replyHtml(ctx, findEmptyText(query));
      return;
    }
    await replyHtml(
      ctx,
      status === "closed" ? ticketClosedText(target.id) : ticketReopenedText(target.id),
    );
    await setTicketStatusAndNotify(ctx, target.id, status);
  }

  /** Обращение пользователя: создаёт тикет или добавляет сообщение в текущий. */
  async function handleUserMessage(ctx: Context): Promise<void> {
    const from = ctx.from;
    const message = ctx.message;
    const chat = ctx.chat;
    if (!from || !message || !chat) return;

    upsertUser({
      telegramId: from.id,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
    });

    let ticket = findOpenTicket(from.id);
    const isNew = ticket === undefined;
    if (ticket === undefined) {
      ticket = createTicket({
        userId: from.id,
        username: from.username ?? null,
        firstName: from.first_name ?? null,
      });
    }

    addTicketMessage({
      ticketId: ticket.id,
      direction: "in",
      authorId: from.id,
      text: message.text ?? null,
    });

    await mirrorToAdmins(ctx, ticket, message.message_id);
    await replyHtml(
      ctx,
      isNew ? ticketCreatedText(ticket.id) : ticketAppendedText(ticket.id),
    );
  }

  /** Пересылает сообщение тикета всем админам и запоминает связь. */
  async function mirrorToAdmins(
    ctx: Context,
    ticket: TicketRecord,
    messageId: number,
  ): Promise<void> {
    const chat = ctx.chat;
    if (!chat) return;

    const admins = allAdminIds();
    if (admins.length === 0) {
      logger.warn({ ticketId: ticket.id }, "нет админов — тикет никому не передан");
      return;
    }

    for (const adminId of admins) {
      try {
        const header = await ctx.api.sendMessage(adminId, ticketMirrorText(ticket), {
          parse_mode: "HTML",
        });
        // Тикет должен остаться в чате админа: исключаем его из чистки.
        tracker.forget(adminId, header.message_id);
        saveMirror(adminId, header.message_id, ticket.id);

        const copied = await ctx.api.copyMessage(adminId, chat.id, messageId);
        saveMirror(adminId, copied.message_id, ticket.id);
      } catch (error) {
        logger.warn(
          { err: errorInfo(error), adminId, ticketId: ticket.id },
          "не удалось передать тикет админу",
        );
      }
    }
  }

  return bot;
}

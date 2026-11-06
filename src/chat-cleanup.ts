/**
 * Учёт сообщений для «чистки» чата.
 *
 * Бот запоминает экраны, которые сам отправил, и удаляет их перед следующим
 * действием. Сообщения пользователя в боте поддержки не удаляются: в них
 * описание проблемы, они нужны в переписке.
 *
 * Telegram Bot API разрешает боту удалять свои сообщения и входящие сообщения
 * в личных чатах, но только не старше 48 часов. Поэтому вызывающая сторона
 * игнорирует неудачные попытки удаления.
 */
export interface MessageTracker {
  /** Запоминает сообщение, чтобы удалить его при следующем действии. */
  remember(chatId: number, messageId: number): void;
  /** Убирает сообщение из списка: оно должно остаться в чате. */
  forget(chatId: number, messageId: number): void;
  /** Отдаёт запомненные сообщения и очищает список для этого чата. */
  take(chatId: number): number[];
  /** Текущее сообщение-якорь с reply-клавиатурой, если оно есть. */
  anchor(chatId: number): number | undefined;
  /**
   * Назначает сообщение якорем. Якорь держит reply-клавиатуру: удалять его
   * нельзя, иначе Telegram убирает саму клавиатуру. В список на удаление
   * якорь не попадает.
   */
  setAnchor(chatId: number, messageId: number): void;
}

export const createMessageTracker = (): MessageTracker => {
  const byChat = new Map<number, number[]>();
  const anchors = new Map<number, number>();

  return {
    remember(chatId, messageId) {
      if (anchors.get(chatId) === messageId) return;
      const ids = byChat.get(chatId);
      if (ids === undefined) {
        byChat.set(chatId, [messageId]);
        return;
      }
      if (!ids.includes(messageId)) ids.push(messageId);
    },

    forget(chatId, messageId) {
      const ids = byChat.get(chatId);
      if (ids === undefined) return;
      const index = ids.indexOf(messageId);
      if (index !== -1) ids.splice(index, 1);
    },

    anchor(chatId) {
      return anchors.get(chatId);
    },

    setAnchor(chatId, messageId) {
      anchors.set(chatId, messageId);
      const ids = byChat.get(chatId);
      if (ids === undefined) return;
      const index = ids.indexOf(messageId);
      if (index !== -1) ids.splice(index, 1);
    },

    take(chatId) {
      const ids = byChat.get(chatId);
      if (ids === undefined) return [];
      byChat.delete(chatId);
      const anchor = anchors.get(chatId);
      return anchor === undefined ? ids : ids.filter((id) => id !== anchor);
    },
  };
};

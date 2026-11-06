export const DEFAULT_CHAT_GROUP_WINDOW_MS = 5 * 60 * 1000;

export type ChatTimelineMessage = {
  id: string;
  senderId: string;
  timestamp: string;
};

export type ChatGroupBoundary = {
  continuesNextPage: boolean;
  continuesPreviousPage: boolean;
  endsGroup: boolean;
  startsGroup: boolean;
};

export type ChatMessagePosition = "first" | "last" | "middle" | "only";

export type ChatMessageRow<M extends ChatTimelineMessage> = {
  boundary: ChatGroupBoundary;
  groupId: string;
  key: string;
  kind: "message";
  message: M;
  position: ChatMessagePosition;
};

export type ChatGroupRow<M extends ChatTimelineMessage> = {
  continuesNextPage: boolean;
  continuesPreviousPage: boolean;
  firstMessage: M;
  key: string;
  kind: "group";
  messageIds: readonly string[];
  senderId: string;
};

export type ChatDayDividerRow = {
  dayKey: string;
  key: string;
  kind: "day-divider";
  timestamp: string;
};

export type ChatFirstUnreadRow = {
  key: string;
  kind: "first-unread";
  messageId: string;
};

export type ChatTimelineRow<M extends ChatTimelineMessage> =
  | ChatDayDividerRow
  | ChatFirstUnreadRow
  | ChatGroupRow<M>
  | ChatMessageRow<M>;

export type ChatGroupingOptions<M extends ChatTimelineMessage> = {
  getDayKey?: (message: M) => string;
  groupWindowMs?: number;
  nextPageBoundaryMessage?: M | null;
  previousPageBoundaryMessage?: M | null;
};

export type BuildChatTimelineRowsOptions<M extends ChatTimelineMessage> =
  ChatGroupingOptions<M> & {
    firstUnreadMessageId?: string | null;
  };

const invalidDayKey = (message: ChatTimelineMessage): string =>
  `invalid:${message.id}`;

export function localChatDayKey(message: ChatTimelineMessage): string {
  const date = new Date(message.timestamp);
  if (Number.isNaN(date.getTime())) {
    return invalidDayKey(message);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timestampMs(message: ChatTimelineMessage): number | null {
  const value = Date.parse(message.timestamp);
  return Number.isFinite(value) ? value : null;
}

export function areMessagesInSameChatGroup<M extends ChatTimelineMessage>(
  previous: M | null | undefined,
  current: M | null | undefined,
  options: Pick<ChatGroupingOptions<M>, "getDayKey" | "groupWindowMs"> = {}
): boolean {
  if (!previous || !current || previous.senderId !== current.senderId) {
    return false;
  }

  const getDayKey = options.getDayKey ?? localChatDayKey;
  if (getDayKey(previous) !== getDayKey(current)) {
    return false;
  }

  const previousMs = timestampMs(previous);
  const currentMs = timestampMs(current);
  if (previousMs === null || currentMs === null || currentMs < previousMs) {
    return false;
  }

  return (
    currentMs - previousMs <=
    (options.groupWindowMs ?? DEFAULT_CHAT_GROUP_WINDOW_MS)
  );
}

export function chatGroupBoundaryAt<M extends ChatTimelineMessage>(
  messages: readonly M[],
  index: number,
  options: ChatGroupingOptions<M> = {}
): ChatGroupBoundary {
  const message = messages[index];
  if (!message) {
    throw new RangeError(`No chat message exists at index ${index}`);
  }

  const previous =
    index > 0 ? messages[index - 1] : options.previousPageBoundaryMessage;
  const next =
    index < messages.length - 1
      ? messages[index + 1]
      : options.nextPageBoundaryMessage;
  const continuesPreviousPage =
    index === 0 && areMessagesInSameChatGroup(previous, message, options);
  const continuesNextPage =
    index === messages.length - 1 &&
    areMessagesInSameChatGroup(message, next, options);

  return {
    continuesNextPage,
    continuesPreviousPage,
    endsGroup: !areMessagesInSameChatGroup(message, next, options),
    startsGroup: !areMessagesInSameChatGroup(previous, message, options)
  };
}

function messagePosition(boundary: ChatGroupBoundary): ChatMessagePosition {
  if (boundary.startsGroup && boundary.endsGroup) return "only";
  if (boundary.startsGroup) return "first";
  if (boundary.endsGroup) return "last";
  return "middle";
}

function uniqueMessages<M extends ChatTimelineMessage>(
  messages: readonly M[]
): M[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

export function buildChatTimelineRows<M extends ChatTimelineMessage>(
  inputMessages: readonly M[],
  options: BuildChatTimelineRowsOptions<M> = {}
): ChatTimelineRow<M>[] {
  const messages = uniqueMessages(inputMessages);
  const getDayKey = options.getDayKey ?? localChatDayKey;
  const rows: ChatTimelineRow<M>[] = [];
  let currentGroup: ChatGroupRow<M> | null = null;
  let previousDayKey: string | null = null;
  const dayKeyOccurrences = new Map<string, number>();

  messages.forEach((message, index) => {
    const dayKey = getDayKey(message);
    const boundary = chatGroupBoundaryAt(messages, index, options);

    if (dayKey !== previousDayKey) {
      const occurrence = (dayKeyOccurrences.get(dayKey) ?? 0) + 1;
      dayKeyOccurrences.set(dayKey, occurrence);
      rows.push({
        dayKey,
        key: `day:${dayKey}${occurrence === 1 ? "" : `:${occurrence}`}`,
        kind: "day-divider",
        timestamp: message.timestamp
      });
      previousDayKey = dayKey;
    }

    if (boundary.startsGroup || currentGroup === null) {
      currentGroup = {
        continuesNextPage: false,
        continuesPreviousPage: boundary.continuesPreviousPage,
        firstMessage: message,
        key: `group:${message.id}`,
        kind: "group",
        messageIds: [],
        senderId: message.senderId
      };
      rows.push(currentGroup);
    }

    const messageIds = [...currentGroup.messageIds, message.id];
    currentGroup.messageIds = messageIds;
    currentGroup.continuesNextPage = boundary.continuesNextPage;

    if (message.id === options.firstUnreadMessageId) {
      rows.push({
        key: `first-unread:${message.id}`,
        kind: "first-unread",
        messageId: message.id
      });
    }

    rows.push({
      boundary,
      groupId: currentGroup.key,
      key: `message:${message.id}`,
      kind: "message",
      message,
      position: messagePosition(boundary)
    });

    if (boundary.endsGroup) {
      currentGroup = null;
    }
  });

  return rows;
}

export function firstUnreadRowIndex<M extends ChatTimelineMessage>(
  rows: readonly ChatTimelineRow<M>[]
): number {
  return rows.findIndex((row) => row.kind === "first-unread");
}

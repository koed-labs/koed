import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHAT_GROUP_WINDOW_MS,
  areMessagesInSameChatGroup,
  buildChatTimelineRows,
  chatGroupBoundaryAt,
  firstUnreadRowIndex,
  type ChatTimelineMessage
} from "./chatTimelineRows.js";

type Message = ChatTimelineMessage & { body: string };

const message = (
  id: string,
  senderId: string,
  minute: number,
  day = "2026-01-01"
): Message => ({
  body: id,
  id,
  senderId,
  timestamp: `${day}T00:${String(minute).padStart(2, "0")}:00.000Z`
});

const utcDay = (item: Message) => item.timestamp.slice(0, 10);

describe("chat timeline row helpers", () => {
  it("builds deterministic day, group, unread, and message rows", () => {
    const rows = buildChatTimelineRows(
      [
        message("m1", "alice", 0),
        message("m2", "alice", 4),
        message("m3", "bob", 5),
        message("m4", "bob", 0, "2026-01-02")
      ],
      { firstUnreadMessageId: "m2", getDayKey: utcDay }
    );

    expect(rows.map((row) => `${row.kind}:${row.key}`)).toEqual([
      "day-divider:day:2026-01-01",
      "group:group:m1",
      "message:message:m1",
      "first-unread:first-unread:m2",
      "message:message:m2",
      "group:group:m3",
      "message:message:m3",
      "day-divider:day:2026-01-02",
      "group:group:m4",
      "message:message:m4"
    ]);
    expect(firstUnreadRowIndex(rows)).toBe(3);

    const aliceGroup = rows.find(
      (row) => row.kind === "group" && row.senderId === "alice"
    );
    expect(aliceGroup).toMatchObject({
      continuesNextPage: false,
      continuesPreviousPage: false,
      messageIds: ["m1", "m2"]
    });

    const positions = rows.flatMap((row) =>
      row.kind === "message" ? [row.position] : []
    );
    expect(positions).toEqual(["first", "last", "only", "only"]);
  });

  it("keeps real-message keys stable when older rows are prepended", () => {
    const original = buildChatTimelineRows(
      [message("m2", "alice", 2), message("m3", "bob", 3)],
      { getDayKey: utcDay }
    );
    const prepended = buildChatTimelineRows(
      [
        message("m1", "alice", 0),
        message("m2", "alice", 2),
        message("m3", "bob", 3)
      ],
      { getDayKey: utcDay }
    );

    const originalMessageKeys = original.flatMap((row) =>
      row.kind === "message" ? [row.key] : []
    );
    const prependedMessageKeys = new Set(
      prepended.flatMap((row) => (row.kind === "message" ? [row.key] : []))
    );
    expect(
      originalMessageKeys.every((key) => prependedMessageKeys.has(key))
    ).toBe(true);
  });

  it("describes loaded-page group continuations without inventing messages", () => {
    const loaded = [message("m2", "alice", 2), message("m3", "alice", 4)];
    const options = {
      getDayKey: utcDay,
      nextPageBoundaryMessage: message("m4", "alice", 6),
      previousPageBoundaryMessage: message("m1", "alice", 0)
    };

    expect(chatGroupBoundaryAt(loaded, 0, options)).toEqual({
      continuesNextPage: false,
      continuesPreviousPage: true,
      endsGroup: false,
      startsGroup: false
    });
    expect(chatGroupBoundaryAt(loaded, 1, options)).toEqual({
      continuesNextPage: true,
      continuesPreviousPage: false,
      endsGroup: false,
      startsGroup: false
    });

    const group = buildChatTimelineRows(loaded, options).find(
      (row) => row.kind === "group"
    );
    expect(group).toMatchObject({
      continuesNextPage: true,
      continuesPreviousPage: true,
      key: "group:m2",
      messageIds: ["m2", "m3"]
    });
  });

  it("groups only same-sender, same-day, ordered messages inside the window", () => {
    const first = message("m1", "alice", 0);
    const exactBoundary: Message = {
      ...message("m2", "alice", 0),
      timestamp: new Date(
        Date.parse(first.timestamp) + DEFAULT_CHAT_GROUP_WINDOW_MS
      ).toISOString()
    };

    expect(
      areMessagesInSameChatGroup(first, exactBoundary, {
        getDayKey: utcDay
      })
    ).toBe(true);
    expect(
      areMessagesInSameChatGroup(first, message("m2", "bob", 1), {
        getDayKey: utcDay
      })
    ).toBe(false);
    expect(
      areMessagesInSameChatGroup(first, message("m2", "alice", 6), {
        getDayKey: utcDay
      })
    ).toBe(false);
    expect(
      areMessagesInSameChatGroup(
        message("later", "alice", 5),
        message("earlier", "alice", 4),
        { getDayKey: utcDay }
      )
    ).toBe(false);
    expect(
      areMessagesInSameChatGroup(
        { ...first, timestamp: "not-a-date" },
        exactBoundary,
        { getDayKey: utcDay }
      )
    ).toBe(false);
  });

  it("deduplicates repeated message ids to preserve LegendList key uniqueness", () => {
    const duplicate = message("m1", "alice", 1);
    const rows = buildChatTimelineRows([message("m1", "alice", 0), duplicate], {
      getDayKey: utcDay
    });

    expect(rows.filter((row) => row.kind === "message")).toHaveLength(1);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("rejects out-of-range boundary requests", () => {
    expect(() => chatGroupBoundaryAt([message("m1", "alice", 0)], 1)).toThrow(
      RangeError
    );
  });
});

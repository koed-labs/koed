import { describe, expect, it } from "vitest";

import {
  buildMultiAgentPublicContext,
  multiAgentContextCursorAfterDelivery,
  type MultiAgentContextSourceMessage
} from "./multi-agent-context.js";

const row = (
  input: Partial<MultiAgentContextSourceMessage> &
    Pick<
      MultiAgentContextSourceMessage,
      "id" | "sequence" | "exchangeId" | "text"
    >
): MultiAgentContextSourceMessage => ({
  kind: "user",
  visibility: "public",
  state: "completed",
  ...input
});

describe("multi-Agent public conversation context", () => {
  it("bootstraps a fresh native session with its own prior public replies", () => {
    const context = buildMultiAgentPublicContext({
      recipientAgentId: "agent-a",
      recipientHasNativeHistory: false,
      afterSequence: 0,
      maxExchanges: 5,
      maxUtf8Bytes: 4096,
      messages: [
        row({
          id: "previous-own",
          sequence: 1,
          exchangeId: "previous",
          kind: "agent_reply",
          authorAgentId: "agent-a",
          text: "Earlier public result before changing models."
        })
      ]
    });
    expect(context.messages.map((message) => message.id)).toEqual([
      "previous-own"
    ]);
  });
  it("keeps the newest public result when an older message exceeds the budget", () => {
    const context = buildMultiAgentPublicContext({
      recipientAgentId: "agent-b",
      afterSequence: 0,
      maxExchanges: 5,
      maxUtf8Bytes: 500,
      messages: [
        row({
          id: "old",
          sequence: 1,
          exchangeId: "old",
          text: "Older context ".repeat(1000)
        }),
        row({
          id: "latest",
          sequence: 2,
          exchangeId: "latest",
          kind: "agent_reply",
          authorAgentId: "agent-a",
          text: "Latest verified result."
        })
      ]
    });
    expect(context.contextText).toContain("Latest verified result.");
    expect(context.counts.contextUtf8Bytes).toBeLessThanOrEqual(500);
    expect(context.counts.omittedUtf8Bytes).toBeGreaterThan(0);
  });
  it("transfers visible reply text without private Memory attribution metadata", () => {
    const context = buildMultiAgentPublicContext({
      recipientAgentId: "agent-b",
      afterSequence: 0,
      maxExchanges: 5,
      maxUtf8Bytes: 4096,
      messages: [
        row({
          id: "reply",
          sequence: 1,
          exchangeId: "turn",
          kind: "agent_reply",
          authorAgentId: "agent-a",
          text: "Public result.\n<!-- koed-memory-attribution:v1:private-node-reference -->"
        })
      ]
    });
    expect(context.messages[0]?.text).toBe("Public result.");
    expect(context.contextText).not.toContain("private-node-reference");
    expect(context.contextText).not.toContain("koed-memory-attribution");
  });
  it("an unnamed respondent skips only its own native generic replies", () => {
    const messages = [
      row({
        id: "own",
        sequence: 1,
        exchangeId: "turn-1",
        kind: "agent_reply",
        authorAgentId: null,
        provider: "codex",
        aiClientInstanceId: "codex.default",
        text: "Already in this native session."
      }),
      row({
        id: "other-instance",
        sequence: 2,
        exchangeId: "turn-2",
        kind: "agent_reply",
        authorAgentId: null,
        provider: "codex",
        aiClientInstanceId: "codex.other",
        text: "Different instance reply."
      }),
      row({
        id: "other-provider",
        sequence: 3,
        exchangeId: "turn-3",
        kind: "agent_reply",
        authorAgentId: null,
        provider: "claude",
        aiClientInstanceId: "claude.default",
        text: "Different provider reply."
      }),
      row({
        id: "named",
        sequence: 4,
        exchangeId: "turn-4",
        kind: "agent_reply",
        authorAgentId: "agent-a",
        provider: "codex",
        aiClientInstanceId: "codex.default",
        text: "Named Agent using same provider."
      }),
      row({
        id: "unknown-origin",
        sequence: 5,
        exchangeId: "turn-5",
        kind: "agent_reply",
        authorAgentId: null,
        text: "Public legacy reply without verified native identity."
      })
    ];
    const context = buildMultiAgentPublicContext({
      recipientAgentId: null,
      recipientProvider: "codex",
      recipientAiClientInstanceId: "codex.default",
      afterSequence: 0,
      maxExchanges: 10,
      maxUtf8Bytes: 4096,
      messages
    });
    expect(context.messages.map((message) => message.id)).toEqual([
      "other-instance",
      "other-provider",
      "named",
      "unknown-origin"
    ]);
    expect(context.contextText).not.toContain(
      "Already in this native session."
    );
    expect(() =>
      buildMultiAgentPublicContext({
        recipientAgentId: null,
        afterSequence: 0,
        maxExchanges: 10,
        maxUtf8Bytes: 4096,
        messages
      })
    ).toThrow("AI Client identity");
  });
  it("includes only public users and completed replies from other Agents", () => {
    const context = buildMultiAgentPublicContext({
      recipientAgentId: "agent-b",
      afterSequence: 0,
      maxExchanges: 10,
      maxUtf8Bytes: 4_096,
      currentMessageId: "current-user",
      messages: [
        row({
          id: "current-user",
          sequence: 1,
          exchangeId: "turn-1",
          text: "Do this"
        }),
        row({
          id: "user-0",
          sequence: 0,
          exchangeId: "turn-0",
          text: "Old prompt"
        }),
        row({
          id: "reply-a",
          sequence: 2,
          exchangeId: "turn-1",
          kind: "agent_reply",
          authorAgentId: "agent-a",
          text: "I changed the parser."
        }),
        row({
          id: "generic-reply",
          sequence: 3,
          exchangeId: "turn-1",
          kind: "agent_reply",
          authorAgentId: null,
          text: "A generic assistant answered before this Agent was selected."
        }),
        row({
          id: "reply-b",
          sequence: 4,
          exchangeId: "turn-1",
          kind: "agent_reply",
          authorAgentId: "agent-b",
          text: "Recipient's native history already has this."
        }),
        row({
          id: "reasoning-a",
          sequence: 5,
          exchangeId: "turn-1",
          kind: "private_reasoning",
          text: "hidden thoughts"
        }),
        row({
          id: "tool-a",
          sequence: 6,
          exchangeId: "turn-1",
          kind: "tool_event",
          text: "raw tool arguments"
        }),
        row({
          id: "incomplete-reply",
          sequence: 7,
          exchangeId: "turn-1",
          kind: "agent_reply",
          authorAgentId: "agent-a",
          state: "indeterminate",
          text: "partial output"
        }),
        row({
          id: "private-user",
          sequence: 8,
          exchangeId: "turn-1",
          visibility: "private",
          text: "private note"
        })
      ]
    });

    expect(context.messages.map((message) => message.id)).toEqual([
      "reply-a",
      "generic-reply"
    ]);
    expect(context.messages[0]).toMatchObject({
      kind: "agent_reply",
      authorAgentId: "agent-a",
      text: "I changed the parser.",
      truncated: false
    });
    expect(context.contextText).toContain("I changed the parser.");
    expect(context.contextText).not.toContain("hidden thoughts");
    expect(context.contextText).not.toContain("raw tool arguments");
    expect(context.contextText).not.toContain("private note");
    expect(context.contextText).not.toContain("Recipient's native history");
    expect(context.contextText).not.toContain("Do this");
    expect(context.contextText).toContain('"attribution":"generic"');
    expect(context.contextText).toContain('"authorAgentId":null');
    expect(context.cursorThroughSequence).toBe(3);
    expect(context.currentMessageSequence).toBe(1);
  });

  it("keeps message order and exchange caps stable for shuffled input", () => {
    const messages = [
      row({ id: "u-1", sequence: 1, exchangeId: "turn-1", text: "First" }),
      row({
        id: "a-1",
        sequence: 2,
        exchangeId: "turn-1",
        kind: "agent_reply",
        authorAgentId: "agent-a",
        text: "First reply"
      }),
      row({ id: "u-2", sequence: 3, exchangeId: "turn-2", text: "Second" }),
      row({
        id: "a-2",
        sequence: 4,
        exchangeId: "turn-2",
        kind: "agent_reply",
        authorAgentId: "agent-a",
        text: "Second reply"
      })
    ];
    const build = (ordered: MultiAgentContextSourceMessage[]) =>
      buildMultiAgentPublicContext({
        recipientAgentId: "agent-b",
        afterSequence: 0,
        maxExchanges: 1,
        maxUtf8Bytes: 4_096,
        messages: ordered
      });

    const first = build(messages);
    const shuffled = build([
      messages[3]!,
      messages[1]!,
      messages[2]!,
      messages[0]!
    ]);

    expect(first.contextText).toBe(shuffled.contextText);
    expect(first.messages.map((message) => message.id)).toEqual(["u-2", "a-2"]);
    expect(first.counts).toMatchObject({
      candidateMessageCount: 4,
      candidateExchangeCount: 2,
      includedMessageCount: 2,
      includedExchangeCount: 1,
      omittedMessageCount: 2,
      omittedExchangeCount: 1,
      partiallyOmittedExchangeCount: 0
    });
    expect(first.cursorThroughSequence).toBe(4);
  });

  it("truncates on Unicode code-point boundaries and stays within the byte cap", () => {
    const source = "猫🙂é".repeat(200);
    const context = buildMultiAgentPublicContext({
      recipientAgentId: "agent-b",
      afterSequence: 0,
      maxExchanges: 5,
      maxUtf8Bytes: 600,
      messages: [
        row({
          id: "long-user",
          sequence: 2,
          exchangeId: "turn-1",
          text: source
        }),
        row({
          id: "later-user",
          sequence: 1,
          exchangeId: "turn-2",
          text: "later"
        })
      ]
    });

    expect(context.counts.contextUtf8Bytes).toBeLessThanOrEqual(600);
    expect(context.contextText).toContain("Context limit omitted");
    expect(context.messages[0]).toMatchObject({
      id: "long-user",
      truncated: true,
      originalUtf8Bytes: new TextEncoder().encode(source).byteLength
    });
    expect(context.messages[0]!.omittedUtf8Bytes).toBeGreaterThan(0);
    expect(context.messages[0]!.text).toMatch(
      /\[Context limit omitted \d+ UTF-8 bytes from this message\.\]$/
    );
    expect(context.counts.omittedMessageCount).toBe(1);

    const boundedText = context.messages[0]!.text;
    for (let index = 0; index < boundedText.length; index += 1) {
      const codeUnit = boundedText.charCodeAt(index);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const nextCodeUnit = boundedText.charCodeAt(index + 1);
        expect(nextCodeUnit).toBeGreaterThanOrEqual(0xdc00);
        expect(nextCodeUnit).toBeLessThanOrEqual(0xdfff);
        index += 1;
      } else {
        expect(codeUnit < 0xdc00 || codeUnit > 0xdfff).toBe(true);
      }
    }
  });

  it("records omissions as not provided and advances only after confirmed delivery", () => {
    const context = buildMultiAgentPublicContext({
      recipientAgentId: "agent-b",
      afterSequence: 0,
      maxExchanges: 10,
      maxUtf8Bytes: 340,
      currentMessageId: "current-user",
      messages: [
        row({
          id: "oversized-context",
          sequence: 1,
          exchangeId: "turn-0",
          text: "old context that will not fit when encoded"
        }),
        row({
          id: "current-user",
          sequence: 2,
          exchangeId: "turn-1",
          text: "Run it"
        })
      ]
    });

    expect(context.counts.includedMessageCount).toBe(0);
    expect(context.counts.omittedMessageCount).toBe(1);
    expect(context.omittedSequenceRange).toEqual({ from: 1, through: 1 });
    expect(context.counts.omissionsStatus).toBe("not_provided");
    const envelope = JSON.parse(context.contextText) as { omissions: unknown };
    expect(envelope.omissions).toMatchObject({
      status: "not_provided",
      messageCount: 1
    });
    expect(context.cursorThroughSequence).toBe(2);
    expect(
      multiAgentContextCursorAfterDelivery({
        cursorBeforeSequence: context.cursorBeforeSequence,
        cursorThroughSequence: context.cursorThroughSequence,
        delivery: "delivered"
      })
    ).toBe(2);
    for (const delivery of [
      "not_delivered",
      "indeterminate",
      "pending"
    ] as const) {
      expect(
        multiAgentContextCursorAfterDelivery({
          cursorBeforeSequence: context.cursorBeforeSequence,
          cursorThroughSequence: 2,
          delivery
        })
      ).toBe(0);
    }
  });

  it("does not resend included public context after a bounded window is acknowledged", () => {
    const initialMessages = [
      row({ id: "u-1", sequence: 1, exchangeId: "turn-1", text: "First" }),
      row({
        id: "a-1",
        sequence: 2,
        exchangeId: "turn-1",
        kind: "agent_reply",
        authorAgentId: "agent-a",
        text: "First result"
      }),
      row({ id: "u-2", sequence: 3, exchangeId: "turn-2", text: "Second" }),
      row({ id: "u-current", sequence: 4, exchangeId: "turn-2", text: "Third" })
    ];
    const initial = buildMultiAgentPublicContext({
      recipientAgentId: "agent-b",
      afterSequence: 0,
      currentMessageId: "u-current",
      maxExchanges: 1,
      maxUtf8Bytes: 4_096,
      messages: initialMessages
    });

    expect(initial.messages.map((message) => message.id)).toEqual(["u-2"]);
    expect(initial.omittedSequenceRange).toEqual({ from: 1, through: 2 });
    const acknowledgedCursor = multiAgentContextCursorAfterDelivery({
      cursorBeforeSequence: initial.cursorBeforeSequence,
      cursorThroughSequence: initial.cursorThroughSequence,
      delivery: "delivered"
    });
    expect(acknowledgedCursor).toBe(4);

    const next = buildMultiAgentPublicContext({
      recipientAgentId: "agent-b",
      afterSequence: acknowledgedCursor,
      currentMessageId: "u-next",
      maxExchanges: 10,
      maxUtf8Bytes: 4_096,
      messages: [
        ...initialMessages,
        row({
          id: "a-next",
          sequence: 5,
          exchangeId: "turn-2",
          kind: "agent_reply",
          authorAgentId: "agent-a",
          text: "New result"
        }),
        row({
          id: "u-next",
          sequence: 6,
          exchangeId: "turn-3",
          text: "Fourth"
        })
      ]
    });

    expect(next.messages.map((message) => message.id)).toEqual(["a-next"]);
    expect(next.contextText).toContain("New result");
    expect(next.contextText).not.toContain("First result");
    expect(next.contextText).not.toContain('"id":"a-1"');
  });

  it("advances an acknowledged cursor and reuses it for the next incremental context", () => {
    const messages = [
      row({ id: "u-1", sequence: 1, exchangeId: "turn-1", text: "Do first" }),
      row({
        id: "a-1",
        sequence: 2,
        exchangeId: "turn-1",
        kind: "agent_reply",
        authorAgentId: "agent-a",
        text: "First result"
      }),
      row({ id: "u-2", sequence: 3, exchangeId: "turn-2", text: "Do next" })
    ];
    const first = buildMultiAgentPublicContext({
      recipientAgentId: "agent-b",
      afterSequence: 0,
      currentMessageId: "u-1",
      maxExchanges: 10,
      maxUtf8Bytes: 4_096,
      messages: messages.slice(0, 2)
    });
    const savedCursor = multiAgentContextCursorAfterDelivery({
      cursorBeforeSequence: first.cursorBeforeSequence,
      cursorThroughSequence: first.cursorThroughSequence,
      delivery: "delivered"
    });
    const next = buildMultiAgentPublicContext({
      recipientAgentId: "agent-b",
      afterSequence: savedCursor,
      currentMessageId: "u-2",
      maxExchanges: 10,
      maxUtf8Bytes: 4_096,
      messages
    });

    expect(savedCursor).toBe(2);
    expect(first.messages.map((message) => message.id)).toEqual(["a-1"]);
    expect(next.messages).toEqual([]);
    expect(next.cursorThroughSequence).toBe(3);
  });

  it("rejects an invalid direct prompt identity and a too-small envelope budget", () => {
    const messages = [
      row({
        id: "private",
        sequence: 1,
        exchangeId: "turn-1",
        visibility: "private",
        text: "secret"
      })
    ];
    expect(() =>
      buildMultiAgentPublicContext({
        recipientAgentId: "agent-b",
        afterSequence: 0,
        currentMessageId: "private",
        maxExchanges: 1,
        maxUtf8Bytes: 4_096,
        messages
      })
    ).toThrow(/currentMessageId/);

    expect(() =>
      buildMultiAgentPublicContext({
        recipientAgentId: "agent-b",
        afterSequence: 0,
        maxExchanges: 1,
        maxUtf8Bytes: 1,
        messages: []
      })
    ).toThrow(/too small/);
  });
});

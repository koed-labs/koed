import { describe, expect, it } from "vitest";
import { parsePiSessionJournalBytes } from "../src/pi-session-parser.js";

const parse = (records: unknown[]) =>
  parsePiSessionJournalBytes({
    bytes: Buffer.from(
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
    ),
    absoluteStartOffset: 0,
    lineIndexOffset: 0,
    sessionId: "11111111-1111-4111-8111-111111111111",
    externalSessionId: "pi-session",
    sourceFingerprint: "f".repeat(64)
  });

describe("Pi session parser", () => {
  it("projects user, assistant, tool, result, and direct bash records", () => {
    const result = parse([
      {
        type: "session",
        version: 3,
        id: "pi-session",
        cwd: "/repo",
        timestamp: "2026-01-01T00:00:00Z"
      },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1767225601000
        }
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-opus-4-6",
          content: [
            { type: "text", text: "hi" },
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              arguments: { path: "x" }
            }
          ]
        }
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [{ type: "text", text: "done" }]
        }
      },
      {
        type: "message",
        id: "b1",
        parentId: "t1",
        message: {
          role: "bashExecution",
          command: "pwd",
          output: "/repo",
          exitCode: 0
        }
      }
    ]);
    expect(result.items.map((item) => item.sourceEventType)).toEqual([
      "unknown",
      "user_message",
      "agent_message",
      "tool_call",
      "tool_result",
      "bash_execution"
    ]);
    expect(result.items[1]?.rawText).toBe("hello");
    expect(result.items[2]?.metadata.modelIdentity).toBe(
      "anthropic/claude-opus-4-6"
    );
    expect(result.items[2]?.metadata.piParentEntryId).toBe("u1");
    expect(result.items.slice(1).every((item) => item.canonicalItemKey)).toBe(
      true
    );
  });

  it("retains compaction and branch summaries as raw-only provenance", () => {
    const result = parse([
      { type: "session", version: 3, id: "pi-session", cwd: "/repo" },
      {
        type: "compaction",
        id: "c1",
        parentId: null,
        summary: "duplicate me not"
      },
      {
        type: "branch_summary",
        id: "s1",
        parentId: "c1",
        summary: "duplicate me not"
      },
      {
        type: "custom",
        id: "x1",
        parentId: "s1",
        customType: "other",
        data: { value: 1 }
      }
    ]);
    expect(
      result.items
        .slice(1)
        .every((item) => item.projectionStatus === "raw_only")
    ).toBe(true);
    expect(
      result.items.slice(1).every((item) => item.canonicalItemKey === undefined)
    ).toBe(true);
  });

  it("rejects partial, malformed, and unsupported complete records", () => {
    const base = {
      absoluteStartOffset: 0,
      lineIndexOffset: 0,
      sessionId: "11111111-1111-4111-8111-111111111111",
      externalSessionId: "pi-session",
      sourceFingerprint: "f".repeat(64)
    };
    expect(() =>
      parsePiSessionJournalBytes({ ...base, bytes: Buffer.from("{}") })
    ).toThrow("pi_session_segment_incomplete");
    expect(() =>
      parsePiSessionJournalBytes({ ...base, bytes: Buffer.from("{bad}\n") })
    ).toThrow("pi_session_malformed_record");
    expect(() =>
      parse([{ type: "session", version: 2, id: "pi-session", cwd: "/repo" }])
    ).toThrow("pi_session_version_unsupported:2");
  });

  it("uses stable IDs across duplicate or reordered signals", () => {
    const records = [
      { type: "session", version: 3, id: "pi-session", cwd: "/repo" },
      {
        type: "message",
        id: "u1",
        parentId: null,
        message: { role: "user", content: "hello" }
      }
    ];
    expect(parse(records).items.map((item) => item.idempotencyKey)).toEqual(
      parse(records).items.map((item) => item.idempotencyKey)
    );
  });
});

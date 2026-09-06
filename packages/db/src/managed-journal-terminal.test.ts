import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { ConversationSourceArtifactRecord } from "./types.js";
import {
  releaseVerifiedManagedJournalItems,
  verifyManagedJournalTerminal
} from "./managed-journal-terminal.js";

const artifact = (sourceKind: string, size: number) =>
  ({
    id: "artifact",
    ownerUserId: "owner",
    sessionId: "session",
    sourceGenerationId: "generation",
    sourceKind,
    sourceComponentId: "main",
    externalSessionId: "native",
    lifecycle: "active",
    journalStartOffset: 0,
    journalStartLine: 0,
    providerCursorOffset: size
  }) as ConversationSourceArtifactRecord;
const prove = (sourceKind: string, entries: unknown[]) => {
  const bytes = Buffer.from(
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  );
  return verifyManagedJournalTerminal({
    artifact: artifact(sourceKind, bytes.length),
    sourceOffset: bytes.length,
    bytes
  });
};
const claude = (
  uuid: string,
  type: string,
  content: unknown,
  stop_reason?: string
) => ({
  sessionId: "native",
  uuid,
  type,
  message: { content, stop_reason }
});
const pi = (
  id: string,
  parentId: string | null,
  role: string,
  stopReason?: string
) => ({
  type: "message",
  id,
  parentId,
  message: { role, content: [{ type: "text", text: id }], stopReason }
});
const header = { type: "session", version: 3, id: "native" };

describe("managed terminal journal verification", () => {
  it("proves Claude's native terminal and keeps tool results in the human turn", () => {
    const proof = prove("claude-code", [
      claude("user", "user", "hi"),
      claude(
        "call",
        "assistant",
        [{ type: "tool_use", id: "tool" }],
        "tool_use"
      ),
      claude("result", "user", [
        { type: "tool_result", tool_use_id: "tool", content: "done" }
      ]),
      claude(
        "answer",
        "assistant",
        [{ type: "text", text: "done" }],
        "end_turn"
      )
    ]);
    expect(proof.items.map(({ turn, stable }) => ({ turn, stable }))).toEqual(
      ["user", "call", "result", "answer"].map((id) => ({
        turn: "user",
        stable: `main:${id}:0`
      }))
    );
  });

  it("requires Claude native completion even when a hook claims Stop", () => {
    expect(() =>
      prove("claude-code", [
        claude("user", "user", "hi"),
        claude("call", "assistant", [{ type: "tool_use" }], "tool_use"),
        { type: "hook_signal", payload: { type: "turn_completed" } }
      ])
    ).toThrow("journal evidence is invalid");
  });

  it("does not accept an old terminal for a newer unfinished Claude turn", () => {
    expect(() =>
      prove("claude-code", [
        claude("user", "user", "hi"),
        claude("answer", "assistant", "done", "end_turn"),
        claude("next", "user", "next")
      ])
    ).toThrow();
  });

  it("rejects cross-session Claude evidence", () => {
    expect(() =>
      prove("claude-code", [
        claude("user", "user", "hi"),
        {
          ...claude("answer", "assistant", "done", "end_turn"),
          sessionId: "other"
        }
      ])
    ).toThrow();
  });

  it("follows Pi ancestry and excludes an unfinished sibling branch", () => {
    const proof = prove("pi", [
      header,
      pi("user", null, "user"),
      pi("sibling", "user", "assistant", "toolUse"),
      pi("call", "user", "assistant", "toolUse"),
      pi("result", "call", "toolResult"),
      pi("answer", "result", "assistant", "stop")
    ]);
    expect(proof.items.map(({ turn, stable }) => ({ turn, stable }))).toEqual([
      { turn: "result", stable: "answer:0" },
      { turn: "call", stable: "result:0" },
      { turn: "user", stable: "call:0" },
      { turn: "user", stable: "user:0" }
    ]);
  });

  it.each(["toolUse", undefined])(
    "holds Pi without a terminal stop reason (%s)",
    (reason) => {
      expect(() =>
        prove("pi", [
          header,
          pi("user", null, "user"),
          pi("answer", "user", "assistant", reason)
        ])
      ).toThrow();
    }
  );

  it("rejects disconnected Pi terminal evidence and wrong session headers", () => {
    expect(() =>
      prove("pi", [header, pi("answer", "missing", "assistant", "stop")])
    ).toThrow();
    expect(() =>
      prove("pi", [
        { ...header, id: "other" },
        pi("user", null, "user"),
        pi("answer", "user", "assistant", "stop")
      ])
    ).toThrow();
  });

  it("requires complete JSONL and a journal beginning at zero", () => {
    const bytes = Buffer.from('{"type":"session"}');
    expect(() =>
      verifyManagedJournalTerminal({
        artifact: artifact("pi", bytes.length),
        sourceOffset: bytes.length,
        bytes
      })
    ).toThrow();
    expect(() =>
      verifyManagedJournalTerminal({
        artifact: { ...artifact("pi", 1), journalStartOffset: 1 },
        sourceOffset: 1,
        bytes: Buffer.from("\n")
      })
    ).toThrow();
  });

  it("rejects forged capabilities and a different owner before database access", async () => {
    const proof = prove("pi", [
      header,
      pi("user", null, "user"),
      pi("answer", "user", "assistant", "stop")
    ]);
    const query = vi.fn();
    const client = { query } as unknown as pg.PoolClient;
    await expect(
      releaseVerifiedManagedJournalItems(
        client,
        { userId: "owner" },
        "session",
        { ...proof }
      )
    ).rejects.toThrow();
    await expect(
      releaseVerifiedManagedJournalItems(
        client,
        { userId: "other" },
        "session",
        proof
      )
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("rechecks the artifact after verification and fails if it was deleted", async () => {
    const proof = prove("pi", [
      header,
      pi("user", null, "user"),
      pi("answer", "user", "assistant", "stop")
    ]);
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(
      releaseVerifiedManagedJournalItems(
        { query } as unknown as pg.PoolClient,
        { userId: "owner" },
        "session",
        proof
      )
    ).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

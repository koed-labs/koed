import { describe, expect, it } from "vitest";
import {
  verifyCodexTranscriptRewrite,
  verifyCodexTranscriptContinuation,
  collectCodexTranscriptContinuationAncestors,
  type CodexTranscriptContinuationEvidence
} from "../src/codex-transcript-rewrite.js";

const timestamp = "2026-10-07T00:00:00.000Z";
const sourceId = "00000000-0000-4000-8000-000000000001";
type FixtureRow = {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
  ordinal?: number;
};
const bytes = (records: unknown[]) =>
  Buffer.from(
    records.map((record) => JSON.stringify(record)).join("\n") + "\n"
  );
const event = (payload: Record<string, unknown>): FixtureRow => ({
  timestamp,
  type: "event_msg",
  payload
});
const header = { timestamp, type: "session_meta", payload: { id: sourceId } };
const previous: FixtureRow[] = [
  header,
  event({ type: "task_started", turn_id: "turn-1" }),
  event({ type: "user_message", message: "Repeated text", text_elements: [] }),
  event({ type: "agent_message", message: "Answer", phase: null }),
  event({ type: "task_complete", turn_id: "turn-1" })
];
const rewritten: FixtureRow[] = previous.map((record, ordinal) => {
  if (ordinal === 0)
    return {
      ...record,
      ordinal,
      payload: { ...record.payload, history_mode: "paginated" }
    };
  if (ordinal !== 2 && ordinal !== 3) return { ...record, ordinal };
  return {
    ...event({
      type: "item_completed",
      thread_id: sourceId,
      turn_id: "turn-1",
      started_at_ms: null,
      completed_at_ms: Date.parse(timestamp),
      item:
        ordinal === 2
          ? {
              type: "UserMessage",
              id: "item-1",
              content: [
                { type: "text", text: "Repeated text", text_elements: [] }
              ]
            }
          : {
              type: "AgentMessage",
              id: "item-2",
              content: [{ type: "Text", text: "Answer" }]
            }
    }),
    ordinal
  };
});
const verify = (oldRecords = previous, newRecords: unknown[] = rewritten) =>
  verifyCodexTranscriptRewrite({
    previousBytes: bytes(oldRecords),
    rewrittenBytes: bytes(newRecords),
    externalSessionId: sourceId
  });

describe("verified Codex source rewrite frontier", () => {
  const previousLabel = `rollout-fixture-${sourceId}.jsonl`;
  const currentLabel = `rollout-fixture-${sourceId}_00000000-0000-4000-8000-000000000002.jsonl`;
  const continuationHeader = {
    ...rewritten[0]!,
    ordinal: 2,
    payload: {
      ...rewritten[0]!.payload,
      history_base: {
        thread_id: sourceId,
        end_ordinal_exclusive: 2,
        end_byte_offset: bytes(rewritten.slice(0, 2)).length
      }
    }
  };
  const verifyContinuation = (
    rows: unknown[] = [continuationHeader],
    oldRows: unknown[] = rewritten,
    start = 0,
    previousHistory?: { subagentHistoryStartOrdinal: number | null }
  ) =>
    verifyCodexTranscriptContinuation({
      previousBytes: bytes(oldRows),
      previousStartOffset: start,
      previousSourceLabel: previousLabel,
      rewrittenBytes: bytes(rows),
      rewrittenSourceLabel: currentLabel,
      externalSessionId: sourceId,
      previousHistory
    });
  it("maps a native revert to its new header without replaying or deleting retained activity", () => {
    expect(verifyContinuation()).toMatchObject({
      journalStartOffset: 0,
      journalStartLine: 0,
      liveStartOffset: bytes([continuationHeader]).length,
      liveStartLine: 1
    });
    expect(
      verifyContinuation([
        { ...continuationHeader },
        { ...event({ type: "task_started", turn_id: "new-turn" }), ordinal: 3 }
      ]).liveStartOffset
    ).toBe(bytes([continuationHeader]).length);
  });
  it("proves a continuation cutoff against only the previously admitted source range", () => {
    const admitted = rewritten.slice(1);
    const start = bytes(rewritten.slice(0, 1)).length;
    expect(
      verifyContinuation([continuationHeader], admitted, start, {
        subagentHistoryStartOrdinal: null
      }).liveStartLine
    ).toBe(1);
    expect(() =>
      verifyContinuation(
        [continuationHeader],
        rewritten.slice(2),
        bytes(rewritten.slice(0, 2)).length
      )
    ).toThrow("codex_rollout_continuation_cutoff_unproven");
  });
  it("requires corroborated own-history context for a headerless predecessor", () => {
    expect(() =>
      verifyContinuation(
        [continuationHeader],
        rewritten.slice(1),
        bytes(rewritten.slice(0, 1)).length
      )
    ).toThrow("codex_rollout_continuation_history_fence_unproven");
  });
  it("preserves a corroborated subagent own-history boundary without a predecessor header", () => {
    const replacement: FixtureRow = structuredClone(continuationHeader);
    replacement.payload.subagent_history_start_ordinal = 4;
    expect(
      verifyContinuation(
        [replacement],
        rewritten.slice(1),
        bytes(rewritten.slice(0, 1)).length,
        { subagentHistoryStartOrdinal: 4 }
      ).liveStartLine
    ).toBe(1);
  });
  it.each([undefined, null, 0, 3, 5])(
    "rejects a changed or omitted headerless subagent boundary %s",
    (boundary) => {
      const replacement: FixtureRow = structuredClone(continuationHeader);
      if (boundary !== undefined)
        replacement.payload.subagent_history_start_ordinal = boundary;
      expect(() =>
        verifyContinuation(
          [replacement],
          rewritten.slice(1),
          bytes(rewritten.slice(0, 1)).length,
          { subagentHistoryStartOrdinal: 4 }
        )
      ).toThrow("codex_rollout_continuation_metadata_changed");
    }
  );
  it("rejects introducing a boundary into corroborated unrestricted history", () => {
    const replacement: FixtureRow = structuredClone(continuationHeader);
    replacement.payload.subagent_history_start_ordinal = 4;
    expect(() =>
      verifyContinuation(
        [replacement],
        rewritten.slice(1),
        bytes(rewritten.slice(0, 1)).length,
        { subagentHistoryStartOrdinal: null }
      )
    ).toThrow("codex_rollout_continuation_metadata_changed");
  });
  const ancestryFixture = (crossLogical = false) => {
    const parentId = "00000000-0000-4000-8000-000000000004";
    const parentRows = rewritten.map((record, index) =>
      index === 0
        ? {
            ...record,
            payload: {
              ...record.payload,
              id: crossLogical ? parentId : sourceId
            }
          }
        : record
    );
    const parentLabel = `rollout-fixture-${crossLogical ? parentId : sourceId}.jsonl`;
    const oldHeader = {
      ...continuationHeader,
      ordinal: 3,
      payload: {
        ...continuationHeader.payload,
        ...(crossLogical
          ? { forked_from_id: parentId, forked_from_ordinal_exclusive: 3 }
          : {}),
        history_base: {
          thread_id: crossLogical ? parentId : sourceId,
          end_ordinal_exclusive: 3,
          end_byte_offset: bytes(parentRows.slice(0, 3)).length
        }
      }
    };
    const replacement = {
      ...oldHeader,
      ordinal: 2,
      payload: {
        ...oldHeader.payload,
        ...(crossLogical ? { forked_from_ordinal_exclusive: 2 } : {}),
        history_base: {
          thread_id: crossLogical ? parentId : sourceId,
          end_ordinal_exclusive: 2,
          end_byte_offset: bytes(parentRows.slice(0, 2)).length
        }
      }
    };
    const ancestor: CodexTranscriptContinuationEvidence & {
      closureHash: string;
    } = {
      bytes: bytes(parentRows),
      startOffset: 0,
      sourceLabel: parentLabel,
      sourceGenerationId: "ancestor-generation",
      logicalThreadId: crossLogical ? parentId : sourceId,
      closureHash: "ancestor-closure",
      priorGenerationClosure: null
    };
    const prior: CodexTranscriptContinuationEvidence = {
      bytes: bytes([
        oldHeader,
        {
          ...event({ type: "task_started", turn_id: "retained-turn" }),
          ordinal: 4
        }
      ]),
      startOffset: 0,
      sourceLabel: currentLabel,
      sourceGenerationId: "prior-generation",
      logicalThreadId: sourceId,
      closureHash: "prior-closure",
      priorGenerationClosure: crossLogical
        ? null
        : {
            sourceGenerationId: ancestor.sourceGenerationId,
            contentDigest: ancestor.closureHash
          }
    };
    const verifyAncestry = (
      ancestors: CodexTranscriptContinuationEvidence[] = [ancestor],
      replacementRows: unknown[] = [replacement]
    ) =>
      verifyCodexTranscriptContinuation({
        previousBytes: prior.bytes,
        previousStartOffset: 0,
        previousSourceLabel: prior.sourceLabel,
        rewrittenBytes: bytes(replacementRows),
        rewrittenSourceLabel: `rollout-fixture-${sourceId}_00000000-0000-4000-8000-000000000005.jsonl`,
        externalSessionId: sourceId,
        ancestors
      });
    return { ancestor, prior, replacement, verifyAncestry, parentId };
  };
  it("proves a normalized revert against an older signed same-logical generation", async () => {
    const f = ancestryFixture();
    const ancestors = await collectCodexTranscriptContinuationAncestors({
      previous: f.prior,
      rewrittenBytes: bytes([f.replacement]),
      loadGeneration: async () => f.ancestor,
      loadThread: async () => null
    });
    expect(ancestors).toEqual([f.ancestor]);
    expect(f.verifyAncestry(ancestors).liveStartLine).toBe(1);
  });
  it("proves a normalized fork revert from the old header's stored logical parent", async () => {
    const f = ancestryFixture(true);
    const requested: string[] = [];
    const ancestors = await collectCodexTranscriptContinuationAncestors({
      previous: f.prior,
      rewrittenBytes: bytes([f.replacement]),
      loadGeneration: async () => null,
      loadThread: async (threadId) => {
        requested.push(threadId);
        return f.ancestor;
      }
    });
    expect(requested).toEqual([f.parentId]);
    expect(f.verifyAncestry(ancestors).liveStartLine).toBe(1);
  });
  it("rejects a normalized cutoff outside the previously retained ancestor range", () => {
    const f = ancestryFixture();
    const replacement = structuredClone(f.replacement);
    replacement.ordinal = 4;
    replacement.payload.history_base.end_ordinal_exclusive = 4;
    replacement.payload.history_base.end_byte_offset = bytes(
      rewritten.slice(0, 4)
    ).length;
    expect(() => f.verifyAncestry([f.ancestor], [replacement])).toThrow(
      "codex_rollout_continuation_cutoff_unproven"
    );
  });
  it("rejects an ancestor cutoff before its admitted journal boundary", () => {
    const f = ancestryFixture();
    const ancestor = {
      ...f.ancestor,
      startOffset: bytes(rewritten.slice(0, 3)).length,
      bytes: bytes(rewritten.slice(3))
    };
    expect(() => f.verifyAncestry([ancestor])).toThrow(
      "codex_rollout_continuation_cutoff_unproven"
    );
  });
  it("keeps missing or changed signed ancestor closures pending or rejected", async () => {
    const f = ancestryFixture();
    const input = {
      previous: f.prior,
      rewrittenBytes: bytes([f.replacement]),
      loadThread: async () => null
    };
    await expect(
      collectCodexTranscriptContinuationAncestors({
        ...input,
        loadGeneration: async () => null
      })
    ).rejects.toThrow("codex_rollout_continuation_ancestor_pending");
    await expect(
      collectCodexTranscriptContinuationAncestors({
        ...input,
        loadGeneration: async () => ({ ...f.ancestor, closureHash: "changed" })
      })
    ).rejects.toThrow("codex_rollout_continuation_ancestor_identity_mismatch");
  });
  it.each([
    { field: "end_byte_offset", value: 1, error: "cutoff_unproven" },
    {
      field: "thread_id",
      value: "00000000-0000-4000-8000-000000000003",
      error: "identity_mismatch"
    },
    { field: "end_ordinal_exclusive", value: 3, error: "identity_mismatch" }
  ])("rejects an unproven continuation $field", ({ field, value, error }) => {
    const altered = structuredClone(continuationHeader);
    (altered.payload.history_base as Record<string, unknown>)[field] = value;
    expect(() => verifyContinuation([altered])).toThrow(
      `codex_rollout_continuation_${error}`
    );
  });
  it("rejects changed logical metadata in a continuation", () => {
    const altered: FixtureRow = structuredClone(continuationHeader);
    altered.payload = { ...altered.payload, cwd: "/another/project" };
    expect(() => verifyContinuation([altered])).toThrow(
      "codex_rollout_continuation_metadata_changed"
    );
  });
  it("accepts native recorder timestamp and binary version changes", () => {
    const oldRows = structuredClone(rewritten);
    oldRows[0]!.payload.timestamp = timestamp;
    oldRows[0]!.payload.cli_version = "0.159.0";
    const altered: FixtureRow = structuredClone(continuationHeader);
    altered.payload = {
      ...altered.payload,
      timestamp: "2026-10-07T00:01:00.000Z",
      cli_version: "0.160.1",
      history_base: {
        ...continuationHeader.payload.history_base,
        end_byte_offset: bytes(oldRows.slice(0, 2)).length
      }
    };
    expect(verifyContinuation([altered], oldRows).liveStartLine).toBe(1);
    altered.payload.timestamp = "not-a-timestamp";
    expect(() => verifyContinuation([altered], oldRows)).toThrow(
      "codex_rollout_continuation_metadata_changed"
    );
  });
  it("binds the exact converted prefix and excludes concurrent new activity from replay", () => {
    const prefix = bytes(rewritten);
    const frontier = verify(previous, [
      ...rewritten,
      { ...event({ type: "task_started", turn_id: "turn-2" }), ordinal: 5 }
    ]);
    expect(frontier).toMatchObject({
      liveStartOffset: prefix.length,
      liveStartLine: rewritten.length
    });
    expect(frontier.prefixDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it("matches an admitted suffix by a unique exact native turn boundary", () => {
    expect(verify(previous.slice(1))).toMatchObject({
      journalStartOffset: bytes(rewritten.slice(0, 1)).length,
      journalStartLine: 1,
      liveStartOffset: bytes(rewritten).length
    });
  });
  it("does not admit an unclosed previous turn", () => {
    expect(() => verify(previous.slice(0, -1))).toThrow(
      "codex_rollout_rewrite_unclosed_turn"
    );
  });
  it("verifies replicated admitted bytes without requesting uncaptured history", () => {
    const admitted = bytes(rewritten.slice(1));
    expect(
      verifyCodexTranscriptRewrite({
        previousBytes: bytes(previous.slice(1)),
        rewrittenBytes: admitted,
        externalSessionId: sourceId,
        rewrittenMetadata: { id: sourceId, history_mode: "paginated" }
      })
    ).toMatchObject({
      journalStartOffset: 0,
      liveStartOffset: admitted.length
    });
  });
  it("refuses changed content rather than treating it as a migration", () => {
    const altered = structuredClone(rewritten);
    (
      altered[2]!.payload.item as { content: Array<{ text: string }> }
    ).content[0]!.text = "Changed text";
    expect(() => verify(previous, altered)).toThrow(
      "codex_rollout_rewrite_unproven"
    );
  });
  it("refuses a mismatched source or turn identity", () => {
    const altered = structuredClone(rewritten);
    altered[2]!.payload.turn_id = "another-turn";
    expect(() => verify(previous, altered)).toThrow(
      "codex_rollout_rewrite_unproven"
    );
  });
  it("keeps ambiguous repeated source anchors blocked", () => {
    expect(() =>
      verify(previous.slice(1), [...rewritten, { ...rewritten[1], ordinal: 5 }])
    ).toThrow("codex_rollout_rewrite_anchor_ambiguous");
  });
  it("refuses a rewrite that omits an attachment", () => {
    const altered = structuredClone(previous);
    altered[2]!.payload.local_images = ["/fixture/image.png"];
    expect(() => verify(altered)).toThrow("codex_rollout_rewrite_unproven");
  });
  it("verifies attachment-only prompts with exact native ordering and detail", () => {
    const original = structuredClone(previous);
    original[2]!.payload = {
      type: "user_message",
      message: " ",
      images: ["https://image.example.test/fixture.png"],
      image_details: ["high"],
      file_ids: ["file-fixture"],
      image_order: ["file", "inline"],
      local_images: ["/fixture/image.png"],
      local_image_details: ["low"],
      audio: ["data:audio/wav;base64,AA=="],
      local_audio: ["/fixture/audio.wav"]
    };
    const migrated = structuredClone(rewritten);
    (migrated[2]!.payload.item as Record<string, unknown>).content = [
      { type: "image", file_id: "file-fixture" },
      {
        type: "image",
        image_url: "https://image.example.test/fixture.png",
        detail: "high"
      },
      { type: "local_image", path: "/fixture/image.png", detail: "low" },
      { type: "audio", audio_url: "data:audio/wav;base64,AA==" },
      { type: "local_audio", path: "/fixture/audio.wav" }
    ];
    expect(verify(original, migrated).liveStartOffset).toBe(
      bytes(migrated).length
    );
    const reversed = structuredClone(migrated);
    (reversed[2]!.payload.item as { content: unknown[] }).content.reverse();
    expect(() => verify(original, reversed)).toThrow(
      "codex_rollout_rewrite_unproven"
    );
  });
  it("verifies native synthesized turns only from a complete admitted source", () => {
    const original = [header, previous[2]!, previous[3]!];
    const migrated = [
      rewritten[0]!,
      {
        ...event({
          type: "task_started",
          turn_id: "rollout-1",
          started_at: Date.parse(timestamp) / 1000,
          model_context_window: null,
          collaboration_mode_kind: "default"
        }),
        ordinal: 1
      },
      {
        ...rewritten[2]!,
        ordinal: 2,
        payload: { ...rewritten[2]!.payload, turn_id: "rollout-1" }
      },
      {
        ...rewritten[3]!,
        ordinal: 3,
        payload: { ...rewritten[3]!.payload, turn_id: "rollout-1" }
      },
      {
        ...event({
          type: "task_complete",
          turn_id: "rollout-1",
          last_agent_message: null,
          completed_at: Date.parse(timestamp) / 1000
        }),
        ordinal: 4
      }
    ];
    expect(verify(original, migrated).liveStartOffset).toBe(
      bytes(migrated).length
    );
    const altered = structuredClone(migrated);
    altered[1]!.payload.started_at = 1;
    expect(() => verify(original, altered)).toThrow(
      "codex_rollout_rewrite_unproven"
    );
    expect(() => verify(original.slice(1), migrated)).toThrow(
      "codex_rollout_rewrite_anchor_missing"
    );
  });
  it.each([
    {
      legacy: {
        type: "exec_command_end",
        call_id: "tool-1",
        turn_id: "turn-1",
        command: ["printf", "fixture"],
        cwd: "/fixture",
        parsed_cmd: [],
        source: "agent",
        status: "completed",
        aggregated_output: "fixture",
        exit_code: 0,
        duration: { secs: 1, nanos: 0 }
      },
      native: {
        type: "CommandExecution",
        id: "tool-1",
        command: ["printf", "fixture"],
        cwd: "file:///fixture",
        parsed_cmd: [],
        source: "agent",
        status: "completed",
        aggregated_output: "fixture",
        exit_code: 0,
        duration: { secs: 1, nanos: 0 }
      }
    },
    {
      legacy: {
        type: "mcp_tool_call_end",
        call_id: "tool-1",
        turn_id: "turn-1",
        invocation: {
          server: "fixture",
          tool: "lookup",
          arguments: { key: "decision" }
        },
        result: { Ok: { content: [{ type: "text", text: "Known decision" }] } },
        duration: { secs: 0, nanos: 3 }
      },
      native: {
        type: "McpToolCall",
        id: "tool-1",
        server: "fixture",
        tool: "lookup",
        arguments: { key: "decision" },
        result: { content: [{ type: "text", text: "Known decision" }] },
        status: "completed",
        duration: { secs: 0, nanos: 3 }
      }
    },
    {
      legacy: {
        type: "dynamic_tool_call_response",
        call_id: "tool-1",
        turn_id: "turn-1",
        tool: "lookup",
        arguments: {},
        success: false,
        content_items: [],
        error: "Unavailable",
        duration: { secs: 0, nanos: 0 }
      },
      native: {
        type: "DynamicToolCall",
        id: "tool-1",
        tool: "lookup",
        arguments: {},
        success: false,
        status: "failed",
        content_items: [],
        error: "Unavailable",
        duration: { secs: 0, nanos: 0 }
      }
    },
    {
      legacy: {
        type: "patch_apply_end",
        call_id: "tool-1",
        turn_id: "turn-1",
        changes: {},
        status: "completed",
        stdout: "",
        stderr: ""
      },
      native: {
        type: "FileChange",
        id: "tool-1",
        changes: {},
        status: "completed"
      }
    },
    {
      legacy: {
        type: "web_search_end",
        call_id: "tool-1",
        query: "fixture",
        action: { type: "search", query: "fixture" }
      },
      native: {
        type: "WebSearch",
        id: "tool-1",
        query: "fixture",
        action: { type: "search", query: "fixture" }
      }
    },
    {
      legacy: { type: "context_compacted" },
      native: { type: "ContextCompaction", id: "item-3" }
    },
    {
      legacy: {
        type: "entered_review_mode",
        turn_id: "turn-1",
        item_id: "review-1",
        target: { type: "uncommittedChanges" }
      },
      native: {
        type: "EnteredReviewMode",
        id: "review-1",
        target: { type: "uncommittedChanges" },
        user_facing_hint: "Review requested."
      }
    },
    {
      legacy: { type: "exited_review_mode", turn_id: "turn-1" },
      native: { type: "ExitedReviewMode", id: "item-3", review_output: null }
    },
    {
      legacy: {
        type: "sub_agent_activity",
        event_id: "activity-1",
        kind: "created",
        agent_thread_id: "00000000-0000-4000-8000-000000000003",
        agent_path: "1"
      },
      native: {
        type: "SubAgentActivity",
        id: "activity-1",
        kind: "created",
        agent_thread_id: "00000000-0000-4000-8000-000000000003",
        agent_path: "1",
        model: null,
        reasoning_effort: null
      }
    }
  ])(
    "checks every transformed field for $legacy.type",
    ({ legacy, native }) => {
      const oldRecords = [
        ...previous.slice(0, -1),
        event(legacy),
        previous.at(-1)!
      ];
      const newRecords = [
        ...rewritten.slice(0, -1),
        {
          ...event({
            type: "item_completed",
            thread_id: sourceId,
            turn_id: "turn-1",
            started_at_ms: null,
            completed_at_ms: Date.parse(timestamp),
            item: native
          }),
          ordinal: 4
        },
        { ...rewritten.at(-1)!, ordinal: 5 }
      ];
      expect(verify(oldRecords, newRecords).liveStartOffset).toBe(
        bytes(newRecords).length
      );
      const changed = structuredClone(newRecords);
      (changed[4]!.payload.item as Record<string, unknown>).id = "another-item";
      expect(() => verify(oldRecords, changed)).toThrow(
        "codex_rollout_rewrite_unproven"
      );
    }
  );
});

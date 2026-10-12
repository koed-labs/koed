import { describe, expect, it } from "vitest";
import {
  collectCodexTranscriptContinuationAncestors,
  verifyCodexTranscriptContinuation,
  type CodexTranscriptContinuationEvidence
} from "../src/codex-transcript-rewrite.js";

const timestamp = "2026-10-07T00:00:00.000Z";
const rootId = "00000000-0000-4000-8000-000000000001";
const parentId = "00000000-0000-4000-8000-000000000002";
const childId = "00000000-0000-4000-8000-000000000003";
const replacementId = "00000000-0000-4000-8000-000000000004";
type Row = {
  timestamp: string;
  ordinal: number;
  type: string;
  payload: Record<string, unknown>;
};
const encode = (rows: Row[]) =>
  Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
const label = (id: string) => `rollout-fixture-${id}.jsonl`;
const header = (
  id: string,
  ordinal: number,
  metadata: Record<string, unknown> = {}
): Row => ({
  timestamp,
  ordinal,
  type: "session_meta",
  payload: { id, history_mode: "paginated", ...metadata }
});
const event = (ordinal: number): Row => ({
  timestamp,
  ordinal,
  type: "event_msg",
  payload: { type: "task_started", turn_id: `turn-${ordinal}` }
});
const evidence = (
  id: string,
  rows: Row[]
): CodexTranscriptContinuationEvidence => ({
  bytes: encode(rows),
  startOffset: 0,
  sourceLabel: label(id),
  sourceGenerationId: id,
  logicalThreadId: id,
  priorGenerationClosure: null,
  closureHash: "retained"
});

const fixture = (subagent = false, directParent = false) => {
  const rootRows = [
    header(rootId, 0),
    ...Array.from({ length: 9 }, (_, index) => event(index + 1))
  ];
  const root = evidence(rootId, rootRows);
  const base = (
    id: string,
    rows: Row[],
    endOrdinal: number,
    count = endOrdinal
  ) => ({
    thread_id: id,
    end_ordinal_exclusive: endOrdinal,
    end_byte_offset: encode(rows.slice(0, count)).length
  });
  const parentRows = [
    header(parentId, 6, {
      forked_from_id: rootId,
      forked_from_ordinal_exclusive: 6,
      history_base: base(rootId, rootRows, 6)
    }),
    event(7),
    event(8),
    event(9)
  ];
  const parent = evidence(parentId, parentRows);
  const oldCutoff = directParent ? 8 : 4;
  const newCutoff = oldCutoff - 1;
  const targetId = directParent ? parentId : rootId;
  const targetRows = directParent ? parentRows : rootRows;
  const relation = subagent
    ? { parent_thread_id: parentId, subagent_history_start_ordinal: 9 }
    : { forked_from_id: parentId, forked_from_ordinal_exclusive: oldCutoff };
  const oldHeader = header(childId, oldCutoff, {
    ...relation,
    history_base: base(
      targetId,
      targetRows,
      oldCutoff,
      directParent ? 2 : oldCutoff
    )
  });
  const oldRows = [oldHeader, event(oldCutoff + 1), event(oldCutoff + 2)];
  const previous = evidence(childId, oldRows);
  const replacement = header(childId, newCutoff, {
    ...relation,
    ...(!subagent ? { forked_from_ordinal_exclusive: newCutoff } : {}),
    history_base: base(
      targetId,
      targetRows,
      newCutoff,
      directParent ? 1 : newCutoff
    )
  });
  const available = new Map([
    [parentId, parent],
    [rootId, root],
    [childId, previous]
  ]);
  const requested: string[] = [];
  const collect = () =>
    collectCodexTranscriptContinuationAncestors({
      previous,
      rewrittenBytes: encode([replacement]),
      loadGeneration: async () => null,
      loadThread: async (id) => {
        requested.push(id);
        return available.get(id) ?? null;
      }
    });
  const verify = (ancestors: CodexTranscriptContinuationEvidence[]) =>
    verifyCodexTranscriptContinuation({
      previousBytes: previous.bytes,
      previousStartOffset: 0,
      previousSourceLabel: previous.sourceLabel,
      rewrittenBytes: encode([replacement]),
      rewrittenSourceLabel: label(replacementId),
      externalSessionId: childId,
      ancestors
    });
  return {
    parent,
    root,
    previous,
    oldHeader,
    replacement,
    available,
    requested,
    collect,
    verify
  };
};

describe("admitted logical and physical continuation ancestry", () => {
  it("proves a normalized physical cutoff that skips the immediate logical fork parent", async () => {
    const f = fixture();
    const ancestors = await f.collect();
    expect(f.requested).toEqual([parentId, rootId]);
    expect(
      ancestors[0]!.logicalAncestors?.map((entry) => entry.logicalThreadId)
    ).toEqual([parentId, rootId]);
    expect(f.verify(ancestors).liveStartLine).toBe(1);
  });
  it.each([false, true])(
    "preserves the own-history fence on a parent_thread_id-only subagent (direct=%s)",
    async (direct) => {
      const f = fixture(true, direct);
      const ancestors = await f.collect();
      expect(f.verify(ancestors).liveStartLine).toBe(1);
      f.replacement.payload.subagent_history_start_ordinal = 8;
      expect(() => f.verify(ancestors)).toThrow(
        "codex_rollout_continuation_metadata_changed"
      );
    }
  );
  it.each([parentId, rootId])(
    "keeps missing admitted ancestry %s pending",
    async (id) => {
      const f = fixture();
      f.available.delete(id);
      await expect(f.collect()).rejects.toThrow(
        "codex_rollout_continuation_ancestor_pending"
      );
    }
  );
  it("rejects logical ancestry cycles", async () => {
    const f = fixture();
    const parent = header(parentId, 5, {
      forked_from_id: childId,
      forked_from_ordinal_exclusive: 5,
      history_base: {
        thread_id: childId,
        end_ordinal_exclusive: 5,
        end_byte_offset: encode([f.oldHeader]).length
      }
    });
    f.available.set(parentId, evidence(parentId, [parent, event(6)]));
    await expect(f.collect()).rejects.toThrow(
      "codex_rollout_continuation_cycle"
    );
  });
  it("does not authorize a subagent parent without a corroborated own-history boundary", async () => {
    const f = fixture(true);
    delete f.oldHeader.payload.subagent_history_start_ordinal;
    f.previous.bytes = encode([f.oldHeader, event(5), event(6)]);
    await expect(f.collect()).rejects.toThrow(
      "codex_rollout_continuation_ancestor_unproven"
    );
  });
  it("rejects a normalized prefix longer than the immediate parent's retained inherited range", async () => {
    const f = fixture();
    const parent = header(parentId, 2, {
      forked_from_id: rootId,
      forked_from_ordinal_exclusive: 2,
      history_base: {
        thread_id: rootId,
        end_ordinal_exclusive: 2,
        end_byte_offset: encode([header(rootId, 0), event(1)]).length
      }
    });
    f.available.set(parentId, evidence(parentId, [parent, event(3)]));
    const ancestors = await f.collect();
    expect(() => f.verify(ancestors)).toThrow(
      "codex_rollout_continuation_cutoff_unproven"
    );
  });
  it("rejects ancestry evidence whose source header was never admitted", async () => {
    const f = fixture();
    f.parent.startOffset = f.parent.bytes.byteLength;
    await expect(f.collect()).rejects.toThrow(
      "codex_rollout_continuation_ancestor_unproven"
    );
  });
});

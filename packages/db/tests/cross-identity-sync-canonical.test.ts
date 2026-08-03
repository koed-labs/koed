import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildCapturedSessionSyncContributor,
  capturedSessionSyncManifestMatchesContributors
} from "../src/cross-identity-sync-canonical.js";

const contributor = (originItemId: string) =>
  buildCapturedSessionSyncContributor({
    originItemId,
    actor: "user",
    kind: "user_message",
    content: "Stable contributor",
    toolName: null,
    toolCallId: null,
    sourceEventTime: "2026-07-19T12:00:00.000Z",
    sourceSequence: 1,
    sourceKind: "codex",
    sourceAdapterVersion: "codex-transcript-v1",
    sourceTransport: "transcript",
    sourceRecordType: "event_msg",
    sourceEventType: "user_message",
    rawJson: { type: "event_msg" },
    rawText: "Stable contributor",
    metadata: { actor: "user" },
    logicalSourceId: null,
    transportChunkIndex: 0,
    transportChunkCount: 1,
    transportChunkText: null,
    transportChunkEncoding: null,
    projectionStatus: "projected",
    projectionVersion: "conversation-projection-v1",
    projectionPolicyRevision: 1,
    memoryExcludedAt: null,
    memoryExclusionReason: null
  });

describe("Captured Session sync canonical snapshots", () => {
  it("accepts exact semantic manifest contributor coverage", () => {
    const first = contributor(randomUUID());
    const second = contributor(randomUUID());
    expect(
      capturedSessionSyncManifestMatchesContributors(
        {
          semanticItemManifest: [
            { sourceIds: [first.originItemId] },
            { sourceIds: [second.originItemId] }
          ]
        },
        [first, second]
      )
    ).toBe(true);
  });

  it("rejects an event payload observed ahead of its source links", () => {
    const linked = contributor(randomUUID());
    expect(
      capturedSessionSyncManifestMatchesContributors(
        {
          semanticItemManifest: [
            { sourceIds: [linked.originItemId] },
            { sourceIds: [randomUUID()] }
          ]
        },
        [linked]
      )
    ).toBe(false);
  });

  it("rejects duplicate, malformed, and unmanifested contributors", () => {
    const linked = contributor(randomUUID());
    expect(
      capturedSessionSyncManifestMatchesContributors(
        {
          semanticItemManifest: [
            { sourceIds: [linked.originItemId, linked.originItemId] }
          ]
        },
        [linked]
      )
    ).toBe(false);
    expect(
      capturedSessionSyncManifestMatchesContributors(
        { semanticItemManifest: [{ sourceIds: [] }] },
        [linked]
      )
    ).toBe(false);
    expect(capturedSessionSyncManifestMatchesContributors({}, [linked])).toBe(
      false
    );
    expect(capturedSessionSyncManifestMatchesContributors({}, [])).toBe(true);
  });
});

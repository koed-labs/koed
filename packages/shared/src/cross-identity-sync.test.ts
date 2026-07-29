import { describe, expect, it } from "vitest";
import {
  CAPTURED_SESSION_SYNC_FORMAT,
  CAPTURED_SESSION_SYNC_FORMAT_VERSION,
  CAPTURED_SESSION_SYNC_MAX_CHUNKS,
  CAPTURED_SESSION_SYNC_POLICY_VERSION,
  capturedSessionSyncUploadPackageManifestSchema,
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest,
  crossIdentitySyncPackageRequestHash,
  crossIdentitySyncSummaryNodeRevisionHash,
  isCapturedSessionSyncChunkV1,
  isCapturedSessionSyncPackageV1,
  type CapturedSessionSyncSummaryNodeV1,
  type CapturedSessionSyncPackageV1
} from "./cross-identity-sync.js";

const summaryNodeFixture = (): CapturedSessionSyncSummaryNodeV1 => {
  const node = {
    originNodeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    kind: "leaf",
    depth: 0,
    lcmAlgorithmVersion: "lcm-v1",
    summaryText: "A canonical LCM summary.",
    summaryModel: "local-summary-model",
    summaryPromptVersion: "prompt-v1",
    summaryStructuredJson: {
      schema_version: "lcm-structured-summary-v1",
      summary_text: "A canonical LCM summary."
    },
    summaryStructuredSchemaVersion: "lcm-structured-summary-v1",
    sourceOriginEventIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    childOriginNodeIds: [],
    sourceHash: "d".repeat(64),
    sourceEventCount: 1,
    sourceTokenEstimate: 12,
    summaryTokenEstimate: 6,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:01:00.000Z"
  } satisfies Omit<CapturedSessionSyncSummaryNodeV1, "revisionHash">;
  return {
    ...node,
    revisionHash: crossIdentitySyncSummaryNodeRevisionHash(node)
  };
};

const packageFixture = (): CapturedSessionSyncPackageV1 => {
  const summaryNodes = [summaryNodeFixture()];
  return {
    format: CAPTURED_SESSION_SYNC_FORMAT,
    formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
    policyVersion: CAPTURED_SESSION_SYNC_POLICY_VERSION,
    packageId: "11111111-1111-4111-8111-111111111111",
    relationshipId: "22222222-2222-4222-8222-222222222222",
    logicalMemoryId: "33333333-3333-4333-8333-333333333333",
    sourceDeploymentId: "44444444-4444-4444-8444-444444444444",
    sourceUserId: "55555555-5555-4555-8555-555555555555",
    sourceReplicaId: "66666666-6666-4666-8666-666666666666",
    targetDeploymentId: "77777777-7777-4777-8777-777777777777",
    targetUserId: "88888888-8888-4888-8888-888888888888",
    targetReplicaId: "99999999-9999-4999-8999-999999999999",
    packageSequence: 1,
    fromCursor: 0,
    toCursor: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    consentDigest: "a".repeat(64),
    policyDigest: "b".repeat(64),
    summaryRevisionHash: crossIdentitySyncDigest(summaryNodes),
    session: {
      originSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      externalSessionId: "thread-1",
      sourceRuntime: "codex",
      captureMethod: "mcp",
      capturedAt: "2026-07-12T00:00:00.000Z",
      title: "Test session",
      sourceAdapterVersion: "1"
    },
    changes: [
      {
        cursor: 1,
        operation: "delete",
        originEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        revisionHash: "c".repeat(64),
        event: null
      }
    ],
    summaryNodes
  };
};

describe("Cross-Identity Sync protocol", () => {
  it("uses one strict upload manifest contract across protocol boundaries", () => {
    const manifest = {
      objectClass: "sync_package",
      format: CAPTURED_SESSION_SYNC_FORMAT,
      formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
      packageDigest: "a".repeat(64),
      summaryRevisionHash: null,
      recipientKeyId: "sync-recipient:test",
      recipientKeyVersion: 1,
      recordCount: 2
    };

    expect(
      capturedSessionSyncUploadPackageManifestSchema.safeParse(manifest).success
    ).toBe(true);
    expect(
      capturedSessionSyncUploadPackageManifestSchema.safeParse({
        ...manifest,
        summaryRevisionHash: "b".repeat(64)
      }).success
    ).toBe(true);
    const missingRevision: Partial<typeof manifest> = { ...manifest };
    delete missingRevision.summaryRevisionHash;
    expect(
      capturedSessionSyncUploadPackageManifestSchema.safeParse(missingRevision)
        .success
    ).toBe(false);
    expect(
      capturedSessionSyncUploadPackageManifestSchema.safeParse({
        ...manifest,
        sourceText: "must not enter control metadata"
      }).success
    ).toBe(false);
  });

  it("derives stable, namespace-sensitive protocol UUIDs", () => {
    const input = { relationship: "source", idempotencyKey: "retry-key" };
    const first = crossIdentitySyncDeterministicUuid(input);

    expect(first).toBe(crossIdentitySyncDeterministicUuid(input));
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(first).not.toBe(
      crossIdentitySyncDeterministicUuid({ ...input, relationship: "target" })
    );
  });

  it("hashes canonical objects independently of key insertion order", () => {
    expect(crossIdentitySyncDigest({ a: 1, b: 2 })).toBe(
      crossIdentitySyncDigest({ b: 2, a: 1 })
    );
  });

  it("uses locale-independent canonical key ordering", () => {
    const first = Object.fromEntries([
      ["ä", 1],
      ["z", 2]
    ]);
    const second = Object.fromEntries([
      ["z", 2],
      ["ä", 1]
    ]);
    expect(crossIdentitySyncDigest(first)).toBe(
      crossIdentitySyncDigest(second)
    );
    expect(() => crossIdentitySyncDigest({ value: Number.NaN })).toThrow(
      "finite numbers"
    );
  });

  it("recognizes only the supported package version", () => {
    const value = packageFixture();
    expect(isCapturedSessionSyncPackageV1(value)).toBe(true);
    expect(isCapturedSessionSyncPackageV1({ ...value, formatVersion: 2 })).toBe(
      false
    );
    expect(isCapturedSessionSyncPackageV1({ ...value, unknown: true })).toBe(
      false
    );
    expect(isCapturedSessionSyncPackageV1({ ...value, toCursor: 2 })).toBe(
      false
    );
    expect(
      isCapturedSessionSyncPackageV1({
        ...value,
        createdAt: "2026-07-12T07:00:00.000+07:00"
      })
    ).toBe(false);
    expect(
      isCapturedSessionSyncPackageV1({
        ...value,
        changes: [
          {
            ...value.changes[0],
            extra: "../../not-a-protocol-field"
          }
        ]
      })
    ).toBe(false);
  });

  it("validates authoritative summary nodes and binds their canonical digest", () => {
    const value = packageFixture();
    const originalRequestHash = crossIdentitySyncPackageRequestHash(value);
    const changedSummaryHash = crossIdentitySyncDigest([
      { ...value.summaryNodes[0], summaryText: "Changed summary." }
    ]);

    expect(isCapturedSessionSyncPackageV1(value)).toBe(true);
    expect(
      crossIdentitySyncPackageRequestHash({
        ...value,
        summaryRevisionHash: changedSummaryHash
      })
    ).not.toBe(originalRequestHash);
    expect(
      isCapturedSessionSyncPackageV1({
        ...value,
        summaryNodes: [
          { ...value.summaryNodes[0], summaryText: "Tampered summary." }
        ]
      })
    ).toBe(false);
    expect(
      isCapturedSessionSyncPackageV1({
        ...value,
        summaryNodes: [...value.summaryNodes, value.summaryNodes[0]]
      })
    ).toBe(false);
  });

  it("accepts a summary-only package without advancing the event cursor", () => {
    const value = packageFixture();

    expect(
      isCapturedSessionSyncPackageV1({
        ...value,
        fromCursor: 1,
        toCursor: 1,
        changes: []
      })
    ).toBe(true);
  });

  it("accepts an empty authoritative summary snapshot", () => {
    const value = packageFixture();

    expect(
      isCapturedSessionSyncPackageV1({
        ...value,
        fromCursor: 1,
        toCursor: 1,
        changes: [],
        summaryNodes: [],
        summaryRevisionHash: crossIdentitySyncDigest([])
      })
    ).toBe(true);
  });

  it("rejects malformed summary provenance and kind/children shapes", () => {
    const value = packageFixture();
    const node = value.summaryNodes[0]!;
    const revise = (
      candidate: CapturedSessionSyncSummaryNodeV1
    ): CapturedSessionSyncSummaryNodeV1 => ({
      ...candidate,
      revisionHash: crossIdentitySyncSummaryNodeRevisionHash(candidate)
    });
    const invalidNodes = (
      [
        {
          ...node,
          sourceOriginEventIds: [
            node.sourceOriginEventIds[0]!,
            node.sourceOriginEventIds[0]!
          ]
        },
        {
          ...node,
          childOriginNodeIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"]
        },
        {
          ...node,
          kind: "rollup",
          childOriginNodeIds: []
        },
        { ...node, summaryPromptVersion: "" },
        { ...node, summaryText: "" },
        {
          ...node,
          updatedAt: "2026-07-12T07:01:00.000+07:00"
        }
      ] satisfies CapturedSessionSyncSummaryNodeV1[]
    ).map(revise);

    for (const node of invalidNodes) {
      const summaryNodes = [node];
      expect(
        isCapturedSessionSyncPackageV1({
          ...value,
          summaryNodes,
          summaryRevisionHash: crossIdentitySyncDigest(summaryNodes)
        })
      ).toBe(false);
    }

    const invalidRevision = [{ ...node, revisionHash: "f".repeat(64) }];
    expect(
      isCapturedSessionSyncPackageV1({
        ...value,
        summaryNodes: invalidRevision,
        summaryRevisionHash: crossIdentitySyncDigest(invalidRevision)
      })
    ).toBe(false);

    const nodesWithoutPrompt = [{ ...node, summaryPromptVersion: null }];
    expect(
      isCapturedSessionSyncPackageV1({
        ...value,
        summaryNodes: nodesWithoutPrompt,
        summaryRevisionHash: crossIdentitySyncDigest(nodesWithoutPrompt)
      })
    ).toBe(false);
  });

  it("rejects invalid chunk boundaries", () => {
    const value = packageFixture();
    const chunk = {
      format: CAPTURED_SESSION_SYNC_FORMAT,
      formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
      packageId: value.packageId,
      relationshipId: value.relationshipId,
      packageSequence: 1,
      fromCursor: 0,
      toCursor: 1,
      chunkIndex: 1,
      chunkCount: 1,
      packageDigest: "c".repeat(64),
      package: value
    };
    expect(isCapturedSessionSyncChunkV1(chunk)).toBe(false);
    expect(
      isCapturedSessionSyncChunkV1({
        ...chunk,
        chunkIndex: 0
      })
    ).toBe(true);
    expect(
      isCapturedSessionSyncChunkV1({
        ...chunk,
        chunkIndex: 0,
        chunkCount: CAPTURED_SESSION_SYNC_MAX_CHUNKS + 1
      })
    ).toBe(false);
  });

  it("fails closed across a bounded protocol mutation corpus", () => {
    const fixture = packageFixture();
    for (const key of Object.keys(fixture)) {
      const mutated = Object.fromEntries(
        Object.entries(structuredClone(fixture))
      );
      mutated[key] = null;
      expect(() => isCapturedSessionSyncPackageV1(mutated)).not.toThrow();
      expect(isCapturedSessionSyncPackageV1(mutated)).toBe(false);
    }

    const malformed: unknown[] = [
      { ...fixture, packageSequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...fixture, fromCursor: 2, toCursor: 1 },
      { ...fixture, toCursor: 2 },
      {
        ...fixture,
        session: { ...fixture.session, title: "x".repeat(2_001) }
      },
      {
        ...fixture,
        changes: Array.from({ length: 10_001 }, () => fixture.changes[0])
      },
      {
        ...fixture,
        changes: [
          {
            ...fixture.changes[0],
            operation: "../../unexpected-operation"
          }
        ]
      },
      {
        ...fixture,
        changes: [
          {
            ...fixture.changes[0],
            event: {
              originEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              revisionHash: "c".repeat(64),
              eventType: "captured",
              actor: "user",
              content: null,
              metadata: {},
              tokenCount: null,
              sealReason: null,
              capturedAt: "2026-07-12T00:00:00.000Z",
              sourceEventTime: null,
              sourceSequence: null,
              contributors: []
            }
          }
        ]
      },
      { ...fixture, changes: [null] },
      {
        ...fixture,
        changes: [
          {
            ...fixture.changes[0],
            operation: "upsert",
            event: {
              originEventId: fixture.changes[0]!.originEventId,
              revisionHash: fixture.changes[0]!.revisionHash,
              eventType: "captured",
              actor: "agent",
              content: "safe",
              metadata: {},
              tokenCount: 1,
              sealReason: "agent_stop",
              capturedAt: fixture.createdAt,
              sourceEventTime: fixture.createdAt,
              sourceSequence: 1,
              contributors: [null]
            }
          }
        ]
      }
    ];
    for (const value of malformed) {
      expect(() => isCapturedSessionSyncPackageV1(value)).not.toThrow();
      expect(isCapturedSessionSyncPackageV1(value)).toBe(false);
    }
  });
});

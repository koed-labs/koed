import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MemorySourceRepository,
  SyncPackageChunkRecord,
  SyncPackageUploadSessionRecord,
  SyncQueueEntryRecord
} from "@koed/db";
import {
  CAPTURED_SESSION_SYNC_FORMAT,
  CAPTURED_SESSION_SYNC_FORMAT_VERSION,
  CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES,
  CAPTURED_SESSION_SYNC_POLICY_VERSION,
  createEncryptedJsonPackage,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createRecipientPrivateKeyEnvelopeEncryptionProvider,
  createRecipientPublicKeyEnvelopeEncryptionProvider,
  crossIdentitySyncDigest,
  crossIdentitySyncSummaryNodeRevisionHash,
  crossIdentitySyncPackageRequestHash,
  decryptEncryptedJsonPackage,
  generateRecipientKeyMaterial,
  isCapturedSessionSyncChunkV1,
  storeUpstreamCredentialSecret,
  type CapturedSessionSyncChunkV1,
  type CapturedSessionSyncPackageV1,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import type { EmbeddingWorkflow } from "./embedding-workflow.js";
import {
  createCrossIdentitySyncService,
  withLeaseHeartbeat
} from "./cross-identity-sync-service.js";

const temporaryHomes: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("Cross-Identity Sync queue leases", () => {
  it("renews a lease while a slow operation is still running", async () => {
    vi.useFakeTimers();
    let finish: ((value: string) => void) | undefined;
    const operation = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const renew = vi.fn().mockResolvedValue(undefined);

    const result = withLeaseHeartbeat({
      leaseMs: 300,
      renew,
      operation: () => operation
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(renew).toHaveBeenCalledTimes(2);
    finish?.("complete");
    await expect(result).resolves.toBe("complete");
  });

  it("fails the operation when a lease heartbeat is lost", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const operation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const renew = vi.fn().mockRejectedValue(new Error("lease lost"));

    const result = withLeaseHeartbeat({
      leaseMs: 300,
      renew,
      operation: () => operation
    });

    await vi.advanceTimersByTimeAsync(100);
    finish?.();
    await expect(result).rejects.toThrow("lease lost");
  });
});

const queueEntry = (): SyncQueueEntryRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  syncRelationshipId: "22222222-2222-4222-8222-222222222222",
  uploadSessionId: null,
  state: "processing",
  idempotencyKey: "revocation:1",
  requestHash: "a".repeat(64),
  payloadManifest: {
    kind: "revocation",
    revocationId: "33333333-3333-4333-8333-333333333333",
    revocationSequence: 1
  },
  attemptCount: 1,
  maxAttempts: 8,
  availableAt: "2026-07-13T00:00:00.000Z",
  claimToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  leaseExpiresAt: null
});

const summaryNodeFixture = (
  index: number,
  summaryText = `Authoritative summary ${index}`
): CapturedSessionSyncPackageV1["summaryNodes"][number] => {
  const node = {
    originNodeId: `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, "0")}`,
    kind: "leaf",
    depth: 0,
    lcmAlgorithmVersion: "lcm-v1",
    summaryText,
    summaryModel: "local-summary-model",
    summaryPromptVersion: "prompt-v1",
    summaryStructuredJson: {
      schema_version: "lcm-structured-summary-v1",
      summary_text: summaryText
    },
    summaryStructuredSchemaVersion: "lcm-structured-summary-v1",
    sourceOriginEventIds: [
      `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, "0")}`
    ],
    childOriginNodeIds: [],
    sourceHash: "a".repeat(64),
    sourceEventCount: 1,
    sourceTokenEstimate: 100,
    summaryTokenEstimate: 25,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:01:00.000Z"
  } satisfies Omit<
    CapturedSessionSyncPackageV1["summaryNodes"][number],
    "revisionHash"
  >;
  return {
    ...node,
    revisionHash: crossIdentitySyncSummaryNodeRevisionHash(node)
  };
};

const createFixture = (
  status: number,
  responseBody: Record<string, unknown>
) => {
  const koedHome = mkdtempSync(join(tmpdir(), "koed-sync-worker-"));
  temporaryHomes.push(koedHome);
  const backendId = "team-backend";
  const { reference } = storeUpstreamCredentialSecret(koedHome, {
    backendId,
    credentialKeyId: "credential-key",
    secret: "device-secret"
  });
  const entry = queueEntry();
  const failSyncQueueEntry = vi.fn().mockResolvedValue(undefined);
  const repository = {
    recordCrossIdentitySyncWorkerHeartbeat: vi
      .fn()
      .mockResolvedValue(undefined),
    listDueSourceSyncHeartbeats: vi.fn().mockResolvedValue([]),
    markOverdueSyncRelationshipsStale: vi.fn().mockResolvedValue(0),
    cleanupCrossIdentitySyncState: vi.fn().mockResolvedValue({
      chunksDeleted: 0,
      uploadsFailed: 0,
      queueEntriesDeleted: 0,
      uploadSessionsDeleted: 0
    }),
    claimSyncQueueEntry: vi
      .fn()
      .mockImplementation(({ queue }) =>
        Promise.resolve(queue === "outbox" ? entry : null)
      ),
    getSyncTransportContext: vi.fn().mockResolvedValue({
      relationship: { side: "source" },
      localDeploymentId: "local",
      localProtocolDeploymentId: "44444444-4444-4444-8444-444444444444",
      remoteProtocolDeploymentId: "55555555-5555-4555-8555-555555555555",
      remoteBaseUrl: "https://team.example.com",
      remoteUpstreamBackendId: backendId,
      remoteCredentialReference: reference,
      remoteSubjectId: "remote-user"
    }),
    renewSyncQueueLease: vi.fn().mockResolvedValue(true),
    failSyncQueueEntry,
    completeSyncQueueEntry: vi.fn().mockResolvedValue(true)
  } as unknown as MemorySourceRepository;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
  const fetchFn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" }
    })
  );
  const service = createCrossIdentitySyncService({
    repository,
    recipientKeyEncryptionProvider: {} as EnvelopeEncryptionProvider,
    embeddingWorkflow: {} as EmbeddingWorkflow,
    koedHome,
    isSourceIdentityHealthy: () => true,
    fetch: fetchFn,
    staleAfterSeconds: 3_600,
    logger
  });
  return { entry, failSyncQueueEntry, fetchFn, logger, service };
};

describe("Cross-Identity Sync device identity gate", () => {
  it("keeps its service heartbeat fresh during a long sync iteration", async () => {
    vi.useFakeTimers();
    try {
      let finishDelta!: (value: null) => void;
      const delta = new Promise<null>((resolve) => {
        finishDelta = resolve;
      });
      const recordHeartbeat = vi.fn().mockResolvedValue(undefined);
      const readDelta = vi.fn().mockReturnValue(delta);
      const entry: SyncQueueEntryRecord = {
        ...queueEntry(),
        payloadManifest: { kind: "changes" }
      };
      const repository = {
        recordCrossIdentitySyncWorkerHeartbeat: recordHeartbeat,
        listDueSourceSyncHeartbeats: vi.fn().mockResolvedValue([]),
        markOverdueSyncRelationshipsStale: vi.fn().mockResolvedValue(0),
        cleanupCrossIdentitySyncState: vi.fn().mockResolvedValue({}),
        claimSyncQueueEntry: vi
          .fn()
          .mockImplementation(({ queue }) =>
            Promise.resolve(queue === "outbox" ? entry : null)
          ),
        renewSyncQueueLease: vi.fn().mockResolvedValue(true),
        readCapturedSessionSyncDelta: readDelta,
        completeSyncQueueEntry: vi.fn().mockResolvedValue(true),
        failSyncQueueEntry: vi.fn().mockResolvedValue(undefined)
      } as unknown as MemorySourceRepository;
      const service = createCrossIdentitySyncService({
        repository,
        recipientKeyEncryptionProvider: {} as EnvelopeEncryptionProvider,
        embeddingWorkflow: {} as EmbeddingWorkflow,
        koedHome: "/tmp/koed-sync-heartbeat-test",
        isSourceIdentityHealthy: () => true,
        staleAfterSeconds: 3_600,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      });

      const processing = service.processOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(readDelta).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(recordHeartbeat).toHaveBeenCalledTimes(2);
      finishDelta(null);
      await expect(processing).resolves.toEqual({
        outbox: true,
        inbox: false
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks missing-proof source work without claiming outbox and keeps inbox processing", async () => {
    const koedHome = mkdtempSync(join(tmpdir(), "koed-sync-missing-proof-"));
    temporaryHomes.push(koedHome);
    const inboxEntry: SyncQueueEntryRecord = {
      ...queueEntry(),
      uploadSessionId: "66666666-6666-4666-8666-666666666666"
    };
    const claimSyncQueueEntry = vi
      .fn()
      .mockImplementation(({ queue }: { queue: "outbox" | "inbox" }) => {
        if (queue === "outbox") throw new Error("outbox must not be claimed");
        return Promise.resolve(inboxEntry);
      });
    const failSyncQueueEntry = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn();
    const repository = {
      recordCrossIdentitySyncWorkerHeartbeat: vi
        .fn()
        .mockResolvedValue(undefined),
      markOverdueSyncRelationshipsStale: vi.fn().mockResolvedValue(0),
      cleanupCrossIdentitySyncState: vi.fn().mockResolvedValue({}),
      claimSyncQueueEntry,
      renewSyncQueueLease: vi.fn().mockResolvedValue(true),
      failSyncQueueEntry
    } as unknown as MemorySourceRepository;
    const service = createCrossIdentitySyncService({
      repository,
      recipientKeyEncryptionProvider: {} as EnvelopeEncryptionProvider,
      embeddingWorkflow: {} as EmbeddingWorkflow,
      koedHome,
      fetch: fetchFn,
      staleAfterSeconds: 3_600,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    await expect(service.processOnce()).resolves.toEqual({
      outbox: false,
      inbox: true
    });
    expect(claimSyncQueueEntry).toHaveBeenCalledWith({
      queue: "inbox",
      leaseMs: 300_000
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(failSyncQueueEntry).toHaveBeenCalledWith(
      expect.objectContaining({ queue: "inbox" })
    );
  });
});

describe("Cross-Identity Sync service failures", () => {
  it("fails permanent remote authorization errors without retrying or logging response content", async () => {
    const fixture = createFixture(403, {
      error: "secret remote tenant detail must remain redacted"
    });

    await expect(fixture.service.processOnce()).resolves.toEqual({
      outbox: true,
      inbox: false
    });
    expect(fixture.failSyncQueueEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: "outbox",
        id: fixture.entry.id,
        errorClass: "RemoteSyncAuthorizationError",
        terminal: true
      })
    );
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorClass: "RemoteSyncAuthorizationError",
        attempt: 1
      }),
      "Cross-Identity Sync outbox attempt failed"
    );
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain(
      "secret remote tenant detail"
    );
  });

  it("retries transient remote failures with bounded redacted state", async () => {
    const fixture = createFixture(503, { error: "upstream internals" });

    await fixture.service.processOnce();
    expect(fixture.failSyncQueueEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: "outbox",
        id: fixture.entry.id,
        errorClass: "RemoteSyncUnavailableError",
        terminal: false,
        retryAfterMs: expect.any(Number)
      })
    );
    const retryAfterMs = fixture.failSyncQueueEntry.mock.calls[0]?.[0]
      .retryAfterMs as number;
    expect(retryAfterMs).toBeGreaterThanOrEqual(1_500);
    expect(retryAfterMs).toBeLessThanOrEqual(2_500);
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain(
      "upstream internals"
    );
  });

  it("classifies a non-JSON gateway failure as transient", async () => {
    const fixture = createFixture(503, {});
    fixture.fetchFn.mockReset().mockResolvedValue(
      new Response("temporary proxy failure", {
        status: 502,
        headers: { "content-type": "text/html" }
      })
    );

    await fixture.service.processOnce();

    expect(fixture.failSyncQueueEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: "outbox",
        errorClass: "RemoteSyncUnavailableError",
        terminal: false
      })
    );
  });
});

const createProcessingHandshakeFixture = (input: {
  remoteState: string;
  remoteProcessingCursor: number;
  remotePackageSequence?: number;
  uploadState?: "created" | "completed";
}) => {
  const koedHome = mkdtempSync(join(tmpdir(), "koed-sync-handshake-"));
  temporaryHomes.push(koedHome);
  const backendId = "team-backend";
  const { reference } = storeUpstreamCredentialSecret(koedHome, {
    backendId,
    credentialKeyId: "credential-key",
    secret: "device-secret"
  });
  const entry = {
    ...queueEntry(),
    payloadManifest: { kind: "changes" }
  };
  const upload = {
    id: "66666666-6666-4666-8666-666666666666",
    syncRelationshipId: entry.syncRelationshipId,
    protocolPackageId: "77777777-7777-4777-8777-777777777777",
    state: input.uploadState ?? "completed",
    requestHash: "b".repeat(64),
    packageManifest: {
      recordCount: 1,
      summaryRevisionHash: null
    },
    packageChecksum: "c".repeat(64),
    sourceSequence: 1,
    fromCursor: 0,
    toCursor: 7,
    totalBytes: 100,
    expectedChunkCount: 1
  };
  const chunks = [
    {
      chunkIndex: 0,
      chunkChecksum: "d".repeat(64),
      byteCount: 100,
      encryptedPayload: { ciphertext: "not-read-on-resume" }
    }
  ];
  const markSourceSyncProcessing = vi.fn().mockResolvedValue(undefined);
  const deferSyncQueueEntry = vi.fn().mockResolvedValue(undefined);
  const acknowledgeSourceSyncPackage = vi.fn().mockResolvedValue(undefined);
  const completeSyncQueueEntry = vi.fn().mockResolvedValue(true);
  const markSourceSyncUploadCommitted = vi.fn().mockResolvedValue(undefined);
  const repository = {
    recordCrossIdentitySyncWorkerHeartbeat: vi
      .fn()
      .mockResolvedValue(undefined),
    listDueSourceSyncHeartbeats: vi.fn().mockResolvedValue([]),
    markOverdueSyncRelationshipsStale: vi.fn().mockResolvedValue(0),
    cleanupCrossIdentitySyncState: vi.fn().mockResolvedValue({
      chunksDeleted: 0,
      uploadsFailed: 0,
      queueEntriesDeleted: 0,
      uploadSessionsDeleted: 0
    }),
    claimSyncQueueEntry: vi
      .fn()
      .mockImplementation(({ queue }) =>
        Promise.resolve(queue === "outbox" ? entry : null)
      ),
    readCapturedSessionSyncDelta: vi.fn().mockResolvedValue({
      relationship: { packageSequence: 0 },
      changes: [{}]
    }),
    getSyncTransportContext: vi.fn().mockResolvedValue({
      relationship: { side: "source" },
      localDeploymentId: "local",
      localProtocolDeploymentId: "44444444-4444-4444-8444-444444444444",
      remoteProtocolDeploymentId: "55555555-5555-4555-8555-555555555555",
      remoteBaseUrl: "https://team.example.com",
      remoteUpstreamBackendId: backendId,
      remoteCredentialReference: reference,
      remoteSubjectId: "remote-user"
    }),
    getSyncPackageBySequence: vi.fn().mockResolvedValue({ upload, chunks }),
    renewSyncQueueLease: vi.fn().mockResolvedValue(true),
    markSourceSyncProcessing,
    deferSyncQueueEntry,
    acknowledgeSourceSyncPackage,
    markSourceSyncUploadCommitted,
    completeSyncQueueEntry,
    failSyncQueueEntry: vi.fn()
  } as unknown as MemorySourceRepository;
  const fetchFn = vi
    .fn()
    .mockImplementation((url: URL, request: RequestInit) => {
      const path = url.pathname;
      const body =
        request.method === "POST" && path.endsWith("/upload-sessions")
          ? { upload: { id: "88888888-8888-4888-8888-888888888888" } }
          : request.method === "GET" && path.includes("/upload-sessions/")
            ? {
                acceptedChunkIndexes: input.uploadState === "created" ? [] : [0]
              }
            : request.method === "POST" && path.endsWith("/complete")
              ? { upload: { state: "completed" } }
              : request.method === "GET" && path.includes("/relationships/")
                ? {
                    relationship: {
                      state: input.remoteState,
                      targetProcessingCursor: input.remoteProcessingCursor,
                      packageSequence: input.remotePackageSequence ?? 1
                    }
                  }
                : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    });
  const service = createCrossIdentitySyncService({
    repository,
    recipientKeyEncryptionProvider: {} as EnvelopeEncryptionProvider,
    embeddingWorkflow: {} as EmbeddingWorkflow,
    koedHome,
    isSourceIdentityHealthy: () => true,
    fetch: fetchFn,
    staleAfterSeconds: 3_600,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  });
  return {
    acknowledgeSourceSyncPackage,
    completeSyncQueueEntry,
    deferSyncQueueEntry,
    fetchFn,
    markSourceSyncProcessing,
    markSourceSyncUploadCommitted,
    service
  };
};

describe("Cross-Identity Sync processing handshake", () => {
  it("records a successful remote upload commit before polling processing", async () => {
    const fixture = createProcessingHandshakeFixture({
      remoteState: "partially_available",
      remoteProcessingCursor: 7,
      uploadState: "created"
    });

    await fixture.service.processOnce();

    expect(fixture.markSourceSyncUploadCommitted).toHaveBeenCalledWith({
      relationshipId: queueEntry().syncRelationshipId,
      packageId: "77777777-7777-4777-8777-777777777777"
    });
    expect(fixture.fetchFn).toHaveBeenCalledTimes(5);
    expect(
      fixture.fetchFn.mock.calls.map(([url, request]) => [
        (url as URL).pathname,
        (request as RequestInit).method
      ])
    ).toEqual([
      [
        `/v1/cross-identity-sync/relationships/${queueEntry().syncRelationshipId}/upload-sessions`,
        "POST"
      ],
      [
        "/v1/cross-identity-sync/upload-sessions/88888888-8888-4888-8888-888888888888",
        "GET"
      ],
      [
        "/v1/cross-identity-sync/upload-sessions/88888888-8888-4888-8888-888888888888/chunks/0",
        "PUT"
      ],
      [
        "/v1/cross-identity-sync/upload-sessions/88888888-8888-4888-8888-888888888888/complete",
        "POST"
      ],
      [
        `/v1/cross-identity-sync/relationships/${queueEntry().syncRelationshipId}`,
        "GET"
      ]
    ]);
  });

  it("does not acknowledge source progress while target processing is partial", async () => {
    const fixture = createProcessingHandshakeFixture({
      remoteState: "partially_available",
      remoteProcessingCursor: 7
    });

    await fixture.service.processOnce();

    expect(fixture.markSourceSyncProcessing).toHaveBeenCalledOnce();
    expect(fixture.deferSyncQueueEntry).toHaveBeenCalledOnce();
    expect(fixture.acknowledgeSourceSyncPackage).not.toHaveBeenCalled();
    expect(fixture.completeSyncQueueEntry).not.toHaveBeenCalled();
    expect(fixture.markSourceSyncUploadCommitted).not.toHaveBeenCalled();
    expect(fixture.fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fixture.fetchFn.mock.calls[0]?.[0])).toContain(
      "/relationships/"
    );
  });

  it("acknowledges source progress only after target readiness covers the cursor", async () => {
    const fixture = createProcessingHandshakeFixture({
      remoteState: "ready",
      remoteProcessingCursor: 7
    });

    await fixture.service.processOnce();

    expect(fixture.acknowledgeSourceSyncPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceCursor: 7,
        targetProcessingCursor: 7,
        packageSequence: 1,
        summaryRevisionHash: null
      })
    );
    expect(fixture.completeSyncQueueEntry).toHaveBeenCalledOnce();
    expect(fixture.deferSyncQueueEntry).not.toHaveBeenCalled();
  });

  it("does not acknowledge readiness from an older package sequence", async () => {
    const fixture = createProcessingHandshakeFixture({
      remoteState: "ready",
      remoteProcessingCursor: 7,
      remotePackageSequence: 0
    });

    await fixture.service.processOnce();

    expect(fixture.markSourceSyncProcessing).toHaveBeenCalledOnce();
    expect(fixture.deferSyncQueueEntry).toHaveBeenCalledOnce();
    expect(fixture.acknowledgeSourceSyncPackage).not.toHaveBeenCalled();
  });

  it("discards an interrupted source package and regenerates the same sequence", async () => {
    const koedHome = mkdtempSync(join(tmpdir(), "koed-sync-recovery-"));
    temporaryHomes.push(koedHome);
    const backendId = "team-backend";
    const { reference } = storeUpstreamCredentialSecret(koedHome, {
      backendId,
      credentialKeyId: "credential-key",
      secret: "device-secret"
    });
    const root = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );
    const recipient = await generateRecipientKeyMaterial(root, {
      keyId: "sync-recipient:recovery",
      keyVersion: 1
    });
    const relationshipId = queueEntry().syncRelationshipId;
    const entry: SyncQueueEntryRecord = {
      ...queueEntry(),
      payloadManifest: { kind: "changes" }
    };
    const incompleteUpload = {
      id: "66666666-6666-4666-8666-666666666666",
      syncRelationshipId: relationshipId,
      protocolPackageId: "77777777-7777-4777-8777-777777777777",
      state: "uploading",
      requestHash: "b".repeat(64),
      packageManifest: {},
      packageChecksum: "c".repeat(64),
      sourceSequence: 1,
      fromCursor: 0,
      toCursor: 1,
      totalBytes: 2,
      expectedChunkCount: 2
    };
    const deleteIncompleteSourceSyncPackage = vi.fn().mockResolvedValue(true);
    let persisted:
      | {
          upload: Record<string, unknown>;
          chunks: Record<string, unknown>[];
        }
      | undefined;
    const createSyncPackageUploadSession = vi
      .fn()
      .mockImplementation((_actor, input) => {
        persisted = {
          upload: {
            id: "88888888-8888-4888-8888-888888888888",
            ...input,
            state: "created"
          },
          chunks: []
        };
        return Promise.resolve(persisted.upload);
      });
    const recordSyncPackageChunk = vi
      .fn()
      .mockImplementation((_actor, input) => {
        persisted?.chunks.push({
          chunkIndex: input.chunkIndex,
          chunkChecksum: input.chunkChecksum,
          byteCount: input.byteCount,
          encryptedPayload: input.encryptedPayload
        });
        return Promise.resolve(input);
      });
    const repository = {
      recordCrossIdentitySyncWorkerHeartbeat: vi
        .fn()
        .mockResolvedValue(undefined),
      listDueSourceSyncHeartbeats: vi.fn().mockResolvedValue([]),
      markOverdueSyncRelationshipsStale: vi.fn().mockResolvedValue(0),
      cleanupCrossIdentitySyncState: vi.fn().mockResolvedValue({}),
      claimSyncQueueEntry: vi
        .fn()
        .mockImplementation(({ queue }) =>
          Promise.resolve(queue === "outbox" ? entry : null)
        ),
      renewSyncQueueLease: vi.fn().mockResolvedValue(true),
      readCapturedSessionSyncDelta: vi.fn().mockResolvedValue({
        relationship: {
          packageSequence: 0,
          logicalMemoryId: "99999999-9999-4999-8999-999999999999",
          localUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          localReplicaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          remoteReplicaId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          policyManifest: {
            sourceBoundary: "captured_session",
            recipientKey: recipient
          },
          consentManifest: { consented: true }
        },
        fromCursor: 0,
        session: {
          originSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          externalSessionId: "thread-recovery",
          sourceRuntime: "codex",
          captureMethod: "transcript",
          capturedAt: "2026-07-13T00:00:00.000Z",
          title: "Recovery test",
          sourceAdapterVersion: "1"
        },
        changes: [
          {
            cursor: 1,
            operation: "delete",
            originEventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            revisionHash: "e".repeat(64),
            event: null
          }
        ]
      }),
      getSyncTransportContext: vi.fn().mockResolvedValue({
        relationship: { side: "source" },
        localProtocolDeploymentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        remoteProtocolDeploymentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        remoteBaseUrl: "https://team.example.com",
        remoteUpstreamBackendId: backendId,
        remoteCredentialReference: reference,
        remoteSubjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      }),
      getSyncPackageBySequence: vi.fn().mockResolvedValue({
        upload: incompleteUpload,
        chunks: [
          {
            chunkIndex: 0,
            chunkChecksum: "f".repeat(64),
            byteCount: 1,
            encryptedPayload: {}
          }
        ]
      }),
      deleteIncompleteSourceSyncPackage,
      createSyncPackageUploadSession,
      recordSyncPackageChunk,
      getSyncPackageForService: vi
        .fn()
        .mockImplementation(() => Promise.resolve(persisted)),
      markSourceSyncUploadCommitted: vi.fn().mockResolvedValue(undefined),
      acknowledgeSourceSyncPackage: vi.fn().mockResolvedValue(undefined),
      completeSyncQueueEntry: vi.fn().mockResolvedValue(true),
      failSyncQueueEntry: vi.fn()
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn().mockImplementation((url: URL, request) => {
      const path = url.pathname;
      const body = path.endsWith("/upload-sessions")
        ? { upload: { id: "12121212-1212-4212-8212-121212121212" } }
        : request.method === "GET" && path.includes("/upload-sessions/")
          ? { acceptedChunkIndexes: [] }
          : path.endsWith("/complete")
            ? { upload: { state: "completed" } }
            : path.includes("/relationships/")
              ? {
                  relationship: {
                    state: "ready",
                    targetProcessingCursor: 1,
                    packageSequence: 1
                  }
                }
              : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    });
    const service = createCrossIdentitySyncService({
      repository,
      recipientKeyEncryptionProvider: root,
      embeddingWorkflow: {} as EmbeddingWorkflow,
      koedHome,
      isSourceIdentityHealthy: () => true,
      fetch: fetchFn,
      staleAfterSeconds: 3_600,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    await service.processOnce();

    expect(deleteIncompleteSourceSyncPackage).toHaveBeenCalledWith({
      relationshipId,
      uploadSessionId: incompleteUpload.id
    });
    expect(createSyncPackageUploadSession).toHaveBeenCalledWith(
      { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      expect.objectContaining({
        syncRelationshipId: relationshipId,
        sourceSequence: 1,
        fromCursor: 0,
        toCursor: 1,
        packageManifest: expect.objectContaining({
          summaryRevisionHash: null
        })
      })
    );
    expect(recordSyncPackageChunk).toHaveBeenCalledOnce();
  });
});

describe("Cross-Identity Sync summary transport", () => {
  it("encrypts and partitions a multi-record summary-only package without changing its digest", async () => {
    const koedHome = mkdtempSync(join(tmpdir(), "koed-sync-summary-source-"));
    temporaryHomes.push(koedHome);
    const root = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );
    const recipient = await generateRecipientKeyMaterial(root, {
      keyId: "sync-recipient:summary-source",
      keyVersion: 1
    });
    const backendId = "team-backend";
    const { reference } = storeUpstreamCredentialSecret(koedHome, {
      backendId,
      credentialKeyId: "credential-key",
      secret: "device-secret"
    });
    const relationshipId = queueEntry().syncRelationshipId;
    const sourceDeploymentId = "44444444-4444-4444-8444-444444444444";
    const targetDeploymentId = "55555555-5555-4555-8555-555555555555";
    const sourceReplicaId = "66666666-6666-4666-8666-666666666666";
    const targetReplicaId = "77777777-7777-4777-8777-777777777777";
    const consentManifest = { consented: true };
    const policyManifest = {
      sourceBoundary: "captured_session",
      recipientKey: recipient
    };
    const summaryNodes = [
      // The summary text is repeated in the structured summary, so this node
      // exercises a valid record that is larger than the former 512 KiB
      // plaintext chunk ceiling.
      summaryNodeFixture(1, "x".repeat(340_000)),
      summaryNodeFixture(2, "x".repeat(240_000))
    ];
    const entry: SyncQueueEntryRecord = {
      ...queueEntry(),
      payloadManifest: { kind: "changes" }
    };
    let persisted:
      | {
          upload: SyncPackageUploadSessionRecord;
          chunks: SyncPackageChunkRecord[];
        }
      | undefined;
    const requirePersistedPackage = (): {
      upload: SyncPackageUploadSessionRecord;
      chunks: SyncPackageChunkRecord[];
    } => {
      if (!persisted) {
        throw new Error("Expected the sync package to be persisted");
      }
      return persisted;
    };
    const createSyncPackageUploadSession = vi
      .fn()
      .mockImplementation((_actor, input) => {
        persisted = {
          upload: {
            id: "88888888-8888-4888-8888-888888888888",
            syncRelationshipId: input.syncRelationshipId,
            protocolPackageId: input.protocolPackageId,
            state: "created",
            packageFormatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
            requestHash: input.requestHash,
            packageManifest: input.packageManifest,
            packageChecksum: input.packageChecksum,
            sourceSequence: input.sourceSequence,
            fromCursor: input.fromCursor,
            toCursor: input.toCursor,
            totalBytes: input.totalBytes,
            uploadedBytes: 0,
            expectedChunkCount: input.expectedChunkCount,
            chunkCount: 0,
            verifiedChunkCount: 0
          },
          chunks: []
        };
        return Promise.resolve(persisted.upload);
      });
    const recordSyncPackageChunk = vi
      .fn()
      .mockImplementation((_actor, input) => {
        persisted?.chunks.push({
          id: `eeeeeeee-eeee-4eee-8eee-${String(input.chunkIndex).padStart(12, "0")}`,
          uploadSessionId: persisted.upload.id,
          chunkIndex: input.chunkIndex,
          chunkChecksum: input.chunkChecksum,
          byteCount: input.byteCount,
          encryptedPayload: input.encryptedPayload
        });
        return Promise.resolve(input);
      });
    const repository = {
      recordCrossIdentitySyncWorkerHeartbeat: vi
        .fn()
        .mockResolvedValue(undefined),
      listDueSourceSyncHeartbeats: vi.fn().mockResolvedValue([]),
      markOverdueSyncRelationshipsStale: vi.fn().mockResolvedValue(0),
      cleanupCrossIdentitySyncState: vi.fn().mockResolvedValue({}),
      claimSyncQueueEntry: vi
        .fn()
        .mockImplementation(({ queue }) =>
          Promise.resolve(queue === "outbox" ? entry : null)
        ),
      renewSyncQueueLease: vi.fn().mockResolvedValue(true),
      readCapturedSessionSyncDelta: vi.fn().mockResolvedValue({
        relationship: {
          packageSequence: 0,
          logicalMemoryId: "99999999-9999-4999-8999-999999999999",
          localUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          localReplicaId: sourceReplicaId,
          remoteReplicaId: targetReplicaId,
          policyManifest,
          consentManifest
        },
        fromCursor: 4,
        toCursor: 4,
        session: {
          originSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          externalSessionId: "thread-summary-only",
          sourceRuntime: "codex",
          captureMethod: "transcript",
          capturedAt: "2026-07-13T00:00:00.000Z",
          title: "Summary-only transport",
          sourceAdapterVersion: "1"
        },
        changes: [],
        summarySnapshotIncluded: true,
        summaryNodes
      }),
      getSyncTransportContext: vi.fn().mockResolvedValue({
        relationship: { side: "source" },
        localProtocolDeploymentId: sourceDeploymentId,
        remoteProtocolDeploymentId: targetDeploymentId,
        remoteBaseUrl: "https://team.example.com",
        remoteUpstreamBackendId: backendId,
        remoteCredentialReference: reference,
        remoteSubjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      }),
      getSyncPackageBySequence: vi.fn().mockResolvedValue(null),
      createSyncPackageUploadSession,
      recordSyncPackageChunk,
      getSyncPackageForService: vi
        .fn()
        .mockImplementation(() => Promise.resolve(persisted)),
      markSourceSyncUploadCommitted: vi.fn().mockResolvedValue(undefined),
      acknowledgeSourceSyncPackage: vi.fn().mockResolvedValue(undefined),
      completeSyncQueueEntry: vi.fn().mockResolvedValue(true),
      failSyncQueueEntry: vi.fn()
    } as unknown as MemorySourceRepository;
    const fetchFn = vi.fn().mockImplementation((url: URL, request) => {
      const path = url.pathname;
      const body = path.endsWith("/upload-sessions")
        ? { upload: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } }
        : request.method === "GET" && path.includes("/upload-sessions/")
          ? { acceptedChunkIndexes: [] }
          : path.endsWith("/complete")
            ? { upload: { state: "completed" } }
            : path.includes("/relationships/")
              ? {
                  relationship: {
                    state: "ready",
                    targetProcessingCursor: 4,
                    packageSequence: 1
                  }
                }
              : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    });
    const service = createCrossIdentitySyncService({
      repository,
      recipientKeyEncryptionProvider: root,
      embeddingWorkflow: {} as EmbeddingWorkflow,
      koedHome,
      fetch: fetchFn,
      isSourceIdentityHealthy: () => true,
      staleAfterSeconds: 3_600,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    await expect(service.processOnce()).resolves.toEqual({
      outbox: true,
      inbox: false
    });

    expect(persisted?.upload.fromCursor).toBe(4);
    expect(persisted?.upload.toCursor).toBe(4);
    expect(persisted?.upload.packageManifest.recordCount).toBe(
      summaryNodes.length
    );
    expect(persisted?.chunks.length).toBeGreaterThan(1);
    const privateProvider =
      await createRecipientPrivateKeyEnvelopeEncryptionProvider(
        root,
        recipient
      );
    const decryptedValues = await Promise.all(
      (persisted?.chunks ?? []).map((chunk) =>
        decryptEncryptedJsonPackage(privateProvider, chunk.encryptedPayload)
      )
    );
    expect(decryptedValues.every(isCapturedSessionSyncChunkV1)).toBe(true);
    const chunks = (decryptedValues as CapturedSessionSyncChunkV1[]).sort(
      (left, right) => left.chunkIndex - right.chunkIndex
    );
    expect(
      chunks.every(
        (chunk) =>
          Buffer.byteLength(JSON.stringify(chunk), "utf8") <=
          CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES
      )
    ).toBe(true);
    expect(
      (persisted?.chunks ?? []).every(
        (chunk) =>
          chunk.encryptedPayload.manifest.payload.byteCount <=
          CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES
      )
    ).toBe(true);
    const mergedSummaryNodes = chunks.flatMap(
      (chunk) => chunk.package.summaryNodes
    );
    const merged: CapturedSessionSyncPackageV1 = {
      ...chunks[0]!.package,
      changes: chunks.flatMap((chunk) => chunk.package.changes),
      summaryNodes: mergedSummaryNodes,
      summaryRevisionHash: crossIdentitySyncDigest(mergedSummaryNodes)
    };
    expect(merged.changes).toEqual([]);
    expect(merged.summaryNodes.map((node) => node.originNodeId)).toEqual(
      summaryNodes.map((node) => node.originNodeId)
    );
    expect(
      new Set(merged.summaryNodes.map((node) => node.originNodeId)).size
    ).toBe(summaryNodes.length);
    expect(crossIdentitySyncDigest(merged)).toBe(chunks[0]!.packageDigest);
    expect(crossIdentitySyncPackageRequestHash(merged)).toBe(
      persisted?.upload.requestHash
    );
    expect(persisted?.upload.packageManifest.summaryRevisionHash).toBe(
      merged.summaryRevisionHash
    );

    if (!persisted) throw new Error("Summary source package was not persisted");
    const targetEntry: SyncQueueEntryRecord = {
      ...queueEntry(),
      syncRelationshipId: relationshipId,
      uploadSessionId: persisted.upload.id,
      payloadManifest: { kind: "package" }
    };
    const applyCapturedSessionSyncPackage = vi.fn().mockResolvedValue({
      eventIds: [],
      invalidatedEventIds: [],
      summaryNodeIds: ["12121212-1212-4212-8212-121212121212"],
      invalidatedSummaryNodeIds: []
    });
    const embedSources = vi.fn().mockResolvedValue(undefined);
    const targetRepository = {
      recordCrossIdentitySyncWorkerHeartbeat: vi
        .fn()
        .mockResolvedValue(undefined),
      listDueSourceSyncHeartbeats: vi.fn().mockResolvedValue([]),
      markOverdueSyncRelationshipsStale: vi.fn().mockResolvedValue(0),
      cleanupCrossIdentitySyncState: vi.fn().mockResolvedValue({}),
      claimSyncQueueEntry: vi
        .fn()
        .mockImplementation(({ queue }) =>
          Promise.resolve(queue === "inbox" ? targetEntry : null)
        ),
      renewSyncQueueLease: vi.fn().mockResolvedValue(true),
      getSyncPackageForService: vi.fn().mockResolvedValue(persisted),
      getSyncTransportContext: vi.fn().mockResolvedValue({
        relationship: {
          side: "target",
          localUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          localReplicaId: targetReplicaId,
          remoteReplicaId: sourceReplicaId,
          policyManifest: { sourceBoundary: "captured_session" },
          consentManifest
        },
        localDeploymentId: "target-local-deployment",
        localProtocolDeploymentId: targetDeploymentId,
        remoteProtocolDeploymentId: sourceDeploymentId,
        remoteSubjectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      }),
      authorizeTargetSyncProcessing: vi.fn().mockResolvedValue(true),
      getSyncRecipientKey: vi.fn().mockResolvedValue(recipient),
      applyCapturedSessionSyncPackage,
      markTargetSyncReady: vi.fn().mockResolvedValue(undefined),
      advanceContinuousGrantRepresentations: vi
        .fn()
        .mockResolvedValue({ advanced: 1 }),
      completeSyncQueueEntry: vi.fn().mockResolvedValue(true),
      failSyncQueueEntry: vi.fn()
    } as unknown as MemorySourceRepository;
    const targetService = createCrossIdentitySyncService({
      repository: targetRepository,
      recipientKeyEncryptionProvider: root,
      embeddingWorkflow: { embedSources } as unknown as EmbeddingWorkflow,
      koedHome,
      staleAfterSeconds: 3_600,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    await expect(targetService.processOnce()).resolves.toEqual({
      outbox: false,
      inbox: true
    });
    expect(applyCapturedSessionSyncPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        package: expect.objectContaining({
          changes: [],
          summaryNodes
        })
      })
    );
    expect(
      targetRepository.advanceContinuousGrantRepresentations
    ).toHaveBeenCalledWith({
      remoteReplicaId: targetReplicaId,
      sourceRevision: persisted.upload.toCursor
    });
    expect(embedSources).toHaveBeenCalledWith(
      [
        {
          sourceType: "memory_node",
          sourceId: "12121212-1212-4212-8212-121212121212"
        }
      ],
      expect.objectContaining({ beforeBatch: expect.any(Function) })
    );

    summaryNodes.splice(0, summaryNodes.length);
    persisted = undefined;
    await expect(service.processOnce()).resolves.toEqual({
      outbox: true,
      inbox: false
    });
    const emptySnapshotPackage = requirePersistedPackage();
    expect(emptySnapshotPackage.upload.packageManifest).toMatchObject({
      recordCount: 0,
      summaryRevisionHash: crossIdentitySyncDigest([])
    });
    expect(emptySnapshotPackage.chunks).toHaveLength(1);
    const emptySnapshotChunk = await decryptEncryptedJsonPackage(
      privateProvider,
      emptySnapshotPackage.chunks[0]!.encryptedPayload
    );
    expect(isCapturedSessionSyncChunkV1(emptySnapshotChunk)).toBe(true);
    expect(emptySnapshotChunk).toMatchObject({
      package: {
        changes: [],
        summaryNodes: [],
        summaryRevisionHash: crossIdentitySyncDigest([])
      }
    });
  }, 30_000);

  it("rejects a validly encrypted package whose summary content was tampered", async () => {
    const relationshipId = queueEntry().syncRelationshipId;
    const packageId = "33333333-3333-4333-8333-333333333333";
    const sourceDeploymentId = "44444444-4444-4444-8444-444444444444";
    const targetDeploymentId = "55555555-5555-4555-8555-555555555555";
    const sourceReplicaId = "66666666-6666-4666-8666-666666666666";
    const targetReplicaId = "77777777-7777-4777-8777-777777777777";
    const policyManifest = { sourceBoundary: "captured_session" };
    const consentManifest = { consented: true };
    const summaryNodes = [summaryNodeFixture(9)];
    const syncPackage: CapturedSessionSyncPackageV1 = {
      format: CAPTURED_SESSION_SYNC_FORMAT,
      formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
      policyVersion: CAPTURED_SESSION_SYNC_POLICY_VERSION,
      packageId,
      relationshipId,
      logicalMemoryId: "88888888-8888-4888-8888-888888888888",
      sourceDeploymentId,
      sourceUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sourceReplicaId,
      targetDeploymentId,
      targetUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      targetReplicaId,
      packageSequence: 1,
      fromCursor: 5,
      toCursor: 5,
      createdAt: "2026-07-13T00:00:00.000Z",
      consentDigest: crossIdentitySyncDigest(consentManifest),
      policyDigest: crossIdentitySyncDigest(policyManifest),
      summaryRevisionHash: crossIdentitySyncDigest(summaryNodes),
      session: {
        originSessionId: "99999999-9999-4999-8999-999999999999",
        externalSessionId: null,
        sourceRuntime: "codex",
        captureMethod: "transcript",
        capturedAt: "2026-07-13T00:00:00.000Z",
        title: null,
        sourceAdapterVersion: null
      },
      changes: [],
      summaryNodes
    };
    const tamperedPackage = {
      ...syncPackage,
      summaryNodes: [
        { ...syncPackage.summaryNodes[0]!, summaryText: "Tampered in transit" }
      ]
    };
    const packageDigest = crossIdentitySyncDigest(syncPackage);
    const chunk: CapturedSessionSyncChunkV1 = {
      format: CAPTURED_SESSION_SYNC_FORMAT,
      formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
      packageId,
      relationshipId,
      packageSequence: 1,
      fromCursor: 5,
      toCursor: 5,
      chunkIndex: 0,
      chunkCount: 1,
      packageDigest,
      package: tamperedPackage
    };
    const root = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );
    const recipient = await generateRecipientKeyMaterial(root, {
      keyId: "sync-recipient:summary-target",
      keyVersion: 1
    });
    const encryptedPayload = await createEncryptedJsonPackage(
      createRecipientPublicKeyEnvelopeEncryptionProvider(recipient),
      {
        objectClass: "sync_package",
        payload: chunk,
        scope: {
          deploymentId: targetDeploymentId,
          tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        },
        provenance: { rowFamily: "sync_package", sourceId: packageId },
        aad: { relationshipId, packageId }
      }
    );
    const entry: SyncQueueEntryRecord = {
      ...queueEntry(),
      syncRelationshipId: relationshipId,
      uploadSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      payloadManifest: { kind: "package" }
    };
    const applyCapturedSessionSyncPackage = vi.fn();
    const failSyncQueueEntry = vi.fn().mockResolvedValue(true);
    const repository = {
      recordCrossIdentitySyncWorkerHeartbeat: vi
        .fn()
        .mockResolvedValue(undefined),
      listDueSourceSyncHeartbeats: vi.fn().mockResolvedValue([]),
      markOverdueSyncRelationshipsStale: vi.fn().mockResolvedValue(0),
      cleanupCrossIdentitySyncState: vi.fn().mockResolvedValue({}),
      claimSyncQueueEntry: vi
        .fn()
        .mockImplementation(({ queue }) =>
          Promise.resolve(queue === "inbox" ? entry : null)
        ),
      renewSyncQueueLease: vi.fn().mockResolvedValue(true),
      getSyncPackageForService: vi.fn().mockResolvedValue({
        upload: {
          id: entry.uploadSessionId,
          syncRelationshipId: relationshipId,
          protocolPackageId: packageId,
          state: "verified",
          requestHash: crossIdentitySyncPackageRequestHash(syncPackage),
          packageManifest: {
            packageDigest,
            recipientKeyId: recipient.keyId,
            recipientKeyVersion: recipient.keyVersion,
            recordCount: 1
          },
          packageChecksum: crossIdentitySyncDigest([encryptedPayload]),
          sourceSequence: 1,
          fromCursor: 5,
          toCursor: 5,
          totalBytes: 1,
          expectedChunkCount: 1
        },
        chunks: [
          {
            chunkIndex: 0,
            chunkChecksum: crossIdentitySyncDigest(encryptedPayload),
            byteCount: 1,
            encryptedPayload
          }
        ]
      }),
      getSyncTransportContext: vi.fn().mockResolvedValue({
        relationship: {
          side: "target",
          localUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          localReplicaId: targetReplicaId,
          remoteReplicaId: sourceReplicaId,
          policyManifest,
          consentManifest
        },
        localDeploymentId: "local-deployment",
        localProtocolDeploymentId: targetDeploymentId,
        remoteProtocolDeploymentId: sourceDeploymentId,
        remoteSubjectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      }),
      authorizeTargetSyncProcessing: vi.fn().mockResolvedValue(true),
      getSyncRecipientKey: vi.fn().mockResolvedValue(recipient),
      applyCapturedSessionSyncPackage,
      failSyncQueueEntry
    } as unknown as MemorySourceRepository;
    const koedHome = mkdtempSync(join(tmpdir(), "koed-sync-summary-target-"));
    temporaryHomes.push(koedHome);
    const service = createCrossIdentitySyncService({
      repository,
      recipientKeyEncryptionProvider: root,
      embeddingWorkflow: {} as EmbeddingWorkflow,
      koedHome,
      staleAfterSeconds: 3_600,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    await service.processOnce();

    expect(applyCapturedSessionSyncPackage).not.toHaveBeenCalled();
    expect(failSyncQueueEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: "inbox",
        errorClass: "InvalidSyncPackageError",
        terminal: true
      })
    );
  });
});

describe("Cross-Identity Sync freshness heartbeat", () => {
  it("delivers an acknowledged-cursor heartbeat without creating a package", async () => {
    const koedHome = mkdtempSync(join(tmpdir(), "koed-sync-heartbeat-"));
    temporaryHomes.push(koedHome);
    const backendId = "team-backend";
    const { reference } = storeUpstreamCredentialSecret(koedHome, {
      backendId,
      credentialKeyId: "credential-key",
      secret: "device-secret"
    });
    const entry: SyncQueueEntryRecord = {
      ...queueEntry(),
      idempotencyKey: "heartbeat:2026-07-13T00:00:00.000Z",
      payloadManifest: {
        kind: "heartbeat",
        sourceCursor: 7,
        targetProcessingCursor: 7,
        packageSequence: 2
      }
    };
    const refreshSourceSyncHeartbeat = vi.fn().mockResolvedValue(true);
    const completeSyncQueueEntry = vi.fn().mockResolvedValue(true);
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const repository = {
      recordCrossIdentitySyncWorkerHeartbeat: vi
        .fn()
        .mockResolvedValue(undefined),
      listDueSourceSyncHeartbeats: vi.fn().mockResolvedValue([]),
      markOverdueSyncRelationshipsStale: vi.fn().mockResolvedValue(0),
      cleanupCrossIdentitySyncState: vi.fn().mockResolvedValue({}),
      claimSyncQueueEntry: vi
        .fn()
        .mockImplementation(({ queue }) =>
          Promise.resolve(queue === "outbox" ? entry : null)
        ),
      renewSyncQueueLease: vi.fn().mockResolvedValue(true),
      getSyncTransportContext: vi.fn().mockResolvedValue({
        relationship: { side: "source" },
        remoteBaseUrl: "https://team.example.com/koed",
        remoteUpstreamBackendId: backendId,
        remoteCredentialReference: reference
      }),
      refreshSourceSyncHeartbeat,
      completeSyncQueueEntry,
      failSyncQueueEntry: vi.fn()
    } as unknown as MemorySourceRepository;
    const service = createCrossIdentitySyncService({
      repository,
      recipientKeyEncryptionProvider: {} as EnvelopeEncryptionProvider,
      embeddingWorkflow: {} as EmbeddingWorkflow,
      koedHome,
      isSourceIdentityHealthy: () => true,
      fetch: fetchFn,
      staleAfterSeconds: 3_600,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    await expect(service.processOnce()).resolves.toEqual({
      outbox: true,
      inbox: false
    });
    expect(fetchFn).toHaveBeenCalledWith(
      new URL(
        `https://team.example.com/koed/v1/cross-identity-sync/intake/relationships/${entry.syncRelationshipId}/heartbeat`
      ),
      expect.objectContaining({
        body: JSON.stringify({
          source_cursor: 7,
          target_processing_cursor: 7,
          package_sequence: 2
        })
      })
    );
    expect(refreshSourceSyncHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ relationshipId: entry.syncRelationshipId })
    );
    expect(completeSyncQueueEntry).toHaveBeenCalledOnce();
  });

  it("scans often enough for a short configured freshness window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const listDueSourceSyncHeartbeats = vi.fn().mockResolvedValue([]);
    const markOverdueSyncRelationshipsStale = vi.fn().mockResolvedValue(0);
    const koedHome = mkdtempSync(join(tmpdir(), "koed-sync-short-freshness-"));
    temporaryHomes.push(koedHome);
    const repository = {
      recordCrossIdentitySyncWorkerHeartbeat: vi
        .fn()
        .mockResolvedValue(undefined),
      listDueSourceSyncHeartbeats,
      markOverdueSyncRelationshipsStale,
      cleanupCrossIdentitySyncState: vi.fn().mockResolvedValue({}),
      claimSyncQueueEntry: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const service = createCrossIdentitySyncService({
      repository,
      recipientKeyEncryptionProvider: {} as EnvelopeEncryptionProvider,
      embeddingWorkflow: {} as EmbeddingWorkflow,
      koedHome,
      isSourceIdentityHealthy: () => true,
      staleAfterSeconds: 8,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    await service.processOnce();
    await vi.advanceTimersByTimeAsync(1_999);
    await service.processOnce();
    expect(listDueSourceSyncHeartbeats).toHaveBeenCalledOnce();
    expect(markOverdueSyncRelationshipsStale).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await service.processOnce();
    expect(listDueSourceSyncHeartbeats).toHaveBeenCalledTimes(2);
    expect(markOverdueSyncRelationshipsStale).toHaveBeenCalledTimes(2);
  });
});

describe("Cross-Identity Sync inbox binding", () => {
  it("rejects a valid encrypted package relabelled as a different upload", async () => {
    const relationshipId = "22222222-2222-4222-8222-222222222222";
    const packageId = "33333333-3333-4333-8333-333333333333";
    const uploadPackageId = "44444444-4444-4444-8444-444444444444";
    const sourceDeploymentId = "55555555-5555-4555-8555-555555555555";
    const targetDeploymentId = "66666666-6666-4666-8666-666666666666";
    const sourceReplicaId = "77777777-7777-4777-8777-777777777777";
    const targetReplicaId = "88888888-8888-4888-8888-888888888888";
    const policyManifest = {
      version: 1,
      sourceBoundary: "captured_session",
      transcriptIncluded: false,
      sourceVectorsAccepted: false
    };
    const consentManifest = {
      consented_at: "2026-07-13T00:00:00.000Z",
      policy_version: 1,
      source_boundary: "captured_session",
      selectedSessionId: "99999999-9999-4999-8999-999999999999"
    };
    const syncPackage: CapturedSessionSyncPackageV1 = {
      format: CAPTURED_SESSION_SYNC_FORMAT,
      formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
      policyVersion: CAPTURED_SESSION_SYNC_POLICY_VERSION,
      packageId,
      relationshipId,
      logicalMemoryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sourceDeploymentId,
      sourceUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sourceReplicaId,
      targetDeploymentId,
      targetUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      targetReplicaId,
      packageSequence: 1,
      fromCursor: 0,
      toCursor: 1,
      createdAt: "2026-07-13T00:00:00.000Z",
      consentDigest: crossIdentitySyncDigest(consentManifest),
      policyDigest: crossIdentitySyncDigest(policyManifest),
      summaryRevisionHash: crossIdentitySyncDigest([]),
      session: {
        originSessionId: consentManifest.selectedSessionId,
        externalSessionId: null,
        sourceRuntime: "codex",
        captureMethod: "transcript",
        capturedAt: "2026-07-13T00:00:00.000Z",
        title: null,
        sourceAdapterVersion: null
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
      summaryNodes: []
    };
    const packageDigest = crossIdentitySyncDigest(syncPackage);
    const chunk: CapturedSessionSyncChunkV1 = {
      format: CAPTURED_SESSION_SYNC_FORMAT,
      formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
      packageId,
      relationshipId,
      packageSequence: 1,
      fromCursor: 0,
      toCursor: 1,
      chunkIndex: 0,
      chunkCount: 1,
      packageDigest,
      package: syncPackage
    };
    const root = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );
    const material = await generateRecipientKeyMaterial(root, {
      keyId: "sync-recipient:test",
      keyVersion: 1
    });
    const encryptedPayload = await createEncryptedJsonPackage(
      createRecipientPublicKeyEnvelopeEncryptionProvider(material),
      {
        objectClass: "sync_package",
        payload: chunk,
        scope: {
          deploymentId: targetDeploymentId,
          tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        },
        provenance: { rowFamily: "sync_package", sourceId: packageId },
        aad: { relationshipId, packageId }
      }
    );
    const entry: SyncQueueEntryRecord = {
      ...queueEntry(),
      syncRelationshipId: relationshipId,
      uploadSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      payloadManifest: { kind: "package" }
    };
    const applyCapturedSessionSyncPackage = vi.fn();
    const failSyncQueueEntry = vi.fn().mockResolvedValue(true);
    const repository = {
      recordCrossIdentitySyncWorkerHeartbeat: vi
        .fn()
        .mockResolvedValue(undefined),
      listDueSourceSyncHeartbeats: vi.fn().mockResolvedValue([]),
      markOverdueSyncRelationshipsStale: vi.fn().mockResolvedValue(0),
      cleanupCrossIdentitySyncState: vi.fn().mockResolvedValue({
        chunksDeleted: 0,
        uploadsFailed: 0,
        queueEntriesDeleted: 0,
        uploadSessionsDeleted: 0
      }),
      claimSyncQueueEntry: vi
        .fn()
        .mockImplementation(({ queue }) =>
          Promise.resolve(queue === "inbox" ? entry : null)
        ),
      renewSyncQueueLease: vi.fn().mockResolvedValue(true),
      getSyncPackageForService: vi.fn().mockResolvedValue({
        upload: {
          id: entry.uploadSessionId,
          syncRelationshipId: relationshipId,
          protocolPackageId: uploadPackageId,
          state: "verified",
          requestHash: crossIdentitySyncPackageRequestHash(syncPackage),
          packageManifest: {
            packageDigest,
            recipientKeyId: material.keyId,
            recipientKeyVersion: material.keyVersion,
            recordCount: 1
          },
          packageChecksum: crossIdentitySyncDigest([encryptedPayload]),
          sourceSequence: 1,
          fromCursor: 0,
          toCursor: 1,
          totalBytes: 1,
          expectedChunkCount: 1
        },
        chunks: [
          {
            chunkIndex: 0,
            chunkChecksum: crossIdentitySyncDigest(encryptedPayload),
            byteCount: 1,
            encryptedPayload
          }
        ]
      }),
      getSyncTransportContext: vi.fn().mockResolvedValue({
        relationship: {
          side: "target",
          localUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          localReplicaId: targetReplicaId,
          remoteReplicaId: sourceReplicaId,
          policyManifest,
          consentManifest
        },
        localDeploymentId: "local-deployment",
        localProtocolDeploymentId: targetDeploymentId,
        remoteProtocolDeploymentId: sourceDeploymentId,
        remoteSubjectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      }),
      authorizeTargetSyncProcessing: vi.fn().mockResolvedValue(true),
      getSyncRecipientKey: vi.fn().mockResolvedValue(material),
      applyCapturedSessionSyncPackage,
      failSyncQueueEntry
    } as unknown as MemorySourceRepository;
    const koedHome = mkdtempSync(join(tmpdir(), "koed-sync-inbox-"));
    temporaryHomes.push(koedHome);
    const service = createCrossIdentitySyncService({
      repository,
      recipientKeyEncryptionProvider: root,
      embeddingWorkflow: {} as EmbeddingWorkflow,
      koedHome,
      staleAfterSeconds: 3_600,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    vi.mocked(repository.authorizeTargetSyncProcessing).mockResolvedValueOnce(
      false
    );
    await service.processOnce();
    expect(repository.getSyncRecipientKey).not.toHaveBeenCalled();
    expect(failSyncQueueEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: "inbox",
        errorClass: "SyncAuthorizationRevokedError",
        terminal: true
      })
    );

    failSyncQueueEntry.mockClear();
    await service.processOnce();

    expect(applyCapturedSessionSyncPackage).not.toHaveBeenCalled();
    expect(failSyncQueueEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: "inbox",
        errorClass: "InvalidSyncPackageError",
        terminal: true
      })
    );
  });
});

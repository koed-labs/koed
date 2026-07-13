import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemorySourceRepository, SyncQueueEntryRecord } from "@koed/db";
import {
  storeUpstreamCredentialSecret,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import type { EmbeddingWorkflow } from "./embedding-workflow.js";
import { createCrossIdentitySyncService } from "./cross-identity-sync-service.js";

const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
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
  leaseExpiresAt: null
});

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
    failSyncQueueEntry,
    completeSyncQueueEntry: vi.fn()
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
    rootEncryptionProvider: {} as EnvelopeEncryptionProvider,
    embeddingWorkflow: {} as EmbeddingWorkflow,
    koedHome,
    fetch: fetchFn,
    staleAfterSeconds: 3_600,
    logger
  });
  return { entry, failSyncQueueEntry, fetchFn, logger, service };
};

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
});

const createProcessingHandshakeFixture = (input: {
  remoteState: string;
  remoteProcessingCursor: number;
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
    state: "completed",
    requestHash: "b".repeat(64),
    packageManifest: { recordCount: 1 },
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
  const completeSyncQueueEntry = vi.fn().mockResolvedValue(undefined);
  const repository = {
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
    markSourceSyncProcessing,
    deferSyncQueueEntry,
    acknowledgeSourceSyncPackage,
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
            ? { acceptedChunkIndexes: [0] }
            : request.method === "POST" && path.endsWith("/complete")
              ? { upload: { state: "completed" } }
              : request.method === "GET" && path.includes("/relationships/")
                ? {
                    relationship: {
                      state: input.remoteState,
                      targetProcessingCursor: input.remoteProcessingCursor
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
    rootEncryptionProvider: {} as EnvelopeEncryptionProvider,
    embeddingWorkflow: {} as EmbeddingWorkflow,
    koedHome,
    fetch: fetchFn,
    staleAfterSeconds: 3_600,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  });
  return {
    acknowledgeSourceSyncPackage,
    completeSyncQueueEntry,
    deferSyncQueueEntry,
    markSourceSyncProcessing,
    service
  };
};

describe("Cross-Identity Sync processing handshake", () => {
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
  });

  it("acknowledges source progress only after target readiness covers the cursor", async () => {
    const fixture = createProcessingHandshakeFixture({
      remoteState: "ready",
      remoteProcessingCursor: 7
    });

    await fixture.service.processOnce();

    expect(fixture.acknowledgeSourceSyncPackage).toHaveBeenCalledWith(
      expect.objectContaining({ sourceCursor: 7, packageSequence: 1 })
    );
    expect(fixture.completeSyncQueueEntry).toHaveBeenCalledOnce();
    expect(fixture.deferSyncQueueEntry).not.toHaveBeenCalled();
  });
});

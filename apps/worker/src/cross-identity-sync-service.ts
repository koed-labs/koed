import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { scheduleCompaction } from "@koed/core";
import type { MemorySourceRepository } from "@koed/db";
import {
  CAPTURED_SESSION_SYNC_FORMAT,
  CAPTURED_SESSION_SYNC_FORMAT_VERSION,
  CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES,
  CAPTURED_SESSION_SYNC_MAX_PACKAGE_BYTES,
  CAPTURED_SESSION_SYNC_POLICY_VERSION,
  assertSecureHttpTransport,
  createEncryptedJsonPackage,
  createRecipientPrivateKeyEnvelopeEncryptionProvider,
  createRecipientPublicKeyEnvelopeEncryptionProvider,
  crossIdentitySyncDigest,
  crossIdentitySyncPackageRequestHash,
  decryptEncryptedJsonPackage,
  isCapturedSessionSyncChunkV1,
  readUpstreamCredentialAuthorization,
  type CapturedSessionSyncChangeV1,
  type CapturedSessionSyncChunkV1,
  type CapturedSessionSyncPackageV1,
  type EnvelopeEncryptionProvider,
  type RecipientPublicKeyMaterial
} from "@koed/shared";
import type { EmbeddingWorkflow } from "./embedding-workflow.js";

interface SyncLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

class InvalidSyncPackageError extends Error {
  transient = false;

  constructor(message: string) {
    super(message);
    this.name = "InvalidSyncPackageError";
  }
}

export interface CrossIdentitySyncService {
  start(): void;
  stop(): void;
  processOnce(): Promise<{ outbox: boolean; inbox: boolean }>;
}

const packagePartitions = (
  base: CapturedSessionSyncPackageV1,
  changes: CapturedSessionSyncChangeV1[]
): CapturedSessionSyncPackageV1[] => {
  const partitions: CapturedSessionSyncPackageV1[] = [];
  let current: CapturedSessionSyncChangeV1[] = [];
  for (const change of changes) {
    const candidate = [...current, change];
    const bytes = Buffer.byteLength(
      JSON.stringify({ ...base, changes: candidate }),
      "utf8"
    );
    if (bytes > CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES && current.length > 0) {
      partitions.push({ ...base, changes: current });
      current = [change];
    } else {
      if (bytes > CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES) {
        throw new Error("A synchronized Memory Event exceeds the chunk limit");
      }
      current = candidate;
    }
  }
  if (current.length > 0) partitions.push({ ...base, changes: current });
  return partitions;
};

const jsonRequest = async (
  fetchFn: typeof fetch,
  url: URL,
  authorization: string,
  method: "GET" | "POST" | "PUT",
  body?: unknown
): Promise<Record<string, unknown>> => {
  assertSecureHttpTransport(url, "Cross-Identity Sync target");
  const response = await fetchFn(url, {
    method,
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const error = new Error(`Remote sync HTTP ${response.status}`) as Error & {
      transient?: boolean;
      statusCode?: number;
    };
    error.statusCode = response.status;
    error.transient = response.status >= 500 || response.status === 429;
    error.name =
      response.status === 401 || response.status === 403
        ? "RemoteSyncAuthorizationError"
        : response.status === 409
          ? "RemoteSyncConflictError"
          : response.status === 429
            ? "RemoteSyncRateLimitError"
            : response.status >= 500
              ? "RemoteSyncUnavailableError"
              : "RemoteSyncRequestRejectedError";
    throw error;
  }
  return payload;
};

const errorClass = (error: unknown): string => {
  if (error instanceof Error && error.name) return error.name.slice(0, 120);
  return "UnknownSyncError";
};

const isTerminalSyncError = (error: unknown): boolean =>
  (typeof error === "object" &&
    error !== null &&
    "transient" in error &&
    error.transient === false) ||
  ["InvalidEncryptedPayloadEnvelopeError", "SyntaxError"].includes(
    errorClass(error)
  );

const retryDelayMs = (attempt: number): number => {
  const exponential = Math.min(300_000, 1_000 * 2 ** Math.min(attempt, 8));
  return Math.floor(exponential * (0.75 + Math.random() * 0.5));
};

export const createCrossIdentitySyncService = (options: {
  repository: MemorySourceRepository;
  rootEncryptionProvider: EnvelopeEncryptionProvider;
  embeddingWorkflow: EmbeddingWorkflow;
  koedHome: string;
  fetch?: typeof fetch;
  intervalMs?: number;
  staleAfterSeconds: number;
  logger: SyncLogger;
}): CrossIdentitySyncService => {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const intervalMs = Math.max(options.intervalMs ?? 1_000, 250);
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastCleanupAt = 0;
  let lastStaleCheckAt = 0;

  const sourceAuthorization = (input: {
    backendId: string | null;
    reference: string | null;
  }): string => {
    if (!input.backendId || !input.reference) {
      throw new Error("Sync upstream credential reference is missing");
    }
    const authorization = readUpstreamCredentialAuthorization(
      options.koedHome,
      input.reference
    );
    if (!authorization) {
      throw new Error("Sync upstream credential is unavailable");
    }
    return authorization;
  };

  const prepareSourcePackage = async (relationshipId: string) => {
    const delta = await options.repository.readCapturedSessionSyncDelta({
      relationshipId
    });
    if (!delta || delta.changes.length === 0) return null;
    const transport =
      await options.repository.getSyncTransportContext(relationshipId);
    if (!transport || !transport.remoteBaseUrl) {
      throw new Error("Sync target transport is unavailable");
    }
    const sequence = delta.relationship.packageSequence + 1;
    const existing = await options.repository.getSyncPackageBySequence({
      relationshipId,
      sourceSequence: sequence
    });
    if (existing) return { transport, ...existing };

    const recipient = delta.relationship.policyManifest.recipientKey as
      | RecipientPublicKeyMaterial
      | undefined;
    if (!recipient) throw new Error("Sync recipient key is unavailable");
    const provider =
      createRecipientPublicKeyEnvelopeEncryptionProvider(recipient);
    const packageId = randomUUID();
    const base: CapturedSessionSyncPackageV1 = {
      format: CAPTURED_SESSION_SYNC_FORMAT,
      formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
      policyVersion: CAPTURED_SESSION_SYNC_POLICY_VERSION,
      packageId,
      relationshipId,
      logicalMemoryId: delta.relationship.logicalMemoryId,
      sourceDeploymentId: transport.localProtocolDeploymentId,
      sourceUserId: delta.relationship.localUserId,
      sourceReplicaId: delta.relationship.localReplicaId,
      targetDeploymentId: transport.remoteProtocolDeploymentId,
      targetUserId: transport.remoteSubjectId,
      targetReplicaId: delta.relationship.remoteReplicaId!,
      packageSequence: sequence,
      fromCursor: delta.fromCursor,
      toCursor: delta.toCursor,
      createdAt: new Date().toISOString(),
      consentDigest: crossIdentitySyncDigest(
        delta.relationship.consentManifest
      ),
      policyDigest: crossIdentitySyncDigest(
        Object.fromEntries(
          Object.entries(delta.relationship.policyManifest).filter(
            ([key]) => key !== "recipientKey"
          )
        )
      ),
      session: delta.session,
      changes: delta.changes
    };
    const packageDigest = crossIdentitySyncDigest(base);
    const partitions = packagePartitions(base, delta.changes);
    const encrypted = await Promise.all(
      partitions.map(async (partition, chunkIndex) => {
        const chunk: CapturedSessionSyncChunkV1 = {
          format: CAPTURED_SESSION_SYNC_FORMAT,
          formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
          packageId,
          relationshipId,
          packageSequence: sequence,
          fromCursor: delta.fromCursor,
          toCursor: delta.toCursor,
          chunkIndex,
          chunkCount: partitions.length,
          packageDigest,
          package: partition
        };
        return createEncryptedJsonPackage(provider, {
          objectClass: "sync_package",
          payload: chunk,
          scope: {
            deploymentId: transport.remoteProtocolDeploymentId,
            tenantId: transport.remoteSubjectId
          },
          provenance: {
            rowFamily: "sync_package",
            sourceId: packageId
          },
          aad: {
            relationshipId,
            packageId,
            packageSequence: sequence,
            chunkIndex,
            chunkCount: partitions.length,
            sourceDeploymentId: transport.localProtocolDeploymentId,
            targetDeploymentId: transport.remoteProtocolDeploymentId
          },
          metadata: {
            formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
            chunkIndex,
            chunkCount: partitions.length
          }
        });
      })
    );
    const chunkRows = encrypted.map((encryptedPackage, chunkIndex) => ({
      encryptedPackage,
      chunkIndex,
      checksum: crossIdentitySyncDigest(encryptedPackage),
      byteCount: Buffer.byteLength(JSON.stringify(encryptedPackage), "utf8")
    }));
    const requestHash = crossIdentitySyncPackageRequestHash(base);
    const packageChecksum = crossIdentitySyncDigest(encrypted);
    const totalBytes = chunkRows.reduce(
      (sum, chunk) => sum + chunk.byteCount,
      0
    );
    if (totalBytes > CAPTURED_SESSION_SYNC_MAX_PACKAGE_BYTES) {
      throw new Error("Cross-Identity Sync package exceeds the size limit");
    }
    const actor = { userId: delta.relationship.localUserId };
    const upload = await options.repository.createSyncPackageUploadSession(
      actor,
      {
        syncRelationshipId: relationshipId,
        protocolPackageId: packageId,
        idempotencyKey: `package:${sequence}`,
        requestHash,
        packageManifest: {
          objectClass: "sync_package",
          format: CAPTURED_SESSION_SYNC_FORMAT,
          formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
          packageDigest,
          recipientKeyId: recipient.keyId,
          recipientKeyVersion: recipient.keyVersion,
          recordCount: base.changes.length
        },
        packageChecksum,
        totalBytes,
        expectedChunkCount: chunkRows.length,
        sourceSequence: sequence,
        fromCursor: delta.fromCursor,
        toCursor: delta.toCursor
      }
    );
    if (!upload) throw new Error("Source sync upload could not be persisted");
    for (const chunk of chunkRows) {
      await options.repository.recordSyncPackageChunk(actor, {
        uploadSessionId: upload.id,
        chunkIndex: chunk.chunkIndex,
        chunkChecksum: chunk.checksum,
        byteCount: chunk.byteCount,
        encryptedPayload: chunk.encryptedPackage
      });
    }
    const persisted = await options.repository.getSyncPackageForService(
      upload.id
    );
    if (!persisted) throw new Error("Source sync upload was not persisted");
    return { transport, ...persisted };
  };

  const processOutbox = async (): Promise<boolean> => {
    const entry = await options.repository.claimSyncQueueEntry({
      queue: "outbox",
      leaseMs: 120_000
    });
    if (!entry) return false;
    try {
      if (entry.payloadManifest.kind === "revocation") {
        const transport = await options.repository.getSyncTransportContext(
          entry.syncRelationshipId
        );
        if (!transport) throw new Error("Sync transport context is missing");
        const authorization = sourceAuthorization({
          backendId: transport.remoteUpstreamBackendId,
          reference: transport.remoteCredentialReference
        });
        await jsonRequest(
          fetchFn,
          new URL(
            `/v1/cross-identity-sync/intake/relationships/${entry.syncRelationshipId}/revoke`,
            `${transport.remoteBaseUrl}/`
          ),
          authorization,
          "POST",
          {
            revocation_id: String(entry.payloadManifest.revocationId),
            revocation_sequence: Number(
              entry.payloadManifest.revocationSequence
            )
          }
        );
        await options.repository.completeSyncQueueEntry({
          queue: "outbox",
          id: entry.id
        });
        return true;
      }
      const prepared = await prepareSourcePackage(entry.syncRelationshipId);
      if (!prepared) {
        await options.repository.completeSyncQueueEntry({
          queue: "outbox",
          id: entry.id
        });
        return true;
      }
      const { transport, upload, chunks } = prepared;
      const authorization = sourceAuthorization({
        backendId: transport.remoteUpstreamBackendId,
        reference: transport.remoteCredentialReference
      });
      const baseUrl = `${transport.remoteBaseUrl}/`;
      const remoteCreate = await jsonRequest(
        fetchFn,
        new URL(
          `/v1/cross-identity-sync/relationships/${upload.syncRelationshipId}/upload-sessions`,
          baseUrl
        ),
        authorization,
        "POST",
        {
          protocol_package_id: upload.protocolPackageId,
          idempotency_key: `package:${upload.sourceSequence}`,
          request_hash: upload.requestHash,
          package_manifest: upload.packageManifest,
          package_checksum: upload.packageChecksum,
          total_bytes: upload.totalBytes,
          expected_chunk_count: upload.expectedChunkCount,
          source_sequence: upload.sourceSequence,
          from_cursor: upload.fromCursor,
          to_cursor: upload.toCursor
        }
      );
      const remoteUpload = remoteCreate.upload as { id?: unknown } | undefined;
      const remoteUploadId =
        typeof remoteUpload?.id === "string" ? remoteUpload.id : "";
      if (!remoteUploadId) throw new Error("Remote upload id is missing");
      const remoteStatus = await jsonRequest(
        fetchFn,
        new URL(
          `/v1/cross-identity-sync/upload-sessions/${remoteUploadId}`,
          baseUrl
        ),
        authorization,
        "GET"
      );
      const accepted = new Set(
        Array.isArray(remoteStatus.acceptedChunkIndexes)
          ? remoteStatus.acceptedChunkIndexes.map(Number)
          : []
      );
      for (const chunk of chunks) {
        if (accepted.has(chunk.chunkIndex)) continue;
        await jsonRequest(
          fetchFn,
          new URL(
            `/v1/cross-identity-sync/upload-sessions/${remoteUploadId}/chunks/${chunk.chunkIndex}`,
            baseUrl
          ),
          authorization,
          "PUT",
          {
            checksum_sha256: chunk.chunkChecksum,
            byte_count: chunk.byteCount,
            encrypted_package: chunk.encryptedPayload
          }
        );
      }
      const remoteCommit = await jsonRequest(
        fetchFn,
        new URL(
          `/v1/cross-identity-sync/upload-sessions/${remoteUploadId}/complete`,
          baseUrl
        ),
        authorization,
        "POST",
        {}
      );
      const remoteUploadStateValue = (
        remoteCommit.upload as { state?: unknown } | undefined
      )?.state;
      const remoteUploadState =
        typeof remoteUploadStateValue === "string"
          ? remoteUploadStateValue
          : "";
      if (!["verified", "completed"].includes(remoteUploadState)) {
        const error = new Error(
          "Remote sync upload state is invalid"
        ) as Error & { transient: boolean };
        error.name = "RemoteSyncStateError";
        error.transient = false;
        throw error;
      }
      const remoteRelationship = await jsonRequest(
        fetchFn,
        new URL(
          `/v1/cross-identity-sync/relationships/${upload.syncRelationshipId}`,
          baseUrl
        ),
        authorization,
        "GET"
      );
      const relationshipPayload = remoteRelationship.relationship as
        | { state?: unknown; targetProcessingCursor?: unknown }
        | undefined;
      const remoteState =
        typeof relationshipPayload?.state === "string"
          ? relationshipPayload.state
          : "";
      const remoteProcessingCursor = Number(
        relationshipPayload?.targetProcessingCursor
      );
      if (["failed", "revoked", "purge_pending"].includes(remoteState)) {
        const error = new Error(
          "Remote sync processing did not complete"
        ) as Error & { transient: boolean };
        error.name = "RemoteSyncProcessingFailedError";
        error.transient = false;
        throw error;
      }
      const targetProcessingComplete =
        ["ready", "stale"].includes(remoteState) &&
        Number.isSafeInteger(remoteProcessingCursor) &&
        remoteProcessingCursor >= upload.toCursor;
      if (!targetProcessingComplete) {
        if (
          ![
            "pending",
            "uploading",
            "uploaded",
            "verified",
            "processing",
            "partially_available",
            "ready",
            "stale"
          ].includes(remoteState)
        ) {
          const error = new Error(
            "Remote sync processing state is invalid"
          ) as Error & { transient: boolean };
          error.name = "RemoteSyncStateError";
          error.transient = false;
          throw error;
        }
        await options.repository.markSourceSyncProcessing({
          relationshipId: upload.syncRelationshipId,
          packageId: upload.protocolPackageId
        });
        await options.repository.deferSyncQueueEntry({
          queue: "outbox",
          id: entry.id,
          delayMs: 2_000
        });
        return true;
      }
      await options.repository.acknowledgeSourceSyncPackage({
        relationshipId: upload.syncRelationshipId,
        packageId: upload.protocolPackageId,
        sourceCursor: upload.toCursor,
        packageSequence: upload.sourceSequence,
        staleAfterSeconds: options.staleAfterSeconds
      });
      await options.repository.completeSyncQueueEntry({
        queue: "outbox",
        id: entry.id
      });
      return true;
    } catch (error) {
      await options.repository.failSyncQueueEntry({
        queue: "outbox",
        id: entry.id,
        errorClass: errorClass(error),
        retryAfterMs: retryDelayMs(entry.attemptCount),
        terminal: isTerminalSyncError(error)
      });
      options.logger.warn(
        {
          event: { name: "sync.outbox.failed", category: "sync" },
          errorClass: errorClass(error),
          attempt: entry.attemptCount
        },
        "Cross-Identity Sync outbox attempt failed"
      );
      return true;
    }
  };

  const processInbox = async (): Promise<boolean> => {
    const entry = await options.repository.claimSyncQueueEntry({
      queue: "inbox",
      leaseMs: 300_000
    });
    if (!entry) return false;
    try {
      if (!entry.uploadSessionId)
        throw new Error("Sync inbox upload is missing");
      const persisted = await options.repository.getSyncPackageForService(
        entry.uploadSessionId
      );
      if (!persisted) throw new Error("Sync inbox package is missing");
      const transport = await options.repository.getSyncTransportContext(
        entry.syncRelationshipId
      );
      if (!transport || transport.relationship.side !== "target") {
        throw new Error("Target sync relationship is missing");
      }
      const recipientKeyId =
        typeof persisted.upload.packageManifest.recipientKeyId === "string"
          ? persisted.upload.packageManifest.recipientKeyId
          : "";
      const recipientKeyVersion = Number(
        persisted.upload.packageManifest.recipientKeyVersion
      );
      const material = await options.repository.getSyncRecipientKey(
        transport.localDeploymentId,
        recipientKeyId,
        recipientKeyVersion
      );
      if (!material)
        throw new Error("Sync recipient private key is unavailable");
      const provider =
        await createRecipientPrivateKeyEnvelopeEncryptionProvider(
          options.rootEncryptionProvider,
          material
        );
      const decrypted: CapturedSessionSyncChunkV1[] = [];
      for (const chunk of persisted.chunks) {
        if (
          crossIdentitySyncDigest(chunk.encryptedPayload) !==
          chunk.chunkChecksum
        ) {
          throw new InvalidSyncPackageError("Sync chunk checksum mismatch");
        }
        const value = await decryptEncryptedJsonPackage(
          provider,
          chunk.encryptedPayload
        );
        if (!isCapturedSessionSyncChunkV1(value)) {
          throw new InvalidSyncPackageError("Unsupported sync chunk payload");
        }
        decrypted.push(value);
      }
      decrypted.sort((left, right) => left.chunkIndex - right.chunkIndex);
      const first = decrypted[0];
      if (
        !first ||
        decrypted.length !== first.chunkCount ||
        decrypted.some(
          (chunk, index) =>
            chunk.chunkIndex !== index ||
            chunk.packageId !== first.packageId ||
            chunk.relationshipId !== first.relationshipId ||
            chunk.packageDigest !== first.packageDigest
        )
      ) {
        throw new InvalidSyncPackageError(
          "Sync chunk set is incomplete or inconsistent"
        );
      }
      const merged: CapturedSessionSyncPackageV1 = {
        ...first.package,
        changes: decrypted.flatMap((chunk) => chunk.package.changes)
      };
      const manifestRecordCount = persisted.upload.packageManifest.recordCount;
      if (
        !Number.isSafeInteger(manifestRecordCount) ||
        manifestRecordCount !== merged.changes.length ||
        crossIdentitySyncDigest(merged) !== first.packageDigest ||
        crossIdentitySyncPackageRequestHash(merged) !==
          persisted.upload.requestHash ||
        merged.policyDigest !==
          crossIdentitySyncDigest(transport.relationship.policyManifest) ||
        merged.consentDigest !==
          crossIdentitySyncDigest(transport.relationship.consentManifest) ||
        merged.targetDeploymentId !== transport.localProtocolDeploymentId ||
        merged.targetUserId !== transport.relationship.localUserId ||
        merged.targetReplicaId !== transport.relationship.localReplicaId ||
        merged.sourceDeploymentId !== transport.remoteProtocolDeploymentId ||
        merged.sourceUserId !== transport.remoteSubjectId ||
        merged.sourceReplicaId !== transport.relationship.remoteReplicaId
      ) {
        throw new InvalidSyncPackageError(
          "Sync package identity binding failed"
        );
      }
      const applied = await options.repository.applyCapturedSessionSyncPackage({
        relationshipId: entry.syncRelationshipId,
        uploadSessionId: entry.uploadSessionId,
        package: merged
      });
      for (const eventId of applied.eventIds) {
        await options.embeddingWorkflow.embedSource("memory_event", eventId);
      }
      if (
        applied.eventIds.length > 0 ||
        applied.invalidatedEventIds.length > 0
      ) {
        const compaction = await scheduleCompaction({
          repository: options.repository,
          requesterContext: { userId: transport.relationship.localUserId },
          visibility: "personal"
        });
        const nodeIds = [
          ...compaction.leafNodeIds,
          ...(compaction.rollupNodeId ? [compaction.rollupNodeId] : [])
        ];
        for (const nodeId of nodeIds) {
          await options.embeddingWorkflow.embedSource("memory_node", nodeId);
        }
      }
      await options.repository.markTargetSyncReady({
        relationshipId: entry.syncRelationshipId,
        sourceCursor: merged.toCursor,
        packageId: merged.packageId,
        staleAfterSeconds: options.staleAfterSeconds
      });
      await options.repository.completeSyncQueueEntry({
        queue: "inbox",
        id: entry.id
      });
      return true;
    } catch (error) {
      await options.repository.failSyncQueueEntry({
        queue: "inbox",
        id: entry.id,
        errorClass: errorClass(error),
        retryAfterMs: retryDelayMs(entry.attemptCount),
        terminal: isTerminalSyncError(error)
      });
      options.logger.warn(
        {
          event: { name: "sync.inbox.failed", category: "sync" },
          errorClass: errorClass(error),
          attempt: entry.attemptCount
        },
        "Cross-Identity Sync inbox attempt failed"
      );
      return true;
    }
  };

  const processOnce = async () => {
    if (Date.now() - lastStaleCheckAt >= 60_000) {
      await options.repository.markOverdueSyncRelationshipsStale();
      lastStaleCheckAt = Date.now();
    }
    if (Date.now() - lastCleanupAt >= 60 * 60 * 1_000) {
      await options.repository.cleanupCrossIdentitySyncState();
      lastCleanupAt = Date.now();
    }
    return {
      outbox: await processOutbox(),
      inbox: await processInbox()
    };
  };
  const schedule = () => {
    if (!running) return;
    timer = setTimeout(() => {
      void (async () => {
        try {
          const progress = await processOnce();
          if (progress.outbox || progress.inbox) await delay(0);
        } catch (error) {
          options.logger.error(
            {
              event: { name: "sync.service.failed", category: "sync" },
              errorClass: errorClass(error)
            },
            "Cross-Identity Sync service iteration failed"
          );
        } finally {
          schedule();
        }
      })();
    }, intervalMs);
    timer.unref?.();
  };

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    processOnce
  };
};

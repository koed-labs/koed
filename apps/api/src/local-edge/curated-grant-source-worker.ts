import type pg from "pg";
import { z } from "zod";
import {
  claimCuratedGrantSourceWork,
  curatedSharedSourceCommitment,
  enqueueDueCuratedGrantExpiryWork,
  finishCuratedGrantSourceWork,
  loadPersonalCuratedSharedSourceMaterial,
  type CuratedGrantSourceWork
} from "@koed/db";
import {
  crossIdentitySyncDeterministicUuid,
  curatedSourceCommitmentHash,
  fetchBoundedJsonObject,
  pendingShareSchema,
  readLocalEdgeUpstreamRegistry,
  signCuratedSourceUpdate,
  upstreamBackendById,
  type EnvelopeEncryptionProvider,
  type LocalEdgeUpstreamBackend
} from "@koed/shared";
import { remoteOwnedShareGrantSchema } from "./collaboration-shared-memory-control.js";
import { safeUpstreamProxyUrl } from "./upstream-routing.js";
import type { CollaborationSharedMemoryAuthorityStore } from "./collaboration-shared-memory-control.js";
import type { ConversationSourceSignerFactory } from "../memory/conversation-source-journal-routes.js";

const RESPONSE_LIMIT = 64 * 1_024;
const TIMEOUT_MS = 30_000;

const pendingStatusSchema = z.object({
  share: z.object({
    kind: z.literal("pending"),
    pendingShare: pendingShareSchema
  })
});
const grantPageSchema = z.object({
  // The owner grant index includes grants originating from a Pending Share;
  // /owned-shares/grant/:id intentionally omits those duplicate entries.
  shareGrants: z.array(remoteOwnedShareGrantSchema).max(20),
  pagination: z.object({
    hasMore: z.boolean(),
    nextOffset: z.number().int().safe().positive().nullable()
  })
});

const nextExpiry = (
  values: readonly { expiresAt: string | null }[]
): string | null =>
  values
    .flatMap((value) => (value.expiresAt ? [value.expiresAt] : []))
    .filter((value) => Date.parse(value) > Date.now())
    .sort()[0] ?? null;

export const createCuratedGrantSourceWorker = (options: {
  pool: pg.Pool;
  encryptionProvider: EnvelopeEncryptionProvider;
  authorityStore: CollaborationSharedMemoryAuthorityStore;
  koedHome: string;
  upstreamBackendsPath: string;
  fetch: typeof fetch;
  resolveUpstreamAuthorization(
    backend: LocalEdgeUpstreamBackend
  ): string | null;
  resolveVerifiedDeploymentId(): string | null;
  sourceSignerFactory: ConversationSourceSignerFactory;
  reportFailure(input: {
    workId: string;
    backendId: string;
    statusCode: number | null;
    errorClass: string;
  }): void;
}) => {
  const backendFor = (backendId: string) => {
    const backend = upstreamBackendById(
      readLocalEdgeUpstreamRegistry(options.upstreamBackendsPath),
      backendId
    );
    const authorization = backend
      ? options.resolveUpstreamAuthorization(backend)
      : null;
    if (
      !backend ||
      !authorization ||
      !/^Koed-Device\s+[^\s:]+:[^\s]+$/.test(authorization) ||
      /[\r\n]/.test(authorization)
    ) {
      throw new Error("Curated Team source authorization is unavailable");
    }
    return { backend, authorization };
  };

  const getTeam = async (
    backend: LocalEdgeUpstreamBackend,
    authorization: string,
    path: string
  ): Promise<Record<string, unknown>> => {
    const { response, payload } = await fetchBoundedJsonObject(
      options.fetch,
      safeUpstreamProxyUrl(backend, path),
      {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json", authorization }
      },
      { timeoutMs: TIMEOUT_MS, maxBytes: RESPONSE_LIMIT }
    );
    if (!response.ok) {
      throw Object.assign(new Error("Current Team grant status unavailable"), {
        statusCode: response.status
      });
    }
    return payload;
  };

  const getCurrentGrant = async (
    backend: LocalEdgeUpstreamBackend,
    authorization: string,
    logicalMemoryId: string,
    grantId: string
  ): Promise<z.infer<typeof remoteOwnedShareGrantSchema> | null> => {
    let offset = 0;
    while (offset <= 10_000) {
      const page = grantPageSchema.parse(
        await getTeam(
          backend,
          authorization,
          `/v1/shared-memory/logical-memories/${logicalMemoryId}/share-grants?limit=20&offset=${offset}`
        )
      );
      const grant = page.shareGrants.find((entry) => entry.id === grantId);
      if (grant) return grant;
      if (
        !page.pagination.hasMore ||
        page.pagination.nextOffset === null ||
        page.pagination.nextOffset <= offset
      )
        return null;
      offset = page.pagination.nextOffset;
    }
    return null;
  };

  const process = async (
    work: CuratedGrantSourceWork
  ): Promise<{ nextExpiryAt: string | null }> => {
    const deploymentId = options.resolveVerifiedDeploymentId();
    if (
      !deploymentId ||
      deploymentId !== work.sourceDeploymentProtocolId ||
      work.sourceOwnerPrincipalId !== work.localOwnerUserId
    ) {
      throw new Error("Curated Personal source identity changed");
    }
    const { backend, authorization } = backendFor(work.backendId);
    const pending = pendingStatusSchema.parse(
      await getTeam(
        backend,
        authorization,
        `/v1/shared-memory/owned-shares/pending/${work.originalPendingShareId}`
      )
    ).share.pendingShare;
    if (pending.state === "revoked") return { nextExpiryAt: null };
    if (
      pending.id !== work.originalPendingShareId ||
      pending.state !== "activated" ||
      pending.sourceUpdateState !== "active" ||
      !pending.grantId ||
      pending.mode !== "continuous" ||
      pending.includeCuratedMemory !== true ||
      pending.consentId !== work.consentId ||
      pending.logicalMemoryId !== work.logicalMemoryId ||
      pending.teamId !== work.teamId ||
      pending.workspaceId !== work.teamWorkspaceId ||
      pending.source.kind !== "captured_session" ||
      pending.source.sessionId !== work.localSessionId
    ) {
      throw new Error("Continuous Curated Team authority is not active");
    }
    const grant = await getCurrentGrant(
      backend,
      authorization,
      work.logicalMemoryId,
      pending.grantId
    );
    if (!grant) throw new Error("Current Team grant status unavailable");
    if (grant.lifecycle === "revoked" || grant.frozenAt) {
      return { nextExpiryAt: null };
    }
    if (
      grant.lifecycle !== "active" ||
      grant.id !== pending.grantId ||
      grant.mode !== "continuous" ||
      grant.includeCuratedMemory !== true ||
      grant.consentId !== work.consentId ||
      grant.logicalMemoryId !== work.logicalMemoryId ||
      grant.teamId !== work.teamId ||
      grant.teamWorkspaceId !== work.teamWorkspaceId
    ) {
      throw new Error("Current Curated Team grant is unavailable");
    }
    // The retained work receipt was registered only after the signed initial
    // upload matched its reviewed preview. That preview can expire while the
    // continuous Team grant remains active; current Team status above governs
    // each subsequent update.
    const cursorResult = await options.pool.query<{ source_cursor: string }>(
      `select coalesce(max(change.cursor),0)::text as source_cursor
         from sessions session
         left join sync_semantic_changes change on change.session_id=session.id
        where session.id=$1 and session.owner_user_id=$2`,
      [work.localSessionId, work.localOwnerUserId]
    );
    const sourceRevision = Number(cursorResult.rows[0]?.source_cursor);
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision <= 0) {
      throw new Error("Current Curated source frontier is unavailable");
    }
    const source = await loadPersonalCuratedSharedSourceMaterial(
      options.pool,
      options.encryptionProvider,
      {
        ownerUserId: work.localOwnerUserId,
        logicalMemoryId: work.logicalMemoryId,
        sourceSessionId: work.localSessionId,
        sourceRevision,
        teamBackendId: work.backendId,
        teamWorkspaceId: work.teamWorkspaceId,
        requirePersistedRevision: false
      }
    );
    const commitment = curatedSharedSourceCommitment(source, {
      sourceDeploymentProtocolId: deploymentId,
      teamId: work.teamId
    });
    const commitmentHash = curatedSourceCommitmentHash(commitment);
    const signer = options.sourceSignerFactory({
      koedHome: options.koedHome,
      sourceGenerationId: deploymentId,
      originKeyId: work.sourceOwnerPrincipalId
    });
    if (
      signer.deploymentId !== deploymentId ||
      signer.keyId !== work.sourceOwnerPrincipalId
    ) {
      throw new Error("Curated source signer identity changed");
    }
    const signed = signCuratedSourceUpdate(
      {
        protocol: "koed.curated-source-update/v1",
        originalPendingShareId: work.originalPendingShareId,
        grantId: grant.id,
        consentId: work.consentId,
        previewHash: work.previewHash,
        generation: work.generation,
        commitmentHash,
        commitment
      },
      signer
    );
    const { response, payload } = await fetchBoundedJsonObject(
      options.fetch,
      safeUpstreamProxyUrl(
        backend,
        `/v1/shared-memory/pending-shares/${work.originalPendingShareId}/curated-source/updates`
      ),
      {
        method: "PUT",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization,
          "content-type": "application/json",
          "idempotency-key": crossIdentitySyncDeterministicUuid(
            `curated-source-update:${work.originalPendingShareId}:${work.generation}`
          )
        },
        body: JSON.stringify(signed)
      },
      { timeoutMs: TIMEOUT_MS, maxBytes: RESPONSE_LIMIT }
    );
    if (
      !response.ok ||
      payload.pendingShareId !== work.originalPendingShareId ||
      payload.grantId !== grant.id ||
      payload.generation !== work.generation ||
      payload.commitmentHash !== commitmentHash ||
      payload.materialHash !== signed.attestation.updateHash ||
      payload.sourceRevision !== sourceRevision ||
      payload.status !== (commitment.items.length ? "ready" : "empty")
    ) {
      throw Object.assign(new Error("Curated update was not acknowledged"), {
        statusCode: response.status
      });
    }
    return { nextExpiryAt: nextExpiry(source.provenance) };
  };

  return {
    async drainOnce(): Promise<number> {
      await enqueueDueCuratedGrantExpiryWork(options.pool);
      const work = await claimCuratedGrantSourceWork(options.pool);
      for (const item of work) {
        try {
          const delivered = await process(item);
          await finishCuratedGrantSourceWork(options.pool, {
            workId: item.workId,
            leaseToken: item.leaseToken,
            generation: item.generation,
            outcome: "delivered",
            nextExpiryAt: delivered.nextExpiryAt
          });
        } catch (error) {
          options.reportFailure({
            workId: item.workId,
            backendId: item.backendId,
            statusCode:
              typeof error === "object" &&
              error !== null &&
              "statusCode" in error &&
              typeof error.statusCode === "number"
                ? error.statusCode
                : null,
            errorClass: error instanceof Error ? error.name : "UnknownError"
          });
          await finishCuratedGrantSourceWork(options.pool, {
            workId: item.workId,
            leaseToken: item.leaseToken,
            generation: item.generation,
            outcome: "retry"
          });
        }
      }
      return work.length;
    }
  };
};

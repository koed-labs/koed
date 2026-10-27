import { createHash } from "node:crypto";
import type pg from "pg";
import { SharedMemoryConflictError } from "@koed/shared";
import {
  freezeSharedMemorySemanticRecallBoundaryWithClient,
  createSharedMemoryAuthorityReadContext,
  readSharedMemoryGrantAuthorityWithClient,
  SharedMemoryAuthorizationError,
  type SharedMemorySemanticAuthorizationBoundary,
  type SharedMemoryAuthorityReadContext
} from "./shared-memory-repository.js";
import type { ActorContext } from "./types.js";

type Client = Pick<pg.PoolClient, "query">;

export interface MemoryAnswerTeamAuthority {
  version: 1;
  ownerUserId: string;
  recallBoundary: SharedMemorySemanticAuthorizationBoundary;
  grantFingerprints: Array<{ grantId: string; fingerprint: string }>;
}

export class MemoryAnswerTeamAuthorityError extends SharedMemoryAuthorizationError {
  constructor() {
    super("Memory Answer Team authority is no longer valid");
    this.name = "MemoryAnswerTeamAuthorityError";
  }
}

const representations = [
  "memory_events",
  "lcm_leaves",
  "lcm_rollups",
  "curated_assertions"
] as const;

const boundariesEqual = (
  a: SharedMemorySemanticAuthorizationBoundary,
  b: SharedMemorySemanticAuthorizationBoundary
) =>
  a.teamId === b.teamId &&
  a.teamVersion === b.teamVersion &&
  a.teamWorkspaceId === b.teamWorkspaceId &&
  a.workspaceVersion === b.workspaceVersion &&
  a.membershipVersion === b.membershipVersion &&
  a.workspaceAccessVersion === b.workspaceAccessVersion &&
  a.userRowVersion === b.userRowVersion &&
  a.shareGrantIds.length === b.shareGrantIds.length &&
  a.shareGrantIds.every((id, i) => id === b.shareGrantIds[i]);

const validBoundary = (boundary: SharedMemorySemanticAuthorizationBoundary) => {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return (
    uuid.test(boundary.teamId) &&
    uuid.test(boundary.teamWorkspaceId) &&
    [
      boundary.teamVersion,
      boundary.workspaceVersion,
      boundary.membershipVersion,
      boundary.workspaceAccessVersion
    ].every((value) => Number.isSafeInteger(value) && value > 0) &&
    typeof boundary.userRowVersion === "string" &&
    /^\d+$/.test(boundary.userRowVersion) &&
    Array.isArray(boundary.shareGrantIds) &&
    boundary.shareGrantIds.length <= 128 &&
    boundary.shareGrantIds.every(
      (id) => typeof id === "string" && uuid.test(id)
    ) &&
    new Set(boundary.shareGrantIds).size === boundary.shareGrantIds.length
  );
};

const grantFingerprint = async (
  client: Client,
  actor: ActorContext,
  grantId: string,
  readContext: SharedMemoryAuthorityReadContext
) => {
  const bindings = [];
  for (const representation of representations) {
    const authorized = await readSharedMemoryGrantAuthorityWithClient(
      client,
      actor,
      { shareGrantId: grantId, representation },
      true,
      readContext
    );
    if (!authorized) continue;
    const { row, grant, representation: record } = authorized;
    bindings.push({
      representation,
      repositorySnapshot: row.repository_snapshot,
      grantVersion: grant.grantVersion,
      consentId: grant.consentId,
      sourceRevisionHash: record.sourceRevisionHash,
      provenanceHash: record.provenanceHash,
      fidelityPolicyRevision: record.fidelityPolicyRevision,
      contentPolicyVersion: record.contentPolicyVersion,
      classifierVersion: record.classifierVersion,
      privacyClassifierGenerationId: record.privacyClassifierGenerationId,
      privacyClassifierHash: record.privacyClassifierHash,
      effectivePrivacyPolicyHash: record.effectivePrivacyPolicyHash,
      consentSourceHash: row.consent_source_hash,
      consentFidelityPolicyHash: row.consent_fidelity_policy_hash,
      consentContentPolicyHash: row.consent_content_policy_hash,
      consentClassifierHash: row.consent_classifier_hash,
      consentSourceContentHash: row.consent_source_content_hash
    });
  }
  if (!bindings.length) throw new MemoryAnswerTeamAuthorityError();
  return createHash("sha256").update(JSON.stringify(bindings)).digest("hex");
};

const normalizeDenial = (error: unknown): never => {
  if (
    error instanceof SharedMemoryAuthorizationError ||
    error instanceof SharedMemoryConflictError
  ) {
    throw new MemoryAnswerTeamAuthorityError();
  }
  throw error;
};

// Callers must keep this transaction open through payload use or terminal writes.
export const freezeMemoryAnswerTeamAuthorityWithClient = async (
  client: Client,
  actor: ActorContext,
  input: { teamWorkspaceId: string }
): Promise<MemoryAnswerTeamAuthority> => {
  try {
    const recallBoundary =
      await freezeSharedMemorySemanticRecallBoundaryWithClient(client, actor, {
        ...input,
        maximumGrantCount: 128,
        lockRows: true
      });
    const grantFingerprints = [];
    const readContext = createSharedMemoryAuthorityReadContext();
    for (const grantId of recallBoundary.shareGrantIds) {
      grantFingerprints.push({
        grantId,
        fingerprint: await grantFingerprint(client, actor, grantId, readContext)
      });
    }
    const lockedBoundary =
      await freezeSharedMemorySemanticRecallBoundaryWithClient(client, actor, {
        ...input,
        maximumGrantCount: 128,
        lockRows: true,
        onlyGrantIds: recallBoundary.shareGrantIds
      });
    if (!boundariesEqual(lockedBoundary, recallBoundary))
      throw new MemoryAnswerTeamAuthorityError();
    return {
      version: 1,
      ownerUserId: actor.userId,
      recallBoundary,
      grantFingerprints
    };
  } catch (error) {
    return normalizeDenial(error);
  }
};

// Authority is server-persisted state, never an authorization claim from input.
export const assertMemoryAnswerTeamAuthorityWithClient = async (
  client: Client,
  actor: ActorContext,
  authority: MemoryAnswerTeamAuthority
): Promise<void> => {
  if (
    !authority ||
    authority.version !== 1 ||
    authority.ownerUserId !== actor.userId ||
    !authority.recallBoundary ||
    (actor.teamBoundaryId !== undefined &&
      authority.recallBoundary.teamId !== actor.teamBoundaryId) ||
    !validBoundary(authority.recallBoundary) ||
    !Array.isArray(authority.grantFingerprints) ||
    authority.grantFingerprints.length > 128 ||
    authority.grantFingerprints.length !==
      authority.recallBoundary.shareGrantIds.length ||
    authority.grantFingerprints.some(
      (entry, i) =>
        !entry ||
        entry.grantId !== authority.recallBoundary.shareGrantIds[i] ||
        !/^[a-f0-9]{64}$/.test(entry.fingerprint)
    )
  ) {
    throw new MemoryAnswerTeamAuthorityError();
  }
  try {
    const current = await freezeSharedMemorySemanticRecallBoundaryWithClient(
      client,
      actor,
      {
        teamWorkspaceId: authority.recallBoundary.teamWorkspaceId,
        maximumGrantCount: 128,
        lockRows: true,
        onlyGrantIds: authority.recallBoundary.shareGrantIds
      }
    );
    if (!boundariesEqual(current, authority.recallBoundary)) {
      throw new MemoryAnswerTeamAuthorityError();
    }
    const readContext = createSharedMemoryAuthorityReadContext();
    for (const entry of authority.grantFingerprints) {
      if (
        (await grantFingerprint(client, actor, entry.grantId, readContext)) !==
        entry.fingerprint
      ) {
        throw new MemoryAnswerTeamAuthorityError();
      }
    }
    const lockedBoundary =
      await freezeSharedMemorySemanticRecallBoundaryWithClient(client, actor, {
        teamWorkspaceId: authority.recallBoundary.teamWorkspaceId,
        maximumGrantCount: 128,
        lockRows: true,
        onlyGrantIds: authority.recallBoundary.shareGrantIds
      });
    if (!boundariesEqual(lockedBoundary, authority.recallBoundary))
      throw new MemoryAnswerTeamAuthorityError();
  } catch (error) {
    normalizeDenial(error);
  }
};

export const getMemoryAnswerTeamRecallBoundary = (
  authority: MemoryAnswerTeamAuthority
) => authority.recallBoundary;
export const getRecallBoundary = getMemoryAnswerTeamRecallBoundary;

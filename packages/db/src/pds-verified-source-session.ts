import type pg from "pg";
import type {
  RepositoryAssignment,
  PersonalSourceContextSnapshot
} from "@koed/shared";
import {
  personalOwnerIdSchema,
  personalSourceReferenceSchema,
  createRepositoryAssignment,
  PdsConfigurationCompatibilityError,
  decodePdsPersonalSourceContextSnapshot
} from "@koed/shared";
import {
  createCapturedSessionRepository,
  type CapturedSessionRepository
} from "./captured-session-repository.js";
import { lockPersonalSourceContextOwner } from "./personal-source-binding-state.js";
import { resolveVerifiedPdsNativeSource } from "./personal-source-native-identity.js";
import { retainVerifiedPersonalSourceBinding } from "./personal-source-binding-receipt.js";

export type PdsVerifiedSourceSessionInput = {
  userId: string;
  groupId: string;
  retainedPackageId: string;
  sourceLogicalSessionId: string;
  sourceContext?: unknown;
  /** Closed bodies apply context only in their final conflict-checked transaction. */
  deferSourceContextProjection?: boolean;
  session: Omit<
    Parameters<CapturedSessionRepository["createCapturedSession"]>[1],
    "logicalSessionId" | "idempotencyKey" | "sourceHash"
  > & { externalSessionId: string };
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const sourceAssignment = (
  snapshot: PersonalSourceContextSnapshot
): RepositoryAssignment => {
  const git = snapshot.context.git,
    automatic = git.original.state === "known" ? git.original.value : null;
  const fact =
    git.correction.state === "corrected" ? git.correction.value : null;
  const override =
    fact?.state === "known"
      ? fact.value
      : fact
        ? {
            kind: "unresolved" as const,
            key: null,
            root: null,
            branch: null,
            reason: "selection_missing" as const,
            checkoutId: null,
            originatingDeviceId: snapshot.context.source.originatingDeviceId,
            selectedRemote: null,
            anchorDisplay: null
          }
        : null;
  return createRepositoryAssignment({
    state: automatic ? "recorded" : "historical_unresolved",
    version: git.revision,
    automatic,
    override
  });
};

/** The secure runtime supplies decrypted source metadata only after origin verification and retention. */
export const createPdsVerifiedSourceSessionRepository = (pool: pg.Pool) => ({
  async createVerifiedPdsSourceSession(
    raw: PdsVerifiedSourceSessionInput
  ): Promise<{ id: string; logicalSessionId: string }> {
    const input = {
      ...raw,
      userId: personalOwnerIdSchema.parse(raw.userId),
      retainedPackageId: personalOwnerIdSchema.parse(raw.retainedPackageId)
    };
    const client = await pool.connect();
    try {
      await client.query("begin");
      await lockPersonalSourceContextOwner(client, input.userId);
      const result = await client.query<{
        group_id: string;
        origin_deployment_id: string;
        origin_device_id: string;
        source_logical_session_id: string | null;
        source_fingerprint: string;
        source_sequence: string;
      }>(
        `select p.group_id,p.origin_deployment_id,p.origin_device_id,p.source_logical_session_id,p.source_fingerprint,p.source_sequence from pds_retained_packages p
        join personal_device_groups g on g.id=p.group_id join local_personal_identities i on i.id=g.local_personal_identity_id
        join users u on u.id=i.owner_user_id and u.disabled_at is null and u.deleted_at is null
        where p.id=$1 and p.owner_user_id=$2 and i.owner_user_id=$2 and g.group_id=$3 and g.state='active' and p.state<>'revoked'
        and not exists(select 1 from pds_deletion_floors f where f.group_id=p.group_id and f.logical_memory_id=p.logical_memory_id and f.deletion_floor_token=p.deletion_floor_token)
        for share of p,g,i,u`,
        [input.retainedPackageId, input.userId, input.groupId]
      );
      const proof = result.rows[0];
      if (
        !proof ||
        !proof.source_fingerprint ||
        proof.source_logical_session_id !== input.sourceLogicalSessionId
      )
        throw new TypeError("PdsCryptoSourceSessionAuthorityError");
      personalSourceReferenceSchema.parse({
        ownerUserId: input.userId,
        originatingDeploymentId: proof.origin_deployment_id,
        originatingDeviceId: proof.origin_device_id,
        logicalSessionId: input.sourceLogicalSessionId
      });
      const identity = await resolveVerifiedPdsNativeSource(client, {
        ownerUserId: input.userId,
        groupDbId: proof.group_id,
        originDeploymentId: proof.origin_deployment_id,
        originDeviceId: proof.origin_device_id,
        sourceLogicalSessionId: input.sourceLogicalSessionId,
        sourceFingerprint: proof.source_fingerprint,
        externalSessionId: input.session.externalSessionId
      });
      const following = await client.query<{ context_version: number }>(
        "select context_version from personal_source_bindings where owner_user_id=$1 and originating_deployment_id=$2 and originating_device_id=$3 and source_logical_session_id=$4",
        [
          input.userId,
          proof.origin_deployment_id,
          proof.origin_device_id,
          input.sourceLogicalSessionId
        ]
      );
      if (
        !input.sourceContext &&
        following.rows[0]?.context_version !== 1 &&
        [
          input.session.replicatedRepositoryAssignment?.automatic,
          input.session.replicatedRepositoryAssignment?.override
        ].some((value) => value?.kind === "local_project")
      )
        throw new PdsConfigurationCompatibilityError("source_context_v1", [
          proof.origin_device_id
        ]);
      let id = identity.existingSessionId;
      if (!id) {
        const snapshot = input.sourceContext
          ? decodePdsPersonalSourceContextSnapshot(input.sourceContext)
          : null;
        const metadata = input.session.metadata ?? {};
        const source = await createCapturedSessionRepository(pool, {
          transactionClient: client,
          verifiedSourceIdentityOnly: true
        }).createCapturedSession(
          { userId: input.userId },
          {
            ...input.session,
            logicalSessionId: identity.logicalSessionId,
            idempotencyKey: `pds-verified-session:${input.groupId}:${identity.logicalSessionId}`,
            sourceHash: `pds:${identity.logicalSessionId}:${proof.source_fingerprint}`,
            ...(snapshot
              ? { replicatedRepositoryAssignment: sourceAssignment(snapshot) }
              : {}),
            importObservedAt:
              input.session.importObservedAt ?? new Date().toISOString(),
            metadata: {
              ...metadata,
              pds: {
                ...record(metadata.pds),
                groupId: input.groupId,
                originDeploymentId: proof.origin_deployment_id,
                originDeviceId: proof.origin_device_id,
                sourceLogicalSessionId: input.sourceLogicalSessionId,
                sourceNativeBindingVersion: 1,
                sourceFingerprint: proof.source_fingerprint,
                sourceSequence: proof.source_sequence
              }
            }
          }
        );
        id = source.id;
      }
      await client.query(
        `insert into personal_source_bindings(owner_user_id,originating_deployment_id,originating_device_id,source_logical_session_id,local_session_id,local_logical_session_id,retained_package_id)
        values($1,$2,$3,$4,$5,$6,$7) on conflict(owner_user_id,originating_deployment_id,originating_device_id,source_logical_session_id) do update set local_session_id=excluded.local_session_id,local_logical_session_id=excluded.local_logical_session_id,retained_package_id=excluded.retained_package_id,updated_at=now()
        where personal_source_bindings.local_session_id is null and personal_source_bindings.local_logical_session_id is null and personal_source_bindings.availability='pending'`,
        [
          input.userId,
          proof.origin_deployment_id,
          proof.origin_device_id,
          input.sourceLogicalSessionId,
          id,
          identity.logicalSessionId,
          input.retainedPackageId
        ]
      );
      if (input.sourceContext && !input.deferSourceContextProjection)
        await retainVerifiedPersonalSourceBinding(client, {
          ownerUserId: input.userId,
          groupId: input.groupId,
          retainedPackageId: input.retainedPackageId,
          localSessionId: id,
          sourceLogicalSessionId: input.sourceLogicalSessionId,
          sourceContext: input.sourceContext
        });
      await client.query("commit");
      return { id, logicalSessionId: identity.logicalSessionId };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
});

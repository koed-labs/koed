import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { readConsumerCursor } from "./personal-selection-consumer-state.js";
import {
  resolveNativeSharingSource,
  resolveNativeConversationSharingSource,
  resolvePublisherTakeoverSource,
  resolveSharingSelectionTarget,
  readPublisherTakeoverSourceBindings,
  resolveReplicaSharingSource
} from "./selection-sharing-source-availability.js";
import {
  canonicalJsonStringify,
  sharingRulePublisherTakeoverLocalIntentSchema,
  repositorySharingRuleMemberInventorySchema,
  sharingRuleSourceIdentityHash,
  sharingRulePublisherTakeoverAppliedScopeSchema,
  transferredSelectionSharingScopeSchema,
  crossIdentitySyncDigest,
  decryptEnvelopeToUtf8,
  personalSelectionConsumerPageSchema,
  selectionSharingProgressSchema,
  selectionSharingSourceStateSchema,
  selectionSharingGoalSchema,
  selectionSharingAttemptSchema,
  sharingRuleDetailAppliedScopeSchema,
  sharingRuleContentPolicyAppliedScopeSchema,
  type SharingRuleContentPolicyAppliedScope,
  type SharingRuleDetailAppliedScope,
  type SelectionSharingProgress,
  type SelectionSharingIdentity,
  type SelectionSharingGoal,
  type SelectionSharingSourceState,
  type SelectionSharingAttempt,
  type EnvelopeEncryptionProvider,
  type EncryptedPayloadEnvelope
} from "@koed/shared";

const progressTable = "collaboration_sharing_selection_progress";
const pagesTable = "collaboration_sharing_selection_pages";
const sourcesTable = "collaboration_sharing_selection_sources";
type Row = Record<string, unknown>;
const conflict = () =>
  Object.assign(
    new Error("Selection sharing progress changed; reload its current lease"),
    { code: "selection_progress_conflict" }
  );
const digestText = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const selectionSharingSourceKey = (
  source: SelectionSharingGoal["source"]
) =>
  crossIdentitySyncDigest({
    localSessionId: source.localSessionId,
    localLogicalSessionId: source.localLogicalSessionId
  });
export const selectionSharingGoalHash = (goal: SelectionSharingGoal) =>
  crossIdentitySyncDigest({
    source: goal.source,
    desired: goal.desired,
    contextHash: goal.contextHash
  });
const aad = (
  identity: SelectionSharingIdentity,
  table: string,
  id: string,
  progressId: string
) => ({ ...identity, table, id, progressId });
const encode = async (
  provider: EnvelopeEncryptionProvider,
  identity: SelectionSharingIdentity,
  table: string,
  id: string,
  value: unknown,
  progressId = id
) => {
  const plaintext = canonicalJsonStringify(value);
  return {
    hash: digestText(plaintext),
    envelope: await provider.encrypt({
      plaintext,
      scope: {
        deploymentId: identity.backendId,
        tenantId: identity.localOwnerUserId,
        objectClass: "selection_sharing_progress"
      },
      provenance: {
        rowFamily: "selection_sharing_progress",
        sourceTable: table,
        sourceColumn: "protected_dto",
        sourceId: id
      },
      ciphertextLocation: table,
      aad: aad(identity, table, id, progressId)
    })
  };
};
const decode = async <T>(
  provider: EnvelopeEncryptionProvider,
  identity: SelectionSharingIdentity,
  table: string,
  row: Row,
  parse: (value: unknown) => T
): Promise<T> => {
  const envelope = row.protected_dto as EncryptedPayloadEnvelope;
  if (
    !envelope ||
    envelope.provenance?.sourceTable !== table ||
    envelope.provenance.sourceId !== row.id ||
    envelope.provenance.sourceColumn !== "protected_dto" ||
    Object.entries(
      aad(
        identity,
        table,
        String(row.id),
        table === progressTable ? String(row.id) : String(row.progress_id)
      )
    ).some(([key, value]) => envelope.aad?.[key] !== value)
  )
    throw conflict();
  const plaintext = await decryptEnvelopeToUtf8(provider, envelope);
  if (digestText(plaintext) !== row.protected_dto_hash) throw conflict();
  return parse(JSON.parse(plaintext));
};
const transaction = async <T>(
  pool: pg.Pool,
  run: (client: pg.PoolClient) => Promise<T>
) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await run(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};
const identityFor = (row: Row): SelectionSharingIdentity => ({
  backendId: String(row.backend_id),
  localOwnerUserId: String(row.local_owner_user_id),
  upstreamUserId: String(row.upstream_user_id)
});
const rootSelect = `select progress.*,enrollment.backend_id,enrollment.local_owner_user_id,enrollment.upstream_user_id,enrollment.remote_device_id
  from collaboration_sharing_selection_progress progress join collaboration_shared_memory_enrollments enrollment
    on enrollment.id=progress.enrollment_id and enrollment.revoked_at is null
  join users owner on owner.id=enrollment.local_owner_user_id and owner.disabled_at is null and owner.deleted_at is null`;
export interface SelectionSharingProgressLease {
  progressId: string;
  leaseVersion: number;
  identity: SelectionSharingIdentity;
  remoteDeviceId: string;
  data: SelectionSharingProgress;
}
export interface SelectionSharingSourceLease {
  deliveryEpoch: number;
  progressId: string;
  sourceId: string;
  leaseVersion: number;
  identity: SelectionSharingIdentity;
  remoteDeviceId: string;
  progress: SelectionSharingProgress;
  goal: SelectionSharingGoal;
  goalHash: string;
  data: SelectionSharingSourceState;
}
const effectiveHash = (parent: string, source = "source") =>
  `case when ${source}.proposed_generation=${parent}.current_generation then ${source}.proposed_goal_hash else ${source}.current_goal_hash end`;
const dirtySources = (
  parent: string
) => `exists(select 1 from collaboration_sharing_selection_sources source
  where source.progress_id=${parent}.id and source.available_at<=now() and (source.locked_at is null or source.locked_at<now()-interval '5 minutes')
    and (source.attempt_mutation_id is not null or source.done_goal_hash is distinct from ${effectiveHash(parent)} or source.done_delivery_epoch is distinct from ${parent}.delivery_epoch)
    and (source.attempt_mutation_id is not null or ${effectiveHash(parent)} is not null))`;
const lockEnrollments = async (
  client: pg.PoolClient,
  ownerUserId: string,
  limit: number,
  sources: boolean
) => {
  const rows = await client.query<{ id: string }>(
    `select enrollment.id from collaboration_shared_memory_enrollments enrollment
    where enrollment.revoked_at is null and enrollment.local_owner_user_id=$1 and enrollment.id in (
      select progress.enrollment_id from collaboration_sharing_selection_progress progress
      join collaboration_shared_memory_enrollments scope on scope.id=progress.enrollment_id and scope.revoked_at is null and scope.local_owner_user_id=$1
      where progress.state='active' and ${sources ? `progress.current_generation is not null and ${dirtySources("progress")}` : "progress.available_at<=now() and (progress.locked_at is null or progress.locked_at<now()-interval '5 minutes')"}
      order by ${sources ? "progress.source_work_at" : "progress.available_at"},progress.id limit $2
    ) order by enrollment.id for share of enrollment skip locked`,
    [ownerUserId, limit]
  );
  return rows.rows.map((row) => row.id);
};

/** Called inside the original creation acknowledgment transaction. The SELECT
 * checks the actual journal/enrollment, not caller-supplied publication authority. */
/** Install an authenticated Team receipt without replacing creation evidence.
 * The epoch makes every source revisit its new cap, even if membership is stable. */
const recordSelectionSharingAmendmentScope = async (
  client: pg.PoolClient,
  provider: EnvelopeEncryptionProvider,
  input: {
    identity: SelectionSharingIdentity;
    remoteDeviceId: string;
    scope: SharingRuleDetailAppliedScope | SharingRuleContentPolicyAppliedScope;
    kind: "detailAmendment" | "contentPolicyAmendment";
  }
) => {
  const scope = (
    input.kind === "detailAmendment"
      ? sharingRuleDetailAppliedScopeSchema
      : sharingRuleContentPolicyAppliedScopeSchema
  ).parse(input.scope);
  const enrollment = (
    await client.query<{ id: string }>(
      `select id from collaboration_shared_memory_enrollments where backend_id=$1 and local_owner_user_id=$2
      and upstream_user_id=$3 and remote_device_id=$4 and revoked_at is null for share`,
      [
        input.identity.backendId,
        input.identity.localOwnerUserId,
        input.identity.upstreamUserId,
        input.remoteDeviceId
      ]
    )
  ).rows[0];
  if (!enrollment) throw conflict();
  const row = (
    await client.query<Row>(
      `${rootSelect} where progress.enrollment_id=$1 and progress.rule_id=$2
    and progress.state='active' for update of progress`,
      [enrollment.id, scope.result.ruleId]
    )
  ).rows[0];
  if (!row) return false;
  const identity = identityFor(row);
  if (
    crossIdentitySyncDigest(identity) !==
    crossIdentitySyncDigest(input.identity)
  )
    throw conflict();
  const data = await decode(provider, identity, progressTable, row, (value) =>
    selectionSharingProgressSchema.parse(value)
  );
  if (
    data.remoteDeviceId !== input.remoteDeviceId ||
    data.intent.ruleId !== row.rule_id ||
    crossIdentitySyncDigest(data.identity) !==
      crossIdentitySyncDigest(identity) ||
    data.currentGeneration !== row.current_generation ||
    (data.proposal?.generation ?? null) !== row.proposal_generation
  )
    throw conflict();
  const previous = data[input.kind];
  if (
    previous &&
    previous.result.authorityVersion >= scope.result.authorityVersion
  ) {
    if (
      previous.result.authorityVersion === scope.result.authorityVersion &&
      crossIdentitySyncDigest(previous) !== crossIdentitySyncDigest(scope)
    )
      throw conflict();
    return false;
  }
  const updated = selectionSharingProgressSchema.parse({
    ...data,
    [input.kind]: scope
  });
  const encrypted = await encode(
    provider,
    identity,
    progressTable,
    String(row.id),
    updated
  );
  await client.query(
    `update collaboration_sharing_selection_progress set protected_dto=$2::jsonb,protected_dto_hash=$3,
    delivery_epoch=delivery_epoch+1,lease_version=lease_version+1,locked_at=null,available_at=now(),source_work_at=now(),updated_at=now()
    where id=$1`,
    [row.id, JSON.stringify(encrypted.envelope), encrypted.hash]
  );
  return true;
};

export const recordSelectionSharingDetailScope = (
  client: pg.PoolClient,
  provider: EnvelopeEncryptionProvider,
  input: {
    identity: SelectionSharingIdentity;
    remoteDeviceId: string;
    scope: SharingRuleDetailAppliedScope;
  }
) =>
  recordSelectionSharingAmendmentScope(client, provider, {
    ...input,
    kind: "detailAmendment"
  });

export const recordSelectionSharingContentPolicyScope = (
  client: pg.PoolClient,
  provider: EnvelopeEncryptionProvider,
  input: {
    identity: SelectionSharingIdentity;
    remoteDeviceId: string;
    scope: SharingRuleContentPolicyAppliedScope;
  }
) =>
  recordSelectionSharingAmendmentScope(client, provider, {
    ...input,
    kind: "contentPolicyAmendment"
  });

export const seedSelectionSharingProgress = async (
  client: pg.PoolClient,
  provider: EnvelopeEncryptionProvider,
  input: {
    enrollmentId: string;
    creationDeliveryId: string;
    identity: SelectionSharingIdentity;
    remoteDeviceId: string;
    intent: SelectionSharingProgress["intent"];
  }
) => {
  const id = randomUUID();
  const data = selectionSharingProgressSchema.parse({
    version: 1,
    identity: input.identity,
    remoteDeviceId: input.remoteDeviceId,
    intent: input.intent,
    currentGeneration: null,
    changeCursor: null,
    proposal: null
  });
  const encrypted = await encode(
    provider,
    input.identity,
    progressTable,
    id,
    data
  );
  await client.query(
    `insert into collaboration_sharing_selection_progress(id,enrollment_id,rule_id,creation_delivery_id,protected_dto,protected_dto_hash)
     select $1,delivery.enrollment_id,delivery.rule_id,delivery.id,$2::jsonb,$3
     from collaboration_sharing_rule_deliveries delivery join collaboration_shared_memory_enrollments enrollment on enrollment.id=delivery.enrollment_id
     where delivery.id=$4 and delivery.enrollment_id=$5 and delivery.rule_id=$6 and delivery.operation_kind='repository_create' and delivery.state='acknowledged'
       and enrollment.revoked_at is null and enrollment.backend_id=$7 and enrollment.local_owner_user_id=$8 and enrollment.upstream_user_id=$9 and enrollment.remote_device_id=$10
     on conflict (enrollment_id,rule_id) do nothing`,
    [
      id,
      JSON.stringify(encrypted.envelope),
      encrypted.hash,
      input.creationDeliveryId,
      input.enrollmentId,
      input.intent.ruleId,
      input.identity.backendId,
      input.identity.localOwnerUserId,
      input.identity.upstreamUserId,
      input.remoteDeviceId
    ]
  );
};

/** Transfer acknowledgment creates a receiving history atomically. Superseded
 * local leases/attempts cannot reuse the former publisher's cursor or work. */
export const seedTransferredSelectionSharingProgress = async (
  client: pg.PoolClient,
  provider: EnvelopeEncryptionProvider,
  input: {
    enrollmentId: string;
    creationDeliveryId: string;
    identity: SelectionSharingIdentity;
    remoteDeviceId: string;
    intent: ReturnType<
      typeof sharingRulePublisherTakeoverLocalIntentSchema.parse
    >;
    scope: ReturnType<
      typeof sharingRulePublisherTakeoverAppliedScopeSchema.parse
    >;
  }
) => {
  const intent = sharingRulePublisherTakeoverLocalIntentSchema.parse(
      input.intent
    ),
    scope = sharingRulePublisherTakeoverAppliedScopeSchema.parse(input.scope);
  if (
    scope.result.mutationId !== intent.mutationId ||
    input.remoteDeviceId !== scope.result.publisherCredentialId ||
    crossIdentitySyncDigest(scope.review) !==
      crossIdentitySyncDigest(intent.review)
  )
    throw conflict();
  if (!scope.review.selectionScope) return;
  if (!intent.target) throw conflict();
  const approved = await client.query(
    `select delivery.id from collaboration_sharing_rule_deliveries delivery join collaboration_shared_memory_enrollments enrollment on enrollment.id=delivery.enrollment_id
     where delivery.id=$1 and delivery.enrollment_id=$2 and delivery.rule_id=$3 and delivery.operation_kind='publisher_takeover' and delivery.state='acknowledged'
       and enrollment.revoked_at is null and enrollment.backend_id=$4 and enrollment.local_owner_user_id=$5 and enrollment.upstream_user_id=$6 and enrollment.remote_device_id=$7 for share of enrollment`,
    [
      input.creationDeliveryId,
      input.enrollmentId,
      intent.ruleId,
      input.identity.backendId,
      input.identity.localOwnerUserId,
      input.identity.upstreamUserId,
      input.remoteDeviceId
    ]
  );
  if (!approved.rowCount) throw conflict();
  const existing = (
    await client.query<Row>(
      `select * from collaboration_sharing_selection_progress where enrollment_id=$1 and rule_id=$2 for update`,
      [input.enrollmentId, intent.ruleId]
    )
  ).rows[0];
  const previous = existing
    ? await decode(provider, input.identity, progressTable, existing, (value) =>
        selectionSharingProgressSchema.parse(value)
      )
    : null;
  if (
    previous &&
    "publisherTakeover" in previous.intent &&
    previous.intent.publisherTakeover.result.authorityVersion >=
      scope.result.authorityVersion
  )
    return;
  const id = existing ? String(existing.id) : randomUUID();
  const data = selectionSharingProgressSchema.parse({
    version: 1,
    identity: input.identity,
    remoteDeviceId: input.remoteDeviceId,
    intent: transferredSelectionSharingScopeSchema.parse({
      ...scope.review.selectionScope,
      review: { target: intent.target },
      publisherTakeover: scope
    }),
    ...(previous?.detailAmendment &&
    previous.detailAmendment.result.authorityVersion >
      scope.result.authorityVersion
      ? { detailAmendment: previous.detailAmendment }
      : {}),
    ...(previous?.contentPolicyAmendment &&
    previous.contentPolicyAmendment.result.authorityVersion >
      scope.result.authorityVersion
      ? { contentPolicyAmendment: previous.contentPolicyAmendment }
      : {}),
    currentGeneration: null,
    changeCursor: null,
    proposal: null
  });
  const encrypted = await encode(
    provider,
    input.identity,
    progressTable,
    id,
    data
  );
  if (existing) {
    await client.query(
      "delete from collaboration_sharing_selection_pages where progress_id=$1",
      [id]
    );
    await client.query(
      "delete from collaboration_sharing_selection_sources where progress_id=$1",
      [id]
    );
    await client.query(
      `update collaboration_sharing_selection_progress set creation_delivery_id=$2,state='active',delivery_epoch=delivery_epoch+1,lease_version=lease_version+1,
      current_generation=null,proposal_generation=null,locked_at=null,available_at=now(),source_work_at=now(),attempt_count=0,protected_dto=$3::jsonb,protected_dto_hash=$4,updated_at=now() where id=$1`,
      [
        id,
        input.creationDeliveryId,
        JSON.stringify(encrypted.envelope),
        encrypted.hash
      ]
    );
  } else
    await client.query(
      `insert into collaboration_sharing_selection_progress(id,enrollment_id,rule_id,creation_delivery_id,protected_dto,protected_dto_hash)
      values($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        id,
        input.enrollmentId,
        intent.ruleId,
        input.creationDeliveryId,
        JSON.stringify(encrypted.envelope),
        encrypted.hash
      ]
    );
};

export const createSelectionSharingJournal = (
  pool: pg.Pool,
  provider: EnvelopeEncryptionProvider
) => {
  const load = async (
    client: pg.PoolClient,
    lease: SelectionSharingProgressLease
  ) => {
    await client.query(
      `select enrollment.id from collaboration_shared_memory_enrollments enrollment
      join collaboration_sharing_selection_progress progress on progress.enrollment_id=enrollment.id
      where progress.id=$1 and enrollment.backend_id=$2 and enrollment.local_owner_user_id=$3 and enrollment.upstream_user_id=$4 and enrollment.revoked_at is null
      for share of enrollment`,
      [
        lease.progressId,
        lease.identity.backendId,
        lease.identity.localOwnerUserId,
        lease.identity.upstreamUserId
      ]
    );
    const rows = await client.query<Row>(
      `${rootSelect} where progress.id=$1 and progress.state='active' and progress.lease_version=$2
      and progress.locked_at>now()-interval '5 minutes' for update of progress`,
      [lease.progressId, lease.leaseVersion]
    );
    const row = rows.rows[0];
    if (
      !row ||
      crossIdentitySyncDigest(identityFor(row)) !==
        crossIdentitySyncDigest(lease.identity) ||
      row.remote_device_id !== lease.remoteDeviceId
    )
      throw conflict();
    const data = await decode(
      provider,
      lease.identity,
      progressTable,
      row,
      (value) => selectionSharingProgressSchema.parse(value)
    );
    if (
      crossIdentitySyncDigest(data.identity) !==
        crossIdentitySyncDigest(lease.identity) ||
      data.remoteDeviceId !== lease.remoteDeviceId ||
      data.intent.ruleId !== row.rule_id ||
      data.currentGeneration !== row.current_generation ||
      (data.proposal?.generation ?? null) !== row.proposal_generation
    )
      throw conflict();
    return { row, data };
  };
  const save = async (
    client: pg.PoolClient,
    lease: SelectionSharingProgressLease,
    data: SelectionSharingProgress,
    release = false
  ) => {
    const encrypted = await encode(
      provider,
      lease.identity,
      progressTable,
      lease.progressId,
      selectionSharingProgressSchema.parse(data)
    );
    await client.query(
      `update collaboration_sharing_selection_progress set protected_dto=$3::jsonb,protected_dto_hash=$4,
      current_generation=$5,proposal_generation=$6,locked_at=case when $7 then null else now() end,
      available_at=case when $7 then now() else available_at end,attempt_count=0,updated_at=now() where id=$1 and lease_version=$2`,
      [
        lease.progressId,
        lease.leaseVersion,
        JSON.stringify(encrypted.envelope),
        encrypted.hash,
        data.currentGeneration,
        data.proposal?.generation ?? null,
        release
      ]
    );
  };
  const readSource = async (identity: SelectionSharingIdentity, row: Row) => {
    const data = await decode(provider, identity, sourcesTable, row, (value) =>
      selectionSharingSourceStateSchema.parse(value)
    );
    if (
      data.sourceKey !== row.source_key ||
      data.currentGeneration !== row.current_generation ||
      data.proposedGeneration !== row.proposed_generation ||
      (data.current ? selectionSharingGoalHash(data.current) : null) !==
        row.current_goal_hash ||
      (data.proposed ? selectionSharingGoalHash(data.proposed) : null) !==
        row.proposed_goal_hash ||
      (data.attempt?.mutationId ?? null) !== row.attempt_mutation_id
    )
      throw conflict();
    for (const goal of [data.current, data.proposed])
      if (goal && selectionSharingSourceKey(goal.source) !== data.sourceKey)
        throw conflict();
    return data;
  };
  const loadSource = async (
    client: pg.PoolClient,
    lease: SelectionSharingSourceLease
  ) => {
    const enrollment = await client.query(
      `select enrollment.id from collaboration_shared_memory_enrollments enrollment
      join collaboration_sharing_selection_progress progress on progress.enrollment_id=enrollment.id
      where progress.id=$1 and enrollment.backend_id=$2 and enrollment.local_owner_user_id=$3 and enrollment.upstream_user_id=$4
        and enrollment.remote_device_id=$5 and enrollment.revoked_at is null for share of enrollment`,
      [
        lease.progressId,
        lease.identity.backendId,
        lease.identity.localOwnerUserId,
        lease.identity.upstreamUserId,
        lease.remoteDeviceId
      ]
    );
    if (!enrollment.rowCount) throw conflict();
    const roots = await client.query<Row>(
      `${rootSelect} where progress.id=$1 and progress.state='active' for share of progress`,
      [lease.progressId]
    );
    const root = roots.rows[0];
    if (!root || !root.current_generation) throw conflict();
    const progress = await decode(
      provider,
      lease.identity,
      progressTable,
      root,
      (value) => selectionSharingProgressSchema.parse(value)
    );
    if (
      crossIdentitySyncDigest(progress.identity) !==
        crossIdentitySyncDigest(lease.identity) ||
      progress.remoteDeviceId !== lease.remoteDeviceId ||
      progress.currentGeneration !== root.current_generation ||
      (progress.proposal?.generation ?? null) !== root.proposal_generation ||
      progress.intent.ruleId !== root.rule_id
    )
      throw conflict();
    const sources = await client.query<Row>(
      `select * from collaboration_sharing_selection_sources where id=$1 and progress_id=$2 and lease_version=$3
      and locked_at>now()-interval '5 minutes' for update`,
      [lease.sourceId, lease.progressId, lease.leaseVersion]
    );
    const row = sources.rows[0];
    if (!row) throw conflict();
    const data = await readSource(lease.identity, row);
    const goal =
      row.proposed_generation === progress.currentGeneration
        ? data.proposed
        : data.current;
    if (!goal) throw conflict();
    return {
      row,
      data,
      goal,
      progress,
      deliveryEpoch: Number(root.delivery_epoch),
      goalHash: selectionSharingGoalHash(goal)
    };
  };
  const saveSource = async (
    client: pg.PoolClient,
    lease: SelectionSharingSourceLease,
    data: SelectionSharingSourceState,
    doneHash?: string,
    doneDeliveryEpoch?: number
  ) => {
    const encrypted = await encode(
      provider,
      lease.identity,
      sourcesTable,
      lease.sourceId,
      data,
      lease.progressId
    );
    await client.query(
      `update collaboration_sharing_selection_sources set protected_dto=$3::jsonb,protected_dto_hash=$4,attempt_mutation_id=$5,
      done_goal_hash=case when $6::text is null then done_goal_hash else $6 end,done_delivery_epoch=case when $6::text is null then done_delivery_epoch else $7::int end,
      locked_at=case when $6::text is null then now() else null end,
      available_at=now(),attempt_count=case when $6::text is null then attempt_count else 0 end,updated_at=now() where id=$1 and lease_version=$2`,
      [
        lease.sourceId,
        lease.leaseVersion,
        JSON.stringify(encrypted.envelope),
        encrypted.hash,
        data.attempt?.mutationId ?? null,
        doneHash ?? null,
        doneDeliveryEpoch ?? null
      ]
    );
  };
  const stage = async (
    client: pg.PoolClient,
    lease: SelectionSharingProgressLease,
    data: SelectionSharingProgress,
    raw: SelectionSharingGoal
  ) => {
    const goal = selectionSharingGoalSchema.parse(raw),
      proposal = data.proposal;
    if (!proposal || goal.snapshotVersion !== proposal.snapshotVersion)
      throw conflict();
    const sourceKey = selectionSharingSourceKey(goal.source),
      hash = selectionSharingGoalHash(goal);
    const selected = await client.query<Row>(
      `select * from collaboration_sharing_selection_sources where progress_id=$1 and source_key=$2 for update`,
      [lease.progressId, sourceKey]
    );
    const row = selected.rows[0];
    const payload: SelectionSharingSourceState = row
      ? await readSource(lease.identity, row)
      : {
          sourceKey,
          current: null,
          proposed: null,
          currentGeneration: null,
          proposedGeneration: null,
          attempt: null,
          remote: null
        };
    if (payload.sourceKey !== sourceKey) throw conflict();
    if (row?.proposed_generation === proposal.generation) {
      if (row.proposed_goal_hash !== hash) {
        if (proposal.inventory)
          throw Object.assign(
            new Error("Personal evidence changed during inventory staging"),
            { code: "selection_enumeration_stale" }
          );
        throw conflict();
      }
      return;
    }
    let currentGeneration = payload.currentGeneration,
      currentHash = payload.current
        ? selectionSharingGoalHash(payload.current)
        : null;
    if (
      row &&
      row.proposed_generation === data.currentGeneration &&
      data.currentGeneration !== null
    ) {
      payload.current = payload.proposed;
      payload.currentGeneration = data.currentGeneration;
      currentGeneration = data.currentGeneration;
      currentHash = payload.current
        ? selectionSharingGoalHash(payload.current)
        : null;
    }
    payload.proposed = goal;
    payload.proposedGeneration = proposal.generation;
    const id = row ? String(row.id) : randomUUID();
    const encrypted = await encode(
      provider,
      lease.identity,
      sourcesTable,
      id,
      payload,
      lease.progressId
    );
    await client.query(
      `insert into collaboration_sharing_selection_sources(id,progress_id,source_key,current_generation,current_goal_hash,proposed_generation,proposed_goal_hash,protected_dto,protected_dto_hash)
      values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
      on conflict(progress_id,source_key) do update set current_generation=excluded.current_generation,current_goal_hash=excluded.current_goal_hash,
        proposed_generation=excluded.proposed_generation,proposed_goal_hash=excluded.proposed_goal_hash,protected_dto=excluded.protected_dto,
        protected_dto_hash=excluded.protected_dto_hash,available_at=now(),updated_at=now()`,
      [
        id,
        lease.progressId,
        sourceKey,
        currentGeneration,
        currentHash,
        proposal.generation,
        hash,
        JSON.stringify(encrypted.envelope),
        encrypted.hash
      ]
    );
  };
  return {
    async readPublisherTakeoverSourceBindings(
      input: Parameters<typeof readPublisherTakeoverSourceBindings>[1]
    ) {
      return transaction(pool, (client) =>
        readPublisherTakeoverSourceBindings(client, input)
      );
    },
    async resolveSharingSelectionTarget(input: {
      ownerUserId: string;
      target: SelectionSharingProgress["intent"]["review"]["target"];
    }) {
      return transaction(pool, (client) =>
        resolveSharingSelectionTarget(client, input.ownerUserId, input.target)
      );
    },
    async recordContentPolicyScope(input: {
      identity: SelectionSharingIdentity;
      remoteDeviceId: string;
      scope: SharingRuleContentPolicyAppliedScope;
    }) {
      return transaction(pool, (client) =>
        recordSelectionSharingContentPolicyScope(client, provider, input)
      );
    },
    async recordDetailScope(input: {
      identity: SelectionSharingIdentity;
      remoteDeviceId: string;
      scope: SharingRuleDetailAppliedScope;
    }) {
      return transaction(pool, (client) =>
        recordSelectionSharingDetailScope(client, provider, input)
      );
    },
    async claim(
      localOwnerUserId: string,
      limit = 5
    ): Promise<SelectionSharingProgressLease[]> {
      return transaction(pool, async (client) => {
        const enrollmentIds = await lockEnrollments(
          client,
          localOwnerUserId,
          Math.max(1, Math.min(20, limit)),
          false
        );
        if (!enrollmentIds.length) return [];
        const selected = await client.query<Row>(
          `${rootSelect} where enrollment.local_owner_user_id=$1 and progress.state='active'
          and progress.available_at<=now() and (progress.locked_at is null or progress.locked_at<now()-interval '5 minutes')
          and progress.enrollment_id=any($3::uuid[]) order by progress.available_at,progress.id limit $2 for update of progress skip locked`,
          [localOwnerUserId, Math.max(1, Math.min(20, limit)), enrollmentIds]
        );
        const work: SelectionSharingProgressLease[] = [];
        for (const row of selected.rows) {
          const identity = identityFor(row),
            data = await decode(
              provider,
              identity,
              progressTable,
              row,
              (value) => selectionSharingProgressSchema.parse(value)
            );
          if (
            crossIdentitySyncDigest(identity) !==
              crossIdentitySyncDigest(data.identity) ||
            data.remoteDeviceId !== row.remote_device_id ||
            data.intent.ruleId !== row.rule_id ||
            data.currentGeneration !== row.current_generation ||
            (data.proposal?.generation ?? null) !== row.proposal_generation
          )
            throw conflict();
          const updated = await client.query<{ lease_version: number }>(
            `update collaboration_sharing_selection_progress set lease_version=lease_version+1,locked_at=now(),updated_at=now() where id=$1 returning lease_version`,
            [row.id]
          );
          work.push({
            progressId: String(row.id),
            leaseVersion: updated.rows[0]!.lease_version,
            identity,
            remoteDeviceId: data.remoteDeviceId,
            data
          });
        }
        return work;
      });
    },
    async appendPage(lease: SelectionSharingProgressLease, raw: unknown) {
      const page = personalSelectionConsumerPageSchema.parse(raw);
      return transaction(pool, async (client) => {
        const { data } = await load(client, lease);
        if (
          page.selection.ownerUserId !== lease.identity.localOwnerUserId ||
          crossIdentitySyncDigest(page.selection.target) !==
            crossIdentitySyncDigest(data.intent.review.target) ||
          Date.parse(page.expiresAt) <= Date.now() ||
          (page.nextCursor === null) !== (page.changeCursor !== null)
        )
          throw conflict();
        if (!data.proposal)
          data.proposal = {
            generation: randomUUID(),
            snapshotVersion: page.snapshotVersion,
            nextCursor: null,
            changeCursor: null,
            pageCount: 0,
            planPage: 0,
            missingAfter: null,
            phase: "enumerating"
          };
        const proposal = data.proposal;
        // The lease's cursor is the exact read this caller was assigned. It
        // cannot append the same page again after another page was persisted.
        if (
          proposal.phase !== "enumerating" ||
          proposal.snapshotVersion !== page.snapshotVersion ||
          proposal.nextCursor !== (lease.data.proposal?.nextCursor ?? null) ||
          proposal.pageCount !== (lease.data.proposal?.pageCount ?? 0)
        )
          throw conflict();
        const id = randomUUID(),
          encrypted = await encode(
            provider,
            lease.identity,
            pagesTable,
            id,
            page,
            lease.progressId
          );
        await client.query(
          `insert into collaboration_sharing_selection_pages(id,progress_id,generation,page_number,protected_dto,protected_dto_hash) values($1,$2,$3,$4,$5::jsonb,$6)`,
          [
            id,
            lease.progressId,
            proposal.generation,
            proposal.pageCount,
            JSON.stringify(encrypted.envelope),
            encrypted.hash
          ]
        );
        proposal.pageCount++;
        proposal.nextCursor = page.nextCursor;
        proposal.changeCursor = page.changeCursor;
        if (page.nextCursor === null) {
          if ("publisherTakeover" in data.intent) {
            proposal.phase = "inventory";
            proposal.inventory = {
              afterMembershipId: null,
              page: null,
              afterBindingId: null,
              unmatchedMembershipIds: [],
              pendingMemberCount: 0,
              scope: null
            };
          } else proposal.phase = "present";
        }
        await save(client, lease, data, true);
      });
    },
    async installInventoryPage(
      lease: SelectionSharingProgressLease,
      raw: unknown
    ) {
      const page = repositorySharingRuleMemberInventorySchema.parse(raw);
      return transaction(pool, async (client) => {
        const { data } = await load(client, lease),
          proposal = data.proposal,
          inventory = proposal?.inventory;
        if (
          proposal?.phase !== "inventory" ||
          !inventory ||
          inventory.page ||
          page.ruleId !== data.intent.ruleId ||
          page.teamId !== data.intent.teamId ||
          page.teamWorkspaceId !== data.intent.teamWorkspaceId ||
          page.selectorBindingHash !==
            crossIdentitySyncDigest(data.intent.selector) ||
          page.entries.some(
            (entry, index) =>
              entry.membershipId <=
              (index
                ? page.entries[index - 1]!.membershipId
                : (inventory.afterMembershipId ?? ""))
          ) ||
          (page.nextAfterMembershipId !== null &&
            (page.entries.length !== 100 ||
              page.nextAfterMembershipId !== page.entries.at(-1)!.membershipId))
        )
          throw conflict();
        const scope = {
          authorityVersion: page.authorityVersion,
          publisherFence: page.publisherFence
        };
        if (
          inventory.scope &&
          crossIdentitySyncDigest(inventory.scope) !==
            crossIdentitySyncDigest(scope)
        )
          throw Object.assign(new Error("Publisher inventory scope changed"), {
            code: "selection_enumeration_stale"
          });
        inventory.scope = scope;
        inventory.page = page;
        inventory.afterBindingId = null;
        inventory.unmatchedMembershipIds = page.entries.map(
          (entry) => entry.membershipId
        );
        if (!page.entries.length) proposal.phase = "present";
        await save(client, lease, data, true);
      });
    },
    async stageInventoryBindings(
      lease: SelectionSharingProgressLease,
      input: {
        nextAfterBindingId: string | null;
        dispositions: Array<{
          membershipId: string;
          source: SelectionSharingGoal["source"];
          goal: SelectionSharingGoal | null;
        }>;
      }
    ) {
      if (input.dispositions.length > 100) throw conflict();
      return transaction(pool, async (client) => {
        const { data } = await load(client, lease),
          proposal = data.proposal,
          inventory = proposal?.inventory,
          page = inventory?.page;
        if (
          proposal?.phase !== "inventory" ||
          !inventory ||
          !page ||
          inventory.afterBindingId !==
            lease.data.proposal?.inventory?.afterBindingId ||
          (input.nextAfterBindingId !== null &&
            input.nextAfterBindingId <= (inventory.afterBindingId ?? ""))
        )
          throw conflict();
        for (const item of input.dispositions) {
          const member = page.entries.find(
              (entry) => entry.membershipId === item.membershipId
            ),
            portable = item.source.portable;
          if (
            !member ||
            !portable ||
            portable.ownerUserId !== lease.identity.localOwnerUserId ||
            item.source.identityState !== "verified" ||
            !inventory.unmatchedMembershipIds.includes(member.membershipId) ||
            member.portableSourceHash !==
              sharingRuleSourceIdentityHash(lease.identity.upstreamUserId, {
                originatingDeploymentId: portable.originatingDeploymentId,
                originatingDeviceId: portable.originatingDeviceId,
                logicalSessionId: portable.logicalSessionId
              })
          )
            throw conflict();
          inventory.unmatchedMembershipIds =
            inventory.unmatchedMembershipIds.filter(
              (id) => id !== member.membershipId
            );
          if (!item.goal) continue;
          if (
            selectionSharingSourceKey(item.goal.source) !==
              selectionSharingSourceKey(item.source) ||
            item.goal.desired === "present"
          )
            throw conflict();
          await stage(client, lease, data, item.goal);
          const row = (
            await client.query<Row>(
              `select * from collaboration_sharing_selection_sources where progress_id=$1 and source_key=$2 for update`,
              [lease.progressId, selectionSharingSourceKey(item.source)]
            )
          ).rows[0]!;
          const payload = await readSource(lease.identity, row);
          if (
            payload.remote &&
            payload.remote.logicalMemoryId !== member.logicalMemoryId
          )
            throw conflict();
          if (!payload.remote) {
            payload.remote = {
              logicalMemoryId: member.logicalMemoryId,
              membershipId: member.membershipId,
              membershipVersion: member.membershipVersion,
              authorityVersion: page.authorityVersion,
              publisherFence: page.publisherFence,
              pendingShareId: null
            };
            const encrypted = await encode(
              provider,
              lease.identity,
              sourcesTable,
              String(row.id),
              payload,
              lease.progressId
            );
            await client.query(
              `update collaboration_sharing_selection_sources set protected_dto=$2::jsonb,protected_dto_hash=$3 where id=$1`,
              [row.id, JSON.stringify(encrypted.envelope), encrypted.hash]
            );
          }
          if (item.goal.desired === "unresolved")
            inventory.pendingMemberCount++;
        }
        inventory.afterBindingId = input.nextAfterBindingId;
        if (input.nextAfterBindingId === null) {
          inventory.pendingMemberCount +=
            inventory.unmatchedMembershipIds.length;
          inventory.afterMembershipId = page.nextAfterMembershipId;
          inventory.page = null;
          inventory.unmatchedMembershipIds = [];
          if (page.nextAfterMembershipId === null) proposal.phase = "present";
        }
        await save(client, lease, data, true);
      });
    },
    async stagePresentPage(lease: SelectionSharingProgressLease) {
      return transaction(pool, async (client) => {
        const { data } = await load(client, lease),
          proposal = data.proposal;
        if (!proposal || proposal.phase !== "present") throw conflict();
        const selected = await client.query<Row>(
          `select * from collaboration_sharing_selection_pages where progress_id=$1 and generation=$2 and page_number=$3`,
          [lease.progressId, proposal.generation, proposal.planPage]
        );
        if (!selected.rows[0]) throw conflict();
        const page = await decode(
          provider,
          lease.identity,
          pagesTable,
          selected.rows[0],
          (value) => personalSelectionConsumerPageSchema.parse(value)
        );
        if (page.snapshotVersion !== proposal.snapshotVersion) throw conflict();
        for (const entry of page.entries)
          await stage(client, lease, data, {
            source: entry.source,
            desired: "present",
            snapshotVersion: proposal.snapshotVersion,
            contextHash: crossIdentitySyncDigest({
              source: entry.source,
              selector: data.intent.selector
            })
          });
        proposal.planPage++;
        if (proposal.planPage === proposal.pageCount)
          proposal.phase = "missing";
        await save(client, lease, data, true);
      });
    },
    async readMissing(lease: SelectionSharingProgressLease) {
      return transaction(pool, async (client) => {
        const { data } = await load(client, lease),
          proposal = data.proposal;
        if (!proposal || proposal.phase !== "missing") throw conflict();
        const rows = await client.query<Row>(
          `select * from collaboration_sharing_selection_sources where progress_id=$1
          and proposed_generation is distinct from $2::uuid and ($3::uuid is null or id>$3) order by id limit 100`,
          [lease.progressId, proposal.generation, proposal.missingAfter]
        );
        const entries = [];
        for (const row of rows.rows) {
          const payload = await readSource(lease.identity, row);
          const goal =
            row.proposed_generation === data.currentGeneration
              ? payload.proposed
              : payload.current;
          entries.push({ id: String(row.id), goal });
        }
        return {
          entries,
          changeCursor: proposal.changeCursor,
          snapshotVersion: proposal.snapshotVersion
        };
      });
    },
    async stageMissing(
      lease: SelectionSharingProgressLease,
      entries: Array<{ id: string; goal: SelectionSharingGoal | null }>
    ) {
      if (entries.length > 100) throw conflict();
      return transaction(pool, async (client) => {
        const { data } = await load(client, lease),
          proposal = data.proposal;
        if (!proposal || proposal.phase !== "missing") throw conflict();
        const expected = await client.query<Row>(
          `select * from collaboration_sharing_selection_sources where progress_id=$1
          and proposed_generation is distinct from $2::uuid and ($3::uuid is null or id>$3) order by id limit 100 for update`,
          [lease.progressId, proposal.generation, proposal.missingAfter]
        );
        if (
          crossIdentitySyncDigest(expected.rows.map((row) => row.id)) !==
          crossIdentitySyncDigest(entries.map((entry) => entry.id))
        )
          throw conflict();
        for (const entry of entries) {
          const row = expected.rows.find((row) => row.id === entry.id)!;
          if (entry.goal) {
            const payload = await readSource(lease.identity, row);
            const old =
              row.proposed_generation === data.currentGeneration
                ? payload.proposed
                : payload.current;
            if (
              !old ||
              selectionSharingSourceKey(old.source) !==
                selectionSharingSourceKey(entry.goal.source)
            )
              throw conflict();
            await stage(client, lease, data, entry.goal);
          } else {
            // Only abandoned, never-installed rows can be discarded here.
            if (
              row.current_generation !== null ||
              row.proposed_generation === data.currentGeneration
            )
              throw conflict();
            await client.query(
              "delete from collaboration_sharing_selection_sources where id=$1",
              [row.id]
            );
          }
        }
        if (entries.length < 100) proposal.phase = "commit";
        else proposal.missingAfter = entries.at(-1)!.id;
        await save(client, lease, data, true);
      });
    },
    async commit(lease: SelectionSharingProgressLease) {
      return transaction(pool, async (client) => {
        const { data } = await load(client, lease),
          proposal = data.proposal;
        if (
          !proposal ||
          proposal.phase !== "commit" ||
          !proposal.changeCursor ||
          proposal.planPage !== proposal.pageCount
        )
          throw conflict();
        const checkpoint = await readConsumerCursor(
          client,
          { userId: lease.identity.localOwnerUserId },
          proposal.changeCursor
        );
        if (
          checkpoint.kind !== "checkpoint" ||
          checkpoint.snapshot_version !== proposal.snapshotVersion ||
          crossIdentitySyncDigest(checkpoint.selection.target) !==
            crossIdentitySyncDigest(data.intent.review.target)
        )
          throw conflict();
        const changed = await client.query(
          `select 1 from personal_selection_changes where owner_user_id=$1
          and not pg_visible_in_snapshot(transaction_id::xid8,$2::pg_snapshot) limit 1`,
          [lease.identity.localOwnerUserId, checkpoint.from_snapshot]
        );
        if (changed.rowCount)
          throw Object.assign(
            new Error(
              "Personal selection changed before baseline installation"
            ),
            { code: "selection_enumeration_stale" }
          );
        // Never replace a complete baseline while a known committed source has
        // no staged disposition. Unavailability must have an explicit retained goal.
        const missing = await client.query(
          `select 1 from collaboration_sharing_selection_sources where progress_id=$1 and proposed_generation is distinct from $2::uuid
          and (current_generation is not null or proposed_generation=$3::uuid) limit 1`,
          [lease.progressId, proposal.generation, data.currentGeneration]
        );
        if (missing.rowCount) throw conflict();
        data.currentGeneration = proposal.generation;
        if (proposal.inventory)
          data.pendingMemberCount = proposal.inventory.pendingMemberCount;
        data.changeCursor = proposal.changeCursor;
        data.proposal = null;
        await save(client, lease, data, true);
        await client.query(
          "delete from collaboration_sharing_selection_pages where progress_id=$1 and generation<>$2",
          [lease.progressId, data.currentGeneration]
        );
      });
    },
    async abandon(lease: SelectionSharingProgressLease) {
      return transaction(pool, async (client) => {
        const { data } = await load(client, lease);
        if (data.proposal)
          await client.query(
            "delete from collaboration_sharing_selection_pages where progress_id=$1 and generation=$2",
            [lease.progressId, data.proposal.generation]
          );
        data.proposal = null;
        // A rejected cursor cannot be the starting point of the next scan.
        // Keep the installed generation and exact source attempts until a
        // complete replacement baseline is ready to commit.
        data.changeCursor = null;
        await save(client, lease, data, true);
      });
    },
    async advanceCheckpoint(
      lease: SelectionSharingProgressLease,
      cursorId: string
    ) {
      return transaction(pool, async (client) => {
        const { data } = await load(client, lease);
        if (data.proposal || !data.currentGeneration || !data.changeCursor)
          throw conflict();
        const previous = await readConsumerCursor(
          client,
          { userId: lease.identity.localOwnerUserId },
          data.changeCursor
        );
        const checkpoint = await readConsumerCursor(
          client,
          { userId: lease.identity.localOwnerUserId },
          cursorId
        );
        if (
          checkpoint.kind !== "checkpoint" ||
          crossIdentitySyncDigest(checkpoint.selection.target) !==
            crossIdentitySyncDigest(data.intent.review.target)
        )
          throw conflict();
        const skipped = await client.query(
          `select 1 from personal_selection_changes where owner_user_id=$1
          and not pg_visible_in_snapshot(transaction_id::xid8,$2::pg_snapshot)
          and pg_visible_in_snapshot(transaction_id::xid8,$3::pg_snapshot) limit 1`,
          [
            lease.identity.localOwnerUserId,
            previous.from_snapshot,
            checkpoint.from_snapshot
          ]
        );
        if (skipped.rowCount) throw conflict();
        data.changeCursor = cursorId;
        await save(client, lease, data, true);
        await client.query(
          "update collaboration_sharing_selection_progress set available_at=now()+interval '30 seconds' where id=$1 and lease_version=$2",
          [lease.progressId, lease.leaseVersion]
        );
      });
    },
    async defer(lease: SelectionSharingProgressLease, seconds = 30) {
      return transaction(pool, async (client) => {
        await load(client, lease);
        await client.query(
          `update collaboration_sharing_selection_progress set locked_at=null,available_at=now()+make_interval(secs=>$3),attempt_count=attempt_count+1,updated_at=now() where id=$1 and lease_version=$2`,
          [
            lease.progressId,
            lease.leaseVersion,
            Math.max(1, Math.min(300, seconds))
          ]
        );
      });
    },
    async claimSources(
      localOwnerUserId: string,
      limit = 10
    ): Promise<SelectionSharingSourceLease[]> {
      return transaction(pool, async (client) => {
        const count = Math.max(1, Math.min(20, limit)),
          enrollmentIds = await lockEnrollments(
            client,
            localOwnerUserId,
            count,
            true
          );
        if (!enrollmentIds.length) return [];
        const roots = await client.query<Row>(
          `${rootSelect} where progress.enrollment_id=any($1::uuid[]) and progress.state='active'
          and progress.current_generation is not null and ${dirtySources("progress")}
          order by progress.source_work_at,progress.id limit $2 for update of progress skip locked`,
          [enrollmentIds, count]
        );
        const work: SelectionSharingSourceLease[] = [];
        for (const root of roots.rows) {
          const identity = identityFor(root),
            progress = await decode(
              provider,
              identity,
              progressTable,
              root,
              (value) => selectionSharingProgressSchema.parse(value)
            );
          if (
            crossIdentitySyncDigest(progress.identity) !==
              crossIdentitySyncDigest(identity) ||
            progress.remoteDeviceId !== root.remote_device_id ||
            progress.currentGeneration !== root.current_generation ||
            (progress.proposal?.generation ?? null) !==
              root.proposal_generation ||
            progress.intent.ruleId !== root.rule_id
          )
            throw conflict();
          const rows = await client.query<Row>(
            `select source.* from collaboration_sharing_selection_sources source
            where source.progress_id=$1 and source.available_at<=now() and (source.locked_at is null or source.locked_at<now()-interval '5 minutes')
              and (source.attempt_mutation_id is not null or source.done_delivery_epoch is distinct from $3::int or source.done_goal_hash is distinct from
                case when source.proposed_generation=$2 then source.proposed_goal_hash else source.current_goal_hash end)
              and (source.attempt_mutation_id is not null or case when source.proposed_generation=$2 then source.proposed_goal_hash else source.current_goal_hash end is not null)
              and (not $4::boolean or source.attempt_mutation_id is not null)
            order by source.available_at,source.id limit 1 for update of source skip locked`,
            [
              root.id,
              root.current_generation,
              root.delivery_epoch,
              "publisherTakeover" in progress.intent &&
                progress.proposal !== null
            ]
          );
          const row = rows.rows[0];
          if (!row) continue;
          const data = await readSource(identity, row),
            goal =
              row.proposed_generation === progress.currentGeneration
                ? data.proposed
                : data.current;
          if (!goal) throw conflict();
          const updated = await client.query<{ lease_version: number }>(
            `update collaboration_sharing_selection_sources set lease_version=lease_version+1,locked_at=now(),updated_at=now() where id=$1 returning lease_version`,
            [row.id]
          );
          await client.query(
            "update collaboration_sharing_selection_progress set source_work_at=now() where id=$1",
            [root.id]
          );
          work.push({
            deliveryEpoch: Number(root.delivery_epoch),
            progressId: String(root.id),
            sourceId: String(row.id),
            leaseVersion: updated.rows[0]!.lease_version,
            identity,
            remoteDeviceId: progress.remoteDeviceId,
            progress,
            goal,
            goalHash: selectionSharingGoalHash(goal),
            data
          });
        }
        return work;
      });
    },
    async resolvePublisherTakeoverSource(
      input: Parameters<typeof resolvePublisherTakeoverSource>[1]
    ) {
      return transaction(pool, (client) =>
        resolvePublisherTakeoverSource(client, input)
      );
    },
    async resolveNativeConversationSource(input: {
      ownerUserId: string;
      sessionId: string;
      deploymentProtocolId: string;
    }) {
      return transaction(pool, (client) =>
        resolveNativeConversationSharingSource(client, input)
      );
    },
    async resolveNativeSource(
      lease: SelectionSharingSourceLease,
      deploymentProtocolId: string
    ) {
      return transaction(pool, async (client) => {
        const { goal, progress, goalHash } = await loadSource(client, lease);
        if (goal.desired !== "present" || goalHash !== lease.goalHash)
          throw conflict();
        return resolveNativeSharingSource(client, {
          ownerUserId: lease.identity.localOwnerUserId,
          goal,
          target: progress.intent.review.target,
          deploymentProtocolId
        });
      });
    },
    async resolveExistingSource(lease: SelectionSharingSourceLease) {
      return transaction(pool, async (client) => {
        const { goal, progress, goalHash } = await loadSource(client, lease);
        if (goalHash !== lease.goalHash) throw conflict();
        return resolveReplicaSharingSource(client, {
          ownerUserId: lease.identity.localOwnerUserId,
          goal,
          target: progress.intent.review.target
        });
      });
    },
    async persistAttempt(
      lease: SelectionSharingSourceLease,
      raw: SelectionSharingAttempt
    ) {
      const attempt = selectionSharingAttemptSchema.parse(raw);
      if (
        attempt.body.mutationId !== attempt.mutationId ||
        attempt.requestHash !==
          crossIdentitySyncDigest({
            kind: attempt.kind,
            logicalMemoryId: attempt.logicalMemoryId,
            membershipId: attempt.membershipId,
            body: attempt.body
          })
      )
        throw conflict();
      return transaction(pool, async (client) => {
        const { data, goalHash, deliveryEpoch, progress } = await loadSource(
          client,
          lease
        );
        if (data.attempt) {
          if (
            crossIdentitySyncDigest(data.attempt) !==
            crossIdentitySyncDigest(attempt)
          )
            throw conflict();
          return data.attempt;
        }
        if ("publisherTakeover" in progress.intent && progress.proposal)
          throw conflict();
        if (
          goalHash !== lease.goalHash ||
          attempt.goalHash !== goalHash ||
          lease.deliveryEpoch !== deliveryEpoch ||
          attempt.deliveryEpoch !== deliveryEpoch
        )
          throw conflict();
        data.attempt = attempt;
        await saveSource(client, lease, data);
        return attempt;
      });
    },
    async cancelAttempt(
      lease: SelectionSharingSourceLease,
      input: { mutationId: string; requestHash: string; retrySeconds?: number }
    ) {
      return transaction(pool, async (client) => {
        const { data } = await loadSource(client, lease);
        if (
          !data.attempt ||
          data.attempt.mutationId !== input.mutationId ||
          data.attempt.requestHash !== input.requestHash
        )
          throw conflict();
        data.attempt = null;
        // Cancellation confirms non-acceptance, not delivery of any goal.
        await saveSource(client, lease, data);
        await client.query(
          "update collaboration_sharing_selection_sources set locked_at=null,available_at=now()+make_interval(secs=>$3) where id=$1 and lease_version=$2",
          [
            lease.sourceId,
            lease.leaseVersion,
            Math.max(1, Math.min(300, input.retrySeconds ?? 1))
          ]
        );
      });
    },
    async acknowledgeSource(
      lease: SelectionSharingSourceLease,
      input: {
        mutationId: string | null;
        remote: SelectionSharingSourceState["remote"];
        observePending?: boolean;
      }
    ) {
      return transaction(pool, async (client) => {
        const { data, goalHash, deliveryEpoch } = await loadSource(
          client,
          lease
        );
        const remote = selectionSharingSourceStateSchema.shape.remote.parse(
          input.remote
        );
        if (
          input.observePending === true &&
          (input.mutationId === null ||
            data.attempt?.sourceWorkMode !== "retained" ||
            !remote?.pendingShareId)
        )
          throw conflict();
        let doneHash: string, doneEpoch: number;
        if (input.mutationId !== null) {
          const attempt = data.attempt;
          if (
            !attempt ||
            attempt.mutationId !== input.mutationId ||
            !remote ||
            remote.logicalMemoryId !== attempt.logicalMemoryId ||
            remote.membershipId !== attempt.membershipId
          )
            throw conflict();
          doneHash = attempt.goalHash;
          doneEpoch = attempt.deliveryEpoch;
          data.attempt = null;
        } else {
          if (
            data.attempt ||
            goalHash !== lease.goalHash ||
            deliveryEpoch !== lease.deliveryEpoch
          )
            throw conflict();
          doneHash = goalHash;
          doneEpoch = lease.deliveryEpoch;
        }
        // Only the original attempt's goal is acknowledged. A newer committed
        // goal remains dirty and is delivered after this ambiguous write settles.
        data.remote = remote;
        await saveSource(client, lease, data, doneHash, doneEpoch);
        // Retained admission has no local upload worker. Keep its exact goal
        // eligible for bounded inspection until Team initializes the member.
        if (
          input.observePending === true &&
          remote?.pendingShareId &&
          doneHash === goalHash &&
          doneEpoch === deliveryEpoch &&
          lease.goal.desired === "present"
        )
          await client.query(
            "update collaboration_sharing_selection_sources set done_goal_hash=null,done_delivery_epoch=null,available_at=now()+interval '30 seconds' where id=$1 and lease_version=$2",
            [lease.sourceId, lease.leaseVersion]
          );
      });
    },
    async deferSource(lease: SelectionSharingSourceLease, seconds = 30) {
      return transaction(pool, async (client) => {
        await loadSource(client, lease);
        await client.query(
          `update collaboration_sharing_selection_sources set locked_at=null,attempt_count=attempt_count+1,
          available_at=now()+make_interval(secs=>$3),updated_at=now() where id=$1 and lease_version=$2`,
          [
            lease.sourceId,
            lease.leaseVersion,
            Math.max(1, Math.min(300, seconds))
          ]
        );
      });
    },
    async readSourceState(
      identity: SelectionSharingIdentity,
      sourceId: string
    ) {
      return transaction(pool, async (client) => {
        const rows = await client.query<Row>(
          `select source.* from collaboration_sharing_selection_sources source
          join collaboration_sharing_selection_progress progress on progress.id=source.progress_id
          join collaboration_shared_memory_enrollments enrollment on enrollment.id=progress.enrollment_id and enrollment.revoked_at is null
          where source.id=$1 and enrollment.backend_id=$2 and enrollment.local_owner_user_id=$3 and enrollment.upstream_user_id=$4`,
          [
            sourceId,
            identity.backendId,
            identity.localOwnerUserId,
            identity.upstreamUserId
          ]
        );
        return rows.rows[0] ? readSource(identity, rows.rows[0]) : null;
      });
    }
  };
};

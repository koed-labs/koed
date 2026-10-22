import type pg from "pg";
import {
  crossIdentitySyncDigest,
  crossIdentitySyncDeterministicUuid,
  curatedWithdrawalManifestHash
} from "@koed/shared";
import type {
  CuratedClassificationOperation,
  CuratedMemoryRepository
} from "./curated-memory-repository.js";
import type { CuratedMemoryRepositoryContext } from "./curated-memory-support.js";
import { sessionExactCuratedAssertionSql } from "./approval-activity-sql.js";

type OperationRow = {
  id: string;
  owner_user_id: string;
  assertion_id: string;
  expected_version: number;
  next_version: number;
  target_scope: CuratedClassificationOperation["scope"];
  target_project_id: string | null;
  manifest: CuratedClassificationOperation["manifest"];
  manifest_hash: string;
  backend_acks: CuratedClassificationOperation["backendAcks"];
  state: CuratedClassificationOperation["state"];
};

const mapOperation = (row: OperationRow): CuratedClassificationOperation => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  assertionId: row.assertion_id,
  expectedVersion: row.expected_version,
  nextVersion: row.next_version,
  scope: row.target_scope,
  projectId: row.target_project_id,
  manifest: row.manifest,
  backendAcks: row.backend_acks,
  state: row.state
});

const transaction = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

const assertNonConversationProjectSources = async (
  client: pg.PoolClient,
  ownerUserId: string,
  assertionId: string,
  projectId: string
): Promise<void> => {
  const mismatch = await client.query(
    `select 1 from curated_memory_sources source
       left join project_source_revisions revision
         on revision.id=source.project_source_revision_id
        and revision.owner_user_id=$1 and revision.state='ready'
       left join project_sources document
         on document.id=revision.source_id
        and document.owner_user_id=$1 and document.deleted_at is null
        and document.remove_batch_id is null and document.status='ready'
        and document.kind='doc'
       left join personal_note_revisions note_revision
         on note_revision.id=revision.note_revision_id
        and note_revision.owner_user_id=$1
        and note_revision.projection_state='available'
        and note_revision.forgotten_at is null
       left join personal_notes note
         on note.id=note_revision.note_id and note.owner_user_id=$1
        and note.lifecycle='active'
       left join project_work_items work_item
         on work_item.id=source.project_work_item_id
        and work_item.owner_user_id=$1 and work_item.deleted_at is null
      where source.assertion_id=$2
        and source.source_role in (
          'primary_evidence','supporting_evidence',
          'superseding_evidence','conflicting_evidence')
        and ((source.source_type='project_source_note_revision'
               and (document.project_id is distinct from $3::uuid
                    or note.id is null))
          or (source.source_type='project_work_item'
               and work_item.project_id is distinct from $3::uuid))
      limit 1`,
    [ownerUserId, assertionId, projectId]
  );
  if (mismatch.rows[0])
    throw Object.assign(
      new Error("Curated source Project does not match classification"),
      { statusCode: 409 }
    );
};

export const createCuratedMemoryClassificationMethods = ({
  pool,
  onCuratedMemoryChanged
}: CuratedMemoryRepositoryContext): Pick<
  CuratedMemoryRepository,
  | "prepareCuratedClassification"
  | "listPendingCuratedClassifications"
  | "listPendingCuratedClassificationWork"
  | "prepareLegacyCuratedActivationBatch"
  | "deferCuratedClassificationRetry"
  | "recordCuratedClassificationAck"
  | "commitCuratedClassification"
> => ({
  async prepareCuratedClassification(actor, input) {
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      (input.scope === "project") !== Boolean(input.projectId)
    ) {
      throw Object.assign(new Error("Invalid Curated classification"), {
        statusCode: 400
      });
    }
    return transaction(pool, async (client) => {
      if (input.projectId) {
        const project = await client.query(
          `select id from projects where id=$1 and owner_user_id=$2
             and lifecycle='active' and deletion_phase is null for update`,
          [input.projectId, actor.userId]
        );
        if (!project.rows[0])
          throw Object.assign(new Error("Personal Project is unavailable"), {
            statusCode: 409
          });
      }
      const assertion = await client.query<{ classification_version: number }>(
        `select classification_version from curated_memory_assertions
          where id=$1 and owner_user_id=$2 for update`,
        [input.assertionId, actor.userId]
      );
      if (
        !assertion.rows[0] ||
        assertion.rows[0].classification_version !== input.expectedVersion
      ) {
        throw Object.assign(
          new Error("Curated classification version changed"),
          { statusCode: 409 }
        );
      }
      if (input.projectId) {
        await assertNonConversationProjectSources(
          client,
          actor.userId,
          input.assertionId,
          input.projectId
        );
      }
      const prior = await client.query<OperationRow>(
        `select * from curated_memory_classification_operations
          where assertion_id=$1 and next_version=$2 for update`,
        [input.assertionId, input.expectedVersion + 1]
      );
      if (prior.rows[0]) {
        if (
          prior.rows[0].target_scope !== input.scope ||
          prior.rows[0].target_project_id !== (input.projectId ?? null)
        ) {
          throw Object.assign(new Error("Another classification is pending"), {
            statusCode: 409
          });
        }
        return mapOperation(prior.rows[0]);
      }
      const grantRows = await client.query<{
        backend_id: string;
        local_session_id: string;
        logical_memory_id: string;
      }>(
        `select distinct enrollment.backend_id,local_source.local_session_id,
                local_source.logical_memory_id
           from local_captured_session_logical_memories local_source
           join collaboration_shared_memory_companion_bindings binding
             on binding.logical_memory_id=local_source.logical_memory_id
           join collaboration_shared_memory_enrollments enrollment
             on enrollment.id=binding.enrollment_id
            and enrollment.local_owner_user_id=$1
          where local_source.owner_user_id=$1
         union
         select distinct enrollment.backend_id,local_source.local_session_id,
                local_source.logical_memory_id
           from collaboration_pending_share_source_work work
           join collaboration_shared_memory_enrollments enrollment
             on enrollment.id=work.enrollment_id
            and enrollment.local_owner_user_id=$1
            and enrollment.revoked_at is null
           join local_captured_session_logical_memories local_source
             on local_source.logical_memory_id=work.logical_memory_id
            and local_source.owner_user_id=$1
           join curated_memory_assertions cma
             on cma.id=$2 and cma.owner_user_id=$1
          where work.include_curated_memory=true
            and work.consent_id is not null
            and work.curated_material_commitment_hash is not null
            and ${sessionExactCuratedAssertionSql("$1", "local_source.local_session_id")}
          order by backend_id,logical_memory_id`,
        [actor.userId, input.assertionId]
      );
      const groups = new Map<
        string,
        CuratedClassificationOperation["manifest"][number]
      >();
      for (const row of grantRows.rows) {
        const key = `${row.backend_id}:${row.logical_memory_id}`;
        let group = groups.get(key);
        if (!group) {
          group = {
            backendId: row.backend_id,
            source: {
              kind: "captured_session",
              sessionId: row.local_session_id,
              logicalMemoryId: row.logical_memory_id
            },
            items: []
          };
          groups.set(key, group);
        }
        // The recipient derives its complete historical grant set under its
        // publication lock. Cached source-side grant rows are not an authority
        // for that set and need not fit inside the request envelope.
      }
      const manifest = [...groups.values()];
      const manifestHash = crossIdentitySyncDigest({
        protocol: "koed.curated-classification-manifest/v1",
        assertionId: input.assertionId,
        expectedVersion: input.expectedVersion,
        scope: input.scope,
        projectId: input.projectId ?? null,
        manifest
      });
      const inserted = await client.query<OperationRow>(
        `insert into curated_memory_classification_operations (
           owner_user_id,assertion_id,expected_version,next_version,
           target_scope,target_project_id,manifest,manifest_hash
         ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) returning *`,
        [
          actor.userId,
          input.assertionId,
          input.expectedVersion,
          input.expectedVersion + 1,
          input.scope,
          input.projectId ?? null,
          JSON.stringify(manifest),
          manifestHash
        ]
      );
      return mapOperation(inserted.rows[0]!);
    });
  },
  async listPendingCuratedClassifications(actor) {
    const result = await pool.query<OperationRow>(
      `select * from curated_memory_classification_operations
        where owner_user_id=$1 and state in ('pending','ready')
        order by created_at,id`,
      [actor.userId]
    );
    return result.rows.map(mapOperation);
  },
  async listPendingCuratedClassificationWork() {
    const result = await pool.query<OperationRow>(
      `select * from curated_memory_classification_operations
        where state in ('pending','ready') order by updated_at,id limit 10`
    );
    return result.rows.map(mapOperation);
  },
  async prepareLegacyCuratedActivationBatch(limit = 10) {
    const result = await pool.query<{
      id: string;
      owner_user_id: string;
      classification_version: number;
    }>(
      `select a.id,a.owner_user_id,a.classification_version
         from curated_memory_assertions a
        where a.scope_activation_state='pending'
          and not exists (
            select 1 from curated_memory_classification_operations op
             where op.assertion_id=a.id and op.state in ('pending','ready','complete')
          ) order by a.id limit $1`,
      [Math.min(Math.max(limit, 1), 50)]
    );
    const prepared: CuratedClassificationOperation[] = [];
    for (const row of result.rows) {
      try {
        prepared.push(
          await this.prepareCuratedClassification(
            { userId: row.owner_user_id },
            {
              assertionId: row.id,
              expectedVersion: row.classification_version,
              scope: "unscoped"
            }
          )
        );
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 409) throw error;
      }
    }
    return prepared;
  },
  async deferCuratedClassificationRetry(actor, operationId) {
    await pool.query(
      `update curated_memory_classification_operations
          set updated_at=now()
        where id=$1 and owner_user_id=$2 and state in ('pending','ready')`,
      [operationId, actor.userId]
    );
  },
  async recordCuratedClassificationAck(
    actor,
    operationId,
    backendId,
    sourceLogicalMemoryId,
    receipt,
    expectedManifestHash
  ) {
    return transaction(pool, async (client) => {
      const result = await client.query<OperationRow>(
        `select * from curated_memory_classification_operations
          where id=$1 and owner_user_id=$2 for update`,
        [operationId, actor.userId]
      );
      const row = result.rows[0];
      if (!row)
        throw Object.assign(new Error("Classification operation not found"), {
          statusCode: 404
        });
      const group = row.manifest.find(
        (entry) =>
          entry.backendId === backendId &&
          entry.source.logicalMemoryId === sourceLogicalMemoryId
      );
      const expectedMutationId = crossIdentitySyncDeterministicUuid({
        protocol: "koed.curated-withdrawal-group/v1",
        operationId: row.id,
        backendId,
        sourceLogicalMemoryId
      });
      const sourceIdentity = group
        ? await client.query<{
            source_deployment_protocol_id: string;
            source_owner_principal_id: string;
          }>(
            `select deployment.protocol_deployment_id as source_deployment_protocol_id,
                    identity.owner_principal_id as source_owner_principal_id
               from local_captured_session_logical_memories local_source
               join captured_session_logical_memories identity
                 on identity.logical_memory_id=local_source.logical_memory_id
               join logical_memories memory
                 on memory.id=local_source.logical_memory_id
               join deployment_identities deployment
                 on deployment.id=memory.origin_deployment_identity_id
              where local_source.logical_memory_id=$1
                and local_source.owner_user_id=$2
                and local_source.local_session_id=$3
                and identity.source_session_id=$3`,
            [sourceLogicalMemoryId, actor.userId, group.source.sessionId]
          )
        : null;
      const verifiedIdentity = sourceIdentity?.rows[0];
      const immutableRequestHash =
        group && verifiedIdentity
          ? curatedWithdrawalManifestHash({
              mutationId: expectedMutationId,
              assertionId: row.assertion_id,
              source: group.source,
              sourceDeploymentProtocolId:
                verifiedIdentity.source_deployment_protocol_id,
              sourceOwnerPrincipalId:
                verifiedIdentity.source_owner_principal_id,
              classificationVersion: row.expected_version,
              items: group.items
            })
          : null;
      if (
        !group ||
        !immutableRequestHash ||
        expectedMutationId !== receipt.mutationId ||
        row.expected_version !== receipt.appliedVersion ||
        expectedManifestHash !== immutableRequestHash ||
        expectedManifestHash !== receipt.manifestHash
      ) {
        throw Object.assign(new Error("Withdrawal receipt conflicts"), {
          statusCode: 409
        });
      }
      const previous = row.backend_acks.find(
        (ack) =>
          ack.backendId === backendId &&
          ack.logicalMemoryId === sourceLogicalMemoryId
      );
      if (previous && previous.manifestHash !== receipt.manifestHash) {
        throw Object.assign(new Error("Withdrawal receipt changed"), {
          statusCode: 409
        });
      }
      if (!previous)
        row.backend_acks.push({
          backendId,
          logicalMemoryId: sourceLogicalMemoryId,
          manifestHash: receipt.manifestHash
        });
      const state = row.manifest.every((entry) =>
        row.backend_acks.some(
          (ack) =>
            ack.backendId === entry.backendId &&
            ack.logicalMemoryId === entry.source.logicalMemoryId
        )
      )
        ? "ready"
        : "pending";
      const updated = await client.query<OperationRow>(
        `update curated_memory_classification_operations
            set backend_acks=$2::jsonb,state=$3,updated_at=now()
          where id=$1 returning *`,
        [operationId, JSON.stringify(row.backend_acks), state]
      );
      return mapOperation(updated.rows[0]!);
    });
  },
  async commitCuratedClassification(actor, operationId) {
    return transaction(pool, async (client) => {
      const identity = await client.query<{
        assertion_id: string;
        target_project_id: string | null;
      }>(
        `select assertion_id,target_project_id
           from curated_memory_classification_operations
          where id=$1 and owner_user_id=$2`,
        [operationId, actor.userId]
      );
      if (!identity.rows[0])
        throw Object.assign(new Error("Classification operation not found"), {
          statusCode: 404
        });
      if (identity.rows[0].target_project_id) {
        const project = await client.query(
          `select id from projects where id=$1 and owner_user_id=$2
             and lifecycle='active' and deletion_phase is null for update`,
          [identity.rows[0].target_project_id, actor.userId]
        );
        if (!project.rows[0])
          throw Object.assign(new Error("Personal Project is unavailable"), {
            statusCode: 409
          });
      }
      await client.query(
        `select id from curated_memory_assertions
          where id=$1 and owner_user_id=$2 for update`,
        [identity.rows[0].assertion_id, actor.userId]
      );
      const result = await client.query<OperationRow>(
        `select * from curated_memory_classification_operations
          where id=$1 and owner_user_id=$2 for update`,
        [operationId, actor.userId]
      );
      const row = result.rows[0];
      if (!row)
        throw Object.assign(new Error("Classification operation not found"), {
          statusCode: 404
        });
      if (row.state === "complete") return mapOperation(row);
      if (
        row.state !== "ready" &&
        !(row.state === "pending" && row.manifest.length === 0)
      ) {
        throw Object.assign(new Error("Team withdrawal is pending"), {
          statusCode: 409
        });
      }
      if (row.target_project_id !== identity.rows[0].target_project_id)
        throw Object.assign(new Error("Classification target changed"), {
          statusCode: 409
        });
      const linked = await client.query<{
        backend_id: string;
        logical_memory_id: string;
        local_session_id: string;
      }>(
        `select distinct enrollment.backend_id,source.logical_memory_id,
                source.local_session_id
           from local_captured_session_logical_memories source
           join collaboration_shared_memory_companion_bindings binding
             on binding.logical_memory_id=source.logical_memory_id
           join collaboration_shared_memory_enrollments enrollment
             on enrollment.id=binding.enrollment_id
          where source.owner_user_id=$1 and enrollment.local_owner_user_id=$1
         union
         select distinct enrollment.backend_id,source.logical_memory_id,
                source.local_session_id
           from collaboration_pending_share_source_work work
           join collaboration_shared_memory_enrollments enrollment
             on enrollment.id=work.enrollment_id
            and enrollment.local_owner_user_id=$1
            and enrollment.revoked_at is null
           join local_captured_session_logical_memories source
             on source.logical_memory_id=work.logical_memory_id
            and source.owner_user_id=$1
           join curated_memory_assertions cma
             on cma.id=$2 and cma.owner_user_id=$1
          where work.include_curated_memory=true
            and work.consent_id is not null
            and work.curated_material_commitment_hash is not null
            and ${sessionExactCuratedAssertionSql("$1", "source.local_session_id")}`,
        [actor.userId, row.assertion_id]
      );
      if (row.target_project_id)
        await assertNonConversationProjectSources(
          client,
          actor.userId,
          row.assertion_id,
          row.target_project_id
        );
      const acknowledged = new Set(
        row.manifest.map(
          (entry) => `${entry.backendId}:${entry.source.logicalMemoryId}`
        )
      );
      const newlyLinked = linked.rows.filter(
        (entry) =>
          !acknowledged.has(`${entry.backend_id}:${entry.logical_memory_id}`)
      );
      if (newlyLinked.length) {
        const expanded = [
          ...row.manifest,
          ...newlyLinked.map((entry) => ({
            backendId: entry.backend_id,
            source: {
              kind: "captured_session" as const,
              sessionId: entry.local_session_id,
              logicalMemoryId: entry.logical_memory_id
            },
            items: []
          }))
        ];
        const expandedHash = crossIdentitySyncDigest({
          protocol: "koed.curated-classification-manifest/v1",
          assertionId: row.assertion_id,
          expectedVersion: row.expected_version,
          scope: row.target_scope,
          projectId: row.target_project_id,
          manifest: expanded
        });
        const retry = await client.query<OperationRow>(
          `update curated_memory_classification_operations
              set manifest=$2::jsonb,manifest_hash=$3,state='pending',
                  updated_at=now() where id=$1 returning *`,
          [operationId, JSON.stringify(expanded), expandedHash]
        );
        return mapOperation(retry.rows[0]!);
      }
      // A co-located Team copy is withdrawn in this very transaction. Remote
      // Team copies have already supplied their separate atomic ACKs above.
      const localRoots = await client.query<{
        logical_memory_id: string;
        owner_principal_id: string;
      }>(
        `select source.logical_memory_id,identity.owner_principal_id
           from local_captured_session_logical_memories source
           join captured_session_logical_memories identity
             on identity.logical_memory_id=source.logical_memory_id
          where source.owner_user_id=$1
          order by source.logical_memory_id,identity.owner_principal_id`,
        [actor.userId]
      );
      for (const root of localRoots.rows) {
        await client.query(
          `select koed_lock_shared_memory_publication_fence($1)`,
          [root.logical_memory_id]
        );
        await client.query(
          `insert into team_memory_curated_assertion_fences (
             logical_memory_id,assertion_id,owner_principal_id,
             classification_version,mutation_id,manifest_hash
           ) values ($1,$2,$3,$4,$5,$6)
           on conflict (logical_memory_id,assertion_id) do update
             set classification_version=greatest(
                   team_memory_curated_assertion_fences.classification_version,
                   excluded.classification_version),withdrawn_at=now()
             where team_memory_curated_assertion_fences.classification_version
                   <=excluded.classification_version`,
          [
            root.logical_memory_id,
            row.assertion_id,
            root.owner_principal_id,
            row.expected_version,
            row.id,
            row.manifest_hash
          ]
        );
      }
      await client.query(
        `insert into team_memory_curated_item_eligibility (
           semantic_item_id,representation_id,share_grant_id,team_id,
           team_workspace_id,logical_memory_id,pseudonymous_source_id,
           pinned_revision_hash,blocked_at
         ) select item.id,item.representation_id,item.share_grant_id,
                  item.team_id,item.team_workspace_id,item.logical_memory_id,
                  item.pseudonymous_source_id,null,now()
             from team_memory_semantic_items item
             join team_memory_representations representation
               on representation.id=item.representation_id
             join team_memory_share_grants grant_row
               on grant_row.id=item.share_grant_id
             join local_captured_session_logical_memories source
               on source.logical_memory_id=grant_row.logical_memory_id
              and source.owner_user_id=grant_row.owner_user_id
            where grant_row.owner_user_id=$1
              and representation.representation='curated_assertions'
              and item.pseudonymous_source_id=
                koed_grant_scoped_curated_source_id(grant_row.id,$2::uuid)
         on conflict (semantic_item_id) do update
           set blocked_at=now(),updated_at=now()`,
        [actor.userId, row.assertion_id]
      );
      for (const dimensions of [384, 1024, 1536, 3072] as const) {
        await client.query(
          `delete from team_memory_semantic_vectors_${dimensions} vector_row
            using team_memory_curated_item_eligibility eligibility,
                  team_memory_semantic_items item,
                  team_memory_share_grants grant_row,
                  local_captured_session_logical_memories source
           where vector_row.semantic_item_id=eligibility.semantic_item_id
             and eligibility.semantic_item_id=item.id
             and item.share_grant_id=grant_row.id
             and source.logical_memory_id=grant_row.logical_memory_id
             and source.owner_user_id=grant_row.owner_user_id
             and grant_row.owner_user_id=$1
             and eligibility.pseudonymous_source_id=
               koed_grant_scoped_curated_source_id(grant_row.id,$2::uuid)`,
          [actor.userId, row.assertion_id]
        );
      }
      await client.query(
        `update team_memory_representations representation
            set state='invalidated',
                invalidated_at=coalesce(invalidated_at,now()),
                invalidation_reason_code='curated_classification_changed',
                record_version=record_version+1,updated_at=now()
           from team_memory_semantic_items item,
                team_memory_share_grants grant_row,
                local_captured_session_logical_memories source
          where item.representation_id=representation.id
            and item.share_grant_id=grant_row.id
            and source.logical_memory_id=grant_row.logical_memory_id
            and source.owner_user_id=grant_row.owner_user_id
            and grant_row.owner_user_id=$1
            and representation.representation='curated_assertions'
            and representation.frozen_snapshot=false
            and representation.state in ('pending','available','stale')
            and item.pseudonymous_source_id=
              koed_grant_scoped_curated_source_id(grant_row.id,$2::uuid)`,
        [actor.userId, row.assertion_id]
      );
      const assertion = await client.query(
        `update curated_memory_assertions
            set scope=$3,project_id=$4,classification_version=$5,
                scope_activation_state='active',updated_at=now()
          where id=$1 and owner_user_id=$2 and classification_version=$6
          returning id`,
        [
          row.assertion_id,
          actor.userId,
          row.target_scope,
          row.target_project_id,
          row.next_version,
          row.expected_version
        ]
      );
      if (!assertion.rows[0]) {
        throw Object.assign(
          new Error("Classification source version changed"),
          { statusCode: 409 }
        );
      }
      await onCuratedMemoryChanged?.(actor, client, [row.assertion_id]);
      const updated = await client.query<OperationRow>(
        `update curated_memory_classification_operations
            set state='complete',updated_at=now() where id=$1 returning *`,
        [operationId]
      );
      return mapOperation(updated.rows[0]!);
    });
  }
});

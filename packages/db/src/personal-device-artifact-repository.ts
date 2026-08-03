import { createHash } from "node:crypto";
import pg from "pg";
import {
  canonicalizePdsJson,
  pdsArtifactCompatibilityHash,
  pdsPortableLcmNodeContentHash,
  pdsPortableLcmNodeId,
  pdsPortableMemoryEventContentHash,
  pdsPortableMemoryEventId,
  pdsPortableMemoryEmbeddingId,
  pdsPortableMemoryEmbeddingWorkIdentity,
  pdsPortableEmbeddingSourceHash,
  pdsPortableEmbeddingVectorHash,
  type PdsArtifactRecord,
  type PdsEmbeddingContractV1,
  type PdsLcmNodeContractV1,
  type PdsMemoryEventContractV1,
  type PdsPortableLcmNodeV1,
  type PdsPortableMemoryEmbeddingV1,
  type PdsPortableMemoryEventV1
} from "@koed/shared";
import { CURRENT_CONVERSATION_PROJECTION_VERSION } from "./conversation-semantic-projection.js";
import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  TOKEN_COUNTER_CONTRACT_VERSION
} from "@koed/core";
import { embeddingTableForDimensions } from "./embedding-coverage.js";
import { resolveSupportedEmbeddingModelConfig } from "@koed/shared";

export type PdsSemanticWorkClass =
  | "projection"
  | "memory_embedding"
  | "lcm_leaf"
  | "lcm_rollup";

export interface PdsSemanticWorkClaimRecord {
  workIdentity: string;
  workClass: PdsSemanticWorkClass;
  compatibilityContractHash: string;
  claimantDeviceId: string;
  claimGeneration: string;
  claimedAt: string;
  expiresAt: string;
}

export interface PdsPortableMemoryEventCandidate {
  localMemoryEventId: string;
  localSessionId: string;
  groupId: string;
  sourcePackageId: string;
  sourceManifestHash: string;
  sourceFingerprint: string;
  sourceClosureHash: string;
  workIdentity: string;
  compatibilityContract: PdsMemoryEventContractV1;
  event: PdsPortableMemoryEventV1;
}

export interface PdsClaimedArtifactOutboxEntry {
  id: string;
  groupId: string;
  artifactId: string;
  packageId: string;
  manifestHash: string;
  attemptCount: number;
  transportId: string | null;
}

export interface PdsPortableMemoryEmbeddingCandidate {
  localMemoryEmbeddingId: string;
  localSessionId: string;
  groupId: string;
  sourcePackageId: string;
  sourceManifestHash: string;
  sourceFingerprint: string;
  sourceClosureHash: string;
  workIdentity: string;
  compatibilityContract: PdsEmbeddingContractV1;
  embedding: PdsPortableMemoryEmbeddingV1;
}

export interface PdsMemoryEmbeddingClaimCandidate {
  localSourceType: "memory_event" | "lcm_node";
  localSourceId: string;
  logicalSourceId: string;
  sourceContentHash: string;
  workIdentity: string;
  compatibilityContractHash: string;
}

export interface PdsPortableLcmNodeCandidate {
  localMemoryNodeId: string;
  localSessionId: string;
  groupId: string;
  sourcePackageId: string;
  sourceManifestHash: string;
  sourceFingerprint: string;
  sourceClosureHash: string;
  workIdentity: string;
  workClass: "lcm_leaf" | "lcm_rollup";
  compatibilityContract: PdsLcmNodeContractV1;
  node: PdsPortableLcmNodeV1;
}

export interface PersonalDeviceArtifactRepository {
  listPdsPortableMemoryEventCandidates(input: {
    userId: string;
    groupId: string;
    limit?: number;
  }): Promise<PdsPortableMemoryEventCandidate[]>;
  listPdsPortableMemoryEmbeddingCandidates(input: {
    userId: string;
    groupId: string;
    contract: PdsEmbeddingContractV1;
    limit?: number;
  }): Promise<PdsPortableMemoryEmbeddingCandidate[]>;
  listPdsMemoryEmbeddingClaimCandidates(input: {
    userId: string;
    groupId: string;
    contract: PdsEmbeddingContractV1;
    limit?: number;
  }): Promise<PdsMemoryEmbeddingClaimCandidate[]>;
  listPdsPortableLcmNodeCandidates(input: {
    userId: string;
    groupId: string;
    limit?: number;
  }): Promise<PdsPortableLcmNodeCandidate[]>;
  acquirePdsSemanticWorkClaim(input: {
    userId: string;
    groupId: string;
    deviceId: string;
    workIdentity: string;
    workClass: PdsSemanticWorkClass;
    compatibilityContractHash: string;
    leaseSeconds?: number;
  }): Promise<PdsSemanticWorkClaimRecord | null>;
  recordPdsSemanticWorkClaim(input: {
    userId: string;
    groupId: string;
    claim: PdsSemanticWorkClaimRecord;
    localSource?: {
      sourceType: "memory_event" | "lcm_node";
      sourceId: string;
      contentHash: string;
    };
  }): Promise<boolean>;
  renewPdsSemanticWorkClaim(input: {
    userId: string;
    groupId: string;
    deviceId: string;
    workIdentity: string;
    claimGeneration: string;
    leaseSeconds?: number;
  }): Promise<PdsSemanticWorkClaimRecord | null>;
  completePdsSemanticWorkClaim(input: {
    userId: string;
    groupId: string;
    deviceId: string;
    workIdentity: string;
    claimGeneration: string;
  }): Promise<boolean>;
  stagePdsPortableArtifact(input: {
    userId: string;
    groupId: string;
    localSessionId: string;
    localMemoryEventId?: string;
    localMemoryEmbeddingId?: string;
    localMemoryNodeId?: string;
    record: PdsArtifactRecord;
    transportManifestHash: string;
    encryptedEnvelope: unknown;
  }): Promise<{ id: string; inserted: boolean }>;
  listPdsPendingArtifactClaimCompletions(input: {
    userId: string;
    groupId: string;
    producerDeviceId: string;
    limit?: number;
  }): Promise<
    Array<{
      artifactId: string;
      workIdentity: string;
      claimGeneration: string;
    }>
  >;
  markPdsArtifactClaimCompleted(input: {
    userId: string;
    groupId: string;
    artifactId: string;
    producerDeviceId: string;
    claimGeneration: string;
  }): Promise<boolean>;
  claimPdsArtifactOutbox(input: {
    workerId: string;
    limit?: number;
    leaseSeconds?: number;
    state?: "pending" | "committed";
  }): Promise<PdsClaimedArtifactOutboxEntry[]>;
  beginPdsArtifactOutboxNetworkAction(input: {
    workerId: string;
    outboxId: string;
  }): Promise<boolean>;
  getPdsArtifactOutboxEncryptedEnvelope(input: {
    workerId: string;
    outboxId: string;
  }): Promise<{ encryptedEnvelope: unknown } | null>;
  completePdsArtifactOutbox(input: {
    workerId: string;
    outboxId: string;
    state: "committed" | "acked";
    transportId: string;
  }): Promise<boolean>;
  releasePdsCommittedArtifactOutbox(input: {
    workerId: string;
    outboxId: string;
  }): Promise<boolean>;
  retryPdsArtifactOutbox(input: {
    workerId: string;
    outboxId: string;
    errorClass: string;
    retryAt: Date;
  }): Promise<boolean>;
  importPdsPortableArtifact(input: {
    userId: string;
    groupId: string;
    inboxId: string;
    workerId: string;
    transportManifestHash: string;
    record: PdsArtifactRecord;
    encryptedEnvelope: unknown;
  }): Promise<{
    state: "ready" | "incompatible";
    localSourceId: string | null;
  }>;
}

interface PersonalDeviceArtifactRepositoryDependencies {
  getEmbeddableSource(
    sourceType: "memory_event" | "memory_node",
    sourceId: string
  ): Promise<{
    ownerUserId: string | null;
    text: string;
    sourceHash: string;
  } | null>;
}

const iso = (value: Date): string => value.toISOString();
const leaseSeconds = (value: number | undefined): number =>
  Math.min(Math.max(value ?? 60, 5), 3600);
const claimRecord = (row: {
  work_identity: string;
  work_class: string;
  compatibility_contract_hash: string;
  claimant_device_id: string;
  claim_generation: string;
  claimed_at: Date;
  expires_at: Date;
}): PdsSemanticWorkClaimRecord => ({
  workIdentity: row.work_identity,
  workClass: row.work_class as PdsSemanticWorkClass,
  compatibilityContractHash: row.compatibility_contract_hash,
  claimantDeviceId: row.claimant_device_id,
  claimGeneration: row.claim_generation,
  claimedAt: iso(row.claimed_at),
  expiresAt: iso(row.expires_at)
});

const portableMetadataKeys = new Set([
  "projectionVersion",
  "semanticUnitType",
  "semanticSourceActors",
  "semanticBundleSealedReason",
  "includeInLcm",
  "includeInEmbedding",
  "embeddingContent",
  "lcmContent",
  "tokenCount",
  "tokenModel",
  "semanticItemManifest",
  "sourceAdapterVersion",
  "sourceChunkIndex",
  "sourceChunkCount",
  "sourceItemCount",
  "externalSessionId",
  "externalThreadId",
  "externalTurnId",
  "logicalSourceId",
  "logicalSourceIds"
]);

const portableMemoryEventMetadata = (
  value: unknown,
  sourceOrdinalsByItemId: Map<string, string>
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metadata = value as Record<string, unknown>;
  const portable = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => portableMetadataKeys.has(key))
  );
  if (Array.isArray(metadata.semanticItemManifest)) {
    portable.semanticItemManifest = metadata.semanticItemManifest.map(
      (item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
          return item;
        const sourceItem = item as Record<string, unknown>;
        const sourceIds = Array.isArray(sourceItem.sourceIds)
          ? sourceItem.sourceIds.filter(
              (id): id is string => typeof id === "string"
            )
          : [];
        const { sourceIds: _sourceIds, ...rest } = sourceItem;
        void _sourceIds;
        return {
          ...rest,
          sourceOrdinals: sourceIds
            .map((id) => sourceOrdinalsByItemId.get(id))
            .filter((ordinal): ordinal is string => Boolean(ordinal))
        };
      }
    );
  }
  return portable;
};

export const createPersonalDeviceArtifactRepository = (
  pool: pg.Pool,
  dependencies: PersonalDeviceArtifactRepositoryDependencies
): PersonalDeviceArtifactRepository => ({
  async listPdsPortableMemoryEventCandidates(input) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
    const result = await pool.query<{
      local_memory_event_id: string;
      local_session_id: string;
      package_id: string;
      source_manifest_hash: string;
      source_fingerprint: string;
      source_closure_hash: string;
      source_ordinals: string[];
      source_item_ids: string[];
      event_type: PdsPortableMemoryEventV1["eventType"];
      payload: Record<string, unknown>;
      include_in_embedding: boolean;
      include_in_lcm: boolean;
      token_count: number;
      seal_reason: string;
      source_event_time: Date;
      source_sequence: string;
      projection_policy_key: string;
      projection_policy_revision: string;
      projection_algorithm_version: string;
      token_counter: string;
    }>(
      `with replica_packages as (
         select distinct on (o.replica_id)
           o.replica_id,p.group_id,p.package_id,p.source_manifest_hash,
           p.source_fingerprint,p.source_closure_hash
         from pds_replica_observations o
         join pds_retained_packages p on p.id=o.retained_package_id
         where p.state='ready' and p.source_fingerprint is not null
           and p.source_closure_hash is not null
         order by o.replica_id,o.source_sequence::numeric desc,o.id desc
       ), mapped_sources as (
         select sim.conversation_item_id,sim.source_ordinal,c.group_id,
           c.package_id,c.source_manifest_hash,p.source_fingerprint,
           c.source_closure_hash
         from pds_source_item_mappings sim
         join pds_session_closures c on c.id=sim.closure_id and c.state='ready'
         join pds_retained_packages p on p.group_id=c.group_id
           and p.package_id=c.package_id and p.state='ready'
         where sim.closure_id is not null and p.source_fingerprint is not null
           and p.source_closure_hash=c.source_closure_hash
         union all
         select sim.conversation_item_id,sim.source_ordinal,rp.group_id,
           rp.package_id,rp.source_manifest_hash,rp.source_fingerprint,
           rp.source_closure_hash
         from pds_source_item_mappings sim
         join replica_packages rp on rp.replica_id=sim.replica_id
         where sim.replica_id is not null
       ), candidates as (
         select me.id as local_memory_event_id,me.session_id as local_session_id,
           ms.group_id,min(ms.package_id) as package_id,
           min(ms.source_manifest_hash) as source_manifest_hash,
           min(ms.source_fingerprint) as source_fingerprint,
           min(ms.source_closure_hash) as source_closure_hash,
           array_agg(ms.source_ordinal order by mes.source_order,ms.source_ordinal::numeric)
             as source_ordinals,
           array_agg(mes.conversation_item_id::text order by mes.source_order,ms.source_ordinal::numeric)
             as source_item_ids,
           me.event_type,me.payload,me.include_in_embedding,me.include_in_lcm,
           me.token_count,me.seal_reason,me.source_event_time,
           me.source_sequence::text as source_sequence,
           me.projection_policy_key,me.projection_policy_revision::text
             as projection_policy_revision,
           me.projection_algorithm_version,me.token_counter,
           count(*) as mapped_count,
           count(distinct ms.package_id) as package_count
         from memory_events me
         join memory_event_sources mes on mes.memory_event_id=me.id
         join mapped_sources ms on ms.conversation_item_id=mes.conversation_item_id
         join personal_device_groups g on g.id=ms.group_id
         join local_personal_identities i on i.id=g.local_personal_identity_id
         where i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
           and me.owner_user_id=$1 and me.visibility='personal'
           and me.session_id is not null and me.invalidated_at is null
           and me.personal_deleted_at is null
           and me.token_count is not null and me.seal_reason is not null
           and me.source_event_time is not null and me.source_sequence is not null
           and me.projection_policy_key is not null
           and me.projection_policy_revision is not null
           and me.projection_algorithm_version is not null
           and me.token_counter is not null
           and not exists (
             select 1 from pds_memory_event_mappings pem
             where pem.memory_event_id=me.id and pem.group_id=ms.group_id
           )
         group by me.id,ms.group_id
       )
       select * from candidates c
       where c.package_count=1
         and c.mapped_count=(
           select count(*) from memory_event_sources expected
           where expected.memory_event_id=c.local_memory_event_id
         )
       order by c.source_event_time,c.local_memory_event_id
       limit $3`,
      [input.userId, input.groupId, limit]
    );
    return result.rows.flatMap((row) => {
      const actor =
        typeof row.payload.actor === "string" ? row.payload.actor : null;
      const content =
        typeof row.payload.content === "string" ? row.payload.content : null;
      const rawEventType =
        typeof row.payload.rawEventType === "string"
          ? row.payload.rawEventType
          : null;
      if (!actor || content === null || !rawEventType) return [];
      const sourceOrdinalsByItemId = new Map(
        row.source_item_ids.map((id, index) => [
          id,
          row.source_ordinals[index]!
        ])
      );
      const eventWithoutIdentity = {
        sourceOrdinals: row.source_ordinals,
        eventType: row.event_type,
        actor,
        rawEventType,
        content,
        metadata: portableMemoryEventMetadata(
          row.payload.metadata,
          sourceOrdinalsByItemId
        ),
        includeInEmbedding: row.include_in_embedding,
        includeInLcm: row.include_in_lcm,
        tokenCount: String(row.token_count),
        sealReason: row.seal_reason,
        sourceEventTime: iso(row.source_event_time),
        sourceSequence: row.source_sequence
      };
      const contentHash =
        pdsPortableMemoryEventContentHash(eventWithoutIdentity);
      const logicalEventId = pdsPortableMemoryEventId({
        sourceFingerprint: row.source_fingerprint,
        sourceClosureHash: row.source_closure_hash,
        sourceOrdinals: row.source_ordinals,
        projectionPolicyKey: row.projection_policy_key,
        projectionPolicyRevision: row.projection_policy_revision,
        contentHash
      });
      return [
        {
          localMemoryEventId: row.local_memory_event_id,
          localSessionId: row.local_session_id,
          groupId: input.groupId,
          sourcePackageId: row.package_id,
          sourceManifestHash: row.source_manifest_hash,
          sourceFingerprint: row.source_fingerprint,
          sourceClosureHash: row.source_closure_hash,
          workIdentity: logicalEventId,
          compatibilityContract: {
            artifactClass: "memory_event/v1",
            projectionPolicyKey: row.projection_policy_key,
            projectionPolicyRevision: row.projection_policy_revision,
            projectionAlgorithmVersion: row.projection_algorithm_version,
            tokenCounter: row.token_counter
          },
          event: {
            logicalEventId,
            ...eventWithoutIdentity,
            contentHash
          }
        }
      ];
    });
  },

  async listPdsMemoryEmbeddingClaimCandidates(input) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const dimensions = Number(input.contract.dimensions);
    const vectorTable = embeddingTableForDimensions(dimensions);
    const compatibilityContractHash = pdsArtifactCompatibilityHash(
      input.contract
    );
    const result = await pool.query<{
      local_source_type: "memory_event" | "lcm_node";
      local_source_id: string;
      logical_source_id: string;
      source_content_hash: string;
    }>(
      `with portable_sources as (
         select 'memory_event'::text as local_source_type,
           me.id as local_source_id,pem.logical_event_id as logical_source_id,
           pem.content_hash as source_content_hash
         from memory_events me
         join pds_memory_event_mappings pem on pem.memory_event_id=me.id
         join personal_device_groups g on g.id=pem.group_id
         join local_personal_identities i on i.id=g.local_personal_identity_id
         where i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
           and me.owner_user_id=$1 and me.visibility='personal'
           and me.include_in_embedding=true and me.invalidated_at is null
           and me.personal_deleted_at is null
         union all
         select 'lcm_node'::text as local_source_type,
           mn.id as local_source_id,pnm.logical_node_id as logical_source_id,
           pnm.content_hash as source_content_hash
         from memory_nodes mn
         join pds_lcm_node_mappings pnm on pnm.memory_node_id=mn.id
         join personal_device_groups g on g.id=pnm.group_id
         join local_personal_identities i on i.id=g.local_personal_identity_id
         where i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
           and mn.owner_user_id=$1 and mn.visibility='personal'
           and mn.summary_model is not null and mn.invalidated_at is null
           and mn.personal_deleted_at is null
       )
       select * from portable_sources source
       where not exists (
         select 1 from memory_embeddings embedding
         join ${vectorTable} vector
           on vector.memory_embedding_id=embedding.id
         where embedding.invalidated_at is null
           and embedding.personal_deleted_at is null
           and embedding.embedding_model=$3
           and embedding.embedding_dimensions=$4
           and embedding.embedding_version=$5
           and embedding.model_artifact_hash=$6
           and embedding.tokenizer=$7 and embedding.input_transform=$8
           and embedding.pooling=$9 and embedding.normalization=$10
           and (
             (source.local_source_type='memory_event'
               and embedding.memory_event_id=source.local_source_id)
             or (source.local_source_type='lcm_node'
               and embedding.memory_node_id=source.local_source_id)
           )
       )
       order by local_source_type,local_source_id limit $11`,
      [
        input.userId,
        input.groupId,
        input.contract.modelKey,
        dimensions,
        input.contract.embeddingVersion,
        input.contract.modelArtifactHash,
        input.contract.tokenizer,
        input.contract.inputTransform,
        input.contract.pooling,
        input.contract.normalization,
        limit
      ]
    );
    return result.rows.map((row) => ({
      localSourceType: row.local_source_type,
      localSourceId: row.local_source_id,
      logicalSourceId: row.logical_source_id,
      sourceContentHash: row.source_content_hash,
      workIdentity: pdsPortableMemoryEmbeddingWorkIdentity({
        logicalSourceType: row.local_source_type,
        logicalSourceId: row.logical_source_id,
        sourceContentHash: row.source_content_hash,
        compatibilityContractHash
      }),
      compatibilityContractHash
    }));
  },

  async listPdsPortableMemoryEmbeddingCandidates(input) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const dimensions = Number(input.contract.dimensions);
    const vectorTable = embeddingTableForDimensions(dimensions);
    const contractHash = pdsArtifactCompatibilityHash(input.contract);
    const result = await pool.query<{
      local_memory_embedding_id: string;
      local_source_id: string;
      local_session_id: string;
      logical_source_id: string;
      source_content_hash: string;
      source_fingerprint: string;
      source_closure_hash: string;
      package_id: string;
      source_manifest_hash: string;
      source_chunk_index: number;
      source_chunk_count: number;
      source_hash: string;
      source_text: string;
      vector_text: string;
    }>(
      `select me.id as local_memory_embedding_id,ev.id as local_source_id,
         ev.session_id as local_session_id,
         pem.logical_event_id as logical_source_id,
         pem.content_hash as source_content_hash,pem.source_fingerprint,
         pem.source_closure_hash,p.package_id,p.source_manifest_hash,
         me.source_chunk_index,me.source_chunk_count,me.source_hash,
         me.source_text,v.embedding::text as vector_text
       from memory_embeddings me
       join memory_events ev on ev.id=me.memory_event_id
       join pds_memory_event_mappings pem on pem.memory_event_id=ev.id
       join personal_device_groups g on g.id=pem.group_id
       join local_personal_identities i on i.id=g.local_personal_identity_id
       join pds_retained_packages p on p.group_id=g.id
         and p.source_fingerprint=pem.source_fingerprint
         and p.source_closure_hash=pem.source_closure_hash and p.state='ready'
       join ${vectorTable} v on v.memory_embedding_id=me.id
       where i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
         and me.owner_user_id=$1 and me.visibility='personal'
         and me.invalidated_at is null and me.personal_deleted_at is null
         and ev.invalidated_at is null and ev.personal_deleted_at is null
         and me.embedding_model=$3 and me.embedding_dimensions=$4
         and me.embedding_version=$5 and me.model_artifact_hash=$6
         and me.tokenizer=$7 and me.input_transform=$8
         and me.pooling=$9 and me.normalization=$10
         and me.source_text<>'[koed encrypted embedding source]'
         and not exists (
           select 1 from pds_memory_embedding_mappings mapped
           where mapped.memory_embedding_id=me.id
         )
       order by ev.source_event_time,me.source_chunk_index,me.id
       limit $11`,
      [
        input.userId,
        input.groupId,
        input.contract.modelKey,
        dimensions,
        input.contract.embeddingVersion,
        input.contract.modelArtifactHash,
        input.contract.tokenizer,
        input.contract.inputTransform,
        input.contract.pooling,
        input.contract.normalization,
        limit
      ]
    );
    const eventCandidates = await Promise.all(
      result.rows.map(async (row) => {
        const vector = JSON.parse(row.vector_text) as unknown;
        if (
          !Array.isArray(vector) ||
          vector.length !== dimensions ||
          vector.some((value) => typeof value !== "number")
        ) {
          throw new Error("PDS portable embedding vector is invalid");
        }
        const typedVector = vector as number[];
        const portableVector = typedVector.map(String);
        const vectorHash = pdsPortableEmbeddingVectorHash(portableVector);
        const sourceTextHash = createHash("sha256")
          .update(row.source_text)
          .digest("base64url");
        const canonicalSource = await dependencies.getEmbeddableSource(
          "memory_event",
          row.local_source_id
        );
        if (!canonicalSource || canonicalSource.ownerUserId !== input.userId) {
          throw new Error("PDS portable embedding source is unavailable");
        }
        const canonicalSourceTextHash = createHash("sha256")
          .update(canonicalSource.text)
          .digest("base64url");
        const sourceHash = pdsPortableEmbeddingSourceHash({
          logicalSourceType: "memory_event",
          logicalSourceId: row.logical_source_id,
          sourceContentHash: row.source_content_hash,
          canonicalSourceTextHash
        });
        const logicalEmbeddingId = pdsPortableMemoryEmbeddingId({
          logicalSourceType: "memory_event",
          logicalSourceId: row.logical_source_id,
          sourceContentHash: row.source_content_hash,
          sourceChunkIndex: String(row.source_chunk_index),
          sourceChunkCount: String(row.source_chunk_count),
          canonicalSourceTextHash,
          compatibilityContractHash: contractHash,
          vectorHash
        });
        return {
          localMemoryEmbeddingId: row.local_memory_embedding_id,
          localSessionId: row.local_session_id,
          groupId: input.groupId,
          sourcePackageId: row.package_id,
          sourceManifestHash: row.source_manifest_hash,
          sourceFingerprint: row.source_fingerprint,
          sourceClosureHash: row.source_closure_hash,
          workIdentity: pdsPortableMemoryEmbeddingWorkIdentity({
            logicalSourceType: "memory_event",
            logicalSourceId: row.logical_source_id,
            sourceContentHash: row.source_content_hash,
            compatibilityContractHash: contractHash
          }),
          compatibilityContract: input.contract,
          embedding: {
            logicalEmbeddingId,
            logicalSourceType: "memory_event" as const,
            logicalSourceId: row.logical_source_id,
            sourceContentHash: row.source_content_hash,
            sourceChunkIndex: String(row.source_chunk_index),
            sourceChunkCount: String(row.source_chunk_count),
            sourceHash,
            canonicalSourceTextHash,
            sourceText: row.source_text,
            sourceTextHash,
            vector: portableVector,
            vectorHash
          }
        };
      })
    );
    const remaining = Math.max(0, limit - eventCandidates.length);
    if (remaining === 0) return eventCandidates;
    const nodeResult = await pool.query<{
      local_memory_embedding_id: string;
      local_source_id: string;
      local_session_id: string;
      logical_source_id: string;
      source_content_hash: string;
      source_fingerprint: string;
      source_closure_hash: string;
      package_id: string;
      source_manifest_hash: string;
      source_chunk_index: number;
      source_chunk_count: number;
      source_hash: string;
      source_text: string;
      vector_text: string;
    }>(
      `select me.id as local_memory_embedding_id,node.id as local_source_id,
         node.session_id as local_session_id,mapping.logical_node_id
           as logical_source_id,mapping.content_hash as source_content_hash,
         mapping.source_fingerprint,mapping.source_closure_hash,
         p.package_id,p.source_manifest_hash,me.source_chunk_index,
         me.source_chunk_count,me.source_hash,me.source_text,
         v.embedding::text as vector_text
       from memory_embeddings me
       join memory_nodes node on node.id=me.memory_node_id
       join pds_lcm_node_mappings mapping on mapping.memory_node_id=node.id
       join personal_device_groups g on g.id=mapping.group_id
       join local_personal_identities i on i.id=g.local_personal_identity_id
       join pds_retained_packages p on p.group_id=g.id
         and p.source_fingerprint=mapping.source_fingerprint
         and p.source_closure_hash=mapping.source_closure_hash
         and p.state='ready'
       join ${vectorTable} v on v.memory_embedding_id=me.id
       where i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
         and me.owner_user_id=$1 and me.visibility='personal'
         and me.invalidated_at is null and me.personal_deleted_at is null
         and node.invalidated_at is null and node.personal_deleted_at is null
         and me.embedding_model=$3 and me.embedding_dimensions=$4
         and me.embedding_version=$5 and me.model_artifact_hash=$6
         and me.tokenizer=$7 and me.input_transform=$8
         and me.pooling=$9 and me.normalization=$10
         and me.source_text<>'[koed encrypted embedding source]'
         and not exists (
           select 1 from pds_memory_embedding_mappings mapped
           where mapped.memory_embedding_id=me.id
         )
       order by node.source_span_start,me.source_chunk_index,me.id
       limit $11`,
      [
        input.userId,
        input.groupId,
        input.contract.modelKey,
        dimensions,
        input.contract.embeddingVersion,
        input.contract.modelArtifactHash,
        input.contract.tokenizer,
        input.contract.inputTransform,
        input.contract.pooling,
        input.contract.normalization,
        remaining
      ]
    );
    const nodeCandidates = await Promise.all(
      nodeResult.rows.map(async (row) => {
        const vector = JSON.parse(row.vector_text) as unknown;
        if (
          !Array.isArray(vector) ||
          vector.length !== dimensions ||
          vector.some((value) => typeof value !== "number")
        ) {
          throw new Error("PDS portable embedding vector is invalid");
        }
        const typedVector = vector as number[];
        const portableVector = typedVector.map(String);
        const vectorHash = pdsPortableEmbeddingVectorHash(portableVector);
        const sourceTextHash = createHash("sha256")
          .update(row.source_text)
          .digest("base64url");
        const canonicalSource = await dependencies.getEmbeddableSource(
          "memory_node",
          row.local_source_id
        );
        if (!canonicalSource || canonicalSource.ownerUserId !== input.userId) {
          throw new Error("PDS portable embedding source is unavailable");
        }
        const canonicalSourceTextHash = createHash("sha256")
          .update(canonicalSource.text)
          .digest("base64url");
        const sourceHash = pdsPortableEmbeddingSourceHash({
          logicalSourceType: "lcm_node",
          logicalSourceId: row.logical_source_id,
          sourceContentHash: row.source_content_hash,
          canonicalSourceTextHash
        });
        const logicalEmbeddingId = pdsPortableMemoryEmbeddingId({
          logicalSourceType: "lcm_node",
          logicalSourceId: row.logical_source_id,
          sourceContentHash: row.source_content_hash,
          sourceChunkIndex: String(row.source_chunk_index),
          sourceChunkCount: String(row.source_chunk_count),
          canonicalSourceTextHash,
          compatibilityContractHash: contractHash,
          vectorHash
        });
        return {
          localMemoryEmbeddingId: row.local_memory_embedding_id,
          localSessionId: row.local_session_id,
          groupId: input.groupId,
          sourcePackageId: row.package_id,
          sourceManifestHash: row.source_manifest_hash,
          sourceFingerprint: row.source_fingerprint,
          sourceClosureHash: row.source_closure_hash,
          workIdentity: pdsPortableMemoryEmbeddingWorkIdentity({
            logicalSourceType: "lcm_node",
            logicalSourceId: row.logical_source_id,
            sourceContentHash: row.source_content_hash,
            compatibilityContractHash: contractHash
          }),
          compatibilityContract: input.contract,
          embedding: {
            logicalEmbeddingId,
            logicalSourceType: "lcm_node" as const,
            logicalSourceId: row.logical_source_id,
            sourceContentHash: row.source_content_hash,
            sourceChunkIndex: String(row.source_chunk_index),
            sourceChunkCount: String(row.source_chunk_count),
            sourceHash,
            canonicalSourceTextHash,
            sourceText: row.source_text,
            sourceTextHash,
            vector: portableVector,
            vectorHash
          }
        };
      })
    );
    return [...eventCandidates, ...nodeCandidates];
  },

  async listPdsPortableLcmNodeCandidates(input) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const nodes = await pool.query<{
      id: string;
      session_id: string;
      kind: "leaf" | "rollup";
      summary_text: string;
      summary_model: string;
      summary_prompt_version: string;
      summary_structured_json: Record<string, unknown>;
      summary_structured_schema_version: string;
      summary_token_estimate: number;
      lcm_algorithm_version: string;
      source_span_start: Date | null;
      source_span_end: Date | null;
      summary_corrected_at: Date | null;
      mapped_content_hash: string | null;
    }>(
      `select mn.id,mn.session_id,mn.kind,mn.summary_text,mn.summary_model,
         mn.summary_prompt_version,mn.summary_structured_json,
         mn.summary_structured_schema_version,mn.lcm_algorithm_version,
         mn.summary_token_estimate,
         mn.source_span_start,mn.source_span_end,mn.summary_corrected_at,
         mapping.content_hash as mapped_content_hash
       from memory_nodes mn
       left join pds_lcm_node_mappings mapping on mapping.memory_node_id=mn.id
       where mn.owner_user_id=$1 and mn.visibility='personal'
         and mn.session_id is not null and mn.invalidated_at is null
         and mn.personal_deleted_at is null and mn.kind in ('leaf','rollup')
         and mn.summary_model is not null
         and mn.summary_prompt_version is not null
         and mn.summary_structured_json is not null
         and mn.summary_structured_schema_version is not null
         and mn.lcm_algorithm_version is not null
       order by mn.depth,mn.created_at,mn.id
       limit $2`,
      [input.userId, limit]
    );
    const candidates: PdsPortableLcmNodeCandidate[] = [];
    for (const row of nodes.rows) {
      const sources =
        row.kind === "leaf"
          ? await pool.query<{
              logical_source_id: string;
              source_fingerprint: string;
              source_closure_hash: string;
              source_order: number;
              source_time: Date;
            }>(
              `select pem.logical_event_id as logical_source_id,
                 pem.source_fingerprint,pem.source_closure_hash,
                 mns.source_order,me.source_event_time as source_time
               from memory_node_sources mns
               join memory_events me on me.id=mns.memory_event_id
               join pds_memory_event_mappings pem
                 on pem.memory_event_id=me.id
               join personal_device_groups g on g.id=pem.group_id
               join local_personal_identities i
                 on i.id=g.local_personal_identity_id
               where mns.memory_node_id=$1 and i.owner_user_id=$2
                 and g.group_id=$3 and g.state='active'
                 and me.invalidated_at is null
                 and me.personal_deleted_at is null
               order by mns.source_order`,
              [row.id, input.userId, input.groupId]
            )
          : await pool.query<{
              logical_source_id: string;
              source_fingerprint: string;
              source_closure_hash: string;
              source_order: number;
              source_time: Date;
            }>(
              `select mapping.logical_node_id as logical_source_id,
                 mapping.source_fingerprint,mapping.source_closure_hash,
                 mnc.child_order as source_order,
                 coalesce(child.source_span_start,child.created_at) as source_time
               from memory_node_children mnc
               join memory_nodes child on child.id=mnc.child_memory_node_id
               join pds_lcm_node_mappings mapping
                 on mapping.memory_node_id=child.id
               join personal_device_groups g on g.id=mapping.group_id
               join local_personal_identities i
                 on i.id=g.local_personal_identity_id
               where mnc.parent_memory_node_id=$1 and i.owner_user_id=$2
                 and g.group_id=$3 and g.state='active'
                 and child.invalidated_at is null
                 and child.personal_deleted_at is null
               order by mnc.child_order`,
              [row.id, input.userId, input.groupId]
            );
      if (sources.rows.length === 0) continue;
      const fingerprints = new Set(
        sources.rows.map((source) => source.source_fingerprint)
      );
      const closures = new Set(
        sources.rows.map((source) => source.source_closure_hash)
      );
      if (fingerprints.size !== 1 || closures.size !== 1) continue;
      const sourceFingerprint = sources.rows[0]!.source_fingerprint;
      const sourceClosureHash = sources.rows[0]!.source_closure_hash;
      const retained = await pool.query<{
        package_id: string;
        source_manifest_hash: string;
      }>(
        `select p.package_id,p.source_manifest_hash
         from pds_retained_packages p
         join personal_device_groups g on g.id=p.group_id
         join local_personal_identities i on i.id=g.local_personal_identity_id
         where i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
           and p.source_fingerprint=$3 and p.source_closure_hash=$4
           and p.state='ready'
         order by p.source_sequence::numeric desc,p.id desc limit 1`,
        [input.userId, input.groupId, sourceFingerprint, sourceClosureHash]
      );
      if (!retained.rows[0]) continue;
      const orderedSourceIds = sources.rows.map(
        (source) => source.logical_source_id
      );
      const contract: PdsLcmNodeContractV1 = {
        artifactClass: "lcm_node/v1",
        nodeKind: row.kind,
        lcmAlgorithmVersion: row.lcm_algorithm_version,
        summaryPromptVersion: row.summary_prompt_version,
        summaryModel: row.summary_model,
        structuredOutputSchema: row.summary_structured_schema_version,
        sourceSelectionPolicy: row.lcm_algorithm_version
      };
      const correctedRevision = row.summary_corrected_at
        ? String(row.summary_corrected_at.getTime())
        : "0";
      const sourceSpanStart =
        row.source_span_start ?? sources.rows[0]!.source_time;
      const sourceSpanEnd =
        row.source_span_end ?? sources.rows.at(-1)!.source_time;
      const nodeWithoutIdentity = {
        nodeKind: row.kind,
        orderedSourceIds,
        summaryText: row.summary_text,
        summaryTokenCount: String(row.summary_token_estimate),
        structuredSummary: row.summary_structured_json,
        correctedRevision,
        sourceSpanStart: iso(sourceSpanStart),
        sourceSpanEnd: iso(sourceSpanEnd)
      };
      const contentHash = pdsPortableLcmNodeContentHash(nodeWithoutIdentity);
      if (row.mapped_content_hash === contentHash) continue;
      const compatibilityContractHash = pdsArtifactCompatibilityHash(contract);
      const logicalNodeId = pdsPortableLcmNodeId({
        nodeKind: row.kind,
        orderedSourceIds,
        compatibilityContractHash,
        correctedRevision,
        contentHash
      });
      const workIdentity = createHash("sha256")
        .update(
          canonicalizePdsJson({
            artifactClass: "lcm_node/v1",
            nodeKind: row.kind,
            orderedSourceIds,
            compatibilityContractHash,
            correctedRevision
          })
        )
        .digest("base64url");
      candidates.push({
        localMemoryNodeId: row.id,
        localSessionId: row.session_id,
        groupId: input.groupId,
        sourcePackageId: retained.rows[0].package_id,
        sourceManifestHash: retained.rows[0].source_manifest_hash,
        sourceFingerprint,
        sourceClosureHash,
        workIdentity,
        workClass: row.kind === "leaf" ? "lcm_leaf" : "lcm_rollup",
        compatibilityContract: contract,
        node: {
          logicalNodeId,
          ...nodeWithoutIdentity,
          contentHash
        }
      });
    }
    return candidates;
  },

  async acquirePdsSemanticWorkClaim(input) {
    const result = await pool.query<{
      work_identity: string;
      work_class: string;
      compatibility_contract_hash: string;
      claimant_device_id: string;
      claim_generation: string;
      claimed_at: Date;
      expires_at: Date;
    }>(
      `insert into pds_semantic_work_claims
       (group_id,work_identity,work_class,compatibility_contract_hash,
        claimant_device_id,claim_generation,claimed_at,expires_at,state)
       select g.id,$4,$5,$6,$3,'1',now(),
         now()+($7::text || ' seconds')::interval,'active'
       from personal_device_groups g
       join local_personal_identities i on i.id=g.local_personal_identity_id
       join personal_device_group_members m on m.group_id=g.id
       where i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
         and m.device_id=$3 and m.status='active'
       on conflict (group_id,work_identity) do update
       set work_class=excluded.work_class,
           compatibility_contract_hash=excluded.compatibility_contract_hash,
           claimant_device_id=excluded.claimant_device_id,
           claim_generation=case
             when pds_semantic_work_claims.claimant_device_id=excluded.claimant_device_id
               then pds_semantic_work_claims.claim_generation
             else (pds_semantic_work_claims.claim_generation::numeric+1)::text
           end,
           claimed_at=now(),expires_at=excluded.expires_at,state='active',
           updated_at=now()
       where pds_semantic_work_claims.state<>'active'
          or pds_semantic_work_claims.expires_at<=now()
          or (pds_semantic_work_claims.claimant_device_id=excluded.claimant_device_id
              and pds_semantic_work_claims.compatibility_contract_hash=
                  excluded.compatibility_contract_hash)
       returning work_identity,work_class,compatibility_contract_hash,
         claimant_device_id,claim_generation,claimed_at,expires_at`,
      [
        input.userId,
        input.groupId,
        input.deviceId,
        input.workIdentity,
        input.workClass,
        input.compatibilityContractHash,
        leaseSeconds(input.leaseSeconds)
      ]
    );
    return result.rows[0] ? claimRecord(result.rows[0]) : null;
  },

  async recordPdsSemanticWorkClaim(input) {
    const claim = input.claim;
    const result = await pool.query(
      `insert into pds_semantic_work_claims
       (group_id,work_identity,work_class,compatibility_contract_hash,
        claimant_device_id,claim_generation,claimed_at,expires_at,state,
        local_source_type,local_source_id,source_content_hash)
       select g.id,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$12
       from personal_device_groups g
       join local_personal_identities i on i.id=g.local_personal_identity_id
       join personal_device_group_members m on m.group_id=g.id
         and m.device_id=$6 and m.status='active'
       where i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
         and (
           $10::text is null
           or ($10='memory_event' and exists (
             select 1 from pds_memory_event_mappings mapping
             where mapping.group_id=g.id and mapping.memory_event_id=$11
               and mapping.content_hash=$12
           ))
           or ($10='lcm_node' and exists (
             select 1 from pds_lcm_node_mappings mapping
             where mapping.group_id=g.id and mapping.memory_node_id=$11
               and mapping.content_hash=$12
           ))
         )
       on conflict (group_id,work_identity) do update
       set work_class=excluded.work_class,
         compatibility_contract_hash=excluded.compatibility_contract_hash,
         claimant_device_id=excluded.claimant_device_id,
         claim_generation=excluded.claim_generation,
         claimed_at=excluded.claimed_at,expires_at=excluded.expires_at,
         local_source_type=coalesce(
           excluded.local_source_type,
           pds_semantic_work_claims.local_source_type
         ),
         local_source_id=coalesce(
           excluded.local_source_id,
           pds_semantic_work_claims.local_source_id
         ),
         source_content_hash=coalesce(
           excluded.source_content_hash,
           pds_semantic_work_claims.source_content_hash
         ),
         state='active',updated_at=now()
       where pds_semantic_work_claims.claim_generation::numeric
           < excluded.claim_generation::numeric
         or (
           pds_semantic_work_claims.claim_generation=
             excluded.claim_generation
           and pds_semantic_work_claims.claimant_device_id=
             excluded.claimant_device_id
           and pds_semantic_work_claims.work_class=excluded.work_class
           and pds_semantic_work_claims.compatibility_contract_hash=
             excluded.compatibility_contract_hash
         )`,
      [
        input.userId,
        input.groupId,
        claim.workIdentity,
        claim.workClass,
        claim.compatibilityContractHash,
        claim.claimantDeviceId,
        claim.claimGeneration,
        claim.claimedAt,
        claim.expiresAt,
        input.localSource?.sourceType ?? null,
        input.localSource?.sourceId ?? null,
        input.localSource?.contentHash ?? null
      ]
    );
    return result.rowCount === 1;
  },

  async renewPdsSemanticWorkClaim(input) {
    const result = await pool.query<{
      work_identity: string;
      work_class: string;
      compatibility_contract_hash: string;
      claimant_device_id: string;
      claim_generation: string;
      claimed_at: Date;
      expires_at: Date;
    }>(
      `update pds_semantic_work_claims c
       set expires_at=now()+($6::text || ' seconds')::interval,updated_at=now()
       from personal_device_groups g
       join local_personal_identities i on i.id=g.local_personal_identity_id
       where c.group_id=g.id and i.owner_user_id=$1 and g.group_id=$2
         and c.claimant_device_id=$3 and c.work_identity=$4
         and c.claim_generation=$5 and c.state='active' and c.expires_at>now()
       returning c.work_identity,c.work_class,c.compatibility_contract_hash,
         c.claimant_device_id,c.claim_generation,c.claimed_at,c.expires_at`,
      [
        input.userId,
        input.groupId,
        input.deviceId,
        input.workIdentity,
        input.claimGeneration,
        leaseSeconds(input.leaseSeconds)
      ]
    );
    return result.rows[0] ? claimRecord(result.rows[0]) : null;
  },

  async completePdsSemanticWorkClaim(input) {
    const result = await pool.query(
      `update pds_semantic_work_claims c set state='completed',updated_at=now()
       from personal_device_groups g
       join local_personal_identities i on i.id=g.local_personal_identity_id
       where c.group_id=g.id and i.owner_user_id=$1 and g.group_id=$2
         and c.claimant_device_id=$3 and c.work_identity=$4
         and c.claim_generation=$5 and c.state='active' and c.expires_at>now()`,
      [
        input.userId,
        input.groupId,
        input.deviceId,
        input.workIdentity,
        input.claimGeneration
      ]
    );
    return result.rowCount === 1;
  },

  async stagePdsPortableArtifact(input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const manifest = input.record.manifest;
      const group = await client.query<{ id: string }>(
        `select g.id from personal_device_groups g
         join local_personal_identities i on i.id=g.local_personal_identity_id
         join personal_device_group_members m on m.group_id=g.id
           and m.device_id=$3 and m.status='active'
         where i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
         for update of g`,
        [input.userId, input.groupId, manifest.producerDeviceId]
      );
      const groupDbId = group.rows[0]?.id;
      if (!groupDbId || manifest.groupId !== input.groupId) {
        throw new Error("PDS artifact authority binding is invalid");
      }
      const source = await client.query(
        `select 1 from pds_retained_packages
         where group_id=$1 and package_id=$2 and source_manifest_hash=$3
           and source_fingerprint=$4 and source_closure_hash=$5
           and state='ready' for share`,
        [
          groupDbId,
          manifest.sourcePackageId,
          manifest.sourceManifestHash,
          manifest.sourceFingerprint,
          manifest.sourceClosureHash
        ]
      );
      if (!source.rowCount) {
        throw new Error("PDS artifact source package is unavailable");
      }
      const claim = await client.query(
        `select 1 from pds_semantic_work_claims
         where group_id=$1 and work_identity=$2 and claimant_device_id=$3
           and claim_generation=$4 and compatibility_contract_hash=$5
           and state='active' and expires_at>now() for update`,
        [
          groupDbId,
          manifest.workIdentity,
          manifest.producerDeviceId,
          manifest.claimGeneration,
          manifest.compatibilityContractHash
        ]
      );
      if (!claim.rowCount) {
        throw new Error("PDS artifact semantic work claim is unavailable");
      }
      const inserted = await client.query<{ id: string }>(
        `insert into pds_portable_artifacts
         (group_id,owner_user_id,local_session_id,artifact_id,work_identity,
          artifact_class,source_package_id,source_manifest_hash,source_fingerprint,
          source_closure_hash,producer_device_id,claim_generation,
          compatibility_contract_hash,payload_hash,transport_manifest_hash,
          encrypted_envelope,state)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,'ready')
         on conflict (group_id,artifact_id) do nothing returning id`,
        [
          groupDbId,
          input.userId,
          input.localSessionId,
          manifest.artifactId,
          manifest.workIdentity,
          manifest.artifactClass,
          manifest.sourcePackageId,
          manifest.sourceManifestHash,
          manifest.sourceFingerprint,
          manifest.sourceClosureHash,
          manifest.producerDeviceId,
          manifest.claimGeneration,
          manifest.compatibilityContractHash,
          manifest.payloadHash,
          input.transportManifestHash,
          JSON.stringify(input.encryptedEnvelope)
        ]
      );
      let id = inserted.rows[0]?.id;
      if (!id) {
        const existing = await client.query<{ id: string }>(
          `select id from pds_portable_artifacts where group_id=$1
             and artifact_id=$2 and payload_hash=$3
             and compatibility_contract_hash=$4`,
          [
            groupDbId,
            manifest.artifactId,
            manifest.payloadHash,
            manifest.compatibilityContractHash
          ]
        );
        id = existing.rows[0]?.id;
      }
      if (!id) throw new Error("PDS artifact identity conflict");
      await client.query(
        `insert into pds_artifact_outbox_entries (artifact_id,idempotency_key)
         values ($1,$2) on conflict (artifact_id) do nothing`,
        [id, `pds-artifact:${input.groupId}:${manifest.artifactId}`]
      );
      if (
        input.localMemoryEventId &&
        manifest.artifactClass === "memory_event/v1" &&
        input.record.payload.artifactClass === "memory_event/v1" &&
        input.record.payload.items.length === 1
      ) {
        const event = input.record.payload.items[0]!;
        const mapped = await client.query(
          `insert into pds_memory_event_mappings
           (group_id,memory_event_id,logical_event_id,source_fingerprint,
            source_closure_hash,content_hash,source_ordinals)
           select $1,me.id,$3,$4,$5,$6,$7
           from memory_events me
           where me.id=$2 and me.owner_user_id=$8 and me.session_id=$9
             and me.invalidated_at is null and me.personal_deleted_at is null
           on conflict (memory_event_id) do update
           set logical_event_id=excluded.logical_event_id,
             source_fingerprint=excluded.source_fingerprint,
             source_closure_hash=excluded.source_closure_hash,
             content_hash=excluded.content_hash,
             source_ordinals=excluded.source_ordinals`,
          [
            groupDbId,
            input.localMemoryEventId,
            event.logicalEventId,
            manifest.sourceFingerprint,
            manifest.sourceClosureHash,
            event.contentHash,
            event.sourceOrdinals,
            input.userId,
            input.localSessionId
          ]
        );
        if (mapped.rowCount !== 1) {
          throw new Error("PDS artifact local Memory Event is unavailable");
        }
      }
      if (
        input.localMemoryEmbeddingId &&
        manifest.artifactClass === "memory_embedding/v1" &&
        input.record.payload.artifactClass === "memory_embedding/v1" &&
        input.record.payload.items.length === 1
      ) {
        const embedding = input.record.payload.items[0]!;
        const mapped = await client.query(
          `insert into pds_memory_embedding_mappings
           (group_id,memory_embedding_id,logical_embedding_id,
            logical_source_type,logical_source_id,source_content_hash,
            compatibility_contract_hash,vector_hash)
           select $1,me.id,$3,$4,$5,$6,$7,$8
           from memory_embeddings me
           where me.id=$2 and me.owner_user_id=$9
             and (
               ($4='memory_event' and exists (
                 select 1 from pds_memory_event_mappings pem
                 where pem.group_id=$1 and pem.memory_event_id=me.memory_event_id
                   and pem.logical_event_id=$5 and pem.content_hash=$6
               ))
               or ($4='lcm_node' and exists (
                 select 1 from pds_lcm_node_mappings pnm
                 where pnm.group_id=$1 and pnm.memory_node_id=me.memory_node_id
                   and pnm.logical_node_id=$5 and pnm.content_hash=$6
               ))
             )
             and me.invalidated_at is null and me.personal_deleted_at is null
           on conflict (memory_embedding_id) do update
           set logical_embedding_id=excluded.logical_embedding_id,
             logical_source_type=excluded.logical_source_type,
             logical_source_id=excluded.logical_source_id,
             source_content_hash=excluded.source_content_hash,
             compatibility_contract_hash=excluded.compatibility_contract_hash,
             vector_hash=excluded.vector_hash`,
          [
            groupDbId,
            input.localMemoryEmbeddingId,
            embedding.logicalEmbeddingId,
            embedding.logicalSourceType,
            embedding.logicalSourceId,
            embedding.sourceContentHash,
            manifest.compatibilityContractHash,
            embedding.vectorHash,
            input.userId
          ]
        );
        if (mapped.rowCount !== 1) {
          throw new Error("PDS artifact local embedding is unavailable");
        }
      }
      if (
        input.localMemoryNodeId &&
        manifest.artifactClass === "lcm_node/v1" &&
        input.record.payload.artifactClass === "lcm_node/v1" &&
        input.record.payload.items.length === 1
      ) {
        const node = input.record.payload.items[0]!;
        const mapped = await client.query(
          `insert into pds_lcm_node_mappings
           (group_id,memory_node_id,logical_node_id,source_fingerprint,
            source_closure_hash,compatibility_contract_hash,content_hash)
           select $1,mn.id,$3,$4,$5,$6,$7
           from memory_nodes mn
           where mn.id=$2 and mn.owner_user_id=$8 and mn.session_id=$9
             and mn.invalidated_at is null and mn.personal_deleted_at is null
           on conflict (memory_node_id) do update
           set logical_node_id=excluded.logical_node_id,
             source_fingerprint=excluded.source_fingerprint,
             source_closure_hash=excluded.source_closure_hash,
             compatibility_contract_hash=excluded.compatibility_contract_hash,
             content_hash=excluded.content_hash`,
          [
            groupDbId,
            input.localMemoryNodeId,
            node.logicalNodeId,
            manifest.sourceFingerprint,
            manifest.sourceClosureHash,
            manifest.compatibilityContractHash,
            node.contentHash,
            input.userId,
            input.localSessionId
          ]
        );
        if (mapped.rowCount !== 1) {
          throw new Error("PDS artifact local LCM node is unavailable");
        }
      }
      await client.query(
        `update pds_semantic_work_claims set state='completed',updated_at=now()
         where group_id=$1 and work_identity=$2 and claimant_device_id=$3
           and claim_generation=$4 and state='active' and expires_at>now()`,
        [
          groupDbId,
          manifest.workIdentity,
          manifest.producerDeviceId,
          manifest.claimGeneration
        ]
      );
      await client.query(
        "select pg_notify('koed_pds_local_sync','artifact_ready')"
      );
      await client.query("commit");
      return { id, inserted: Boolean(inserted.rows[0]) };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async claimPdsArtifactOutbox(input) {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
    const seconds = leaseSeconds(input.leaseSeconds);
    const requestedState = input.state ?? "pending";
    const result = await pool.query<{
      id: string;
      groupId: string;
      artifactId: string;
      packageId: string;
      manifestHash: string;
      attemptCount: number;
      transportId: string | null;
    }>(
      `with claimed as (
         select o.id
         from pds_artifact_outbox_entries o
         join pds_portable_artifacts a on a.id=o.artifact_id
         join personal_sync_policies p on p.group_id=a.group_id
         where o.state=$3 and o.retry_at<=now()
           and (o.lease_until is null or o.lease_until<now())
           and p.enabled=true and p.publication_paused=false
           and a.state in ('ready','published')
           and a.semantic_claim_completed_at is not null
         order by o.retry_at,o.id
         for update of o,p skip locked limit $1
       )
       update pds_artifact_outbox_entries o
       set state=case when $3='pending' then 'uploading' else o.state end,
         lease_owner=$2,
         lease_until=now()+($4::text || ' seconds')::interval,
         attempt_count=case when $3='pending' then o.attempt_count+1
           else o.attempt_count end,
         updated_at=now()
       from claimed c,pds_portable_artifacts a,personal_device_groups g
       where o.id=c.id and a.id=o.artifact_id and g.id=a.group_id
       returning o.id,g.group_id as "groupId",a.artifact_id as "artifactId",
         a.artifact_id as "packageId",
         a.transport_manifest_hash as "manifestHash",
         o.attempt_count as "attemptCount",o.transport_id as "transportId"`,
      [limit, input.workerId, requestedState, seconds]
    );
    return result.rows;
  },

  async listPdsPendingArtifactClaimCompletions(input) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const result = await pool.query<{
      artifact_id: string;
      work_identity: string;
      claim_generation: string;
    }>(
      `select a.artifact_id,a.work_identity,a.claim_generation
       from pds_portable_artifacts a
       join personal_device_groups g on g.id=a.group_id
       join local_personal_identities i on i.id=g.local_personal_identity_id
       where i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
         and a.owner_user_id=$1 and a.producer_device_id=$3
         and a.state='ready' and a.semantic_claim_completed_at is null
       order by a.created_at,a.id limit $4`,
      [input.userId, input.groupId, input.producerDeviceId, limit]
    );
    return result.rows.map((row) => ({
      artifactId: row.artifact_id,
      workIdentity: row.work_identity,
      claimGeneration: row.claim_generation
    }));
  },

  async markPdsArtifactClaimCompleted(input) {
    const result = await pool.query(
      `update pds_portable_artifacts a
       set semantic_claim_completed_at=now(),updated_at=now()
       from personal_device_groups g
       join local_personal_identities i on i.id=g.local_personal_identity_id
       where a.group_id=g.id and i.owner_user_id=$1 and g.group_id=$2
         and a.artifact_id=$3 and a.producer_device_id=$4
         and a.claim_generation=$5 and a.state='ready'
         and a.semantic_claim_completed_at is null`,
      [
        input.userId,
        input.groupId,
        input.artifactId,
        input.producerDeviceId,
        input.claimGeneration
      ]
    );
    if (result.rowCount === 1) {
      await pool.query(
        "select pg_notify('koed_pds_local_sync','artifact_claim_completed')"
      );
    }
    return result.rowCount === 1;
  },

  async beginPdsArtifactOutboxNetworkAction(input) {
    const result = await pool.query(
      `select 1 from pds_artifact_outbox_entries o
       join pds_portable_artifacts a on a.id=o.artifact_id
       join personal_sync_policies p on p.group_id=a.group_id
       where o.id=$1 and o.lease_owner=$2 and o.state='uploading'
         and o.lease_until>=now() and p.enabled=true
         and p.publication_paused=false and a.state='ready'`,
      [input.outboxId, input.workerId]
    );
    return result.rowCount === 1;
  },

  async getPdsArtifactOutboxEncryptedEnvelope(input) {
    const result = await pool.query<{ encrypted_envelope: unknown }>(
      `select a.encrypted_envelope
       from pds_artifact_outbox_entries o
       join pds_portable_artifacts a on a.id=o.artifact_id
       where o.id=$1 and o.lease_owner=$2 and o.state='uploading'
         and o.lease_until>=now() and a.state='ready'`,
      [input.outboxId, input.workerId]
    );
    return result.rows[0]
      ? { encryptedEnvelope: result.rows[0].encrypted_envelope }
      : null;
  },

  async completePdsArtifactOutbox(input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<{ artifact_id: string }>(
        `update pds_artifact_outbox_entries
         set state=$3,transport_id=$4,lease_owner=null,lease_until=null,
           last_error_class=null,updated_at=now()
         where id=$1 and lease_owner=$2
           and state in ('uploading','committed') and lease_until>=now()
         returning artifact_id`,
        [input.outboxId, input.workerId, input.state, input.transportId]
      );
      if (result.rows[0]) {
        await client.query(
          `update pds_portable_artifacts
           set state='published',updated_at=now() where id=$1`,
          [result.rows[0].artifact_id]
        );
      }
      await client.query("commit");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async releasePdsCommittedArtifactOutbox(input) {
    const result = await pool.query(
      `update pds_artifact_outbox_entries
       set lease_owner=null,lease_until=null,updated_at=now()
       where id=$1 and lease_owner=$2 and state='committed'`,
      [input.outboxId, input.workerId]
    );
    return result.rowCount === 1;
  },

  async retryPdsArtifactOutbox(input) {
    const result = await pool.query(
      `update pds_artifact_outbox_entries
       set state='pending',lease_owner=null,lease_until=null,retry_at=$3,
         last_error_class=$4,updated_at=now()
       where id=$1 and lease_owner=$2 and state='uploading'`,
      [input.outboxId, input.workerId, input.retryAt, input.errorClass]
    );
    return result.rowCount === 1;
  },

  async importPdsPortableArtifact(input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const manifest = input.record.manifest;
      if (
        manifest.groupId !== input.groupId ||
        !["memory_event/v1", "memory_embedding/v1", "lcm_node/v1"].includes(
          manifest.artifactClass
        ) ||
        manifest.compatibilityContract.artifactClass !==
          manifest.artifactClass ||
        input.record.payload.artifactClass !== manifest.artifactClass ||
        input.record.payload.items.length !== 1
      ) {
        throw new Error("PDS artifact import class is unsupported");
      }
      const group = await client.query<{ id: string }>(
        `select g.id
         from personal_device_groups g
         join local_personal_identities i on i.id=g.local_personal_identity_id
         join personal_device_group_members m on m.group_id=g.id
           and m.device_id=$3 and m.status='active'
         where i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
         for update of g`,
        [input.userId, input.groupId, manifest.producerDeviceId]
      );
      const groupDbId = group.rows[0]?.id;
      if (!groupDbId) {
        throw new Error("PDS artifact producer authority is unavailable");
      }
      const processing = await client.query(
        `update pds_inbox_entries
         set state='processing',updated_at=now()
         where id=$1 and group_id=$2 and owner_user_id=$3
           and state in ('downloading','verifying')
           and lease_owner=$4
           and lease_until>=now()`,
        [input.inboxId, groupDbId, input.userId, input.workerId]
      );
      if (processing.rowCount !== 1) {
        throw new Error("PdsInboxLeaseUnavailableError");
      }
      const source = await client.query<{ id: string }>(
        `select id from pds_retained_packages
         where group_id=$1 and package_id=$2 and source_manifest_hash=$3
           and source_fingerprint=$4 and source_closure_hash=$5
           and state='ready' for share`,
        [
          groupDbId,
          manifest.sourcePackageId,
          manifest.sourceManifestHash,
          manifest.sourceFingerprint,
          manifest.sourceClosureHash
        ]
      );
      if (!source.rowCount) {
        throw new Error("PDS artifact source package is unavailable");
      }
      if (
        manifest.artifactClass === "lcm_node/v1" &&
        manifest.compatibilityContract.artifactClass === "lcm_node/v1" &&
        input.record.payload.artifactClass === "lcm_node/v1"
      ) {
        const node = input.record.payload.items[0]!;
        const contract = manifest.compatibilityContract;
        if (node.nodeKind !== contract.nodeKind) {
          throw new Error("PDS LCM artifact node kind is inconsistent");
        }
        const existing = await client.query<{
          memory_node_id: string;
          content_hash: string;
        }>(
          `select memory_node_id,content_hash
           from pds_lcm_node_mappings
           where group_id=$1 and logical_node_id=$2`,
          [groupDbId, node.logicalNodeId]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].content_hash !== node.contentHash) {
            throw new Error("PDS artifact logical LCM identity conflict");
          }
          await client.query("commit");
          return {
            state: "ready",
            localSourceId: existing.rows[0].memory_node_id
          };
        }
        const compatible =
          contract.structuredOutputSchema ===
            LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION &&
          ((contract.nodeKind === "leaf" &&
            contract.lcmAlgorithmVersion === "depth0-source-items-v1") ||
            (contract.nodeKind === "rollup" &&
              contract.lcmAlgorithmVersion === "depth1-child-rollup-v1")) &&
          contract.sourceSelectionPolicy === contract.lcmAlgorithmVersion;
        const sourceRows =
          node.nodeKind === "leaf"
            ? await client.query<{
                local_source_id: string;
                session_id: string;
                source_time: Date;
                actor: string | null;
                turn_id: string | null;
                source_text: string;
                source_token_count: number;
                source_event_count: number;
              }>(
                `select me.id as local_source_id,me.session_id,
                   me.source_event_time as source_time,
                   me.payload->>'actor' as actor,me.turn_id,
                   coalesce(me.payload->>'content','') as source_text,
                   coalesce(me.token_count,0) as source_token_count,
                   1 as source_event_count
                 from unnest($2::text[]) with ordinality requested(logical_id,position)
                 join pds_memory_event_mappings mapping
                   on mapping.group_id=$1
                  and mapping.logical_event_id=requested.logical_id
                 join memory_events me on me.id=mapping.memory_event_id
                 where me.owner_user_id=$3 and me.visibility='personal'
                   and me.invalidated_at is null
                   and me.personal_deleted_at is null
                 order by requested.position`,
                [groupDbId, node.orderedSourceIds, input.userId]
              )
            : await client.query<{
                local_source_id: string;
                session_id: string;
                source_time: Date;
                actor: string | null;
                turn_id: string | null;
                source_text: string;
                source_token_count: number;
                source_event_count: number;
              }>(
                `select mn.id as local_source_id,mn.session_id,
                   coalesce(mn.source_span_start,mn.created_at) as source_time,
                   null::text as actor,null::uuid as turn_id,
                   mn.summary_text as source_text,
                   coalesce(mn.source_token_estimate,0) as source_token_count,
                   mn.source_event_count
                 from unnest($2::text[]) with ordinality requested(logical_id,position)
                 join pds_lcm_node_mappings mapping
                   on mapping.group_id=$1
                  and mapping.logical_node_id=requested.logical_id
                 join memory_nodes mn on mn.id=mapping.memory_node_id
                 where mn.owner_user_id=$3 and mn.visibility='personal'
                   and mn.kind='leaf' and mn.invalidated_at is null
                   and mn.personal_deleted_at is null
                 order by requested.position`,
                [groupDbId, node.orderedSourceIds, input.userId]
              );
        const sessions = new Set(sourceRows.rows.map((row) => row.session_id));
        if (
          sourceRows.rows.length !== node.orderedSourceIds.length ||
          sessions.size !== 1 ||
          !sourceRows.rows[0]?.session_id
        ) {
          throw new Error("PDS LCM artifact source closure is incomplete");
        }
        const localSessionId = sourceRows.rows[0].session_id;
        const retained = await client.query<{ id: string }>(
          `insert into pds_portable_artifacts
           (group_id,owner_user_id,local_session_id,artifact_id,work_identity,
            artifact_class,source_package_id,source_manifest_hash,
            source_fingerprint,source_closure_hash,producer_device_id,
            claim_generation,compatibility_contract_hash,payload_hash,
            transport_manifest_hash,semantic_claim_completed_at,
            encrypted_envelope,state)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             now(),$16::jsonb,$17)
           on conflict (group_id,artifact_id) do update
           set encrypted_envelope=excluded.encrypted_envelope,
             transport_manifest_hash=excluded.transport_manifest_hash,
             state=excluded.state,updated_at=now()
           where pds_portable_artifacts.payload_hash=excluded.payload_hash
             and pds_portable_artifacts.compatibility_contract_hash=
               excluded.compatibility_contract_hash
           returning id`,
          [
            groupDbId,
            input.userId,
            localSessionId,
            manifest.artifactId,
            manifest.workIdentity,
            manifest.artifactClass,
            manifest.sourcePackageId,
            manifest.sourceManifestHash,
            manifest.sourceFingerprint,
            manifest.sourceClosureHash,
            manifest.producerDeviceId,
            manifest.claimGeneration,
            manifest.compatibilityContractHash,
            manifest.payloadHash,
            input.transportManifestHash,
            JSON.stringify(input.encryptedEnvelope),
            compatible ? "imported" : "incompatible"
          ]
        );
        if (!retained.rows[0]) {
          throw new Error("PDS LCM artifact retained identity conflict");
        }
        await client.query(
          `insert into pds_artifact_inbox_entries
           (group_id,owner_user_id,package_id,manifest_hash,state,
            retained_artifact_id)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (group_id,package_id) do update
           set manifest_hash=excluded.manifest_hash,state=excluded.state,
             retained_artifact_id=excluded.retained_artifact_id,
             updated_at=now()`,
          [
            groupDbId,
            input.userId,
            manifest.artifactId,
            input.transportManifestHash,
            compatible ? "ready" : "incompatible",
            retained.rows[0].id
          ]
        );
        if (!compatible) {
          await client.query("commit");
          return { state: "incompatible", localSourceId: null };
        }
        const sourceItems = sourceRows.rows.map((sourceRow, position) =>
          node.nodeKind === "leaf"
            ? {
                kind: "memory_event",
                sourceTable: "memory_events",
                sourceId: sourceRow.local_source_id,
                actor: sourceRow.actor,
                turnId: sourceRow.turn_id,
                createdAt: sourceRow.source_time.toISOString(),
                text: sourceRow.source_text,
                position
              }
            : {
                kind: "lcm_child",
                nodeId: sourceRow.local_source_id,
                text: sourceRow.source_text,
                position
              }
        );
        const sourceEventCount = sourceRows.rows.reduce(
          (sum, sourceRow) => sum + sourceRow.source_event_count,
          0
        );
        const sourceTokenEstimate = sourceRows.rows.reduce(
          (sum, sourceRow) => sum + sourceRow.source_token_count,
          0
        );
        const inserted = await client.query<{ id: string }>(
          `insert into memory_nodes
           (owner_user_id,session_id,created_by_user_id,visibility,kind,depth,
            summary_text,body_text,capture_method,lcm_algorithm_version,
            source_items_json,source_event_count,source_token_estimate,
            summary_token_estimate,source_span_start,source_span_end,
            source_hash,summary_model,summary_prompt_version,
            summary_structured_json,summary_structured_schema_version)
           values ($1,$2,$1,'personal',$3,$4,$5,$5,'mcp',$6,$7::jsonb,$8,$9,
             $10,$11,$12,$13,$14,$15,$16::jsonb,$17)
           on conflict (source_hash) where source_hash is not null
           do update set summary_text=excluded.summary_text,
             body_text=excluded.body_text,
             summary_model=excluded.summary_model,
             summary_prompt_version=excluded.summary_prompt_version,
             summary_structured_json=excluded.summary_structured_json,
             summary_structured_schema_version=
               excluded.summary_structured_schema_version,
             source_items_json=excluded.source_items_json,
             source_event_count=excluded.source_event_count,
             source_token_estimate=excluded.source_token_estimate,
             source_span_start=excluded.source_span_start,
             source_span_end=excluded.source_span_end,
             invalidated_at=null,invalidation_reason=null,updated_at=now()
           returning id`,
          [
            input.userId,
            localSessionId,
            node.nodeKind,
            node.nodeKind === "leaf" ? 0 : 1,
            node.summaryText,
            contract.lcmAlgorithmVersion,
            JSON.stringify(sourceItems),
            sourceEventCount,
            sourceTokenEstimate,
            Number(node.summaryTokenCount),
            new Date(node.sourceSpanStart),
            new Date(node.sourceSpanEnd),
            `pds-lcm:${node.logicalNodeId}`,
            contract.summaryModel,
            contract.summaryPromptVersion,
            JSON.stringify(node.structuredSummary),
            contract.structuredOutputSchema
          ]
        );
        const localMemoryNodeId = inserted.rows[0]?.id;
        if (!localMemoryNodeId) {
          throw new Error("PDS LCM artifact identity conflict");
        }
        if (node.nodeKind === "leaf") {
          for (const [index, sourceRow] of sourceRows.rows.entries()) {
            await client.query(
              `insert into memory_node_sources
               (memory_node_id,memory_event_id,source_order)
               values ($1,$2,$3) on conflict do nothing`,
              [localMemoryNodeId, sourceRow.local_source_id, index]
            );
          }
        } else {
          for (const [index, sourceRow] of sourceRows.rows.entries()) {
            await client.query(
              `insert into memory_node_children
               (parent_memory_node_id,child_memory_node_id,child_order)
               values ($1,$2,$3) on conflict do nothing`,
              [localMemoryNodeId, sourceRow.local_source_id, index]
            );
          }
        }
        await client.query(
          `insert into pds_lcm_node_mappings
           (group_id,memory_node_id,logical_node_id,source_fingerprint,
            source_closure_hash,compatibility_contract_hash,content_hash)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            groupDbId,
            localMemoryNodeId,
            node.logicalNodeId,
            manifest.sourceFingerprint,
            manifest.sourceClosureHash,
            manifest.compatibilityContractHash,
            node.contentHash
          ]
        );
        await client.query("commit");
        return { state: "ready", localSourceId: localMemoryNodeId };
      }
      if (
        manifest.artifactClass === "memory_embedding/v1" &&
        manifest.compatibilityContract.artifactClass ===
          "memory_embedding/v1" &&
        input.record.payload.artifactClass === "memory_embedding/v1"
      ) {
        const embedding = input.record.payload.items[0]!;
        const existing = await client.query<{
          memory_embedding_id: string;
          vector_hash: string;
        }>(
          `select memory_embedding_id,vector_hash
           from pds_memory_embedding_mappings
           where group_id=$1 and logical_embedding_id=$2`,
          [groupDbId, embedding.logicalEmbeddingId]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].vector_hash !== embedding.vectorHash) {
            throw new Error("PDS artifact logical embedding identity conflict");
          }
          await client.query("commit");
          return {
            state: "ready",
            localSourceId: existing.rows[0].memory_embedding_id
          };
        }
        const localSource = await client.query<{
          local_source_id: string;
          content_hash: string;
          session_id: string;
          source_hash: string | null;
        }>(
          embedding.logicalSourceType === "memory_event"
            ? `select pem.memory_event_id as local_source_id,pem.content_hash,
                 me.session_id,me.source_hash
               from pds_memory_event_mappings pem
               join memory_events me on me.id=pem.memory_event_id
               where pem.group_id=$1 and pem.logical_event_id=$2
                 and pem.content_hash=$3 and me.owner_user_id=$4
                 and me.invalidated_at is null
                 and me.personal_deleted_at is null`
            : `select pnm.memory_node_id as local_source_id,pnm.content_hash,
                 mn.session_id,mn.source_hash
               from pds_lcm_node_mappings pnm
               join memory_nodes mn on mn.id=pnm.memory_node_id
               where pnm.group_id=$1 and pnm.logical_node_id=$2
                 and pnm.content_hash=$3 and mn.owner_user_id=$4
                 and mn.invalidated_at is null
                 and mn.personal_deleted_at is null`,
          [
            groupDbId,
            embedding.logicalSourceId,
            embedding.sourceContentHash,
            input.userId
          ]
        );
        if (!localSource.rows[0]?.session_id) {
          throw new Error("PDS embedding artifact source is unavailable");
        }
        const canonicalSource = await dependencies.getEmbeddableSource(
          embedding.logicalSourceType === "memory_event"
            ? "memory_event"
            : "memory_node",
          localSource.rows[0].local_source_id
        );
        if (!canonicalSource || canonicalSource.ownerUserId !== input.userId) {
          throw new Error("PDS embedding artifact source is unavailable");
        }
        const canonicalSourceTextHash = createHash("sha256")
          .update(canonicalSource.text)
          .digest("base64url");
        const expectedPortableSourceHash = pdsPortableEmbeddingSourceHash({
          logicalSourceType: embedding.logicalSourceType,
          logicalSourceId: embedding.logicalSourceId,
          sourceContentHash: embedding.sourceContentHash,
          canonicalSourceTextHash
        });
        if (
          embedding.canonicalSourceTextHash !== canonicalSourceTextHash ||
          embedding.sourceHash !== expectedPortableSourceHash
        ) {
          throw new Error(
            "PDS embedding artifact does not match canonical local source"
          );
        }
        const compatibilityContract = manifest.compatibilityContract;
        const configuredModel = resolveSupportedEmbeddingModelConfig(
          process.env.EMBEDDING_MODEL
        );
        const expectedModelArtifactHash =
          process.env.KOED_EMBEDDING_MODEL_SHA256?.trim() ||
          configuredModel.defaultArtifactSha256;
        const compatible =
          compatibilityContract.modelKey === configuredModel.key &&
          compatibilityContract.embeddingVersion === configuredModel.key &&
          compatibilityContract.dimensions ===
            String(configuredModel.dimensions) &&
          compatibilityContract.modelArtifactHash ===
            expectedModelArtifactHash &&
          compatibilityContract.tokenizer === configuredModel.tokenizer &&
          compatibilityContract.inputTransform ===
            configuredModel.inputTransform &&
          compatibilityContract.pooling === configuredModel.pooling &&
          compatibilityContract.normalization === configuredModel.normalization;
        const retained = await client.query<{ id: string }>(
          `insert into pds_portable_artifacts
           (group_id,owner_user_id,local_session_id,artifact_id,work_identity,
            artifact_class,source_package_id,source_manifest_hash,
            source_fingerprint,source_closure_hash,producer_device_id,
            claim_generation,compatibility_contract_hash,payload_hash,
            transport_manifest_hash,semantic_claim_completed_at,
            encrypted_envelope,state)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             now(),$16::jsonb,$17)
           on conflict (group_id,artifact_id) do update
           set encrypted_envelope=excluded.encrypted_envelope,
             transport_manifest_hash=excluded.transport_manifest_hash,
             state=excluded.state,updated_at=now()
           where pds_portable_artifacts.payload_hash=excluded.payload_hash
             and pds_portable_artifacts.compatibility_contract_hash=
               excluded.compatibility_contract_hash
           returning id`,
          [
            groupDbId,
            input.userId,
            localSource.rows[0].session_id,
            manifest.artifactId,
            manifest.workIdentity,
            manifest.artifactClass,
            manifest.sourcePackageId,
            manifest.sourceManifestHash,
            manifest.sourceFingerprint,
            manifest.sourceClosureHash,
            manifest.producerDeviceId,
            manifest.claimGeneration,
            manifest.compatibilityContractHash,
            manifest.payloadHash,
            input.transportManifestHash,
            JSON.stringify(input.encryptedEnvelope),
            compatible ? "imported" : "incompatible"
          ]
        );
        if (!retained.rows[0]) {
          throw new Error("PDS embedding artifact retained identity conflict");
        }
        await client.query(
          `insert into pds_artifact_inbox_entries
           (group_id,owner_user_id,package_id,manifest_hash,state,
            retained_artifact_id)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (group_id,package_id) do update
           set manifest_hash=excluded.manifest_hash,state=excluded.state,
             retained_artifact_id=excluded.retained_artifact_id,
             updated_at=now()`,
          [
            groupDbId,
            input.userId,
            manifest.artifactId,
            input.transportManifestHash,
            compatible ? "ready" : "incompatible",
            retained.rows[0].id
          ]
        );
        if (!compatible) {
          await client.query("commit");
          return { state: "incompatible", localSourceId: null };
        }
        const inserted = await client.query<{ id: string }>(
          `insert into memory_embeddings
           (memory_event_id,memory_node_id,owner_user_id,visibility,embedding_model,
            embedding_dimensions,embedding_version,source_hash,
            source_chunk_index,source_chunk_count,source_text,
            model_artifact_hash,tokenizer,input_transform,pooling,normalization)
           values (
             case when $1='memory_event' then $2::uuid else null end,
             case when $1='lcm_node' then $2::uuid else null end,
             $3,'personal',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
           )
           on conflict do nothing returning id`,
          [
            embedding.logicalSourceType,
            localSource.rows[0].local_source_id,
            input.userId,
            compatibilityContract.modelKey,
            Number(compatibilityContract.dimensions),
            compatibilityContract.embeddingVersion,
            localSource.rows[0].source_hash ??
              `pds-artifact:${embedding.logicalSourceId}`,
            Number(embedding.sourceChunkIndex),
            Number(embedding.sourceChunkCount),
            embedding.sourceText,
            compatibilityContract.modelArtifactHash,
            compatibilityContract.tokenizer,
            compatibilityContract.inputTransform,
            compatibilityContract.pooling,
            compatibilityContract.normalization
          ]
        );
        const localMemoryEmbeddingId = inserted.rows[0]?.id;
        if (!localMemoryEmbeddingId) {
          throw new Error("PDS embedding artifact identity conflict");
        }
        const vectorTable = embeddingTableForDimensions(
          Number(compatibilityContract.dimensions)
        );
        await client.query(
          `insert into ${vectorTable} (memory_embedding_id,embedding)
           values ($1,$2::vector)`,
          [localMemoryEmbeddingId, `[${embedding.vector.join(",")}]`]
        );
        await client.query(
          `insert into pds_memory_embedding_mappings
           (group_id,memory_embedding_id,logical_embedding_id,
            logical_source_type,logical_source_id,source_content_hash,
            compatibility_contract_hash,vector_hash)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            groupDbId,
            localMemoryEmbeddingId,
            embedding.logicalEmbeddingId,
            embedding.logicalSourceType,
            embedding.logicalSourceId,
            embedding.sourceContentHash,
            manifest.compatibilityContractHash,
            embedding.vectorHash
          ]
        );
        await client.query("commit");
        return {
          state: "ready",
          localSourceId: localMemoryEmbeddingId
        };
      }
      if (
        manifest.compatibilityContract.artifactClass !== "memory_event/v1" ||
        input.record.payload.artifactClass !== "memory_event/v1"
      ) {
        throw new Error("PDS artifact import class is unsupported");
      }
      const compatibilityContract = manifest.compatibilityContract;
      const event = input.record.payload.items[0]!;
      const existing = await client.query<{
        memory_event_id: string;
        content_hash: string;
      }>(
        `select memory_event_id,content_hash
         from pds_memory_event_mappings
         where group_id=$1 and logical_event_id=$2`,
        [groupDbId, event.logicalEventId]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].content_hash !== event.contentHash) {
          throw new Error("PDS artifact logical event identity conflict");
        }
        await client.query("commit");
        return {
          state: "ready",
          localSourceId: existing.rows[0].memory_event_id
        };
      }
      const sourceItems = await client.query<{
        source_ordinal: string;
        conversation_item_id: string;
        session_id: string;
        project_id: string | null;
        source_kind: "codex" | "codex-cli";
      }>(
        `with source_mapping as (
           select sim.source_ordinal,sim.conversation_item_id
           from pds_source_item_mappings sim
           join pds_session_closures c on c.id=sim.closure_id
           where c.group_id=$1 and c.package_id=$2 and c.state='ready'
           union all
           select sim.source_ordinal,sim.conversation_item_id
           from pds_source_item_mappings sim
           join pds_replica_observations o on o.replica_id=sim.replica_id
           join pds_retained_packages p on p.id=o.retained_package_id
           where p.group_id=$1 and p.package_id=$2 and p.state='ready'
         )
         select sm.source_ordinal,sm.conversation_item_id,ci.session_id,
           coalesce(s.project_override_id,s.automatic_project_id) as project_id,
           s.source_kind
         from source_mapping sm
         join conversation_items ci on ci.id=sm.conversation_item_id
         join sessions s on s.id=ci.session_id
         where sm.source_ordinal=any($3::text[])
           and ci.owner_user_id=$4 and ci.visibility='personal'
           and ci.personal_deleted_at is null
         order by array_position($3::text[],sm.source_ordinal)`,
        [
          groupDbId,
          manifest.sourcePackageId,
          event.sourceOrdinals,
          input.userId
        ]
      );
      if (
        sourceItems.rows.length !== event.sourceOrdinals.length ||
        new Set(sourceItems.rows.map((row) => row.session_id)).size !== 1 ||
        sourceItems.rows.some(
          (row, index) => row.source_ordinal !== event.sourceOrdinals[index]
        )
      ) {
        throw new Error("PDS artifact source ordinal closure is incomplete");
      }
      const localSessionId = sourceItems.rows[0]!.session_id;
      const policy = await client.query<{
        revision: string;
        rule_exists: boolean;
      }>(
        `select s.revision::text as revision,
           exists(
             select 1 from projection_policy_rules r
             where r.transcript_type=$1 and r.enabled=true
               and r.create_memory_event=true
           ) as rule_exists
         from projection_policy_state s where s.id=1`,
        [compatibilityContract.projectionPolicyKey]
      );
      const compatible =
        compatibilityContract.projectionAlgorithmVersion ===
          CURRENT_CONVERSATION_PROJECTION_VERSION &&
        new RegExp(
          `^${TOKEN_COUNTER_CONTRACT_VERSION}:js-tiktoken:(?:o200k_base|cl100k_base)$`
        ).test(compatibilityContract.tokenCounter) &&
        policy.rows[0]?.revision ===
          compatibilityContract.projectionPolicyRevision &&
        policy.rows[0]?.rule_exists === true;
      let reconciledLocalMemoryEventId: string | null = null;
      if (compatible) {
        const localSourceIds = sourceItems.rows.map(
          (row) => row.conversation_item_id
        );
        const projected = await client.query<{
          id: string;
          event_type: PdsPortableMemoryEventV1["eventType"];
          payload: Record<string, unknown>;
          include_in_embedding: boolean;
          include_in_lcm: boolean;
          token_count: number;
          seal_reason: string;
          source_event_time: Date;
          source_sequence: string;
          source_item_ids: string[];
        }>(
          `select me.id,me.event_type,me.payload,me.include_in_embedding,
             me.include_in_lcm,me.token_count,me.seal_reason,
             me.source_event_time,me.source_sequence::text as source_sequence,
             array_agg(mes.conversation_item_id::text order by mes.source_order)
               as source_item_ids
           from memory_events me
           join memory_event_sources mes on mes.memory_event_id=me.id
           where me.owner_user_id=$1 and me.visibility='personal'
             and me.session_id=$2 and me.invalidated_at is null
             and me.personal_deleted_at is null
           group by me.id
           having count(*)=$4
             and bool_and(mes.conversation_item_id=any($3::uuid[]))
           order by me.captured_at,me.id`,
          [input.userId, localSessionId, localSourceIds, localSourceIds.length]
        );
        for (const local of projected.rows) {
          if (
            local.source_item_ids.some(
              (sourceId, index) => sourceId !== localSourceIds[index]
            )
          ) {
            continue;
          }
          const actor =
            typeof local.payload.actor === "string"
              ? local.payload.actor
              : null;
          const content =
            typeof local.payload.content === "string"
              ? local.payload.content
              : null;
          const rawEventType =
            typeof local.payload.rawEventType === "string"
              ? local.payload.rawEventType
              : null;
          if (!actor || content === null || !rawEventType) continue;
          const sourceOrdinalsByItemId = new Map(
            localSourceIds.map((id, index) => [
              id,
              event.sourceOrdinals[index]!
            ])
          );
          const localContentHash = pdsPortableMemoryEventContentHash({
            sourceOrdinals: event.sourceOrdinals,
            eventType: local.event_type,
            actor,
            rawEventType,
            content,
            metadata: portableMemoryEventMetadata(
              local.payload.metadata,
              sourceOrdinalsByItemId
            ),
            includeInEmbedding: local.include_in_embedding,
            includeInLcm: local.include_in_lcm,
            tokenCount: String(local.token_count),
            sealReason: local.seal_reason,
            sourceEventTime: iso(local.source_event_time),
            sourceSequence: local.source_sequence
          });
          if (localContentHash === event.contentHash) {
            reconciledLocalMemoryEventId = local.id;
            break;
          }
        }
      }
      const retained = await client.query<{ id: string }>(
        `insert into pds_portable_artifacts
         (group_id,owner_user_id,local_session_id,artifact_id,work_identity,
          artifact_class,source_package_id,source_manifest_hash,source_fingerprint,
          source_closure_hash,producer_device_id,claim_generation,
          compatibility_contract_hash,payload_hash,transport_manifest_hash,
          semantic_claim_completed_at,encrypted_envelope,state)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
           now(),$16::jsonb,$17)
         on conflict (group_id,artifact_id) do update
         set encrypted_envelope=excluded.encrypted_envelope,
           transport_manifest_hash=excluded.transport_manifest_hash,
           state=excluded.state,updated_at=now()
         where pds_portable_artifacts.payload_hash=excluded.payload_hash
           and pds_portable_artifacts.compatibility_contract_hash=
             excluded.compatibility_contract_hash
         returning id`,
        [
          groupDbId,
          input.userId,
          localSessionId,
          manifest.artifactId,
          manifest.workIdentity,
          manifest.artifactClass,
          manifest.sourcePackageId,
          manifest.sourceManifestHash,
          manifest.sourceFingerprint,
          manifest.sourceClosureHash,
          manifest.producerDeviceId,
          manifest.claimGeneration,
          manifest.compatibilityContractHash,
          manifest.payloadHash,
          input.transportManifestHash,
          JSON.stringify(input.encryptedEnvelope),
          compatible ? "imported" : "incompatible"
        ]
      );
      if (!retained.rows[0]) {
        throw new Error("PDS artifact retained identity conflict");
      }
      await client.query(
        `insert into pds_artifact_inbox_entries
         (group_id,owner_user_id,package_id,manifest_hash,state,
          retained_artifact_id)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (group_id,package_id) do update
         set manifest_hash=excluded.manifest_hash,state=excluded.state,
           retained_artifact_id=excluded.retained_artifact_id,updated_at=now()`,
        [
          groupDbId,
          input.userId,
          manifest.artifactId,
          input.transportManifestHash,
          compatible ? "ready" : "incompatible",
          retained.rows[0].id
        ]
      );
      if (!compatible) {
        await client.query("commit");
        return { state: "incompatible", localSourceId: null };
      }
      if (reconciledLocalMemoryEventId) {
        await client.query(
          `insert into pds_memory_event_mappings
           (group_id,memory_event_id,logical_event_id,source_fingerprint,
            source_closure_hash,content_hash,source_ordinals)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (memory_event_id) do update
           set logical_event_id=excluded.logical_event_id,
             source_fingerprint=excluded.source_fingerprint,
             source_closure_hash=excluded.source_closure_hash,
             content_hash=excluded.content_hash,
             source_ordinals=excluded.source_ordinals`,
          [
            groupDbId,
            reconciledLocalMemoryEventId,
            event.logicalEventId,
            manifest.sourceFingerprint,
            manifest.sourceClosureHash,
            event.contentHash,
            event.sourceOrdinals
          ]
        );
        await client.query("commit");
        return {
          state: "ready",
          localSourceId: reconciledLocalMemoryEventId
        };
      }
      const localSourceIds = sourceItems.rows.map(
        (row) => row.conversation_item_id
      );
      const metadata = structuredClone(event.metadata);
      metadata.rawConversationItemId = localSourceIds[0];
      metadata.rawConversationItemIds = localSourceIds;
      if (Array.isArray(metadata.semanticItemManifest)) {
        metadata.semanticItemManifest = metadata.semanticItemManifest.map(
          (item: unknown) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return item;
            }
            const manifestItem = item as Record<string, unknown>;
            const ordinals = Array.isArray(manifestItem.sourceOrdinals)
              ? manifestItem.sourceOrdinals
              : [];
            const { sourceOrdinals: _sourceOrdinals, ...rest } = manifestItem;
            void _sourceOrdinals;
            return {
              ...rest,
              sourceIds: ordinals.map((ordinal) => {
                const index = event.sourceOrdinals.indexOf(String(ordinal));
                if (index < 0) {
                  throw new Error(
                    "PDS artifact semantic item ordinal is invalid"
                  );
                }
                return localSourceIds[index]!;
              })
            };
          }
        );
      }
      const payload = {
        actor: event.actor,
        content: event.content,
        metadata,
        rawEventType: event.rawEventType,
        ...(sourceItems.rows[0]!.project_id
          ? { projectId: sourceItems.rows[0]!.project_id }
          : {})
      };
      const inserted = await client.query<{ id: string }>(
        `insert into memory_events
         (actor_user_id,owner_user_id,visibility,event_type,source_runtime,
          capture_method,session_id,idempotency_key,source_hash,payload,
          include_in_embedding,include_in_lcm,projection_policy_key,
          projection_policy_revision,projection_algorithm_version,token_counter,
          token_count,seal_reason,captured_at,source_event_time,source_sequence)
         values ($1,$1,'personal',$2,$3,'transcript',$4,$5,$6,$7::jsonb,
          $8,$9,$10,$11::bigint,$12,$13,$14,$15,$16,$17,$18::bigint)
         on conflict (idempotency_key) where idempotency_key is not null
         do update
         set updated_at=now()
         where memory_events.owner_user_id=excluded.owner_user_id
           and memory_events.source_hash=excluded.source_hash
         returning id`,
        [
          input.userId,
          event.eventType,
          sourceItems.rows[0]!.source_kind,
          localSessionId,
          `pds-artifact:${event.logicalEventId}`,
          `pds-artifact:${event.logicalEventId}`,
          JSON.stringify(payload),
          event.includeInEmbedding,
          event.includeInLcm,
          compatibilityContract.projectionPolicyKey,
          compatibilityContract.projectionPolicyRevision,
          compatibilityContract.projectionAlgorithmVersion,
          compatibilityContract.tokenCounter,
          event.tokenCount,
          event.sealReason,
          event.sourceEventTime,
          event.sourceEventTime,
          event.sourceSequence
        ]
      );
      const localMemoryEventId = inserted.rows[0]?.id;
      if (!localMemoryEventId) {
        throw new Error("PDS artifact Memory Event identity conflict");
      }
      for (const [index, sourceItem] of sourceItems.rows.entries()) {
        await client.query(
          `insert into memory_event_sources
           (memory_event_id,conversation_item_id,source_order,source_role)
           values ($1,$2,$3,'derived') on conflict do nothing`,
          [localMemoryEventId, sourceItem.conversation_item_id, index]
        );
      }
      await client.query(
        `insert into pds_memory_event_mappings
         (group_id,memory_event_id,logical_event_id,source_fingerprint,
          source_closure_hash,content_hash,source_ordinals)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          groupDbId,
          localMemoryEventId,
          event.logicalEventId,
          manifest.sourceFingerprint,
          manifest.sourceClosureHash,
          event.contentHash,
          event.sourceOrdinals
        ]
      );
      await client.query("commit");
      return { state: "ready", localSourceId: localMemoryEventId };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
});

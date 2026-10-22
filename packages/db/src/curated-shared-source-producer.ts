import type pg from "pg";
import {
  crossIdentitySyncDigest,
  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ENCODED_BYTES,
  validateSharedMemoryCanonicalSourceItem,
  type EnvelopeEncryptionProvider,
  type CuratedSourceCommitmentV1,
  type SharedMemoryCanonicalSourceItemDto,
  type SharedSourceArtifactV1
} from "@koed/shared";
import { sessionExactCuratedAssertionSql } from "./approval-activity-sql.js";
import { chatAllowsTeamPublication } from "./chat-sharing-publication.js";
import { capturedSessionMayLeavePersonalBoundary } from "./project-hq-privacy.js";
import {
  assertionSelect,
  type AssertionRow
} from "./curated-memory-support.js";
import {
  decryptAuthorizedEncryptedFieldPayloadsWithClient,
  encryptedFieldReferenceKey
} from "./encrypted-payload-repository.js";

const MAX_CURATED_SOURCE_ITEMS = 100;
const MAX_CURATED_DIRECT_SOURCES = 2_048;
const directRoles = new Set([
  "primary_evidence",
  "supporting_evidence",
  "superseding_evidence",
  "conflicting_evidence"
]);

export interface CuratedSharedDirectSourceProvenance {
  kind: "conversation_item" | "memory_event" | "memory_node";
  sourceId: string;
  revisionHash: string;
  sourceSessionId: string;
}

export interface CuratedSharedAssertionProvenance {
  assertionId: string;
  classificationVersion: number;
  expiresAt: string | null;
  directSources: CuratedSharedDirectSourceProvenance[];
}

export interface CuratedSharedSourceMaterial {
  logicalMemoryId: string;
  sourceOwnerPrincipalId: string;
  sourceProjectId: string;
  workspaceProjectId: string;
  teamBackendId: string;
  teamWorkspaceId: string;
  sourceSessionId: string;
  sourceRevision: number;
  sourceCursor: number;
  manifestHash: string;
  sourceContentHash: string;
  manifest: SharedSourceArtifactV1["manifest"];
  items: SharedMemoryCanonicalSourceItemDto[];
  provenance: CuratedSharedAssertionProvenance[];
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const asText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

const asIso = (value: Date | string | null): string | null =>
  value instanceof Date ? value.toISOString() : value;

/** Resolve only the owner-authorized canonical value, never a storage marker. */
export const curatedConversationSourceText = (
  row: {
    rawText: string | null;
    metadata: Record<string, unknown> | null;
  },
  decryptedRawText: unknown
): string => {
  const encryptedColumns = row.metadata?.encryptedConversationItemColumns;
  const rawTextEncrypted =
    Array.isArray(encryptedColumns) && encryptedColumns.includes("raw_text");
  const value = rawTextEncrypted ? decryptedRawText : row.rawText;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value === "[koed encrypted conversation item]" ||
    value === "[koed encrypted conversation item observation]"
  ) {
    throw new Error("Curated Conversation item is unavailable");
  }
  return value;
};

/** A direct source changes only when its canonical content or identity changes. */
export const curatedDirectSourceRevisionHash = (input: {
  kind: CuratedSharedDirectSourceProvenance["kind"];
  sourceSessionId: string;
  item: SharedMemoryCanonicalSourceItemDto;
}): string =>
  crossIdentitySyncDigest({
    kind: input.kind,
    sourceId: input.item.sourceId,
    sourceSessionId: input.sourceSessionId,
    itemType: input.item.itemType,
    content: input.item.content
  });

const sourceItem = (input: {
  representation:
    | "memory_events"
    | "lcm_leaves"
    | "lcm_rollups"
    | "curated_assertions";
  logicalMemoryId: string;
  sourceRevision: number;
  itemType:
    | "user_message"
    | "assistant_message"
    | "lcm_leaf"
    | "lcm_rollup"
    | "curated_assertion";
  sourceId: string;
  occurredAt: string | null;
  content: Record<string, unknown>;
}): SharedMemoryCanonicalSourceItemDto =>
  validateSharedMemoryCanonicalSourceItem({
    representation: input.representation,
    logicalMemoryId: input.logicalMemoryId,
    sourceRevision: input.sourceRevision,
    item: {
      itemType: input.itemType,
      schemaVersion: 1,
      sourceId: input.sourceId,
      sourceLogicalMemoryId: input.logicalMemoryId,
      sourceRevision: input.sourceRevision,
      occurredAt: input.occurredAt,
      content: input.content
    }
  });

/**
 * Read only Personal canonical source material for one owned Captured
 * Session. The transaction makes the direct-source set, current
 * classification, Project link, and decrypted values one coherent snapshot.
 * Before consent, callers may disclose only its hash and signer identity.
 * After consent, the caller must bind it to the approved Pending Share and
 * attest it before any Team upload.
 */
export const loadPersonalCuratedSharedSourceMaterial = async (
  pool: pg.Pool,
  provider: EnvelopeEncryptionProvider,
  input: {
    ownerUserId: string;
    logicalMemoryId: string;
    sourceSessionId: string;
    sourceRevision: number;
    teamBackendId: string;
    teamWorkspaceId: string;
    /** False only while computing an owner-local pre-consent commitment. */
    requirePersistedRevision?: boolean;
  }
): Promise<CuratedSharedSourceMaterial> => {
  if (
    !Number.isSafeInteger(input.sourceRevision) ||
    input.sourceRevision <= 0
  ) {
    throw new Error("Captured Session source revision is invalid");
  }
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    if (
      !(await capturedSessionMayLeavePersonalBoundary(
        client,
        input.ownerUserId,
        input.sourceSessionId
      )) ||
      !(await chatAllowsTeamPublication(
        client,
        input.ownerUserId,
        input.logicalMemoryId,
        input.sourceSessionId
      ))
    ) {
      throw new Error("Current Captured Session publication is unavailable");
    }
    const binding = await client.query<{
      project_id: string;
      workspace_project_id: string;
      source_cursor: string | null;
    }>(
      `select project.id as project_id,
              project.workspace_project_id,
              source_revision.source_cursor
         from sessions source_session
         join projects project
           on project.id=(case when source_session.project_override_id is not null
                 then source_session.project_override_personal_project_id
                 else source_session.automatic_personal_project_id end)
          and project.owner_user_id=source_session.owner_user_id
          and project.lifecycle='active' and project.deletion_phase is null
          and project.team_backend_id=$4 and project.team_workspace_id=$5
          and project.workspace_project_id is not null
         join local_captured_session_logical_memories local_memory
           on local_memory.local_session_id=source_session.id
          and local_memory.owner_user_id=source_session.owner_user_id
          and local_memory.logical_memory_id=$3
         left join captured_session_source_revisions source_revision
           on source_revision.logical_memory_id=local_memory.logical_memory_id
          and source_revision.owner_principal_id=source_session.owner_user_id
          and source_revision.source_session_id=source_session.id
          and source_revision.source_cursor=$6
          and source_revision.revision=$6+1
        where source_session.id=$1 and source_session.owner_user_id=$2
          and source_session.visibility='personal'
          and source_session.invalidated_at is null
          and source_session.personal_deleted_at is null
          and source_session.trashed_at is null
          and source_session.delete_batch_id is null
          and source_session.forget_batch_id is null
          and source_session.project_share_private_at is null
          and source_session.project_share_private_pending_at is null
          and source_session.project_share_move_pending_at is null
          and ($7::boolean=false or source_revision.source_revision_id is not null)
          and $6=(select coalesce(max(change.cursor),0)
                    from sync_semantic_changes change
                   where change.session_id=source_session.id)
        limit 1`,
      [
        input.sourceSessionId,
        input.ownerUserId,
        input.logicalMemoryId,
        input.teamBackendId,
        input.teamWorkspaceId,
        input.sourceRevision,
        input.requirePersistedRevision ?? true
      ]
    );
    if (!binding.rows[0]) {
      throw new Error(
        "Current exact Session Project source binding is unavailable"
      );
    }
    const sourceCursor =
      binding.rows[0].source_cursor === null
        ? input.sourceRevision
        : Number(binding.rows[0].source_cursor);
    if (
      !Number.isSafeInteger(sourceCursor) ||
      sourceCursor !== input.sourceRevision
    ) {
      throw new Error("Current Captured Session frontier changed");
    }
    const rows = await client.query<AssertionRow>(
      `select ${assertionSelect}
         from curated_memory_assertions cma
         left join curated_memory_topics cmt on cmt.id=cma.topic_id
        where cma.owner_user_id=$1 and cma.visibility='personal'
          and cma.status='current' and cma.suppressed_at is null
          and (cma.expires_at is null or cma.expires_at>now())
          and cma.scope='project' and cma.scope_activation_state='active'
          and cma.project_id=$3
          and not exists (
            select 1 from curated_memory_classification_operations pending
             where pending.assertion_id=cma.id
               and pending.state in ('pending','ready')
          )
          and ${sessionExactCuratedAssertionSql("$1", "$2")}
        order by cma.observed_at,cma.id
        limit $4`,
      [
        input.ownerUserId,
        input.sourceSessionId,
        binding.rows[0].project_id,
        MAX_CURATED_SOURCE_ITEMS + 1
      ]
    );
    if (rows.rows.length > MAX_CURATED_SOURCE_ITEMS) {
      throw new Error("Curated source exceeds the item consent boundary");
    }
    const sourceRows = await client.query<{
      assertion_id: string;
      source_role: string;
      conversation_item_id: string | null;
      memory_event_id: string | null;
      lcm_node_id: string | null;
    }>(
      `select assertion_id,source_role,conversation_item_id,memory_event_id,lcm_node_id
         from curated_memory_sources
        where assertion_id=any($1::uuid[])
        order by created_at,id
        limit $2`,
      [rows.rows.map((row) => row.id), MAX_CURATED_DIRECT_SOURCES + 1]
    );
    const sourcesByAssertion = new Map<string, typeof sourceRows.rows>();
    for (const row of sourceRows.rows) {
      if (!directRoles.has(row.source_role)) {
        throw new Error(
          "Curated source provenance includes an unsupported role"
        );
      }
      sourcesByAssertion.set(row.assertion_id, [
        ...(sourcesByAssertion.get(row.assertion_id) ?? []),
        row
      ]);
    }
    const direct = [...sourcesByAssertion.values()].flat();
    if (direct.length > MAX_CURATED_DIRECT_SOURCES) {
      throw new Error("Curated direct source set exceeds the consent boundary");
    }
    const conversationIds = direct.flatMap((row) =>
      row.conversation_item_id ? [row.conversation_item_id] : []
    );
    const eventIds = direct.flatMap((row) =>
      row.memory_event_id ? [row.memory_event_id] : []
    );
    const nodeIds = direct.flatMap((row) =>
      row.lcm_node_id ? [row.lcm_node_id] : []
    );
    const conversation = await client.query<{
      id: string;
      raw_text: string | null;
      metadata: Record<string, unknown> | null;
    }>(
      `select id,raw_text,metadata from conversation_items where id=any($1::uuid[])
           and owner_user_id=$2 and session_id=$3 and visibility='personal'
           and personal_deleted_at is null and memory_excluded_at is null`,
      [conversationIds, input.ownerUserId, input.sourceSessionId]
    );
    const events = await client.query<{ id: string; payload: unknown }>(
      `select id,payload from memory_events where id=any($1::uuid[])
           and owner_user_id=$2 and session_id=$3 and visibility='personal'
           and invalidated_at is null and personal_deleted_at is null`,
      [eventIds, input.ownerUserId, input.sourceSessionId]
    );
    const nodes = await client.query<{
      root_id: string;
      expected_count: number;
      active_count: string;
      exact_count: string;
      invalid_node_count: string;
      root_kind: "leaf" | "rollup";
      summary_text: string;
      source_ids: string[];
    }>(
      `with recursive descendants(root_id,id) as (
           select id,id from memory_nodes where id=any($1::uuid[])
           union
           select parent.root_id,child.child_memory_node_id
             from memory_node_children child
             join descendants parent on parent.id=child.parent_memory_node_id
         ), underlying as (
           select distinct d.root_id,mns.memory_event_id
             from descendants d
             join memory_node_sources mns on mns.memory_node_id=d.id
         )
         select root.id as root_id,root.source_event_count as expected_count,
                root.kind as root_kind,root.summary_text,
                array_agg(distinct me.id) filter (where me.id is not null) as source_ids,
                count(distinct me.id)::text as active_count,
                count(distinct me.id) filter (where me.session_id=$3)::text as exact_count,
                count(distinct d.id) filter (where node.id is null)::text as invalid_node_count
           from memory_nodes root
           join descendants d on d.root_id=root.id
           left join memory_nodes node on node.id=d.id
            and node.owner_user_id=$2 and node.visibility='personal'
            and node.invalidated_at is null and node.personal_deleted_at is null
            and node.session_id=$3
           left join underlying u on u.root_id=root.id
           left join memory_events me on me.id=u.memory_event_id
            and me.owner_user_id=$2 and me.visibility='personal'
            and me.invalidated_at is null and me.personal_deleted_at is null
          where root.id=any($1::uuid[]) and root.owner_user_id=$2
          group by root.id,root.source_event_count,root.kind,root.summary_text`,
      [nodeIds, input.ownerUserId, input.sourceSessionId]
    );
    const conversationById = new Map(
      conversation.rows.map((row) => [row.id, row])
    );
    const eventsById = new Map(events.rows.map((row) => [row.id, row]));
    const nodesById = new Map(nodes.rows.map((row) => [row.root_id, row]));
    const encrypted = await decryptAuthorizedEncryptedFieldPayloadsWithClient(
      client,
      { userId: input.ownerUserId },
      provider,
      [
        ...conversationIds.map((sourceId) => ({
          sourceTable: "conversation_items" as const,
          sourceId,
          sourceColumn: "raw_text"
        })),
        ...eventIds.map((sourceId) => ({
          sourceTable: "memory_events" as const,
          sourceId,
          sourceColumn: "payload"
        })),
        ...nodeIds.map((sourceId) => ({
          sourceTable: "memory_nodes" as const,
          sourceId,
          sourceColumn: "summary_text"
        })),
        ...rows.rows.map((row) => ({
          sourceTable: "curated_memory_assertions" as const,
          sourceId: row.id,
          sourceColumn: "payload"
        })),
        ...rows.rows.flatMap((row) =>
          row.topic_id
            ? [
                {
                  sourceTable: "curated_memory_topics" as const,
                  sourceId: row.topic_id,
                  sourceColumn: "payload"
                }
              ]
            : []
        )
      ]
    );
    const plaintext = (
      sourceTable:
        | "conversation_items"
        | "memory_events"
        | "memory_nodes"
        | "curated_memory_assertions"
        | "curated_memory_topics",
      sourceId: string,
      sourceColumn: string
    ): unknown =>
      encrypted.get(
        encryptedFieldReferenceKey({ sourceTable, sourceId, sourceColumn })
      )?.plaintext;
    const items: SharedMemoryCanonicalSourceItemDto[] = [];
    const manifest: SharedSourceArtifactV1["manifest"] = [];
    const provenance: CuratedSharedAssertionProvenance[] = [];
    for (const assertion of rows.rows) {
      const sources = sourcesByAssertion.get(assertion.id) ?? [];
      if (sources.length === 0)
        throw new Error("Curated source set is incomplete");
      const directSources: CuratedSharedDirectSourceProvenance[] = [];
      for (const source of sources) {
        const identifiers = [
          source.conversation_item_id,
          source.memory_event_id,
          source.lcm_node_id
        ].filter((id): id is string => id !== null);
        if (identifiers.length !== 1)
          throw new Error("Curated direct source is ambiguous");
        const sourceId = identifiers[0]!;
        let kind: CuratedSharedDirectSourceProvenance["kind"];
        let item: SharedMemoryCanonicalSourceItemDto;
        if (source.conversation_item_id) {
          const row = conversationById.get(sourceId);
          if (!row) throw new Error("Curated Conversation item is unavailable");
          const value = curatedConversationSourceText(
            { rawText: row.raw_text, metadata: row.metadata },
            plaintext("conversation_items", sourceId, "raw_text")
          );
          kind = "conversation_item";
          item = sourceItem({
            representation: "memory_events",
            logicalMemoryId: input.logicalMemoryId,
            sourceRevision: input.sourceRevision,
            itemType: "user_message",
            sourceId,
            occurredAt: null,
            content: { text: asText(value) }
          });
        } else if (source.memory_event_id) {
          const row = eventsById.get(sourceId);
          const storedPayload = object(row?.payload);
          const payloadEncrypted = storedPayload?.contentEncrypted === true;
          const value = payloadEncrypted
            ? plaintext("memory_events", sourceId, "payload")
            : row?.payload;
          const payload = object(value);
          if (
            !row ||
            !payload ||
            payload.contentEncrypted === true ||
            payload.content === "[koed encrypted memory event]"
          )
            throw new Error("Curated Memory Event is unavailable");
          kind = "memory_event";
          item = sourceItem({
            representation: "memory_events",
            logicalMemoryId: input.logicalMemoryId,
            sourceRevision: input.sourceRevision,
            itemType:
              payload?.actor === "assistant"
                ? "assistant_message"
                : "user_message",
            sourceId,
            occurredAt: null,
            content: {
              text:
                typeof payload?.content === "string"
                  ? payload.content
                  : asText(value)
            }
          });
        } else {
          const row = nodesById.get(sourceId);
          const value =
            row?.summary_text === "[koed encrypted memory node]"
              ? plaintext("memory_nodes", sourceId, "summary_text")
              : row?.summary_text;
          if (
            !row ||
            !Number(row.active_count) ||
            Number(row.active_count) !== Number(row.exact_count) ||
            Number(row.active_count) !== Number(row.expected_count) ||
            Number(row.invalid_node_count) !== 0 ||
            typeof value !== "string" ||
            !value.trim() ||
            value === "[koed encrypted memory node]"
          ) {
            throw new Error("Curated LCM source is unavailable");
          }
          kind = "memory_node";
          item = sourceItem({
            representation:
              row.root_kind === "rollup" ? "lcm_rollups" : "lcm_leaves",
            logicalMemoryId: input.logicalMemoryId,
            sourceRevision: input.sourceRevision,
            itemType: row.root_kind === "rollup" ? "lcm_rollup" : "lcm_leaf",
            sourceId,
            occurredAt: null,
            content: {
              summaryText: asText(value),
              lexicalAnchors: [],
              sourceIds: row.source_ids
            }
          });
        }
        directSources.push({
          kind,
          sourceId,
          sourceSessionId: input.sourceSessionId,
          revisionHash: curatedDirectSourceRevisionHash({
            kind,
            sourceSessionId: input.sourceSessionId,
            item
          })
        });
      }
      const payload = object(
        plaintext("curated_memory_assertions", assertion.id, "payload")
      );
      if (!payload) throw new Error("Curated assertion payload is unavailable");
      const topicPayload = assertion.topic_id
        ? object(
            plaintext("curated_memory_topics", assertion.topic_id, "payload")
          )
        : null;
      const assertionText = nullableString(payload.assertionText);
      if (!assertionText)
        throw new Error("Curated assertion text is unavailable");
      const topicTitle =
        nullableString(payload.topicTitle) ??
        nullableString(topicPayload?.title) ??
        assertion.topic_title;
      const tags = Array.isArray(payload.tags) ? payload.tags : null;
      if (
        !tags ||
        !tags.every((tag): tag is string => typeof tag === "string")
      ) {
        throw new Error("Curated assertion tags are malformed");
      }
      const item = sourceItem({
        representation: "curated_assertions",
        logicalMemoryId: input.logicalMemoryId,
        sourceRevision: input.sourceRevision,
        itemType: "curated_assertion",
        sourceId: assertion.id,
        occurredAt: assertion.observed_at.toISOString(),
        content: {
          assertionText,
          topicTitle,
          tags,
          sourceCount: sources.length,
          scopeProtocolVersion: 1,
          classificationVersion: assertion.classification_version
        }
      });
      items.push(item);
      manifest.push({
        sourceId: assertion.id,
        sourceTable: "curated_memory_assertions",
        itemType: "curated_assertion",
        sourceCursor: input.sourceRevision,
        revisionHash: crossIdentitySyncDigest({
          assertionText,
          topicTitle,
          tags,
          classificationVersion: assertion.classification_version,
          expiresAt: asIso(assertion.expires_at),
          sourceProjectId: binding.rows[0].project_id,
          workspaceProjectId: binding.rows[0].workspace_project_id,
          directSources
        }),
        occurredAt: item.occurredAt,
        sourceEventId: null,
        sourceNodeId: null
      });
      provenance.push({
        assertionId: assertion.id,
        classificationVersion: assertion.classification_version,
        expiresAt: asIso(assertion.expires_at),
        directSources
      });
    }
    const material: CuratedSharedSourceMaterial = {
      logicalMemoryId: input.logicalMemoryId,
      sourceOwnerPrincipalId: input.ownerUserId,
      sourceProjectId: binding.rows[0].project_id,
      workspaceProjectId: binding.rows[0].workspace_project_id,
      teamBackendId: input.teamBackendId,
      teamWorkspaceId: input.teamWorkspaceId,
      sourceSessionId: input.sourceSessionId,
      sourceRevision: input.sourceRevision,
      sourceCursor,
      items,
      manifest,
      provenance,
      manifestHash: crossIdentitySyncDigest(manifest),
      sourceContentHash: crossIdentitySyncDigest(items)
    };
    if (
      Buffer.byteLength(JSON.stringify(material), "utf8") >
      SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ENCODED_BYTES
    ) {
      throw new Error("Curated source artifact exceeds the consent boundary");
    }
    await client.query("commit");
    return material;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

/** Pure boundary mapping: the caller must bind teamId through Team admission. */
export const curatedSharedSourceCommitment = (
  material: CuratedSharedSourceMaterial,
  input: { sourceDeploymentProtocolId: string; teamId: string }
): CuratedSourceCommitmentV1 => ({
  protocol: "koed.curated-source-commitment/v1",
  source: {
    kind: "captured_session",
    sessionId: material.sourceSessionId,
    logicalMemoryId: material.logicalMemoryId
  },
  sourceDeploymentProtocolId: input.sourceDeploymentProtocolId,
  sourceOwnerPrincipalId: material.sourceOwnerPrincipalId,
  sourceProjectId: material.sourceProjectId,
  workspaceProjectId: material.workspaceProjectId,
  teamBackendId: material.teamBackendId,
  teamId: input.teamId,
  teamWorkspaceId: material.teamWorkspaceId,
  sourceRevision: material.sourceRevision,
  manifest: material.manifest,
  items: material.items,
  assertions: material.provenance
});

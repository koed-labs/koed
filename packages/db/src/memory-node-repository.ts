import pg from "pg";
import { recordAuditEventWithClient } from "./audit-repository.js";
import {
  clusterIdForLabel,
  isGenericDevelopmentActivity,
  presentMemoryText
} from "./presentation.js";
import { truncateDisplayText } from "./value-helpers.js";
import type {
  ActorContext,
  CreateMemoryNodeInput,
  MemoryBrowserItem,
  MemoryClusterRecord,
  MemoryNodeRecord,
  Visibility
} from "./types.js";

export interface MemoryNodeRepository {
  createMemoryNode(
    actor: ActorContext,
    input: CreateMemoryNodeInput
  ): Promise<MemoryNodeRecord>;
  getVisibleMemoryNode(
    actor: ActorContext,
    nodeId: string
  ): Promise<MemoryNodeRecord | null>;
  listVisibleMemoryNodes(
    actor: ActorContext,
    visibility?: Visibility
  ): Promise<MemoryNodeRecord[]>;
  listMemoryBrowserItems(
    actor: ActorContext,
    input?: {
      query?: string;
      visibility?: Visibility;
      projectId?: string;
      threadId?: string;
      pinned?: boolean;
      limit?: number;
    }
  ): Promise<MemoryBrowserItem[]>;
  listMemoryClusters(
    actor: ActorContext,
    input?: {
      query?: string;
      visibility?: Visibility;
      projectId?: string;
      threadId?: string;
      limit?: number;
      itemsPerCluster?: number;
    }
  ): Promise<MemoryClusterRecord[]>;
  listMemoriesInCluster(
    actor: ActorContext,
    clusterId: string,
    input?: { limit?: number }
  ): Promise<MemoryBrowserItem[]>;
  updateMemoryPresentation(
    actor: ActorContext,
    nodeId: string,
    input: { summaryText?: string; pinned?: boolean; visibility?: Visibility }
  ): Promise<MemoryBrowserItem | null>;
  deleteMemory(actor: ActorContext, nodeId: string): Promise<boolean>;
}

type MemoryNodeRow = {
  id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  title: string | null;
  summary_text: string;
  created_at?: Date;
  updated_at?: Date;
  pinned_at?: Date | null;
  project_id?: string | null;
  project_name?: string | null;
  project_path?: string | null;
  thread_id?: string | null;
  thread_name?: string | null;
};

type MemoryBrowserItemRow = {
  id: string;
  title: string | null;
  summary_text: string;
  visibility: Visibility;
  created_at: Date;
  updated_at: Date;
  pinned_at: Date | null;
  project_id: string | null;
  project_name: string | null;
  project_path: string | null;
  thread_id: string | null;
  thread_name: string | null;
};

const mapMemoryNode = (row: MemoryNodeRow): MemoryNodeRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  visibility: row.visibility,
  title: row.title,
  summaryText: row.summary_text,
  ...(row.created_at ? { createdAt: row.created_at.toISOString() } : {}),
  ...(row.updated_at ? { updatedAt: row.updated_at.toISOString() } : {}),
  ...(row.pinned_at !== undefined
    ? { pinnedAt: row.pinned_at?.toISOString() ?? null }
    : {}),
  ...(row.project_id !== undefined ? { projectId: row.project_id } : {}),
  ...(row.project_name !== undefined ? { projectName: row.project_name } : {}),
  ...(row.project_path !== undefined ? { projectPath: row.project_path } : {}),
  ...(row.thread_id !== undefined ? { threadId: row.thread_id } : {}),
  ...(row.thread_name !== undefined ? { threadName: row.thread_name } : {})
});

const mapMemoryBrowserItem = (row: MemoryBrowserItemRow): MemoryBrowserItem => {
  const text = presentMemoryText(row.summary_text, row);
  const titleLabel = row.title ? truncateDisplayText(row.title, 80) : "";
  const label = isGenericDevelopmentActivity(text, row)
    ? "Development Activity"
    : titleLabel || "General";
  return {
    id: row.id,
    clusterId: clusterIdForLabel(label),
    clusterLabel: label,
    text,
    title: row.title,
    visibility: row.visibility,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    pinnedAt: row.pinned_at?.toISOString() ?? null,
    projectId: row.project_id,
    projectName: row.project_name,
    projectPath: row.project_path,
    threadId: row.thread_id,
    threadName: row.thread_name
  };
};

export const createMemoryNodeRepository = (
  pool: pg.Pool
): MemoryNodeRepository => {
  const getVisibleMemoryNode = async (
    actor: ActorContext,
    nodeId: string
  ): Promise<MemoryNodeRecord | null> => {
    const result = await pool.query<MemoryNodeRow>(
      `
        select mn.id, mn.owner_user_id, mn.visibility, mn.title, mn.summary_text
        from memory_nodes mn
        where mn.id = $2
          and mn.invalidated_at is null
          and mn.visibility = 'personal'
          and mn.owner_user_id = $1
        limit 1
      `,
      [actor.userId, nodeId]
    );

    return result.rows[0] ? mapMemoryNode(result.rows[0]) : null;
  };

  const listMemoryBrowserItems = async (
    actor: ActorContext,
    input: Parameters<MemoryNodeRepository["listMemoryBrowserItems"]>[1] = {}
  ): Promise<MemoryBrowserItem[]> => {
    const requestedLimit = input.limit ?? 100;
    const candidateLimit = Math.min(requestedLimit * 10, 500);
    const result = await pool.query<MemoryBrowserItemRow>(
      `
        select
          mn.id,
          mn.title,
          mn.summary_text,
          mn.visibility,
          mn.created_at,
          mn.updated_at,
          mn.pinned_at,
          coalesce(
            case when ev.payload ->> 'workspaceId' = s.id::text then null else ev.payload ->> 'workspaceId' end,
            s.workspace_id::text,
            s.cwd
          ) as project_id,
          coalesce(ev.payload #>> '{metadata,projectName}', s.workspace_id::text, s.cwd) as project_name,
          coalesce(
            ev.payload #>> '{metadata,projectPath}',
            s.cwd,
            case when ev.payload ->> 'workspaceId' = s.id::text then null else ev.payload ->> 'workspaceId' end
          ) as project_path,
          coalesce(ev.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text) as thread_id,
          coalesce(s.metadata ->> 'threadName', ev.payload #>> '{metadata,threadName}', s.external_session_id, s.id::text) as thread_name
        from memory_nodes mn
        left join lateral (
          select mns.memory_event_id
          from memory_node_sources mns
          where mns.memory_node_id = mn.id
            and mns.memory_event_id is not null
          order by mns.source_order asc
          limit 1
        ) first_source on true
        left join memory_events ev on ev.id = first_source.memory_event_id
        left join sessions s on s.id = ev.session_id
        where mn.invalidated_at is null
          and mn.visibility = 'personal'
          and mn.owner_user_id = $1
          and ($2::visibility_scope is null or mn.visibility = $2::visibility_scope)
          and ($3::text is null or coalesce(
            case when ev.payload ->> 'workspaceId' = s.id::text then null else ev.payload ->> 'workspaceId' end,
            s.workspace_id::text,
            s.cwd
          ) = $3)
          and ($4::text is null or coalesce(ev.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text) = $4)
          and ($5::boolean is null or (($5::boolean = true and mn.pinned_at is not null) or ($5::boolean = false and mn.pinned_at is null)))
          and ($6::text is null or mn.summary_text ilike '%' || $6 || '%' or coalesce(mn.title, '') ilike '%' || $6 || '%')
        order by mn.pinned_at desc nulls last, mn.updated_at desc, mn.created_at desc
        limit $7
      `,
      [
        actor.userId,
        input.visibility ?? null,
        input.projectId ?? null,
        input.threadId ?? null,
        input.pinned ?? null,
        input.query?.trim() || null,
        candidateLimit
      ]
    );
    return result.rows
      .map(mapMemoryBrowserItem)
      .filter(
        (item) =>
          item.clusterLabel !== "Development Activity" ||
          Boolean(input.query?.trim())
      )
      .slice(0, requestedLimit);
  };

  return {
    async createMemoryNode(actor, input) {
      const ownerUserId = actor.userId;

      const result = await pool.query<MemoryNodeRow>(
        `
          insert into memory_nodes (
            owner_user_id,
            created_by_user_id,
            visibility,
            kind,
            depth,
            title,
            summary_text,
            body_text,
            source_runtime,
            capture_method,
            codex_transcript_path,
            idempotency_key,
            source_hash,
            summary_model,
            summary_prompt_version,
            lcm_algorithm_version
          )
          values (
            $1, $2, $3, 'leaf', 0, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
          )
          returning id, owner_user_id, visibility, title, summary_text
        `,
        [
          ownerUserId,
          actor.userId,
          input.visibility,
          input.title ?? null,
          input.summaryText,
          input.bodyText ?? null,
          input.sourceRuntime ?? null,
          input.captureMethod ?? "mcp",
          input.codexTranscriptPath ?? null,
          input.idempotencyKey ?? null,
          input.sourceHash ?? null,
          input.summaryModel ?? null,
          input.summaryPromptVersion ?? null,
          input.lcmAlgorithmVersion ?? null
        ]
      );

      return mapMemoryNode(result.rows[0]!);
    },

    getVisibleMemoryNode,

    async listVisibleMemoryNodes(actor, visibility) {
      const result = await pool.query<MemoryNodeRow>(
        `
          select mn.id, mn.owner_user_id, mn.visibility, mn.title, mn.summary_text
          from memory_nodes mn
          where mn.invalidated_at is null
            and mn.visibility = 'personal'
            and mn.owner_user_id = $1
            and ($2::visibility_scope is null or mn.visibility = $2::visibility_scope)
          order by mn.created_at asc, mn.id asc
        `,
        [actor.userId, visibility ?? null]
      );

      return result.rows.map(mapMemoryNode);
    },

    listMemoryBrowserItems,

    async listMemoryClusters(actor, input = {}) {
      const items = await listMemoryBrowserItems(actor, {
        ...input,
        limit: input.limit ? input.limit * (input.itemsPerCluster ?? 4) : 200
      });
      const groups = new Map<string, MemoryClusterRecord>();
      for (const item of items) {
        const current = groups.get(item.clusterId);
        if (current) {
          current.count += 1;
          current.pinnedCount += item.pinnedAt ? 1 : 0;
          if (item.updatedAt > current.latestUpdatedAt) {
            current.latestUpdatedAt = item.updatedAt;
          }
          if (current.items.length < (input.itemsPerCluster ?? 4)) {
            current.items.push(item);
          }
        } else {
          groups.set(item.clusterId, {
            id: item.clusterId,
            label: item.clusterLabel,
            count: 1,
            latestUpdatedAt: item.updatedAt,
            pinnedCount: item.pinnedAt ? 1 : 0,
            items: [item]
          });
        }
      }
      return [...groups.values()]
        .sort((left, right) =>
          right.latestUpdatedAt.localeCompare(left.latestUpdatedAt)
        )
        .slice(0, input.limit ?? 50);
    },

    async listMemoriesInCluster(actor, clusterId, input = {}) {
      const items = await listMemoryBrowserItems(actor, {
        limit: Math.max(input.limit ?? 100, 100)
      });
      return items
        .filter((item) => item.clusterId === clusterId)
        .slice(0, input.limit ?? 100);
    },

    async updateMemoryPresentation(actor, nodeId, input) {
      const existing = await getVisibleMemoryNode(actor, nodeId);
      if (!existing) {
        return null;
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<MemoryBrowserItemRow>(
          `
            update memory_nodes mn
            set
              summary_text = coalesce($3, mn.summary_text),
              pinned_at = case
                when $4::boolean is null then mn.pinned_at
                when $4::boolean = true then coalesce(mn.pinned_at, now())
                else null
              end,
              visibility = coalesce($5::visibility_scope, mn.visibility),
              owner_user_id = case
                when $5::visibility_scope = 'personal' then $1
                else mn.owner_user_id
              end,
              updated_at = now()
            where mn.id = $2
              and mn.invalidated_at is null
            returning
              mn.id,
              mn.title,
              mn.summary_text,
              mn.visibility,
              mn.created_at,
              mn.updated_at,
              mn.pinned_at,
              null::text as project_id,
              null::text as project_name,
              null::text as project_path,
              null::text as thread_id,
              null::text as thread_name
          `,
          [
            actor.userId,
            nodeId,
            input.summaryText ?? null,
            input.pinned ?? null,
            input.visibility ?? null
          ]
        );
        const updated = result.rows[0]
          ? mapMemoryBrowserItem(result.rows[0])
          : null;
        if (updated) {
          const previousPinned = Boolean(existing.pinnedAt);
          const nextPinned = Boolean(updated.pinnedAt);
          const changedFields = [
            input.summaryText !== undefined &&
            input.summaryText !== existing.summaryText
              ? "summaryText"
              : null,
            input.pinned !== undefined && input.pinned !== previousPinned
              ? "pinned"
              : null,
            input.visibility !== undefined &&
            input.visibility !== existing.visibility
              ? "visibility"
              : null
          ].filter((field): field is string => Boolean(field));

          if (changedFields.length > 0) {
            await recordAuditEventWithClient(client, {
              actorUserId: actor.userId,
              ownerUserId: actor.userId,
              visibility: updated.visibility,
              action: "memory.presentation_updated",
              targetTable: "memory_nodes",
              targetId: nodeId,
              metadata: {
                changedFields,
                previousVisibility: existing.visibility,
                nextVisibility: updated.visibility,
                previousPinned,
                nextPinned
              }
            });
          }
        }
        await client.query("commit");
        return updated;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteMemory(actor, nodeId) {
      const existing = await getVisibleMemoryNode(actor, nodeId);
      if (!existing) {
        return false;
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query(
          `
            update memory_nodes mn
            set invalidated_at = now(), invalidation_reason = 'user_deleted'
            where mn.id = $2
              and mn.invalidated_at is null
              and mn.visibility = 'personal'
              and mn.owner_user_id = $1
          `,
          [actor.userId, nodeId]
        );
        const deleted = (result.rowCount ?? 0) > 0;
        if (deleted) {
          await recordAuditEventWithClient(client, {
            actorUserId: actor.userId,
            ownerUserId: actor.userId,
            visibility: existing.visibility,
            action: "memory.deleted",
            targetTable: "memory_nodes",
            targetId: nodeId,
            metadata: {
              projectId: existing.projectId ?? null,
              projectName: existing.projectName ?? null,
              threadId: existing.threadId ?? null,
              threadName: existing.threadName ?? null
            }
          });
        }
        await client.query("commit");
        return deleted;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  };
};

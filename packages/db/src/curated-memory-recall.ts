import {
  codexIdePromptUserText,
  type LcmSourceItem,
  type MemoryActor,
  type MemoryEventRecord,
  type MemoryEventType
} from "@koed/core";
import { decryptAuthorizedEncryptedFieldPayloadWithClient } from "./encrypted-payload-repository.js";
import type { CuratedMemoryRepository } from "./curated-memory-repository.js";
import {
  activeCuratedMemoryEvidencePredicate,
  curatedMemoryActiveEvidenceRowsSql
} from "./curated-memory-policy.js";
import {
  assertionSelect,
  hydrateAssertionRow,
  loadSources,
  mapAssertion,
  positiveLimit,
  protectedCuratedMemoryPayloadsRequired,
  recordValue,
  requireEncryptionProvider,
  type AssertionRow,
  type CuratedMemoryRepositoryContext
} from "./curated-memory-support.js";
import type { Visibility } from "./types.js";

export const createCuratedMemoryRecallMethods = ({
  pool,
  envelopeEncryptionProvider
}: CuratedMemoryRepositoryContext): Pick<
  CuratedMemoryRepository,
  "searchCuratedMemoryAssertions" | "expandCuratedMemoryRetrieval"
> => ({
  async searchCuratedMemoryAssertions(actor, input) {
    const terms = input.query
      .toLowerCase()
      .split(/[^a-z0-9_'-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3)
      .slice(0, 12);
    const patterns =
      terms.length > 0
        ? terms.map((term) => `%${term}%`)
        : [`%${input.query.trim().toLowerCase()}%`];
    const currentOnly = input.currentOnly ?? true;
    const temporalEvidenceSql = curatedMemoryActiveEvidenceRowsSql(
      "cma",
      "temporal"
    );
    const scopedEvidenceSql = curatedMemoryActiveEvidenceRowsSql(
      "cma",
      "scoped"
    );
    if (protectedCuratedMemoryPayloadsRequired()) {
      requireEncryptionProvider(envelopeEncryptionProvider);
      const candidates = await pool.query<AssertionRow>(
        `
          select ${assertionSelect}
          from curated_memory_assertions cma
          left join curated_memory_topics cmt on cmt.id = cma.topic_id
          where cma.owner_user_id = $1
            and cma.visibility = 'personal'
            and cma.suppressed_at is null
            and ($2::boolean = false or cma.status = 'current')
            and (cma.expires_at is null or cma.expires_at > now())
            and ${activeCuratedMemoryEvidencePredicate("cma")}
            and (
              ($6::timestamptz is null and $7::timestamptz is null)
              or exists (
                select 1
                from (${temporalEvidenceSql}) temporal_source
                where temporal_source.source_event_time >= coalesce($6::timestamptz, '-infinity'::timestamptz)
                  and temporal_source.source_event_time < coalesce($7::timestamptz, 'infinity'::timestamptz)
              )
            )
            and (
              $3::text = 'global'
              or (
                $3::text = 'session'
                and exists (
                  select 1
                  from (${scopedEvidenceSql}) scoped_source
                  where scoped_source.source_session_id = $4::uuid
                )
              )
              or (
                $3::text = 'project'
                and exists (
                  select 1
                  from (${scopedEvidenceSql}) scoped_source
                  where $5 in (
                    scoped_source.ci_project_id,
                    scoped_source.ci_stable_project_id,
                    scoped_source.ci_project_path,
                    scoped_source.me_project_id,
                    scoped_source.me_project_path,
                    scoped_source.node_project_id,
                    scoped_source.node_project_path
                  )
                )
              )
            )
          order by
            cma.updated_at desc,
            cma.id desc
          limit 500
        `,
        [
          actor.userId,
          currentOnly,
          input.searchDomain ?? "global",
          input.sessionId ?? null,
          input.projectId ?? null,
          input.sourceAfter ?? null,
          input.sourceBefore ?? null
        ]
      );
      const hydrated = await Promise.all(
        candidates.rows.map((row) =>
          hydrateAssertionRow(pool, actor, envelopeEncryptionProvider, row)
        )
      );
      const queryTerms =
        terms.length > 0
          ? terms
          : [input.query.trim().toLowerCase()].filter(Boolean);
      const matching = hydrated
        .filter((row) => {
          const searchable = [
            row.assertion_text,
            row.topic_title ?? "",
            ...(row.tags ?? [])
          ].map((value) => value.toLowerCase());
          return queryTerms.some((term) =>
            searchable.some((value) => value.includes(term))
          );
        })
        .slice(0, positiveLimit(input.limit, 10));
      const sourceMap = await loadSources(
        pool,
        actor,
        envelopeEncryptionProvider,
        matching.map((row) => row.id)
      );
      return matching.map((row) => mapAssertion(row, sourceMap.get(row.id)));
    }
    const result = await pool.query<AssertionRow>(
      `
        select ${assertionSelect}
        from curated_memory_assertions cma
        left join curated_memory_topics cmt on cmt.id = cma.topic_id
        where cma.owner_user_id = $1
          and cma.visibility = 'personal'
          and cma.suppressed_at is null
          and ($2::boolean = false or cma.status = 'current')
          and (cma.expires_at is null or cma.expires_at > now())
          and ${activeCuratedMemoryEvidencePredicate("cma")}
          and (
            lower(cma.assertion_text) like any($3::text[])
            or lower(coalesce(cmt.title, '')) like any($3::text[])
            or exists (
              select 1
              from unnest(cma.tags) as tag
              where lower(tag) like any($3::text[])
            )
          )
          and (
            ($8::timestamptz is null and $9::timestamptz is null)
            or exists (
              select 1
              from (${temporalEvidenceSql}) temporal_source
              where temporal_source.source_event_time >= coalesce($8::timestamptz, '-infinity'::timestamptz)
                and temporal_source.source_event_time < coalesce($9::timestamptz, 'infinity'::timestamptz)
            )
          )
          and (
            $4::text = 'global'
            or (
              $4::text = 'session'
              and exists (
                select 1
                from (${scopedEvidenceSql}) scoped_source
                where scoped_source.source_session_id = $5::uuid
              )
            )
            or (
              $4::text = 'project'
              and exists (
                select 1
                from (${scopedEvidenceSql}) scoped_source
                where $6 in (
                  scoped_source.ci_project_id,
                  scoped_source.ci_stable_project_id,
                  scoped_source.ci_project_path,
                  scoped_source.me_project_id,
                  scoped_source.me_project_path,
                  scoped_source.node_project_id,
                  scoped_source.node_project_path
                )
              )
            )
          )
        order by
          cma.updated_at desc,
          cma.id desc
        limit $7
      `,
      [
        actor.userId,
        currentOnly,
        patterns,
        input.searchDomain ?? "global",
        input.sessionId ?? null,
        input.projectId ?? null,
        positiveLimit(input.limit, 10),
        input.sourceAfter ?? null,
        input.sourceBefore ?? null
      ]
    );
    const sourceMap = await loadSources(
      pool,
      actor,
      envelopeEncryptionProvider,
      result.rows.map((row) => row.id)
    );
    return result.rows.map((row) => mapAssertion(row, sourceMap.get(row.id)));
  },

  async expandCuratedMemoryRetrieval(actor, assertionId) {
    type EvidenceRow = {
      assertion_id: string;
      visibility: Visibility;
      source_type: string | null;
      source_role: string | null;
      source_order: number;
      conversation_item_id: string | null;
      ci_owner_user_id: string | null;
      ci_raw_json: unknown;
      ci_raw_text: string | null;
      ci_metadata: Record<string, unknown> | null;
      ci_session_id: string | null;
      ci_created_at: Date | null;
      ci_event_time: Date | null;
      ci_observed_at: Date | null;
      memory_event_id: string | null;
      me_owner_user_id: string | null;
      me_visibility: Visibility | null;
      me_event_type: MemoryEventType | null;
      me_session_id: string | null;
      me_turn_id: string | null;
      me_payload: {
        actor?: MemoryActor;
        content?: string;
        contentEncrypted?: boolean;
        metadata?: Record<string, unknown>;
        projectId?: string;
      } | null;
      me_created_at: Date | null;
      me_captured_at: Date | null;
      me_source_event_time: Date | null;
      lcm_node_id: string | null;
      lcm_owner_user_id: string | null;
      lcm_summary_text: string | null;
      lcm_visibility: Visibility | null;
      lcm_created_at: Date | null;
    };
    const result = await pool.query<EvidenceRow>(
      `
        select
          cma.id as assertion_id,
          cma.visibility,
          cms.source_type,
          cms.source_role,
          row_number() over (order by cms.created_at asc, cms.id asc) - 1 as source_order,
          cms.conversation_item_id,
          ci.owner_user_id as ci_owner_user_id,
          ci.raw_json as ci_raw_json,
          ci.raw_text as ci_raw_text,
          ci.metadata as ci_metadata,
          ci.session_id as ci_session_id,
          ci.created_at as ci_created_at,
          ci.event_time as ci_event_time,
          ci.observed_at as ci_observed_at,
          cms.memory_event_id,
          me.owner_user_id as me_owner_user_id,
          me.visibility as me_visibility,
          me.event_type as me_event_type,
          me.session_id as me_session_id,
          me.turn_id as me_turn_id,
          me.payload as me_payload,
          me.created_at as me_created_at,
          me.captured_at as me_captured_at,
          me.source_event_time as me_source_event_time,
          cms.lcm_node_id,
          mn.owner_user_id as lcm_owner_user_id,
          mn.summary_text as lcm_summary_text,
          mn.visibility as lcm_visibility,
          mn.created_at as lcm_created_at
        from curated_memory_assertions cma
        left join curated_memory_sources cms on cms.assertion_id = cma.id
        left join conversation_items ci
          on ci.id = cms.conversation_item_id
          and ci.owner_user_id = cma.owner_user_id
          and ci.visibility = 'personal'
          and ci.personal_deleted_at is null
          and ci.memory_excluded_at is null
        left join memory_events me
          on me.id = cms.memory_event_id
          and me.owner_user_id = cma.owner_user_id
          and me.visibility = 'personal'
          and me.invalidated_at is null
          and me.personal_deleted_at is null
        left join memory_nodes mn
          on mn.id = cms.lcm_node_id
          and mn.owner_user_id = cma.owner_user_id
          and mn.visibility = 'personal'
          and mn.invalidated_at is null
          and mn.personal_deleted_at is null
        where cma.id = $1
          and cma.owner_user_id = $2
          and cma.visibility = 'personal'
          and cma.status = 'current'
          and cma.suppressed_at is null
          and (cma.expires_at is null or cma.expires_at > now())
          and ${activeCuratedMemoryEvidencePredicate("cma")}
        order by cms.created_at asc, cms.id asc
      `,
      [assertionId, actor.userId]
    );
    if (result.rows.length === 0) {
      return null;
    }

    const sourceItems: LcmSourceItem[] = [];
    const sources: MemoryEventRecord[] = [];
    for (const row of result.rows) {
      if (
        row.source_type === "conversation_item" &&
        row.conversation_item_id &&
        row.ci_owner_user_id
      ) {
        const encryptedColumns = Array.isArray(
          row.ci_metadata?.encryptedConversationItemColumns
        )
          ? row.ci_metadata.encryptedConversationItemColumns.filter(
              (column): column is string => typeof column === "string"
            )
          : [];
        const rawMarker = recordValue(row.ci_raw_json, null);
        if (
          rawMarker?.contentEncrypted === true &&
          rawMarker.encryptedSourceTable === "conversation_items"
        ) {
          encryptedColumns.push("raw_json");
        }
        const decryptColumn = async (sourceColumn: "raw_json" | "raw_text") =>
          (
            await decryptAuthorizedEncryptedFieldPayloadWithClient(
              pool,
              actor,
              requireEncryptionProvider(envelopeEncryptionProvider),
              {
                sourceTable: "conversation_items",
                sourceId: row.conversation_item_id!,
                sourceColumn
              }
            )
          )?.plaintext;
        const rawJson = encryptedColumns.includes("raw_json")
          ? await decryptColumn("raw_json")
          : row.ci_raw_json;
        const rawText = encryptedColumns.includes("raw_text")
          ? await decryptColumn("raw_text")
          : row.ci_raw_text;
        const rawRecord = recordValue(rawJson, null);
        const payload = recordValue(rawRecord?.payload, rawRecord);
        const content =
          (typeof rawText === "string" && rawText.trim()) ||
          (typeof payload?.content === "string" && payload.content.trim()) ||
          "";
        const text = codexIdePromptUserText(content);
        sourceItems.push({
          kind: "conversation_item",
          sourceTable: "conversation_items",
          sourceId: row.conversation_item_id,
          visibility: "personal",
          createdAt: (
            row.ci_event_time ??
            row.ci_observed_at ??
            row.ci_created_at
          )?.toISOString(),
          text,
          payload: {
            sourceType: "conversation_item",
            sourceRole: row.source_role,
            sessionId: row.ci_session_id,
            curatedMemoryAssertionId: row.assertion_id
          },
          position: row.source_order
        });
        sources.push({
          id: row.conversation_item_id,
          projectId:
            typeof row.ci_metadata?.projectId === "string"
              ? row.ci_metadata.projectId
              : typeof row.ci_metadata?.projectPath === "string"
                ? row.ci_metadata.projectPath
                : "curated-memory",
          sessionId: row.ci_session_id,
          turnId: null,
          actor: "user",
          eventType: "curated_memory_evidence",
          content: text,
          metadata: {
            ...(row.ci_metadata ?? {}),
            sourceType: "conversation_item",
            sourceRole: row.source_role,
            curatedMemoryAssertionId: row.assertion_id
          },
          visibility: "personal",
          ownerUserId: row.ci_owner_user_id,
          createdAt:
            (
              row.ci_event_time ??
              row.ci_observed_at ??
              row.ci_created_at
            )?.toISOString() ?? new Date(0).toISOString()
        });
      } else if (
        row.source_type === "memory_event" &&
        row.memory_event_id &&
        row.me_owner_user_id &&
        row.me_payload
      ) {
        const decrypted =
          row.me_payload.contentEncrypted === true
            ? await decryptAuthorizedEncryptedFieldPayloadWithClient(
                pool,
                actor,
                requireEncryptionProvider(envelopeEncryptionProvider),
                {
                  sourceTable: "memory_events",
                  sourceId: row.memory_event_id,
                  sourceColumn: "payload"
                }
              )
            : null;
        const payload = (recordValue(decrypted?.plaintext, row.me_payload) ??
          {}) as EvidenceRow["me_payload"];
        const text = codexIdePromptUserText(payload?.content ?? "");
        const payloadWithoutContent = { ...(payload ?? {}) };
        delete payloadWithoutContent.content;
        sourceItems.push({
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: row.memory_event_id,
          visibility: row.me_visibility ?? "personal",
          actor: payload?.actor,
          turnId: row.me_turn_id,
          createdAt: (
            row.me_source_event_time ??
            row.me_captured_at ??
            row.me_created_at
          )?.toISOString(),
          text,
          payload: {
            ...payloadWithoutContent,
            sessionId: row.me_session_id,
            sourceRole: row.source_role,
            curatedMemoryAssertionId: row.assertion_id
          },
          position: row.source_order
        });
        sources.push({
          id: row.memory_event_id,
          projectId:
            typeof payload?.projectId === "string"
              ? payload.projectId
              : "curated-memory",
          sessionId: row.me_session_id,
          turnId: row.me_turn_id,
          actor: payload?.actor ?? "agent",
          eventType: row.me_event_type ?? "semantic",
          content: text,
          metadata: {
            ...(payload?.metadata ?? {}),
            sourceType: "memory_event",
            sourceRole: row.source_role,
            curatedMemoryAssertionId: row.assertion_id
          },
          visibility: row.me_visibility ?? "personal",
          ownerUserId: row.me_owner_user_id,
          createdAt:
            (
              row.me_source_event_time ??
              row.me_captured_at ??
              row.me_created_at
            )?.toISOString() ?? new Date(0).toISOString()
        });
      } else if (
        row.source_type === "lcm_summary" &&
        row.lcm_node_id &&
        row.lcm_owner_user_id
      ) {
        const decrypted =
          row.lcm_summary_text === "[koed encrypted memory node]"
            ? await decryptAuthorizedEncryptedFieldPayloadWithClient(
                pool,
                actor,
                requireEncryptionProvider(envelopeEncryptionProvider),
                {
                  sourceTable: "memory_nodes",
                  sourceId: row.lcm_node_id,
                  sourceColumn: "summary_text"
                }
              )
            : null;
        const text =
          typeof decrypted?.plaintext === "string"
            ? decrypted.plaintext
            : (row.lcm_summary_text ?? "");
        sourceItems.push({
          kind: "lcm_child",
          nodeId: row.lcm_node_id,
          position: row.source_order,
          text,
          payload: {
            sourceType: "lcm_summary",
            sourceRole: row.source_role,
            curatedMemoryAssertionId: row.assertion_id
          }
        });
        sources.push({
          id: row.lcm_node_id,
          projectId: "curated-memory",
          sessionId: null,
          turnId: null,
          actor: "agent",
          eventType: "curated_memory_lcm_summary",
          content: text,
          metadata: {
            sourceType: "lcm_summary",
            sourceRole: row.source_role,
            curatedMemoryAssertionId: row.assertion_id
          },
          visibility: row.lcm_visibility ?? "personal",
          ownerUserId: row.lcm_owner_user_id,
          createdAt:
            row.lcm_created_at?.toISOString() ?? new Date(0).toISOString()
        });
      }
    }
    return {
      nodeId: assertionId,
      visibility: result.rows[0]!.visibility,
      sourceItems,
      sources
    };
  }
});

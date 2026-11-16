import {
  authorizedPersonalSelectionSnapshot,
  personalSelectionLegacyScope,
  type EnvelopeEncryptionProvider,
  type RecallScope
} from "@koed-labs/shared";
import type pg from "pg";
import type { ActorContext } from "./types.js";
import { personalRecallPredicate } from "./recall-activity-query.js";
import {
  decryptAuthorizedEncryptedFieldPayloadsWithClient,
  encryptedFieldReferenceKey
} from "./encrypted-payload-repository.js";

interface ScopeIndex {
  kind: RecallScope["kind"];
  provenance: RecallScope["provenance"];
  projectIds: string[];
}

/** Only routing identities are indexed, as with the existing project_id column.
 * The complete accepted selection, caller context and diagnostics stay encrypted. */
export const recallScopeIndex = (
  owner: string,
  selection: unknown,
  legacy: { searchDomain: string; projectId: string | null }
): ScopeIndex => {
  if (selection != null) {
    const accepted = authorizedPersonalSelectionSnapshot(selection, owner);
    const target = accepted.target;
    if (target.kind === "projects" || target.kind === "project") {
      const projects =
        target.kind === "projects" ? target.projects : [target.project];
      if (projects.some((project) => project.ownerUserId !== owner))
        throw new Error("Accepted scope contains another owner's Project");
      return {
        kind: "projects",
        provenance: "accepted",
        projectIds: projects.map((project) => project.projectId)
      };
    }
    if (target.kind === "session")
      return { kind: "session", provenance: "accepted", projectIds: [] };
    const scope = personalSelectionLegacyScope(accepted);
    return {
      kind:
        target.kind === "legacy_project"
          ? "repository"
          : target.kind === "legacy_session"
            ? "session"
            : target.kind,
      provenance: "accepted",
      projectIds: scope.projectId ? [scope.projectId] : []
    };
  }
  return {
    kind:
      legacy.searchDomain === "global"
        ? "global"
        : legacy.searchDomain === "session"
          ? "session"
          : "unknown",
    provenance: "legacy",
    projectIds: legacy.projectId ? [legacy.projectId] : []
  };
};

/** Upgrade old history once, in bounded batches. Read only retained retrieval
 * metadata, never answer, evidence or worker payloads; never consult membership.
 * Failure leaves the projection pending rather than making unknown scope Global. */
export const ensureRecallScopeIndexes = async (
  pool: pg.Pool,
  actor: ActorContext,
  provider?: EnvelopeEncryptionProvider
): Promise<void> => {
  for (;;) {
    const { rows } = await pool.query<{
      id: string;
      searchDomain: string;
      projectId: string | null;
      retrieval: Record<string, unknown> | null;
    }>(
      `select q.id, q.search_domain as "searchDomain", q.project_id as "projectId", q.retrieval
      from memory_questions q where ${personalRecallPredicate} and q.recall_scope is null
      order by q.id limit 100`,
      [actor.userId]
    );
    if (!rows.length) return;
    const references = rows
      .filter((row) => row.retrieval?.contentEncrypted === true)
      .map((row) => ({
        sourceTable: "memory_questions" as const,
        sourceId: row.id,
        sourceColumn: "retrieval"
      }));
    if (references.length && !provider)
      throw new Error("Question encryption is unavailable");
    const payloads = references.length
      ? await decryptAuthorizedEncryptedFieldPayloadsWithClient(
          pool,
          actor,
          provider!,
          references
        )
      : new Map<string, { plaintext: unknown }>();
    const updates = rows.map((row) => {
      let retrieval = row.retrieval;
      if (retrieval?.contentEncrypted === true) {
        const plaintext = payloads.get(
          encryptedFieldReferenceKey({
            sourceTable: "memory_questions",
            sourceId: row.id,
            sourceColumn: "retrieval"
          })
        )?.plaintext;
        if (
          !plaintext ||
          typeof plaintext !== "object" ||
          Array.isArray(plaintext)
        )
          throw new Error("Retained scope is unavailable");
        retrieval = plaintext as Record<string, unknown>;
      }
      return {
        id: row.id,
        scope: recallScopeIndex(
          actor.userId,
          retrieval?.personal_selection,
          row
        )
      };
    });
    await pool.query(
      `update memory_questions q set recall_scope = u.scope
      from jsonb_to_recordset($2::jsonb) as u(id uuid, scope jsonb)
      where q.owner_user_id = $1 and q.id = u.id and q.recall_scope is null`,
      [actor.userId, JSON.stringify(updates)]
    );
  }
};

// Read labels only from this owner's active Projects. Deletion never removes
// accepted identity. No join to current Conversation membership is involved.
export const recallScopeSql = `case when q.recall_scope is null then null else jsonb_build_object(
  'kind', q.recall_scope->>'kind', 'provenance', q.recall_scope->>'provenance',
  'label', case when q.recall_scope->>'kind' in ('repository','folder','unknown') then q.project_name end,
  'projects', coalesce((select jsonb_agg(jsonb_build_object('projectId', ids.id,
    'projectName', case when q.recall_scope->>'kind' = 'projects' then p.name else q.project_name end) order by ids.ordinality)
    from jsonb_array_elements_text(q.recall_scope->'projectIds') with ordinality as ids(id, ordinality)
    left join personal_named_projects p on p.owner_user_id=q.owner_user_id
      and p.project_id::text=ids.id and p.deleted_at is null), '[]'::jsonb)) end`;

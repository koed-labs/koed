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

/** A retained selection that can no longer be read (invalidated or missing
 * payload, or a selection that fails owner authorization) is permanent. Index it
 * as an unknown scope that keeps only the legacy Project identity, never Global. */
const unavailableScope = (row: { projectId: string | null }): ScopeIndex => ({
  kind: "unknown",
  provenance: "unavailable",
  projectIds: row.projectId ? [row.projectId] : []
});

type PendingRow = {
  id: string;
  searchDomain: string;
  projectId: string | null;
  retrieval: Record<string, unknown> | null;
};

const retrievalReference = (id: string) => ({
  sourceTable: "memory_questions" as const,
  sourceId: id,
  sourceColumn: "retrieval"
});

/** Decrypt a batch, isolating envelopes that fail so one record cannot block
 * the rest. Rows whose decryption throws are omitted and stay pending. */
const decryptRetrievals = async (
  pool: pg.Pool,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  rows: PendingRow[]
): Promise<{ payloads: Map<string, unknown>; failed: Set<string> }> => {
  const payloads = new Map<string, unknown>();
  const failed = new Set<string>();
  const read = async (batch: PendingRow[]) => {
    const result = await decryptAuthorizedEncryptedFieldPayloadsWithClient(
      pool,
      actor,
      provider,
      batch.map((row) => retrievalReference(row.id))
    );
    for (const row of batch)
      payloads.set(
        row.id,
        result.get(encryptedFieldReferenceKey(retrievalReference(row.id)))
          ?.plaintext
      );
  };
  try {
    await read(rows);
  } catch {
    for (const row of rows) {
      try {
        await read([row]);
      } catch {
        failed.add(row.id);
      }
    }
  }
  return { payloads, failed };
};

/** Upgrade old history once, in bounded batches. Read only retained retrieval
 * metadata, never answer, evidence or worker payloads; never consult membership.
 * A record that cannot be projected never fails the read: a transient failure
 * (no encryption provider, an envelope that does not decrypt) leaves it pending
 * for a later read, and a permanently unreadable selection is indexed as unknown. */
export const ensureRecallScopeIndexes = async (
  pool: pg.Pool,
  actor: ActorContext,
  provider?: EnvelopeEncryptionProvider
): Promise<void> => {
  // Advance past skipped rows so pending records are not refetched in a loop.
  let after: string | null = null;
  for (;;) {
    const { rows }: { rows: PendingRow[] } = await pool.query<PendingRow>(
      `select q.id, q.search_domain as "searchDomain", q.project_id as "projectId", q.retrieval
      from memory_questions q where ${personalRecallPredicate} and q.recall_scope is null
        and ($2::uuid is null or q.id > $2::uuid)
      order by q.id limit 100`,
      [actor.userId, after]
    );
    if (!rows.length) return;
    after = rows[rows.length - 1]!.id;
    const encrypted = rows.filter(
      (row) => row.retrieval?.contentEncrypted === true
    );
    const { payloads, failed } =
      encrypted.length && provider
        ? await decryptRetrievals(pool, actor, provider, encrypted)
        : { payloads: new Map<string, unknown>(), failed: new Set<string>() };
    const updates: { id: string; scope: ScopeIndex }[] = [];
    for (const row of rows) {
      let retrieval = row.retrieval;
      if (retrieval?.contentEncrypted === true) {
        if (!provider || failed.has(row.id)) continue;
        const plaintext = payloads.get(row.id);
        if (
          !plaintext ||
          typeof plaintext !== "object" ||
          Array.isArray(plaintext)
        ) {
          updates.push({ id: row.id, scope: unavailableScope(row) });
          continue;
        }
        retrieval = plaintext as Record<string, unknown>;
      }
      let scope: ScopeIndex;
      try {
        scope = recallScopeIndex(
          actor.userId,
          retrieval?.personal_selection,
          row
        );
      } catch {
        scope = unavailableScope(row);
      }
      updates.push({ id: row.id, scope });
    }
    if (updates.length)
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

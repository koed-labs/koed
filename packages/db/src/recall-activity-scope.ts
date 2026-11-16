import {
  authorizedPersonalSelectionSnapshot,
  personalSelectionLegacyScope,
  type EnvelopeEncryptionProvider,
  type PersonalSelectionSnapshot,
  type RecallProjectScopeStatus,
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

/** A version-zero Project selection names a retained repository identity. Only
 * Git identities are repositories; a non-Git project is a directory, and any
 * other identity cannot be classified honestly. Membership is never inferred. */
const legacyProjectKind = (
  kind: string
): Extract<ScopeIndex["kind"], "repository" | "folder" | "unknown"> =>
  kind === "portable_repository" || kind === "device_local_repository"
    ? "repository"
    : kind === "non_git_project"
      ? "folder"
      : "unknown";

/** Only routing identities are indexed, as with the existing project_id column.
 * The complete accepted selection, caller context and diagnostics stay encrypted. */
export const recallScopeIndex = (
  owner: string,
  selection: unknown,
  legacy: { searchDomain: string; projectId: string | null }
): ScopeIndex =>
  recallScopeIndexFromSnapshot(
    owner,
    selection == null
      ? undefined
      : authorizedPersonalSelectionSnapshot(selection, owner),
    legacy
  );

/** As `recallScopeIndex`, for a selection the caller has already authorized. */
export const recallScopeIndexFromSnapshot = (
  owner: string,
  accepted: PersonalSelectionSnapshot | undefined,
  legacy: { searchDomain: string; projectId: string | null }
): ScopeIndex => {
  if (accepted) {
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
          ? legacyProjectKind(target.repository.kind)
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

const REPAIR_BATCH = 100;
/** Records projected per activity read, so no request repairs a whole history. */
export const RECALL_SCOPE_REPAIR_BUDGET = 500;
/** How long a completed pass that had to skip records waits before retrying. */
const RECALL_SCOPE_RETRY_MS = 10 * 60_000;

export interface RecallScopeRepairPass {
  /** Last record examined; the next pass resumes after it. */
  after: string | null;
  /** Records left pending because of a possibly transient failure. */
  skipped: number;
  /** No pending record remains after `after`. */
  finished: boolean;
}

/** Upgrade old history in bounded batches, resuming after `after`. Read only
 * retained retrieval metadata, never answer, evidence or worker payloads; never
 * consult membership. A record that cannot be projected never fails the read: a
 * transient failure (no encryption provider, an envelope that does not decrypt)
 * leaves it pending for a later pass, and a permanently unreadable selection is
 * indexed as unknown. */
export const ensureRecallScopeIndexes = async (
  pool: pg.Pool,
  actor: ActorContext,
  provider?: EnvelopeEncryptionProvider,
  {
    after = null,
    budget = RECALL_SCOPE_REPAIR_BUDGET
  }: { after?: string | null; budget?: number } = {}
): Promise<RecallScopeRepairPass> => {
  let skipped = 0;
  let remaining = budget;
  while (remaining > 0) {
    // Advance past skipped rows so pending records are not refetched in a loop.
    const { rows }: { rows: PendingRow[] } = await pool.query<PendingRow>(
      `select q.id, q.search_domain as "searchDomain", q.project_id as "projectId", q.retrieval
      from memory_questions q where ${personalRecallPredicate} and q.recall_scope is null
        and ($2::uuid is null or q.id > $2::uuid)
      order by q.id limit $3`,
      [actor.userId, after, Math.min(REPAIR_BATCH, remaining)]
    );
    if (!rows.length) return { after, skipped, finished: true };
    remaining -= rows.length;
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
    skipped += rows.length - updates.length;
    if (updates.length)
      await pool.query(
        `update memory_questions q set recall_scope = u.scope
        from jsonb_to_recordset($2::jsonb) as u(id uuid, scope jsonb)
        where q.owner_user_id = $1 and q.id = u.id and q.recall_scope is null`,
        [actor.userId, JSON.stringify(updates)]
      );
  }
  return { after, skipped, finished: false };
};

/** Whether any of the owner's history lost its accepted Project identities for
 * good. Read from the stored projection, so it survives a process restart. */
const hasUnavailableScope = async (
  pool: pg.Pool,
  actor: ActorContext
): Promise<boolean> =>
  (
    await pool.query<{ unavailable: boolean }>(
      `select exists(select 1 from memory_questions q where ${personalRecallPredicate}
        and q.recall_scope @> '{"provenance":"unavailable"}'::jsonb) as unavailable`,
      [actor.userId]
    )
  ).rows[0]?.unavailable === true;

/** Run at most one bounded repair pass per owner at a time. Concurrent activity
 * reads (the page loads its overview and list together) share the pass, and an
 * owner whose history is fully projected is not scanned again: final Personal
 * MCP history writes its projection when it is recorded. Repair is best effort;
 * a pending record reads with a null scope and legacy Project filtering. */
export const createRecallScopeRepair = (
  pool: pg.Pool,
  provider?: EnvelopeEncryptionProvider,
  now: () => number = Date.now
) => {
  const progress = new Map<
    string,
    {
      after: string | null;
      skipped: number;
      idleUntil: number;
      status: RecallProjectScopeStatus;
    }
  >();
  const running = new Map<string, Promise<RecallProjectScopeStatus>>();
  const pass = async (
    actor: ActorContext
  ): Promise<RecallProjectScopeStatus> => {
    const current = progress.get(actor.userId) ?? {
      after: null,
      skipped: 0,
      idleUntil: 0,
      status: "updating" as const
    };
    if (current.idleUntil > now()) return current.status;
    const result = await ensureRecallScopeIndexes(pool, actor, provider, {
      after: current.after
    });
    const skipped = current.skipped + result.skipped;
    // A finished pass is complete coverage only if no record is still pending
    // and none was indexed with an unrecoverable selection.
    const status = result.finished
      ? skipped || (await hasUnavailableScope(pool, actor))
        ? "unavailable"
        : "complete"
      : "updating";
    progress.set(
      actor.userId,
      result.finished
        ? {
            after: null,
            skipped: 0,
            status,
            // Retry pending records later; unrecoverable ones are never retried.
            idleUntil: skipped
              ? now() + RECALL_SCOPE_RETRY_MS
              : Number.POSITIVE_INFINITY
          }
        : { after: result.after, skipped, idleUntil: 0, status }
    );
    return status;
  };
  return (actor: ActorContext): Promise<RecallProjectScopeStatus> => {
    const active = running.get(actor.userId);
    if (active) return active;
    const next = pass(actor)
      .catch((): RecallProjectScopeStatus => {
        const current = progress.get(actor.userId);
        progress.set(actor.userId, {
          after: current?.after ?? null,
          skipped: current?.skipped ?? 0,
          idleUntil: now() + RECALL_SCOPE_RETRY_MS,
          status: "unavailable"
        });
        return "unavailable";
      })
      .finally(() => running.delete(actor.userId));
    running.set(actor.userId, next);
    return next;
  };
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

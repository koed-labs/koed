import type pg from "pg";
import {
  crossIdentitySyncDigest,
  personalSelectionMemberEvaluationInputSchema,
  personalSelectionMemberEvaluationSchema
} from "@koed/shared";
import { personalProjectMemberEvidenceKnownSql } from "./personal-project-member-evidence-sql.js";
import type { ActorContext } from "./types.js";
import {
  readConsumerCursor,
  resolveConsumerSelection,
  selectionConsumerError,
  withSelectionConsumerTransaction,
  type SelectionConsumerOptions
} from "./personal-selection-consumer-state.js";
import {
  personalSourceSelectionSql,
  personalEffectiveFolderFactSql
} from "./personal-selection-sql.js";

/** Absence from a recall-ready enumeration is not evidence of removal.
 * Evaluate only exact previously known owner/source pairs, in a bounded batch. */
export const evaluatePersonalSelectionMembers = (
  pool: pg.Pool,
  actor: ActorContext,
  raw: unknown,
  options: SelectionConsumerOptions = {}
) => {
  const input = personalSelectionMemberEvaluationInputSchema.parse(raw);
  return withSelectionConsumerTransaction(pool, actor, async (client) => {
    const cursor = await readConsumerCursor(client, actor, input.cursor);
    if (
      cursor.kind !== "checkpoint" ||
      !["repository", "folder", "project"].includes(
        cursor.selection.target.kind
      )
    )
      throw selectionConsumerError(
        "selection_cursor_kind",
        400,
        "A completed Project, Git Anchor or exact Folder enumeration is required to evaluate known members"
      );
    const changed = await client.query(
      `select 1 from personal_selection_changes where owner_user_id=$1
       and not pg_visible_in_snapshot(transaction_id::xid8,$2::pg_snapshot) limit 1`,
      [actor.userId, cursor.from_snapshot]
    );
    if (changed.rows.length)
      throw selectionConsumerError(
        "selection_enumeration_stale",
        409,
        "Selection changed. Refresh the complete baseline before evaluating removals."
      );
    const resolved = await resolveConsumerSelection(
      client,
      actor,
      cursor.selection,
      options
    );
    const isFolder = cursor.selection.target.kind === "folder";
    const isProject = cursor.selection.target.kind === "project";
    const matches = personalSourceSelectionSql("s", "$2");
    const folderFact = personalEffectiveFolderFactSql("s");
    const contextIdentity = isProject
      ? "jsonb_build_object('projectId',$4::uuid,'version',$5::integer,'deleted',$6::boolean)"
      : isFolder
        ? `case when ${folderFact}->>'state'='known' then ${folderFact}->'value'->'reference' else null end`
        : "coalesce(s.repository_override_identity,s.repository_automatic_identity)";
    const contextKnown = isProject
      ? personalProjectMemberEvidenceKnownSql(
          "s",
          "$4::uuid",
          matches,
          "$6::boolean"
        )
      : isFolder
        ? `${folderFact}->>'state'='known'`
        : `(${contextIdentity} is not null and ${contextIdentity}->>'kind'<>'unresolved')`;
    const result = await client.query<{
      id: string;
      logical_session_id: string;
      git_context_version: number;
      folder_context_version: number;
      context_known: boolean;
      identity: unknown;
      deleted: boolean;
      available: boolean;
      matches: boolean;
    }>(
      `select s.id,s.logical_session_id,s.repository_assignment_version git_context_version,
         (s.folder_assignment->>'revision')::integer folder_context_version,
         ${contextIdentity} identity,${contextKnown} context_known,
         (s.personal_deleted_at is not null) deleted,
         (s.visibility='personal' and s.invalidated_at is null
           and pds_session_recall_ready(s.id) and sync_session_recall_ready(s.id)
           and not exists(select 1 from personal_source_bindings b
             where b.owner_user_id=s.owner_user_id and b.local_session_id=s.id
               and (b.availability<>'available' or b.local_logical_session_id is distinct from s.logical_session_id))) available,
         ${matches} matches
       from sessions s
       join jsonb_to_recordset($3::jsonb) requested("localSessionId" uuid,"localLogicalSessionId" uuid)
         on s.id=requested."localSessionId" and s.logical_session_id=requested."localLogicalSessionId"
       where s.owner_user_id=$1`,
      [
        actor.userId,
        resolved.selection,
        JSON.stringify(input.sources),
        ...(isProject
          ? [
              resolved.nativeProjectId ?? null,
              resolved.projectVersion,
              resolved.projectDeleted === true
            ]
          : [])
      ]
    );
    const rows = new Map(result.rows.map((row) => [row.id, row]));
    return personalSelectionMemberEvaluationSchema.parse({
      snapshotVersion: cursor.snapshot_version,
      entries: input.sources.map((source) => {
        const row = rows.get(source.localSessionId);
        // A retained, explicit deletion is conclusive. Missing rows, pending
        // replicas and unresolved context cannot prove a selector mismatch.
        const state = row?.deleted
          ? "deleted"
          : row && resolved.projectDeleted
            ? "not_matching"
            : !row?.available || row.context_known !== true
              ? "unresolved"
              : row.matches
                ? "matching"
                : "not_matching";
        return {
          ...source,
          state,
          contextVersion:
            state === "unresolved"
              ? null
              : {
                  git: row!.git_context_version,
                  folder: row!.folder_context_version
                },
          sourceContextHash:
            state === "unresolved"
              ? null
              : crossIdentitySyncDigest({
                  source,
                  ...(isProject
                    ? { snapshotVersion: cursor.snapshot_version }
                    : {}),
                  contextVersion: {
                    git: row!.git_context_version,
                    folder: row!.folder_context_version
                  },
                  identity: row!.identity,
                  deleted: row!.deleted
                })
        };
      }),
      expiresAt: cursor.expires_at.toISOString()
    });
  });
};

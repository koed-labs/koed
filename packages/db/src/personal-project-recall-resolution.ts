import type pg from "pg";
import {
  personalProjectRecallResolutionInputSchema,
  personalProjectRecallResolutionSchema
} from "@koed-labs/shared";
import type { ActorContext } from "./types.js";
import { withSelectionConsumerTransaction } from "./personal-selection-consumer-state.js";
import {
  personalSessionProjectMembershipSql,
  personalSourceSelectionSql
} from "./personal-selection-sql.js";

const unavailable = (
  code: string,
  statusCode: number,
  message: string,
  retryable = false
) => Object.assign(new Error(message), { code, statusCode, retryable });

/** Resolves only authenticated owner-bound capture identity. Never infers a Conversation from cwd. */
export const resolvePersonalProjectRecall = async (
  pool: pg.Pool,
  actor: ActorContext,
  raw: unknown
) => {
  const input = personalProjectRecallResolutionInputSchema.parse(raw);
  if ("source" in input && input.source.ownerUserId !== actor.userId)
    throw unavailable(
      "personal_conversation_unavailable",
      404,
      "Conversation not found or not available"
    );
  return withSelectionConsumerTransaction(pool, actor, async (client) => {
    const source = "source" in input ? input.source : null;
    const pendingBinding = `exists(select 1 from personal_source_bindings pending_capture
      where pending_capture.owner_user_id=s.owner_user_id and pending_capture.local_session_id=s.id and pending_capture.availability='pending')`;
    const sessions = await client.query<{ id: string; pending: boolean }>(
      `select s.id,${pendingBinding} pending from sessions s where s.owner_user_id=$1 and (
        ($2::uuid is not null and s.id=$2)
        or ($3::jsonb is not null and (
          exists (select 1 from personal_source_bindings b
            where b.owner_user_id=s.owner_user_id and b.local_session_id=s.id and b.local_logical_session_id=s.logical_session_id
              and b.originating_deployment_id=$3::jsonb->>'originatingDeploymentId'
              and b.originating_device_id=$3::jsonb->>'originatingDeviceId' and b.source_logical_session_id=$3::jsonb->>'logicalSessionId')
          or (s.logical_session_id::text=$3::jsonb->>'logicalSessionId' and exists (
            select 1 from conversation_source_artifacts a where a.owner_user_id=s.owner_user_id and a.session_id=s.id
              and a.origin_deployment_id=$3::jsonb->>'originatingDeploymentId' and a.origin_device_id=$3::jsonb->>'originatingDeviceId'
              and a.lifecycle in ('active','finalizing','finalized') and a.origin_key_status='active'))))
        or ($4::text is not null and s.external_session_id=$4 and s.source_runtime=$5)
      ) and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
      and (${personalSourceSelectionSql("s", "$6")} or ${pendingBinding})`,
      [
        actor.userId,
        "sessionId" in input ? input.sessionId : null,
        source ? JSON.stringify(source) : null,
        "externalSessionId" in input ? input.externalSessionId : null,
        "sourceRuntime" in input ? input.sourceRuntime : null,
        JSON.stringify({ ownerUserId: actor.userId, searchDomain: "global" })
      ]
    );
    if (sessions.rows.length !== 1)
      throw unavailable(
        "personal_conversation_unavailable",
        sessions.rows.length ? 409 : 404,
        sessions.rows.length
          ? "Conversation identity is ambiguous"
          : "Conversation not found or not available"
      );
    const sessionId = sessions.rows[0]!.id;
    if (sessions.rows[0]!.pending)
      throw unavailable(
        "personal_conversation_pending",
        409,
        "Conversation source is pending verification; retry after synchronization",
        true
      );
    const projects = await client.query<{ project_id: string }>(
      `select coalesce((select e.project_identity from personal_membership_entities e
        where e.owner_user_id=p.owner_user_id and e.local_project_id=p.project_id and e.entity_kind='project'),p.project_id::text) project_id
       from personal_named_projects p join sessions caller on caller.id=$2 and caller.owner_user_id=$1
       where ${personalSessionProjectMembershipSql("caller", "p")} order by project_id`,
      [actor.userId, sessionId]
    );
    if (!projects.rows.length) {
      const reconciliation = await client.query<{ pending: boolean }>(
        "select pending from personal_project_default_reconciliation where owner_user_id=$1",
        [actor.userId]
      );
      if (reconciliation.rows[0]?.pending)
        throw unavailable(
          "personal_project_membership_pending",
          409,
          "Project organization is pending; retry after reconciliation",
          true
        );
      throw unavailable(
        "personal_project_membership_missing",
        409,
        "Conversation does not belong to an available Project"
      );
    }
    return personalProjectRecallResolutionSchema.parse({
      sessionId,
      target: {
        kind: "projects",
        callerSessionId: sessionId,
        projects: projects.rows.map((project) => ({
          ownerUserId: actor.userId,
          projectId: project.project_id
        }))
      }
    });
  });
};

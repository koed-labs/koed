import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  nextScheduledJobOccurrence,
  scheduledJobScheduleSchema,
  type CreateScheduledJob,
  type EditScheduledJob,
  type ScheduledJobSchedule
} from "@koed/shared";
import { appendCollaborationOutboxEventWithClient } from "./collaboration-repository.js";
import { managedConversationEventMutationId } from "./managed-conversation-event.js";
import { claimedManagedTextCreateWithClient } from "./managed-text-action-repository.js";
import type { EnvelopeEncryptionProvider } from "@koed/shared";

type Row = Record<string, unknown>;
export class ScheduledJobNotFound extends Error {}
export class ScheduledJobConflict extends Error {}
export class ScheduledJobAuthorityUnavailable extends Error {}

export interface ScheduledJobRecord {
  id: string;
  ownerUserId: string;
  projectId: string | null;
  agentId: string;
  conversationSessionId: string;
  title: string;
  instruction: string;
  schedule: ScheduledJobSchedule;
  paused: boolean;
  pausedReason: string | null;
  runnerDeviceId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface ScheduledJobRunRecord {
  id: string;
  jobId: string;
  scheduledFor: string;
  trigger: "scheduled" | "manual";
  attempt: number;
  status:
    | "scheduled"
    | "running"
    | "waiting_approval"
    | "ok"
    | "failed"
    | "interrupted"
    | "missed"
    | "skipped";
  skipReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  executionId: string | null;
  error: string | null;
}

const iso = (value: unknown): string =>
  new Date(value as Date | string).toISOString();
const dbText = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Invalid database text");
  return value;
};
const canonicalSchedule = (
  schedule: ScheduledJobSchedule
): ScheduledJobSchedule =>
  schedule.kind === "weekly"
    ? {
        ...schedule,
        dow: [...schedule.dow].sort((left, right) => left - right)
      }
    : schedule;
const mapJob = (row: Row): ScheduledJobRecord => ({
  id: String(row.id),
  ownerUserId: String(row.owner_user_id),
  projectId: row.project_id == null ? null : dbText(row.project_id),
  agentId: String(row.agent_id),
  conversationSessionId: String(row.conversation_session_id),
  title: String(row.title),
  instruction: String(row.instruction),
  schedule: scheduledJobScheduleSchema.parse(row.schedule),
  paused: Boolean(row.paused),
  pausedReason: row.paused_reason == null ? null : dbText(row.paused_reason),
  runnerDeviceId: String(row.runner_device_id),
  version: Number(row.version),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});
const mapRun = (row: Row): ScheduledJobRunRecord => ({
  id: String(row.id),
  jobId: String(row.job_id),
  scheduledFor: iso(row.scheduled_for),
  trigger: row.trigger as ScheduledJobRunRecord["trigger"],
  attempt: Number(row.attempt),
  status: row.status as ScheduledJobRunRecord["status"],
  skipReason: row.skip_reason == null ? null : dbText(row.skip_reason),
  startedAt: row.started_at == null ? null : iso(row.started_at),
  finishedAt: row.finished_at == null ? null : iso(row.finished_at),
  executionId: row.execution_id == null ? null : dbText(row.execution_id),
  error: row.error == null ? null : dbText(row.error)
});
const mapAttempt = (row: Row) => ({
  id: String(row.id),
  runId: String(row.run_id),
  attempt: Number(row.attempt),
  executionId: String(row.execution_id),
  fenceGeneration: Number(row.fence_generation),
  jobVersion: Number(row.job_version),
  runnerDeviceId: String(row.runner_device_id),
  conversationSessionId: String(row.conversation_session_id),
  conversationProjectAssignmentVersion: Number(
    row.conversation_project_assignment_version
  ),
  projectId: row.project_id == null ? null : dbText(row.project_id),
  projectVersion:
    row.project_version == null ? null : Number(row.project_version),
  teamBackendId:
    row.team_backend_id == null ? null : dbText(row.team_backend_id),
  workspaceProjectId:
    row.workspace_project_id == null ? null : dbText(row.workspace_project_id),
  teamProjectVersion:
    row.team_project_version == null ? null : Number(row.team_project_version),
  teamMemberVersion:
    row.team_member_version == null ? null : Number(row.team_member_version),
  startedAt: iso(row.started_at)
});
const mapAttemptEvent = (row: Row) => ({
  id: String(row.id),
  attemptId: String(row.attempt_id),
  eventKind: String(row.event_kind),
  executionId: String(row.execution_id),
  fenceGeneration: Number(row.fence_generation),
  status: row.status as ScheduledJobRunRecord["status"],
  leaseOwnerId: row.lease_owner_id == null ? null : dbText(row.lease_owner_id),
  leaseExpiresAt:
    row.lease_expires_at == null ? null : iso(row.lease_expires_at),
  uncertainty: Boolean(row.uncertainty),
  outcome: row.outcome == null ? null : dbText(row.outcome),
  error: row.error == null ? null : dbText(row.error),
  at: iso(row.at)
});
const transaction = async <T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>
) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};
const changed = async (
  client: pg.PoolClient,
  ownerUserId: string,
  id: string
) =>
  appendCollaborationOutboxEventWithClient(client, {
    family: "scheduled_job_changed",
    scope: "personal",
    personalOwnerUserId: ownerUserId,
    teamId: null,
    teamWorkspaceId: null,
    threadId: null,
    messageId: null,
    shareGrantId: null,
    logicalMemoryId: null,
    resourceType: "scheduled_job",
    resourceId: id,
    actorPrincipalId: ownerUserId,
    mutationId: randomUUID()
  });

/** Same-transaction lifecycle hook: restoration never clears this pause. */
export async function pauseScheduledJobsWithClient(
  client: pg.PoolClient,
  ownerUserId: string,
  selector: {
    projectId?: string;
    conversationSessionId?: string;
    reason: string;
  }
) {
  const result = await client.query<{ id: string }>(
    `update scheduled_jobs set paused=true,paused_reason=$4,version=version+1,updated_at=now()
     where owner_user_id=$1 and paused=false
       and ($2::uuid is null or project_id=$2)
       and ($3::uuid is null or conversation_session_id=$3)
     returning id`,
    [
      ownerUserId,
      selector.projectId ?? null,
      selector.conversationSessionId ?? null,
      selector.reason
    ]
  );
  for (const row of result.rows) await changed(client, ownerUserId, row.id);
  return result.rows.length;
}

/** Forget removes the job and its cascading run/attempt history with the Conversation. */
export async function forgetScheduledJobsWithClient(
  client: pg.PoolClient,
  ownerUserId: string,
  conversationSessionId: string
) {
  const result = await client.query<{ id: string }>(
    `delete from scheduled_jobs where owner_user_id=$1 and conversation_session_id=$2 returning id`,
    [ownerUserId, conversationSessionId]
  );
  for (const row of result.rows) await changed(client, ownerUserId, row.id);
  return result.rows.length;
}

/** Call in the same transaction that creates a queued Managed prompt command.
 * The command cannot become visible to a runner before this immutable mapping commits.
 * Linked Projects need a fresh authoritative Team callback here; because Team
 * state is remote, the later 602 runner claim must obtain current Team proof again.
 */
export async function bindScheduledJobManagedPromptWithClient(
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    attemptId: string;
    attemptExecutionId: string;
    fenceToken: string;
    managedExecutionId: string;
    managedCommandId: string;
    teamAuthority?: ScheduledJobTeamAuthority;
  }
) {
  // Read the immutable attempt only to discover its parent. The parent is
  // rechecked after taking the canonical Project -> Conversation -> Job locks.
  const parent = await client.query<Row>(
    `select run.job_id from scheduled_job_attempts attempt
       join scheduled_job_runs run on run.id=attempt.run_id
       join scheduled_jobs job on job.id=run.job_id
      where attempt.id=$1 and job.owner_user_id=$2`,
    [input.attemptId, input.ownerUserId]
  );
  if (!parent.rows[0])
    throw new ScheduledJobConflict("Scheduled attempt is unavailable");
  const job = await lockJob(
    client,
    input.ownerUserId,
    dbText(parent.rows[0].job_id)
  );
  const authority = await binding(client, input.ownerUserId, {
    agentId: dbText(job.agent_id),
    conversationSessionId: dbText(job.conversation_session_id),
    projectId: job.project_id == null ? null : dbText(job.project_id)
  });
  let team: { projectVersion: number; memberVersion: number } | null = null;
  if (
    authority.project?.team_backend_id ||
    authority.project?.workspace_project_id
  ) {
    if (
      !authority.project.team_backend_id ||
      !authority.project.workspace_project_id ||
      !input.teamAuthority
    )
      throw new ScheduledJobAuthorityUnavailable(
        "Current Team authority is unavailable"
      );
    try {
      team = await input.teamAuthority({
        ownerUserId: input.ownerUserId,
        projectId: dbText(authority.project.id),
        teamBackendId: dbText(authority.project.team_backend_id),
        workspaceProjectId: dbText(authority.project.workspace_project_id)
      });
    } catch {
      throw new ScheduledJobAuthorityUnavailable(
        "Current Team authority is unavailable"
      );
    }
  }
  const result = await client.query<Row>(
    `select attempt.id,execution.execution_generation,
            execution.provider,execution.ai_client_instance_id,
            execution.permission_mode,execution.model,
            command.id as command_id
       from scheduled_job_attempts attempt
       join scheduled_job_runs run on run.id=attempt.run_id
       join scheduled_jobs job on job.id=run.job_id
       join managed_conversation_executions execution
         on execution.id=$5 and execution.owner_user_id=job.owner_user_id
        and execution.logical_session_id=(
          select session.logical_session_id from sessions session
           where session.id=job.conversation_session_id
             and session.owner_user_id=job.owner_user_id)
        and (job.project_id is null or execution.project_id=job.project_id::text)
        and execution.runner_device_id=job.runner_device_id
        and execution.state='running'
       join managed_conversation_commands command
         on command.id=$6 and command.execution_id=execution.id
        and command.owner_user_id=job.owner_user_id
        and command.command_kind='prompt' and command.state='queued'
        and command.execution_generation=execution.execution_generation
       where job.owner_user_id=$1 and attempt.id=$2 and attempt.execution_id=$3
         and attempt.fence_token_hash=$4 and run.execution_id=attempt.execution_id
         and run.status='running' and job.paused=false
         and job.version=attempt.job_version
         and job.runner_device_id=attempt.runner_device_id
         and job.conversation_session_id=attempt.conversation_session_id
         and job.project_id is not distinct from attempt.project_id
         and run.attempt=attempt.attempt
         and attempt.conversation_project_assignment_version=$7
         and attempt.project_version is not distinct from $8::integer
         and attempt.team_backend_id is not distinct from $9::text
         and attempt.workspace_project_id is not distinct from $10::uuid
         and attempt.team_project_version is not distinct from $11::integer
         and attempt.team_member_version is not distinct from $12::integer
       for share of attempt,run,job,execution,command`,
    [
      input.ownerUserId,
      input.attemptId,
      input.attemptExecutionId,
      createHash("sha256").update(input.fenceToken).digest("hex"),
      input.managedExecutionId,
      input.managedCommandId,
      authority.conversation.project_assignment_version,
      authority.project?.version ?? null,
      authority.project?.team_backend_id ?? null,
      authority.project?.workspace_project_id ?? null,
      team?.projectVersion ?? null,
      team?.memberVersion ?? null
    ]
  );
  if (
    !result.rows[0] ||
    !activeAgentMatchesExecution(authority.agent, result.rows[0])
  )
    throw new ScheduledJobConflict(
      "Managed prompt does not match current attempt"
    );
  const bound = await client.query<Row>(
    `insert into scheduled_job_attempt_dispatch_bindings
       (attempt_id,owner_user_id,managed_execution_id,
        managed_execution_generation,managed_command_id)
     values($1,$2,$3,$4,$5) on conflict(attempt_id) do nothing returning *`,
    [
      input.attemptId,
      input.ownerUserId,
      input.managedExecutionId,
      result.rows[0].execution_generation,
      input.managedCommandId
    ]
  );
  if (bound.rows[0])
    return {
      attemptId: input.attemptId,
      managedExecutionId: input.managedExecutionId,
      managedCommandId: input.managedCommandId,
      managedExecutionGeneration: Number(result.rows[0].execution_generation)
    };
  const prior = await client.query<Row>(
    `select * from scheduled_job_attempt_dispatch_bindings where attempt_id=$1`,
    [input.attemptId]
  );
  if (
    prior.rows[0]?.managed_execution_id !== input.managedExecutionId ||
    prior.rows[0]?.managed_command_id !== input.managedCommandId ||
    Number(prior.rows[0]?.managed_execution_generation) !==
      Number(result.rows[0].execution_generation)
  )
    throw new ScheduledJobConflict(
      "Scheduled attempt is bound to a different command"
    );
  return {
    attemptId: input.attemptId,
    managedExecutionId: input.managedExecutionId,
    managedCommandId: input.managedCommandId,
    managedExecutionGeneration: Number(result.rows[0].execution_generation)
  };
}

const lockJob = async (
  client: pg.PoolClient,
  ownerUserId: string,
  id: string,
  proposed?: { projectId?: string | null; conversationSessionId?: string }
) => {
  const preliminary = await client.query<Row>(
    `select job.project_id,job.conversation_session_id,
      (case when session.project_override_at is not null then session.project_override_personal_project_id
        else session.automatic_personal_project_id end) as conversation_project_id
     from scheduled_jobs job left join sessions session
       on session.id=job.conversation_session_id and session.owner_user_id=job.owner_user_id
     where job.id=$1 and job.owner_user_id=$2`,
    [id, ownerUserId]
  );
  const before = preliminary.rows[0];
  if (!before) throw new ScheduledJobNotFound("Scheduled Job not found");
  const sessionIds = [
    ...new Set([
      dbText(before.conversation_session_id),
      proposed?.conversationSessionId ?? dbText(before.conversation_session_id)
    ])
  ].sort();
  const sessionAssignments = new Map<
    string,
    {
      projectId: string | null;
      version: number;
    }
  >();
  for (const sessionId of sessionIds) {
    const assignment = await client.query<Row>(
      `select project_assignment_version,
         (case when project_override_at is not null then project_override_personal_project_id
           else automatic_personal_project_id end) as project_id
       from sessions where id=$1 and owner_user_id=$2`,
      [sessionId, ownerUserId]
    );
    if (!assignment.rows[0])
      throw new ScheduledJobConflict("Conversation binding changed");
    sessionAssignments.set(sessionId, {
      projectId:
        assignment.rows[0].project_id == null
          ? null
          : dbText(assignment.rows[0].project_id),
      version: Number(assignment.rows[0].project_assignment_version)
    });
  }
  const projectIds = [
    ...new Set(
      [
        before.project_id,
        before.conversation_project_id,
        proposed?.projectId === undefined
          ? before.project_id
          : proposed.projectId,
        ...[...sessionAssignments.values()].map(
          (assignment) => assignment.projectId
        )
      ].filter((value): value is string => typeof value === "string")
    )
  ].sort();
  for (const projectId of projectIds) {
    const project = await client.query(
      "select id from projects where id=$1 and owner_user_id=$2 for share",
      [projectId, ownerUserId]
    );
    if (!project.rows[0])
      throw new ScheduledJobConflict("Project binding changed");
  }
  for (const sessionId of sessionIds) {
    const assignment = await client.query<Row>(
      `select project_assignment_version,
         (case when project_override_at is not null then project_override_personal_project_id
           else automatic_personal_project_id end) as project_id
       from sessions where id=$1 and owner_user_id=$2 for share`,
      [sessionId, ownerUserId]
    );
    const expected = sessionAssignments.get(sessionId)!;
    if (
      !assignment.rows[0] ||
      (assignment.rows[0].project_id == null
        ? null
        : dbText(assignment.rows[0].project_id)) !== expected.projectId ||
      Number(assignment.rows[0].project_assignment_version) !== expected.version
    )
      throw new ScheduledJobConflict("Conversation Project assignment changed");
  }
  const result = await client.query<Row>(
    "select * from scheduled_jobs where id=$1 and owner_user_id=$2 for update",
    [id, ownerUserId]
  );
  if (!result.rows[0])
    throw new ScheduledJobNotFound("Scheduled Job not found");
  if (
    result.rows[0].project_id !== before.project_id ||
    result.rows[0].conversation_session_id !== before.conversation_session_id
  )
    throw new ScheduledJobConflict("Scheduled Job binding changed");
  return result.rows[0];
};
const assertVersion = (job: Row, expectedVersion: number) => {
  if (Number(job.version) !== expectedVersion)
    throw new ScheduledJobConflict("Scheduled Job changed");
};
const binding = async (
  client: pg.PoolClient,
  ownerUserId: string,
  input: {
    agentId: string;
    conversationSessionId: string;
    projectId: string | null;
  },
  lock = true
) => {
  let project: Row | null = null;
  // Project before Conversation follows the existing chat-delete lock order.
  if (input.projectId) {
    const result = await client.query<Row>(
      `select id,version,team_backend_id,workspace_project_id from projects
        where id=$1 and owner_user_id=$2 and lifecycle='active' and deletion_phase is null
        ${lock ? "for share" : ""}`,
      [input.projectId, ownerUserId]
    );
    project = result.rows[0] ?? null;
    if (!project) throw new ScheduledJobConflict("Project is unavailable");
  }
  const conversation = await client.query<Row>(
    `select id,logical_session_id,updated_at,project_assignment_version,
       (case when project_override_at is not null then project_override_personal_project_id
             else automatic_personal_project_id end) as effective_project_id
       from sessions where id=$1 and owner_user_id=$2 and visibility='personal'
        and personal_deleted_at is null and trashed_at is null and invalidated_at is null
        and delete_batch_id is null and forget_batch_id is null ${lock ? "for share" : ""}`,
    [input.conversationSessionId, ownerUserId]
  );
  if (!conversation.rows[0])
    throw new ScheduledJobConflict("Conversation is unavailable");
  if ((conversation.rows[0].effective_project_id ?? null) !== input.projectId)
    throw new ScheduledJobConflict("Conversation Project binding changed");
  const agent = await client.query<Row>(
    `select agent.id,agent.ai_client_instance_id,
            agent.default_permission_mode,agent.default_model,
            instance.driver_id,instance.enabled
       from agents agent
       join ai_client_instances instance
         on instance.owner_user_id=agent.owner_user_id
        and instance.instance_id=agent.ai_client_instance_id
      where agent.id=$1 and agent.owner_user_id=$2
      ${lock ? "for share of agent,instance" : ""}`,
    [input.agentId, ownerUserId]
  );
  if (!agent.rows[0]) throw new ScheduledJobConflict("Agent is unavailable");
  return { conversation: conversation.rows[0], project, agent: agent.rows[0] };
};

const activeAgentMatchesExecution = (agent: Row, execution: Row): boolean =>
  agent.enabled === true &&
  agent.ai_client_instance_id === execution.ai_client_instance_id &&
  agent.driver_id === execution.provider &&
  agent.default_permission_mode === execution.permission_mode &&
  (agent.default_model == null || agent.default_model === execution.model);

export type ScheduledJobTeamAuthority = (input: {
  ownerUserId: string;
  projectId: string;
  teamBackendId: string;
  workspaceProjectId: string;
}) => Promise<{ projectVersion: number; memberVersion: number }>;

export function createScheduledJobRepository(
  pool: pg.Pool,
  options: {
    teamAuthority?: ScheduledJobTeamAuthority;
    encryptionProvider?: EnvelopeEncryptionProvider;
  } = {}
) {
  const textActionTeamProof = async (
    ownerUserId: string,
    projectId: string | null
  ) => {
    if (!projectId) return null;
    const result = await pool.query<Row>(
      `select id,team_backend_id,workspace_project_id from projects
       where id=$1 and owner_user_id=$2 and lifecycle='active' and deletion_phase is null`,
      [projectId, ownerUserId]
    );
    const project = result.rows[0];
    if (!project) throw new ScheduledJobConflict("Project is unavailable");
    return assertTeam(ownerUserId, project);
  };
  const matchesTextSnapshot = (
    snapshot: Record<string, unknown>,
    authority: Awaited<ReturnType<typeof binding>>,
    proof: Awaited<ReturnType<typeof textActionTeamProof>>
  ) =>
    (snapshot.projectId ?? null) === (authority.project?.id ?? null) &&
    (snapshot.projectVersion ?? null) ===
      (authority.project?.version ?? null) &&
    snapshot.conversationProjectAssignmentVersion ===
      authority.conversation.project_assignment_version &&
    (snapshot.teamBackendId ?? null) ===
      (authority.project?.team_backend_id ?? null) &&
    (snapshot.workspaceProjectId ?? null) ===
      (authority.project?.workspace_project_id ?? null) &&
    (snapshot.teamProjectVersion ?? null) === (proof?.projectVersion ?? null) &&
    (snapshot.teamMemberVersion ?? null) === (proof?.memberVersion ?? null);
  const assertTeam = async (ownerUserId: string, project: Row | null) => {
    if (
      !project ||
      (project.team_backend_id == null && project.workspace_project_id == null)
    )
      return null;
    if (!project.team_backend_id || !project.workspace_project_id)
      throw new ScheduledJobAuthorityUnavailable(
        "Linked Project authority is incomplete"
      );
    if (!options.teamAuthority)
      throw new ScheduledJobAuthorityUnavailable(
        "Team authority is unavailable"
      );
    let proof: { projectVersion: number; memberVersion: number };
    try {
      proof = await options.teamAuthority({
        ownerUserId,
        projectId: dbText(project.id),
        teamBackendId: dbText(project.team_backend_id),
        workspaceProjectId: dbText(project.workspace_project_id)
      });
    } catch {
      throw new ScheduledJobAuthorityUnavailable(
        "Current Team authority is unavailable"
      );
    }
    return {
      teamBackendId: dbText(project.team_backend_id),
      workspaceProjectId: dbText(project.workspace_project_id),
      ...proof
    };
  };
  const update = async (
    client: pg.PoolClient,
    ownerUserId: string,
    id: string,
    expectedVersion: number,
    values: string[],
    params: unknown[]
  ) => {
    const current = await lockJob(client, ownerUserId, id);
    assertVersion(current, expectedVersion);
    const result = await client.query<Row>(
      `update scheduled_jobs set ${values.join(",")},version=version+1,updated_at=now()
       where id=$1 and owner_user_id=$2 returning *`,
      [id, ownerUserId, ...params]
    );
    await changed(client, ownerUserId, id);
    return mapJob(result.rows[0]!);
  };
  const startAttemptWithClient = async (
    client: pg.PoolClient,
    ownerUserId: string,
    id: string,
    runId: string,
    input: {
      expectedJobVersion: number;
      runnerDeviceId: string;
      fenceToken: string;
    }
  ) => {
    const job = await lockJob(client, ownerUserId, id);
    assertVersion(job, input.expectedJobVersion);
    if (job.paused || job.runner_device_id !== input.runnerDeviceId)
      throw new ScheduledJobConflict("Assigned device or pause state changed");
    const authority = await binding(client, ownerUserId, {
      agentId: String(job.agent_id),
      conversationSessionId: String(job.conversation_session_id),
      projectId: job.project_id == null ? null : dbText(job.project_id)
    });
    const team = await assertTeam(ownerUserId, authority.project);
    const run = await client.query<Row>(
      "select * from scheduled_job_runs where id=$1 and job_id=$2 for update",
      [runId, id]
    );
    if (!run.rows[0] || run.rows[0].status !== "scheduled")
      throw new ScheduledJobConflict("Occurrence is no longer scheduled");
    const active = await client.query<Row>(
      "select started_at from scheduled_job_runs where job_id=$1 and id<>$2 and status in ('running','waiting_approval') limit 1",
      [id, runId]
    );
    const scheduledFor = new Date(run.rows[0].scheduled_for as string | Date);
    const missed =
      run.rows[0].trigger === "scheduled" &&
      Date.now() - scheduledFor.getTime() > 15 * 60_000;
    const overlap = Boolean(
      active.rows[0] &&
      (!missed ||
        !active.rows[0].started_at ||
        new Date(active.rows[0].started_at as string | Date) <= scheduledFor)
    );
    if (overlap || missed) {
      const ended = await client.query<Row>(
        `update scheduled_job_runs set status=$2,skip_reason=$3,finished_at=now(),updated_at=now()
              where id=$1 returning *`,
        [runId, overlap ? "skipped" : "missed", overlap ? "overlap" : null]
      );
      await changed(client, ownerUserId, id);
      return { started: false as const, run: mapRun(ended.rows[0]!) };
    }
    const nextAttempt = Number(run.rows[0].attempt) + 1;
    const executionId = randomUUID();
    const hash = createHash("sha256").update(input.fenceToken).digest("hex");
    const attempt = await client.query<Row>(
      `insert into scheduled_job_attempts(run_id,attempt,execution_id,fence_generation,
             fence_token_hash,job_version,runner_device_id,conversation_session_id,
             conversation_project_assignment_version,project_id,project_version,
             team_backend_id,workspace_project_id,team_project_version,team_member_version)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
      [
        runId,
        nextAttempt,
        executionId,
        nextAttempt,
        hash,
        input.expectedJobVersion,
        input.runnerDeviceId,
        job.conversation_session_id,
        authority.conversation.project_assignment_version,
        job.project_id,
        authority.project?.version ?? null,
        team?.teamBackendId ?? null,
        team?.workspaceProjectId ?? null,
        team?.projectVersion ?? null,
        team?.memberVersion ?? null
      ]
    );
    await client.query(
      `insert into scheduled_job_attempt_events(attempt_id,event_kind,execution_id,
             fence_generation,status,at) values($1,'attempt_start',$2,$3,'running',clock_timestamp())`,
      [attempt.rows[0]!.id, executionId, nextAttempt]
    );
    const nextRun = await client.query<Row>(
      `update scheduled_job_runs set attempt=$2,status='running',execution_id=$3,
             started_at=now(),finished_at=null,error=null,updated_at=now()
           where id=$1 returning *`,
      [runId, nextAttempt, executionId]
    );
    await changed(client, ownerUserId, id);
    return {
      started: true as const,
      run: mapRun(nextRun.rows[0]!),
      attemptId: String(attempt.rows[0]!.id),
      executionId,
      fenceGeneration: nextAttempt
    };
  };
  const currentManagedCommand = async (
    client: pg.PoolClient,
    ownerUserId: string,
    commandId: string,
    runnerDeviceId: string,
    states: string[]
  ) => {
    const found = await client.query<Row>(
      `select run.job_id from scheduled_job_attempt_dispatch_bindings dispatch
        join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
        join scheduled_job_runs run on run.id=attempt.run_id
       where dispatch.owner_user_id=$1 and dispatch.managed_command_id=$2`,
      [ownerUserId, commandId]
    );
    if (!found.rows[0]) return null;
    const job = await lockJob(
      client,
      ownerUserId,
      dbText(found.rows[0].job_id)
    );
    const authority = await binding(client, ownerUserId, {
      agentId: dbText(job.agent_id),
      conversationSessionId: dbText(job.conversation_session_id),
      projectId: job.project_id == null ? null : dbText(job.project_id)
    });
    const team = await assertTeam(ownerUserId, authority.project);
    const current = await client.query<Row>(
      `select attempt.*,run.id as run_id,run.status as run_status,
          command.state as command_state,command.lease_token as command_lease_token,
          command.lease_expires_at as command_lease_expires_at,
          command.attempts as command_attempts,
          execution.execution_generation,execution.state as execution_state,
          execution.project_id as managed_project_id,
          execution.logical_session_id as managed_logical_session_id,
          execution.ai_client_instance_id as managed_ai_client_instance_id,
          execution.provider as managed_provider,
          execution.permission_mode as managed_permission_mode,
          execution.model as managed_model,
          execution.runner_deployment_id,execution.runner_id,
          runtime.deployment_id as bound_deployment_id
       from scheduled_job_attempt_dispatch_bindings dispatch
        join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
        join scheduled_job_runs run on run.id=attempt.run_id
        join managed_conversation_commands command on command.id=dispatch.managed_command_id
        join managed_conversation_executions execution on execution.id=dispatch.managed_execution_id
        join managed_conversation_runtime_bindings runtime on runtime.execution_id=execution.id
       where dispatch.owner_user_id=$1 and dispatch.managed_command_id=$2
         and dispatch.managed_execution_generation=execution.execution_generation
         and command.execution_id=execution.id and command.owner_user_id=$1
         and command.execution_generation=execution.execution_generation
         and execution.owner_user_id=$1 and execution.runner_device_id=$3
         and runtime.owner_user_id=$1 and runtime.device_id=$3
         and runtime.execution_generation=execution.execution_generation
         and run.job_id=$4 and run.execution_id=attempt.execution_id
         and run.attempt=attempt.attempt
       for share of dispatch,attempt,run,command,execution,runtime`,
      [ownerUserId, commandId, runnerDeviceId, job.id]
    );
    const row = current.rows[0];
    const terminalReconciliation = row?.command_state === "completed";
    if (
      !row ||
      job.paused ||
      job.runner_device_id !== runnerDeviceId ||
      Number(job.version) !== Number(row.job_version) ||
      row.conversation_session_id !== job.conversation_session_id ||
      row.managed_logical_session_id !==
        authority.conversation.logical_session_id ||
      (job.project_id != null &&
        row.managed_project_id !== dbText(job.project_id)) ||
      row.managed_ai_client_instance_id !==
        authority.agent.ai_client_instance_id ||
      (["queued", "dispatching"].includes(dbText(row.command_state)) &&
        !activeAgentMatchesExecution(authority.agent, {
          ai_client_instance_id: row.managed_ai_client_instance_id,
          provider: row.managed_provider,
          permission_mode: row.managed_permission_mode,
          model: row.managed_model
        })) ||
      Number(row.conversation_project_assignment_version) !==
        Number(authority.conversation.project_assignment_version) ||
      row.project_id !== job.project_id ||
      (row.project_version == null ? null : Number(row.project_version)) !==
        (authority.project?.version == null
          ? null
          : Number(authority.project.version)) ||
      (row.team_backend_id ?? null) !== (team?.teamBackendId ?? null) ||
      (row.workspace_project_id ?? null) !==
        (team?.workspaceProjectId ?? null) ||
      (row.team_project_version == null
        ? null
        : Number(row.team_project_version)) !==
        (team?.projectVersion ?? null) ||
      (row.team_member_version == null
        ? null
        : Number(row.team_member_version)) !== (team?.memberVersion ?? null) ||
      row.bound_deployment_id !== row.runner_deployment_id ||
      !states.includes(dbText(row.command_state)) ||
      (!terminalReconciliation && Number(row.command_attempts) > 1) ||
      !["running", "waiting_approval"].includes(dbText(row.run_status)) ||
      ![
        "running",
        "quiesce_requested",
        ...(terminalReconciliation ? ["quiesced"] : [])
      ].includes(dbText(row.execution_state))
    )
      throw new ScheduledJobConflict("Scheduled dispatch authority changed");
    return { job, row };
  };
  return {
    async listInterruptedManagedCommandsAwaitingProviderAck(
      ownerUserId: string,
      runnerDeviceId: string,
      limit = 100
    ) {
      const result = await pool.query<{ managed_command_id: string }>(
        `select dispatch.managed_command_id
         from scheduled_job_attempt_dispatch_bindings dispatch
          join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
          join scheduled_job_runs run on run.id=attempt.run_id
          join scheduled_jobs job on job.id=run.job_id
          join managed_conversation_commands command on command.id=dispatch.managed_command_id
         where dispatch.owner_user_id=$1 and job.owner_user_id=$1
           and job.runner_device_id=$2 and run.status='interrupted'
           and run.execution_id=attempt.execution_id and run.attempt=attempt.attempt
           and command.owner_user_id=$1 and command.state='indeterminate'
         order by attempt.started_at limit $3`,
        [ownerUserId, runnerDeviceId, Math.min(Math.max(limit, 1), 100)]
      );
      return result.rows.map((row) => row.managed_command_id);
    },
    async releaseInterruptedManagedCommandAfterProviderAck(
      ownerUserId: string,
      commandId: string,
      runnerDeviceId: string
    ) {
      return transaction(pool, async (client) => {
        const current = await client.query<Row>(
          `select command.execution_id,command.execution_generation,
              command.sequence,command.completed_at,command.result,
              execution.state as execution_state
           from scheduled_job_attempt_dispatch_bindings dispatch
            join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
            join scheduled_job_runs run on run.id=attempt.run_id
            join scheduled_jobs job on job.id=run.job_id
            join managed_conversation_commands command on command.id=dispatch.managed_command_id
            join managed_conversation_executions execution on execution.id=command.execution_id
           where dispatch.owner_user_id=$1 and dispatch.managed_command_id=$2
             and job.owner_user_id=$1 and job.runner_device_id=$3
             and run.status='interrupted' and run.execution_id=attempt.execution_id
             and run.attempt=attempt.attempt and command.owner_user_id=$1
             and command.state='indeterminate' and execution.owner_user_id=$1
             and execution.execution_generation=command.execution_generation
             and dispatch.managed_execution_generation=command.execution_generation
           for update of command,execution`,
          [ownerUserId, commandId, runnerDeviceId]
        );
        const row = current.rows[0];
        if (
          !row ||
          !["running", "reconciling"].includes(dbText(row.execution_state))
        )
          return false;
        const controls = await client.query<Row>(
          `select result from managed_conversation_commands
           where owner_user_id=$1 and execution_id=$2
             and execution_generation=$3 and command_kind='interrupt'
             and state='completed' and sequence>$4
             and completed_at>$5
             and result->>'scheduledRecoveryCommandId'=$6
             and result->>'providerQuiesced'='true'
           order by sequence desc limit 1`,
          [
            ownerUserId,
            row.execution_id,
            row.execution_generation,
            row.sequence,
            row.completed_at,
            commandId
          ]
        );
        const ack = controls.rows[0]?.result as
          | Record<string, unknown>
          | undefined;
        if (!ack) return false;
        const providerTurnId =
          row.result && typeof row.result === "object"
            ? (row.result as Record<string, unknown>).providerTurnId
            : undefined;
        if (
          typeof providerTurnId === "string" &&
          ack.interrupted === true &&
          ack.turnId !== providerTurnId
        )
          return false;
        const result = await client.query(
          `update managed_conversation_commands
             set state='canceled',updated_at=now()
           where id=$1 and owner_user_id=$2 and state='indeterminate'`,
          [commandId, ownerUserId]
        );
        if (result.rowCount !== 1) return false;
        if (row.execution_state === "reconciling") {
          const restored = await client.query<{ state_version: number }>(
            `update managed_conversation_executions
               set state='running',state_version=state_version+1,
                   last_error_code=null,updated_at=now()
             where id=$1 and owner_user_id=$2 and execution_generation=$3
               and state='reconciling'
             returning state_version`,
            [row.execution_id, ownerUserId, row.execution_generation]
          );
          if (restored.rowCount !== 1)
            throw new ScheduledJobConflict("Provider recovery state changed");
          await appendCollaborationOutboxEventWithClient(client, {
            family: "managed_conversation_changed",
            scope: "personal",
            personalOwnerUserId: ownerUserId,
            teamId: null,
            teamWorkspaceId: null,
            threadId: null,
            messageId: null,
            shareGrantId: null,
            logicalMemoryId: null,
            resourceType: "managed_conversation_execution",
            resourceId: dbText(row.execution_id),
            actorPrincipalId: ownerUserId,
            mutationId: managedConversationEventMutationId(
              `managed-conversation:${row.execution_id}:state:${restored.rows[0]!.state_version}`
            )
          });
        }
        return true;
      });
    },
    async interruptScheduledAuthorityLoss(
      ownerUserId: string,
      commandId: string,
      runnerDeviceId: string,
      reason: "changed" | "unavailable"
    ) {
      return transaction(pool, async (client) => {
        const result = await client.query<Row>(
          `select attempt.id as attempt_id,attempt.execution_id,
              attempt.fence_generation,attempt.attempt,
              run.id as run_id,job.id as job_id,
              command.state as command_state
           from scheduled_job_attempt_dispatch_bindings dispatch
            join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
            join scheduled_job_runs run on run.id=attempt.run_id
            join scheduled_jobs job on job.id=run.job_id
            join managed_conversation_commands command on command.id=dispatch.managed_command_id
           where dispatch.owner_user_id=$1 and dispatch.managed_command_id=$2
             and job.owner_user_id=$1 and job.runner_device_id=$3
             and command.owner_user_id=$1
             and run.execution_id=attempt.execution_id and run.attempt=attempt.attempt
             and run.status in ('running','waiting_approval')
             and (command.state in ('queued','dispatching')
               or (command.state='failed'
                 and command.last_error_code='ScheduledJobAuthorityUnavailable'))
           for update of job,run,attempt,command nowait`,
          [ownerUserId, commandId, runnerDeviceId]
        );
        const row = result.rows[0];
        if (!row) return false;
        const uncertain = row.command_state !== "queued";
        const outcome =
          reason === "unavailable"
            ? "Scheduled Job authority could not be verified; effects require review"
            : "Scheduled Job authority changed; effects require review";
        await client.query(
          `update managed_conversation_commands
             set state=$3,last_error_code='ScheduledJobAuthorityUnavailable',
               lease_token=null,lease_expires_at=null,completed_at=now(),updated_at=now()
           where id=$1 and owner_user_id=$2
             and (state in ('queued','dispatching')
               or (state='failed'
                 and last_error_code='ScheduledJobAuthorityUnavailable'))`,
          [commandId, ownerUserId, uncertain ? "indeterminate" : "canceled"]
        );
        await client.query(
          `insert into scheduled_job_attempt_events
             (attempt_id,event_kind,execution_id,fence_generation,status,uncertainty,outcome,at)
           values($1,'state',$2,$3,'interrupted',$4,$5,clock_timestamp())`,
          [
            row.attempt_id,
            row.execution_id,
            row.fence_generation,
            uncertain,
            outcome
          ]
        );
        await client.query(
          `update scheduled_job_runs set status='interrupted',finished_at=now(),
             error=$2,updated_at=now() where id=$1`,
          [row.run_id, outcome]
        );
        await changed(client, ownerUserId, dbText(row.job_id));
        return true;
      });
    },
    async listExpiredManagedCommands(
      ownerUserId: string,
      runnerDeviceId: string,
      limit = 100
    ) {
      const result = await pool.query<{ managed_command_id: string }>(
        `select dispatch.managed_command_id
         from scheduled_job_attempt_dispatch_bindings dispatch
          join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
          join scheduled_job_runs run on run.id=attempt.run_id
          join scheduled_jobs job on job.id=run.job_id
          join managed_conversation_commands command on command.id=dispatch.managed_command_id
         where dispatch.owner_user_id=$1 and job.owner_user_id=$1
           and job.runner_device_id=$2 and run.execution_id=attempt.execution_id
           and run.attempt=attempt.attempt and run.status in ('running','waiting_approval')
           and ((command.state='dispatching' and command.lease_expires_at<=now())
             or (command.state='queued' and attempt.started_at<=now()-interval '15 minutes'))
         order by attempt.started_at limit $3`,
        [ownerUserId, runnerDeviceId, Math.min(Math.max(limit, 1), 100)]
      );
      return result.rows.map((row) => row.managed_command_id);
    },
    async interruptExpiredManagedCommand(
      ownerUserId: string,
      commandId: string,
      runnerDeviceId: string
    ) {
      return transaction(pool, async (client) => {
        const current = await currentManagedCommand(
          client,
          ownerUserId,
          commandId,
          runnerDeviceId,
          ["queued", "dispatching"]
        );
        if (!current) return false;
        const staleQueued =
          current.row.command_state === "queued" &&
          new Date(current.row.started_at as Date | string).getTime() <=
            Date.now() - 15 * 60_000;
        const expiredLease =
          current.row.command_state === "dispatching" &&
          current.row.command_lease_expires_at &&
          new Date(
            current.row.command_lease_expires_at as Date | string
          ).getTime() <= Date.now();
        if (!staleQueued && !expiredLease) return false;
        const uncertain = current.row.command_state === "dispatching";
        const ended = await client.query(
          `update managed_conversation_commands
             set state=$4,last_error_code='ScheduledJobLeaseExpired',
               lease_token=null,lease_expires_at=null,completed_at=now(),updated_at=now()
           where id=$1 and owner_user_id=$2
             and ((state='queued' and $3::boolean)
               or (state='dispatching' and lease_expires_at<=now()))`,
          [
            commandId,
            ownerUserId,
            staleQueued,
            uncertain ? "indeterminate" : "canceled"
          ]
        );
        if (ended.rowCount !== 1) return false;
        await client.query(
          `insert into scheduled_job_attempt_events
             (attempt_id,event_kind,execution_id,fence_generation,status,uncertainty,outcome,at)
           values($1,'state',$2,$3,'interrupted',$4,$5,clock_timestamp())`,
          [
            current.row.id,
            current.row.execution_id,
            current.row.fence_generation,
            uncertain,
            uncertain
              ? "AI Client turn lease expired; effects require review"
              : "Queued AI Client turn expired before launch"
          ]
        );
        await client.query(
          `update scheduled_job_runs set status='interrupted',finished_at=now(),
             error=$2,updated_at=now() where id=$1 and status in ('running','waiting_approval')`,
          [
            current.row.run_id,
            uncertain
              ? "AI Client turn lease expired; effects require review"
              : "Queued AI Client turn expired before launch"
          ]
        );
        await changed(client, ownerUserId, dbText(current.job.id));
        return true;
      });
    },
    async listActiveManagedCommands(
      ownerUserId: string,
      runnerDeviceId: string,
      limit = 100
    ) {
      const result = await pool.query<{ managed_command_id: string }>(
        `select dispatch.managed_command_id
         from scheduled_job_attempt_dispatch_bindings dispatch
          join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
          join scheduled_job_runs run on run.id=attempt.run_id
          join scheduled_jobs job on job.id=run.job_id
          join managed_conversation_commands command on command.id=dispatch.managed_command_id
         where dispatch.owner_user_id=$1 and job.owner_user_id=$1
           and job.runner_device_id=$2 and run.execution_id=attempt.execution_id
           and run.attempt=attempt.attempt and run.status in ('running','waiting_approval')
           and command.state in ('queued','dispatching')
         order by attempt.started_at limit $3`,
        [ownerUserId, runnerDeviceId, Math.min(Math.max(limit, 1), 100)]
      );
      return result.rows.map((row) => row.managed_command_id);
    },
    async syncManagedApprovalWait(
      ownerUserId: string,
      commandId: string,
      runnerDeviceId: string
    ) {
      return transaction(pool, async (client) => {
        const current = await currentManagedCommand(
          client,
          ownerUserId,
          commandId,
          runnerDeviceId,
          ["dispatching"]
        );
        if (!current) return false;
        const pending = await client.query(
          `select 1 from managed_conversation_runtime_items item
            join scheduled_job_attempt_dispatch_bindings dispatch
              on dispatch.managed_command_id=$2
           where item.owner_user_id=$1 and item.execution_id=dispatch.managed_execution_id
             and item.execution_generation=dispatch.managed_execution_generation
             and item.state='pending'
             and item.item_kind in ('command_approval','file_approval','permissions_approval')
           limit 1`,
          [ownerUserId, commandId]
        );
        const status = pending.rowCount ? "waiting_approval" : "running";
        if (status === current.row.run_status) return false;
        await client.query(
          `insert into scheduled_job_attempt_events
            (attempt_id,event_kind,execution_id,fence_generation,status,outcome,at)
           values($1,'state',$2,$3,$4,$5,clock_timestamp())`,
          [
            current.row.id,
            current.row.execution_id,
            current.row.fence_generation,
            status,
            status === "waiting_approval"
              ? "Awaiting User approval"
              : "User approval resolved"
          ]
        );
        await client.query(
          `update scheduled_job_runs set status=$2,updated_at=now()
           where id=$1 and status in ('running','waiting_approval')`,
          [current.row.run_id, status]
        );
        await changed(client, ownerUserId, dbText(current.job.id));
        return true;
      });
    },
    async listTerminalManagedCommands(
      ownerUserId: string,
      runnerDeviceId: string,
      limit = 100
    ) {
      const result = await pool.query<{ managed_command_id: string }>(
        `select dispatch.managed_command_id
         from scheduled_job_attempt_dispatch_bindings dispatch
          join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
          join scheduled_job_runs run on run.id=attempt.run_id
          join scheduled_jobs job on job.id=run.job_id
          join managed_conversation_commands command on command.id=dispatch.managed_command_id
         where dispatch.owner_user_id=$1 and job.owner_user_id=$1
           and job.runner_device_id=$2 and run.execution_id=attempt.execution_id
           and run.attempt=attempt.attempt and run.status in ('running','waiting_approval')
           and command.state in ('completed','failed','indeterminate','canceled')
         order by attempt.started_at limit $3`,
        [ownerUserId, runnerDeviceId, Math.min(Math.max(limit, 1), 100)]
      );
      return result.rows.map((row) => row.managed_command_id);
    },
    async reconcileManagedCommandOutcome(
      ownerUserId: string,
      commandId: string,
      runnerDeviceId: string
    ) {
      return transaction(pool, async (client) => {
        const current = await currentManagedCommand(
          client,
          ownerUserId,
          commandId,
          runnerDeviceId,
          ["completed", "failed", "indeterminate", "canceled"]
        );
        if (!current) return false;
        const state = dbText(current.row.command_state);
        const status =
          Number(current.row.command_attempts) > 1
            ? "interrupted"
            : state === "completed"
              ? "ok"
              : state === "failed"
                ? "failed"
                : "interrupted";
        const uncertainty = status === "interrupted";
        const outcome =
          status === "ok"
            ? "Managed turn completed"
            : status === "failed"
              ? "Managed turn failed"
              : "Managed turn outcome uncertain";
        await client.query(
          `insert into scheduled_job_attempt_events
            (attempt_id,event_kind,execution_id,fence_generation,status,uncertainty,outcome,at)
           values($1,'state',$2,$3,$4,$5,$6,clock_timestamp())`,
          [
            current.row.id,
            current.row.execution_id,
            current.row.fence_generation,
            status,
            uncertainty,
            outcome
          ]
        );
        await client.query(
          `update scheduled_job_runs set status=$2,finished_at=now(),
             error=case when $4::boolean then null else $3 end,updated_at=now()
           where id=$1 and status in ('running','waiting_approval')`,
          [current.row.run_id, status, outcome, status === "ok"]
        );
        await changed(client, ownerUserId, dbText(current.job.id));
        return true;
      });
    },
    async getActiveScheduledCommandForExecution(
      ownerUserId: string,
      executionId: string
    ) {
      const found = await pool.query<{ managed_command_id: string }>(
        `select dispatch.managed_command_id
         from scheduled_job_attempt_dispatch_bindings dispatch
          join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
          join scheduled_job_runs run on run.id=attempt.run_id
          join managed_conversation_commands command on command.id=dispatch.managed_command_id
         where dispatch.owner_user_id=$1 and dispatch.managed_execution_id=$2
           and run.execution_id=attempt.execution_id
           and run.attempt=attempt.attempt
           and (run.status in ('running','waiting_approval')
             or command.state in ('queued','blocked','dispatching','indeterminate'))
         order by attempt.started_at desc limit 1`,
        [ownerUserId, executionId]
      );
      return found.rows[0]?.managed_command_id ?? null;
    },
    async assertManagedCommandAuthority(
      ownerUserId: string,
      commandId: string,
      runnerDeviceId: string,
      states: string[] = ["dispatching"]
    ) {
      return transaction(pool, async (client) => {
        const current = await currentManagedCommand(
          client,
          ownerUserId,
          commandId,
          runnerDeviceId,
          states
        );
        return current
          ? { scheduled: true as const, attemptId: dbText(current.row.id) }
          : { scheduled: false as const };
      });
    },
    async appendManagedCommandLease(
      ownerUserId: string,
      commandId: string,
      runnerDeviceId: string,
      leaseToken: string,
      runnerId: string
    ) {
      return transaction(pool, async (client) => {
        const current = await currentManagedCommand(
          client,
          ownerUserId,
          commandId,
          runnerDeviceId,
          ["dispatching"]
        );
        if (!current) return false;
        if (
          current.row.command_lease_token !== leaseToken ||
          current.row.runner_id !== runnerId ||
          !current.row.command_lease_expires_at ||
          new Date(
            current.row.command_lease_expires_at as Date | string
          ).getTime() <= Date.now()
        )
          throw new ScheduledJobConflict("Scheduled command lease changed");
        const previous = await client.query<Row>(
          `select event_kind,lease_owner_id,lease_expires_at from scheduled_job_attempt_events
           where attempt_id=$1 and event_kind in ('lease_acquired','lease_renewed')
           order by at desc,id desc limit 1`,
          [current.row.id]
        );
        if (
          previous.rows[0]?.lease_owner_id === runnerId &&
          previous.rows[0]?.lease_expires_at &&
          new Date(
            previous.rows[0].lease_expires_at as Date | string
          ).getTime() ===
            new Date(
              current.row.command_lease_expires_at as Date | string
            ).getTime()
        )
          return true;
        await client.query(
          `insert into scheduled_job_attempt_events
            (attempt_id,event_kind,execution_id,fence_generation,status,lease_owner_id,lease_expires_at,at)
           values($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`,
          [
            current.row.id,
            previous.rows[0] ? "lease_renewed" : "lease_acquired",
            current.row.execution_id,
            current.row.fence_generation,
            current.row.run_status,
            runnerId,
            current.row.command_lease_expires_at
          ]
        );
        return true;
      });
    },
    async listRuntimeCandidates(
      ownerUserId: string,
      runnerDeviceId: string,
      afterId: string | null,
      limit = 100
    ) {
      const result = await pool.query<Row>(
        `select job.*,
          (select max(run.scheduled_for) from scheduled_job_runs run
            where run.job_id=job.id and run.trigger='scheduled') as last_scheduled_for
         from scheduled_jobs job
         where job.owner_user_id=$1 and job.runner_device_id=$2
           and job.id>$3::uuid
         order by job.id limit $4`,
        [
          ownerUserId,
          runnerDeviceId,
          afterId ?? "00000000-0000-0000-0000-000000000000",
          Math.min(Math.max(limit, 1), 100)
        ]
      );
      return result.rows.map((row) => ({
        job: mapJob(row),
        lastScheduledFor:
          row.last_scheduled_for == null ? null : iso(row.last_scheduled_for)
      }));
    },
    async listPendingRuntimeRuns(
      ownerUserId: string,
      runnerDeviceId: string,
      limit = 100
    ) {
      const result = await pool.query<Row>(
        `select run.*,job.version as job_version,job.instruction as job_instruction,
           job.agent_id as job_agent_id,job.conversation_session_id as job_conversation_session_id,
           job.project_id as job_project_id
         from scheduled_job_runs run join scheduled_jobs job on job.id=run.job_id
         where job.owner_user_id=$1 and job.runner_device_id=$2
           and job.paused=false and run.status='scheduled'
         order by run.scheduled_for,run.id limit $3`,
        [ownerUserId, runnerDeviceId, Math.min(Math.max(limit, 1), 100)]
      );
      return result.rows.map((row) => ({
        run: mapRun(row),
        jobVersion: Number(row.job_version),
        instruction: dbText(row.job_instruction),
        agentId: dbText(row.job_agent_id),
        conversationSessionId: dbText(row.job_conversation_session_id),
        projectId:
          row.job_project_id == null ? null : dbText(row.job_project_id)
      }));
    },
    async create(
      ownerUserId: string,
      runnerDeviceId: string,
      input: CreateScheduledJob
    ) {
      const textProof = input.textActionId
        ? await textActionTeamProof(ownerUserId, input.projectId)
        : null;
      return transaction(pool, async (client) => {
        const payloadHash = createHash("sha256")
          .update(
            JSON.stringify({
              projectId: input.projectId,
              agentId: input.agentId,
              conversationSessionId: input.conversationSessionId,
              title: input.title,
              instruction: input.instruction,
              schedule: canonicalSchedule(input.schedule),
              runnerDeviceId
            })
          )
          .digest("hex");
        const prior = await client.query<Row>(
          "select * from scheduled_jobs where owner_user_id=$1 and creation_request_id=$2 for share",
          [ownerUserId, input.requestId]
        );
        if (prior.rows[0]) {
          if (prior.rows[0].creation_payload_hash !== payloadHash)
            throw new ScheduledJobConflict("Creation request changed");
          if (input.textActionId) {
            const receipt = await client.query<Row>(
              `select id from managed_conversation_text_actions
               where id=$1 and owner_user_id=$2 and action_name='koed_job_create'
                 and state='applied'`,
              [input.textActionId, ownerUserId]
            );
            if (input.requestId !== input.textActionId || !receipt.rows[0])
              throw new ScheduledJobConflict(
                "Scheduled Job text action receipt missing"
              );
          }
          return mapJob(prior.rows[0]);
        }
        let textSnapshot: Record<string, unknown> | null = null;
        if (input.textActionId) {
          const valid = await claimedManagedTextCreateWithClient(
            client,
            options.encryptionProvider,
            {
              ownerUserId,
              actionId: input.textActionId,
              name: "koed_job_create",
              matches: (args, snapshot) =>
                input.requestId === input.textActionId &&
                args.title === input.title &&
                args.instruction === input.instruction &&
                JSON.stringify(args.schedule) ===
                  JSON.stringify(input.schedule) &&
                (snapshot.projectId ?? null) === input.projectId &&
                snapshot.agentId === input.agentId &&
                snapshot.conversationSessionId ===
                  input.conversationSessionId &&
                ((textSnapshot = snapshot), true)
            }
          );
          if (!valid)
            throw new ScheduledJobConflict("Scheduled Job text action changed");
        }
        const current = await binding(client, ownerUserId, input);
        if (input.textActionId) {
          if (
            !textSnapshot ||
            !matchesTextSnapshot(textSnapshot, current, textProof)
          )
            throw new ScheduledJobConflict(
              "Scheduled Job text action binding changed"
            );
        } else await assertTeam(ownerUserId, current.project);
        const result = await client.query<Row>(
          `insert into scheduled_jobs (owner_user_id,creation_request_id,creation_payload_hash,
            project_id,agent_id,conversation_session_id,title,instruction,schedule,runner_device_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
           on conflict(owner_user_id,creation_request_id) do nothing returning *`,
          [
            ownerUserId,
            input.requestId,
            payloadHash,
            input.projectId,
            input.agentId,
            input.conversationSessionId,
            input.title,
            input.instruction,
            JSON.stringify(canonicalSchedule(input.schedule)),
            runnerDeviceId
          ]
        );
        if (!result.rows[0]) {
          const raced = await client.query<Row>(
            "select * from scheduled_jobs where owner_user_id=$1 and creation_request_id=$2",
            [ownerUserId, input.requestId]
          );
          if (raced.rows[0]?.creation_payload_hash !== payloadHash)
            throw new ScheduledJobConflict("Creation request changed");
          return mapJob(raced.rows[0]!);
        }
        await changed(client, ownerUserId, String(result.rows[0]!.id));
        if (input.textActionId) {
          const applied = await client.query(
            `update managed_conversation_text_actions set state='applied',revision=revision+1,updated_at=now()
             where id=$1 and owner_user_id=$2 and state='claimed'`,
            [input.textActionId, ownerUserId]
          );
          if (applied.rowCount !== 1)
            throw new ScheduledJobConflict("Scheduled Job text action changed");
        }
        return mapJob(result.rows[0]!);
      });
    },
    async list(
      ownerUserId: string,
      options: { limit: number; cursor?: string }
    ) {
      let cursor: { createdAt: string; id: string } | null = null;
      if (options.cursor) {
        try {
          const parsed: unknown = JSON.parse(
            Buffer.from(options.cursor, "base64url").toString("utf8")
          );
          if (!parsed || typeof parsed !== "object")
            throw new Error("Invalid cursor");
          const candidate = parsed as { createdAt?: unknown; id?: unknown };
          if (
            typeof candidate.createdAt !== "string" ||
            typeof candidate.id !== "string" ||
            !Number.isFinite(Date.parse(candidate.createdAt)) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              candidate.id
            )
          )
            throw new Error("Invalid cursor");
          cursor = { createdAt: candidate.createdAt, id: candidate.id };
        } catch {
          throw new ScheduledJobConflict("Invalid Scheduled Job cursor");
        }
      }
      const result = await pool.query<Row>(
        `select * from scheduled_jobs where owner_user_id=$1
          and ($2::timestamptz is null or (created_at,id)<($2::timestamptz,$3::uuid))
          order by created_at desc,id desc limit $4`,
        [
          ownerUserId,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          options.limit + 1
        ]
      );
      const page = result.rows.slice(0, options.limit);
      const last = page.at(-1);
      return {
        jobs: page.map(mapJob),
        nextCursor:
          result.rows.length > options.limit && last
            ? Buffer.from(
                JSON.stringify({
                  createdAt: iso(last.created_at),
                  id: String(last.id)
                })
              ).toString("base64url")
            : null
      };
    },
    async get(ownerUserId: string, id: string) {
      const result = await pool.query<Row>(
        "select * from scheduled_jobs where owner_user_id=$1 and id=$2",
        [ownerUserId, id]
      );
      if (!result.rows[0])
        throw new ScheduledJobNotFound("Scheduled Job not found");
      return mapJob(result.rows[0]);
    },
    async edit(ownerUserId: string, id: string, input: EditScheduledJob) {
      return transaction(pool, async (client) => {
        const current = await lockJob(client, ownerUserId, id, {
          projectId: input.projectId,
          conversationSessionId: input.conversationSessionId
        });
        assertVersion(current, input.expectedVersion);
        const next = {
          agentId: input.agentId ?? String(current.agent_id),
          conversationSessionId:
            input.conversationSessionId ??
            String(current.conversation_session_id),
          projectId:
            input.projectId === undefined
              ? current.project_id == null
                ? null
                : dbText(current.project_id)
              : input.projectId
        };
        const authority = await binding(client, ownerUserId, next);
        await assertTeam(ownerUserId, authority.project);
        const result = await client.query<Row>(
          `update scheduled_jobs set project_id=$3,agent_id=$4,conversation_session_id=$5,
             title=$6,instruction=$7,schedule=$8::jsonb,version=version+1,updated_at=now()
            where id=$1 and owner_user_id=$2 returning *`,
          [
            id,
            ownerUserId,
            next.projectId,
            next.agentId,
            next.conversationSessionId,
            input.title ?? current.title,
            input.instruction ?? current.instruction,
            JSON.stringify(
              canonicalSchedule(
                input.schedule ??
                  scheduledJobScheduleSchema.parse(current.schedule)
              )
            )
          ]
        );
        await changed(client, ownerUserId, id);
        return mapJob(result.rows[0]!);
      });
    },
    async setPaused(
      ownerUserId: string,
      id: string,
      expectedVersion: number,
      paused: boolean,
      textActionId?: string
    ) {
      const textProject = textActionId
        ? (
            await pool.query<Row>(
              "select project_id from scheduled_jobs where id=$1 and owner_user_id=$2",
              [id, ownerUserId]
            )
          ).rows[0]
        : null;
      const textProof = textActionId
        ? await textActionTeamProof(
            ownerUserId,
            textProject?.project_id == null
              ? null
              : dbText(textProject.project_id)
          )
        : null;
      return transaction(pool, async (client) => {
        const current = await lockJob(client, ownerUserId, id);
        assertVersion(current, expectedVersion);
        let textSnapshot: Record<string, unknown> | null = null;
        if (textActionId) {
          const valid = await claimedManagedTextCreateWithClient(
            client,
            options.encryptionProvider,
            {
              ownerUserId,
              actionId: textActionId,
              name: "koed_job_pause",
              matches: (args, snapshot) =>
                args.title === current.title &&
                args.paused === paused &&
                snapshot.jobId === id &&
                snapshot.jobVersion === expectedVersion &&
                snapshot.paused === current.paused &&
                snapshot.agentId === current.agent_id &&
                snapshot.conversationSessionId ===
                  current.conversation_session_id &&
                ((textSnapshot = snapshot), true)
            }
          );
          if (!valid)
            throw new ScheduledJobConflict("Scheduled Job text action changed");
        }
        if (!paused || textActionId) {
          const authority = await binding(client, ownerUserId, {
            agentId: String(current.agent_id),
            conversationSessionId: String(current.conversation_session_id),
            projectId:
              current.project_id == null ? null : dbText(current.project_id)
          });
          if (textActionId) {
            if (
              !textSnapshot ||
              !matchesTextSnapshot(textSnapshot, authority, textProof)
            )
              throw new ScheduledJobConflict(
                "Scheduled Job text action binding changed"
              );
          } else await assertTeam(ownerUserId, authority.project);
        }
        const result = await client.query<Row>(
          `update scheduled_jobs set paused=$3,paused_reason=$4,version=version+1,updated_at=now()
           where id=$1 and owner_user_id=$2 returning *`,
          [id, ownerUserId, paused, paused ? "owner" : null]
        );
        await changed(client, ownerUserId, id);
        if (textActionId) {
          const applied = await client.query(
            `update managed_conversation_text_actions set state='applied',revision=revision+1,updated_at=now()
             where id=$1 and owner_user_id=$2 and state='claimed'`,
            [textActionId, ownerUserId]
          );
          if (applied.rowCount !== 1)
            throw new ScheduledJobConflict("Scheduled Job text action changed");
        }
        return mapJob(result.rows[0]!);
      });
    },
    async reassign(
      ownerUserId: string,
      id: string,
      expectedVersion: number,
      targetDeviceId: string
    ) {
      return transaction(pool, async (client) => {
        const device = await client.query<Row>(
          `select credential.id from device_credentials credential
            join personal_device_group_members member
              on member.device_id=credential.device_instance_id and member.status='active'
            join personal_device_group_user_subjects subject
              on subject.id=member.user_subject_id and subject.user_id=credential.owner_user_id
              and subject.revoked_at is null
            join personal_device_groups group_record
              on group_record.id=member.group_id and group_record.state='active'
            join local_personal_identities identity
              on identity.id=group_record.local_personal_identity_id
              and identity.owner_user_id=credential.owner_user_id
            join personal_sync_policies policy
              on policy.group_id=group_record.id and policy.enabled=true
            where credential.owner_user_id=$1 and credential.device_instance_id=$2
              and credential.revoked_at is null
              and (credential.expires_at is null or credential.expires_at>now())
              and 'sync'=any(credential.operation_families)
              and 'managed_execution'=any(credential.operation_families)
              and 'managed_execution'=any(member.operation_families)
              and credential.metadata->>'protocolDeploymentId' ~
                '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            limit 1 for share of credential,member,group_record,policy`,
          [ownerUserId, targetDeviceId]
        );
        if (!device.rows[0])
          throw new ScheduledJobConflict(
            "Target device is not enrolled for this owner"
          );
        return update(
          client,
          ownerUserId,
          id,
          expectedVersion,
          ["runner_device_id=$3"],
          [targetDeviceId]
        );
      });
    },
    async runNow(
      ownerUserId: string,
      id: string,
      expectedVersion: number,
      requestId: string
    ) {
      return transaction(pool, async (client) => {
        const job = await lockJob(client, ownerUserId, id);
        assertVersion(job, expectedVersion);
        const prior = await client.query<Row>(
          "select * from scheduled_job_runs where job_id=$1 and manual_request_id=$2",
          [id, requestId]
        );
        if (prior.rows[0]) return mapRun(prior.rows[0]);
        if (job.paused)
          throw new ScheduledJobConflict("Scheduled Job is paused");
        const authority = await binding(client, ownerUserId, {
          agentId: String(job.agent_id),
          conversationSessionId: String(job.conversation_session_id),
          projectId: job.project_id == null ? null : dbText(job.project_id)
        });
        await assertTeam(ownerUserId, authority.project);
        const active = await client.query(
          "select 1 from scheduled_job_runs where job_id=$1 and status in ('running','waiting_approval') limit 1",
          [id]
        );
        const result = await client.query<Row>(
          `insert into scheduled_job_runs(job_id,manual_request_id,scheduled_for,trigger,status,skip_reason,finished_at)
           values ($1,$2,clock_timestamp(),'manual',$3::scheduled_job_run_status,$4,
             case when $3::scheduled_job_run_status='skipped' then now() else null end)
           returning *`,
          [
            id,
            requestId,
            active.rows[0] ? "skipped" : "scheduled",
            active.rows[0] ? "overlap" : null
          ]
        );
        await changed(client, ownerUserId, id);
        return mapRun(result.rows[0]!);
      });
    },
    async retry(
      ownerUserId: string,
      id: string,
      runId: string,
      expectedVersion: number
    ) {
      return transaction(pool, async (client) => {
        const job = await lockJob(client, ownerUserId, id);
        assertVersion(job, expectedVersion);
        if (job.paused)
          throw new ScheduledJobConflict("Scheduled Job is paused");
        const authority = await binding(client, ownerUserId, {
          agentId: String(job.agent_id),
          conversationSessionId: String(job.conversation_session_id),
          projectId: job.project_id == null ? null : dbText(job.project_id)
        });
        await assertTeam(ownerUserId, authority.project);
        const run = await client.query<Row>(
          "select * from scheduled_job_runs where id=$1 and job_id=$2 for update",
          [runId, id]
        );
        if (!run.rows[0])
          throw new ScheduledJobNotFound("Scheduled Job run not found");
        if (!["interrupted", "failed"].includes(String(run.rows[0].status)))
          throw new ScheduledJobConflict(
            "Only interrupted or failed runs may be retried"
          );
        const result = await client.query<Row>(
          `update scheduled_job_runs set status='scheduled',skip_reason=null,
            started_at=null,finished_at=null,execution_id=null,error=null,updated_at=now()
           where id=$1 returning *`,
          [runId]
        );
        await changed(client, ownerUserId, id);
        return mapRun(result.rows[0]!);
      });
    },
    async skip(
      ownerUserId: string,
      id: string,
      runId: string,
      expectedVersion: number
    ) {
      return transaction(pool, async (client) => {
        const job = await lockJob(client, ownerUserId, id);
        assertVersion(job, expectedVersion);
        if (job.paused)
          throw new ScheduledJobConflict("Scheduled Job is paused");
        const authority = await binding(client, ownerUserId, {
          agentId: String(job.agent_id),
          conversationSessionId: String(job.conversation_session_id),
          projectId: job.project_id == null ? null : dbText(job.project_id)
        });
        await assertTeam(ownerUserId, authority.project);
        const run = await client.query<Row>(
          "select * from scheduled_job_runs where id=$1 and job_id=$2 for update",
          [runId, id]
        );
        if (!run.rows[0])
          throw new ScheduledJobNotFound("Scheduled Job run not found");
        if (
          !["interrupted", "scheduled", "failed", "missed"].includes(
            String(run.rows[0].status)
          )
        )
          throw new ScheduledJobConflict(
            "Active or finished run cannot be skipped"
          );
        const result = await client.query<Row>(
          `update scheduled_job_runs set status='skipped',skip_reason='owner',finished_at=now(),updated_at=now()
           where id=$1 returning *`,
          [runId]
        );
        await changed(client, ownerUserId, id);
        return mapRun(result.rows[0]!);
      });
    },
    async listRuns(
      ownerUserId: string,
      id: string,
      options: { limit: number; cursor?: string }
    ) {
      const job = await pool.query(
        "select 1 from scheduled_jobs where owner_user_id=$1 and id=$2",
        [ownerUserId, id]
      );
      if (!job.rows[0])
        throw new ScheduledJobNotFound("Scheduled Job not found");
      const cursor = options.cursor ? new Date(options.cursor) : null;
      if (cursor && !Number.isFinite(cursor.getTime()))
        throw new ScheduledJobConflict("Invalid run cursor");
      const result = await pool.query<Row>(
        `select * from scheduled_job_runs where job_id=$1
         and ($2::timestamptz is null or scheduled_for<$2)
         order by scheduled_for desc limit $3`,
        [id, cursor?.toISOString() ?? null, options.limit + 1]
      );
      const page = result.rows.slice(0, options.limit);
      return {
        runs: page.map(mapRun),
        nextCursor:
          result.rows.length > options.limit && page.at(-1)
            ? iso(page.at(-1)!.scheduled_for)
            : null
      };
    },
    async materializeScheduledOccurrence(
      ownerUserId: string,
      id: string,
      scheduledFor: Date,
      expectedVersion: number
    ) {
      return transaction(pool, async (client) => {
        const job = await lockJob(client, ownerUserId, id);
        assertVersion(job, expectedVersion);
        const latest = await client.query<{ scheduled_for: Date | null }>(
          `select max(scheduled_for) as scheduled_for from scheduled_job_runs
           where job_id=$1 and trigger='scheduled'`,
          [id]
        );
        const after = latest.rows[0]?.scheduled_for ?? job.created_at;
        const expected = nextScheduledJobOccurrence(
          scheduledJobScheduleSchema.parse(job.schedule),
          new Date(after as Date | string)
        );
        if (
          expected.getTime() !== scheduledFor.getTime() ||
          scheduledFor.getTime() > Date.now()
        )
          throw new ScheduledJobConflict("Scheduled occurrence changed");
        const bindingState = await binding(client, ownerUserId, {
          agentId: String(job.agent_id),
          conversationSessionId: String(job.conversation_session_id),
          projectId: job.project_id == null ? null : dbText(job.project_id)
        });
        await assertTeam(ownerUserId, bindingState.project);
        const active = await client.query<Row>(
          "select started_at from scheduled_job_runs where job_id=$1 and status in ('running','waiting_approval') limit 1",
          [id]
        );
        const overdue = Date.now() - scheduledFor.getTime() > 15 * 60_000;
        const overlap = Boolean(
          active.rows[0] &&
          (!overdue ||
            !active.rows[0].started_at ||
            new Date(active.rows[0].started_at as Date | string) <=
              scheduledFor)
        );
        const status =
          job.paused || overlap ? "skipped" : overdue ? "missed" : "scheduled";
        const reason = job.paused ? "paused" : overlap ? "overlap" : null;
        const result = await client.query<Row>(
          `insert into scheduled_job_runs(job_id,scheduled_for,trigger,status,skip_reason,finished_at)
            values($1,$2,'scheduled',$3::scheduled_job_run_status,$4,
              case when $3::scheduled_job_run_status='scheduled' then null else now() end)
            on conflict(job_id,scheduled_for) do nothing returning *`,
          [id, scheduledFor, status, reason]
        );
        if (!result.rows[0]) {
          const existing = await client.query<Row>(
            "select * from scheduled_job_runs where job_id=$1 and scheduled_for=$2",
            [id, scheduledFor]
          );
          return { run: mapRun(existing.rows[0]!), created: false };
        }
        await changed(client, ownerUserId, id);
        return { run: mapRun(result.rows[0]), created: true };
      });
    },
    async startAttempt(
      ownerUserId: string,
      id: string,
      runId: string,
      input: {
        expectedJobVersion: number;
        runnerDeviceId: string;
        fenceToken: string;
      }
    ) {
      return transaction(pool, (client) =>
        startAttemptWithClient(client, ownerUserId, id, runId, input)
      );
    },
    startAttemptWithClient,
    async settleUnlaunchableRun(
      ownerUserId: string,
      id: string,
      runId: string,
      expectedJobVersion: number,
      runnerDeviceId: string
    ) {
      return transaction(pool, async (client) => {
        const job = await lockJob(client, ownerUserId, id);
        assertVersion(job, expectedJobVersion);
        if (job.paused || job.runner_device_id !== runnerDeviceId)
          throw new ScheduledJobConflict(
            "Assigned device or pause state changed"
          );
        const authority = await binding(client, ownerUserId, {
          agentId: dbText(job.agent_id),
          conversationSessionId: dbText(job.conversation_session_id),
          projectId: job.project_id == null ? null : dbText(job.project_id)
        });
        await assertTeam(ownerUserId, authority.project);
        const run = await client.query<Row>(
          "select * from scheduled_job_runs where id=$1 and job_id=$2 for update",
          [runId, id]
        );
        if (!run.rows[0] || run.rows[0].status !== "scheduled") return null;
        const active = await client.query<Row>(
          "select started_at from scheduled_job_runs where job_id=$1 and id<>$2 and status in ('running','waiting_approval') limit 1",
          [id, runId]
        );
        const scheduledFor = new Date(
          run.rows[0].scheduled_for as string | Date
        );
        const missed =
          run.rows[0].trigger === "scheduled" &&
          Date.now() - scheduledFor.getTime() > 15 * 60_000;
        const overlap = Boolean(
          active.rows[0] &&
          (!missed ||
            !active.rows[0].started_at ||
            new Date(active.rows[0].started_at as Date | string) <=
              scheduledFor)
        );
        if (!overlap && !missed) return null;
        const ended = await client.query<Row>(
          `update scheduled_job_runs set status=$2,skip_reason=$3,finished_at=now(),updated_at=now()
           where id=$1 returning *`,
          [runId, overlap ? "skipped" : "missed", overlap ? "overlap" : null]
        );
        await changed(client, ownerUserId, id);
        return mapRun(ended.rows[0]!);
      });
    },
    async failUnsupportedRuntimeRun(
      ownerUserId: string,
      id: string,
      runId: string,
      input: {
        expectedJobVersion: number;
        runnerDeviceId: string;
        fenceToken: string;
      }
    ) {
      return transaction(pool, async (client) => {
        const started = await startAttemptWithClient(
          client,
          ownerUserId,
          id,
          runId,
          input
        );
        if (!started.started) return started.run;
        await client.query(
          `insert into scheduled_job_attempt_events
             (attempt_id,event_kind,execution_id,fence_generation,status,outcome,error,at)
           values($1,'state',$2,$3,'failed',$4,$5,clock_timestamp())`,
          [
            started.attemptId,
            started.executionId,
            started.fenceGeneration,
            "No AI Client work was launched",
            "Job Conversation is not a current compatible Managed Conversation"
          ]
        );
        const result = await client.query<Row>(
          `update scheduled_job_runs set status='failed',finished_at=now(),
             error=$2,updated_at=now() where id=$1 returning *`,
          [
            runId,
            "Job Conversation is not a current compatible Managed Conversation"
          ]
        );
        await changed(client, ownerUserId, id);
        return mapRun(result.rows[0]!);
      });
    },
    async appendAttemptEvent(
      ownerUserId: string,
      id: string,
      runId: string,
      input: {
        attemptId: string;
        executionId: string;
        fenceGeneration: number;
        fenceToken: string;
        expectedJobVersion: number;
        runnerDeviceId: string;
        status:
          | "running"
          | "waiting_approval"
          | "ok"
          | "failed"
          | "interrupted";
        uncertainty?: boolean;
        outcome?: string | null;
        error?: string | null;
      }
    ) {
      return transaction(pool, async (client) => {
        const job = await lockJob(client, ownerUserId, id);
        assertVersion(job, input.expectedJobVersion);
        if (job.paused || job.runner_device_id !== input.runnerDeviceId)
          throw new ScheduledJobConflict(
            "Assigned device or pause state changed"
          );
        const authority = await binding(client, ownerUserId, {
          agentId: String(job.agent_id),
          conversationSessionId: String(job.conversation_session_id),
          projectId: job.project_id == null ? null : dbText(job.project_id)
        });
        const team = await assertTeam(ownerUserId, authority.project);
        const run = await client.query<Row>(
          `select run.* from scheduled_job_runs run where run.id=$1 and run.job_id=$2 for update`,
          [runId, id]
        );
        if (
          !run.rows[0] ||
          run.rows[0].execution_id !== input.executionId ||
          !["running", "waiting_approval"].includes(String(run.rows[0].status))
        )
          throw new ScheduledJobConflict("Run attempt changed");
        if (
          (input.status === "waiting_approval" &&
            run.rows[0].status !== "running") ||
          (input.status === "running" &&
            run.rows[0].status !== "waiting_approval")
        )
          throw new ScheduledJobConflict("Run transition changed");
        const attempt = await client.query<Row>(
          `select * from scheduled_job_attempts where id=$1 and run_id=$2 for share`,
          [input.attemptId, runId]
        );
        const current = attempt.rows[0];
        if (
          !current ||
          current.execution_id !== input.executionId ||
          Number(current.fence_generation) !== input.fenceGeneration ||
          Number(current.job_version) !== input.expectedJobVersion ||
          current.runner_device_id !== input.runnerDeviceId ||
          current.fence_token_hash !==
            createHash("sha256").update(input.fenceToken).digest("hex") ||
          current.conversation_session_id !== job.conversation_session_id ||
          Number(current.conversation_project_assignment_version) !==
            Number(authority.conversation.project_assignment_version) ||
          current.project_id !== job.project_id ||
          (current.project_version == null
            ? null
            : Number(current.project_version)) !==
            (authority.project?.version == null
              ? null
              : Number(authority.project.version)) ||
          (current.team_backend_id ?? null) !== (team?.teamBackendId ?? null) ||
          (current.workspace_project_id ?? null) !==
            (team?.workspaceProjectId ?? null) ||
          (current.team_project_version == null
            ? null
            : Number(current.team_project_version)) !==
            (team?.projectVersion ?? null) ||
          (current.team_member_version == null
            ? null
            : Number(current.team_member_version)) !==
            (team?.memberVersion ?? null)
        )
          throw new ScheduledJobConflict("Attempt fence or binding changed");
        await client.query(
          `insert into scheduled_job_attempt_events(attempt_id,event_kind,execution_id,
             fence_generation,status,uncertainty,outcome,error,at)
           values($1,'state',$2,$3,$4,$5,$6,$7,clock_timestamp())`,
          [
            input.attemptId,
            input.executionId,
            input.fenceGeneration,
            input.status,
            input.uncertainty ?? false,
            input.outcome ?? null,
            input.error ?? null
          ]
        );
        const terminal =
          input.status !== "waiting_approval" && input.status !== "running";
        const result = await client.query<Row>(
          `update scheduled_job_runs set status=$2,finished_at=case when $3 then now() else null end,
             error=$4,updated_at=now() where id=$1 returning *`,
          [runId, input.status, terminal, input.error ?? null]
        );
        await changed(client, ownerUserId, id);
        return mapRun(result.rows[0]!);
      });
    },
    async attemptHistory(
      ownerUserId: string,
      id: string,
      runId: string,
      options: { limit: number; afterAttempt?: number } = { limit: 50 }
    ) {
      const found = await pool.query(
        `select 1 from scheduled_job_runs run join scheduled_jobs job on job.id=run.job_id
         where job.owner_user_id=$1 and job.id=$2 and run.id=$3`,
        [ownerUserId, id, runId]
      );
      if (!found.rows[0])
        throw new ScheduledJobNotFound("Scheduled Job run not found");
      const attempts = await pool.query<Row>(
        `select * from scheduled_job_attempts where run_id=$1 and attempt>$2
         order by attempt limit $3`,
        [runId, options.afterAttempt ?? 0, options.limit + 1]
      );
      const page = attempts.rows.slice(0, options.limit);
      const events = await pool.query<Row>(
        `select event.* from scheduled_job_attempt_events event
         where event.attempt_id=any($1::uuid[]) order by event.at,event.id`,
        [page.map((attempt) => attempt.id)]
      );
      return {
        attempts: page.map(mapAttempt),
        events: events.rows.map(mapAttemptEvent),
        nextAttempt:
          attempts.rows.length > options.limit
            ? Number(page.at(-1)!.attempt)
            : null
      };
    }
  };
}
export type ScheduledJobRepository = ReturnType<
  typeof createScheduledJobRepository
>;

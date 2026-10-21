import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import pg from "pg";
import {
  decryptEnvelopeToUtf8,
  parseKoedTextActionArguments,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type KoedTextActionName
} from "@koed/shared";
import type {
  ManagedTextActionRecord,
  ManagedTextActionRepository
} from "./managed-text-action-contract.js";
import { deckCreateFromTextAction } from "./managed-deck-action.js";

type Row = {
  id: string;
  owner_user_id: string;
  logical_session_id: string;
  execution_id: string;
  command_id: string;
  execution_generation: number;
  provider_turn_id: string;
  tool_call_id: string;
  action_name: KoedTextActionName;
  arguments_digest: string;
  encrypted_arguments: EncryptedPayloadEnvelope;
  encrypted_snapshot: EncryptedPayloadEnvelope;
  state: ManagedTextActionRecord["state"];
  revision: number;
  review_kind: ManagedTextActionRecord["reviewKind"];
  created_at: Date;
  decided_at: Date | null;
};

type TeamProof = {
  teamBackendId: string;
  workspaceProjectId: string;
  teamProjectVersion: number;
  teamMemberVersion: number;
  workItemId?: string;
  workItemVersion?: number;
  workItemTitle?: string;
};
export type ManagedTextActionTeamAuthority = (input: {
  ownerUserId: string;
  projectId: string;
  teamBackendId: string;
  workspaceProjectId: string;
  workItemId?: string;
}) => Promise<Omit<TeamProof, "teamBackendId" | "workspaceProjectId">>;
export type ManagedTextActionTeamReceipt = (input: {
  ownerUserId: string;
  projectId: string;
  teamBackendId: string;
  workspaceProjectId: string;
  name: "koed_todo_add" | "koed_todo_send" | "koed_deck_make";
  effectKey: string;
  effectNonce?: string;
  arguments: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}) => Promise<{ confirmed: boolean; effectNonceHash: string | null }>;

const canonicalTeamNonce = (value: string): Buffer | null => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value
    ? bytes
    : null;
};
const teamNonceHash = (value: string): string | null => {
  const bytes = canonicalTeamNonce(value);
  return bytes ? createHash("sha256").update(bytes).digest("hex") : null;
};
const sameHash = (left: string, right: string): boolean => {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right))
    return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};
const teamNonceAad = (row: Row, snapshot: Record<string, unknown>) => ({
  ownerUserId: row.owner_user_id,
  actionId: row.id,
  executionId: row.execution_id,
  executionGeneration: row.execution_generation,
  ...(row.action_name === "koed_deck_make"
    ? { runnerDeviceId: String(snapshot.runnerDeviceId) }
    : {}),
  argumentsDigest: row.arguments_digest,
  teamBackendId: String(snapshot.teamBackendId),
  workspaceProjectId: String(snapshot.workspaceProjectId),
  teamProjectVersion: Number(snapshot.teamProjectVersion),
  teamMemberVersion: Number(snapshot.teamMemberVersion)
});
const sameTeamNonceAad = (
  actual: unknown,
  expected: ReturnType<typeof teamNonceAad>
): boolean =>
  Boolean(
    actual &&
    typeof actual === "object" &&
    !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, value]) =>
        Object.hasOwn(actual, key) &&
        typeof (actual as Record<string, unknown>)[key] === "string" &&
        (actual as Record<string, unknown>)[key] === String(value)
    )
  );
const encryptTeamNonce = async (
  provider: EnvelopeEncryptionProvider,
  row: Row,
  snapshot: Record<string, unknown>,
  nonce: string
): Promise<EncryptedPayloadEnvelope> =>
  provider.encrypt({
    plaintext: nonce,
    scope: {
      tenantId: row.owner_user_id,
      objectClass: "managed_conversation_text_action_team_nonce"
    },
    provenance: {
      rowFamily: "managed_conversation_text_action_team_nonces",
      sourceId: row.id
    },
    ciphertextLocation:
      "managed_conversation_text_action_team_nonces.encrypted_nonce",
    aad: teamNonceAad(row, snapshot)
  });
const readTeamNonce = async (
  client: pg.PoolClient | pg.Pool,
  provider: EnvelopeEncryptionProvider,
  row: Row,
  snapshot: Record<string, unknown>
): Promise<string | null> => {
  const found = await client.query<{
    encrypted_nonce: EncryptedPayloadEnvelope;
  }>(
    `select encrypted_nonce from managed_conversation_text_action_team_nonces
      where owner_user_id=$1 and action_id=$2`,
    [row.owner_user_id, row.id]
  );
  const envelope = found.rows[0]?.encrypted_nonce;
  if (
    !envelope ||
    envelope.scope?.tenantId !== row.owner_user_id ||
    envelope.scope?.objectClass !==
      "managed_conversation_text_action_team_nonce" ||
    envelope.provenance?.rowFamily !==
      "managed_conversation_text_action_team_nonces" ||
    envelope.provenance?.sourceId !== row.id ||
    envelope.ciphertextLocation !==
      "managed_conversation_text_action_team_nonces.encrypted_nonce" ||
    !sameTeamNonceAad(envelope.aad, teamNonceAad(row, snapshot))
  )
    return null;
  const nonce = await decryptEnvelopeToUtf8(provider, envelope);
  return canonicalTeamNonce(nonce) ? nonce : null;
};

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)])
    );
  return value;
};
const digest = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
const identity = (row: Row) =>
  JSON.stringify({
    ownerUserId: row.owner_user_id,
    logicalSessionId: row.logical_session_id,
    executionId: row.execution_id,
    commandId: row.command_id,
    executionGeneration: row.execution_generation,
    providerTurnId: row.provider_turn_id,
    toolCallId: row.tool_call_id,
    name: row.action_name,
    argumentsDigest: row.arguments_digest
  });
const envelope = async (
  provider: EnvelopeEncryptionProvider,
  row: Row,
  field: "arguments" | "snapshot",
  value: unknown
): Promise<EncryptedPayloadEnvelope> =>
  provider.encrypt({
    plaintext: JSON.stringify(value),
    scope: {
      tenantId: row.owner_user_id,
      objectClass: "managed_conversation_text_action"
    },
    provenance: {
      rowFamily: "managed_conversation_text_actions",
      sourceId: row.id
    },
    ciphertextLocation: `managed_conversation_text_actions.encrypted_${field}`,
    aad: {
      ownerUserId: row.owner_user_id,
      executionId: row.execution_id,
      commandId: row.command_id,
      actionId: row.id,
      field,
      routingIdentityJson: identity(row)
    }
  });
const decrypt = async (
  provider: EnvelopeEncryptionProvider,
  row: Row,
  field: "arguments" | "snapshot"
): Promise<Record<string, unknown>> => {
  const value =
    field === "arguments" ? row.encrypted_arguments : row.encrypted_snapshot;
  if (
    value.scope?.tenantId !== row.owner_user_id ||
    value.scope?.objectClass !== "managed_conversation_text_action" ||
    value.provenance?.rowFamily !== "managed_conversation_text_actions" ||
    value.provenance?.sourceId !== row.id ||
    value.ciphertextLocation !==
      `managed_conversation_text_actions.encrypted_${field}` ||
    value.aad?.ownerUserId !== row.owner_user_id ||
    value.aad?.executionId !== row.execution_id ||
    value.aad?.commandId !== row.command_id ||
    value.aad?.actionId !== row.id ||
    value.aad?.field !== field ||
    value.aad?.routingIdentityJson !== identity(row)
  )
    throw new Error("Koed text action encrypted custody changed");
  const parsed: unknown = JSON.parse(
    await decryptEnvelopeToUtf8(provider, value)
  );
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
    throw new Error("Koed text action encrypted payload is invalid");
  return parsed as Record<string, unknown>;
};
const present = async (
  provider: EnvelopeEncryptionProvider,
  row: Row
): Promise<ManagedTextActionRecord> => {
  const args = await decrypt(provider, row, "arguments");
  if (
    digest({ name: row.action_name, arguments: args }) !== row.arguments_digest
  )
    throw new Error("Koed text action request digest changed");
  const snapshot = await decrypt(provider, row, "snapshot");
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    logicalSessionId: row.logical_session_id,
    executionId: row.execution_id,
    commandId: row.command_id,
    executionGeneration: row.execution_generation,
    providerTurnId: row.provider_turn_id,
    toolCallId: row.tool_call_id,
    name: row.action_name,
    arguments: args,
    snapshot,
    state: row.state,
    revision: row.revision,
    reviewKind: row.review_kind,
    effectKey: row.id,
    ...(row.action_name === "koed_chat_create" && row.state === "applied"
      ? { uiOutcome: "opened_composer" as const }
      : {}),
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null
  };
};
const withVerifiedNativeOutcome = async (
  pool: pg.Pool,
  action: ManagedTextActionRecord
): Promise<ManagedTextActionRecord> => {
  if (!["awaiting_review", "claimed"].includes(action.state)) return action;
  let desired: "claimed" | "applied" | "declined" | null;
  if (action.name === "koed_chat_delete") {
    const operation = await pool.query<{
      state: string;
      trashed_at: Date | null;
    }>(
      `select operation.state,session.trashed_at from chat_delete_operations operation
         join sessions session on session.id=operation.session_id
          and session.owner_user_id=operation.owner_user_id
        where operation.owner_user_id=$1 and operation.session_id=$2
          and operation.batch_id=$3`,
      [action.ownerUserId, action.snapshot.sessionId, action.effectKey]
    );
    const row = operation.rows[0];
    if (!row) return action;
    desired =
      (row.state === "complete" && row.trashed_at) || row.state === "restored"
        ? "applied"
        : row.state === "cancelled"
          ? "declined"
          : "claimed";
  } else if (action.name === "koed_project_delete") {
    const operation = await pool.query<{
      state: string;
      execution_set_hash: string;
      lifecycle: string;
    }>(
      `select operation.state,operation.execution_set_hash,project.lifecycle
         from project_delete_operations operation
         join projects project on project.id=operation.project_id
          and project.owner_user_id=operation.owner_user_id
        where operation.owner_user_id=$1 and operation.project_id=$2
          and operation.batch_id=$3`,
      [action.ownerUserId, action.snapshot.projectId, action.effectKey]
    );
    const row = operation.rows[0];
    if (!row || row.execution_set_hash !== action.snapshot.executionSetHash)
      return action;
    desired =
      (row.state === "complete" && row.lifecycle === "deleted") ||
      row.state === "restored"
        ? "applied"
        : row.state === "cancelled"
          ? "declined"
          : "claimed";
  } else return action;
  if (!desired || desired === action.state) return action;
  const updated = await pool.query<{
    state: ManagedTextActionRecord["state"];
    revision: number;
    decided_at: Date | null;
  }>(
    `update managed_conversation_text_actions
        set state=$4,revision=revision+1,updated_at=now(),
            decided_at=case when $4='declined' then now() else decided_at end
      where id=$1 and owner_user_id=$2 and state=$3 and revision=$5
      returning state,revision,decided_at`,
    [action.id, action.ownerUserId, action.state, desired, action.revision]
  );
  const changed = updated.rows[0];
  return changed
    ? {
        ...action,
        state: changed.state,
        revision: changed.revision,
        decidedAt: changed.decided_at?.toISOString() ?? null
      }
    : action;
};

/** Bind a Desktop create to the claimed action inside the effect transaction. */
export const claimedManagedTextCreateWithClient = async (
  client: pg.PoolClient,
  provider: EnvelopeEncryptionProvider | undefined,
  input: {
    ownerUserId: string;
    actionId: string;
    name:
      | "koed_project_create"
      | "koed_deck_make"
      | "koed_todo_add"
      | "koed_job_create"
      | "koed_job_pause"
      | "koed_chat_move"
      | "koed_project_move_chats";
    matches: (
      argumentsValue: Record<string, unknown>,
      snapshot: Record<string, unknown>
    ) => boolean;
  }
): Promise<boolean> => {
  if (!provider) return false;
  const found = await client.query<Row>(
    `select action.* from managed_conversation_text_actions action
       join managed_conversation_executions execution
         on execution.id=action.execution_id and execution.owner_user_id=action.owner_user_id
       join managed_conversation_commands command
         on command.id=action.command_id and command.owner_user_id=action.owner_user_id
        and command.execution_id=action.execution_id
       join managed_conversation_text_human_origins origin
         on origin.owner_user_id=command.owner_user_id
        and origin.command_id=command.id and origin.execution_id=command.execution_id
        and origin.execution_generation=command.execution_generation
        and origin.request_digest=command.request_digest
       join managed_conversation_runtime_bindings binding
         on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
       join sessions session on session.id=binding.local_session_id
         and session.owner_user_id=action.owner_user_id
         and session.logical_session_id=action.logical_session_id
      where action.id=$1 and action.owner_user_id=$2 and action.action_name=$3
        and action.state='claimed'
        and execution.execution_generation=action.execution_generation
        and execution.state in ('running','reconciling')
        and command.execution_generation=action.execution_generation
        and ((command.command_kind='start' and origin.source_kind='hq_first_message')
          or (command.command_kind='prompt' and origin.source_kind='human_prompt'
            and command.client_user_message_id is not null))
        and ((command.state='completed' and command.completed_at is not null)
          or (command.state='dispatching' and command.lease_expires_at>now()
            and execution.runner_lease_expires_at>now()))
        and session.invalidated_at is null and session.personal_deleted_at is null
        and session.trashed_at is null and session.delete_batch_id is null
        and session.forget_batch_id is null
        and (action.action_name='koed_todo_add' or action.review_kind <> 'none'
          or execution.permission_mode='full_access')
      for share of action,execution,session`,
    [input.actionId, input.ownerUserId, input.name]
  );
  const row = found.rows[0];
  if (!row || found.rows.length !== 1) return false;
  const argumentsValue = await decrypt(provider, row, "arguments");
  if (
    digest({ name: row.action_name, arguments: argumentsValue }) !==
    row.arguments_digest
  )
    return false;
  const snapshot = await decrypt(provider, row, "snapshot");
  if (row.action_name === "koed_deck_make") {
    // The earlier preparation is a read, not a reservation of the chat's
    // Project. Recheck its exact assignment while the effect transaction
    // still holds the Session and execution locks acquired above.
    const current = await client.query<{
      project_id: string | null;
      project_assignment_version: number;
    }>(
      `select case when execution.is_project_hq then execution.project_id
                     when session.project_override_at is not null
                       then session.project_override_personal_project_id::text
                     else session.automatic_personal_project_id::text end as project_id,
              session.project_assignment_version
         from managed_conversation_executions execution
         join managed_conversation_runtime_bindings binding
           on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
         join sessions session on session.id=binding.local_session_id
           and session.owner_user_id=execution.owner_user_id
        where execution.id=$1 and execution.owner_user_id=$2`,
      [row.execution_id, input.ownerUserId]
    );
    if (
      current.rows[0]?.project_id !== snapshot.projectId ||
      current.rows[0]?.project_assignment_version !==
        snapshot.conversationProjectAssignmentVersion
    )
      return false;
  }
  return input.matches(argumentsValue, snapshot);
};

/** Validate one linked-source move against the claimed immutable text action.
 * The journal calls this inside its own placement transaction. No Team/network
 * operation occurs while these local locks are held. */
export const claimedManagedTextMoveWithClient = async (
  client: pg.PoolClient,
  provider: EnvelopeEncryptionProvider | undefined,
  input: {
    ownerUserId: string;
    actionId: string;
    sessionId: string;
    sourceProjectId: string;
    targetProjectId: string | null;
    expectedAssignmentVersion: number;
    sourceProjectVersion: number;
    sourceWorkspaceProjectId: string;
    sourceTeamBackendId: string;
    targetProjectVersion: number | null;
  }
): Promise<boolean> => {
  const matches = (
    args: Record<string, unknown>,
    snapshot: Record<string, unknown>
  ) => {
    const requestedTarget = args.projectId ?? null;
    const chat =
      args.sessionId === input.sessionId
        ? snapshot
        : Array.isArray(args.sessionIds) &&
            args.sessionIds.includes(input.sessionId) &&
            Array.isArray(snapshot.chats)
          ? (snapshot.chats as unknown[]).find(
              (entry) =>
                entry &&
                typeof entry === "object" &&
                (entry as Record<string, unknown>).sessionId === input.sessionId
            )
          : null;
    if (!chat || typeof chat !== "object") return false;
    const current = chat as Record<string, unknown>;
    return (
      requestedTarget === input.targetProjectId &&
      current.currentProjectId === input.sourceProjectId &&
      current.sessionProjectVersion === input.expectedAssignmentVersion &&
      current.sourceProjectVersion === input.sourceProjectVersion &&
      current.sourceWorkspaceProjectId === input.sourceWorkspaceProjectId &&
      current.sourceTeamBackendId === input.sourceTeamBackendId &&
      (input.targetProjectId === null ||
        snapshot.projectVersion === input.targetProjectVersion)
    );
  };
  return (
    (await claimedManagedTextCreateWithClient(client, provider, {
      ownerUserId: input.ownerUserId,
      actionId: input.actionId,
      name: "koed_chat_move",
      matches
    })) ||
    (await claimedManagedTextCreateWithClient(client, provider, {
      ownerUserId: input.ownerUserId,
      actionId: input.actionId,
      name: "koed_project_move_chats",
      matches
    }))
  );
};

const activeProject = async (
  client: pg.PoolClient,
  ownerUserId: string,
  projectId: string
) => {
  const found = await client.query<{
    id: string;
    name: string;
    version: number;
    team_backend_id: string | null;
    workspace_project_id: string | null;
  }>(
    `select id,name,version,team_backend_id,workspace_project_id from projects project
      where id=$1 and owner_user_id=$2 and lifecycle='active'
        and deletion_phase is null
        and not exists (
          select 1 from personal_workspace_project_share_attempts attempt
           where attempt.personal_project_id=project.id and attempt.state='pending'
        ) for share`,
    [projectId, ownerUserId]
  );
  return found.rows[0] ?? null;
};
const activeChat = async (
  client: pg.PoolClient,
  ownerUserId: string,
  sessionId: string
) => {
  const found = await client.query<{
    id: string;
    project_assignment_version: number;
    project_override_personal_project_id: string | null;
    automatic_personal_project_id: string | null;
    project_override_at: Date | null;
    title: string;
  }>(
    `select id,project_assignment_version,project_override_personal_project_id,
            automatic_personal_project_id,project_override_at,
            coalesce(nullif(btrim(metadata->>'threadName'),''),'Conversation') as title
       from sessions where id=$1 and owner_user_id=$2 and visibility='personal'
        and invalidated_at is null and personal_deleted_at is null
        and trashed_at is null and delete_batch_id is null
        and forget_batch_id is null for share`,
    [sessionId, ownerUserId]
  );
  const row = found.rows[0];
  return row
    ? {
        sessionId: row.id,
        chatTitle: row.title,
        sessionProjectVersion: row.project_assignment_version,
        currentProjectId: row.project_override_at
          ? row.project_override_personal_project_id
          : row.automatic_personal_project_id
      }
    : null;
};
const sourceProjectLink = async (
  client: pg.PoolClient,
  ownerUserId: string,
  projectId: string | null
) => {
  if (!projectId) return null;
  const found = await client.query<{
    version: number;
    team_backend_id: string | null;
    workspace_project_id: string | null;
  }>(
    `select version,team_backend_id,workspace_project_id from projects
      where id=$1 and owner_user_id=$2 and lifecycle='active'
        and deletion_phase is null for share`,
    [projectId, ownerUserId]
  );
  const row = found.rows[0];
  return row?.team_backend_id && row.workspace_project_id
    ? {
        sourceProjectVersion: row.version,
        sourceTeamBackendId: row.team_backend_id,
        sourceWorkspaceProjectId: row.workspace_project_id
      }
    : null;
};
const targetSnapshot = async (
  client: pg.PoolClient,
  ownerUserId: string,
  name: KoedTextActionName,
  args: Record<string, unknown>,
  teamProof: TeamProof | null = null,
  origin?: { logicalSessionId: string; executionId: string }
): Promise<Record<string, unknown> | null> => {
  type JobSessionRow = {
    id: string;
    project_id: string | null;
    project_assignment_version: number;
  };
  type JobTargetRow = {
    id: string;
    project_id: string | null;
    version: number;
    paused: boolean;
    agent_id: string;
    conversation_session_id: string;
    project_assignment_version: number;
    conversation_project_id: string | null;
  };
  let jobSession: JobSessionRow | null = null;
  let jobTarget: JobTargetRow | null = null;
  if (name === "koed_job_create") {
    if (!origin) return null;
    jobSession =
      (
        await client.query<JobSessionRow>(
          `select sessions.id,sessions.project_assignment_version,
        (case when sessions.project_override_at is not null then sessions.project_override_personal_project_id
          else sessions.automatic_personal_project_id end) as project_id
       from managed_conversation_runtime_bindings binding
       join sessions on sessions.id=binding.local_session_id
         and sessions.owner_user_id=binding.owner_user_id
       where binding.execution_id=$3 and binding.owner_user_id=$2
         and sessions.logical_session_id=$1
         and sessions.visibility='personal' and sessions.invalidated_at is null
         and sessions.personal_deleted_at is null and sessions.trashed_at is null
         and sessions.delete_batch_id is null and sessions.forget_batch_id is null
       for share of sessions,binding`,
          [origin.logicalSessionId, ownerUserId, origin.executionId]
        )
      ).rows[0] ?? null;
    if (!jobSession) return null;
  }
  if (name === "koed_job_pause") {
    const matching = await client.query<JobTargetRow>(
      `select job.id,job.project_id,job.version,job.paused,job.agent_id,
         job.conversation_session_id,session.project_assignment_version,
         (case when session.project_override_at is not null
           then session.project_override_personal_project_id
           else session.automatic_personal_project_id end) as conversation_project_id
       from scheduled_jobs job join sessions session
         on session.id=job.conversation_session_id and session.owner_user_id=job.owner_user_id
       where job.owner_user_id=$1 and job.title=$2
         and session.visibility='personal' and session.invalidated_at is null
         and session.personal_deleted_at is null and session.trashed_at is null
         and session.delete_batch_id is null and session.forget_batch_id is null
       for share of job,session`,
      [ownerUserId, args.title]
    );
    if (matching.rows.length !== 1) return null;
    jobTarget = matching.rows[0]!;
    if (jobTarget.paused === args.paused) return null;
    if (jobTarget.conversation_project_id !== jobTarget.project_id) return null;
  }
  const projectId =
    jobSession?.project_id ??
    jobTarget?.project_id ??
    (typeof args.projectId === "string" ? args.projectId : null);
  const project = projectId
    ? await activeProject(client, ownerUserId, projectId)
    : null;
  if (projectId && !project) return null;
  if (
    project?.workspace_project_id &&
    name !== "koed_chat_create" &&
    name !== "koed_hq_open"
  ) {
    if (
      !teamProof ||
      project.team_backend_id !== teamProof.teamBackendId ||
      project.workspace_project_id !== teamProof.workspaceProjectId ||
      ![
        "koed_todo_add",
        "koed_todo_send",
        "koed_job_create",
        "koed_job_pause",
        "koed_deck_make"
      ].includes(name)
    )
      return null;
  } else if (teamProof) return null;
  const base = project
    ? { projectId, projectName: project.name, projectVersion: project.version }
    : {};
  const team = teamProof ? { ...teamProof } : {};
  if (name === "koed_deck_make") {
    if (!origin || typeof args.projectId !== "string" || !project) return null;
    // A Deck may be generated only for this human-started Conversation's
    // current Project. A model-supplied Project ID is never enough.
    const current = (
      await client.query<{
        project_id: string | null;
        project_assignment_version: number;
        ai_client_instance_id: string;
        provider: string;
        permission_mode: string;
        model: string;
        runner_device_id: string;
      }>(
        `select (case when execution.is_project_hq then execution.project_id
                  when session.project_override_at is not null
                    then session.project_override_personal_project_id::text
                  else session.automatic_personal_project_id::text end) as project_id,
                session.project_assignment_version,execution.ai_client_instance_id,
                execution.provider,execution.permission_mode,execution.model,
                execution.runner_device_id
           from managed_conversation_executions execution
           join managed_conversation_runtime_bindings binding
             on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
           join sessions session on session.id=binding.local_session_id
             and session.owner_user_id=execution.owner_user_id
             and session.logical_session_id=execution.logical_session_id
          where execution.id=$1 and execution.owner_user_id=$2
            and execution.logical_session_id=$3
            and session.visibility='personal' and session.invalidated_at is null
            and session.personal_deleted_at is null and session.trashed_at is null
            and session.delete_batch_id is null and session.forget_batch_id is null
          for share of execution,binding,session`,
        [origin.executionId, ownerUserId, origin.logicalSessionId]
      )
    ).rows[0];
    if (
      !current ||
      current.project_id !== args.projectId ||
      typeof current.runner_device_id !== "string" ||
      !current.runner_device_id
    )
      return null;
    const agents = await client.query<{
      id: string;
      name: string;
      is_chief_of_staff: boolean;
    }>(
      `select agent.id,agent.name,agent.is_chief_of_staff from agents agent
         join ai_client_instances instance on instance.owner_user_id=agent.owner_user_id
           and instance.instance_id=agent.ai_client_instance_id
        where agent.owner_user_id=$1 and agent.ai_client_instance_id=$2
          and instance.driver_id=$3 and instance.enabled=true
          and agent.default_permission_mode=$4
          and (agent.default_model is null or agent.default_model=$5)
        order by agent.is_chief_of_staff desc,agent.id`,
      [
        ownerUserId,
        current.ai_client_instance_id,
        current.provider,
        current.permission_mode,
        current.model
      ]
    );
    const agent =
      agents.rows.length === 1
        ? agents.rows[0]
        : agents.rows.filter((candidate) => candidate.is_chief_of_staff)
              .length === 1
          ? agents.rows.find((candidate) => candidate.is_chief_of_staff)
          : null;
    if (!agent) return null;
    return {
      ...base,
      ...team,
      conversationProjectAssignmentVersion: current.project_assignment_version,
      agentId: agent.id,
      agentName: agent.name,
      runnerDeviceId: current.runner_device_id
    };
  }
  if (
    name === "koed_project_create" ||
    name === "koed_settings_open" ||
    name === "koed_settings_set_theme"
  )
    return {};
  if (name === "koed_job_create") {
    if (!jobSession || !origin) return null;
    const execution = (
      await client.query<{
        ai_client_instance_id: string;
        provider: string;
        permission_mode: string;
        model: string;
      }>(
        `select ai_client_instance_id,provider,permission_mode,model from managed_conversation_executions
       where id=$1 and owner_user_id=$2 and logical_session_id=$3 for share`,
        [origin.executionId, ownerUserId, origin.logicalSessionId]
      )
    ).rows[0];
    if (!execution) return null;
    const agents = await client.query<{
      id: string;
      name: string;
      is_chief_of_staff: boolean;
    }>(
      `select agent.id,agent.name,agent.is_chief_of_staff from agents agent
       join ai_client_instances instance on instance.owner_user_id=agent.owner_user_id
         and instance.instance_id=agent.ai_client_instance_id
       where agent.owner_user_id=$1 and agent.ai_client_instance_id=$2
         and instance.driver_id=$3 and instance.enabled=true
         and agent.default_permission_mode=$4
         and (agent.default_model is null or agent.default_model=$5)
       order by agent.is_chief_of_staff desc,agent.id`,
      [
        ownerUserId,
        execution.ai_client_instance_id,
        execution.provider,
        execution.permission_mode,
        execution.model
      ]
    );
    const agent =
      agents.rows.length === 1
        ? agents.rows[0]
        : agents.rows.filter((candidate) => candidate.is_chief_of_staff)
              .length === 1
          ? agents.rows.find((candidate) => candidate.is_chief_of_staff)
          : null;
    if (!agent) return null;
    return {
      ...base,
      ...team,
      agentId: agent.id,
      agentName: agent.name,
      conversationSessionId: jobSession.id,
      conversationProjectAssignmentVersion:
        jobSession.project_assignment_version
    };
  }
  if (name === "koed_job_pause") {
    if (!jobTarget) return null;
    return {
      ...base,
      ...team,
      jobId: jobTarget.id,
      jobVersion: jobTarget.version,
      paused: jobTarget.paused,
      agentId: jobTarget.agent_id,
      conversationSessionId: jobTarget.conversation_session_id,
      conversationProjectAssignmentVersion: jobTarget.project_assignment_version
    };
  }
  // chat.new/project.chat.new are UI operations. The effect is opening a
  // composer with the selected Project, not persisting a Conversation.
  if (name === "koed_chat_create") return base;
  if (name === "koed_project_delete") {
    const executions = await client.query<{
      id: string;
      execution_generation: number;
      state: string;
      state_version: number;
    }>(
      `select execution.id,execution.execution_generation,execution.state,
              execution.state_version
         from managed_conversation_executions execution
        where execution.owner_user_id=$1
          and ((execution.is_project_hq and execution.project_id=$2::text)
            or (not execution.is_project_hq and exists (
              select 1 from project_local_contexts context
               where context.owner_user_id=execution.owner_user_id
                 and context.device_id=execution.runner_device_id
                 and context.local_project_id=execution.project_id
                 and context.project_id=$2::uuid
                 and context.association_state='resolved'
            )))
          and execution.state in ('starting','running','reconciling',
            'quiesce_requested','quiesced','stopping') order by execution.id`,
      [ownerUserId, projectId]
    );
    const activeExecutions = executions.rows.map((row) => ({
      id: row.id,
      executionGeneration: row.execution_generation,
      state: row.state,
      stateVersion: row.state_version
    }));
    return {
      ...base,
      executionSetHash: createHash("sha256")
        .update(JSON.stringify(activeExecutions))
        .digest("hex"),
      activeExecutionCount: activeExecutions.length
    };
  }
  if (name === "koed_hq_open" || name === "koed_todo_add")
    return { ...base, ...team };
  if (name === "koed_todo_send") {
    const agentName =
      (
        await client.query<{ name: string }>(
          `select name from agents where id=$1 and owner_user_id=$2`,
          [args.agentId, ownerUserId]
        )
      ).rows[0]?.name ?? null;
    if (teamProof)
      return teamProof.workItemId === args.workItemId &&
        teamProof.workItemVersion
        ? { ...base, ...team, agentName }
        : null;
    const item = await client.query<{
      version: number;
      status: string;
      title: string;
    }>(
      `select version,status,title from project_work_items where owner_user_id=$1
         and project_id=$2 and id=$3 and deleted_at is null for share`,
      [ownerUserId, projectId, args.workItemId]
    );
    if (!item.rows[0] || !["todo", "blocked"].includes(item.rows[0].status))
      return null;
    return {
      ...base,
      workItemId: args.workItemId,
      workItemVersion: item.rows[0].version,
      workItemTitle: item.rows[0].title,
      agentName
    };
  }
  if (name === "koed_chat_delete") {
    const session = await client.query<{
      project_assignment_version: number;
      title: string;
    }>(
      `select project_assignment_version,
        coalesce(nullif(btrim(metadata->>'threadName'),''),'Conversation') as title
        from sessions where id=$1
         and owner_user_id=$2 and visibility='personal'
         and invalidated_at is null and personal_deleted_at is null
         and trashed_at is null and delete_batch_id is null
         and forget_batch_id is null for share`,
      [args.sessionId, ownerUserId]
    );
    if (!session.rows[0]) return null;
    return {
      sessionId: args.sessionId,
      sessionProjectVersion: session.rows[0].project_assignment_version,
      chatTitle: session.rows[0].title
    };
  }
  if (name === "koed_chat_move") {
    const chat = await activeChat(client, ownerUserId, String(args.sessionId));
    if (!chat || chat.currentProjectId === projectId) return null;
    const source = await sourceProjectLink(
      client,
      ownerUserId,
      chat.currentProjectId
    );
    const sourceName = chat.currentProjectId
      ? ((await activeProject(client, ownerUserId, chat.currentProjectId))
          ?.name ?? null)
      : null;
    return {
      ...base,
      ...chat,
      sourceProjectName: sourceName,
      ...(source ?? {})
    };
  }
  if (name === "koed_project_move_chats") {
    const chats = [];
    for (const sessionId of args.sessionIds as string[]) {
      const chat = await activeChat(client, ownerUserId, sessionId);
      if (!chat || chat.currentProjectId === projectId) return null;
      const source = await sourceProjectLink(
        client,
        ownerUserId,
        chat.currentProjectId
      );
      const sourceName = chat.currentProjectId
        ? ((await activeProject(client, ownerUserId, chat.currentProjectId))
            ?.name ?? null)
        : null;
      chats.push({ ...chat, sourceProjectName: sourceName, ...(source ?? {}) });
    }
    return { ...base, chats };
  }
  return null;
};

/**
 * Owner-private ledger. Schema is the additive HQ504 migration slot 0073.
 * Proposal authority comes from a current leased command AND the immutable
 * server-created Human-origin receipt, never from a tool argument or a kind.
 */
export const createManagedTextActionRepository = (
  pool: pg.Pool,
  encryptionProvider: EnvelopeEncryptionProvider,
  options: {
    teamAuthority?: ManagedTextActionTeamAuthority;
    teamReceipt?: ManagedTextActionTeamReceipt;
  } = {}
): ManagedTextActionRepository => {
  const preflightTeam = async (
    ownerUserId: string,
    name: KoedTextActionName,
    args: Record<string, unknown>,
    projectOverride?: string | null
  ): Promise<TeamProof | null> => {
    if (
      ![
        "koed_todo_add",
        "koed_todo_send",
        "koed_job_create",
        "koed_job_pause",
        "koed_deck_make"
      ].includes(name)
    )
      return null;
    const projectId = projectOverride ?? args.projectId;
    if (typeof projectId !== "string") return null;
    const row = (
      await pool.query<{
        team_backend_id: string | null;
        workspace_project_id: string | null;
      }>(
        `select team_backend_id,workspace_project_id from projects
         where id=$1 and owner_user_id=$2 and lifecycle='active'`,
        [projectId, ownerUserId]
      )
    ).rows[0];
    if (!row?.team_backend_id || !row.workspace_project_id) return null;
    if (!options.teamAuthority) return null;
    try {
      const proof = await options.teamAuthority({
        ownerUserId,
        projectId,
        teamBackendId: row.team_backend_id,
        workspaceProjectId: row.workspace_project_id,
        ...(name === "koed_todo_send"
          ? { workItemId: String(args.workItemId) }
          : {})
      });
      return {
        teamBackendId: row.team_backend_id,
        workspaceProjectId: row.workspace_project_id,
        ...proof
      };
    } catch {
      return null;
    }
  };
  return {
    async enqueueManagedTextAction(actor, input) {
      const args = parseKoedTextActionArguments(input.name, input.arguments);
      const argsHash = digest({ name: input.name, arguments: args });
      let jobProject: string | null | undefined;
      if (input.name === "koed_job_create") {
        const origin = await pool.query<{ project_id: string | null }>(
          `select (case when session.project_override_at is not null then session.project_override_personal_project_id
            else session.automatic_personal_project_id end) as project_id
           from managed_conversation_commands command
           join managed_conversation_executions execution on execution.id=command.execution_id
             and execution.owner_user_id=command.owner_user_id
           join managed_conversation_runtime_bindings binding
             on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
           join sessions session on session.id=binding.local_session_id
             and session.owner_user_id=execution.owner_user_id
             and session.logical_session_id=execution.logical_session_id
           where command.owner_user_id=$1 and command.id=$2 and execution.id=$3`,
          [actor.userId, input.commandId, input.executionId]
        );
        jobProject =
          origin.rows.length === 1 ? origin.rows[0]!.project_id : undefined;
      } else if (input.name === "koed_job_pause") {
        const job = await pool.query<{ project_id: string | null }>(
          "select project_id from scheduled_jobs where owner_user_id=$1 and title=$2",
          [actor.userId, args.title]
        );
        jobProject =
          job.rows.length === 1 ? job.rows[0]!.project_id : undefined;
      }
      const teamProof = await preflightTeam(
        actor.userId,
        input.name,
        args,
        jobProject
      );
      const client = await pool.connect();
      try {
        await client.query("begin");
        const authority = await client.query<{
          logical_session_id: string;
          permission_mode: string;
        }>(
          `select execution.logical_session_id,execution.permission_mode
             from managed_conversation_commands command
             join managed_conversation_executions execution
               on execution.id=command.execution_id
              and execution.owner_user_id=command.owner_user_id
             join managed_conversation_runtime_bindings binding
               on binding.execution_id=execution.id
              and binding.owner_user_id=execution.owner_user_id
              and binding.execution_generation=command.execution_generation
             join sessions session on session.id=binding.local_session_id
              and session.owner_user_id=execution.owner_user_id
              and session.logical_session_id=execution.logical_session_id
             join managed_conversation_text_human_origins origin
               on origin.owner_user_id=command.owner_user_id
              and origin.command_id=command.id
              and origin.execution_id=command.execution_id
              and origin.execution_generation=command.execution_generation
              and origin.request_digest=command.request_digest
            where command.owner_user_id=$1 and command.id=$2
              and command.execution_id=$3 and command.execution_generation=$4
              and ((command.command_kind='start' and origin.source_kind='hq_first_message')
                or (command.command_kind='prompt' and origin.source_kind='human_prompt'
                  and command.client_user_message_id is not null))
              and command.state='dispatching' and command.lease_token=$5
              and command.lease_expires_at>now()
              and execution.execution_generation=$4
              and execution.state in ('running','reconciling')
              and execution.runner_lease_expires_at>now()
              and session.invalidated_at is null and session.personal_deleted_at is null
              and session.trashed_at is null and session.delete_batch_id is null
              and session.forget_batch_id is null
              and not exists (
                select 1 from scheduled_job_attempt_dispatch_bindings job
                 where job.owner_user_id=command.owner_user_id
                   and job.managed_command_id=command.id
              )
            for share of command,execution,session`,
          [
            actor.userId,
            input.commandId,
            input.executionId,
            input.executionGeneration,
            input.leaseToken
          ]
        );
        const current = authority.rows[0];
        if (!current) {
          await client.query("rollback");
          return null;
        }
        const snapshot = await targetSnapshot(
          client,
          actor.userId,
          input.name,
          args,
          teamProof,
          {
            logicalSessionId: current.logical_session_id,
            executionId: input.executionId
          }
        );
        const id = randomUUID();
        const initial: Row = {
          id,
          owner_user_id: actor.userId,
          logical_session_id: current.logical_session_id,
          execution_id: input.executionId,
          command_id: input.commandId,
          execution_generation: input.executionGeneration,
          provider_turn_id: input.providerTurnId,
          tool_call_id: input.toolCallId,
          action_name: input.name,
          arguments_digest: argsHash,
          encrypted_arguments: null as never,
          encrypted_snapshot: null as never,
          state: snapshot ? "awaiting_review" : "unavailable",
          revision: 1,
          review_kind:
            input.name === "koed_project_delete" ||
            input.name === "koed_chat_delete"
              ? "native"
              : input.name === "koed_project_create" ||
                  input.name === "koed_deck_make" ||
                  input.name === "koed_job_create" ||
                  input.name === "koed_job_pause" ||
                  input.name === "koed_project_move_chats" ||
                  input.name === "koed_chat_move"
                ? current.permission_mode === "full_access"
                  ? "none"
                  : "ask_first"
                : "none",
          created_at: new Date(),
          decided_at: null
        };
        if (snapshot && initial.review_kind === "none") initial.state = "ready";
        initial.encrypted_arguments = await envelope(
          encryptionProvider,
          initial,
          "arguments",
          args
        );
        initial.encrypted_snapshot = await envelope(
          encryptionProvider,
          initial,
          "snapshot",
          snapshot ?? {}
        );
        const inserted = await client.query<Row>(
          `insert into managed_conversation_text_actions
             (id,owner_user_id,logical_session_id,execution_id,command_id,
              execution_generation,provider_turn_id,tool_call_id,action_name,
              arguments_digest,encrypted_arguments,encrypted_snapshot,
              state,review_kind,native_target_id,native_execution_set_hash)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16)
            on conflict on constraint managed_text_actions_tool_call_unique
              do nothing returning *`,
          [
            id,
            actor.userId,
            initial.logical_session_id,
            input.executionId,
            input.commandId,
            input.executionGeneration,
            input.providerTurnId,
            input.toolCallId,
            input.name,
            argsHash,
            JSON.stringify(initial.encrypted_arguments),
            JSON.stringify(initial.encrypted_snapshot),
            initial.state,
            initial.review_kind,
            initial.review_kind === "native"
              ? (args.projectId ?? args.sessionId)
              : null,
            input.name === "koed_project_delete"
              ? (snapshot?.executionSetHash ?? null)
              : null
          ]
        );
        if (
          inserted.rows[0] &&
          snapshot &&
          (input.name === "koed_chat_move" ||
            input.name === "koed_project_move_chats")
        ) {
          const chats =
            input.name === "koed_chat_move"
              ? [snapshot]
              : (snapshot.chats as Record<string, unknown>[]);
          for (const chat of chats) {
            await client.query(
              `insert into managed_conversation_text_action_move_authorities
                 (action_id,owner_user_id,session_id,source_project_id,
                  target_project_id,expected_assignment_version,target_project_version)
               values($1,$2,$3,$4,$5,$6,$7)`,
              [
                id,
                actor.userId,
                chat.sessionId,
                chat.currentProjectId ?? null,
                args.projectId ?? null,
                chat.sessionProjectVersion,
                snapshot.projectVersion ?? null
              ]
            );
          }
        }
        if (inserted.rows[0] && snapshot && input.name === "koed_todo_send") {
          await client.query(
            `insert into managed_conversation_text_action_dispatch_authorities
               (action_id,owner_user_id,project_id,work_item_id,agent_id,
                work_item_version,team_backend_id,workspace_project_id,
                team_project_version,team_member_version)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              id,
              actor.userId,
              args.projectId,
              args.workItemId,
              args.agentId,
              snapshot.workItemVersion,
              snapshot.teamBackendId ?? null,
              snapshot.workspaceProjectId ?? null,
              snapshot.teamProjectVersion ?? null,
              snapshot.teamMemberVersion ?? null
            ]
          );
        }
        const row =
          inserted.rows[0] ??
          (
            await client.query<Row>(
              `select * from managed_conversation_text_actions where owner_user_id=$1
             and command_id=$2 and provider_turn_id=$3 and tool_call_id=$4`,
              [
                actor.userId,
                input.commandId,
                input.providerTurnId,
                input.toolCallId
              ]
            )
          ).rows[0];
        if (
          !row ||
          row.action_name !== input.name ||
          row.arguments_digest !== argsHash
        ) {
          await client.query("rollback");
          return null;
        }
        await client.query("commit");
        return present(encryptionProvider, row);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async listManagedTextActions(actor, executionId) {
      const found = await pool.query<Row>(
        `select action.* from managed_conversation_text_actions action
          join managed_conversation_executions execution
            on execution.id=action.execution_id
           and execution.owner_user_id=action.owner_user_id
          join managed_conversation_runtime_bindings binding
            on binding.execution_id=execution.id
           and binding.owner_user_id=execution.owner_user_id
          join sessions session on session.id=binding.local_session_id
           and session.owner_user_id=action.owner_user_id
           and session.logical_session_id=action.logical_session_id
         where action.owner_user_id=$1 and action.execution_id=$2
           and session.invalidated_at is null and session.personal_deleted_at is null
           and session.trashed_at is null and session.delete_batch_id is null
           and session.forget_batch_id is null
         order by action.created_at desc,action.id desc limit 100`,
        [actor.userId, executionId]
      );
      return Promise.all(
        found.rows.map(async (row) =>
          withVerifiedNativeOutcome(
            pool,
            await present(encryptionProvider, row)
          )
        )
      );
    },
    async reconcileManagedTextAction(actor, input) {
      const found = await pool.query<Row>(
        `select action.* from managed_conversation_text_actions action
          join managed_conversation_executions execution
            on execution.id=action.execution_id and execution.owner_user_id=action.owner_user_id
          join managed_conversation_runtime_bindings binding
            on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
          join sessions session on session.id=binding.local_session_id
            and session.owner_user_id=action.owner_user_id
            and session.logical_session_id=action.logical_session_id
         where action.owner_user_id=$1 and action.execution_id=$2 and action.id=$3
           and session.invalidated_at is null and session.personal_deleted_at is null
           and session.trashed_at is null and session.delete_batch_id is null
           and session.forget_batch_id is null`,
        [actor.userId, input.executionId, input.actionId]
      );
      return found.rows[0]
        ? withVerifiedNativeOutcome(
            pool,
            await present(encryptionProvider, found.rows[0])
          )
        : null;
    },
    async decideManagedTextAction(actor, input) {
      const changed = await pool.query<Row>(
        `update managed_conversation_text_actions action
            set state=case when $5='approve' then 'ready' else 'declined' end,
                revision=revision+1,decided_at=now(),updated_at=now()
          where action.owner_user_id=$1 and action.execution_id=$2 and action.id=$3
            and action.revision=$4 and action.state='awaiting_review'
            and action.review_kind='ask_first'
            and exists (
              select 1 from managed_conversation_executions execution
               join managed_conversation_commands command
                 on command.id=action.command_id and command.owner_user_id=action.owner_user_id
                and command.execution_id=execution.id
               join managed_conversation_text_human_origins origin
                 on origin.owner_user_id=command.owner_user_id
                and origin.command_id=command.id
                and origin.execution_id=command.execution_id
                and origin.execution_generation=command.execution_generation
                and origin.request_digest=command.request_digest
               join managed_conversation_runtime_bindings binding
                 on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
               join sessions session on session.id=binding.local_session_id
                 and session.owner_user_id=execution.owner_user_id
                 and session.logical_session_id=execution.logical_session_id
               where execution.id=action.execution_id
                 and execution.owner_user_id=action.owner_user_id
                 and execution.execution_generation=action.execution_generation
                 and command.execution_generation=action.execution_generation
                 and ((command.command_kind='start' and origin.source_kind='hq_first_message')
                   or (command.command_kind='prompt' and origin.source_kind='human_prompt'
                     and command.client_user_message_id is not null))
                 and ((command.state='completed' and command.completed_at is not null)
                   or (command.state='dispatching' and command.lease_expires_at>now()
                     and execution.runner_lease_expires_at>now()))
                 and session.invalidated_at is null and session.personal_deleted_at is null
                 and session.trashed_at is null and session.delete_batch_id is null
                 and session.forget_batch_id is null
            ) returning action.*`,
        [
          actor.userId,
          input.executionId,
          input.actionId,
          input.expectedRevision,
          input.decision
        ]
      );
      return changed.rows[0]
        ? present(encryptionProvider, changed.rows[0])
        : null;
    },
    async claimManagedTextAction(actor, input) {
      const preliminary = (
        await pool.query<Row>(
          `select * from managed_conversation_text_actions where owner_user_id=$1
           and execution_id=$2 and id=$3 and state='ready' and revision=$4`,
          [
            actor.userId,
            input.executionId,
            input.actionId,
            input.expectedRevision
          ]
        )
      ).rows[0];
      if (!preliminary) return null;
      const preliminaryArgs = await decrypt(
        encryptionProvider,
        preliminary,
        "arguments"
      );
      const preliminarySnapshot = await decrypt(
        encryptionProvider,
        preliminary,
        "snapshot"
      );
      const teamProof = await preflightTeam(
        actor.userId,
        preliminary.action_name,
        preliminaryArgs,
        typeof preliminarySnapshot.projectId === "string"
          ? preliminarySnapshot.projectId
          : null
      );
      const client = await pool.connect();
      try {
        await client.query("begin");
        const found = await client.query<Row & { permission_mode: string }>(
          `select action.*,execution.permission_mode
             from managed_conversation_text_actions action
            join managed_conversation_executions execution
              on execution.id=action.execution_id and execution.owner_user_id=action.owner_user_id
            join managed_conversation_commands command
              on command.id=action.command_id and command.owner_user_id=action.owner_user_id
             and command.execution_id=action.execution_id
            join managed_conversation_text_human_origins origin
              on origin.owner_user_id=command.owner_user_id
             and origin.command_id=command.id
             and origin.execution_id=command.execution_id
             and origin.execution_generation=command.execution_generation
             and origin.request_digest=command.request_digest
            join managed_conversation_runtime_bindings binding
              on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
            join sessions session on session.id=binding.local_session_id
              and session.owner_user_id=action.owner_user_id
              and session.logical_session_id=action.logical_session_id
           where action.owner_user_id=$1 and action.execution_id=$2 and action.id=$3
             and action.revision=$4 and action.state='ready'
             and execution.execution_generation=action.execution_generation
             and execution.state in ('running','reconciling')
             and command.execution_generation=action.execution_generation
             and ((command.command_kind='start' and origin.source_kind='hq_first_message')
               or (command.command_kind='prompt' and origin.source_kind='human_prompt'
                 and command.client_user_message_id is not null))
             and ((command.state='completed' and command.completed_at is not null)
               or (command.state='dispatching' and command.lease_expires_at>now()
                 and execution.runner_lease_expires_at>now()))
             and session.invalidated_at is null and session.personal_deleted_at is null
             and session.trashed_at is null and session.delete_batch_id is null
             and session.forget_batch_id is null
           for update of action,execution,session`,
          [
            actor.userId,
            input.executionId,
            input.actionId,
            input.expectedRevision
          ]
        );
        const row = found.rows[0];
        if (!row) {
          await client.query("rollback");
          return null;
        }
        if (
          row.review_kind === "none" &&
          [
            "koed_project_create",
            "koed_deck_make",
            "koed_job_create",
            "koed_job_pause",
            "koed_chat_move",
            "koed_project_move_chats"
          ].includes(row.action_name) &&
          row.permission_mode !== "full_access"
        ) {
          await client.query("rollback");
          return null;
        }
        const args = await decrypt(encryptionProvider, row, "arguments");
        const pinned = await decrypt(encryptionProvider, row, "snapshot");
        const fresh = await targetSnapshot(
          client,
          actor.userId,
          row.action_name,
          args,
          teamProof,
          {
            logicalSessionId: row.logical_session_id,
            executionId: row.execution_id
          }
        );
        if (!fresh || digest(fresh) !== digest(pinned)) {
          await client.query("rollback");
          return null;
        }
        const changed = await client.query<Row>(
          `update managed_conversation_text_actions set state='claimed',
             revision=revision+1,updated_at=now()
           where id=$1 and owner_user_id=$2 and state='ready' and revision=$3
           returning *`,
          [row.id, actor.userId, row.revision]
        );
        if (
          changed.rows[0] &&
          row.action_name === "koed_todo_add" &&
          typeof pinned.workspaceProjectId === "string"
        ) {
          const nonce = randomBytes(32).toString("base64url");
          const encrypted = await encryptTeamNonce(
            encryptionProvider,
            changed.rows[0],
            pinned,
            nonce
          );
          await client.query(
            `insert into managed_conversation_text_action_team_nonces
              (action_id,owner_user_id,encrypted_nonce)
             values($1,$2,$3::jsonb)`,
            [row.id, actor.userId, JSON.stringify(encrypted)]
          );
        }
        await client.query("commit");
        return changed.rows[0]
          ? present(encryptionProvider, changed.rows[0])
          : null;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async completeManagedTextAction(actor, input) {
      const preliminary = (
        await pool.query<Row>(
          `select * from managed_conversation_text_actions where owner_user_id=$1
           and execution_id=$2 and id=$3 and state='claimed' and revision=$4`,
          [
            actor.userId,
            input.executionId,
            input.actionId,
            input.expectedRevision
          ]
        )
      ).rows[0];
      if (!preliminary) {
        const applied = (
          await pool.query<Row>(
            `select * from managed_conversation_text_actions
           where owner_user_id=$1 and execution_id=$2 and id=$3
             and state='applied' and revision=$4
             and action_name in ('koed_job_create','koed_job_pause','koed_deck_make')`,
            [
              actor.userId,
              input.executionId,
              input.actionId,
              input.expectedRevision + 1
            ]
          )
        ).rows[0];
        return applied ? present(encryptionProvider, applied) : null;
      }
      const preliminarySnapshot = await decrypt(
        encryptionProvider,
        preliminary,
        "snapshot"
      );
      const teamReceipt =
        typeof preliminarySnapshot.projectId === "string" &&
        typeof preliminarySnapshot.teamBackendId === "string" &&
        typeof preliminarySnapshot.workspaceProjectId === "string" &&
        (preliminary.action_name === "koed_todo_add" ||
          preliminary.action_name === "koed_todo_send" ||
          preliminary.action_name === "koed_deck_make") &&
        options.teamReceipt
          ? await options
              .teamReceipt({
                ownerUserId: actor.userId,
                projectId: preliminarySnapshot.projectId,
                teamBackendId: preliminarySnapshot.teamBackendId,
                workspaceProjectId: preliminarySnapshot.workspaceProjectId,
                name: preliminary.action_name,
                effectKey: preliminary.id,
                ...(preliminary.action_name === "koed_deck_make"
                  ? {
                      effectNonce:
                        (await readTeamNonce(
                          pool,
                          encryptionProvider,
                          preliminary,
                          preliminarySnapshot
                        )) ?? undefined
                    }
                  : {}),
                arguments: await decrypt(
                  encryptionProvider,
                  preliminary,
                  "arguments"
                ),
                snapshot: preliminarySnapshot
              })
              .catch(() => null)
          : null;
      const client = await pool.connect();
      try {
        await client.query("begin");
        const found = await client.query<Row>(
          `select action.* from managed_conversation_text_actions action
            join managed_conversation_executions execution
              on execution.id=action.execution_id and execution.owner_user_id=action.owner_user_id
           where action.owner_user_id=$1 and action.execution_id=$2 and action.id=$3
             and action.revision=$4 and action.state='claimed'
           for update of action`,
          [
            actor.userId,
            input.executionId,
            input.actionId,
            input.expectedRevision
          ]
        );
        const row = found.rows[0];
        if (!row) {
          await client.query("rollback");
          return null;
        }
        const args = await decrypt(encryptionProvider, row, "arguments");
        const snapshot = await decrypt(encryptionProvider, row, "snapshot");
        let proven = false;
        if (snapshot.workspaceProjectId) {
          if (row.action_name === "koed_todo_add") {
            const nonce = await readTeamNonce(
              client,
              encryptionProvider,
              row,
              snapshot
            );
            const expectedHash = nonce ? teamNonceHash(nonce) : null;
            proven = Boolean(
              expectedHash &&
              teamReceipt?.confirmed &&
              teamReceipt.effectNonceHash &&
              sameHash(expectedHash, teamReceipt.effectNonceHash)
            );
          } else proven = teamReceipt?.confirmed === true;
        } else if (row.action_name === "koed_deck_make") {
          const payload = deckCreateFromTextAction(
            row.id,
            args,
            String(snapshot.agentId)
          );
          const expectedHash = createHash("sha256")
            .update(JSON.stringify(payload))
            .digest("hex");
          const result = await client.query(
            `select 1 from managed_conversation_text_action_create_effects effect
               join project_decks deck on deck.owner_user_id=effect.owner_user_id
                 and deck.project_id=effect.project_id
                 and deck.idempotency_key=effect.action_id::text
               join projects project on project.id=deck.project_id
                 and project.owner_user_id=deck.owner_user_id
              where effect.action_id=$3 and effect.owner_user_id=$1
                and effect.project_id=$2 and effect.work_item_id is null
                and deck.owner_user_id=$1 and deck.project_id=$2
                and deck.idempotency_key=$3::text and deck.creation_payload_hash=$4
                and deck.deleted_at is null and project.lifecycle='active'
                and project.deletion_phase is null`,
            [actor.userId, args.projectId, row.id, expectedHash]
          );
          proven = Boolean(result.rowCount);
        } else if (row.action_name === "koed_project_create") {
          const result = await client.query(
            `select 1 from managed_conversation_text_action_create_effects effect
               join projects project on project.id=effect.project_id
                and project.owner_user_id=effect.owner_user_id
              where effect.owner_user_id=$1 and effect.action_id=$2
                and effect.work_item_id is null
                and project.creation_idempotency_key=effect.action_id::text and project.name=$3
                and project.folder_path is not distinct from $4::text`,
            [actor.userId, row.id, args.name, args.folderPath ?? null]
          );
          proven = Boolean(result.rowCount);
        } else if (row.action_name === "koed_todo_add") {
          const result = await client.query(
            `select 1 from managed_conversation_text_action_create_effects effect
               join project_work_items item on item.id=effect.work_item_id
                and item.owner_user_id=effect.owner_user_id
                and item.project_id=effect.project_id
              where effect.owner_user_id=$1 and effect.project_id=$2
                and effect.action_id=$3 and item.origin='koed_text_action'
                and item.idempotency_key=effect.action_id::text and item.title=$4 and item.goal=$5
                and item.due_on is not distinct from $6::date and item.deleted_at is null`,
            [
              actor.userId,
              args.projectId,
              row.id,
              args.title,
              args.goal ?? args.title,
              args.dueOn ?? null
            ]
          );
          proven = Boolean(result.rowCount);
        } else if (row.action_name === "koed_todo_send") {
          const result = await client.query(
            `select 1 from managed_conversation_text_action_dispatch_effects effect
               join project_work_items item
                 on item.id=effect.work_item_id and item.owner_user_id=effect.owner_user_id
              where effect.action_id=$1 and effect.owner_user_id=$2
                and effect.project_id=$3 and effect.work_item_id=$4
                and effect.agent_id=$5 and effect.work_item_version=$6
                and item.execution_id=effect.execution_id
                and item.assignee_agent_id=effect.agent_id
                and item.dispatch_key=$7
                and item.status in ('doing','review','done') and item.deleted_at is null`,
            [
              row.id,
              actor.userId,
              args.projectId,
              args.workItemId,
              args.agentId,
              snapshot.workItemVersion,
              `${args.workItemId}:${snapshot.workItemVersion}`
            ]
          );
          proven = Boolean(result.rowCount);
        } else if (row.action_name === "koed_chat_move") {
          const effects = await client.query<{
            session_id: string;
            source_project_id: string | null;
            target_project_id: string | null;
            assignment_version: number;
            move_batch_id: string | null;
            journal_batch_id: string | null;
          }>(
            `select effect.session_id,effect.source_project_id,effect.target_project_id,
                    effect.assignment_version,effect.move_batch_id,
                    journal.batch_id as journal_batch_id
                from managed_conversation_text_action_move_effects effect
                left join chat_move_operations journal on journal.batch_id=effect.move_batch_id
                  and journal.owner_user_id=effect.owner_user_id
                  and journal.session_id=effect.session_id
                  and journal.text_action_id=effect.action_id and journal.state='complete'
               where effect.owner_user_id=$1 and effect.action_id=$2`,
            [actor.userId, row.id]
          );
          const effect = effects.rows[0];
          proven =
            effects.rows.length === 1 &&
            Boolean(effect) &&
            effect!.session_id === args.sessionId &&
            effect!.source_project_id === (snapshot.currentProjectId ?? null) &&
            effect!.target_project_id === (args.projectId ?? null) &&
            effect!.assignment_version ===
              Number(snapshot.sessionProjectVersion) + 1 &&
            (snapshot.sourceWorkspaceProjectId
              ? Boolean(effect!.move_batch_id) &&
                effect!.move_batch_id === effect!.journal_batch_id
              : effect!.move_batch_id === null);
        } else if (row.action_name === "koed_project_move_chats") {
          const pinned = Array.isArray(snapshot.chats) ? snapshot.chats : [];
          const effects = await client.query<{
            session_id: string;
            source_project_id: string | null;
            target_project_id: string | null;
            assignment_version: number;
            move_batch_id: string | null;
            journal_batch_id: string | null;
          }>(
            `select effect.session_id,effect.source_project_id,effect.target_project_id,
                    effect.assignment_version,effect.move_batch_id,
                    journal.batch_id as journal_batch_id
                from managed_conversation_text_action_move_effects effect
                left join chat_move_operations journal on journal.batch_id=effect.move_batch_id
                  and journal.owner_user_id=effect.owner_user_id
                  and journal.session_id=effect.session_id
                  and journal.text_action_id=effect.action_id and journal.state='complete'
               where effect.owner_user_id=$1 and effect.action_id=$2`,
            [actor.userId, row.id]
          );
          proven =
            pinned.length === (args.sessionIds as string[]).length &&
            pinned.length > 0 &&
            effects.rows.length === pinned.length;
          for (const entry of pinned) {
            if (!entry || typeof entry !== "object") {
              proven = false;
              break;
            }
            const old = entry as Record<string, unknown>;
            const effect = effects.rows.find(
              (item) => item.session_id === old.sessionId
            );
            if (
              !effect ||
              effect.source_project_id !== (old.currentProjectId ?? null) ||
              effect.target_project_id !== args.projectId ||
              effect.assignment_version !==
                Number(old.sessionProjectVersion) + 1 ||
              (old.sourceWorkspaceProjectId
                ? !effect.move_batch_id ||
                  effect.move_batch_id !== effect.journal_batch_id
                : effect.move_batch_id !== null)
            ) {
              proven = false;
              break;
            }
          }
        } else if (
          row.action_name === "koed_hq_open" ||
          row.action_name === "koed_chat_create" ||
          row.action_name === "koed_settings_open" ||
          row.action_name === "koed_settings_set_theme"
        ) {
          // These are local view/preference effects owned by the Desktop.
          proven = true;
        }
        if (!proven) {
          await client.query("rollback");
          return null;
        }
        const changed = await client.query<Row>(
          `update managed_conversation_text_actions set state='applied',
             revision=revision+1,updated_at=now()
           where id=$1 and owner_user_id=$2 and state='claimed' and revision=$3
           returning *`,
          [row.id, actor.userId, row.revision]
        );
        await client.query("commit");
        return changed.rows[0]
          ? present(encryptionProvider, changed.rows[0])
          : null;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async prepareManagedTextTeamTodoAdd(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const found = await client.query<Row>(
          `select * from managed_conversation_text_actions
            where owner_user_id=$1 and execution_id=$2 and id=$3
              and revision=$4 and state='claimed'
              and action_name='koed_todo_add' for share`,
          [
            actor.userId,
            input.executionId,
            input.actionId,
            input.expectedRevision
          ]
        );
        const row = found.rows[0];
        const valid =
          row &&
          (await claimedManagedTextCreateWithClient(
            client,
            encryptionProvider,
            {
              ownerUserId: actor.userId,
              actionId: input.actionId,
              name: "koed_todo_add",
              matches: (args, snapshot) =>
                typeof args.projectId === "string" &&
                snapshot.projectId === args.projectId &&
                typeof snapshot.teamBackendId === "string" &&
                typeof snapshot.workspaceProjectId === "string" &&
                Number.isSafeInteger(snapshot.teamProjectVersion) &&
                Number.isSafeInteger(snapshot.teamMemberVersion)
            }
          ));
        const snapshot =
          valid && row
            ? await decrypt(encryptionProvider, row, "snapshot")
            : null;
        const effectNonce =
          valid && row && snapshot
            ? await readTeamNonce(client, encryptionProvider, row, snapshot)
            : null;
        await client.query("commit");
        return valid && row && effectNonce
          ? { action: await present(encryptionProvider, row), effectNonce }
          : null;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async prepareManagedTextDeckMake(actor, input) {
      const preliminary = (
        await pool.query<Row>(
          `select * from managed_conversation_text_actions
            where owner_user_id=$1 and execution_id=$2 and id=$3
              and revision=$4 and state='claimed' and action_name='koed_deck_make'`,
          [
            actor.userId,
            input.executionId,
            input.actionId,
            input.expectedRevision
          ]
        )
      ).rows[0];
      if (!preliminary) return null;
      const args = await decrypt(encryptionProvider, preliminary, "arguments");
      const snapshot = await decrypt(
        encryptionProvider,
        preliminary,
        "snapshot"
      );
      const proof = await preflightTeam(
        actor.userId,
        "koed_deck_make",
        args,
        typeof snapshot.projectId === "string" ? snapshot.projectId : null
      );
      const client = await pool.connect();
      try {
        await client.query("begin");
        const valid = await claimedManagedTextCreateWithClient(
          client,
          encryptionProvider,
          {
            ownerUserId: actor.userId,
            actionId: input.actionId,
            name: "koed_deck_make",
            matches: (actual, pinned) =>
              digest(actual) === digest(args) &&
              digest(pinned) === digest(snapshot)
          }
        );
        const fresh = valid
          ? await targetSnapshot(
              client,
              actor.userId,
              "koed_deck_make",
              args,
              proof,
              {
                logicalSessionId: preliminary.logical_session_id,
                executionId: preliminary.execution_id
              }
            )
          : null;
        await client.query("commit");
        return fresh && digest(fresh) === digest(snapshot)
          ? present(encryptionProvider, preliminary)
          : null;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async markManagedTextDeckDispatch(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const row = (
          await client.query<Row>(
            `select * from managed_conversation_text_actions
            where owner_user_id=$1 and execution_id=$2 and id=$3
              and state='claimed' and revision=$4 and action_name='koed_deck_make'
            for update`,
            [
              actor.userId,
              input.executionId,
              input.actionId,
              input.expectedRevision
            ]
          )
        ).rows[0];
        if (!row) {
          await client.query("rollback");
          return null;
        }
        const snapshot = await decrypt(encryptionProvider, row, "snapshot");
        if (
          typeof snapshot.teamBackendId !== "string" ||
          typeof snapshot.workspaceProjectId !== "string"
        ) {
          await client.query("rollback");
          return null;
        }
        const nonce = randomBytes(32).toString("base64url");
        const encrypted = await encryptTeamNonce(
          encryptionProvider,
          row,
          snapshot,
          nonce
        );
        const inserted = await client.query(
          `insert into managed_conversation_text_action_team_nonces
            (action_id,owner_user_id,encrypted_nonce)
           values($1,$2,$3::jsonb) on conflict do nothing`,
          [row.id, actor.userId, JSON.stringify(encrypted)]
        );
        await client.query("commit");
        return inserted.rowCount === 1
          ? {
              action: await present(encryptionProvider, row),
              effectNonce: nonce
            }
          : null;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async readManagedTextDeckEffectNonce(actor, input) {
      const row = (
        await pool.query<Row>(
          `select * from managed_conversation_text_actions
           where owner_user_id=$1 and execution_id=$2 and id=$3
             and action_name='koed_deck_make' and state='applied'`,
          [actor.userId, input.executionId, input.actionId]
        )
      ).rows[0];
      if (!row) return null;
      const snapshot = await decrypt(encryptionProvider, row, "snapshot");
      return typeof snapshot.workspaceProjectId === "string"
        ? readTeamNonce(pool, encryptionProvider, row, snapshot)
        : null;
    }
  };
};

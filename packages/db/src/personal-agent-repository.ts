import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  assertPersonalAgentAttemptRuntimeIdentity,
  assertPersonalAgentIsActive,
  decryptEnvelopeToUtf8,
  decideConversationItemPresentation,
  parsePersonalAgentExecutionAttempt,
  parsePersonalAgentExecutionJob,
  parsePersonalAgentConversation,
  parsePersonalAgentIdentity,
  parsePersonalAgentIdentityVersion,
  type AiClientPermissionMode,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type PersonalAgentAttemptOutcome,
  type PersonalAgentAttribution,
  type PersonalAgentExecutionAttempt,
  type PersonalAgentExecutionJob,
  type PersonalAgentActivityProjectSummary,
  type PersonalAgentIdentity,
  type PersonalAgentIdentityVersion,
  type PersonalAgentInstructionSource,
  type PersonalAgentRoleTemplate,
  personalAgentRoleTemplateSchema
} from "@koed/shared";
import {
  decryptAuthorizedEncryptedFieldPayloadWithClient,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import { loadConversationPresentationPolicySnapshot } from "./conversation-presentation-policy.js";
import type { ActorContext } from "./types.js";

const SOUL_MARKER = "[koed encrypted personal agent soul]";
const SOUL_SOURCE_TABLE = "personal_agent_identity_versions" as const;
const SOUL_SOURCE_COLUMN = "soul_instructions" as const;
const OUTPUT_SOURCE_TABLE = "personal_agent_execution_jobs" as const;
const OUTPUT_SOURCE_COLUMN = "assistant_output" as const;

// Job goals live in encrypted command payloads. Keep their short display
// titles out of the plaintext job row as well.
const originalJobGoal = (prompt: string): string =>
  prompt.split(/\n\s*\nKoed attached terminal context\b/u, 1)[0] ?? prompt;

const titleFromJobGoal = (goal: string): string => {
  const compact = goal.replace(/\s+/gu, " ").trim();
  if (!compact) return "Agent task";
  const characters = Array.from(compact);
  if (characters.length <= 64) return compact;
  const prefix = characters.slice(0, 64).join("");
  const lastSpace = prefix.lastIndexOf(" ");
  return `${lastSpace >= 32 ? prefix.slice(0, lastSpace) : prefix}…`;
};

const excerpt = (value: string, maximum: number): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;

const requestFingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const idempotencyConflict = (message: string): Error =>
  Object.assign(new Error(message), { code: "IDEMPOTENCY_CONFLICT" });

const retiredMutationError = (): Error =>
  Object.assign(new Error("Retired Personal Agents cannot be edited"), {
    code: "PERSONAL_AGENT_RETIRED"
  });

const nameConflictError = (): Error =>
  Object.assign(
    new Error("Personal Agent name was already used by this account"),
    { code: "PERSONAL_AGENT_NAME_CONFLICT" }
  );

export interface CreatePersonalAgentInput {
  requestId: string;
  name: string;
  role: string | null;
  avatarReference?: string | null;
  soulInstructions: string;
  instructionSource: PersonalAgentInstructionSource;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultReasoningEffort?: string | null;
  sourceTemplateId?: string | null;
  sourceTemplateVersion?: number | null;
}

export interface CreatePersonalAgentVersionInput {
  agentId: string;
  requestId: string;
  name: string;
  role: string | null;
  avatarReference?: string | null;
  soulInstructions: string;
  instructionSource: PersonalAgentInstructionSource;
  expectedCurrentVersion?: number;
  sourceTemplateId?: string | null;
  sourceTemplateVersion?: number | null;
}

const requestFingerprintForVersion = (
  input: CreatePersonalAgentVersionInput,
  ownerUserId: string
): string =>
  requestFingerprint({
    operation: "version",
    ownerUserId,
    agentId: input.agentId,
    requestId: input.requestId,
    expectedCurrentVersion: input.expectedCurrentVersion ?? null,
    name: input.name,
    role: input.role ?? "",
    avatarReference: input.avatarReference ?? null,
    soulInstructions: input.soulInstructions,
    instructionSource: input.instructionSource,
    sourceTemplateId: input.sourceTemplateId ?? null,
    sourceTemplateVersion: input.sourceTemplateVersion ?? null
  });

export interface PersonalAgentExecutionJobInput {
  conversationId: string;
  commandId?: string | null;
  attribution: PersonalAgentAttribution;
  projectId?: string | null;
}

export interface PersonalAgentJobOutputReference {
  runtimeItemIds: string[];
  attemptOutputs?: Array<{ attemptId: string; runtimeItemIds: string[] }>;
  legacyRuntimeItemIds?: string[];
}

export interface PersonalAgentExecutionAttemptInput {
  jobId: string;
  commandId?: string | null;
  attemptNumber: number;
  attribution: PersonalAgentAttribution;
  provider: string | null;
  model: string | null;
  aiClientInstanceId: string | null;
  reasoningEffort: string | null;
  permissionMode: AiClientPermissionMode | null;
  managedExecutionId: string | null;
  managedExecutionGeneration: number | null;
  status: "running";
  outcome: null;
  startedAt: string;
  completedAt: null;
}

export interface PersonalAgentExecutionJobPage {
  jobs: PersonalAgentExecutionJob[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface PersonalAgentHistoryJobPage {
  jobs: PersonalAgentHistoryJob[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface PersonalAgentActivityJob {
  id: string;
  conversationId: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  goal: string | null;
  state: PersonalAgentExecutionJob["state"];
  updatedAt: string;
}

export interface PersonalAgentActivityItem {
  agentId: string;
  status: "running" | "idle" | "unknown";
  availability: "available" | "unavailable" | "unsupported";
  freshness: "fresh" | "stale" | "unknown";
  observedAt: string | null;
  runningAttempts: number | null;
  persistedRunningAttempts: number | null;
  activeJobs: PersonalAgentActivityJob[];
  activeJobsCount: number | null;
  activeJobsTruncated: boolean;
  projectSummary: PersonalAgentActivityProjectSummary | null;
}

export interface PersonalAgentExecutionAttemptPage {
  attempts: PersonalAgentExecutionAttempt[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface PersonalAgentHistory {
  stats: Record<string, number | boolean | null>;
  jobs: PersonalAgentHistoryJob[];
  runningNow?: PersonalAgentHistoryJob[];
  jobsHasMore: boolean;
  jobsNextCursor: string | null;
  projects: unknown[] | null;
}

export interface PersonalAgentHistoryJob extends PersonalAgentExecutionJob {
  title: string;
  goal: string | null;
  agentName: string | null;
  attempts: PersonalAgentExecutionAttempt[];
  latestAttempt: PersonalAgentExecutionAttempt | null;
}

export interface PersonalAgentDetail {
  agent: PersonalAgentIdentity;
  soulInstructions: string;
  history: PersonalAgentHistory;
}

export interface PersonalAgentRepository {
  listPersonalAgentRoleTemplates(): Promise<PersonalAgentRoleTemplate[]>;
  getPersonalAgentRoleTemplate(
    templateId: string,
    version: number
  ): Promise<PersonalAgentRoleTemplate | null>;
  getPersonalAgentConversation(
    actor: ActorContext,
    input: { conversationId: string }
  ): Promise<import("@koed/shared").PersonalAgentConversation | null>;
  addPersonalAgentParticipant(
    actor: ActorContext,
    input: { conversationId: string; agentId: string; makeActive?: boolean }
  ): Promise<import("@koed/shared").PersonalAgentConversation>;
  setActivePersonalAgentRespondent(
    actor: ActorContext,
    input: {
      conversationId: string;
      agentId: string | null;
      expectedVersion: number;
    }
  ): Promise<import("@koed/shared").PersonalAgentConversation>;
  createPersonalAgent(
    actor: ActorContext,
    input: CreatePersonalAgentInput
  ): Promise<PersonalAgentDetail>;
  getPersonalAgent(
    actor: ActorContext,
    agentId: string
  ): Promise<PersonalAgentDetail | null>;
  listPersonalAgents(
    actor: ActorContext,
    input?: { includeRetired?: boolean }
  ): Promise<PersonalAgentIdentity[]>;
  getPersonalAgentActivity(
    actor: ActorContext,
    input: { agentIds: string[] }
  ): Promise<PersonalAgentActivityItem[]>;
  listPersonalAgentHistoryJobs(
    actor: ActorContext,
    input: { agentId: string; limit?: number; before?: string }
  ): Promise<PersonalAgentHistoryJobPage>;
  getPersonalAgentVersion(
    actor: ActorContext,
    input: { agentId: string; version: number }
  ): Promise<PersonalAgentIdentityVersion | null>;
  createPersonalAgentVersion(
    actor: ActorContext,
    input: CreatePersonalAgentVersionInput
  ): Promise<PersonalAgentIdentityVersion>;
  updatePersonalAgent(
    actor: ActorContext,
    input: {
      agentId: string;
      requestId: string;
      expectedVersion: number;
      name?: string;
      role?: string | null;
      avatarReference?: string | null;
      soulInstructions?: string;
      defaultProvider?: string | null;
      defaultModel?: string | null;
      defaultReasoningEffort?: string | null;
    }
  ): Promise<PersonalAgentDetail | null>;
  retirePersonalAgent(input: {
    actor: ActorContext;
    agentId: string;
    requestId: string;
    expectedVersion: number;
  }): Promise<PersonalAgentIdentity | null>;
  restorePersonalAgent(input: {
    actor: ActorContext;
    agentId: string;
    requestId: string;
    expectedVersion: number;
  }): Promise<PersonalAgentIdentity | null>;
  createPersonalAgentExecutionJob(
    actor: ActorContext,
    input: PersonalAgentExecutionJobInput
  ): Promise<PersonalAgentExecutionJob>;
  recordPersonalAgentTurnOutput(input: {
    actor: ActorContext;
    jobId: string;
    attemptId: string;
    outputText: string;
    outputReference: PersonalAgentJobOutputReference;
    eventId?: string;
    observedAt?: string;
  }): Promise<PersonalAgentExecutionJob>;
  getPersonalAgentTurnOutput(
    actor: ActorContext,
    input: { jobId: string }
  ): Promise<string | null>;
  getPersonalAgentExecutionJob(
    actor: ActorContext,
    jobId: string
  ): Promise<PersonalAgentExecutionJob | null>;
  listPersonalAgentExecutionJobs(
    actor: ActorContext,
    input?: {
      conversationId?: string;
      agentId?: string;
      limit?: number;
      before?: string;
    }
  ): Promise<PersonalAgentExecutionJobPage>;
  countPersonalAgentExecutionJobs(
    actor: ActorContext,
    input?: {
      conversationId?: string;
      state?: PersonalAgentExecutionJob["state"];
    }
  ): Promise<number>;
  createPersonalAgentExecutionAttempt(
    actor: ActorContext,
    input: PersonalAgentExecutionAttemptInput
  ): Promise<PersonalAgentExecutionAttempt>;
  completePersonalAgentExecutionAttempt(input: {
    actor: ActorContext;
    jobId: string;
    attemptId: string;
    outcome: PersonalAgentAttemptOutcome;
    jobState?: "waiting";
    eventId?: string;
    observedAt?: string;
  }): Promise<{
    attempt: PersonalAgentExecutionAttempt;
    job: PersonalAgentExecutionJob;
    replayed: boolean;
  }>;
  listPersonalAgentExecutionAttempts(
    actor: ActorContext,
    input: { jobId: string; limit?: number; before?: string }
  ): Promise<PersonalAgentExecutionAttemptPage>;
  countPersonalAgentExecutionAttempts(
    actor: ActorContext,
    input?: {
      jobId?: string;
      status?: PersonalAgentExecutionAttempt["status"];
    }
  ): Promise<number>;
}

type IdentityRow = {
  id: string;
  owner_user_id: string;
  name: string;
  role: string;
  avatar_reference: string | null;
  default_provider: string | null;
  default_model: string | null;
  default_reasoning_effort: string | null;
  lifecycle: "active" | "retired";
  current_version: number;
  created_at: Date;
  updated_at: Date;
  retired_at: Date | null;
  creation_request_id: string;
  retirement_request_id: string | null;
  creation_request_fingerprint: string;
  retirement_request_fingerprint: string | null;
  restore_request_id: string | null;
  restore_request_fingerprint: string | null;
};

type VersionRow = {
  id: string;
  agent_id: string;
  owner_user_id: string;
  version: number;
  name: string;
  role: string;
  avatar_reference: string | null;
  default_provider: string | null;
  default_model: string | null;
  default_reasoning_effort: string | null;
  soul_instructions: string;
  instruction_source: PersonalAgentInstructionSource;
  source_template_id?: string | null;
  source_template_version?: number | null;
  created_by_user_id: string;
  request_id: string;
  request_fingerprint: string;
  created_at: Date;
};

type JobRow = {
  id: string;
  owner_user_id: string;
  conversation_id: string;
  command_id: string | null;
  title: string;
  project_id: string | null;
  output_reference: PersonalAgentJobOutputReference | null;
  version: number;
  last_observed_at: Date | null;
  attribution_kind: "agent" | "legacy";
  agent_id: string | null;
  agent_version: number | null;
  state: PersonalAgentExecutionJob["state"];
  attempts_started: number;
  attempts_succeeded: number;
  attempts_failed: number;
  attempts_canceled: number;
  attempts_interrupted: number;
  last_attempt_id: string | null;
  created_at: Date;
  created_at_cursor?: string;
  updated_at: Date;
};

type AttemptRow = {
  id: string;
  owner_user_id: string;
  job_id: string;
  command_id: string | null;
  attempt_number: number;
  attribution_kind: "agent" | "legacy";
  agent_id: string | null;
  agent_version: number | null;
  provider: string | null;
  model: string | null;
  ai_client_instance_id: string | null;
  reasoning_effort: string | null;
  permission_mode: AiClientPermissionMode | null;
  managed_execution_id: string | null;
  managed_execution_generation: number | null;
  status: PersonalAgentExecutionAttempt["status"];
  outcome: PersonalAgentAttemptOutcome | null;
  started_at: Date;
  phase?: PersonalAgentExecutionAttempt["phase"];
  phase_observed_at?: Date | null;
  completed_at: Date | null;
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const mapIdentity = (row: IdentityRow): PersonalAgentIdentity =>
  parsePersonalAgentIdentity({
    contractVersion: 1,
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    role: row.role,
    avatarReference: row.avatar_reference,
    lifecycle: row.lifecycle,
    defaultProvider: row.default_provider,
    defaultModel: row.default_model,
    defaultReasoningEffort: row.default_reasoning_effort,
    currentVersion: row.current_version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    retiredAt: row.retired_at ? iso(row.retired_at) : null
  });

const mapVersion = (
  row: VersionRow,
  soulInstructions: string
): PersonalAgentIdentityVersion =>
  parsePersonalAgentIdentityVersion({
    contractVersion: 1,
    id: row.id,
    agentId: row.agent_id,
    ownerUserId: row.owner_user_id,
    version: row.version,
    name: row.name,
    role: row.role,
    avatarReference: row.avatar_reference,
    defaultProvider: row.default_provider,
    defaultModel: row.default_model,
    defaultReasoningEffort: row.default_reasoning_effort,
    soulInstructions,
    instructionSource: row.instruction_source,
    sourceTemplateId: row.source_template_id ?? null,
    sourceTemplateVersion: row.source_template_version ?? null,
    createdByUserId: row.created_by_user_id,
    createdAt: iso(row.created_at)
  });

const mapAttribution = (
  kind: "agent" | "legacy",
  agentId: string | null,
  agentVersion: number | null
): PersonalAgentAttribution =>
  kind === "agent"
    ? { kind, agentId: agentId!, agentVersion: agentVersion! }
    : { kind, agentId: null, agentVersion: null };

const mapJob = (row: JobRow): PersonalAgentExecutionJob =>
  parsePersonalAgentExecutionJob({
    contractVersion: 1,
    id: row.id,
    ownerUserId: row.owner_user_id,
    conversationId: row.conversation_id,
    commandId: row.command_id,
    title: row.title,
    projectId: row.project_id,
    attribution: mapAttribution(
      row.attribution_kind,
      row.agent_id,
      row.agent_version
    ),
    state: row.state,
    counters: {
      attemptsStarted: row.attempts_started,
      attemptsSucceeded: row.attempts_succeeded,
      attemptsFailed: row.attempts_failed,
      attemptsCanceled: row.attempts_canceled,
      attemptsInterrupted: row.attempts_interrupted
    },
    lastAttemptId: row.last_attempt_id,
    outputReference: row.output_reference,
    version: row.version,
    lastObservedAt: row.last_observed_at ? iso(row.last_observed_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  });

const mapAttempt = (row: AttemptRow): PersonalAgentExecutionAttempt =>
  parsePersonalAgentExecutionAttempt({
    contractVersion: 1,
    id: row.id,
    ownerUserId: row.owner_user_id,
    jobId: row.job_id,
    commandId: row.command_id,
    attemptNumber: row.attempt_number,
    attribution: mapAttribution(
      row.attribution_kind,
      row.agent_id,
      row.agent_version
    ),
    provider: row.provider,
    model: row.model,
    aiClientInstanceId: row.ai_client_instance_id,
    reasoningEffort: row.reasoning_effort,
    permissionMode: row.permission_mode,
    managedExecutionId: row.managed_execution_id,
    managedExecutionGeneration: row.managed_execution_generation,
    status: row.status,
    outcome: row.outcome,
    startedAt: iso(row.started_at),
    phase: row.phase ?? "working",
    phaseObservedAt: row.phase_observed_at ? iso(row.phase_observed_at) : null,
    completedAt: row.completed_at ? iso(row.completed_at) : null
  });

const encodeCursor = (createdAt: Date | string, id: string): string =>
  Buffer.from(
    `${createdAt instanceof Date ? createdAt.toISOString() : createdAt}\u0000${id}`,
    "utf8"
  ).toString("base64url");

const decodeCursor = (cursor: string): { createdAt: string; id: string } => {
  const [createdAt, id] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("\u0000");
  if (
    !createdAt ||
    !id ||
    Number.isNaN(Date.parse(createdAt)) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id
    )
  ) {
    throw new TypeError("Invalid Personal Agent history cursor");
  }
  return { createdAt, id };
};

export const createPersonalAgentRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider } = {}
): PersonalAgentRepository => {
  const requireProvider = (): EnvelopeEncryptionProvider => {
    if (!options.envelopeEncryptionProvider) {
      throw new Error(
        "Envelope encryption provider is required for Personal Agents"
      );
    }
    return options.envelopeEncryptionProvider;
  };

  const decryptSoul = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    versionId: string
  ): Promise<string> => {
    const result = await decryptAuthorizedEncryptedFieldPayloadWithClient(
      client,
      actor,
      requireProvider(),
      {
        sourceTable: SOUL_SOURCE_TABLE,
        sourceId: versionId,
        sourceColumn: SOUL_SOURCE_COLUMN
      }
    );
    if (!result || typeof result.plaintext !== "string") {
      throw new Error("Encrypted Personal Agent soul is missing or invalid");
    }
    return result.plaintext;
  };

  const hydrateVersion = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    row: VersionRow
  ): Promise<PersonalAgentIdentityVersion> =>
    mapVersion(row, await decryptSoul(client, actor, row.id));

  const withTransaction = async <T>(
    work: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const value = await work(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };

  const reserveName = async (
    client: pg.PoolClient,
    ownerUserId: string,
    agentId: string,
    name: string
  ): Promise<void> => {
    const inserted = await client.query<{ agent_id: string }>(
      `insert into personal_agent_name_claims
         (owner_user_id, normalized_name, agent_id)
       select $1, lower(regexp_replace(trim($2), '\\s+', ' ', 'g')), $3
       on conflict (owner_user_id, normalized_name) do nothing
       returning agent_id`,
      [ownerUserId, name, agentId]
    );
    if (inserted.rows[0]) return;
    const existing = await client.query<{ agent_id: string }>(
      `select agent_id from personal_agent_name_claims
       where owner_user_id = $1
         and normalized_name = lower(regexp_replace(trim($2), '\\s+', ' ', 'g'))`,
      [ownerUserId, name]
    );
    if (existing.rows[0]?.agent_id !== agentId) throw nameConflictError();
  };

  const insertSoul = async (
    client: pg.PoolClient,
    actor: ActorContext,
    versionId: string,
    soulInstructions: string
  ): Promise<void> => {
    await upsertEncryptedFieldPayloadWithClient(
      client,
      actor,
      requireProvider(),
      {
        sourceTable: SOUL_SOURCE_TABLE,
        sourceId: versionId,
        sourceColumn: SOUL_SOURCE_COLUMN,
        plaintext: soulInstructions,
        visibility: "personal",
        rowFamily: "personal_agent_identity_version",
        scope: { tenantId: actor.userId, objectClass: "personal_agent_soul" },
        aad: { agentVersionId: versionId }
      }
    );
  };

  const encryptTurnOutput = async (
    client: pg.PoolClient,
    actor: ActorContext,
    jobId: string,
    attemptId: string,
    outputText: string
  ): Promise<void> => {
    await upsertEncryptedFieldPayloadWithClient(
      client,
      actor,
      requireProvider(),
      {
        sourceTable: OUTPUT_SOURCE_TABLE,
        sourceId: attemptId,
        sourceColumn: OUTPUT_SOURCE_COLUMN,
        plaintext: outputText,
        visibility: "personal",
        rowFamily: "personal_agent_execution_job",
        scope: { tenantId: actor.userId, objectClass: "personal_agent_output" },
        aad: { jobId, attemptId }
      }
    );
  };

  const decryptTurnOutput = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    sourceId: string
  ): Promise<string | null> => {
    const result = await decryptAuthorizedEncryptedFieldPayloadWithClient(
      client,
      actor,
      requireProvider(),
      {
        sourceTable: OUTPUT_SOURCE_TABLE,
        sourceId,
        sourceColumn: OUTPUT_SOURCE_COLUMN
      }
    );
    return typeof result?.plaintext === "string" ? result.plaintext : null;
  };

  const insertVersion = async (
    client: pg.PoolClient,
    actor: ActorContext,
    input: {
      agentId: string;
      ownerUserId: string;
      version: number;
      name: string;
      role: string;
      avatarReference: string | null;
      soulInstructions: string;
      instructionSource: PersonalAgentInstructionSource;
      requestId: string;
      requestFingerprint: string;
      defaultProvider: string | null;
      defaultModel: string | null;
      defaultReasoningEffort: string | null;
      sourceTemplateId?: string | null;
      sourceTemplateVersion?: number | null;
    }
  ): Promise<VersionRow> => {
    const id = randomUUID();
    const result = await client.query<VersionRow>(
      `insert into personal_agent_identity_versions
        (id, agent_id, owner_user_id, version, name, role, avatar_reference,
         soul_instructions, instruction_source, created_by_user_id, request_id,
         request_fingerprint, default_provider, default_model,
         default_reasoning_effort, source_template_id, source_template_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $3, $10, $11, $12, $13, $14, $15, $16)
       returning id, agent_id, owner_user_id, version, name, role,
         avatar_reference, default_provider, default_model,
         default_reasoning_effort, soul_instructions, instruction_source,
         source_template_id, source_template_version,
         created_by_user_id, request_id, request_fingerprint, created_at`,
      [
        id,
        input.agentId,
        input.ownerUserId,
        input.version,
        input.name,
        input.role ?? "",
        input.avatarReference,
        SOUL_MARKER,
        input.instructionSource,
        input.requestId,
        input.requestFingerprint,
        input.defaultProvider,
        input.defaultModel,
        input.defaultReasoningEffort,
        input.sourceTemplateId ?? null,
        input.sourceTemplateVersion ?? null
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Personal Agent version insert returned no row");
    await insertSoul(client, actor, id, input.soulInstructions);
    return row;
  };

  const selectIdentity = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    agentId: string
  ): Promise<IdentityRow | null> => {
    const result = await client.query<IdentityRow>(
      `select id, owner_user_id, name, role, avatar_reference, lifecycle,
          default_provider, default_model, default_reasoning_effort,
          current_version, creation_request_id, creation_request_fingerprint,
          retirement_request_id, retirement_request_fingerprint,
          restore_request_id, restore_request_fingerprint,
          created_at, updated_at, retired_at
       from personal_agent_identities
       where id = $1 and owner_user_id = $2`,
      [agentId, actor.userId]
    );
    return result.rows[0] ?? null;
  };

  const selectVersion = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    agentId: string,
    version: number
  ): Promise<VersionRow | null> => {
    const result = await client.query<VersionRow>(
      `select id, agent_id, owner_user_id, version, name, role,
          avatar_reference, default_provider, default_model,
          default_reasoning_effort, soul_instructions, instruction_source,
          source_template_id, source_template_version,
          created_by_user_id, request_id, request_fingerprint, created_at
       from personal_agent_identity_versions
       where agent_id = $1 and owner_user_id = $2 and version = $3`,
      [agentId, actor.userId, version]
    );
    return result.rows[0] ?? null;
  };

  const validateAttribution = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    attribution: PersonalAgentAttribution,
    requireActive: boolean
  ): Promise<void> => {
    if (attribution.kind === "legacy") return;
    const result = await client.query<{ lifecycle: "active" | "retired" }>(
      `select i.lifecycle
       from personal_agent_identities i
       join personal_agent_identity_versions v
         on v.agent_id = i.id and v.owner_user_id = i.owner_user_id
        and v.version = $3
       where i.id = $1 and i.owner_user_id = $2
       ${requireActive ? "for share of i" : ""}`,
      [attribution.agentId, actor.userId, attribution.agentVersion]
    );
    if (
      !result.rows[0] ||
      (requireActive && result.rows[0].lifecycle !== "active")
    ) {
      throw new Error("Personal Agent attribution is not owned or available");
    }
  };

  const authorizedJobGoals = async (
    actor: ActorContext,
    jobs: PersonalAgentExecutionJob[]
  ): Promise<Map<string, string>> => {
    const commandIds = jobs
      .map((job) => job.commandId)
      .filter((id): id is string => Boolean(id));
    if (commandIds.length === 0) return new Map();
    const commands = await pool.query<{
      id: string;
      execution_id: string;
      encrypted_payload: EncryptedPayloadEnvelope | null;
    }>(
      `select id, execution_id, encrypted_payload
       from managed_conversation_commands
       where owner_user_id = $1 and id = any($2::uuid[])
         and command_kind in ('start', 'prompt')`,
      [actor.userId, commandIds]
    );
    const byId = new Map(commands.rows.map((row) => [row.id, row]));
    const goals = await Promise.all(
      jobs.map(async (job) => {
        const command = job.commandId ? byId.get(job.commandId) : undefined;
        if (
          !command?.encrypted_payload ||
          command.execution_id !== job.conversationId
        )
          return null;
        const plaintext = await decryptEnvelopeToUtf8(
          requireProvider(),
          command.encrypted_payload
        );
        const payload: unknown = JSON.parse(plaintext);
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          return null;
        const prompt = (payload as Record<string, unknown>).prompt;
        return typeof prompt === "string"
          ? { jobId: job.id, goal: originalJobGoal(prompt) }
          : null;
      })
    );
    return new Map(
      goals
        .filter((value): value is { jobId: string; goal: string } =>
          Boolean(value)
        )
        .map((value) => [value.jobId, value.goal])
    );
  };

  const withAuthorizedJobTitles = async (
    actor: ActorContext,
    jobs: PersonalAgentExecutionJob[]
  ): Promise<PersonalAgentExecutionJob[]> => {
    const goals = await authorizedJobGoals(actor, jobs);
    return jobs.map((job) => ({
      ...job,
      title: goals.has(job.id)
        ? titleFromJobGoal(goals.get(job.id)!)
        : "Agent task"
    }));
  };

  const getPersonalAgentActivity = async (
    actor: ActorContext,
    input: { agentIds: string[] }
  ): Promise<PersonalAgentActivityItem[]> => {
    const agentIds = [...new Set(input.agentIds)];
    if (agentIds.length !== input.agentIds.length || agentIds.length > 100) {
      throw new RangeError(
        "Personal Agent activity requires up to 100 unique Agent IDs"
      );
    }
    if (agentIds.length === 0) return [];
    const result = await pool.query<{
      agent_id: string;
      persisted_count: string;
      verified_attempt_count: string;
      active_job_count: string;
      observed_at: Date;
      id: string | null;
      owner_user_id: string | null;
      conversation_id: string | null;
      command_id: string | null;
      title: string | null;
      project_id: string | null;
      output_reference: PersonalAgentExecutionJob["outputReference"] | null;
      version: number | null;
      last_observed_at: Date | null;
      attribution_kind: "agent" | "legacy" | null;
      attributed_agent_id: string | null;
      agent_version: number | null;
      state: PersonalAgentExecutionJob["state"] | null;
      attempts_started: number | null;
      attempts_succeeded: number | null;
      attempts_failed: number | null;
      attempts_canceled: number | null;
      attempts_interrupted: number | null;
      last_attempt_id: string | null;
      created_at: Date | null;
      updated_at: Date | null;
      project_name: string | null;
    }>(
      `with requested_agents as (
         select id from personal_agent_identities
         where owner_user_id = $1 and id = any($2::uuid[])
       ), persisted as (
         select a.agent_id, count(distinct a.id)::text as persisted_count
         from personal_agent_execution_attempts a
         join requested_agents i on i.id = a.agent_id
         where a.owner_user_id = $1 and a.status = 'running'
         group by a.agent_id
       ), verified_attempts as (
         select a.id as attempt_id, a.agent_id, j.id as job_id
         from personal_agent_execution_attempts a
         join personal_agent_execution_jobs j
           on j.id = a.job_id and j.owner_user_id = a.owner_user_id
         join managed_conversation_commands c
           on c.id = j.command_id and c.owner_user_id = j.owner_user_id
         join managed_conversation_executions e
           on e.id = c.execution_id and e.owner_user_id = c.owner_user_id
         join requested_agents i on i.id = a.agent_id
         where a.owner_user_id = $1 and a.status = 'running'
           and a.managed_execution_id = e.id
           and a.managed_execution_generation = e.execution_generation
           and c.execution_generation = e.execution_generation
           and c.command_kind = 'prompt' and c.state = 'dispatching'
           and e.state = 'running'
           and e.runner_lease_expires_at > clock_timestamp()
       ), running_stats as (
         select agent_id, count(distinct attempt_id)::text as verified_attempt_count,
                count(distinct job_id)::text as active_job_count
         from verified_attempts group by agent_id
       ), verified_jobs as (
         select distinct on (a.agent_id, j.id)
                a.agent_id, j.id, j.owner_user_id, j.conversation_id, j.command_id,
                j.title, j.project_id, j.output_reference, j.version,
                j.last_observed_at, j.attribution_kind, j.agent_id as attributed_agent_id,
                j.agent_version, j.state, j.attempts_started, j.attempts_succeeded,
                j.attempts_failed, j.attempts_canceled, j.attempts_interrupted,
                j.last_attempt_id, j.created_at, j.updated_at,
                coalesce(s.project_override_name, s.automatic_project_name) as project_name
         from verified_attempts v
         join personal_agent_execution_attempts a
           on a.id = v.attempt_id and a.owner_user_id = $1
         join personal_agent_execution_jobs j
           on j.id = v.job_id and j.owner_user_id = $1
         join managed_conversation_executions e
           on e.id = j.conversation_id and e.owner_user_id = $1
         left join sessions s
           on s.owner_user_id = e.owner_user_id
          and s.logical_session_id = e.logical_session_id
          and coalesce(s.project_override_id, s.automatic_project_id) = j.project_id
         order by a.agent_id, j.id, a.attempt_number desc, a.id desc
       ), ranked_jobs as (
       select *, row_number() over (
           partition by agent_id order by updated_at desc, id desc
         ) as job_rank,
         row_number() over (order by updated_at desc, agent_id, id desc) as batch_rank
         from verified_jobs
       )
       select i.id as agent_id,
              coalesce(p.persisted_count, '0') as persisted_count,
              coalesce(r.verified_attempt_count, '0') as verified_attempt_count,
              coalesce(r.active_job_count, '0') as active_job_count,
              clock_timestamp() as observed_at,
              j.id, j.owner_user_id, j.conversation_id, j.command_id, j.title,
              j.project_id, j.output_reference, j.version, j.last_observed_at,
              j.attribution_kind, j.attributed_agent_id,
              j.agent_version, j.state, j.attempts_started, j.attempts_succeeded,
              j.attempts_failed, j.attempts_canceled, j.attempts_interrupted,
              j.last_attempt_id, j.created_at, j.updated_at, j.project_name
       from requested_agents i
       left join persisted p on p.agent_id = i.id
       left join running_stats r on r.agent_id = i.id
       left join ranked_jobs j
         on j.agent_id = i.id and j.job_rank <= 5 and j.batch_rank <= 100
       order by i.id, j.job_rank`,
      [actor.userId, agentIds]
    );
    const projectResult = await pool.query<{
      agent_id: string;
      project_count: string;
      named_project_count: string;
      project_id: string | null;
      project_name: string | null;
      status: "active" | "history" | null;
      started_at: Date | null;
    }>(
      `with requested_project_agents as (
         select id from personal_agent_identities
         where owner_user_id = $1 and id = any($2::uuid[])
       ), project_counts as (
         select i.id as agent_id, count(distinct j.project_id)::text as project_count
         from requested_project_agents i
         left join personal_agent_execution_jobs j
           on j.owner_user_id = $1 and j.agent_id = i.id
         group by i.id
       ), named_projects as (
         select j.agent_id, j.project_id,
                coalesce(max(s.project_override_name), max(s.automatic_project_name)) as name,
                case when bool_or(j.state = 'running') then 'active' else 'history' end as status,
                max(j.created_at) as started_at
         from requested_project_agents i
         join personal_agent_execution_jobs j
           on j.owner_user_id = $1 and j.agent_id = i.id
          and j.project_id is not null
         join managed_conversation_executions e
           on e.id = j.conversation_id and e.owner_user_id = $1
         left join sessions s
           on s.owner_user_id = e.owner_user_id
          and s.logical_session_id = e.logical_session_id
          and coalesce(s.project_override_id, s.automatic_project_id) = j.project_id
         group by j.agent_id, j.project_id
         having coalesce(max(s.project_override_name), max(s.automatic_project_name)) is not null
       ), named_counts as (
         select agent_id, count(*)::text as named_project_count
         from named_projects group by agent_id
       ), ranked_projects as (
         select *, row_number() over (
             partition by agent_id order by started_at desc, project_id
           ) as agent_rank,
           row_number() over (order by started_at desc, agent_id, project_id) as batch_rank
         from named_projects
       )
       select i.id as agent_id,
              coalesce(pc.project_count, '0') as project_count,
              coalesce(nc.named_project_count, '0') as named_project_count,
              p.project_id, p.name as project_name, p.status, p.started_at
       from requested_project_agents i
       left join project_counts pc on pc.agent_id = i.id
       left join named_counts nc on nc.agent_id = i.id
       left join ranked_projects p
         on p.agent_id = i.id and p.agent_rank <= 5 and p.batch_rank <= 100
       order by i.id, p.agent_rank`,
      [actor.userId, agentIds]
    );
    const projectsByAgent = new Map<
      string,
      {
        projectCount: number;
        namedProjectCount: number;
        projects: PersonalAgentActivityProjectSummary["projects"];
      }
    >();
    for (const row of projectResult.rows) {
      const value = projectsByAgent.get(row.agent_id) ?? {
        projectCount: Number(row.project_count),
        namedProjectCount: Number(row.named_project_count),
        projects: []
      };
      if (
        row.project_id &&
        row.project_id.length <= 512 &&
        row.project_name &&
        row.status &&
        row.started_at
      ) {
        value.projects.push({
          id: row.project_id,
          name: row.project_name.slice(0, 128),
          status: row.status,
          startedAt: iso(row.started_at)
        });
      }
      projectsByAgent.set(row.agent_id, value);
    }
    const rowsByAgent = new Map<string, (typeof result.rows)[number][]>();
    for (const row of result.rows) {
      const rows = rowsByAgent.get(row.agent_id) ?? [];
      rows.push(row);
      rowsByAgent.set(row.agent_id, rows);
    }
    const jobs = result.rows.flatMap((row) =>
      row.id &&
      row.owner_user_id &&
      row.conversation_id &&
      row.created_at &&
      row.updated_at &&
      row.state &&
      row.attribution_kind
        ? [
            mapJob({
              id: row.id,
              owner_user_id: row.owner_user_id,
              conversation_id: row.conversation_id,
              command_id: row.command_id,
              title: row.title ?? "Agent task",
              project_id: row.project_id,
              output_reference: row.output_reference,
              version: row.version ?? 1,
              last_observed_at: row.last_observed_at,
              attribution_kind: row.attribution_kind,
              agent_id: row.attributed_agent_id,
              agent_version: row.agent_version,
              state: row.state,
              attempts_started: row.attempts_started ?? 0,
              attempts_succeeded: row.attempts_succeeded ?? 0,
              attempts_failed: row.attempts_failed ?? 0,
              attempts_canceled: row.attempts_canceled ?? 0,
              attempts_interrupted: row.attempts_interrupted ?? 0,
              last_attempt_id: row.last_attempt_id,
              created_at: row.created_at,
              updated_at: row.updated_at
            })
          ]
        : []
    );
    const goals = await authorizedJobGoals(actor, jobs);
    const activeJobsByAgent = new Map<string, PersonalAgentActivityJob[]>();
    for (const row of result.rows) {
      if (!row.id || !row.conversation_id || !row.updated_at || !row.state) {
        continue;
      }
      const goal = goals.get(row.id) ?? null;
      const activityJobs = activeJobsByAgent.get(row.agent_id) ?? [];
      activityJobs.push({
        id: row.id,
        conversationId: row.conversation_id,
        projectId:
          row.project_id && row.project_id.length <= 512
            ? row.project_id
            : null,
        projectName: row.project_name?.slice(0, 128) ?? null,
        title: goal ? titleFromJobGoal(goal) : "Agent task",
        goal: goal ? excerpt(originalJobGoal(goal), 240) : null,
        state: row.state,
        updatedAt: iso(row.updated_at)
      });
      activeJobsByAgent.set(row.agent_id, activityJobs);
    }
    return agentIds.map((agentId) => {
      const rows = rowsByAgent.get(agentId) ?? [];
      const row = rows[0];
      if (!row) {
        return {
          agentId,
          status: "unknown" as const,
          availability: "unavailable" as const,
          freshness: "unknown" as const,
          observedAt: null,
          runningAttempts: null,
          persistedRunningAttempts: null,
          activeJobs: [],
          activeJobsCount: null,
          activeJobsTruncated: false,
          projectSummary: null
        };
      }
      const persistedRunningAttempts = Number(row.persisted_count);
      const runningAttempts = Number(row.verified_attempt_count);
      const activeJobsCount = Number(row.active_job_count);
      return {
        agentId,
        status:
          runningAttempts > 0
            ? ("running" as const)
            : persistedRunningAttempts > runningAttempts
              ? ("unknown" as const)
              : ("idle" as const),
        availability: "available" as const,
        freshness:
          runningAttempts > 0
            ? ("fresh" as const)
            : persistedRunningAttempts > 0
              ? ("stale" as const)
              : ("fresh" as const),
        observedAt: iso(row.observed_at),
        runningAttempts,
        persistedRunningAttempts,
        activeJobs: activeJobsByAgent.get(agentId) ?? [],
        activeJobsCount,
        activeJobsTruncated:
          activeJobsCount > (activeJobsByAgent.get(agentId)?.length ?? 0),
        projectSummary: projectsByAgent.has(agentId)
          ? {
              projects: projectsByAgent.get(agentId)!.projects,
              count: projectsByAgent.get(agentId)!.projectCount,
              truncated:
                projectsByAgent.get(agentId)!.namedProjectCount >
                projectsByAgent.get(agentId)!.projects.length
            }
          : null
      };
    });
  };

  const loadPersonalAgentDetail = async (
    actor: ActorContext,
    agentId: string
  ): Promise<PersonalAgentDetail | null> => {
    const identityRow = await selectIdentity(pool, actor, agentId);
    if (!identityRow) return null;
    const versionRow = await selectVersion(
      pool,
      actor,
      agentId,
      identityRow.current_version
    );
    if (!versionRow)
      throw new Error("Current Personal Agent version is missing");
    const jobs = await listPersonalAgentExecutionJobs(actor, {
      agentId,
      limit: 50
    });
    const goals = await authorizedJobGoals(actor, jobs.jobs);
    const hydrateHistoryJobs = async (
      sourceJobs: PersonalAgentExecutionJob[],
      jobGoals: Map<string, string>
    ): Promise<PersonalAgentHistoryJob[]> =>
      Promise.all(
        sourceJobs.map(async (job) => {
          const attempts = await listPersonalAgentExecutionAttempts(actor, {
            jobId: job.id,
            limit: 100
          });
          const historicalIdentity =
            job.attribution.kind === "agent"
              ? await pool.query<{ name: string }>(
                  `select name from personal_agent_identity_versions
                 where owner_user_id = $1 and agent_id = $2 and version = $3`,
                  [
                    actor.userId,
                    job.attribution.agentId,
                    job.attribution.agentVersion
                  ]
                )
              : null;
          return {
            ...job,
            goal: jobGoals.get(job.id) ?? null,
            agentName: historicalIdentity?.rows[0]?.name ?? null,
            attempts: attempts.attempts,
            latestAttempt: attempts.attempts[0] ?? null
          };
        })
      );
    const historyJobs = await hydrateHistoryJobs(jobs.jobs, goals);
    const [jobStats, attemptStats, verifiedRunning, projectCount, projects] =
      await Promise.all([
        pool.query<{
          state: PersonalAgentExecutionJob["state"];
          count: string;
        }>(
          `select state, count(*)::text as count
         from personal_agent_execution_jobs
         where owner_user_id = $1 and agent_id = $2
         group by state`,
          [actor.userId, agentId]
        ),
        pool.query<{
          status: PersonalAgentExecutionAttempt["status"];
          count: string;
        }>(
          `select status, count(*)::text as count
         from personal_agent_execution_attempts
         where owner_user_id = $1 and agent_id = $2
         group by status`,
          [actor.userId, agentId]
        ),
        pool.query<{
          persisted_count: string;
          verified_count: string;
          observed_at: Date;
          verified_job_ids: string[] | null;
        }>(
          `select count(distinct a.id) filter (
                  where a.status = 'running'
                )::text as persisted_count,
                count(distinct a.id) filter (
                  where a.status = 'running'
                    and a.managed_execution_id = e.id
                    and a.managed_execution_generation = e.execution_generation
                    and c.execution_generation = e.execution_generation
                    and c.command_kind = 'prompt' and c.state = 'dispatching'
                    and e.state = 'running'
                    and e.runner_lease_expires_at > clock_timestamp()
                )::text as verified_count,
                clock_timestamp() as observed_at,
                coalesce(array_agg(distinct j.id) filter (
                  where a.status = 'running'
                    and a.managed_execution_id = e.id
                    and a.managed_execution_generation = e.execution_generation
                    and c.execution_generation = e.execution_generation
                    and c.command_kind = 'prompt' and c.state = 'dispatching'
                    and e.state = 'running'
                    and e.runner_lease_expires_at > clock_timestamp()
                ), '{}') as verified_job_ids
         from personal_agent_execution_attempts a
         left join personal_agent_execution_jobs j
           on j.id = a.job_id and j.owner_user_id = a.owner_user_id
         left join managed_conversation_commands c
           on c.id = j.command_id and c.owner_user_id = j.owner_user_id
         left join managed_conversation_executions e
           on e.id = c.execution_id and e.owner_user_id = c.owner_user_id
         where a.owner_user_id = $1 and a.agent_id = $2`,
          [actor.userId, agentId]
        ),
        pool.query<{ count: string }>(
          `select count(distinct project_id)::text as count
         from personal_agent_execution_jobs
         where owner_user_id = $1 and agent_id = $2 and project_id is not null`,
          [actor.userId, agentId]
        ),
        pool.query<{
          id: string;
          name: string;
          status: string;
          started_at: Date;
        }>(
          `with agent_projects as (
           select distinct project_id
           from personal_agent_execution_jobs
           where owner_user_id = $1 and agent_id = $2 and project_id is not null
         )
         select p.project_id as id,
                coalesce(max(s.project_override_name), max(s.automatic_project_name)) as name,
                case when bool_or(j.state = 'running') then 'active' else 'history' end as status,
                max(j.created_at) as started_at
         from agent_projects p
         join personal_agent_execution_jobs j
           on j.owner_user_id = $1 and j.agent_id = $2 and j.project_id = p.project_id
         join managed_conversation_executions e
           on e.id = j.conversation_id and e.owner_user_id = j.owner_user_id
         left join sessions s
           on s.owner_user_id = e.owner_user_id
          and s.logical_session_id = e.logical_session_id
          and coalesce(s.project_override_id, s.automatic_project_id) = p.project_id
         group by p.project_id
         having coalesce(max(s.project_override_name), max(s.automatic_project_name)) is not null
         order by max(j.created_at) desc, p.project_id`,
          [actor.userId, agentId]
        )
      ]);
    const persistedRunning = Number(
      verifiedRunning.rows[0]?.persisted_count ?? 0
    );
    const verifiedRunningNow = Number(
      verifiedRunning.rows[0]?.verified_count ?? 0
    );
    const runningObservedAt = verifiedRunning.rows[0]?.observed_at ?? null;
    const verifiedJobIds = verifiedRunning.rows[0]?.verified_job_ids ?? [];
    const historyJobIds = new Set(historyJobs.map((job) => job.id));
    const missingRunningJobIds = verifiedJobIds.filter(
      (jobId) => !historyJobIds.has(jobId)
    );
    const extraRunningJobs = missingRunningJobIds.length
      ? await pool.query<JobRow>(
          `select id, owner_user_id, conversation_id, command_id, title, project_id,
              output_reference, version, last_observed_at, attribution_kind, agent_id,
              agent_version, state, attempts_started, attempts_succeeded,
              attempts_failed, attempts_canceled, attempts_interrupted,
              last_attempt_id, created_at, updated_at
           from personal_agent_execution_jobs
           where owner_user_id = $1 and agent_id = $2 and id = any($3::uuid[])`,
          [actor.userId, agentId, missingRunningJobIds]
        )
      : { rows: [] as JobRow[] };
    const extraRunningJobRows = extraRunningJobs.rows.map(mapJob);
    const extraGoals = await authorizedJobGoals(actor, extraRunningJobRows);
    const titledExtraRunningJobs = extraRunningJobRows.map((job) => ({
      ...job,
      title: extraGoals.has(job.id)
        ? titleFromJobGoal(extraGoals.get(job.id)!)
        : "Agent task"
    }));
    const hydratedExtraRunningJobs = await hydrateHistoryJobs(
      titledExtraRunningJobs,
      extraGoals
    );
    const runningJobsById = new Map(
      [...historyJobs, ...hydratedExtraRunningJobs].map((job) => [job.id, job])
    );
    const runningNow = verifiedJobIds.flatMap((jobId) => {
      const job = runningJobsById.get(jobId);
      return job ? [job] : [];
    });
    const stats: Record<string, number | boolean | null> = {
      totalJobs: jobStats.rows.reduce(
        (total, row) => total + Number(row.count),
        0
      ),
      totalAttempts: attemptStats.rows.reduce(
        (total, row) => total + Number(row.count),
        0
      ),
      runningAttemptsPersisted: persistedRunning,
      runningNow: verifiedRunningNow,
      runningAttemptsMayBeStale: persistedRunning > verifiedRunningNow,
      runningAttemptsObservedAt: runningObservedAt
        ? runningObservedAt.getTime()
        : null,
      jobsHasMore: jobs.hasMore ? 1 : 0,
      projects: Number(projectCount.rows[0]?.count ?? 0),
      projectsAvailable: true
    };
    for (const row of jobStats.rows)
      stats[`jobs_${row.state}`] = Number(row.count);
    for (const row of attemptStats.rows) {
      stats[`attempts_${row.status}`] = Number(row.count);
    }
    return {
      agent: mapIdentity(identityRow),
      soulInstructions: await decryptSoul(pool, actor, versionRow.id),
      history: {
        stats,
        jobs: historyJobs,
        runningNow,
        jobsHasMore: jobs.hasMore,
        jobsNextCursor: jobs.nextCursor,
        projects: projects.rows.map((project) => ({
          id: project.id,
          name: project.name,
          status: project.status,
          startedAt: iso(project.started_at)
        }))
      }
    };
  };

  const readPersonalAgentConversation = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    conversationId: string
  ): Promise<import("@koed/shared").PersonalAgentConversation | null> => {
    const session = await client.query<{ id: string }>(
      `select id from managed_conversation_executions where id = $1 and owner_user_id = $2`,
      [conversationId, actor.userId]
    );
    if (!session.rows[0]) return null;
    const state = await client.query<{
      active_agent_id: string | null;
      model_override: string | null;
      reasoning_effort_override: string | null;
      version: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `select active_agent_id, model_override, reasoning_effort_override,
              version, created_at, updated_at
       from personal_agent_conversations
       where conversation_id = $1 and owner_user_id = $2`,
      [conversationId, actor.userId]
    );
    const participants = await client.query<{
      agent_id: string;
      ordinal: number;
      added_at: Date;
    }>(
      `select agent_id, ordinal, added_at
       from personal_agent_conversation_participants
       where conversation_id = $1 and owner_user_id = $2
       order by ordinal asc`,
      [conversationId, actor.userId]
    );
    const row = state.rows[0];
    return parsePersonalAgentConversation({
      contractVersion: 1,
      id: conversationId,
      ownerUserId: actor.userId,
      participants: participants.rows.map((participant) => ({
        conversationId,
        ownerUserId: actor.userId,
        agentId: participant.agent_id,
        ordinal: participant.ordinal,
        addedAt: iso(participant.added_at)
      })),
      activeAgentId: row?.active_agent_id ?? null,
      modelOverride: row?.model_override ?? null,
      reasoningEffortOverride: row?.reasoning_effort_override ?? null,
      version: row?.version ?? 1,
      createdAt: row ? iso(row.created_at) : iso(new Date(0)),
      updatedAt: row ? iso(row.updated_at) : iso(new Date(0))
    });
  };

  const getPersonalAgentConversation = async (
    actor: ActorContext,
    input: { conversationId: string }
  ) =>
    withTransaction(async (client) => {
      const session = await client.query<{ id: string }>(
        `select id from managed_conversation_executions where id = $1 and owner_user_id = $2 for share`,
        [input.conversationId, actor.userId]
      );
      if (!session.rows[0]) return null;
      await client.query(
        `insert into personal_agent_conversations (conversation_id, owner_user_id)
       values ($1, $2) on conflict (conversation_id) do nothing`,
        [input.conversationId, actor.userId]
      );
      return readPersonalAgentConversation(client, actor, input.conversationId);
    });

  const addPersonalAgentParticipant = async (
    actor: ActorContext,
    input: { conversationId: string; agentId: string; makeActive?: boolean }
  ) =>
    withTransaction(async (client) => {
      const agentResult = await client.query<{
        id: string;
        lifecycle: string;
        current_version: number;
      }>(
        `select id, lifecycle, current_version
       from personal_agent_identities
       where id = $1 and owner_user_id = $2
       for share`,
        [input.agentId, actor.userId]
      );
      const agent = agentResult.rows[0];
      if (!agent || agent.lifecycle !== "active") {
        throw Object.assign(new Error("Personal Agent is not available"), {
          code: "PERSONAL_AGENT_UNAVAILABLE"
        });
      }
      const session = await client.query<{ id: string }>(
        `select id from managed_conversation_executions where id = $1 and owner_user_id = $2 for share`,
        [input.conversationId, actor.userId]
      );
      if (!session.rows[0])
        throw new Error(
          "Conversation is not owned by the Personal Agent owner"
        );
      await client.query(
        `insert into personal_agent_conversations (conversation_id, owner_user_id)
       values ($1, $2) on conflict (conversation_id) do nothing`,
        [input.conversationId, actor.userId]
      );
      const state = await client.query<{ version: number }>(
        `select version from personal_agent_conversations
       where conversation_id = $1 and owner_user_id = $2 for update`,
        [input.conversationId, actor.userId]
      );
      const participant = await client.query(
        `insert into personal_agent_conversation_participants
         (conversation_id, owner_user_id, agent_id, ordinal)
       select $1, $2, $3, coalesce(max(ordinal) + 1, 0)
       from personal_agent_conversation_participants
       where conversation_id = $1 and owner_user_id = $2
       on conflict (conversation_id, agent_id) do nothing
       returning agent_id`,
        [input.conversationId, actor.userId, input.agentId]
      );
      const isParticipant =
        participant.rowCount === 1 ||
        Boolean(
          (
            await client.query(
              `select 1 from personal_agent_conversation_participants
       where conversation_id = $1 and owner_user_id = $2 and agent_id = $3`,
              [input.conversationId, actor.userId, input.agentId]
            )
          ).rows[0]
        );
      if (input.makeActive && isParticipant) {
        await client.query(
          `update personal_agent_conversations
            set active_agent_id = $3, version = version + 1, updated_at = now()
          where conversation_id = $1 and owner_user_id = $2`,
          [input.conversationId, actor.userId, input.agentId]
        );
      } else if (participant.rowCount === 1) {
        await client.query(
          `update personal_agent_conversations set version = version + 1, updated_at = now()
          where conversation_id = $1 and owner_user_id = $2`,
          [input.conversationId, actor.userId]
        );
      }
      const result = await readPersonalAgentConversation(
        client,
        actor,
        input.conversationId
      );
      if (!result)
        throw new Error(
          "Conversation is not owned by the Personal Agent owner"
        );
      return result;
    });

  const setActivePersonalAgentRespondent = async (
    actor: ActorContext,
    input: {
      conversationId: string;
      agentId: string | null;
      expectedVersion: number;
    }
  ) =>
    withTransaction(async (client) => {
      const state = await client.query<{ version: number }>(
        `select version from personal_agent_conversations
       where conversation_id = $1 and owner_user_id = $2 for update`,
        [input.conversationId, actor.userId]
      );
      const current = state.rows[0];
      if (!current)
        throw new Error("Personal Agent conversation state was not found");
      if (current.version !== input.expectedVersion) {
        throw Object.assign(new Error("Personal Agent conversation changed"), {
          code: "PERSONAL_AGENT_VERSION_CONFLICT"
        });
      }
      if (input.agentId !== null) {
        const selected = await client.query<{ lifecycle: string }>(
          `select i.lifecycle
         from personal_agent_conversation_participants p
         join personal_agent_identities i on i.id = p.agent_id and i.owner_user_id = p.owner_user_id
         where p.conversation_id = $1 and p.owner_user_id = $2 and p.agent_id = $3
         for share of i`,
          [input.conversationId, actor.userId, input.agentId]
        );
        if (!selected.rows[0] || selected.rows[0].lifecycle !== "active") {
          throw Object.assign(
            new Error("Active respondent must be an active participant"),
            { code: "PERSONAL_AGENT_UNAVAILABLE" }
          );
        }
      }
      await client.query(
        `update personal_agent_conversations
          set active_agent_id = $3, version = version + 1, updated_at = now()
        where conversation_id = $1 and owner_user_id = $2`,
        [input.conversationId, actor.userId, input.agentId]
      );
      const result = await readPersonalAgentConversation(
        client,
        actor,
        input.conversationId
      );
      if (!result)
        throw new Error("Personal Agent conversation state was not found");
      return result;
    });

  const createPersonalAgent = async (
    actor: ActorContext,
    input: CreatePersonalAgentInput
  ): Promise<PersonalAgentDetail> => {
    if ((input.defaultProvider === null) !== (input.defaultModel === null)) {
      throw new TypeError(
        "Default provider and model must both be set or both be null"
      );
    }
    if (
      input.defaultProvider === null &&
      input.defaultReasoningEffort != null
    ) {
      throw new TypeError(
        "Default reasoning effort must be null when no provider and model are saved"
      );
    }
    const created = await withTransaction(async (client) => {
      const fingerprint = requestFingerprint({
        operation: "create",
        ownerUserId: actor.userId,
        requestId: input.requestId,
        name: input.name,
        role: input.role ?? "",
        avatarReference: input.avatarReference ?? null,
        soulInstructions: input.soulInstructions,
        instructionSource: input.instructionSource,
        sourceTemplateId: input.sourceTemplateId ?? null,
        sourceTemplateVersion: input.sourceTemplateVersion ?? null,
        defaultProvider: input.defaultProvider,
        defaultModel: input.defaultModel,
        defaultReasoningEffort: input.defaultReasoningEffort ?? null
      });
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`personal-agent:create:${actor.userId}:${input.requestId}`]
      );
      const existing = await client.query<IdentityRow>(
        `select id, owner_user_id, name, role, avatar_reference, lifecycle,
            default_provider, default_model, default_reasoning_effort,
            current_version, creation_request_id, creation_request_fingerprint,
            retirement_request_id, retirement_request_fingerprint,
          restore_request_id, restore_request_fingerprint,
            created_at, updated_at, retired_at
         from personal_agent_identities
         where owner_user_id = $1 and creation_request_id = $2`,
        [actor.userId, input.requestId]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].creation_request_fingerprint !== fingerprint) {
          throw idempotencyConflict(
            "Personal Agent create request was reused with different input"
          );
        }
        return existing.rows[0];
      }
      const result = await client.query<IdentityRow>(
        `insert into personal_agent_identities
          (owner_user_id, name, role, avatar_reference, default_provider,
           default_model, default_reasoning_effort, creation_request_id,
           creation_request_fingerprint)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id, owner_user_id, name, role, avatar_reference, lifecycle,
           default_provider, default_model, default_reasoning_effort,
           current_version, creation_request_id, creation_request_fingerprint,
           retirement_request_id, retirement_request_fingerprint,
          restore_request_id, restore_request_fingerprint,
           created_at, updated_at, retired_at`,
        [
          actor.userId,
          input.name,
          input.role ?? "",
          input.avatarReference ?? null,
          input.defaultProvider,
          input.defaultModel,
          input.defaultReasoningEffort ?? null,
          input.requestId,
          fingerprint
        ]
      );
      const identityRow = result.rows[0];
      if (!identityRow)
        throw new Error("Personal Agent insert returned no row");
      await reserveName(client, actor.userId, identityRow.id, input.name);
      const versionRow = await insertVersion(client, actor, {
        agentId: identityRow.id,
        ownerUserId: actor.userId,
        version: 1,
        name: input.name,
        role: input.role ?? "",
        avatarReference: input.avatarReference ?? null,
        soulInstructions: input.soulInstructions,
        instructionSource: input.instructionSource,
        sourceTemplateId: input.sourceTemplateId ?? null,
        sourceTemplateVersion: input.sourceTemplateVersion ?? null,
        requestId: input.requestId,
        requestFingerprint: fingerprint,
        defaultProvider: input.defaultProvider,
        defaultModel: input.defaultModel,
        defaultReasoningEffort: input.defaultReasoningEffort ?? null
      });
      return identityRow;
    });
    return (await loadPersonalAgentDetail(actor, created.id))!;
  };

  const getPersonalAgent = async (
    actor: ActorContext,
    agentId: string
  ): Promise<PersonalAgentDetail | null> =>
    loadPersonalAgentDetail(actor, agentId);

  const listPersonalAgents = async (
    actor: ActorContext,
    input: { includeRetired?: boolean } = {}
  ): Promise<PersonalAgentIdentity[]> => {
    const result = await pool.query<IdentityRow>(
      `select id, owner_user_id, name, role, avatar_reference, lifecycle,
          default_provider, default_model, default_reasoning_effort,
          current_version, creation_request_id, creation_request_fingerprint,
          retirement_request_id, retirement_request_fingerprint,
          restore_request_id, restore_request_fingerprint,
          created_at, updated_at, retired_at
       from personal_agent_identities
       where owner_user_id = $1
         and ($2::boolean or lifecycle = 'active')
       order by updated_at desc, id desc`,
      [actor.userId, input.includeRetired ?? false]
    );
    return result.rows.map(mapIdentity);
  };

  const getPersonalAgentVersion = async (
    actor: ActorContext,
    input: { agentId: string; version: number }
  ): Promise<PersonalAgentIdentityVersion | null> => {
    const row = await selectVersion(pool, actor, input.agentId, input.version);
    return row ? hydrateVersion(pool, actor, row) : null;
  };

  const createPersonalAgentVersion = async (
    actor: ActorContext,
    input: CreatePersonalAgentVersionInput
  ): Promise<PersonalAgentIdentityVersion> =>
    withTransaction(async (client) => {
      const requestFingerprint = requestFingerprintForVersion(
        input,
        actor.userId
      );
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`personal-agent:version:${actor.userId}:${input.requestId}`]
      );
      const identityResult = await client.query<IdentityRow>(
        `select id, owner_user_id, name, role, avatar_reference, lifecycle,
            default_provider, default_model, default_reasoning_effort,
            current_version, creation_request_id, creation_request_fingerprint,
            retirement_request_id, retirement_request_fingerprint,
          restore_request_id, restore_request_fingerprint,
            created_at, updated_at, retired_at
         from personal_agent_identities
         where id = $1 and owner_user_id = $2
         for update`,
        [input.agentId, actor.userId]
      );
      const identityRow = identityResult.rows[0];
      if (!identityRow) throw new Error("Personal Agent was not found");
      const replay = await client.query<VersionRow>(
        `select id, agent_id, owner_user_id, version, name, role,
            avatar_reference, default_provider, default_model,
            default_reasoning_effort, soul_instructions, instruction_source,
            source_template_id, source_template_version,
            created_by_user_id, request_id, request_fingerprint, created_at
         from personal_agent_identity_versions
         where owner_user_id = $1 and request_id = $2`,
        [actor.userId, input.requestId]
      );
      if (replay.rows[0]) {
        if (
          replay.rows[0].agent_id !== input.agentId ||
          replay.rows[0].request_fingerprint !== requestFingerprint
        ) {
          throw idempotencyConflict(
            "Personal Agent version request was reused with different input"
          );
        }
        return mapVersion(
          replay.rows[0],
          await decryptSoul(client, actor, replay.rows[0].id)
        );
      }
      if (identityRow.lifecycle !== "active") throw retiredMutationError();
      assertPersonalAgentIsActive(mapIdentity(identityRow));
      if (
        input.expectedCurrentVersion !== undefined &&
        input.expectedCurrentVersion !== identityRow.current_version
      ) {
        throw new Error("Personal Agent version changed concurrently");
      }
      const nextVersion = identityRow.current_version + 1;
      const versionRow = await insertVersion(client, actor, {
        agentId: input.agentId,
        ownerUserId: actor.userId,
        version: nextVersion,
        name: input.name,
        role: input.role ?? "",
        avatarReference: input.avatarReference ?? null,
        soulInstructions: input.soulInstructions,
        instructionSource: input.instructionSource,
        sourceTemplateId: input.sourceTemplateId ?? null,
        sourceTemplateVersion: input.sourceTemplateVersion ?? null,
        requestId: input.requestId,
        requestFingerprint,
        defaultProvider: identityRow.default_provider,
        defaultModel: identityRow.default_model,
        defaultReasoningEffort: identityRow.default_reasoning_effort
      });
      await client.query(
        `update personal_agent_identities
            set name = $3, role = $4, avatar_reference = $5,
                current_version = $6, updated_at = now()
          where id = $1 and owner_user_id = $2`,
        [
          input.agentId,
          actor.userId,
          input.name,
          input.role ?? "",
          input.avatarReference ?? null,
          nextVersion
        ]
      );
      return mapVersion(versionRow, input.soulInstructions);
    });

  const updatePersonalAgent = async (
    actor: ActorContext,
    input: {
      agentId: string;
      requestId: string;
      expectedVersion: number;
      name?: string;
      role?: string | null;
      avatarReference?: string | null;
      soulInstructions?: string;
      defaultProvider?: string | null;
      defaultModel?: string | null;
      defaultReasoningEffort?: string | null;
      sourceTemplateId?: string | null;
      sourceTemplateVersion?: number | null;
    }
  ): Promise<PersonalAgentDetail | null> => {
    const updateFingerprint = requestFingerprint({
      operation: "update",
      ownerUserId: actor.userId,
      agentId: input.agentId,
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.avatarReference !== undefined
        ? { avatarReference: input.avatarReference }
        : {}),
      ...(input.soulInstructions !== undefined
        ? { soulInstructions: input.soulInstructions }
        : {}),
      ...(input.defaultProvider !== undefined
        ? { defaultProvider: input.defaultProvider }
        : {}),
      ...(input.defaultModel !== undefined
        ? { defaultModel: input.defaultModel }
        : {}),
      ...(input.defaultReasoningEffort !== undefined
        ? { defaultReasoningEffort: input.defaultReasoningEffort }
        : {}),
      ...(input.sourceTemplateId !== undefined
        ? { sourceTemplateId: input.sourceTemplateId }
        : {}),
      ...(input.sourceTemplateVersion !== undefined
        ? { sourceTemplateVersion: input.sourceTemplateVersion }
        : {})
    });
    const agentId = await withTransaction(async (client) => {
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`personal-agent:update:${actor.userId}:${input.requestId}`]
      );
      const result = await client.query<IdentityRow>(
        `select id, owner_user_id, name, role, avatar_reference, lifecycle,
            default_provider, default_model, default_reasoning_effort,
            current_version, creation_request_id, creation_request_fingerprint,
            retirement_request_id, retirement_request_fingerprint,
          restore_request_id, restore_request_fingerprint,
            created_at, updated_at, retired_at
         from personal_agent_identities
         where id = $1 and owner_user_id = $2
         for update`,
        [input.agentId, actor.userId]
      );
      const row = result.rows[0];
      if (!row) return null;
      const existing = await client.query<VersionRow>(
        `select id, agent_id, owner_user_id, version, name, role,
            avatar_reference, default_provider, default_model,
            default_reasoning_effort, soul_instructions, instruction_source,
            source_template_id, source_template_version,
            created_by_user_id, request_id, request_fingerprint, created_at
         from personal_agent_identity_versions
         where owner_user_id = $1 and request_id = $2`,
        [actor.userId, input.requestId]
      );
      if (existing.rows[0]) {
        if (
          existing.rows[0].agent_id !== input.agentId ||
          existing.rows[0].request_fingerprint !== updateFingerprint
        ) {
          throw idempotencyConflict(
            "Personal Agent update request was reused with different input"
          );
        }
        return row.id;
      }
      if (row.current_version !== input.expectedVersion) {
        throw Object.assign(new Error("Personal Agent version is stale"), {
          code: "STALE_VERSION"
        });
      }
      if (row.lifecycle !== "active") throw retiredMutationError();
      assertPersonalAgentIsActive(mapIdentity(row));
      const currentVersion = await selectVersion(
        client,
        actor,
        input.agentId,
        row.current_version
      );
      if (!currentVersion)
        throw new Error("Current Personal Agent version is missing");
      const soulInstructions =
        input.soulInstructions ??
        (await decryptSoul(client, actor, currentVersion.id));
      const nextName = input.name ?? row.name;
      const nextProvider =
        input.defaultProvider !== undefined
          ? input.defaultProvider
          : row.default_provider;
      const nextModel =
        input.defaultModel !== undefined
          ? input.defaultModel
          : row.default_model;
      const nextEffort =
        input.defaultReasoningEffort !== undefined
          ? input.defaultReasoningEffort
          : row.default_reasoning_effort;
      if ((nextProvider === null) !== (nextModel === null)) {
        throw new TypeError(
          "Default provider and model must both be set or both be cleared"
        );
      }
      if (nextProvider === null && nextEffort !== null) {
        throw new TypeError(
          "Default reasoning effort must be null when no provider and model are saved"
        );
      }
      await reserveName(client, actor.userId, input.agentId, nextName);
      const versionRow = await insertVersion(client, actor, {
        agentId: input.agentId,
        ownerUserId: actor.userId,
        version: row.current_version + 1,
        name: nextName,
        role: input.role !== undefined ? (input.role ?? "") : row.role,
        avatarReference:
          input.avatarReference !== undefined
            ? input.avatarReference
            : row.avatar_reference,
        soulInstructions,
        instructionSource: input.soulInstructions
          ? "custom"
          : currentVersion.instruction_source,
        sourceTemplateId:
          input.sourceTemplateId !== undefined
            ? input.sourceTemplateId
            : (currentVersion.source_template_id ?? null),
        sourceTemplateVersion:
          input.sourceTemplateVersion !== undefined
            ? input.sourceTemplateVersion
            : (currentVersion.source_template_version ?? null),
        requestId: input.requestId,
        requestFingerprint: updateFingerprint,
        defaultProvider: nextProvider,
        defaultModel: nextModel,
        defaultReasoningEffort: nextEffort
      });
      await client.query(
        `update personal_agent_identities
            set name = $3, role = $4, avatar_reference = $5,
                default_provider = $6, default_model = $7,
                default_reasoning_effort = $8, current_version = $9,
                updated_at = now()
          where id = $1 and owner_user_id = $2`,
        [
          input.agentId,
          actor.userId,
          versionRow.name,
          versionRow.role,
          versionRow.avatar_reference,
          nextProvider,
          nextModel,
          nextEffort,
          versionRow.version
        ]
      );
      return row.id;
    });
    return agentId ? loadPersonalAgentDetail(actor, agentId) : null;
  };

  const retirePersonalAgent = async (input: {
    actor: ActorContext;
    agentId: string;
    requestId: string;
    expectedVersion: number;
  }): Promise<PersonalAgentIdentity | null> =>
    withTransaction(async (client) => {
      const retirementFingerprint = requestFingerprint({
        operation: "retire",
        ownerUserId: input.actor.userId,
        agentId: input.agentId,
        requestId: input.requestId,
        expectedVersion: input.expectedVersion
      });
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`personal-agent:retire:${input.actor.userId}:${input.requestId}`]
      );
      const current = await client.query<IdentityRow>(
        `select id, owner_user_id, name, role, avatar_reference, lifecycle,
            default_provider, default_model, default_reasoning_effort,
            current_version, creation_request_id, creation_request_fingerprint,
            retirement_request_id, retirement_request_fingerprint,
          restore_request_id, restore_request_fingerprint,
            created_at, updated_at, retired_at
         from personal_agent_identities
         where id = $1 and owner_user_id = $2
         for update`,
        [input.agentId, input.actor.userId]
      );
      const currentRow = current.rows[0];
      if (!currentRow) return null;
      if (currentRow.retirement_request_id === input.requestId) {
        if (
          currentRow.retirement_request_fingerprint !== retirementFingerprint
        ) {
          throw idempotencyConflict(
            "Personal Agent retirement request was reused with different input"
          );
        }
        return mapIdentity(currentRow);
      }
      if (currentRow.current_version !== input.expectedVersion) {
        throw Object.assign(new Error("Personal Agent version is stale"), {
          code: "STALE_VERSION"
        });
      }
      if (currentRow.lifecycle !== "active") {
        throw new Error("Personal Agent is already retired");
      }
      const result = await client.query<IdentityRow>(
        `update personal_agent_identities
            set lifecycle = 'retired', retired_at = now(),
                retirement_request_id = $3,
                retirement_request_fingerprint = $4, updated_at = now()
          where id = $1 and owner_user_id = $2 and lifecycle = 'active'
         returning id, owner_user_id, name, role, avatar_reference, lifecycle,
           default_provider, default_model, default_reasoning_effort,
           current_version, creation_request_id, creation_request_fingerprint,
           retirement_request_id, retirement_request_fingerprint,
          restore_request_id, restore_request_fingerprint,
           created_at, updated_at, retired_at`,
        [
          input.agentId,
          input.actor.userId,
          input.requestId,
          retirementFingerprint
        ]
      );
      return result.rows[0] ? mapIdentity(result.rows[0]) : null;
    });

  const restorePersonalAgent = async (input: {
    actor: ActorContext;
    agentId: string;
    requestId: string;
    expectedVersion: number;
  }): Promise<PersonalAgentIdentity | null> =>
    withTransaction(async (client) => {
      const restoreFingerprint = requestFingerprint({
        operation: "restore",
        ownerUserId: input.actor.userId,
        agentId: input.agentId,
        requestId: input.requestId,
        expectedVersion: input.expectedVersion
      });
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`personal-agent:restore:${input.actor.userId}:${input.requestId}`]
      );
      const replay = await client.query<IdentityRow>(
        `select id, owner_user_id, name, role, avatar_reference, lifecycle,
            default_provider, default_model, default_reasoning_effort,
            current_version, creation_request_id, creation_request_fingerprint,
            retirement_request_id, retirement_request_fingerprint,
            restore_request_id, restore_request_fingerprint,
            created_at, updated_at, retired_at
         from personal_agent_identities
         where owner_user_id = $1 and restore_request_id = $2
         for update`,
        [input.actor.userId, input.requestId]
      );
      if (replay.rows[0]) {
        if (
          replay.rows[0].id !== input.agentId ||
          replay.rows[0].restore_request_fingerprint !== restoreFingerprint
        ) {
          throw idempotencyConflict(
            "Personal Agent restore request was reused with different input"
          );
        }
        return mapIdentity(replay.rows[0]);
      }
      const current = await client.query<IdentityRow>(
        `select id, owner_user_id, name, role, avatar_reference, lifecycle,
            default_provider, default_model, default_reasoning_effort,
            current_version, creation_request_id, creation_request_fingerprint,
            retirement_request_id, retirement_request_fingerprint,
            restore_request_id, restore_request_fingerprint,
            created_at, updated_at, retired_at
         from personal_agent_identities
         where id = $1 and owner_user_id = $2
         for update`,
        [input.agentId, input.actor.userId]
      );
      const row = current.rows[0];
      if (!row) return null;
      if (row.current_version !== input.expectedVersion) {
        throw Object.assign(new Error("Personal Agent version is stale"), {
          code: "STALE_VERSION"
        });
      }
      if (row.lifecycle !== "retired") {
        throw Object.assign(new Error("Personal Agent is already active"), {
          code: "PERSONAL_AGENT_NOT_RETIRED"
        });
      }
      const restored = await client.query<IdentityRow>(
        `update personal_agent_identities
            set lifecycle = 'active', retired_at = null,
                restore_request_id = $3, restore_request_fingerprint = $4,
                updated_at = now()
          where id = $1 and owner_user_id = $2 and lifecycle = 'retired'
         returning id, owner_user_id, name, role, avatar_reference, lifecycle,
           default_provider, default_model, default_reasoning_effort,
           current_version, creation_request_id, creation_request_fingerprint,
           retirement_request_id, retirement_request_fingerprint,
           restore_request_id, restore_request_fingerprint,
           created_at, updated_at, retired_at`,
        [input.agentId, input.actor.userId, input.requestId, restoreFingerprint]
      );
      return restored.rows[0] ? mapIdentity(restored.rows[0]) : null;
    });

  const createPersonalAgentExecutionJob = async (
    actor: ActorContext,
    input: PersonalAgentExecutionJobInput
  ): Promise<PersonalAgentExecutionJob> =>
    withTransaction(async (client) => {
      const conversation = await client.query<{ id: string }>(
        `select id from managed_conversation_executions where id = $1 and owner_user_id = $2 limit 1`,
        [input.conversationId, actor.userId]
      );
      if (!conversation.rows[0]) {
        throw new Error(
          "Conversation is not owned by the Personal Agent owner"
        );
      }
      await validateAttribution(client, actor, input.attribution, true);
      const result = await client.query<JobRow>(
        `insert into personal_agent_execution_jobs
        (owner_user_id, conversation_id, command_id, attribution_kind, agent_id, agent_version, title, project_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, owner_user_id, conversation_id, command_id, title, project_id,
         output_reference, version, last_observed_at, attribution_kind, agent_id,
         agent_version, state, attempts_started, attempts_succeeded,
         attempts_failed, attempts_canceled, attempts_interrupted,
         last_attempt_id, created_at, updated_at`,
        [
          actor.userId,
          input.conversationId,
          input.commandId ?? null,
          input.attribution.kind,
          input.attribution.agentId,
          input.attribution.agentVersion,
          "Agent task",
          input.projectId ?? null
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Personal Agent job insert returned no row");
      return mapJob(row);
    });

  const recordPersonalAgentTurnOutput = async (input: {
    actor: ActorContext;
    jobId: string;
    attemptId: string;
    outputText: string;
    outputReference: PersonalAgentJobOutputReference;
    eventId?: string;
    observedAt?: string;
  }): Promise<PersonalAgentExecutionJob> => {
    const refs = input.outputReference.runtimeItemIds;
    const outputText = input.outputText.trim();
    if (
      !outputText ||
      Buffer.byteLength(outputText, "utf8") > 65_536 ||
      refs.length < 1 ||
      refs.length > 128 ||
      refs.some(
        (id) => typeof id !== "string" || id.length < 1 || id.length > 256
      ) ||
      new Set(refs).size !== refs.length
    ) {
      throw new TypeError("Personal Agent output references are invalid");
    }
    const outputDigest = requestFingerprint({ outputText });
    const observedAt = input.observedAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(observedAt))) {
      throw new TypeError("Personal Agent output observation time is invalid");
    }
    return withTransaction(async (client) => {
      const result = await client.query<JobRow>(
        `select id, owner_user_id, conversation_id, command_id, title, project_id,
            output_reference, version, last_observed_at, attribution_kind, agent_id,
            agent_version, state, attempts_started, attempts_succeeded,
            attempts_failed, attempts_canceled, attempts_interrupted,
            last_attempt_id, created_at, updated_at
         from personal_agent_execution_jobs
         where id = $1 and owner_user_id = $2
         for update`,
        [input.jobId, input.actor.userId]
      );
      const jobRow = result.rows[0];
      if (!jobRow) throw new Error("Personal Agent job was not found");
      const attempt = await client.query<AttemptRow>(
        `select id, owner_user_id, job_id, command_id, attempt_number, attribution_kind,
            agent_id, agent_version, provider, model, ai_client_instance_id,
            reasoning_effort, permission_mode, managed_execution_id,
            managed_execution_generation, status, outcome, started_at,
            phase, phase_observed_at, completed_at
         from personal_agent_execution_attempts
         where id = $1 and job_id = $2 and owner_user_id = $3`,
        [input.attemptId, input.jobId, input.actor.userId]
      );
      if (!attempt.rows[0])
        throw new Error("Personal Agent attempt was not found");
      const eventId = input.eventId ?? `output:${input.attemptId}`;
      const event = await client.query<{
        payload: {
          attemptId?: string;
          runtimeItemIds?: string[];
          outputDigest?: string;
        };
      }>(
        `select payload from personal_agent_execution_job_events
         where owner_user_id = $1 and job_id = $2 and event_id = $3`,
        [input.actor.userId, input.jobId, eventId]
      );
      if (event.rows[0]) {
        if (
          (event.rows[0].payload.attemptId !== undefined
            ? event.rows[0].payload.attemptId !== input.attemptId
            : eventId !== `output:${input.attemptId}`) ||
          event.rows[0].payload.outputDigest !== outputDigest ||
          JSON.stringify(event.rows[0].payload.runtimeItemIds) !==
            JSON.stringify(refs)
        ) {
          throw idempotencyConflict(
            "Personal Agent output event was reused with different references"
          );
        }
        return mapJob(jobRow);
      }
      await assertCurrentRunningPersonalAgentAttempt(
        client,
        jobRow,
        attempt.rows[0]
      );
      const previousReference = jobRow.output_reference;
      const attemptOutputs = [...(previousReference?.attemptOutputs ?? [])];
      const priorAttemptOutput = attemptOutputs.find(
        (entry) => entry.attemptId === input.attemptId
      );
      if (
        priorAttemptOutput &&
        JSON.stringify(priorAttemptOutput.runtimeItemIds) !==
          JSON.stringify(refs)
      ) {
        throw idempotencyConflict(
          "Personal Agent attempt output was already recorded"
        );
      }
      const existingOutput = await decryptTurnOutput(
        client,
        input.actor,
        input.attemptId
      );
      if (
        existingOutput !== null &&
        requestFingerprint({ outputText: existingOutput }) !== outputDigest
      ) {
        throw idempotencyConflict(
          "Personal Agent attempt output was already recorded"
        );
      }
      if (existingOutput === null) {
        await encryptTurnOutput(
          client,
          input.actor,
          input.jobId,
          input.attemptId,
          outputText
        );
      }
      if (!priorAttemptOutput) {
        if (attemptOutputs.length >= 100) {
          throw idempotencyConflict(
            "Personal Agent output history limit was reached"
          );
        }
        attemptOutputs.push({
          attemptId: input.attemptId,
          runtimeItemIds: refs
        });
      }
      const legacyRuntimeItemIds =
        previousReference?.legacyRuntimeItemIds ??
        (previousReference?.runtimeItemIds?.length &&
        !previousReference.attemptOutputs?.length
          ? previousReference.runtimeItemIds
          : undefined);
      const nextReference: PersonalAgentJobOutputReference = {
        runtimeItemIds: refs,
        attemptOutputs,
        ...(legacyRuntimeItemIds ? { legacyRuntimeItemIds } : {})
      };
      const sequence = await client.query<{ sequence: number }>(
        `select coalesce(max(sequence), 0) + 1 as sequence
         from personal_agent_execution_job_events where owner_user_id = $1 and job_id = $2`,
        [input.actor.userId, input.jobId]
      );
      await client.query(
        `insert into personal_agent_execution_job_events
           (owner_user_id, job_id, sequence, event_id, event_type, payload, observed_at)
         values ($1, $2, $3, $4, 'assistant_output_recorded', $5::jsonb, $6)`,
        [
          input.actor.userId,
          input.jobId,
          sequence.rows[0]!.sequence,
          eventId,
          JSON.stringify({
            attemptId: input.attemptId,
            runtimeItemIds: refs,
            outputDigest
          }),
          observedAt
        ]
      );
      const updated = await client.query<JobRow>(
        `update personal_agent_execution_jobs
            set output_reference = $3::jsonb, version = version + 1,
                last_observed_at = $4, updated_at = now()
          where id = $1 and owner_user_id = $2
          returning id, owner_user_id, conversation_id, command_id, title, project_id,
            output_reference, version, last_observed_at, attribution_kind, agent_id,
            agent_version, state, attempts_started, attempts_succeeded,
            attempts_failed, attempts_canceled, attempts_interrupted,
            last_attempt_id, created_at, updated_at`,
        [
          input.jobId,
          input.actor.userId,
          JSON.stringify(nextReference),
          observedAt
        ]
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new Error("Personal Agent output update failed");
      return mapJob(updatedRow);
    });
  };

  const getPersonalAgentTurnOutput = async (
    actor: ActorContext,
    input: { jobId: string }
  ): Promise<string | null> => {
    const job = await pool.query<{
      id: string;
      output_reference: PersonalAgentJobOutputReference | null;
    }>(
      `select id, output_reference from personal_agent_execution_jobs
       where id = $1 and owner_user_id = $2`,
      [input.jobId, actor.userId]
    );
    if (!job.rows[0]) return null;
    const reference = job.rows[0].output_reference;
    if (!reference?.runtimeItemIds?.length) return null;
    const policySnapshot =
      await loadConversationPresentationPolicySnapshot(pool);
    const presentation = decideConversationItemPresentation({
      sourceKind: "managed_runtime",
      sourceAdapterVersion: "managed-runtime-v1",
      lookupItemTypes: ["transient_output"],
      policyRevision: policySnapshot.revision,
      rules: policySnapshot.rules
    });
    if (presentation.mode === "hidden" || presentation.renderer !== "message") {
      return null;
    }
    const outputTexts: string[] = [];
    if (reference.legacyRuntimeItemIds?.length) {
      const legacy = await decryptTurnOutput(pool, actor, input.jobId);
      if (legacy) outputTexts.push(legacy);
    } else if (!reference.attemptOutputs?.length) {
      const legacy = await decryptTurnOutput(pool, actor, input.jobId);
      if (legacy) outputTexts.push(legacy);
    }
    for (const entry of reference.attemptOutputs ?? []) {
      const output = await decryptTurnOutput(pool, actor, entry.attemptId);
      if (output) outputTexts.push(output);
    }
    if (!outputTexts.length) return null;
    const joined = outputTexts.join("\n\n");
    if (Buffer.byteLength(joined, "utf8") <= 262_144) return joined;
    let bounded = joined;
    while (Buffer.byteLength(bounded, "utf8") > 262_144) {
      bounded = bounded.slice(0, Math.max(0, bounded.length - 1024));
    }
    return bounded;
  };

  const getPersonalAgentExecutionJob = async (
    actor: ActorContext,
    jobId: string
  ): Promise<PersonalAgentExecutionJob | null> => {
    const result = await pool.query<JobRow>(
      `select id, owner_user_id, conversation_id, command_id, title, project_id,
          output_reference, version, last_observed_at, attribution_kind, agent_id,
          agent_version, state, attempts_started, attempts_succeeded,
          attempts_failed, attempts_canceled, attempts_interrupted,
          last_attempt_id, created_at, created_at::text as created_at_cursor, updated_at
       from personal_agent_execution_jobs
       where id = $1 and owner_user_id = $2`,
      [jobId, actor.userId]
    );
    if (!result.rows[0]) return null;
    return (await withAuthorizedJobTitles(actor, [mapJob(result.rows[0])]))[0]!;
  };

  const assertCurrentRunningPersonalAgentAttempt = async (
    client: pg.PoolClient,
    job: JobRow,
    attempt: Pick<
      AttemptRow,
      "id" | "status" | "managed_execution_id" | "managed_execution_generation"
    >
  ): Promise<void> => {
    const execution = await client.query<{ execution_generation: number }>(
      `select execution_generation from managed_conversation_executions
       where id = $1 and owner_user_id = $2
       for share`,
      [job.conversation_id, job.owner_user_id]
    );
    if (
      job.last_attempt_id !== attempt.id ||
      attempt.status !== "running" ||
      attempt.managed_execution_id !== job.conversation_id ||
      attempt.managed_execution_generation !==
        execution.rows[0]?.execution_generation
    ) {
      throw Object.assign(
        new Error("Personal Agent attempt is not current for this execution"),
        { code: "PERSONAL_AGENT_STATE_CONFLICT" }
      );
    }
  };

  const listPersonalAgentExecutionJobs = async (
    actor: ActorContext,
    input: {
      conversationId?: string;
      agentId?: string;
      limit?: number;
      before?: string;
    } = {}
  ): Promise<PersonalAgentExecutionJobPage> => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const cursor = input.before ? decodeCursor(input.before) : null;
    const result = await pool.query<JobRow>(
      `select id, owner_user_id, conversation_id, command_id, title, project_id,
          output_reference, version, last_observed_at, attribution_kind, agent_id,
          agent_version, state, attempts_started, attempts_succeeded,
          attempts_failed, attempts_canceled, attempts_interrupted,
          last_attempt_id, created_at, created_at::text as created_at_cursor,
          updated_at
       from personal_agent_execution_jobs
       where owner_user_id = $1
         and ($2::uuid is null or conversation_id = $2)
         and ($3::uuid is null or agent_id = $3)
         and ($4::timestamptz is null or (created_at, id) < ($4, $5))
       order by created_at desc, id desc
       limit $6`,
      [
        actor.userId,
        input.conversationId ?? null,
        input.agentId ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1
      ]
    );
    const rows = result.rows.slice(0, limit);
    return {
      jobs: await withAuthorizedJobTitles(actor, rows.map(mapJob)),
      hasMore: result.rows.length > limit,
      nextCursor:
        result.rows.length > limit
          ? encodeCursor(
              rows.at(-1)!.created_at_cursor ?? rows.at(-1)!.created_at,
              rows.at(-1)!.id
            )
          : null
    };
  };

  const countPersonalAgentExecutionJobs = async (
    actor: ActorContext,
    input: {
      conversationId?: string;
      state?: PersonalAgentExecutionJob["state"];
    } = {}
  ): Promise<number> => {
    const result = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from personal_agent_execution_jobs
       where owner_user_id = $1
         and ($2::uuid is null or conversation_id = $2)
         and ($3::text is null or state = $3)`,
      [actor.userId, input.conversationId ?? null, input.state ?? null]
    );
    return Number(result.rows[0]?.count ?? 0);
  };

  const createPersonalAgentExecutionAttempt = async (
    actor: ActorContext,
    input: PersonalAgentExecutionAttemptInput
  ): Promise<PersonalAgentExecutionAttempt> =>
    withTransaction(async (client) => {
      const jobResult = await client.query<JobRow>(
        `select id, owner_user_id, conversation_id, command_id, title, project_id,
            output_reference, version, last_observed_at, attribution_kind, agent_id,
            agent_version, state, attempts_started, attempts_succeeded,
            attempts_failed, attempts_canceled, attempts_interrupted,
            last_attempt_id, created_at, updated_at
         from personal_agent_execution_jobs
         where id = $1 and owner_user_id = $2
         for update`,
        [input.jobId, actor.userId]
      );
      const jobRow = jobResult.rows[0];
      if (!jobRow) throw new Error("Personal Agent job was not found");
      const job = mapJob(jobRow);
      if (
        job.attribution.kind !== input.attribution.kind ||
        job.attribution.agentId !== input.attribution.agentId ||
        job.attribution.agentVersion !== input.attribution.agentVersion
      ) {
        throw new Error("Attempt attribution does not match its job");
      }
      const attempt = parsePersonalAgentExecutionAttempt({
        contractVersion: 1,
        id: randomUUID(),
        ownerUserId: actor.userId,
        jobId: input.jobId,
        commandId: input.commandId ?? null,
        attemptNumber: input.attemptNumber,
        attribution: input.attribution,
        provider: input.provider,
        model: input.model,
        aiClientInstanceId: input.aiClientInstanceId,
        reasoningEffort: input.reasoningEffort,
        permissionMode: input.permissionMode,
        managedExecutionId: input.managedExecutionId,
        managedExecutionGeneration: input.managedExecutionGeneration,
        status: input.status,
        outcome: input.outcome,
        startedAt: input.startedAt,
        completedAt: input.completedAt
      });
      assertPersonalAgentAttemptRuntimeIdentity(attempt);
      // A command is the idempotency boundary for a provider turn. The runner
      // may retry after the attempt transaction committed but its response was
      // lost; its refreshed Job counters then suggest the next attempt number.
      // Look up this exact command before attempt-number replay so that retry
      // cannot collide with the command unique index or create another attempt.
      if (attempt.commandId) {
        const commandAttemptResult = await client.query<AttemptRow>(
          `select id, owner_user_id, job_id, command_id, attempt_number,
              attribution_kind, agent_id, agent_version, provider, model,
              ai_client_instance_id, reasoning_effort, permission_mode,
              managed_execution_id, managed_execution_generation, status,
              outcome, started_at, phase, phase_observed_at, completed_at
           from personal_agent_execution_attempts
           where owner_user_id = $1 and command_id = $2
           limit 1`,
          [actor.userId, attempt.commandId]
        );
        const commandAttemptRow = commandAttemptResult.rows[0];
        if (commandAttemptRow) {
          const existing = mapAttempt(commandAttemptRow);
          const sameCommandBinding =
            existing.jobId === attempt.jobId &&
            existing.commandId === attempt.commandId &&
            existing.attribution.kind === attempt.attribution.kind &&
            existing.attribution.agentId === attempt.attribution.agentId &&
            existing.attribution.agentVersion ===
              attempt.attribution.agentVersion &&
            existing.provider === attempt.provider &&
            existing.model === attempt.model &&
            existing.aiClientInstanceId === attempt.aiClientInstanceId &&
            existing.reasoningEffort === attempt.reasoningEffort &&
            existing.permissionMode === attempt.permissionMode &&
            existing.managedExecutionId === attempt.managedExecutionId &&
            existing.managedExecutionGeneration ===
              attempt.managedExecutionGeneration;
          if (!sameCommandBinding) {
            throw idempotencyConflict(
              "Personal Agent command was reused with different attempt input"
            );
          }
          return existing;
        }
      }
      const existingAttempt = await client.query<AttemptRow>(
        `select id, owner_user_id, job_id, command_id, attempt_number, attribution_kind,
            agent_id, agent_version, provider, model, ai_client_instance_id,
            reasoning_effort, permission_mode, managed_execution_id,
            managed_execution_generation, status, outcome, started_at,
            phase, phase_observed_at, completed_at
         from personal_agent_execution_attempts
         where owner_user_id = $1 and job_id = $2 and attempt_number = $3`,
        [actor.userId, attempt.jobId, attempt.attemptNumber]
      );
      if (existingAttempt.rows[0]) {
        const existing = mapAttempt(existingAttempt.rows[0]);
        const comparable = (value: PersonalAgentExecutionAttempt) => ({
          jobId: value.jobId,
          commandId: value.commandId,
          attemptNumber: value.attemptNumber,
          attribution: value.attribution,
          provider: value.provider,
          model: value.model,
          aiClientInstanceId: value.aiClientInstanceId,
          reasoningEffort: value.reasoningEffort,
          permissionMode: value.permissionMode,
          managedExecutionId: value.managedExecutionId,
          managedExecutionGeneration: value.managedExecutionGeneration,
          status: value.status,
          outcome: value.outcome,
          startedAt: value.startedAt,
          completedAt: value.completedAt
        });
        if (
          JSON.stringify(comparable(existing)) !==
          JSON.stringify(comparable(attempt))
        ) {
          throw idempotencyConflict(
            "Personal Agent attempt number was reused with different input"
          );
        }
        return existing;
      }
      if (input.managedExecutionId !== null) {
        if (input.managedExecutionId !== job.conversationId) {
          throw Object.assign(
            new Error(
              "Attempt execution does not match its Personal Agent job"
            ),
            { code: "PERSONAL_AGENT_STATE_CONFLICT" }
          );
        }
        const execution = await client.query<{
          id: string;
          execution_generation: number;
        }>(
          `select id, execution_generation
           from managed_conversation_executions
           where id = $1 and owner_user_id = $2
           for share`,
          [job.conversationId, actor.userId]
        );
        if (!execution.rows[0]) {
          throw new Error(
            "Managed execution is not owned by the Personal Agent owner"
          );
        }
        if (
          input.managedExecutionGeneration !==
          execution.rows[0].execution_generation
        ) {
          throw Object.assign(
            new Error("Attempt execution generation is stale"),
            { code: "PERSONAL_AGENT_STATE_CONFLICT" }
          );
        }
      }
      await validateAttribution(client, actor, input.attribution, true);
      const result = await client.query<AttemptRow>(
        `insert into personal_agent_execution_attempts
          (id, owner_user_id, job_id, command_id, attempt_number, attribution_kind,
           agent_id, agent_version, provider, model, ai_client_instance_id,
           reasoning_effort, permission_mode, managed_execution_id,
           managed_execution_generation, status, outcome, started_at,
           phase, phase_observed_at, completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18, 'working', $18, $19)
         returning id, owner_user_id, job_id, command_id, attempt_number,
           attribution_kind, agent_id, agent_version, provider, model,
           ai_client_instance_id, reasoning_effort, permission_mode,
           managed_execution_id, managed_execution_generation, status,
           outcome, started_at, phase, phase_observed_at, completed_at`,
        [
          attempt.id,
          actor.userId,
          attempt.jobId,
          attempt.commandId,
          attempt.attemptNumber,
          attempt.attribution.kind,
          attempt.attribution.agentId,
          attempt.attribution.agentVersion,
          attempt.provider,
          attempt.model,
          attempt.aiClientInstanceId,
          attempt.reasoningEffort,
          attempt.permissionMode,
          attempt.managedExecutionId,
          attempt.managedExecutionGeneration,
          attempt.status,
          attempt.outcome,
          attempt.startedAt,
          attempt.completedAt
        ]
      );
      const row = result.rows[0];
      if (!row)
        throw new Error("Personal Agent attempt insert returned no row");
      const startedEventId = `attempt:${attempt.id}:started`;
      const sequenceResult = await client.query<{ sequence: number }>(
        `select coalesce(max(sequence), 0) + 1 as sequence
         from personal_agent_execution_job_events where owner_user_id = $1 and job_id = $2`,
        [actor.userId, input.jobId]
      );
      await client.query(
        `insert into personal_agent_execution_job_events
           (owner_user_id, job_id, sequence, event_id, execution_generation,
            event_type, payload, observed_at)
         values ($1, $2, $3, $4, $5, 'attempt_started', $6::jsonb, $7)`,
        [
          actor.userId,
          input.jobId,
          sequenceResult.rows[0]!.sequence,
          startedEventId,
          attempt.managedExecutionGeneration,
          JSON.stringify({
            attemptId: attempt.id,
            attemptNumber: attempt.attemptNumber
          }),
          attempt.startedAt
        ]
      );
      await client.query(
        `update personal_agent_execution_jobs
            set state = 'running', attempts_started = attempts_started + 1,
                last_attempt_id = $3,
                version = version + 1, last_observed_at = $4, updated_at = now()
          where id = $1 and owner_user_id = $2`,
        [input.jobId, actor.userId, attempt.id, attempt.startedAt]
      );
      return mapAttempt(row);
    });

  const completePersonalAgentExecutionAttempt = async (input: {
    actor: ActorContext;
    jobId: string;
    attemptId: string;
    outcome: PersonalAgentAttemptOutcome;
    jobState?: "waiting";
    eventId?: string;
    observedAt?: string;
  }): Promise<{
    attempt: PersonalAgentExecutionAttempt;
    job: PersonalAgentExecutionJob;
    replayed: boolean;
  }> => {
    const completedAt = input.observedAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(completedAt))) {
      throw new TypeError("Personal Agent attempt completion time is invalid");
    }
    const eventId = input.eventId ?? `attempt:${input.attemptId}:completed`;
    return withTransaction(async (client) => {
      const jobResult = await client.query<JobRow>(
        `select id, owner_user_id, conversation_id, command_id, title, project_id,
            output_reference, version, last_observed_at, attribution_kind, agent_id,
            agent_version, state, attempts_started, attempts_succeeded,
            attempts_failed, attempts_canceled, attempts_interrupted,
            last_attempt_id, created_at, updated_at
         from personal_agent_execution_jobs
         where id = $1 and owner_user_id = $2 for update`,
        [input.jobId, input.actor.userId]
      );
      const job = jobResult.rows[0];
      if (!job) throw new Error("Personal Agent job was not found");
      const attemptResult = await client.query<AttemptRow>(
        `select id, owner_user_id, job_id, command_id, attempt_number, attribution_kind,
            agent_id, agent_version, provider, model, ai_client_instance_id,
            reasoning_effort, permission_mode, managed_execution_id,
            managed_execution_generation, status, outcome, started_at,
            phase, phase_observed_at, completed_at
         from personal_agent_execution_attempts
         where id = $1 and job_id = $2 and owner_user_id = $3 for update`,
        [input.attemptId, input.jobId, input.actor.userId]
      );
      const attemptRow = attemptResult.rows[0];
      if (!attemptRow) throw new Error("Personal Agent attempt was not found");
      const attempt = mapAttempt(attemptRow);
      const previousEvent = await client.query<{
        payload: { attemptId?: string; outcome?: string; jobState?: string };
      }>(
        `select payload from personal_agent_execution_job_events
         where owner_user_id = $1 and job_id = $2 and event_id = $3`,
        [input.actor.userId, input.jobId, eventId]
      );
      if (previousEvent.rows[0]) {
        if (
          previousEvent.rows[0].payload.attemptId !== input.attemptId ||
          previousEvent.rows[0].payload.outcome !== input.outcome ||
          (previousEvent.rows[0].payload.jobState ?? null) !==
            (input.jobState ?? null)
        ) {
          throw idempotencyConflict(
            "Personal Agent attempt event ID was reused"
          );
        }
        return { attempt, job: mapJob(job), replayed: true };
      }
      await assertCurrentRunningPersonalAgentAttempt(client, job, attemptRow);
      if (attempt.status !== "running") {
        throw Object.assign(
          new Error("Personal Agent attempt is already terminal"),
          {
            code: "PERSONAL_AGENT_STATE_CONFLICT"
          }
        );
      }
      const status = input.outcome;
      const updatedAttemptResult = await client.query<AttemptRow>(
        `update personal_agent_execution_attempts
            set status = $3, outcome = $3, completed_at = $4, updated_at = now()
          where id = $1 and job_id = $2 and owner_user_id = $5 and status = 'running'
          returning id, owner_user_id, job_id, command_id, attempt_number, attribution_kind,
            agent_id, agent_version, provider, model, ai_client_instance_id,
            reasoning_effort, permission_mode, managed_execution_id,
            managed_execution_generation, status, outcome, started_at, phase,
            phase_observed_at, completed_at`,
        [input.attemptId, input.jobId, status, completedAt, input.actor.userId]
      );
      const updatedAttempt = updatedAttemptResult.rows[0];
      if (!updatedAttempt) {
        throw Object.assign(
          new Error("Personal Agent attempt changed concurrently"),
          {
            code: "PERSONAL_AGENT_STATE_CONFLICT"
          }
        );
      }
      if (input.jobState === "waiting" && input.outcome !== "succeeded") {
        throw new TypeError(
          "Only a successful provider turn can leave a Job waiting"
        );
      }
      const jobState =
        input.jobState ??
        (input.outcome === "succeeded"
          ? "succeeded"
          : input.outcome === "canceled"
            ? "canceled"
            : "failed");
      const counterColumn = {
        succeeded: "attempts_succeeded",
        failed: "attempts_failed",
        canceled: "attempts_canceled",
        interrupted: "attempts_interrupted"
      }[input.outcome];
      const sequenceResult = await client.query<{ sequence: number }>(
        `select coalesce(max(sequence), 0) + 1 as sequence
         from personal_agent_execution_job_events where owner_user_id = $1 and job_id = $2`,
        [input.actor.userId, input.jobId]
      );
      await client.query(
        `insert into personal_agent_execution_job_events
           (owner_user_id, job_id, sequence, event_id, execution_generation,
            event_type, payload, observed_at)
         values ($1, $2, $3, $4, $5, 'attempt_completed', $6::jsonb, $7)`,
        [
          input.actor.userId,
          input.jobId,
          sequenceResult.rows[0]!.sequence,
          eventId,
          attempt.managedExecutionGeneration,
          JSON.stringify({
            attemptId: input.attemptId,
            outcome: input.outcome,
            ...(input.jobState ? { jobState: input.jobState } : {})
          }),
          completedAt
        ]
      );
      const updatedJobResult = await client.query<JobRow>(
        `update personal_agent_execution_jobs
            set state = $3, ${counterColumn} = ${counterColumn} + 1,
                version = version + 1, last_observed_at = $4, updated_at = now()
          where id = $1 and owner_user_id = $2
          returning id, owner_user_id, conversation_id, command_id, title,
            project_id, output_reference, version, last_observed_at,
            attribution_kind, agent_id, agent_version, state, attempts_started,
            attempts_succeeded, attempts_failed, attempts_canceled,
            attempts_interrupted, last_attempt_id, created_at, updated_at`,
        [input.jobId, input.actor.userId, jobState, completedAt]
      );
      const updatedJob = updatedJobResult.rows[0];
      if (!updatedJob) throw new Error("Personal Agent job transition failed");
      return {
        attempt: mapAttempt(updatedAttempt),
        job: mapJob(updatedJob),
        replayed: false
      };
    });
  };

  const listPersonalAgentExecutionAttempts = async (
    actor: ActorContext,
    input: { jobId: string; limit?: number; before?: string }
  ): Promise<PersonalAgentExecutionAttemptPage> => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const cursor = input.before ? decodeCursor(input.before) : null;
    const result = await pool.query<AttemptRow>(
      `select id, owner_user_id, job_id, command_id, attempt_number, attribution_kind,
          agent_id, agent_version, provider, model, ai_client_instance_id,
          reasoning_effort, permission_mode, managed_execution_id,
          managed_execution_generation, status, outcome, started_at,
          phase, phase_observed_at, completed_at
       from personal_agent_execution_attempts
       where owner_user_id = $1 and job_id = $2
         and ($3::timestamptz is null or (started_at, id) < ($3, $4))
       order by started_at desc, id desc
       limit $5`,
      [
        actor.userId,
        input.jobId,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1
      ]
    );
    const rows = result.rows.slice(0, limit);
    return {
      attempts: rows.map(mapAttempt),
      hasMore: result.rows.length > limit,
      nextCursor:
        result.rows.length > limit
          ? encodeCursor(rows.at(-1)!.started_at, rows.at(-1)!.id)
          : null
    };
  };

  const listPersonalAgentHistoryJobs = async (
    actor: ActorContext,
    input: { agentId: string; limit?: number; before?: string }
  ): Promise<PersonalAgentHistoryJobPage> => {
    const page = await listPersonalAgentExecutionJobs(actor, {
      agentId: input.agentId,
      limit: input.limit,
      before: input.before
    });
    if (page.jobs.length === 0) {
      return { jobs: [], hasMore: page.hasMore, nextCursor: page.nextCursor };
    }
    const jobIds = page.jobs.map((job) => job.id);
    const goals = await authorizedJobGoals(actor, page.jobs);
    const versions = page.jobs.flatMap((job) =>
      job.attribution.kind === "agent" ? [job.attribution.agentVersion] : []
    );
    const [attemptRows, identityRows] = await Promise.all([
      pool.query<AttemptRow & { history_rank: number }>(
        `with ranked_attempts as (
           select id, owner_user_id, job_id, command_id, attempt_number,
                  attribution_kind, agent_id, agent_version, provider, model,
                  ai_client_instance_id, reasoning_effort, permission_mode,
                  managed_execution_id, managed_execution_generation, status,
                  outcome, started_at, phase, phase_observed_at, completed_at,
                  row_number() over (
                    partition by job_id order by started_at desc, id desc
                  ) as history_rank
           from personal_agent_execution_attempts
           where owner_user_id = $1 and job_id = any($2::uuid[])
         )
         select id, owner_user_id, job_id, command_id, attempt_number,
                attribution_kind, agent_id, agent_version, provider, model,
                ai_client_instance_id, reasoning_effort, permission_mode,
                managed_execution_id, managed_execution_generation, status,
                outcome, started_at, phase, phase_observed_at, completed_at,
                history_rank
         from ranked_attempts where history_rank <= 100
         order by job_id, started_at desc, id desc`,
        [actor.userId, jobIds]
      ),
      versions.length
        ? pool.query<{ version: number; name: string }>(
            `select version, name from personal_agent_identity_versions
             where owner_user_id = $1 and agent_id = $2
               and version = any($3::integer[])`,
            [actor.userId, input.agentId, versions]
          )
        : Promise.resolve({ rows: [] as { version: number; name: string }[] })
    ]);
    const attemptsByJob = new Map<string, PersonalAgentExecutionAttempt[]>();
    for (const row of attemptRows.rows) {
      const attempts = attemptsByJob.get(row.job_id) ?? [];
      attempts.push(mapAttempt(row));
      attemptsByJob.set(row.job_id, attempts);
    }
    const namesByVersion = new Map(
      identityRows.rows.map((row) => [row.version, row.name])
    );
    return {
      jobs: page.jobs.map((job) => {
        const goal = goals.get(job.id) ?? null;
        const attempts = attemptsByJob.get(job.id) ?? [];
        return {
          ...job,
          goal,
          agentName:
            job.attribution.kind === "agent"
              ? (namesByVersion.get(job.attribution.agentVersion) ?? null)
              : null,
          attempts,
          latestAttempt: attempts[0] ?? null
        };
      }),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor
    };
  };

  const countPersonalAgentExecutionAttempts = async (
    actor: ActorContext,
    input: {
      jobId?: string;
      status?: PersonalAgentExecutionAttempt["status"];
    } = {}
  ): Promise<number> => {
    const result = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from personal_agent_execution_attempts
       where owner_user_id = $1
         and ($2::uuid is null or job_id = $2)
         and ($3::text is null or status = $3)`,
      [actor.userId, input.jobId ?? null, input.status ?? null]
    );
    return Number(result.rows[0]?.count ?? 0);
  };

  const listPersonalAgentRoleTemplates = async (): Promise<
    PersonalAgentRoleTemplate[]
  > => {
    const result = await pool.query(
      `select template_id, version, title, role, soul_instructions,
          content_sha256
       from personal_agent_role_template_versions
       order by template_id asc, version desc`
    );
    return result.rows.map((row) =>
      personalAgentRoleTemplateSchema.parse({
        id: row.template_id,
        version: row.version,
        title: row.title,
        role: row.role,
        soulInstructions: row.soul_instructions,
        contentSha256: row.content_sha256
      })
    );
  };

  const getPersonalAgentRoleTemplate = async (
    templateId: string,
    version: number
  ): Promise<PersonalAgentRoleTemplate | null> => {
    const result = await pool.query(
      `select template_id, version, title, role, soul_instructions,
          content_sha256
       from personal_agent_role_template_versions
       where template_id = $1 and version = $2`,
      [templateId, version]
    );
    const row = result.rows[0];
    return row
      ? personalAgentRoleTemplateSchema.parse({
          id: row.template_id,
          version: row.version,
          title: row.title,
          role: row.role,
          soulInstructions: row.soul_instructions,
          contentSha256: row.content_sha256
        })
      : null;
  };

  return {
    listPersonalAgentRoleTemplates,
    getPersonalAgentRoleTemplate,
    getPersonalAgentConversation,
    addPersonalAgentParticipant,
    setActivePersonalAgentRespondent,
    createPersonalAgent,
    getPersonalAgent,
    listPersonalAgents,
    getPersonalAgentVersion,
    createPersonalAgentVersion,
    updatePersonalAgent,
    retirePersonalAgent,
    restorePersonalAgent,
    createPersonalAgentExecutionJob,
    recordPersonalAgentTurnOutput,
    getPersonalAgentTurnOutput,
    getPersonalAgentExecutionJob,
    listPersonalAgentExecutionJobs,
    countPersonalAgentExecutionJobs,
    createPersonalAgentExecutionAttempt,
    completePersonalAgentExecutionAttempt,
    listPersonalAgentExecutionAttempts,
    getPersonalAgentActivity,
    listPersonalAgentHistoryJobs,
    countPersonalAgentExecutionAttempts
  };
};

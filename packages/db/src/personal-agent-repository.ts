import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  assertPersonalAgentAttemptRuntimeIdentity,
  assertPersonalAgentIsActive,
  decideConversationItemPresentation,
  parsePersonalAgentExecutionAttempt,
  parsePersonalAgentExecutionJob,
  parsePersonalAgentConversation,
  parsePersonalAgentIdentity,
  parsePersonalAgentIdentityVersion,
  type AiClientPermissionMode,
  type EnvelopeEncryptionProvider,
  type PersonalAgentAttemptOutcome,
  type PersonalAgentAttribution,
  type PersonalAgentExecutionAttempt,
  type PersonalAgentExecutionJob,
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
  title?: string;
  projectId?: string | null;
}

export interface PersonalAgentJobOutputReference {
  runtimeItemIds: string[];
}

export interface PersonalAgentExecutionAttemptInput {
  jobId: string;
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

export interface PersonalAgentExecutionAttemptPage {
  attempts: PersonalAgentExecutionAttempt[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface PersonalAgentHistory {
  stats: Record<string, number | boolean | null>;
  jobs: PersonalAgentHistoryJob[];
  jobsHasMore: boolean;
  jobsNextCursor: string | null;
  projects: unknown[] | null;
}

export interface PersonalAgentHistoryJob extends PersonalAgentExecutionJob {
  title: string;
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
  updated_at: Date;
};

type AttemptRow = {
  id: string;
  owner_user_id: string;
  job_id: string;
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
    completedAt: row.completed_at ? iso(row.completed_at) : null
  });

const encodeCursor = (createdAt: Date, id: string): string =>
  Buffer.from(`${createdAt.toISOString()}\u0000${id}`, "utf8").toString(
    "base64url"
  );

const decodeCursor = (cursor: string): { createdAt: string; id: string } => {
  const [createdAt, id] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("\u0000");
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
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
        sourceId: jobId,
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
    jobId: string
  ): Promise<string | null> => {
    const result = await decryptAuthorizedEncryptedFieldPayloadWithClient(
      client,
      actor,
      requireProvider(),
      {
        sourceTable: OUTPUT_SOURCE_TABLE,
        sourceId: jobId,
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
    const historyJobs: PersonalAgentHistoryJob[] = await Promise.all(
      jobs.jobs.map(async (job) => {
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
          title: "Agent task",
          agentName: historicalIdentity?.rows[0]?.name ?? null,
          attempts: attempts.attempts,
          latestAttempt: attempts.attempts[0] ?? null
        };
      })
    );
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
                clock_timestamp() as observed_at
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
          input.title?.trim().slice(0, 512) || "Agent task",
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
      const attempt = await client.query<{ id: string; job_id: string }>(
        `select id, job_id from personal_agent_execution_attempts
         where id = $1 and job_id = $2 and owner_user_id = $3`,
        [input.attemptId, input.jobId, input.actor.userId]
      );
      if (!attempt.rows[0])
        throw new Error("Personal Agent attempt was not found");
      const eventId = input.eventId ?? `output:${input.attemptId}`;
      const event = await client.query<{
        payload: { runtimeItemIds?: string[]; outputDigest?: string };
      }>(
        `select payload from personal_agent_execution_job_events
         where owner_user_id = $1 and job_id = $2 and event_id = $3`,
        [input.actor.userId, input.jobId, eventId]
      );
      if (event.rows[0]) {
        if (
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
      const existing = jobRow.output_reference?.runtimeItemIds;
      if (existing && JSON.stringify(existing) !== JSON.stringify(refs)) {
        throw idempotencyConflict(
          "Personal Agent job output was already recorded"
        );
      }
      const existingOutput = await decryptTurnOutput(
        client,
        input.actor,
        input.jobId
      );
      if (
        existingOutput !== null &&
        requestFingerprint({ outputText: existingOutput }) !== outputDigest
      ) {
        throw idempotencyConflict(
          "Personal Agent job output was already recorded"
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
          JSON.stringify({ runtimeItemIds: refs, outputDigest }),
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
          JSON.stringify(input.outputReference),
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
    if (!job.rows[0].output_reference?.runtimeItemIds?.length) return null;
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
    return decryptTurnOutput(pool, actor, input.jobId);
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
          last_attempt_id, created_at, updated_at
       from personal_agent_execution_jobs
       where id = $1 and owner_user_id = $2`,
      [jobId, actor.userId]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
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
          last_attempt_id, created_at, updated_at
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
      jobs: rows.map(mapJob),
      hasMore: result.rows.length > limit,
      nextCursor:
        result.rows.length > limit
          ? encodeCursor(rows.at(-1)!.created_at, rows.at(-1)!.id)
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
      if (input.managedExecutionId !== null) {
        const execution = await client.query<{ id: string }>(
          `select id
           from managed_conversation_executions
           where id = $1 and owner_user_id = $2
           limit 1`,
          [input.managedExecutionId, actor.userId]
        );
        if (!execution.rows[0]) {
          throw new Error(
            "Managed execution is not owned by the Personal Agent owner"
          );
        }
      }
      const attempt = parsePersonalAgentExecutionAttempt({
        contractVersion: 1,
        id: randomUUID(),
        ownerUserId: actor.userId,
        jobId: input.jobId,
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
      const existingAttempt = await client.query<AttemptRow>(
        `select id, owner_user_id, job_id, attempt_number, attribution_kind,
            agent_id, agent_version, provider, model, ai_client_instance_id,
            reasoning_effort, permission_mode, managed_execution_id,
            managed_execution_generation, status, outcome, started_at,
            completed_at
         from personal_agent_execution_attempts
         where owner_user_id = $1 and job_id = $2 and attempt_number = $3`,
        [actor.userId, attempt.jobId, attempt.attemptNumber]
      );
      if (existingAttempt.rows[0]) {
        const existing = mapAttempt(existingAttempt.rows[0]);
        const comparable = (value: PersonalAgentExecutionAttempt) => ({
          jobId: value.jobId,
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
      await validateAttribution(client, actor, input.attribution, true);
      const result = await client.query<AttemptRow>(
        `insert into personal_agent_execution_attempts
          (id, owner_user_id, job_id, attempt_number, attribution_kind,
           agent_id, agent_version, provider, model, ai_client_instance_id,
           reasoning_effort, permission_mode, managed_execution_id,
           managed_execution_generation, status, outcome, started_at,
           completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18)
         returning id, owner_user_id, job_id, attempt_number,
           attribution_kind, agent_id, agent_version, provider, model,
           ai_client_instance_id, reasoning_effort, permission_mode,
           managed_execution_id, managed_execution_generation, status,
           outcome, started_at, completed_at`,
        [
          attempt.id,
          actor.userId,
          attempt.jobId,
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
        `select id, owner_user_id, job_id, attempt_number, attribution_kind,
            agent_id, agent_version, provider, model, ai_client_instance_id,
            reasoning_effort, permission_mode, managed_execution_id,
            managed_execution_generation, status, outcome, started_at,
            completed_at
         from personal_agent_execution_attempts
         where id = $1 and job_id = $2 and owner_user_id = $3 for update`,
        [input.attemptId, input.jobId, input.actor.userId]
      );
      const attemptRow = attemptResult.rows[0];
      if (!attemptRow) throw new Error("Personal Agent attempt was not found");
      const attempt = mapAttempt(attemptRow);
      const previousEvent = await client.query<{
        payload: { attemptId?: string; outcome?: string };
      }>(
        `select payload from personal_agent_execution_job_events
         where owner_user_id = $1 and job_id = $2 and event_id = $3`,
        [input.actor.userId, input.jobId, eventId]
      );
      if (previousEvent.rows[0]) {
        if (
          previousEvent.rows[0].payload.attemptId !== input.attemptId ||
          previousEvent.rows[0].payload.outcome !== input.outcome
        ) {
          throw idempotencyConflict(
            "Personal Agent attempt event ID was reused"
          );
        }
        return { attempt, job: mapJob(job), replayed: true };
      }
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
          returning id, owner_user_id, job_id, attempt_number, attribution_kind,
            agent_id, agent_version, provider, model, ai_client_instance_id,
            reasoning_effort, permission_mode, managed_execution_id,
            managed_execution_generation, status, outcome, started_at, completed_at`,
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
      const jobState =
        input.outcome === "succeeded"
          ? "succeeded"
          : input.outcome === "canceled"
            ? "canceled"
            : "failed";
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
            outcome: input.outcome
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
      `select id, owner_user_id, job_id, attempt_number, attribution_kind,
          agent_id, agent_version, provider, model, ai_client_instance_id,
          reasoning_effort, permission_mode, managed_execution_id,
          managed_execution_generation, status, outcome, started_at,
          completed_at
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
    countPersonalAgentExecutionAttempts
  };
};

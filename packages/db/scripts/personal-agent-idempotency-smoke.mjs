import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { createManagedConversationRepository } from "../dist/managed-conversation-repository.js";
import { createPersonalAgentRepository } from "../dist/personal-agent-repository.js";
import { runDbMigrations } from "../dist/migrate.js";

const databaseUrl = process.env.PERSONAL_AGENT_SMOKE_DATABASE_URL;
if (!databaseUrl)
  throw new Error("PERSONAL_AGENT_SMOKE_DATABASE_URL is required");

const temporaryDatabase = `koed_agents_test_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`create database "${temporaryDatabase}"`);
const temporaryUrl = new URL(databaseUrl);
temporaryUrl.pathname = `/${temporaryDatabase}`;
const pool = new pg.Pool({ connectionString: temporaryUrl.toString() });
const ownerId = randomUUID();
const otherOwnerId = randomUUID();
const actor = { userId: ownerId };
const otherActor = { userId: otherOwnerId };
const provider = createLocalTestKeyEnvelopeEncryptionProvider(
  randomBytes(32).toString("base64url")
);
const repository = createPersonalAgentRepository(pool, {
  envelopeEncryptionProvider: provider
});
const managedRepository = createManagedConversationRepository(pool, {
  envelopeEncryptionProvider: provider
});
const requestId = randomUUID();
const input = {
  requestId,
  name: "Smoke Agent",
  role: "Durable test agent",
  avatarReference: "pixelkin:smoke",
  soulInstructions: "Disposable encrypted smoke-test soul",
  instructionSource: "custom",
  defaultProvider: "codex",
  defaultModel: "gpt-5.6",
  defaultReasoningEffort: "high"
};

try {
  await runDbMigrations(pool);
  await pool.query(
    `insert into users (id, email, display_name) values ($1, $2, $3), ($4, $5, $6)`,
    [
      ownerId,
      `${ownerId}@smoke.invalid`,
      "Smoke Owner",
      otherOwnerId,
      `${otherOwnerId}@smoke.invalid`,
      "Other Owner"
    ]
  );

  const [first, second] = await Promise.all([
    repository.createPersonalAgent(actor, input),
    repository.createPersonalAgent(actor, input)
  ]);
  if (first.agent.id !== second.agent.id)
    throw new Error("Concurrent create did not converge");
  if (first.soulInstructions !== input.soulInstructions)
    throw new Error("Soul decrypt failed");

  await repository.createPersonalAgent(actor, input);
  await assertRejects(
    repository.createPersonalAgent(actor, {
      ...input,
      name: "Changed payload"
    }),
    "IDEMPOTENCY_CONFLICT"
  );
  if (await repository.getPersonalAgent(otherActor, first.agent.id)) {
    throw new Error("Cross-owner identity read was not denied");
  }

  const updateRequestId = randomUUID();
  const updated = await repository.updatePersonalAgent(actor, {
    agentId: first.agent.id,
    requestId: updateRequestId,
    expectedVersion: 1,
    name: "Updated Smoke Agent",
    defaultModel: "gpt-5.6"
  });
  if (updated?.agent.currentVersion !== 2)
    throw new Error("CAS update did not create version 2");
  await assertRejects(
    repository.updatePersonalAgent(actor, {
      agentId: first.agent.id,
      requestId: updateRequestId,
      expectedVersion: 1,
      name: "Different update"
    }),
    "IDEMPOTENCY_CONFLICT"
  );

  const version = await repository.getPersonalAgentVersion(actor, {
    agentId: first.agent.id,
    version: 2
  });
  if (!version) throw new Error("Agent version snapshot is missing");
  const execution = await managedRepository.createManagedConversation(actor, {
    projectId: null,
    contextKind: "independent",
    provider: "codex",
    aiClientInstanceId: "codex-app-server",
    model: "gpt-5.6",
    reasoningEffort: "high",
    permissionMode: "supervised",
    runnerKind: "local_device",
    runnerDeploymentId: randomUUID(),
    runnerDeviceId: randomUUID(),
    idempotencyKey: randomUUID()
  });
  const context = {
    schemaVersion: 1,
    identity: {
      agentId: first.agent.id,
      version: version.version,
      identityVersionId: version.id,
      name: version.name,
      role: version.role,
      soulInstructions: version.soulInstructions
    },
    project: { projectId: null, name: null },
    memory: { searchDomain: "global", evidence: [] }
  };
  const enqueueInput = {
    executionId: execution.execution.id,
    executionGeneration: execution.execution.executionGeneration,
    idempotencyKey: randomUUID(),
    clientUserMessageId: randomUUID(),
    prompt: "Smoke test the durable Personal Agent lifecycle.",
    agentId: first.agent.id,
    expectedAgentVersion: version.version,
    personalAgentContext: context
  };
  const command = await managedRepository.enqueueManagedConversationPrompt(
    actor,
    enqueueInput
  );
  if (!command.personalAgent || command.personalAgent.replayed) {
    throw new Error(
      "Agent prompt enqueue did not return a new job attribution"
    );
  }
  const replayedCommand =
    await managedRepository.enqueueManagedConversationPrompt(
      actor,
      enqueueInput
    );
  if (
    replayedCommand.personalAgent?.jobId !== command.personalAgent.jobId ||
    !replayedCommand.personalAgent.replayed
  ) {
    throw new Error("Prompt replay did not return its original agent job");
  }
  const conversation = await repository.getPersonalAgentConversation(actor, {
    conversationId: execution.execution.id
  });
  if (
    conversation?.activeAgentId !== first.agent.id ||
    conversation.participants.length !== 1 ||
    conversation.participants[0]?.agentId !== first.agent.id
  ) {
    throw new Error(
      "Managed prompt did not persist its participant and respondent"
    );
  }
  const jobId = command.personalAgent.jobId;
  const attemptInput = {
    jobId,
    attemptNumber: 1,
    attribution: {
      kind: "agent",
      agentId: first.agent.id,
      agentVersion: version.version
    },
    provider: execution.execution.provider,
    model: execution.execution.model,
    aiClientInstanceId: execution.execution.aiClientInstanceId,
    reasoningEffort: execution.execution.reasoningEffort,
    permissionMode: execution.execution.permissionMode,
    managedExecutionId: execution.execution.id,
    managedExecutionGeneration: execution.execution.executionGeneration,
    status: "running",
    outcome: null,
    startedAt: new Date().toISOString(),
    completedAt: null
  };
  const attempt = await repository.createPersonalAgentExecutionAttempt(
    actor,
    attemptInput
  );
  if (
    attempt.model !== "gpt-5.6" ||
    attempt.provider !== "codex" ||
    attempt.aiClientInstanceId !== "codex-app-server"
  ) {
    throw new Error("Attempt did not preserve the actual execution identity");
  }
  const runningDetail = await repository.getPersonalAgent(
    actor,
    first.agent.id
  );
  if (
    runningDetail?.history.stats.runningNow !== 0 ||
    runningDetail.history.stats.runningAttemptsPersisted !== 1 ||
    runningDetail.history.stats.runningAttemptsMayBeStale !== true ||
    runningDetail.history.stats.projects !== 0 ||
    runningDetail.history.stats.projectsAvailable !== true
  ) {
    throw new Error(
      "Running freshness or independent-project stats are incorrect"
    );
  }
  const assistantText =
    "Encrypted durable assistant output from the smoke test.";
  const outputJob = await repository.recordPersonalAgentTurnOutput({
    actor,
    jobId,
    attemptId: attempt.id,
    outputText: assistantText,
    outputReference: { runtimeItemIds: [randomUUID()] }
  });
  if (outputJob.outputReference?.runtimeItemIds.length !== 1) {
    throw new Error("Durable assistant output reference was not stored");
  }
  const completion = {
    actor,
    jobId,
    attemptId: attempt.id,
    outcome: "succeeded",
    eventId: `smoke-complete:${attempt.id}`
  };
  const completed =
    await repository.completePersonalAgentExecutionAttempt(completion);
  const replayedCompletion =
    await repository.completePersonalAgentExecutionAttempt(completion);
  if (
    completed.replayed ||
    !replayedCompletion.replayed ||
    replayedCompletion.job.counters.attemptsStarted !== 1 ||
    replayedCompletion.job.counters.attemptsSucceeded !== 1
  ) {
    throw new Error("Attempt completion was not idempotent");
  }
  const completedDetail = await repository.getPersonalAgent(
    actor,
    first.agent.id
  );
  if (
    completedDetail?.history.stats.runningNow !== 0 ||
    completedDetail.history.stats.runningAttemptsPersisted !== 0 ||
    completedDetail.history.stats.runningAttemptsMayBeStale !== false
  ) {
    throw new Error("Terminal attempt freshness was not reflected in history");
  }
  if (await repository.getPersonalAgentTurnOutput(otherActor, { jobId })) {
    throw new Error("Cross-owner assistant output read was not denied");
  }
  if (
    (await repository.getPersonalAgentTurnOutput(actor, { jobId })) !==
    assistantText
  ) {
    throw new Error("Encrypted assistant output did not round-trip");
  }
  const ciphertext = await pool.query(
    `select ciphertext::text as ciphertext from encrypted_field_payloads
      where source_table = 'personal_agent_execution_jobs'
        and source_id = $1 and source_column = 'assistant_output'`,
    [jobId]
  );
  if (
    !ciphertext.rows[0] ||
    ciphertext.rows[0].ciphertext.includes(assistantText)
  ) {
    throw new Error("Assistant output was not encrypted at rest");
  }
  await pool.query(
    `update conversation_presentation_policy_rules
        set presentation_mode = 'hidden', renderer_kind = 'generic'
      where source_kind = 'managed_runtime'
        and source_adapter_version = 'managed-runtime-v1'
        and item_type = 'transient_output'`
  );
  if (await repository.getPersonalAgentTurnOutput(actor, { jobId })) {
    throw new Error("Current hidden presentation policy was bypassed");
  }
  await pool.query(
    `update conversation_presentation_policy_rules
        set presentation_mode = 'expanded', renderer_kind = 'message'
      where source_kind = 'managed_runtime'
        and source_adapter_version = 'managed-runtime-v1'
        and item_type = 'transient_output'`
  );

  const retireRequestId = randomUUID();
  const retired = await repository.retirePersonalAgent({
    actor,
    agentId: first.agent.id,
    requestId: retireRequestId,
    expectedVersion: 2
  });
  if (retired?.lifecycle !== "retired") throw new Error("Retirement failed");
  const replayedRetirement = await repository.retirePersonalAgent({
    actor,
    agentId: first.agent.id,
    requestId: retireRequestId,
    expectedVersion: 2
  });
  if (replayedRetirement?.currentVersion !== 2)
    throw new Error("Retirement replay changed history");
  if (!(await repository.getPersonalAgentExecutionJob(actor, jobId))) {
    throw new Error("Retirement deleted the historical agent job");
  }
  if (
    (await repository.getPersonalAgentTurnOutput(actor, { jobId })) !==
    assistantText
  ) {
    throw new Error("Retirement removed the historical assistant output");
  }
  await assertRejectsStatus(
    managedRepository.enqueueManagedConversationPrompt(actor, {
      ...enqueueInput,
      idempotencyKey: randomUUID(),
      clientUserMessageId: randomUUID()
    }),
    409
  );
  console.log(
    "Personal Agent operational lifecycle smoke passed in disposable database"
  );
} finally {
  await pool.end();
  await admin.query(`drop database "${temporaryDatabase}"`);
  await admin.end();
}

async function assertRejects(promise, code) {
  try {
    await promise;
  } catch (error) {
    if (error?.code === code) return;
    throw error;
  }
  throw new Error(`Expected ${code}`);
}

async function assertRejectsStatus(promise, status) {
  try {
    await promise;
  } catch (error) {
    if (error?.statusCode === status) return;
    throw error;
  }
  throw new Error(`Expected HTTP status ${status}`);
}

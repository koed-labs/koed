import { randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createCollaborationRepository } from "../src/collaboration-repository.js";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import { createManagedConversationRepository } from "../src/managed-conversation-repository.js";
import { createPublicSquareRepository } from "../src/public-square-repository.js";

const databaseUrl =
  process.env.PUBLIC_SQUARE_TEST_DATABASE_URL ??
  process.env.COLLABORATION_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const actor = (userId: string) => ({ userId });

describeDb("Public Square repository", () => {
  let pool: pg.Pool;
  let publicSquare: ReturnType<typeof createPublicSquareRepository>;
  let collaboration: ReturnType<typeof createCollaborationRepository>;
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 29).toString("base64")
  );

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl! });
    await runDbMigrations(pool);
    collaboration = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    publicSquare = createPublicSquareRepository(pool, {
      envelopeEncryptionProvider: provider
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  const createFixture = async (connect = true) => {
    const ownerId = (
      await pool.query<{ id: string }>(
        `insert into users(email,display_name) values($1,'Square Owner') returning id`,
        [`square-owner-${randomUUID()}@example.test`]
      )
    ).rows[0]!.id;
    const adminId = (
      await pool.query<{ id: string }>(
        `insert into users(email,display_name) values($1,'Square Admin') returning id`,
        [`square-admin-${randomUUID()}@example.test`]
      )
    ).rows[0]!.id;
    const teamId = (
      await pool.query<{ id: string }>(
        `insert into teams(name,entitlement_status) values($1,'active') returning id`,
        [`Square ${randomUUID()}`]
      )
    ).rows[0]!.id;
    await pool.query(
      `insert into team_memberships(team_id,user_id,role,status,accepted_at) values($1,$2,'member','enabled',now()),($1,$3,'admin','enabled',now())`,
      [teamId, ownerId, adminId]
    );
    const localProjectId = `project:${randomUUID()}`;
    const project = await collaboration.createTeamSharedProject(
      actor(ownerId),
      {
        teamId,
        idempotencyKey: `public-square:${randomUUID()}`,
        name: "Encrypted Team Project",
        ...(connect ? { localProjectId } : {})
      }
    );
    if (!project) throw new Error("Expected Team Project creation");
    return { ownerId, adminId, teamId, localProjectId, project };
  };

  const insertJob = async (input: {
    ownerId: string;
    localProjectId: string;
    state?: "queued" | "running" | "succeeded";
    executionId?: string;
    agentId?: string;
  }) => {
    const executionId = input.executionId ?? randomUUID();
    const jobId = randomUUID();
    const now = new Date();
    if (!input.executionId)
      await pool.query(
        `insert into managed_conversation_executions(id,owner_user_id,project_id,ai_client_instance_id,model,permission_mode,runner_kind,state,execution_generation,fencing_token_hash,runner_deployment_id,runner_device_id,runner_id,runner_lease_expires_at,logical_session_id,provider_thread_id,started_at,runner_last_seen_at)
      values($1,$2,$3,'codex.default','test-model','supervised','local_device','running',1,$4,$5,$6,'runner',$7,$8,$9,now(),now())`,
        [
          executionId,
          input.ownerId,
          input.localProjectId,
          "a".repeat(64),
          randomUUID(),
          randomUUID(),
          new Date(now.getTime() + 60_000),
          randomUUID(),
          `thread-${randomUUID()}`
        ]
      );
    const agentId = input.agentId ?? randomUUID();
    if (!input.agentId) {
      await pool.query(
        `insert into personal_agent_identities(id,owner_user_id,name,role,default_provider,default_model,current_version,creation_request_id,creation_request_fingerprint) values($1,$2,'Private Agent','Private role','codex','test-model',1,$3,$4)`,
        [agentId, input.ownerId, randomUUID(), "b".repeat(64)]
      );
      await pool.query(
        `insert into personal_agent_identity_versions(agent_id,owner_user_id,version,name,role,default_provider,default_model,soul_instructions,instruction_source,created_by_user_id,request_id,request_fingerprint) values($1,$2,1,'Private Agent','Private role','codex','test-model','[koed encrypted personal agent soul]','custom',$2,$3,$4)`,
        [agentId, input.ownerId, randomUUID(), "c".repeat(64)]
      );
    }
    await pool.query(
      `insert into personal_agent_execution_jobs(id,owner_user_id,conversation_id,attribution_kind,agent_id,agent_version,state,project_id,title) values($1,$2,$3,'agent',$4,1,$5,$6,'Private Job Title')`,
      [
        jobId,
        input.ownerId,
        executionId,
        agentId,
        input.state ?? "running",
        input.localProjectId
      ]
    );
    return { executionId, jobId, agentId };
  };

  const createRunnerAssignedJob = async (input: {
    ownerId: string;
    projectId: string | null;
  }) => {
    const agentId = randomUUID();
    const identityVersionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const runnerId = `publication-runner-${randomUUID()}`;
    const leaseToken = randomUUID();
    await pool.query(
      `insert into personal_agent_identities
         (id,owner_user_id,name,role,default_provider,default_model,current_version,
          creation_request_id,creation_request_fingerprint)
       values($1,$2,'PR Reviewer','Review pull requests','codex','test-model',1,$3,$4)`,
      [agentId, input.ownerId, randomUUID(), "d".repeat(64)]
    );
    await pool.query(
      `insert into personal_agent_identity_versions
         (id,agent_id,owner_user_id,version,name,role,default_provider,
          default_model,soul_instructions,instruction_source,created_by_user_id,
          request_id,request_fingerprint)
       values($1,$2,$3,1,'PR Reviewer','Review pull requests','codex',
              'test-model','[koed encrypted personal agent soul]','custom',$3,$4,$5)`,
      [identityVersionId, agentId, input.ownerId, randomUUID(), "e".repeat(64)]
    );
    const projectContext = input.projectId
      ? { projectId: input.projectId, name: "Linked Project" }
      : { projectId: null, name: null };
    const personalAgentContext = {
      schemaVersion: 1 as const,
      identity: {
        agentId,
        version: 1,
        identityVersionId,
        name: "PR Reviewer",
        role: "Review pull requests",
        soulInstructions: "Find concrete risks."
      },
      project: projectContext,
      activeJob: null,
      pendingTeamRequestId: null,
      memory: {
        searchDomain: input.projectId ? "project" : "global",
        evidence: []
      }
    };
    const personalMemoryContext = {
      schemaVersion: 1 as const,
      status: "skipped" as const,
      attributionNonce: randomUUID(),
      searchDomain: input.projectId
        ? ("project" as const)
        : ("global" as const),
      projectId: input.projectId,
      evidence: []
    };
    const repository = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const created = await repository.createManagedConversation(
      actor(input.ownerId),
      {
        projectId: input.projectId,
        contextKind: input.projectId ? "project" : "independent",
        provider: "codex",
        aiClientInstanceId: "codex.default",
        model: "test-model",
        permissionMode: "supervised",
        runnerKind: "local_device",
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        idempotencyKey: randomUUID(),
        initialPrompt: "Review this pull request.",
        initialPromptClientUserMessageId: randomUUID(),
        initialPersonalMemoryContext: personalMemoryContext,
        initialAgentId: agentId,
        initialExpectedAgentVersion: 1,
        initialPersonalAgentContext: personalAgentContext
      }
    );
    const [start] = await repository.claimManagedConversationCommands({
      ownerUserId: input.ownerId,
      runnerId,
      deploymentId,
      deviceId,
      leaseMs: 60_000
    });
    if (!start?.leaseToken) throw new Error("Expected a claimed start command");
    const running = await repository.bindManagedConversationRuntime(
      actor(input.ownerId),
      {
        executionId: created.execution.id,
        expectedStateVersion: created.execution.stateVersion,
        executionGeneration: 1,
        runnerId,
        logicalSessionId: randomUUID(),
        providerThreadId: randomUUID(),
        providerCliVersion: "test"
      }
    );
    await repository.completeManagedConversationCommand({
      commandId: start.id,
      leaseToken: start.leaseToken,
      result: { started: true }
    });
    const [prompt] = await repository.claimManagedConversationCommands({
      ownerUserId: input.ownerId,
      runnerId,
      deploymentId,
      deviceId,
      leaseMs: 60_000
    });
    if (!prompt?.leaseToken || prompt.commandKind !== "prompt") {
      throw new Error("Expected a claimed Agent prompt");
    }
    const result = await repository.recordPersonalAgentIntentForManagedCommand(
      actor(input.ownerId),
      {
        commandId: prompt.id,
        executionId: running.id,
        executionGeneration: 1,
        leaseToken: prompt.leaseToken,
        runnerId,
        deviceId,
        deploymentId,
        providerTurnId: `codex-turn-${randomUUID()}`,
        intent: { kind: "assign", goal: "Review the pull request" }
      }
    );
    return { ...result, executionId: running.id };
  };

  const createOffer = (teamId: string, ownerId: string, agentId: string) =>
    pool.query(
      `insert into team_agent_offers(team_id,owner_user_id,agent_id,enabled) values($1,$2,$3,true)`,
      [teamId, ownerId, agentId]
    );

  const insertAttempt = async (input: {
    ownerId: string;
    jobId: string;
    attemptNumber: number;
    startedAt: Date;
    phase?: "working" | "checking";
    phaseObservedAt?: Date;
  }) =>
    pool.query(
      `insert into personal_agent_execution_attempts(
        owner_user_id,job_id,attempt_number,attribution_kind,status,outcome,
        started_at,completed_at,phase,phase_observed_at
      ) values($1,$2,$3,'legacy','succeeded','succeeded',$4::timestamptz,$4::timestamptz,$5::text,coalesce($6::timestamptz,$4::timestamptz))`,
      [
        input.ownerId,
        input.jobId,
        input.attemptNumber,
        input.startedAt,
        input.phase ?? "working",
        input.phaseObservedAt ?? null
      ]
    );

  it("publishes only connected future Jobs, snapshots departure, and ignores the insert/departure race", async () => {
    const fixture = await createFixture();
    const channelMessage = await collaboration.sendMessage(
      actor(fixture.ownerId),
      {
        threadId: fixture.project.thread.id,
        idempotencyKey: `square-channel-message:${randomUUID()}`,
        bodyText: "Stored Project channel history"
      }
    );
    expect(channelMessage).toBeTruthy();
    const first = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId
    });
    const listed = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(listed?.items).toHaveLength(1);
    expect(listed?.items[0]).toMatchObject({
      jobId: first.jobId,
      projectName: "Encrypted Team Project",
      status: "running",
      ownerLeftTeam: false,
      sharedBrief: null
    });
    expect(listed?.items[0]?.ownerExecutionId).toBeNull();
    const ownerView = await publicSquare.listPublicSquare(
      actor(fixture.ownerId),
      { teamId: fixture.teamId, limit: 50 }
    );
    expect(ownerView?.items[0]?.ownerExecutionId).toBe(first.executionId);
    expect(JSON.stringify(listed?.items[0])).not.toContain("Private Job Title");

    await pool.query(
      `update personal_agent_execution_jobs set state='succeeded',updated_at=now() where id=$1`,
      [first.jobId]
    );
    const terminal = await publicSquare.listPublicSquare(
      actor(fixture.adminId),
      { teamId: fixture.teamId, limit: 50 }
    );
    expect(terminal?.items[0]).toMatchObject({
      status: "succeeded",
      completedAt: expect.any(String)
    });

    const departure = await pool.connect();
    const competing = await pool.connect();
    try {
      await departure.query("begin");
      await departure.query(
        `update team_memberships set status='disabled',disabled_at=now() where team_id=$1 and user_id=$2`,
        [fixture.teamId, fixture.ownerId]
      );
      const racingJob = insertJob({
        ownerId: fixture.ownerId,
        localProjectId: fixture.localProjectId,
        state: "queued"
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await departure.query("commit");
      await racingJob;
      const all = await competing.query<{ count: number }>(
        `select count(*)::int as count from personal_agent_team_job_publications where team_id=$1`,
        [fixture.teamId]
      );
      expect(all.rows[0]?.count).toBe(1);
    } catch (error) {
      await departure.query("rollback");
      throw error;
    } finally {
      departure.release();
      competing.release();
    }

    const frozen = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(frozen?.items[0]).toMatchObject({
      ownerLeftTeam: true,
      status: "succeeded",
      canRemoveRetainedBrief: true
    });
    expect(frozen?.items[0]?.ownerExecutionId).toBeNull();
    await pool.query(
      `update personal_agent_execution_jobs set state='failed',updated_at=now() where id=$1`,
      [first.jobId]
    );
    const stillFrozen = await publicSquare.listPublicSquare(
      actor(fixture.adminId),
      { teamId: fixture.teamId, limit: 50 }
    );
    expect(stillFrozen?.items[0]).toMatchObject({
      status: "succeeded",
      ownerLeftTeam: true
    });
    expect(
      await publicSquare.unsharePublicSquareProject(actor(fixture.adminId), {
        teamId: fixture.teamId,
        teamProjectId: fixture.project.id
      })
    ).toBe(true);
    const afterUnshare = await publicSquare.listPublicSquare(
      actor(fixture.adminId),
      { teamId: fixture.teamId, limit: 50 }
    );
    expect(afterUnshare?.items).toEqual([]);
    const channelSnapshot = await collaboration.getAuthorizedSnapshot(
      actor(fixture.adminId),
      { scope: "team", teamId: fixture.teamId }
    );
    expect(
      channelSnapshot?.threads.some(
        (thread) => thread.id === fixture.project.thread.id
      )
    ).toBe(false);
    await expect(
      collaboration.getThread(actor(fixture.adminId), {
        threadId: fixture.project.thread.id
      })
    ).resolves.toBeNull();
    await expect(
      collaboration.listMessages(actor(fixture.adminId), {
        threadId: fixture.project.thread.id
      })
    ).resolves.toBeNull();
    const retainedChannelHistory = await pool.query<{ message_count: number }>(
      `select count(*)::int as message_count from collaboration_messages where id=$1 and thread_id=$2`,
      [channelMessage!.id, fixture.project.thread.id]
    );
    expect(retainedChannelHistory.rows[0]?.message_count).toBe(1);
  });

  it("publishes a runner-created Job after an existing link and denies stale or missing authorization", async () => {
    const connected = await createFixture();
    const linkedJob = await createRunnerAssignedJob({
      ownerId: connected.ownerId,
      projectId: connected.localProjectId
    });
    const listed = await publicSquare.listPublicSquare(
      actor(connected.adminId),
      { teamId: connected.teamId, limit: 50 }
    );
    expect(
      listed?.items.find((item) => item.jobId === linkedJob.jobId)
    ).toMatchObject({
      jobId: linkedJob.jobId,
      projectId: connected.project.id,
      status: "queued",
      sharedBrief: null
    });

    await pool.query(
      `update team_memberships set status='disabled',disabled_at=now()
        where team_id=$1 and user_id=$2`,
      [connected.teamId, connected.ownerId]
    );
    const disabledOwnerJob = await createRunnerAssignedJob({
      ownerId: connected.ownerId,
      projectId: connected.localProjectId
    });
    const disabledPublication = await pool.query<{ count: number }>(
      `select count(*)::int as count from personal_agent_team_job_publications where job_id=$1`,
      [disabledOwnerJob.jobId]
    );
    expect(disabledPublication.rows[0]?.count).toBe(0);

    const unconnected = await createFixture(false);
    const unconnectedJob = await createRunnerAssignedJob({
      ownerId: unconnected.ownerId,
      projectId: unconnected.localProjectId
    });
    const unconnectedPublication = await pool.query<{ count: number }>(
      `select count(*)::int as count from personal_agent_team_job_publications where job_id=$1`,
      [unconnectedJob.jobId]
    );
    expect(unconnectedPublication.rows[0]?.count).toBe(0);

    const independentJob = await createRunnerAssignedJob({
      ownerId: unconnected.ownerId,
      projectId: null
    });
    const independentPublication = await pool.query<{ count: number }>(
      `select count(*)::int as count from personal_agent_team_job_publications where job_id=$1`,
      [independentJob.jobId]
    );
    expect(independentPublication.rows[0]?.count).toBe(0);
  });

  it("reports the first real attempt start and freezes it at owner departure", async () => {
    const fixture = await createFixture();
    const attempted = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running"
    });
    const firstStart = new Date("2026-09-30T10:00:00.000Z");
    const retryStart = new Date("2026-09-30T10:05:00.000Z");
    await insertAttempt({
      ownerId: fixture.ownerId,
      jobId: attempted.jobId,
      attemptNumber: 1,
      startedAt: firstStart
    });
    await insertAttempt({
      ownerId: fixture.ownerId,
      jobId: attempted.jobId,
      attemptNumber: 2,
      startedAt: retryStart
    });
    await pool.query(
      `update personal_agent_execution_jobs set state='succeeded',updated_at=now() where id=$1`,
      [attempted.jobId]
    );
    const neverAttempted = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "queued"
    });

    let page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(
      page?.items.find((item) => item.jobId === attempted.jobId)
    ).toMatchObject({
      startedAt: firstStart.toISOString(),
      status: "succeeded"
    });
    expect(
      page?.items.find((item) => item.jobId === neverAttempted.jobId)
    ).toMatchObject({ startedAt: null });

    await pool.query(
      `update team_memberships set status='disabled',disabled_at=now() where team_id=$1 and user_id=$2`,
      [fixture.teamId, fixture.ownerId]
    );
    await insertAttempt({
      ownerId: fixture.ownerId,
      jobId: attempted.jobId,
      attemptNumber: 3,
      startedAt: new Date("2026-09-30T10:10:00.000Z")
    });
    await insertAttempt({
      ownerId: fixture.ownerId,
      jobId: neverAttempted.jobId,
      attemptNumber: 1,
      startedAt: new Date("2026-09-30T10:12:00.000Z")
    });
    page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(
      page?.items.find((item) => item.jobId === attempted.jobId)
    ).toMatchObject({
      startedAt: firstStart.toISOString(),
      ownerLeftTeam: true,
      status: "succeeded"
    });
    expect(
      page?.items.find((item) => item.jobId === neverAttempted.jobId)
    ).toMatchObject({ startedAt: null, ownerLeftTeam: true });
  });

  it("projects the latest explicit Job phase and freezes it on owner departure", async () => {
    const fixture = await createFixture();
    const job = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running"
    });
    const startedAt = new Date("2026-09-30T10:00:00.000Z");
    const checkingAt = new Date("2026-09-30T10:03:00.000Z");
    await insertAttempt({
      ownerId: fixture.ownerId,
      jobId: job.jobId,
      attemptNumber: 1,
      startedAt,
      phase: "working"
    });
    await insertAttempt({
      ownerId: fixture.ownerId,
      jobId: job.jobId,
      attemptNumber: 2,
      startedAt: new Date("2026-09-30T10:02:00.000Z"),
      phase: "checking",
      phaseObservedAt: checkingAt
    });
    let page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(page?.items[0]).toMatchObject({
      phase: "checking",
      phaseObservedAt: checkingAt.toISOString()
    });
    await pool.query(
      `update team_memberships set status='disabled',disabled_at=now() where team_id=$1 and user_id=$2`,
      [fixture.teamId, fixture.ownerId]
    );
    await pool.query(
      `update personal_agent_execution_attempts set phase='working',phase_observed_at=now() where job_id=$1 and attempt_number=2`,
      [job.jobId]
    );
    page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(page?.items[0]).toMatchObject({
      phase: "checking",
      phaseObservedAt: checkingAt.toISOString(),
      ownerLeftTeam: true
    });
  });

  it("fences live phase writes to the current attempt and preserves the frozen projection", async () => {
    const fixture = await createFixture();
    const managedRepository = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const runnerId = `phase-runner-${randomUUID()}`;
    const actorForOwner = actor(fixture.ownerId);
    const managed = await managedRepository.createManagedConversation(
      actorForOwner,
      {
        provider: "codex",
        aiClientInstanceId: "codex.default",
        model: "test-model",
        permissionMode: "supervised",
        runnerKind: "local_device",
        projectId: fixture.localProjectId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        idempotencyKey: randomUUID()
      }
    );
    const [start] = await managedRepository.claimManagedConversationCommands({
      ownerUserId: fixture.ownerId,
      runnerId,
      deploymentId,
      deviceId,
      leaseMs: 60_000
    });
    const running = await managedRepository.bindManagedConversationRuntime(
      actorForOwner,
      {
        executionId: managed.execution.id,
        expectedStateVersion: start!.execution.stateVersion,
        executionGeneration: 1,
        runnerId,
        logicalSessionId: randomUUID(),
        providerThreadId: randomUUID(),
        providerCliVersion: "test"
      }
    );
    await managedRepository.completeManagedConversationCommand({
      commandId: start!.id,
      leaseToken: start!.leaseToken!,
      result: { started: true }
    });
    const prompt = await managedRepository.enqueueManagedConversationPrompt(
      actorForOwner,
      {
        executionId: running.id,
        executionGeneration: 1,
        idempotencyKey: randomUUID(),
        clientUserMessageId: randomUUID(),
        prompt: "Run an assigned task"
      }
    );
    const [claimedPrompt] =
      await managedRepository.claimManagedConversationCommands({
        ownerUserId: fixture.ownerId,
        runnerId,
        deploymentId,
        deviceId,
        leaseMs: 60_000
      });
    expect(claimedPrompt?.id).toBe(prompt.id);

    const job = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running",
      executionId: running.id
    });
    const attemptId = randomUUID();
    const startedAt = new Date();
    await pool.query(
      `update personal_agent_execution_jobs
          set command_id=$2,last_attempt_id=$3,attempts_started=1
        where id=$1`,
      [job.jobId, prompt.id, attemptId]
    );
    await pool.query(
      `insert into personal_agent_execution_attempts(
        id,owner_user_id,job_id,command_id,attempt_number,attribution_kind,
        agent_id,agent_version,provider,model,ai_client_instance_id,
        permission_mode,managed_execution_id,managed_execution_generation,
        status,started_at,phase,phase_observed_at
      ) values($1,$2,$3,$4,1,'agent',$5,1,'codex','test-model','codex.default',
        'supervised',$6,1,'running',$7,'working',$7)`,
      [
        attemptId,
        fixture.ownerId,
        job.jobId,
        prompt.id,
        job.agentId,
        running.id,
        startedAt
      ]
    );
    await pool.query(
      `insert into personal_agent_execution_job_events(
        owner_user_id,job_id,sequence,event_id,execution_generation,event_type,payload,observed_at
      ) values($1,$2,1,$3,1,'attempt_started',$4::jsonb,$5)`,
      [
        fixture.ownerId,
        job.jobId,
        `attempt:${attemptId}:started`,
        JSON.stringify({ attemptId, attemptNumber: 1 }),
        startedAt
      ]
    );
    const encryptedPayload = await provider.encrypt({
      plaintext: JSON.stringify({ personalAgent: { jobId: job.jobId } }),
      scope: {
        tenantId: fixture.ownerId,
        objectClass: "managed_conversation_prompt"
      },
      provenance: {
        rowFamily: "managed_conversation_commands",
        sourceId: prompt.id
      },
      ciphertextLocation: "managed_conversation_commands.encrypted_payload",
      aad: {
        ownerUserId: fixture.ownerId,
        executionId: running.id,
        commandId: prompt.id
      }
    });
    await pool.query(
      `update managed_conversation_commands set encrypted_payload=$2::jsonb where id=$1`,
      [prompt.id, encryptedPayload]
    );
    const signal = {
      commandId: prompt.id,
      executionId: running.id,
      executionGeneration: 1,
      leaseToken: claimedPrompt!.leaseToken!,
      runnerId,
      deviceId,
      deploymentId,
      providerTurnId: "codex-provider-turn-1",
      attemptId,
      phase: "checking" as const
    };
    await managedRepository.recordPersonalAgentPhaseForManagedCommand(
      actorForOwner,
      signal
    );
    const phase = await pool.query<{
      phase: string;
      phase_observed_at: Date;
      provider_turn_id: string | null;
    }>(
      `select phase,phase_observed_at,provider_turn_id
         from personal_agent_execution_attempts where id=$1`,
      [attemptId]
    );
    expect(phase.rows[0]).toMatchObject({
      phase: "checking",
      provider_turn_id: signal.providerTurnId
    });
    const adminPage = await publicSquare.listPublicSquare(
      actor(fixture.adminId),
      { teamId: fixture.teamId, limit: 50 }
    );
    expect(
      adminPage?.items.find((item) => item.jobId === job.jobId)
    ).toMatchObject({
      phase: "checking",
      phaseObservedAt: phase.rows[0]!.phase_observed_at.toISOString()
    });

    await expect(
      managedRepository.recordPersonalAgentPhaseForManagedCommand(
        actor(fixture.adminId),
        signal
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      managedRepository.recordPersonalAgentPhaseForManagedCommand(
        actorForOwner,
        { ...signal, executionGeneration: 2 }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      managedRepository.recordPersonalAgentPhaseForManagedCommand(
        actorForOwner,
        { ...signal, providerTurnId: "codex-provider-turn-2", phase: "working" }
      )
    ).rejects.toMatchObject({ statusCode: 409 });

    await pool.query(
      `update team_memberships set status='disabled',disabled_at=now() where team_id=$1 and user_id=$2`,
      [fixture.teamId, fixture.ownerId]
    );
    await managedRepository.recordPersonalAgentPhaseForManagedCommand(
      actorForOwner,
      { ...signal, phase: "working" }
    );
    const frozenPage = await publicSquare.listPublicSquare(
      actor(fixture.adminId),
      { teamId: fixture.teamId, limit: 50 }
    );
    expect(
      frozenPage?.items.find((item) => item.jobId === job.jobId)
    ).toMatchObject({
      ownerLeftTeam: true,
      phase: "checking",
      phaseObservedAt: phase.rows[0]!.phase_observed_at.toISOString()
    });

    await pool.query(
      `update managed_conversation_commands set lease_expires_at=now()-interval '1 second' where id=$1`,
      [prompt.id]
    );
    await expect(
      managedRepository.recordPersonalAgentPhaseForManagedCommand(
        actorForOwner,
        { ...signal, phase: "checking" }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("identifies the owner only for actionable live waits", async () => {
    const fixture = await createFixture();
    const job = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running"
    });
    const item = async (
      kind: "user_input" | "transient_output",
      providerRequestId: string
    ) =>
      pool.query(
        `insert into managed_conversation_runtime_items(owner_user_id,execution_id,execution_generation,provider_request_id,item_kind,state,request_digest,encrypted_payload)
         values($1,$2,1,$3,$4,'pending',$5,'{}'::jsonb)`,
        [
          fixture.ownerId,
          job.executionId,
          providerRequestId,
          kind,
          "d".repeat(64)
        ]
      );
    await item("transient_output", `output:${randomUUID()}`);
    let page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(page?.items[0]).toMatchObject({
      status: "running",
      waitingOn: null
    });

    await item("user_input", `input:${randomUUID()}`);
    page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(page?.items[0]).toMatchObject({
      status: "waiting",
      waitingOn: { userId: fixture.ownerId, name: "Square Owner" }
    });

    await pool.query(
      `update managed_conversation_executions set runner_lease_expires_at=now()-interval '1 second' where id=$1`,
      [job.executionId]
    );
    page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(page?.items[0]).toMatchObject({
      status: "offline",
      waitingOn: null
    });
    await pool.query(
      `update managed_conversation_executions set runner_lease_expires_at=now()+interval '1 minute' where id=$1`,
      [job.executionId]
    );

    await pool.query(
      `update team_memberships set status='disabled',disabled_at=now() where team_id=$1 and user_id=$2`,
      [fixture.teamId, fixture.ownerId]
    );
    page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(page?.items[0]).toMatchObject({
      status: "waiting",
      ownerLeftTeam: true,
      waitingOn: null
    });
  });

  it("lists only Team-scoped idle offers and excludes current Jobs beyond the visible page", async () => {
    const fixture = await createFixture();
    const personalActivity = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: `personal:${randomUUID()}`,
      state: "running"
    });
    await createOffer(
      fixture.teamId,
      fixture.ownerId,
      personalActivity.agentId
    );

    const olderCurrent = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running"
    });
    await createOffer(fixture.teamId, fixture.ownerId, olderCurrent.agentId);
    await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running"
    });

    const otherTeamId = (
      await pool.query<{ id: string }>(
        `insert into teams(name,entitlement_status) values($1,'active') returning id`,
        [`Square Other ${randomUUID()}`]
      )
    ).rows[0]!.id;
    await pool.query(
      `insert into team_memberships(team_id,user_id,role,status,accepted_at) values($1,$2,'member','enabled',now()),($1,$3,'admin','enabled',now())`,
      [otherTeamId, fixture.ownerId, fixture.adminId]
    );
    await createOffer(otherTeamId, fixture.ownerId, olderCurrent.agentId);

    const firstTeamPage = await publicSquare.listPublicSquare(
      actor(fixture.adminId),
      { teamId: fixture.teamId, limit: 1 }
    );
    expect(firstTeamPage?.items).toHaveLength(1);
    expect(firstTeamPage?.nextCursor).toBeTruthy();
    expect(firstTeamPage?.idleAgents).toContainEqual({
      agentId: personalActivity.agentId,
      agentName: "Private Agent",
      ownerId: fixture.ownerId,
      ownerName: "Square Owner"
    });
    expect(
      firstTeamPage?.idleAgents.some(
        (agent) => agent.agentId === olderCurrent.agentId
      )
    ).toBe(false);

    const secondTeamPage = await publicSquare.listPublicSquare(
      actor(fixture.adminId),
      { teamId: otherTeamId, limit: 1 }
    );
    expect(secondTeamPage?.items).toEqual([]);
    expect(
      secondTeamPage?.idleAgents.some(
        (agent) => agent.agentId === olderCurrent.agentId
      )
    ).toBe(true);
  });

  it("keeps current activity ahead of paginated terminal history", async () => {
    const fixture = await createFixture();
    const olderTerminal = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running"
    });
    await pool.query(
      `update personal_agent_execution_jobs set state='succeeded',created_at=now()-interval '2 days',updated_at=now()-interval '2 days' where id=$1`,
      [olderTerminal.jobId]
    );
    await pool.query(
      `update personal_agent_team_job_publications set published_at=now()-interval '2 days' where job_id=$1`,
      [olderTerminal.jobId]
    );
    const current = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running"
    });
    const page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 1
    });
    expect(page?.items[0]?.jobId).toBe(current.jobId);
    expect(page?.nextCursor).toBeTruthy();
  });

  it("keeps an explicit owner wait ahead of terminal Job history", async () => {
    const fixture = await createFixture();
    const terminal = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running"
    });
    await pool.query(
      `update personal_agent_execution_jobs set state='succeeded',created_at=now()-interval '2 days',updated_at=now()-interval '2 days' where id=$1`,
      [terminal.jobId]
    );
    await pool.query(
      `update personal_agent_team_job_publications set published_at=now()-interval '2 days' where job_id=$1`,
      [terminal.jobId]
    );
    const waiting = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running"
    });
    await pool.query(
      `update personal_agent_execution_jobs set state='waiting' where id=$1`,
      [waiting.jobId]
    );

    const page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 1
    });
    expect(page?.items[0]).toMatchObject({
      jobId: waiting.jobId,
      status: "waiting",
      waitingOn: { userId: fixture.ownerId, name: "Square Owner" }
    });
  });

  it("rejects the no-Project sentinel as a member connection", async () => {
    const fixture = await createFixture(false);
    await expect(
      publicSquare.setPublicSquareConnection(actor(fixture.ownerId), {
        teamId: fixture.teamId,
        teamProjectId: fixture.project.id,
        expectedVersion: 0,
        localProjectId: "unassigned"
      })
    ).rejects.toThrow();
  });

  it("shares only active Jobs on first connection and retains completed history when remapping", async () => {
    const fixture = await createFixture(false);
    const finishedBeforeShare = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "succeeded"
    });
    const activeBeforeShare = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running"
    });
    const initialConnection = await publicSquare.setPublicSquareConnection(
      actor(fixture.ownerId),
      {
        teamId: fixture.teamId,
        teamProjectId: fixture.project.id,
        expectedVersion: 0,
        localProjectId: fixture.localProjectId
      }
    );
    expect(initialConnection?.version).toBe(1);
    let page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(page?.items.map((item) => item.jobId)).toEqual([
      activeBeforeShare.jobId
    ]);
    expect(page?.items.map((item) => item.jobId)).not.toContain(
      finishedBeforeShare.jobId
    );

    const oldCurrent = activeBeforeShare;
    const oldCompleted = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running"
    });
    await pool.query(
      `update personal_agent_execution_jobs set state='succeeded',updated_at=now() where id=$1`,
      [oldCompleted.jobId]
    );
    const nextLocalProjectId = `project:${randomUUID()}`;
    const newCurrent = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: nextLocalProjectId,
      state: "running"
    });
    const remapped = await publicSquare.setPublicSquareConnection(
      actor(fixture.ownerId),
      {
        teamId: fixture.teamId,
        teamProjectId: fixture.project.id,
        expectedVersion: initialConnection!.version,
        localProjectId: nextLocalProjectId
      }
    );
    expect(remapped?.version).toBe(2);
    page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    const jobs = page?.items.map((item) => item.jobId) ?? [];
    expect(jobs).toContain(oldCompleted.jobId);
    expect(jobs).toContain(newCurrent.jobId);
    expect(jobs).not.toContain(oldCurrent.jobId);
    expect(jobs).not.toContain(finishedBeforeShare.jobId);
  });

  it("lets a Team admin remove a retained brief without restoring it when the owner rejoins", async () => {
    const fixture = await createFixture();
    const job = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId
    });
    let page = await publicSquare.listPublicSquare(actor(fixture.ownerId), {
      teamId: fixture.teamId,
      limit: 50
    });
    const publication = page!.items.find((item) => item.jobId === job.jobId)!;
    await publicSquare.updatePublicSquareBrief(actor(fixture.ownerId), {
      teamId: fixture.teamId,
      publicationId: publication.id,
      expectedVersion: publication.version,
      brief: "Reviewed and shared"
    });
    await pool.query(
      `update team_memberships set status='disabled',disabled_at=now() where team_id=$1 and user_id=$2`,
      [fixture.teamId, fixture.ownerId]
    );
    page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    const retained = page!.items[0]!;
    expect(retained).toMatchObject({
      ownerLeftTeam: true,
      sharedBrief: "Reviewed and shared",
      canRemoveRetainedBrief: true
    });
    const removed = await publicSquare.updatePublicSquareBrief(
      actor(fixture.adminId),
      {
        teamId: fixture.teamId,
        publicationId: retained.id,
        expectedVersion: retained.version,
        brief: null
      }
    );
    expect(removed?.sharedBrief).toBeNull();
    await pool.query(
      `update team_memberships set status='enabled',disabled_at=null where team_id=$1 and user_id=$2`,
      [fixture.teamId, fixture.ownerId]
    );
    page = await publicSquare.listPublicSquare(actor(fixture.ownerId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(page?.items[0]).toMatchObject({
      ownerLeftTeam: true,
      sharedBrief: null,
      canEditBrief: false
    });
  });

  it("does not derive waiting from a later Job for an earlier terminal Job in the same execution", async () => {
    const fixture = await createFixture();
    const prior = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running"
    });
    await pool.query(
      `update personal_agent_execution_jobs set state='succeeded',updated_at=now() where id=$1`,
      [prior.jobId]
    );
    const waiting = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "running",
      executionId: prior.executionId
    });
    await pool.query(
      `insert into managed_conversation_runtime_items(owner_user_id,execution_id,execution_generation,provider_request_id,item_kind,state,request_digest,encrypted_payload)
      values($1,$2,1,$3,'user_input','pending',$4,'{}'::jsonb)`,
      [
        fixture.ownerId,
        prior.executionId,
        `request:${randomUUID()}`,
        "d".repeat(64)
      ]
    );
    const page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(page?.items.find((item) => item.jobId === prior.jobId)?.status).toBe(
      "succeeded"
    );
    expect(
      page?.items.find((item) => item.jobId === waiting.jobId)?.status
    ).toBe("waiting");
  });

  it("reports a failed assigned execution as terminal for a dangling queued Job", async () => {
    const fixture = await createFixture();
    const job = await insertJob({
      ownerId: fixture.ownerId,
      localProjectId: fixture.localProjectId,
      state: "queued"
    });
    await pool.query(
      `update managed_conversation_executions set state='failed',state_version=state_version+1,
        runner_id=null,runner_lease_expires_at=null,last_error_code='ManagedConversationProjectUnavailableError',stopped_at=now(),updated_at=now()
        where id=$1`,
      [job.executionId]
    );
    const page = await publicSquare.listPublicSquare(actor(fixture.adminId), {
      teamId: fixture.teamId,
      limit: 50
    });
    expect(page?.items[0]).toMatchObject({
      jobId: job.jobId,
      status: "failed",
      completedAt: expect.any(String)
    });
  });
});

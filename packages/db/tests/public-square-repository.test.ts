import { randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createCollaborationRepository } from "../src/collaboration-repository.js";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
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
    const agentId = randomUUID();
    await pool.query(
      `insert into personal_agent_identities(id,owner_user_id,name,role,default_provider,default_model,current_version,creation_request_id,creation_request_fingerprint) values($1,$2,'Private Agent','Private role','codex','test-model',1,$3,$4)`,
      [agentId, input.ownerId, randomUUID(), "b".repeat(64)]
    );
    await pool.query(
      `insert into personal_agent_identity_versions(agent_id,owner_user_id,version,name,role,default_provider,default_model,soul_instructions,instruction_source,created_by_user_id,request_id,request_fingerprint) values($1,$2,1,'Private Agent','Private role','codex','test-model','[koed encrypted personal agent soul]','custom',$2,$3,$4)`,
      [agentId, input.ownerId, randomUUID(), "c".repeat(64)]
    );
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
    return { executionId, jobId };
  };

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

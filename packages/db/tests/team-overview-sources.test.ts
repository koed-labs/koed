import { createHash, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createCollaborationRepository } from "../src/collaboration-repository.js";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import { createTeamOverviewSourcesRepository } from "../src/team-overview-sources.js";

const databaseUrl =
  process.env.TEAM_OVERVIEW_TEST_DATABASE_URL ??
  process.env.COLLABORATION_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const actor = (userId: string) => ({ userId });

describeDb("Team overview sources repository", () => {
  let pool: pg.Pool;
  let collaboration: ReturnType<typeof createCollaborationRepository>;
  let sources: ReturnType<typeof createTeamOverviewSourcesRepository>;
  const personalProvider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 71).toString("base64")
  );
  const teamProvider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 72).toString("base64")
  );

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl! });
    await runDbMigrations(pool);
    collaboration = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: personalProvider,
      teamEnvelopeEncryptionProvider: teamProvider
    });
    sources = createTeamOverviewSourcesRepository(pool, {
      envelopeEncryptionProvider: personalProvider,
      teamEnvelopeEncryptionProvider: teamProvider
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  const makeUser = async (label: string) =>
    (
      await pool.query<{ id: string }>(
        `insert into users(email,display_name) values($1,$2) returning id`,
        [`${label}-${randomUUID()}@example.test`, label]
      )
    ).rows[0]!.id;

  const makePublishedJob = async (input: {
    ownerId: string;
    localProjectId: string;
    state?: "running" | "succeeded";
  }) => {
    const executionId = randomUUID();
    const jobId = randomUUID();
    const agentId = randomUUID();
    await pool.query(
      `insert into managed_conversation_executions(
         id,owner_user_id,project_id,ai_client_instance_id,model,permission_mode,
         runner_kind,state,execution_generation,fencing_token_hash,
         runner_deployment_id,runner_device_id,runner_id,runner_lease_expires_at,
         logical_session_id,provider_thread_id,started_at,runner_last_seen_at
       ) values($1,$2,$3,'codex.default','test-model','supervised','local_device',
         'running',1,$4,$5,$6,'overview-runner',now()+interval '1 minute',$7,$8,now(),now())`,
      [
        executionId,
        input.ownerId,
        input.localProjectId,
        "a".repeat(64),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        `overview-${randomUUID()}`
      ]
    );
    await pool.query(
      `insert into personal_agent_identities(
         id,owner_user_id,name,role,default_provider,default_model,current_version,
         creation_request_id,creation_request_fingerprint
       ) values($1,$2,'Overview Agent','Private role','codex','test-model',1,$3,$4)`,
      [agentId, input.ownerId, randomUUID(), "b".repeat(64)]
    );
    await pool.query(
      `insert into personal_agent_identity_versions(
         agent_id,owner_user_id,version,name,role,default_provider,default_model,
         soul_instructions,instruction_source,created_by_user_id,request_id,request_fingerprint
       ) values($1,$2,1,'Overview Agent','Private role','codex','test-model',
         '[koed encrypted personal agent soul]','custom',$2,$3,$4)`,
      [agentId, input.ownerId, randomUUID(), "c".repeat(64)]
    );
    await pool.query(
      `insert into personal_agent_execution_jobs(
         id,owner_user_id,conversation_id,attribution_kind,agent_id,agent_version,
         state,project_id,title
       ) values($1,$2,$3,'agent',$4,1,$5,$6,'PRIVATE JOB TITLE')`,
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

  it("projects authorized unread Team messages and validates the exact source revision", async () => {
    const ownerId = await makeUser("Overview owner");
    const memberId = await makeUser("Overview member");
    const outsiderId = await makeUser("Overview outsider");
    const teamId = (
      await pool.query<{ id: string }>(
        `insert into teams(name,entitlement_status) values($1,'active') returning id`,
        [`Overview ${randomUUID()}`]
      )
    ).rows[0]!.id;
    await pool.query(
      `insert into team_memberships(team_id,user_id,role,status,accepted_at)
       values($1,$2,'member','enabled',now()),($1,$3,'member','enabled',now())`,
      [teamId, ownerId, memberId]
    );
    const project = await collaboration.createTeamSharedProject(
      actor(ownerId),
      {
        teamId,
        idempotencyKey: `team-overview-project:${randomUUID()}`,
        name: "Overview project"
      }
    );
    if (!project) throw new Error("Expected an authorized Team Project");

    const root = await collaboration.sendMessage(actor(ownerId), {
      threadId: project.thread.id,
      idempotencyKey: `team-overview-root:${randomUUID()}`,
      bodyText: "The root message is read before its reply arrives.",
      provenance: { kind: "user", id: randomUUID() }
    });
    if (!root) throw new Error("Expected a root message");
    await collaboration.advanceReadState(actor(ownerId), {
      threadId: project.thread.id,
      messageId: root.id
    });
    const replies = [];
    for (let index = 0; index < 5; index += 1) {
      const reply = await collaboration.sendMessage(actor(memberId), {
        threadId: project.thread.id,
        rootMessageId: root.id,
        idempotencyKey: `team-overview-reply:${randomUUID()}`,
        bodyText: `Reply ${index + 1} to the owner's read root.`,
        provenance: { kind: "user", id: randomUUID() }
      });
      if (!reply) throw new Error("Expected a reply");
      replies.push(reply);
    }
    const mention = await collaboration.sendMessage(actor(memberId), {
      threadId: project.thread.id,
      idempotencyKey: `team-overview-mention:${randomUUID()}`,
      bodyText: "A direct Team mention.",
      mentionUserIds: [ownerId],
      provenance: { kind: "user", id: randomUUID() }
    });
    if (!mention) throw new Error("Expected a mention");
    const ordinaryRoot = await collaboration.sendMessage(actor(memberId), {
      threadId: project.thread.id,
      idempotencyKey: `team-overview-ordinary-root:${randomUUID()}`,
      bodyText: "Ordinary unread work stays in catch-up beside attention.",
      provenance: { kind: "user", id: randomUUID() }
    });
    if (!ordinaryRoot) throw new Error("Expected an ordinary channel root");
    const ordinaryReplyToAttentionRoot = await collaboration.sendMessage(
      actor(memberId),
      {
        threadId: project.thread.id,
        rootMessageId: mention.id,
        idempotencyKey: `team-overview-ordinary-reply:${randomUUID()}`,
        bodyText: "Ordinary reply under a root already shown for attention.",
        provenance: { kind: "user", id: randomUUID() }
      }
    );
    if (!ordinaryReplyToAttentionRoot)
      throw new Error("Expected an ordinary reply under the attention root");

    const dm = await collaboration.createThread(actor(ownerId), {
      kind: "dm",
      idempotencyKey: `team-overview-dm:${randomUUID()}`,
      teamId,
      participantUserIds: [ownerId, memberId]
    });
    if (!dm) throw new Error("Expected an authorized Team DM");
    const dmMessage = await collaboration.sendMessage(actor(memberId), {
      threadId: dm.id,
      idempotencyKey: `team-overview-dm-message:${randomUUID()}`,
      bodyText: "A private direct message.",
      provenance: { kind: "user", id: randomUUID() }
    });
    if (!dmMessage) throw new Error("Expected a direct message");

    const snapshot = await sources.listCurrentItems(actor(ownerId));
    const rootReplyItem = snapshot.attention.find(
      (item) => item.sourceEventId === `message-root:${root.id}`
    );
    expect(rootReplyItem).toMatchObject({
      sourceId: root.id,
      unreadCount: 5,
      summary: "Reply 5 to the owner's read root."
    });
    expect(snapshot.attention.map((item) => item.sourceEventId)).toEqual(
      expect.arrayContaining([
        `message-root:${root.id}`,
        `message-root:${mention.id}`,
        `dm:${dm.id}`
      ])
    );
    expect(
      snapshot.attention.filter(
        (item) => item.sourceEventId === `message-root:${root.id}`
      )
    ).toHaveLength(1);
    expect(snapshot.catchUp).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceEventId: `catch-up:${project.thread.id}`,
          sourceId: project.thread.id,
          unreadCount: 1,
          destination: {
            kind: "thread",
            threadId: project.thread.id,
            rootMessageId: null
          }
        })
      ])
    );
    expect(
      (await sources.listCurrentItems(actor(outsiderId))).attention
    ).toEqual([]);

    const client = await pool.connect();
    try {
      const ref = {
        teamId,
        source: "message_attention" as const,
        sourceEventId: `message-root:${root.id}`,
        sourceId: root.id
      };
      const current = await sources.getCurrentSourceWithClient(
        client,
        actor(ownerId),
        ref
      );
      expect(current).not.toBeNull();
      expect(
        await sources.validateCurrentSourceWithClient(
          client,
          actor(ownerId),
          current!
        )
      ).toBe(true);

      const extraReply = await collaboration.sendMessage(actor(memberId), {
        threadId: project.thread.id,
        rootMessageId: root.id,
        idempotencyKey: `team-overview-extra-reply:${randomUUID()}`,
        bodyText: "A new reply resurface the cleared root.",
        provenance: { kind: "user", id: randomUUID() }
      });
      if (!extraReply) throw new Error("Expected a new reply");
      expect(
        await sources.validateCurrentSourceWithClient(
          client,
          actor(ownerId),
          current!
        )
      ).toBe(false);
      const newRevision = await sources.getCurrentSourceWithClient(
        client,
        actor(ownerId),
        ref
      );
      expect(newRevision?.sourceRevision).not.toBe(current?.sourceRevision);

      await collaboration.editMessage(actor(memberId), {
        threadId: project.thread.id,
        messageId: extraReply.id,
        expectedVersion: extraReply.version,
        bodyText: "The reply has a new message revision."
      });
      expect(
        await sources.validateCurrentSourceWithClient(
          client,
          actor(ownerId),
          newRevision!
        )
      ).toBe(false);
    } finally {
      client.release();
    }

    await pool.query(
      `update team_memberships set status='disabled',disabled_at=now()
        where team_id=$1 and user_id=$2`,
      [teamId, ownerId]
    );
    expect(await sources.listCurrentItems(actor(ownerId))).toEqual({
      attention: [],
      catchUp: []
    });
  });

  it("projects owner blockers and shared Job outcomes without publication noise or future frozen state", async () => {
    const ownerId = await makeUser("Job owner");
    const peerId = await makeUser("Job peer");
    const teamId = (
      await pool.query<{ id: string }>(
        `insert into teams(name,entitlement_status) values($1,'active') returning id`,
        [`Overview Jobs ${randomUUID()}`]
      )
    ).rows[0]!.id;
    await pool.query(
      `insert into team_memberships(team_id,user_id,role,status,accepted_at)
       values($1,$2,'member','enabled',now()),($1,$3,'member','enabled',now())`,
      [teamId, ownerId, peerId]
    );
    const localProjectId = `overview-job-project:${randomUUID()}`;
    const project = await collaboration.createTeamSharedProject(
      actor(ownerId),
      {
        teamId,
        idempotencyKey: `team-overview-job-project:${randomUUID()}`,
        name: "Overview Jobs project",
        localProjectId
      }
    );
    if (!project) throw new Error("Expected connected Team Project");
    const job = await makePublishedJob({ ownerId, localProjectId });
    const publication = (
      await pool.query<{ id: string }>(
        `select id from personal_agent_team_job_publications where job_id=$1 and team_id=$2`,
        [job.jobId, teamId]
      )
    ).rows[0];
    if (!publication) throw new Error("Expected connected Job publication");
    await pool.query(
      `insert into managed_conversation_runtime_items(
         id,owner_user_id,execution_id,execution_generation,provider_request_id,
         item_kind,state,request_digest,encrypted_payload,revision
       ) values($1,$2,$3,1,$4,'user_input','pending',$5,$6::jsonb,3)`,
      [
        randomUUID(),
        ownerId,
        job.executionId,
        `input-${randomUUID()}`,
        createHash("sha256").update("private runtime request").digest("hex"),
        JSON.stringify({ payload: "[koed encrypted runtime item payload]" })
      ]
    );

    const ownerWaiting = await sources.listCurrentItems(actor(ownerId));
    const blocker = ownerWaiting.attention.find(
      (item) => item.sourceEventId === `job-action:${publication.id}`
    );
    expect(blocker).toMatchObject({
      priority: "blocker",
      state: "blocked",
      kind: "job_action",
      sourceId: publication.id
    });
    expect(
      ownerWaiting.attention.filter((item) => item.sourceId === publication.id)
    ).toHaveLength(1);
    const peerWaiting = await sources.listCurrentItems(actor(peerId));
    expect(
      peerWaiting.attention.some((item) => item.sourceId === publication.id)
    ).toBe(false);
    expect(
      peerWaiting.catchUp.some((item) => item.sourceId === publication.id)
    ).toBe(false);
    expect(JSON.stringify(ownerWaiting)).not.toContain("PRIVATE JOB TITLE");
    expect(JSON.stringify(ownerWaiting)).not.toContain(
      "[koed encrypted runtime item payload]"
    );

    const client = await pool.connect();
    let currentAction: Awaited<
      ReturnType<typeof sources.getCurrentSourceWithClient>
    >;
    try {
      currentAction = await sources.getCurrentSourceWithClient(
        client,
        actor(ownerId),
        {
          teamId,
          source: "team_job_action",
          sourceEventId: `job-action:${publication.id}`,
          sourceId: publication.id
        }
      );
      expect(currentAction).not.toBeNull();
      await pool.query(
        `update personal_agent_team_job_publications
            set last_seen_at=now(),version=version+1,updated_at=now()
          where id=$1`,
        [publication.id]
      );
      const afterHeartbeat = await sources.getCurrentSourceWithClient(
        client,
        actor(ownerId),
        {
          teamId,
          source: "team_job_action",
          sourceEventId: `job-action:${publication.id}`,
          sourceId: publication.id
        }
      );
      expect(afterHeartbeat?.sourceRevision).toBe(
        currentAction?.sourceRevision
      );
    } finally {
      client.release();
    }

    await pool.query(
      `update managed_conversation_runtime_items set state='resolved',resolved_at=now()
        where owner_user_id=$1 and execution_id=$2 and item_kind='user_input'`,
      [ownerId, job.executionId]
    );
    await pool.query(
      `update personal_agent_execution_jobs set state='succeeded',updated_at=now() where id=$1`,
      [job.jobId]
    );
    const ownerSuccess = await sources.listCurrentItems(actor(ownerId));
    const success = ownerSuccess.catchUp.find(
      (item) => item.sourceEventId === `job-outcome:${publication.id}`
    );
    expect(success).toMatchObject({ kind: "job_outcome", state: "recent" });
    const peerSuccess = await sources.listCurrentItems(actor(peerId));
    expect(
      peerSuccess.catchUp.find(
        (item) => item.sourceEventId === `job-outcome:${publication.id}`
      )
    ).toMatchObject({
      kind: "job_outcome",
      title: "Published Agent Job completed"
    });
    await pool.query(
      `update personal_agent_team_job_publications
          set last_seen_at=now(),version=version+1,updated_at=now()
        where id=$1`,
      [publication.id]
    );
    expect(
      (await sources.listCurrentItems(actor(peerId))).catchUp.find(
        (item) => item.sourceEventId === `job-outcome:${publication.id}`
      )?.sourceRevision
    ).toBe(success?.sourceRevision);

    const reviewId = randomUUID();
    const reviewDigest = createHash("sha256")
      .update(`team overview PR ${reviewId}`)
      .digest("hex");
    const baseSha = "1".repeat(40);
    const headSha = "2".repeat(40);
    await pool.query(
      `insert into pull_request_reviews(
         id,owner_user_id,agent_id,agent_version,execution_id,project_id,
         target_device_id,target_deployment_id,account_id,repository_id,pull_request_number,
         expected_base_sha,expected_head_sha,connection_generation,work_mode,status,
         revision,draft_revision,idempotency_key,request_digest,encrypted_selection
       ) values($1,$2,$3,1,$4,$5,$6,$7,'test-account','test/repo',17,$8,$9,1,
         'fix','draft',1,1,$10,$11,$12::jsonb)`,
      [
        reviewId,
        ownerId,
        job.agentId,
        job.executionId,
        localProjectId,
        randomUUID(),
        randomUUID(),
        baseSha,
        headSha,
        `overview-pr:${reviewId}`,
        reviewDigest,
        JSON.stringify({ payload: "[koed encrypted PR selection]" })
      ]
    );
    await pool.query(
      `insert into pull_request_review_drafts(
         id,review_id,owner_user_id,revision,origin,agent_job_id,execution_generation,
         account_id,base_sha,head_sha,encrypted_payload
       ) values($1,$2,$3,1,'agent',$4,1,'test-account',$5,$6,$7::jsonb)`,
      [
        randomUUID(),
        reviewId,
        ownerId,
        job.jobId,
        baseSha,
        headSha,
        JSON.stringify({ payload: "[koed encrypted PR draft]" })
      ]
    );
    const ownerWithPrAction = await sources.listCurrentItems(actor(ownerId));
    expect(
      ownerWithPrAction.attention.find(
        (item) => item.sourceEventId === `pr:${reviewId}`
      )
    ).toMatchObject({
      kind: "pull_request_action",
      title: "test/repo #17 review needs attention"
    });
    expect(
      ownerWithPrAction.catchUp.some(
        (item) => item.sourceEventId === `job-outcome:${publication.id}`
      )
    ).toBe(false);
    const peerWithPrAction = await sources.listCurrentItems(actor(peerId));
    expect(
      peerWithPrAction.attention.some(
        (item) => item.sourceEventId === `pr:${reviewId}`
      )
    ).toBe(false);
    expect(
      peerWithPrAction.catchUp.some(
        (item) => item.sourceEventId === `job-outcome:${publication.id}`
      )
    ).toBe(true);
    const unshareProjectId = `overview-pr-unshare:${randomUUID()}`;
    const unshareJob = await makePublishedJob({
      ownerId,
      localProjectId: unshareProjectId
    });
    const unshareProject = await collaboration.createTeamSharedProject(
      actor(ownerId),
      {
        teamId,
        idempotencyKey: `team-overview-pr-unshare:${randomUUID()}`,
        name: "PR unshare project",
        localProjectId: unshareProjectId
      }
    );
    if (!unshareProject) throw new Error("Expected PR unshare project");
    const unsharePublication = (
      await pool.query<{ id: string }>(
        `select id from personal_agent_team_job_publications where job_id=$1 and team_id=$2`,
        [unshareJob.jobId, teamId]
      )
    ).rows[0];
    if (!unsharePublication)
      throw new Error("Expected PR unshare Job publication");
    await pool.query(
      `update personal_agent_execution_jobs set state='succeeded',updated_at=now() where id=$1`,
      [unshareJob.jobId]
    );
    const unshareReviewId = randomUUID();
    const unshareSha = "3".repeat(40);
    await pool.query(
      `insert into pull_request_reviews(
         id,owner_user_id,agent_id,agent_version,execution_id,project_id,
         target_device_id,target_deployment_id,account_id,repository_id,pull_request_number,
         expected_base_sha,expected_head_sha,connection_generation,work_mode,status,
         revision,draft_revision,idempotency_key,request_digest,encrypted_selection
       ) values($1,$2,$3,1,$4,$5,$6,$7,'test-account','test/unshare',18,$8,$9,1,
         'fix','draft',1,1,$10,$11,$12::jsonb)`,
      [
        unshareReviewId,
        ownerId,
        unshareJob.agentId,
        unshareJob.executionId,
        unshareProjectId,
        randomUUID(),
        randomUUID(),
        unshareSha,
        headSha,
        `overview-pr-unshare:${unshareReviewId}`,
        createHash("sha256").update(unshareReviewId).digest("hex"),
        JSON.stringify({ payload: "[koed encrypted PR selection]" })
      ]
    );
    await pool.query(
      `insert into pull_request_review_drafts(
         id,review_id,owner_user_id,revision,origin,agent_job_id,execution_generation,
         account_id,base_sha,head_sha,encrypted_payload
       ) values($1,$2,$3,1,'agent',$4,1,'test-account',$5,$6,$7::jsonb)`,
      [
        randomUUID(),
        unshareReviewId,
        ownerId,
        unshareJob.jobId,
        unshareSha,
        headSha,
        JSON.stringify({ payload: "[koed encrypted PR draft]" })
      ]
    );
    expect(
      (await sources.listCurrentItems(actor(ownerId))).attention.some(
        (item) => item.sourceEventId === `pr:${unshareReviewId}`
      )
    ).toBe(true);
    await pool.query(
      `update collaboration_team_shared_projects set unshared_at=now() where id=$1`,
      [unshareProject.id]
    );
    expect(
      (await sources.listCurrentItems(actor(ownerId))).attention.some(
        (item) => item.sourceEventId === `pr:${unshareReviewId}`
      )
    ).toBe(false);

    const frozenWaitingJob = await makePublishedJob({
      ownerId,
      localProjectId
    });
    const frozenWaitingPublication = (
      await pool.query<{ id: string }>(
        `select id from personal_agent_team_job_publications where job_id=$1 and team_id=$2`,
        [frozenWaitingJob.jobId, teamId]
      )
    ).rows[0];
    if (!frozenWaitingPublication)
      throw new Error("Expected second Team Job publication");
    const frozenWaitingRuntimeItemId = randomUUID();
    await pool.query(
      `insert into managed_conversation_runtime_items(
         id,owner_user_id,execution_id,execution_generation,provider_request_id,
         item_kind,state,request_digest,encrypted_payload,revision
       ) values($1,$2,$3,1,$4,'user_input','pending',$5,$6::jsonb,1)`,
      [
        frozenWaitingRuntimeItemId,
        ownerId,
        frozenWaitingJob.executionId,
        `input-${randomUUID()}`,
        createHash("sha256").update("frozen waiting input").digest("hex"),
        JSON.stringify({ payload: "[koed encrypted runtime item payload]" })
      ]
    );
    await pool.query(
      `update personal_agent_team_job_publications
          set state='frozen',frozen_status='waiting',frozen_updated_at=now()
        where id=$1`,
      [frozenWaitingPublication.id]
    );
    const frozenWaitingSnapshot = await sources.listCurrentItems(
      actor(ownerId)
    );
    expect(
      frozenWaitingSnapshot.attention.some(
        (item) => item.sourceId === frozenWaitingPublication.id
      )
    ).toBe(false);
    await pool.query(
      `update managed_conversation_runtime_items set state='resolved',resolved_at=now(),revision=revision+1
        where id=$1`,
      [frozenWaitingRuntimeItemId]
    );
    await pool.query(
      `update personal_agent_execution_jobs set state='failed',updated_at=now() where id=$1`,
      [frozenWaitingJob.jobId]
    );
    const afterFrozenWaitingRuntimeChange = await sources.listCurrentItems(
      actor(ownerId)
    );
    expect(
      afterFrozenWaitingRuntimeChange.attention.some(
        (item) => item.sourceId === frozenWaitingPublication.id
      )
    ).toBe(false);
    expect(
      afterFrozenWaitingRuntimeChange.catchUp.some(
        (item) => item.sourceId === frozenWaitingPublication.id
      )
    ).toBe(false);

    await pool.query(
      `update team_memberships set status='disabled',disabled_at=now()
        where team_id=$1 and user_id=$2`,
      [teamId, ownerId]
    );
    const frozenBeforePrivateChange = await sources.listCurrentItems(
      actor(peerId)
    );
    const frozenSuccess = frozenBeforePrivateChange.catchUp.find(
      (item) => item.sourceEventId === `job-outcome:${publication.id}`
    );
    await pool.query(
      `update personal_agent_execution_jobs set state='failed',updated_at=now() where id=$1`,
      [job.jobId]
    );
    const frozen = await sources.listCurrentItems(actor(peerId));
    expect(
      frozen.catchUp.find(
        (item) => item.sourceEventId === `job-outcome:${publication.id}`
      )
    ).toMatchObject({
      sourceRevision: frozenSuccess?.sourceRevision,
      title: "Published Agent Job completed"
    });

    await pool.query(
      `update collaboration_team_shared_projects set unshared_at=now()
        where id=$1 and team_id=$2`,
      [project.id, teamId]
    );
    expect(
      (await sources.listCurrentItems(actor(peerId))).catchUp.some(
        (item) => item.sourceId === publication.id
      )
    ).toBe(false);
    expect(
      (await sources.listCurrentItems(actor(ownerId))).attention.some(
        (item) => item.sourceId === reviewId
      )
    ).toBe(false);
  });
});

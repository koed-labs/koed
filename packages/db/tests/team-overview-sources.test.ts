import { createHash, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createCollaborationRepository } from "../src/collaboration-repository.js";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import { registerNativePublicSquareWorkWithClient } from "../src/native-public-square-repository.js";
import { createTeamOverviewRepository } from "../src/team-overview-repository.js";
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
  let overview: ReturnType<typeof createTeamOverviewRepository>;
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
    overview = createTeamOverviewRepository(pool, sources);
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

  const makeNativePublishedWork = async () => {
    const ownerId = await makeUser("Native overview owner");
    const memberId = await makeUser("Native overview member");
    const teamId = (
      await pool.query<{ id: string }>(
        `insert into teams(name,entitlement_status) values($1,'active') returning id`,
        [`Native overview ${randomUUID()}`]
      )
    ).rows[0]!.id;
    await pool.query(
      `insert into team_memberships(team_id,user_id,role,status,accepted_at)
       values($1,$2,'member','enabled',now()),($1,$3,'admin','enabled',now())`,
      [teamId, ownerId, memberId]
    );
    const localProjectId = `native-overview:${randomUUID()}`;
    const project = await collaboration.createTeamSharedProject(
      actor(ownerId),
      {
        teamId,
        idempotencyKey: `native-overview-project:${randomUUID()}`,
        name: "Native overview Project",
        localProjectId
      }
    );
    if (!project) throw new Error("Expected an authorized Team Project");
    const agentId = randomUUID();
    await pool.query(
      `insert into personal_agent_identities(
         id,owner_user_id,name,role,default_provider,default_model,current_version,
         creation_request_id,creation_request_fingerprint
       ) values($1,$2,'Native shared Agent','PRIVATE ROLE','codex','test-model',1,$3,$4)`,
      [agentId, ownerId, randomUUID(), "a".repeat(64)]
    );
    await pool.query(
      `insert into personal_agent_identity_versions(
         agent_id,owner_user_id,version,name,role,default_provider,default_model,
         soul_instructions,instruction_source,created_by_user_id,request_id,request_fingerprint
       ) values($1,$2,1,'Native shared Agent','PRIVATE ROLE','codex','test-model',
         '[koed encrypted personal agent soul]','custom',$2,$3,$4)`,
      [agentId, ownerId, randomUUID(), "b".repeat(64)]
    );

    const executionId = randomUUID();
    const commandId = randomUUID();
    const leaseToken = randomUUID();
    await pool.query(
      `insert into managed_conversation_executions(
         id,owner_user_id,project_id,ai_client_instance_id,model,permission_mode,
         runner_kind,state,execution_generation,fencing_token_hash,
         runner_deployment_id,runner_device_id,runner_id,runner_lease_expires_at,
         logical_session_id,provider_thread_id,started_at,runner_last_seen_at
       ) values($1,$2,$3,'codex.default','test-model','supervised','local_device',
         'running',1,$4,$5,$6,'overview-runner',now()+interval '5 minutes',$7,$8,now(),now())`,
      [
        executionId,
        ownerId,
        localProjectId,
        "c".repeat(64),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        `provider:${randomUUID()}`
      ]
    );
    const encryptedPayload = await personalProvider.encrypt({
      plaintext: JSON.stringify({ prompt: "PRIVATE PROMPT TEXT" }),
      scope: { tenantId: ownerId, objectClass: "managed_conversation_prompt" },
      provenance: {
        rowFamily: "managed_conversation_commands",
        sourceId: commandId
      },
      ciphertextLocation: "managed_conversation_commands.encrypted_payload",
      aad: { ownerUserId: ownerId, executionId, commandId }
    });
    await pool.query(
      `insert into managed_conversation_commands(
         id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,
         request_digest,execution_generation,state,lease_token,lease_expires_at,
         dispatching_at,client_user_message_id,encrypted_payload,result
       ) values($1,$2,$3,$4,0,'prompt',$5,1,'dispatching',$6,
         now()+interval '5 minutes',now(),$7,$8::jsonb,$9::jsonb)`,
      [
        commandId,
        ownerId,
        executionId,
        `native-overview:${randomUUID()}`,
        "d".repeat(64),
        leaseToken,
        randomUUID(),
        encryptedPayload,
        JSON.stringify({ turnId: "PRIVATE PROVIDER TURN" })
      ]
    );
    const insertBlocker = async (input: {
      generation: number;
      turnId: string;
      requestId: string;
    }) =>
      pool.query<{ id: string }>(
        `insert into managed_conversation_runtime_items(
           owner_user_id,execution_id,execution_generation,provider_request_id,
           provider_turn_id,item_kind,state,request_digest,encrypted_payload
         ) values($1,$2,$3,$4,$5,'user_input','pending',$6,'{"private":"PRIVATE RESPONSE TEXT"}'::jsonb)
         returning id`,
        [
          ownerId,
          executionId,
          input.generation,
          input.requestId,
          input.turnId,
          "e".repeat(64)
        ]
      );
    const exactBlockerId = (
      await insertBlocker({
        generation: 1,
        turnId: "PRIVATE PROVIDER TURN",
        requestId: `exact:${randomUUID()}`
      })
    ).rows[0]!.id;
    await insertBlocker({
      generation: 1,
      turnId: "another-private-turn",
      requestId: `other-turn:${randomUUID()}`
    });
    await insertBlocker({
      generation: 2,
      turnId: "PRIVATE PROVIDER TURN",
      requestId: `other-generation:${randomUUID()}`
    });
    const registered = await registerNativePublicSquareWorkWithClient(
      pool,
      actor(ownerId),
      {
        commandId,
        executionId,
        executionGeneration: 1,
        agentId,
        agentVersion: 1,
        originalProjectId: localProjectId
      }
    );
    if (registered.publicationIds.length !== 1)
      throw new Error("Expected one authorized native Team publication");
    return {
      ownerId,
      memberId,
      teamId,
      teamProjectId: project.id,
      channelId: project.thread.id,
      localProjectId,
      agentId,
      executionId,
      commandId,
      exactBlockerId,
      publicationId: registered.publicationIds[0]!
    };
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

  it("keeps private-room Agent request previews inside current origin participants", async () => {
    const fixture = await makeNativePublishedWork();
    const roomViewerId = await makeUser("Private overview room viewer");
    await pool.query(
      `insert into team_memberships(team_id,user_id,role,status,accepted_at)
       values($1,$2,'member','enabled',now())`,
      [fixture.teamId, roomViewerId]
    );
    const room = await collaboration.createThread(actor(fixture.ownerId), {
      kind: "group_dm",
      idempotencyKey: `private-overview-room:${randomUUID()}`,
      teamId: fixture.teamId,
      participantUserIds: [fixture.ownerId, fixture.memberId, roomViewerId]
    });
    if (!room) throw new Error("Expected a private overview request room");
    await pool.query(
      `insert into team_agent_offers(team_id,owner_user_id,agent_id,enabled)
       values($1,$2,$3,true)`,
      [fixture.teamId, fixture.ownerId, fixture.agentId]
    );
    const requestMessage = await collaboration.sendMessage(
      actor(fixture.memberId),
      {
        threadId: room.id,
        idempotencyKey: `private-overview-request:${randomUUID()}`,
        bodyText: "Sensitive request text stays in the room",
        provenance: { kind: "user", id: randomUUID() }
      }
    );
    if (!requestMessage)
      throw new Error("Expected the private request message");
    const requestId = randomUUID();
    await pool.query(
      `insert into team_agent_requests(
         id,team_id,team_project_id,channel_id,request_message_id,requester_user_id,
         owner_user_id,agent_id,agent_version,agent_name,status,idempotency_key_hash,request_hash
       ) values($1,$2,$3,$4,$5,$6,$7,$8,1,'Native shared Agent','awaiting_owner',$9,$10)`,
      [
        requestId,
        fixture.teamId,
        fixture.teamProjectId,
        room.id,
        requestMessage.id,
        fixture.memberId,
        fixture.ownerId,
        fixture.agentId,
        createHash("sha256").update(randomUUID()).digest("hex"),
        createHash("sha256").update(randomUUID()).digest("hex")
      ]
    );

    const ownerSnapshot = await sources.listCurrentItems(
      actor(fixture.ownerId)
    );
    const privateRequestItem = ownerSnapshot.attention.find(
      (item) => item.sourceEventId === `request:${requestId}`
    );
    expect(privateRequestItem).toMatchObject({
      source: "agent_request",
      summary: "Native overview member requested Native shared Agent",
      destination: {
        kind: "agent_request",
        requestId,
        threadId: room.id
      }
    });
    expect(JSON.stringify(privateRequestItem)).not.toContain(
      "Sensitive request text stays in the room"
    );
    expect(
      (await sources.listCurrentItems(actor(fixture.memberId))).attention.some(
        (item) => item.sourceEventId === `request:${requestId}`
      )
    ).toBe(false);

    await pool.query(
      `update team_memberships set status='disabled',disabled_at=now()
        where team_id=$1 and user_id=$2`,
      [fixture.teamId, fixture.ownerId]
    );
    expect(
      (await sources.listCurrentItems(actor(fixture.ownerId))).attention.some(
        (item) => item.sourceEventId === `request:${requestId}`
      )
    ).toBe(false);
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

  it("projects exact native Team blockers and outcomes with semantic revisions and reminder authorization", async () => {
    const fixture = await makeNativePublishedWork();
    const findAction = async (userId: string) =>
      (await sources.listCurrentItems(actor(userId))).attention.find(
        (item) =>
          item.source === "team_agent_action" &&
          item.sourceId === fixture.publicationId
      );
    const findOutcome = async (userId: string) =>
      (await sources.listCurrentItems(actor(userId))).catchUp.find(
        (item) =>
          item.source === "team_agent_outcome" &&
          item.sourceId === fixture.publicationId
      );

    const ownerAction = await findAction(fixture.ownerId);
    expect(ownerAction).toMatchObject({
      sourceEventId: `agent-action:${fixture.publicationId}`,
      source: "team_agent_action",
      kind: "agent_action",
      priority: "blocker",
      state: "blocked",
      title: "Native shared Agent needs your input",
      summary: null,
      destination: {
        kind: "team_agent_work",
        publicationId: fixture.publicationId,
        teamProjectId: fixture.teamProjectId
      }
    });
    const exactBlocker = (
      await pool.query<{ updated_at: Date }>(
        `select updated_at from managed_conversation_runtime_items where id=$1`,
        [fixture.exactBlockerId]
      )
    ).rows[0];
    expect(Date.parse(ownerAction!.updatedAt)).toBe(
      exactBlocker?.updated_at.getTime()
    );
    expect(await findAction(fixture.memberId)).toBeUndefined();
    const actionDto = JSON.stringify(ownerAction);
    for (const privateValue of [
      fixture.executionId,
      fixture.commandId,
      fixture.exactBlockerId,
      "PRIVATE PROVIDER TURN",
      "PRIVATE PROMPT TEXT",
      "PRIVATE RESPONSE TEXT",
      "PRIVATE ROLE"
    ])
      expect(actionDto).not.toContain(privateValue);

    const initialRevision = ownerAction!.sourceRevision;
    expect(
      await overview.setReminderState(actor(fixture.ownerId), {
        teamId: fixture.teamId,
        sourceEventId: ownerAction!.sourceEventId,
        source: ownerAction!.source,
        sourceId: ownerAction!.sourceId,
        sourceRevision: initialRevision,
        seen: true
      })
    ).toBeNull();
    const cleared = await overview.setReminderState(actor(fixture.ownerId), {
      teamId: fixture.teamId,
      sourceEventId: ownerAction!.sourceEventId,
      source: ownerAction!.source,
      sourceId: ownerAction!.sourceId,
      sourceRevision: initialRevision,
      cleared: true
    });
    expect(cleared?.cleared).toBe(true);

    await pool.query(
      `update managed_conversation_commands
          set lease_expires_at=now()+interval '10 minutes',updated_at=now()+interval '1 minute'
        where id=$1`,
      [fixture.commandId]
    );
    await pool.query(
      `update managed_conversation_executions
          set runner_last_seen_at=now()+interval '1 minute',
              runner_lease_expires_at=now()-interval '1 minute',
              state_version=state_version+1,updated_at=now()+interval '1 minute'
        where id=$1`,
      [fixture.executionId]
    );
    const duringReconnect = await findAction(fixture.ownerId);
    expect(duringReconnect?.sourceRevision).toBe(initialRevision);
    expect(duringReconnect?.sourceEventId).toBe(ownerAction!.sourceEventId);
    expect(
      await overview.listReminderStates(actor(fixture.ownerId), {
        teamId: fixture.teamId,
        sourceEventIds: [ownerAction!.sourceEventId]
      })
    ).toMatchObject([
      { cleared: true, sourceRevision: initialRevision, seen: false }
    ]);

    await pool.query(
      `update managed_conversation_runtime_items
          set revision=revision+1,updated_at=now()+interval '2 minutes'
        where id=$1`,
      [fixture.exactBlockerId]
    );
    const changedQuestion = await findAction(fixture.ownerId);
    expect(changedQuestion?.sourceEventId).toBe(ownerAction!.sourceEventId);
    expect(changedQuestion?.sourceRevision).not.toBe(initialRevision);
    const revisedClear = await overview.setReminderState(
      actor(fixture.ownerId),
      {
        teamId: fixture.teamId,
        sourceEventId: changedQuestion!.sourceEventId,
        source: changedQuestion!.source,
        sourceId: changedQuestion!.sourceId,
        sourceRevision: changedQuestion!.sourceRevision,
        cleared: false
      }
    );
    expect(revisedClear).toMatchObject({ cleared: false, seen: false });

    await pool.query(
      `update managed_conversation_runtime_items
          set state='resolved',resolved_at=now(),revision=revision+1
        where id=$1`,
      [fixture.exactBlockerId]
    );
    await pool.query(
      `update managed_conversation_commands
          set state='completed',completed_at=now(),lease_token=null,lease_expires_at=null,
              updated_at=now()
        where id=$1`,
      [fixture.commandId]
    );
    const memberOutcome = await findOutcome(fixture.memberId);
    expect(memberOutcome).toMatchObject({
      sourceEventId: `agent-outcome:${fixture.publicationId}`,
      source: "team_agent_outcome",
      kind: "agent_outcome",
      title: "Native shared Agent completed",
      summary: null,
      destination: {
        kind: "team_agent_work",
        publicationId: fixture.publicationId,
        teamProjectId: fixture.teamProjectId
      }
    });
    expect(await findOutcome(fixture.ownerId)).toMatchObject({
      sourceRevision: memberOutcome?.sourceRevision
    });
    const outcomeDto = JSON.stringify(memberOutcome);
    for (const privateValue of [
      fixture.executionId,
      fixture.commandId,
      fixture.exactBlockerId,
      "PRIVATE PROVIDER TURN",
      "PRIVATE PROMPT TEXT",
      "PRIVATE RESPONSE TEXT",
      "PRIVATE ROLE"
    ])
      expect(outcomeDto).not.toContain(privateValue);
    expect(
      await overview.setReminderState(actor(fixture.memberId), {
        teamId: fixture.teamId,
        sourceEventId: memberOutcome!.sourceEventId,
        source: memberOutcome!.source,
        sourceId: memberOutcome!.sourceId,
        sourceRevision: memberOutcome!.sourceRevision,
        seen: true
      })
    ).toMatchObject({ seen: true, cleared: false });

    const requestMessage = await collaboration.sendMessage(
      actor(fixture.memberId),
      {
        threadId: fixture.channelId,
        idempotencyKey: `native-outcome-request:${randomUUID()}`,
        bodyText: "Please review this item.",
        provenance: { kind: "user", id: randomUUID() }
      }
    );
    const outcomeMessage = await collaboration.sendMessage(
      actor(fixture.ownerId),
      {
        threadId: fixture.channelId,
        idempotencyKey: `native-outcome-message:${randomUUID()}`,
        bodyText: "The Agent completed the requested work.",
        provenance: { kind: "user", id: randomUUID() }
      }
    );
    if (!requestMessage || !outcomeMessage)
      throw new Error("Expected the published Team request messages");
    await pool.query(
      `insert into team_agent_requests(
         team_id,team_project_id,channel_id,request_message_id,requester_user_id,
         owner_user_id,agent_id,agent_version,agent_name,status,managed_execution_id,
         managed_command_id,outcome_message_id,idempotency_key_hash,request_hash
       ) values($1,$2,$3,$4,$5,$6,$7,1,'Native shared Agent','accepted',$8,$9,$10,$11,$12)`,
      [
        fixture.teamId,
        fixture.teamProjectId,
        fixture.channelId,
        requestMessage.id,
        fixture.memberId,
        fixture.ownerId,
        (
          await pool.query<{ agent_id: string }>(
            `select agent_id from personal_agent_native_public_square_work where execution_id=$1 and owner_user_id=$2`,
            [fixture.executionId, fixture.ownerId]
          )
        ).rows[0]!.agent_id,
        fixture.executionId,
        fixture.commandId,
        outcomeMessage.id,
        "f".repeat(64),
        "0".repeat(64)
      ]
    );
    expect(await findOutcome(fixture.memberId)).toBeUndefined();
    expect(await findOutcome(fixture.ownerId)).toBeUndefined();

    await pool.query(
      `update collaboration_team_shared_projects set unshared_at=now()
        where id=$1 and team_id=$2`,
      [fixture.teamProjectId, fixture.teamId]
    );
    expect(await findOutcome(fixture.memberId)).toBeUndefined();
  });

  it("keeps native failure actionable for its owner and as non-blocking Team catch-up for peers", async () => {
    const fixture = await makeNativePublishedWork();
    await pool.query(
      `update managed_conversation_commands
          set state='failed',completed_at=now(),lease_token=null,lease_expires_at=null,
              last_error_code='provider_failed',updated_at=now()
        where id=$1`,
      [fixture.commandId]
    );
    const owner = await sources.listCurrentItems(actor(fixture.ownerId));
    const member = await sources.listCurrentItems(actor(fixture.memberId));
    expect(
      owner.attention.find((item) => item.sourceId === fixture.publicationId)
    ).toMatchObject({
      source: "team_agent_action",
      kind: "agent_action",
      priority: "attention",
      title: "Native shared Agent failed"
    });
    expect(
      owner.catchUp.some((item) => item.sourceId === fixture.publicationId)
    ).toBe(false);
    expect(
      member.attention.some((item) => item.sourceId === fixture.publicationId)
    ).toBe(false);
    expect(
      member.catchUp.find((item) => item.sourceId === fixture.publicationId)
    ).toMatchObject({
      source: "team_agent_outcome",
      kind: "agent_outcome",
      priority: "attention",
      state: "recent",
      title: "Native shared Agent failed"
    });
  });

  it("projects one exact native PR action across duplicate Team publications and retains terminal history after remap", async () => {
    const fixture = await makeNativePublishedWork();
    const secondProject = await collaboration.createTeamSharedProject(
      actor(fixture.ownerId),
      {
        teamId: fixture.teamId,
        idempotencyKey: `native-pr-second-project:${randomUUID()}`,
        name: "Native PR second Project",
        localProjectId: fixture.localProjectId
      }
    );
    if (!secondProject)
      throw new Error("Expected a second connected Team Project");
    const secondPublication = (
      await pool.query<{ id: string }>(
        `select publication.id
           from personal_agent_team_native_command_publications publication
           join personal_agent_native_public_square_work work
             on work.id=publication.work_id and work.owner_user_id=publication.owner_user_id
          where publication.team_id=$1 and publication.team_project_id=$2
            and publication.owner_user_id=$3 and work.command_id=$4`,
        [fixture.teamId, secondProject.id, fixture.ownerId, fixture.commandId]
      )
    ).rows[0];
    if (!secondPublication)
      throw new Error("Expected the second publication for native work");
    const publicationIds = [fixture.publicationId, secondPublication.id];

    const execution = (
      await pool.query<{
        runner_device_id: string;
        runner_deployment_id: string;
      }>(
        `select runner_device_id,runner_deployment_id
           from managed_conversation_executions where id=$1`,
        [fixture.executionId]
      )
    ).rows[0];
    if (!execution) throw new Error("Expected the native execution");
    const reviewId = randomUUID();
    const baseSha = "1".repeat(40);
    const headSha = "2".repeat(40);
    await pool.query(
      `insert into pull_request_reviews(
         id,owner_user_id,agent_id,agent_version,execution_id,project_id,
         target_device_id,target_deployment_id,account_id,repository_id,pull_request_number,
         expected_base_sha,expected_head_sha,connection_generation,work_mode,
         reviewed_base_sha,reviewed_head_sha,reviewed_execution_generation,status,
         revision,draft_revision,idempotency_key,request_digest,encrypted_selection
       ) values($1,$2,$3,1,$4,$5,$6,$7,'native-test-account','test/native',31,$8,$9,1,
         'fix',$8,$9,1,'draft',2,1,$10,$11,$12::jsonb)`,
      [
        reviewId,
        fixture.ownerId,
        fixture.agentId,
        fixture.executionId,
        fixture.localProjectId,
        execution.runner_device_id,
        execution.runner_deployment_id,
        baseSha,
        headSha,
        `native-pr:${reviewId}`,
        createHash("sha256").update(reviewId).digest("hex"),
        JSON.stringify({ payload: "[private PR selection]" })
      ]
    );
    await pool.query(
      `insert into pull_request_review_drafts(
         id,review_id,owner_user_id,revision,origin,source_execution_id,
         source_command_id,source_agent_version,source_provider,
         source_ai_client_instance_id,source_model,source_review_revision,
         source_lease_token_digest,source_result_digest,execution_generation,
         account_id,base_sha,head_sha,encrypted_payload
       ) values($1,$2,$3,1,'agent',$4,$5,1,'codex','codex.default','test-model',
         1,$6,$7,1,'native-test-account',$8,$9,$10::jsonb)`,
      [
        randomUUID(),
        reviewId,
        fixture.ownerId,
        fixture.executionId,
        fixture.commandId,
        "3".repeat(64),
        "4".repeat(64),
        baseSha,
        headSha,
        JSON.stringify({ payload: "[private PR draft]" })
      ]
    );
    await pool.query(
      `update managed_conversation_runtime_items
          set state='resolved',resolved_at=now(),revision=revision+1
        where execution_id=$1 and provider_turn_id='PRIVATE PROVIDER TURN'`,
      [fixture.executionId]
    );
    await pool.query(
      `update managed_conversation_commands
          set state='completed',completed_at=now(),lease_token=null,lease_expires_at=null,
              updated_at=now()
        where id=$1`,
      [fixture.commandId]
    );

    const ownerSnapshot = await sources.listCurrentItems(
      actor(fixture.ownerId)
    );
    const prActions = ownerSnapshot.attention.filter(
      (item) =>
        item.source === "pull_request_action" &&
        item.sourceEventId === `pr:${reviewId}`
    );
    expect(prActions).toHaveLength(1);
    expect(prActions[0]).toMatchObject({
      source: "pull_request_action",
      sourceId: reviewId,
      title: "test/native #31 review needs attention",
      destination: {
        kind: "pull_request_review",
        reviewId,
        repositoryId: "test/native",
        number: 31
      }
    });
    expect(
      ownerSnapshot.catchUp.filter(
        (item) =>
          item.source === "team_agent_outcome" &&
          publicationIds.includes(item.sourceId)
      )
    ).toEqual([]);
    const peerSnapshot = await sources.listCurrentItems(
      actor(fixture.memberId)
    );
    expect(
      [...peerSnapshot.attention, ...peerSnapshot.catchUp].some(
        (item) => item.source === "pull_request_action"
      )
    ).toBe(false);

    await pool.query(
      `update public_square_project_connections
          set local_project_id=null,connected_at=null,version=version+1,updated_at=now()
        where actor_user_id=$1 and team_id=$2`,
      [fixture.ownerId, fixture.teamId]
    );
    const afterDisconnect = await sources.listCurrentItems(
      actor(fixture.ownerId)
    );
    expect(
      afterDisconnect.attention.some(
        (item) =>
          item.source === "pull_request_action" &&
          item.sourceEventId === `pr:${reviewId}`
      )
    ).toBe(true);
    expect(
      (await sources.listCurrentItems(actor(fixture.memberId))).catchUp.some(
        (item) =>
          item.source === "team_agent_outcome" &&
          item.sourceId === fixture.publicationId
      )
    ).toBe(true);

    await pool.query(
      `update pull_request_reviews set revision=3,draft_revision=2,updated_at=now()
        where id=$1`,
      [reviewId]
    );
    await pool.query(
      `insert into pull_request_review_drafts(
         review_id,owner_user_id,revision,origin,account_id,base_sha,head_sha,
         encrypted_payload
       ) values($1,$2,2,'owner','native-test-account',$3,$4,$5::jsonb)`,
      [
        reviewId,
        fixture.ownerId,
        baseSha,
        headSha,
        JSON.stringify({ payload: "[private replacement draft]" })
      ]
    );
    expect(
      (await sources.listCurrentItems(actor(fixture.ownerId))).attention.some(
        (item) => item.sourceEventId === `pr:${reviewId}`
      )
    ).toBe(false);
    await pool.query(
      `update pull_request_reviews set revision=2,draft_revision=1,updated_at=now()
        where id=$1`,
      [reviewId]
    );

    await pool.query(
      `update pull_request_reviews set account_id='stale-account',updated_at=now()
        where id=$1`,
      [reviewId]
    );
    expect(
      (await sources.listCurrentItems(actor(fixture.ownerId))).attention.some(
        (item) => item.sourceEventId === `pr:${reviewId}`
      )
    ).toBe(false);
    await pool.query(
      `update pull_request_reviews set account_id='native-test-account',
          expected_base_sha=$2,expected_head_sha=$3,updated_at=now() where id=$1`,
      [reviewId, "5".repeat(40), "6".repeat(40)]
    );
    expect(
      (await sources.listCurrentItems(actor(fixture.ownerId))).attention.some(
        (item) => item.sourceEventId === `pr:${reviewId}`
      )
    ).toBe(false);
  });
});

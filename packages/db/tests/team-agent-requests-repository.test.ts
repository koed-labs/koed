import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/connection.js";
import { createCollaborationRepository } from "../src/collaboration-repository.js";
import { runDbMigrations } from "../src/migrate.js";
import { createPublicSquareRepository } from "../src/public-square-repository.js";
import { createTeamAgentRequestsRepository } from "../src/team-agent-requests-repository.js";

const databaseUrl =
  process.env.TEAM_AGENT_REQUESTS_TEST_DATABASE_URL ??
  process.env.COLLABORATION_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const actor = (userId: string) => ({ userId });

describeDb("Team Agent Requests repository", () => {
  let pool: pg.Pool;
  let collaboration: ReturnType<typeof createCollaborationRepository>;
  let publicSquare: ReturnType<typeof createPublicSquareRepository>;
  let requests: ReturnType<typeof createTeamAgentRequestsRepository>;
  const personalProvider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 37).toString("base64")
  );
  const teamProvider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 38).toString("base64")
  );

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl! });
    await runDbMigrations(pool);
    collaboration = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: personalProvider,
      teamEnvelopeEncryptionProvider: teamProvider
    });
    publicSquare = createPublicSquareRepository(pool, {
      envelopeEncryptionProvider: personalProvider,
      teamEnvelopeEncryptionProvider: teamProvider
    });
    requests = createTeamAgentRequestsRepository(pool, {
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

  const makeTeam = async (ownerId: string, requesterId: string) => {
    const teamId = (
      await pool.query<{ id: string }>(
        `insert into teams(name,entitlement_status) values($1,'active') returning id`,
        [`Request ${randomUUID()}`]
      )
    ).rows[0]!.id;
    await pool.query(
      `insert into team_memberships(team_id,user_id,role,status,accepted_at)
       values($1,$2,'member','enabled',now()),($1,$3,'member','enabled',now())`,
      [teamId, ownerId, requesterId]
    );
    const project = await collaboration.createTeamSharedProject(
      actor(ownerId),
      {
        teamId,
        idempotencyKey: `team-agent-project:${randomUUID()}`,
        name: "Shared Work"
      }
    );
    if (!project) throw new Error("Expected shared Team Project");
    return { teamId, project };
  };

  const makeAgent = async (ownerId: string) => {
    const agentId = randomUUID();
    const requestId = randomUUID();
    const fingerprint = "a".repeat(64);
    await pool.query(
      `insert into personal_agent_identities(
        id,owner_user_id,name,role,default_provider,default_model,current_version,
        creation_request_id,creation_request_fingerprint
      ) values($1,$2,'Release Helper','private role','codex','test-model',1,$3,$4)`,
      [agentId, ownerId, requestId, fingerprint]
    );
    await pool.query(
      `insert into personal_agent_identity_versions(
        agent_id,owner_user_id,version,name,role,default_provider,default_model,
        soul_instructions,instruction_source,created_by_user_id,request_id,request_fingerprint
      ) values($1,$2,1,'Release Helper','private role','codex','test-model',
        '[koed encrypted personal agent soul]','custom',$2,$3,$4)`,
      [agentId, ownerId, randomUUID(), "b".repeat(64)]
    );
    return agentId;
  };

  it("keeps offers Team-scoped, creates one channel request, and supports idempotent decisions", async () => {
    const ownerId = await makeUser("Agent owner");
    const requesterId = await makeUser("Requester");
    const { teamId, project } = await makeTeam(ownerId, requesterId);
    const agentId = await makeAgent(ownerId);
    const offer = await requests.updateOffer(actor(ownerId), {
      teamId,
      agentId,
      expectedVersion: 0,
      enabled: true,
      description: "Reviews release notes"
    });
    expect(offer).toMatchObject({ enabled: true, agentName: "Release Helper" });

    const otherOwnerId = await makeUser("Other owner");
    const otherTeam = await makeTeam(otherOwnerId, requesterId);
    expect(
      (
        await requests.listOffers(actor(requesterId), {
          teamId: otherTeam.teamId
        })
      )?.items
    ).toEqual([]);
    expect(
      await requests.createRequest(actor(requesterId), {
        teamId: otherTeam.teamId,
        idempotencyKey: randomUUID(),
        teamProjectId: otherTeam.project.id,
        channelId: otherTeam.project.thread.id,
        agentId,
        requestText: "Please review this release"
      })
    ).toBeNull();

    const input = {
      teamId,
      idempotencyKey: randomUUID(),
      teamProjectId: project.id,
      channelId: project.thread.id,
      agentId,
      requestText: "Please review this release"
    };
    const created = await requests.createRequest(actor(requesterId), input);
    const legacyNullRootHash = createHash("sha256")
      .update(
        JSON.stringify({
          teamProjectId: input.teamProjectId,
          channelId: input.channelId,
          agentId: input.agentId,
          requestText: input.requestText
        }),
        "utf8"
      )
      .digest("hex");
    const savedRequestHash = await pool.query<{ request_hash: string }>(
      `select request_hash from team_agent_requests where id=$1`,
      [created!.id]
    );
    expect(savedRequestHash.rows[0]?.request_hash).toBe(legacyNullRootHash);
    expect(created).toMatchObject({
      teamId,
      ownerId,
      requesterId,
      status: "awaiting_owner",
      agentName: "Release Helper",
      canWithdraw: true
    });
    expect(JSON.stringify(created)).not.toContain("private role");
    expect(
      await requests.createRequest(actor(requesterId), input)
    ).toMatchObject({
      id: created!.id,
      requestMessageId: created!.requestMessageId
    });
    const inbox = await requests.listRequests(actor(ownerId), {
      teamId,
      inbox: true
    });
    expect(inbox?.requests).toHaveLength(1);
    expect(inbox?.requests[0]?.id).toBe(created?.id);
    const savedReview = await requests.getReview(actor(ownerId), {
      teamId,
      requestId: created!.id
    });
    expect(savedReview).toMatchObject({
      privateGoal: "",
      executionId: null,
      version: 0
    });
    const refinedReview = await requests.updateReview(actor(ownerId), {
      teamId,
      requestId: created!.id,
      expectedVersion: 0,
      privateGoal: "Prepare a concise release review",
      executionId: null
    });
    expect(refinedReview).toMatchObject({
      privateGoal: "Prepare a concise release review",
      version: 1
    });

    const declined = await requests.decideRequest(
      actor(ownerId),
      {
        teamId,
        requestId: created!.id,
        expectedVersion: 1,
        decision: "decline"
      },
      async () => {
        throw new Error("Decline must not create a Job");
      }
    );
    expect(declined).toMatchObject({
      status: "declined",
      version: 2,
      jobId: null
    });
    expect(JSON.stringify(declined)).not.toContain(
      "Prepare a concise release review"
    );
    expect(
      await requests.getReview(actor(ownerId), {
        teamId,
        requestId: created!.id
      })
    ).toMatchObject({
      privateGoal: "Prepare a concise release review",
      version: 1
    });
    await expect(
      requests.decideRequest(
        actor(ownerId),
        {
          teamId,
          requestId: created!.id,
          expectedVersion: 1,
          decision: "decline"
        },
        async () => {
          throw new Error("Decision replay must not create a Job");
        }
      )
    ).resolves.toMatchObject({
      id: created!.id,
      status: "declined",
      version: 2
    });
    await expect(
      requests.decideRequest(
        actor(ownerId),
        {
          teamId,
          requestId: created!.id,
          expectedVersion: 1,
          decision: "accept"
        },
        async () => {
          throw new Error("A losing decision must not create a Job");
        }
      )
    ).rejects.toMatchObject({ statusCode: 409 });

    const general = await collaboration.ensureTeamGeneralChannel(
      actor(ownerId),
      teamId
    );
    const generalRoot = await collaboration.sendMessage(actor(requesterId), {
      threadId: general!.id,
      idempotencyKey: `team-agent-origin:${randomUUID()}`,
      bodyText: "Please have the agent review this channel discussion"
    });
    const generalRequest = await requests.createRequest(actor(requesterId), {
      ...input,
      channelId: general!.id,
      rootMessageId: generalRoot!.id,
      idempotencyKey: randomUUID()
    });
    expect(generalRequest?.originRootMessageId).toBe(generalRoot!.id);
    const pending = await requests.createRequest(actor(requesterId), {
      ...input,
      idempotencyKey: randomUUID()
    });
    expect(pending?.originRootMessageId).toBeNull();
    const executionId = randomUUID();
    await pool.query(
      `insert into public_square_project_connections(
        actor_user_id,team_id,team_project_id,local_project_id,version,connected_at
      ) values($1,$2,$3,$4,1,now())`,
      [ownerId, teamId, project.id, `project:${randomUUID()}`]
    );
    await requests.updateReview(actor(ownerId), {
      teamId,
      requestId: pending!.id,
      expectedVersion: 0,
      privateGoal: "Work privately on the requested review",
      executionId
    });
    expect(
      await requests.getAwaitingOwnerRequestForExecution(actor(requesterId), {
        executionId
      })
    ).toBeNull();
    expect(
      await requests.getAwaitingOwnerRequestForExecution(actor(ownerId), {
        executionId
      })
    ).toMatchObject({
      requestId: pending!.id,
      teamId,
      ownerUserId: ownerId,
      agentId,
      privateGoal: "Work privately on the requested review"
    });
    await requests.updateOffer(actor(ownerId), {
      teamId,
      agentId,
      expectedVersion: offer!.version,
      enabled: false,
      description: "Reviews release notes"
    });
    const afterDisable = await requests.listRequests(actor(requesterId), {
      teamId,
      channelId: project.thread.id
    });
    expect(
      afterDisable?.requests.find((entry) => entry.id === pending?.id)
    ).toMatchObject({
      status: "unavailable",
      canWithdraw: false
    });
    await pool.query(
      `update collaboration_team_shared_projects set unshared_at=now()
        where id=$1 and team_id=$2`,
      [project.id, teamId]
    );
    const retainedGeneralHistory = await requests.listRequests(
      actor(requesterId),
      { teamId, channelId: general!.id }
    );
    expect(
      retainedGeneralHistory?.requests.find(
        (entry) => entry.id === generalRequest?.id
      )
    ).toMatchObject({ status: "unavailable" });
    const hiddenProjectHistory = await requests.listRequests(
      actor(requesterId),
      { teamId, channelId: project.thread.id }
    );
    expect(hiddenProjectHistory?.requests).toEqual([]);
  });

  it("binds a fresh private owner review to its execution in the caller transaction", async () => {
    const ownerId = await makeUser("Review owner");
    const requesterId = await makeUser("Review requester");
    const { teamId, project } = await makeTeam(ownerId, requesterId);
    const agentId = await makeAgent(ownerId);
    await requests.updateOffer(actor(ownerId), {
      teamId,
      agentId,
      expectedVersion: 0,
      enabled: true,
      description: "Handles private work"
    });
    const request = await requests.createRequest(actor(requesterId), {
      teamId,
      idempotencyKey: randomUUID(),
      teamProjectId: project.id,
      channelId: project.thread.id,
      agentId,
      requestText: "Please prepare this"
    });
    expect(request).not.toBeNull();
    await requests.updateReview(actor(ownerId), {
      teamId,
      requestId: request!.id,
      expectedVersion: 0,
      privateGoal: "Privately review the request",
      executionId: null
    });
    const localProjectId = `project:${randomUUID()}`;
    await pool.query(
      `insert into public_square_project_connections(
        actor_user_id,team_id,team_project_id,local_project_id,version,connected_at
      ) values($1,$2,$3,$4,1,now())`,
      [ownerId, teamId, project.id, localProjectId]
    );
    // The request keeps the version that was offered originally, while owner
    // review must use the currently selected profile version.
    await pool.query(
      `insert into personal_agent_identity_versions(
        agent_id,owner_user_id,version,name,role,default_provider,default_model,
        soul_instructions,instruction_source,created_by_user_id,request_id,request_fingerprint
      ) values($1,$2,2,'Release Helper Renamed','updated private role','codex','test-model',
        '[koed encrypted personal agent soul]','custom',$2,$3,$4)`,
      [agentId, ownerId, randomUUID(), "d".repeat(64)]
    );
    await pool.query(
      `update personal_agent_identities set current_version=2 where id=$1 and owner_user_id=$2`,
      [agentId, ownerId]
    );

    const executionId = randomUUID();
    const bindWith = async (
      binding: {
        teamId?: string;
        requestId?: string;
        expectedRequestVersion?: number;
        expectedReviewVersion?: number;
        actorId?: string;
      } = {}
    ) => {
      const candidate = await pool.connect();
      try {
        await candidate.query("begin");
        return await requests.bindOwnerReviewExecutionWithClient(
          candidate,
          actor(binding.actorId ?? ownerId),
          {
            teamId: binding.teamId ?? teamId,
            requestId: binding.requestId ?? request!.id,
            expectedRequestVersion:
              binding.expectedRequestVersion ?? request!.version,
            expectedReviewVersion: binding.expectedReviewVersion ?? 1,
            executionId
          }
        );
      } finally {
        await candidate.query("rollback").catch(() => undefined);
        candidate.release();
      }
    };
    expect(await bindWith({ actorId: requesterId })).toBeNull();
    expect(await bindWith({ teamId: randomUUID() })).toBeNull();
    expect(await bindWith({ requestId: randomUUID() })).toBeNull();
    await expect(
      bindWith({ expectedRequestVersion: request!.version + 1 })
    ).rejects.toThrow("Team Agent Request changed concurrently");
    await expect(bindWith({ expectedReviewVersion: 0 })).rejects.toThrow(
      "Owner review changed concurrently"
    );

    const client = await pool.connect();
    try {
      await client.query("begin");
      const binding = await requests.bindOwnerReviewExecutionWithClient(
        client,
        actor(ownerId),
        {
          teamId,
          requestId: request!.id,
          expectedRequestVersion: request!.version,
          expectedReviewVersion: 1,
          executionId
        }
      );
      expect(binding).toMatchObject({
        requestId: request!.id,
        teamId,
        teamProjectId: project.id,
        ownerUserId: ownerId,
        agentId,
        agentVersion: 2,
        localProjectId,
        privateGoal: "Privately review the request"
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const pending = await requests.getAwaitingOwnerRequestForExecution(
      actor(ownerId),
      { executionId }
    );
    expect(pending).toMatchObject({
      requestId: request!.id,
      agentVersion: 2,
      localProjectId,
      privateGoal: "Privately review the request"
    });
    const historicalVersion = await pool.query<{ agent_version: number }>(
      `select agent_version from team_agent_requests where id=$1 and team_id=$2`,
      [request!.id, teamId]
    );
    expect(historicalVersion.rows[0]?.agent_version).toBe(1);
    await expect(
      requests.updateReview(actor(ownerId), {
        teamId,
        requestId: request!.id,
        expectedVersion: 2,
        privateGoal: "Stale refinement",
        executionId: null
      })
    ).rejects.toThrow("Owner review is bound to another Agent execution");
    expect(
      await requests.getAwaitingOwnerRequestForExecution(actor(ownerId), {
        executionId
      })
    ).toMatchObject({ requestId: request!.id });
  });

  it("freezes accepted request Job status when the owner leaves the Team", async () => {
    const ownerId = await makeUser("Departing Agent owner");
    const requesterId = await makeUser("Request viewer");
    const { teamId, project } = await makeTeam(ownerId, requesterId);
    const agentId = await makeAgent(ownerId);
    await requests.updateOffer(actor(ownerId), {
      teamId,
      agentId,
      expectedVersion: 0,
      enabled: true,
      description: "Handles private work"
    });
    const general = await collaboration.ensureTeamGeneralChannel(
      actor(ownerId),
      teamId
    );
    const created = await requests.createRequest(actor(requesterId), {
      teamId,
      idempotencyKey: randomUUID(),
      teamProjectId: project.id,
      channelId: general!.id,
      agentId,
      requestText: "Please prepare this"
    });
    const localProjectId = `project:${randomUUID()}`;
    const executionId = randomUUID();
    const jobId = randomUUID();
    await pool.query(
      `insert into public_square_project_connections(
        actor_user_id,team_id,team_project_id,local_project_id,version,connected_at
      ) values($1,$2,$3,$4,1,now())`,
      [ownerId, teamId, project.id, localProjectId]
    );
    await pool.query(
      `insert into managed_conversation_executions(
        id,owner_user_id,project_id,ai_client_instance_id,model,permission_mode,
        runner_kind,state,execution_generation,fencing_token_hash,runner_deployment_id,
        runner_device_id,runner_id,runner_lease_expires_at,logical_session_id,
        provider_thread_id,started_at,runner_last_seen_at
      ) values($1,$2,$3,'codex.default','test-model','supervised','local_device',
        'running',1,$4,$5,$6,'runner',now()+interval '1 minute',$7,$8,now(),now())`,
      [
        executionId,
        ownerId,
        localProjectId,
        "c".repeat(64),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        `thread-${randomUUID()}`
      ]
    );
    await pool.query(
      `insert into personal_agent_execution_jobs(
        id,owner_user_id,conversation_id,attribution_kind,agent_id,agent_version,
        state,project_id,title
      ) values($1,$2,$3,'agent',$4,1,'queued',$5,'Private title')`,
      [jobId, ownerId, executionId, agentId, localProjectId]
    );
    await requests.updateReview(actor(ownerId), {
      teamId,
      requestId: created!.id,
      expectedVersion: 0,
      privateGoal: "Finish the reviewed request privately",
      executionId
    });
    await pool.query(
      `update team_agent_requests set status='accepted',job_id=$3,version=version+1
        where id=$1 and team_id=$2`,
      [created!.id, teamId, jobId]
    );
    const publication = await pool.query<{ id: string; state: string }>(
      `select id,state from personal_agent_team_job_publications
        where team_id=$1 and team_project_id=$2 and owner_user_id=$3 and job_id=$4`,
      [teamId, project.id, ownerId, jobId]
    );
    expect(publication.rows[0]).toMatchObject({ state: "active" });
    const requestVersionBeforeJobStart = (
      await pool.query<{ version: number }>(
        `select version from team_agent_requests where id=$1 and team_id=$2`,
        [created!.id, teamId]
      )
    ).rows[0]!.version;
    await pool.query(
      `update personal_agent_execution_jobs set state='running',updated_at=now()+interval '1 second'
        where id=$1 and owner_user_id=$2`,
      [jobId, ownerId]
    );
    const requestVersionAfterJobStart = (
      await pool.query<{ version: number }>(
        `select version from team_agent_requests where id=$1 and team_id=$2`,
        [created!.id, teamId]
      )
    ).rows[0]!.version;
    expect(requestVersionAfterJobStart).toBe(requestVersionBeforeJobStart + 1);
    expect(
      await requests.getAcceptedRequestForExecution(actor(ownerId), {
        teamId,
        requestId: created!.id,
        executionId
      })
    ).toMatchObject({ status: "accepted", jobId });
    expect(
      await requests.getAcceptedRequestForExecution(actor(ownerId), {
        teamId,
        requestId: created!.id,
        executionId: randomUUID()
      })
    ).toBeNull();
    expect(
      await requests.getAcceptedRequestForExecution(actor(requesterId), {
        teamId,
        requestId: created!.id,
        executionId
      })
    ).toBeNull();
    const beforeDeparture = await requests.listRequests(actor(requesterId), {
      teamId,
      channelId: general!.id
    });
    expect(beforeDeparture?.requests[0]).toMatchObject({
      status: "accepted",
      jobId,
      jobStatus: "running"
    });
    await pool.query(
      `update team_memberships set status='disabled',disabled_at=now()
        where team_id=$1 and user_id=$2`,
      [teamId, ownerId]
    );
    await pool.query(
      `update personal_agent_execution_jobs set state='succeeded',updated_at=now()
        where id=$1`,
      [jobId]
    );
    const afterDeparture = await requests.listRequests(actor(requesterId), {
      teamId,
      channelId: general!.id
    });
    expect(afterDeparture?.requests[0]).toMatchObject({
      status: "accepted",
      jobId,
      jobStatus: "running",
      version: beforeDeparture?.requests[0]?.version
    });
    expect(
      await requests.getAcceptedRequestForExecution(actor(ownerId), {
        teamId,
        requestId: created!.id,
        executionId
      })
    ).toBeNull();
    await pool.query(
      `update team_memberships set status='enabled',disabled_at=null
        where team_id=$1 and user_id=$2`,
      [teamId, ownerId]
    );
    expect(
      await publicSquare.unsharePublicSquareProject(actor(ownerId), {
        teamId,
        teamProjectId: project.id
      })
    ).toBe(true);
    expect(
      await requests.getAcceptedRequestForExecution(actor(ownerId), {
        teamId,
        requestId: created!.id,
        executionId
      })
    ).toBeNull();
    const afterUnshare = await requests.listRequests(actor(requesterId), {
      teamId,
      channelId: general!.id
    });
    expect(afterUnshare?.requests[0]).toMatchObject({
      id: created!.id,
      status: "accepted",
      jobId: null,
      jobStatus: null
    });
  });
});

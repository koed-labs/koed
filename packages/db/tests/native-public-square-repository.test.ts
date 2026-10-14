import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import { createCollaborationRepository } from "../src/collaboration-repository.js";
import { createPublicSquareRepository } from "../src/public-square-repository.js";
import { registerNativePublicSquareWorkWithClient } from "../src/native-public-square-repository.js";

const databaseUrl = process.env.PUBLIC_SQUARE_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const actor = (userId: string) => ({ userId });

describeDb("native Public Square publication boundaries", () => {
  let pool: pg.Pool;
  let square: ReturnType<typeof createPublicSquareRepository>;
  let collaboration: ReturnType<typeof createCollaborationRepository>;
  let provider: ReturnType<typeof createLocalTestKeyEnvelopeEncryptionProvider>;
  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl! });
    await runDbMigrations(pool);
    provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 41).toString("base64")
    );
    const options = {
      envelopeEncryptionProvider: provider,
      teamEnvelopeEncryptionProvider: provider
    };
    square = createPublicSquareRepository(pool, options);
    collaboration = createCollaborationRepository(pool, options);
  });
  afterAll(async () => {
    await pool.end();
  });

  const user = async () =>
    (
      await pool.query<{ id: string }>(
        `insert into users(email,display_name) values($1,'Native member') returning id`,
        [`native-square-${randomUUID()}@example.test`]
      )
    ).rows[0]!.id;
  const team = async (
    ownerId: string,
    viewerId: string,
    localProjectId?: string
  ) => {
    const teamId = (
      await pool.query<{ id: string }>(
        `insert into teams(name,entitlement_status) values($1,'active') returning id`,
        [randomUUID()]
      )
    ).rows[0]!.id;
    await pool.query(
      `insert into team_memberships(team_id,user_id,role,status,accepted_at)
      values($1,$2,'member','enabled',now()),($1,$3,'admin','enabled',now())`,
      [teamId, ownerId, viewerId]
    );
    const project = await collaboration.createTeamSharedProject(
      actor(ownerId),
      {
        teamId,
        idempotencyKey: randomUUID(),
        name: "Native shared Project",
        ...(localProjectId ? { localProjectId } : {})
      }
    );
    if (!project) throw new Error("Expected Team Project");
    return { teamId, project };
  };
  const fixture = async (connected = true) => {
    const ownerId = await user();
    const viewerId = await user();
    const outsiderId = await user();
    const localProjectId = `project:${randomUUID()}`;
    const scope = await team(
      ownerId,
      viewerId,
      connected ? localProjectId : undefined
    );
    const agentId = randomUUID();
    await pool.query(
      `insert into personal_agent_identities(id,owner_user_id,name,role,default_provider,default_model,current_version,creation_request_id,creation_request_fingerprint)
      values($1,$2,'Native helper','','codex','test-model',1,$3,$4)`,
      [agentId, ownerId, randomUUID(), "a".repeat(64)]
    );
    await pool.query(
      `insert into personal_agent_identity_versions(agent_id,owner_user_id,version,name,role,default_provider,default_model,soul_instructions,instruction_source,created_by_user_id,request_id,request_fingerprint)
      values($1,$2,1,'Native helper','','codex','test-model','[koed encrypted personal agent soul]','custom',$2,$3,$4)`,
      [agentId, ownerId, randomUUID(), "b".repeat(64)]
    );
    return { ownerId, viewerId, outsiderId, localProjectId, agentId, ...scope };
  };
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const work = async (
    f: Fixture,
    options: {
      executionId?: string;
      projectId?: string;
      state?: "queued" | "completed";
      register?: boolean;
    } = {}
  ) => {
    const executionId = options.executionId ?? randomUUID();
    const projectId = options.projectId ?? f.localProjectId;
    if (!options.executionId)
      await pool.query(
        `insert into managed_conversation_executions(
      id,owner_user_id,project_id,ai_client_instance_id,model,permission_mode,runner_kind,state,execution_generation,fencing_token_hash,runner_deployment_id,runner_device_id,runner_id,runner_lease_expires_at,logical_session_id,provider_thread_id,started_at,runner_last_seen_at)
      values($1,$2,$3,'codex.default','test-model','supervised','local_device','running',1,$4,$5,$6,'runner',now()+interval '5 minutes',$7,$8,now(),now())`,
        [
          executionId,
          f.ownerId,
          projectId,
          "c".repeat(64),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          `provider:${randomUUID()}`
        ]
      );
    const commandId = randomUUID();
    const encryptedPayload = await provider.encrypt({
      plaintext: JSON.stringify({
        prompt: "Private native goal for owner review"
      }),
      scope: {
        tenantId: f.ownerId,
        objectClass: "managed_conversation_prompt"
      },
      provenance: {
        rowFamily: "managed_conversation_commands",
        sourceId: commandId
      },
      ciphertextLocation: "managed_conversation_commands.encrypted_payload",
      aad: { ownerUserId: f.ownerId, executionId, commandId }
    });
    await pool.query(
      `insert into managed_conversation_commands(id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,request_digest,execution_generation,state,completed_at,client_user_message_id,encrypted_payload)
      select $1,$2,$3,$4,coalesce(max(sequence),-1)+1,'prompt',$5,1,$6,case when $6='completed' then now() else null end,$7,$8::jsonb
      from managed_conversation_commands where execution_id=$3`,
      [
        commandId,
        f.ownerId,
        executionId,
        randomUUID(),
        "d".repeat(64),
        options.state ?? "queued",
        randomUUID(),
        encryptedPayload
      ]
    );
    const input = {
      commandId,
      executionId,
      executionGeneration: 1,
      agentId: f.agentId,
      agentVersion: 1,
      originalProjectId: projectId
    };
    if (options.register !== false) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await registerNativePublicSquareWorkWithClient(
          client,
          actor(f.ownerId),
          input
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    return { executionId, commandId, input };
  };
  const page = (f: Fixture, viewerId = f.viewerId, limit = 50) =>
    square.listPublicSquare(actor(viewerId), { teamId: f.teamId, limit });
  const eventCount = async (teamId: string, publicationId: string) =>
    (
      await pool.query<{ count: number }>(
        `select count(*)::int as count from collaboration_outbox
        where team_id=$1 and family='public_square_changed'
          and resource_type='public_square_publication' and resource_id=$2`,
        [teamId, publicationId]
      )
    ).rows[0]!.count;

  it("publishes native work without Jobs or private identifiers and keeps replay idempotent", async () => {
    const f = await fixture();
    const w = await work(f);
    await registerNativePublicSquareWorkWithClient(
      pool,
      actor(f.ownerId),
      w.input
    );
    const result = await page(f);
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]).toMatchObject({
      source: "native_command",
      jobId: null,
      status: "queued",
      ownerExecutionId: null,
      phase: null,
      sharedBrief: null
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(w.executionId);
    expect(text).not.toContain(w.commandId);
    expect(text).not.toContain(f.localProjectId);
    expect(text).not.toContain("Private native goal");
    expect((await page(f, f.ownerId))?.items[0]?.ownerExecutionId).toBe(
      w.executionId
    );
    expect(await page(f, f.outsiderId)).toBeNull();
    expect(
      (
        await pool.query<{ count: string }>(
          `select count(*) from personal_agent_execution_jobs where owner_user_id=$1`,
          [f.ownerId]
        )
      ).rows[0]?.count
    ).toBe("0");
    await expect(
      registerNativePublicSquareWorkWithClient(
        pool,
        actor(f.outsiderId),
        w.input
      )
    ).rejects.toThrow();
    const events = await pool.query<{ resource_id: string }>(
      `select resource_id from collaboration_outbox where team_id=$1 and family='public_square_changed' and resource_type='public_square_publication'`,
      [f.teamId]
    );
    expect(
      events.rows.some((event) => event.resource_id === result?.items[0]?.id)
    ).toBe(true);
    const publicationId = result!.items[0]!.id;
    const initialEvents = await eventCount(f.teamId, publicationId);
    await pool.query(
      `update managed_conversation_commands set state='failed',completed_at=now(),updated_at=now() where id=$1`,
      [w.commandId]
    );
    const terminalEvents = await eventCount(f.teamId, publicationId);
    expect(terminalEvents).toBeGreaterThan(initialEvents);
    await pool.query(
      `update managed_conversation_executions set runner_last_seen_at=now()+interval '1 minute',updated_at=now()+interval '1 minute' where id=$1`,
      [w.executionId]
    );
    expect(await eventCount(f.teamId, publicationId)).toBe(terminalEvents);
  });

  it("binds waiting to the exact turn and treats offline and uncertainty as active, never Idle", async () => {
    const f = await fixture();
    const w = await work(f);
    await pool.query(
      `insert into team_agent_offers(team_id,owner_user_id,agent_id,enabled) values($1,$2,$3,true)`,
      [f.teamId, f.ownerId, f.agentId]
    );
    await pool.query(
      `update managed_conversation_commands set state='dispatching',lease_token=$2,lease_expires_at=now()+interval '5 minutes',dispatching_at=now(),result='{"turnId":"this-turn"}' where id=$1`,
      [w.commandId, randomUUID()]
    );
    await pool.query(
      `insert into managed_conversation_runtime_items(owner_user_id,execution_id,execution_generation,provider_request_id,provider_turn_id,item_kind,state,request_digest,encrypted_payload)
      values($1,$2,1,$3,'other-turn','user_input','pending',$4,'{}')`,
      [f.ownerId, w.executionId, randomUUID(), "e".repeat(64)]
    );
    expect((await page(f))?.items[0]?.status).toBe("running");
    await pool.query(
      `update managed_conversation_runtime_items set provider_turn_id='this-turn' where execution_id=$1`,
      [w.executionId]
    );
    expect((await page(f))?.items[0]?.status).toBe("waiting");
    await pool.query(
      `update managed_conversation_commands set state='completed',completed_at=now(),lease_token=null,lease_expires_at=null where id=$1`,
      [w.commandId]
    );
    expect((await page(f))?.items[0]).toMatchObject({
      status: "waiting",
      completedAt: null
    });
    await pool.query(
      `update managed_conversation_executions set execution_generation=2 where id=$1`,
      [w.executionId]
    );
    expect((await page(f))?.items[0]?.status).toBe("unknown");
    await pool.query(
      `update managed_conversation_executions set execution_generation=1 where id=$1`,
      [w.executionId]
    );
    await pool.query(
      `update managed_conversation_executions set runner_lease_expires_at=now()-interval '1 minute' where id=$1`,
      [w.executionId]
    );
    expect((await page(f))?.items[0]).toMatchObject({
      status: "offline",
      lastKnownStatus: "waiting"
    });
    expect((await page(f))?.idleAgents).toEqual([]);
    await pool.query(
      `update managed_conversation_commands set state='indeterminate' where id=$1`,
      [w.commandId]
    );
    expect((await page(f))?.items[0]?.status).toBe("unknown");
    expect((await page(f))?.idleAgents).toEqual([]);
    await pool.query(
      `update managed_conversation_runtime_items set provider_turn_id='other-turn' where execution_id=$1`,
      [w.executionId]
    );
    await pool.query(
      `update managed_conversation_commands set state='completed',completed_at=now() where id=$1`,
      [w.commandId]
    );
    expect((await page(f))?.items[0]?.status).toBe("succeeded");
    expect((await page(f))?.idleAgents.map((item) => item.agentId)).toContain(
      f.agentId
    );
  });

  it("shares briefs per Team, withdraws immediately and freezes a departed owner's record", async () => {
    const f = await fixture();
    const second = await team(f.ownerId, f.viewerId, f.localProjectId);
    const w = await work(f);
    const publication = (await page(f))!.items[0]!;
    expect(
      await square.getPublicSquareBriefDraft(actor(f.ownerId), {
        teamId: f.teamId,
        publicationId: publication.id
      })
    ).toMatchObject({ briefDraft: "Private native goal for owner review" });
    expect((await page(f))?.items[0]?.sharedBrief).toBeNull();
    expect(
      await square.getPublicSquareBriefDraft(actor(f.viewerId), {
        teamId: f.teamId,
        publicationId: publication.id
      })
    ).toBeNull();
    expect(
      await square.updatePublicSquareBrief(actor(f.viewerId), {
        teamId: f.teamId,
        publicationId: publication.id,
        expectedVersion: publication.version,
        brief: "Unauthorized"
      })
    ).toBeNull();
    const shared = await square.updatePublicSquareBrief(actor(f.ownerId), {
      teamId: f.teamId,
      publicationId: publication.id,
      expectedVersion: publication.version,
      brief: "Reviewed Team A brief"
    });
    expect((await page(f))?.items[0]?.sharedBrief).toBe(
      "Reviewed Team A brief"
    );
    expect(
      (
        await square.listPublicSquare(actor(f.viewerId), {
          teamId: second.teamId,
          limit: 50
        })
      )?.items[0]?.sharedBrief
    ).toBeNull();
    await expect(
      square.updatePublicSquareBrief(actor(f.ownerId), {
        teamId: f.teamId,
        publicationId: publication.id,
        expectedVersion: publication.version,
        brief: "Stale update"
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    const hidden = await square.updatePublicSquareBrief(actor(f.ownerId), {
      teamId: f.teamId,
      publicationId: publication.id,
      expectedVersion: shared!.version,
      brief: null
    });
    expect((await page(f))?.items[0]?.sharedBrief).toBeNull();
    await square.updatePublicSquareBrief(actor(f.ownerId), {
      teamId: f.teamId,
      publicationId: publication.id,
      expectedVersion: hidden!.version,
      brief: "Retained reviewed brief"
    });
    await pool.query(
      `update team_memberships set status='disabled',disabled_at=now() where team_id=$1 and user_id=$2`,
      [f.teamId, f.ownerId]
    );
    const frozen = (await page(f))!.items[0]!;
    expect(frozen).toMatchObject({
      ownerLeftTeam: true,
      sharedBrief: "Retained reviewed brief",
      status: "queued"
    });
    await pool.query(
      `update managed_conversation_commands set state='completed',completed_at=now(),updated_at=now() where id=$1`,
      [w.commandId]
    );
    expect((await page(f))?.items[0]).toEqual(frozen);
    await square.updatePublicSquareBrief(actor(f.viewerId), {
      teamId: f.teamId,
      publicationId: publication.id,
      expectedVersion: frozen.version,
      brief: null
    });
    await pool.query(
      `update team_memberships set status='enabled',disabled_at=null where team_id=$1 and user_id=$2`,
      [f.teamId, f.ownerId]
    );
    expect((await page(f))?.items[0]).toMatchObject({
      ownerLeftTeam: true,
      sharedBrief: null,
      status: "queued"
    });
    expect(
      await square.unsharePublicSquareProject(actor(f.viewerId), {
        teamId: f.teamId,
        teamProjectId: f.project.id
      })
    ).toBe(true);
    expect((await page(f))?.items).toEqual([]);
    expect(
      (
        await square.listPublicSquare(actor(f.viewerId), {
          teamId: second.teamId,
          limit: 50
        })
      )?.items
    ).toHaveLength(1);
    await pool.query(
      `update collaboration_team_shared_projects set unshared_at=now() where id=$1`,
      [second.project.id]
    );
    const revoked = await pool.query<{ state: string }>(
      `select state from personal_agent_team_native_command_publications where team_id=$1`,
      [second.teamId]
    );
    expect(revoked.rows.map((row) => row.state)).toEqual(["revoked"]);
  });

  it("publishes only active original-Project work at first share, never completed private history or moved work", async () => {
    const f = await fixture(false);
    const active = await work(f);
    await work(f, { state: "completed" });
    const oldProject = `private:${randomUUID()}`;
    const moved = await work(f, { projectId: oldProject });
    await pool.query(
      `update managed_conversation_executions set project_id=$2 where id=$1`,
      [moved.executionId, f.localProjectId]
    );
    expect((await page(f))?.items).toEqual([]);
    await square.setPublicSquareConnection(actor(f.ownerId), {
      teamId: f.teamId,
      teamProjectId: f.project.id,
      expectedVersion: 0,
      localProjectId: f.localProjectId
    });
    expect(
      (await page(f, f.ownerId))?.items.map((item) => item.ownerExecutionId)
    ).toEqual([active.executionId]);
    await work(f, { executionId: moved.executionId });
    expect((await page(f))?.items).toHaveLength(2);
  });

  it("keeps earlier completed metadata fixed during later private work and excludes busy Agents beyond page one from Idle", async () => {
    const f = await fixture();
    const finished = await work(f);
    await pool.query(
      `update managed_conversation_commands set state='completed',dispatching_at=now()-interval '2 minutes',completed_at=now()-interval '1 minute',updated_at=now()-interval '1 minute' where id=$1`,
      [finished.commandId]
    );
    const before = (await page(f))!.items[0]!;
    await pool.query(
      `update managed_conversation_executions set runner_last_seen_at=now()+interval '1 minute',updated_at=now()+interval '1 minute' where id=$1`,
      [finished.executionId]
    );
    const after = (await page(f))!.items[0]!;
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.lastSeenAt).toBe(before.lastSeenAt);
    expect(after.completedAt).toBe(before.completedAt);
    await pool.query(
      `insert into team_agent_offers(team_id,owner_user_id,agent_id,enabled) values($1,$2,$3,true)`,
      [f.teamId, f.ownerId, f.agentId]
    );
    await work(f);
    await work(f);
    const first = await page(f, f.viewerId, 1);
    expect(first?.items).toHaveLength(1);
    expect(first?.nextCursor).not.toBeNull();
    expect(first?.idleAgents).toEqual([]);
    const next = await square.listPublicSquare(actor(f.viewerId), {
      teamId: f.teamId,
      limit: 1,
      cursor: first!.nextCursor!
    });
    expect(next?.items[0]?.id).not.toBe(first?.items[0]?.id);
    expect(next?.items[0]?.status).toBe("queued");
  });
});

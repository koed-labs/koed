import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crossIdentitySyncDeterministicUuid } from "@koed/shared";
import { runDbMigrations } from "./migrate.js";
import { createCrossIdentitySyncRepository } from "./cross-identity-sync-repository.js";
import {
  createPersonalProjectSharePolicyRepository,
  PersonalProjectSharePolicyConflictError
} from "./personal-project-share-policy-repository.js";

const testUrl =
  process.env.KOED_HQ713_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!testUrl)("first Project policy source preparation", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database = "";
  const ownerUserId = randomUUID();
  const otherUserId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const workspaceProjectId = randomUUID();
  const sourceDeploymentProtocolId = randomUUID();
  const futureDeviceCredentialId = randomUUID();
  const teamBackendId = "hq713-policy-local-source";
  const scope = {
    ownerUserId,
    projectId,
    teamBackendId,
    workspaceProjectId
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl, max: 2 });
    database = `hq713_policy_source_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${database}"`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
    await runDbMigrations(pool);
    await pool.query(`insert into users(id,email) values($1,$2),($3,$4)`, [
      ownerUserId,
      `${ownerUserId}@test.invalid`,
      otherUserId,
      `${otherUserId}@test.invalid`
    ]);
    await pool.query(
      `insert into projects(id,owner_user_id,name,key,team_backend_id,workspace_project_id)
       values($1,$2,'Policy source','hq713-policy-source',$3,$4)`,
      [projectId, ownerUserId, teamBackendId, workspaceProjectId]
    );
    await pool.query(
      `insert into projects(id,owner_user_id,name,key)
       values($1,$2,'Other source','hq713-other-source')`,
      [otherProjectId, otherUserId]
    );
    await pool.query(
      `insert into deployment_identities(protocol_deployment_id,locality,profile)
       values($1,'local','local_personal')`,
      [sourceDeploymentProtocolId]
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database "${database}" with (force)`);
    await admin?.end();
  });

  const seed = async (
    input: {
      ownerUserId?: string;
      private?: boolean;
      hq?: boolean;
      deleted?: boolean;
      future?: boolean;
    } = {}
  ) => {
    const sessionId = randomUUID();
    const owner = input.ownerUserId ?? ownerUserId;
    const externalSessionId = `hq713-${sessionId}`;
    const linkEpoch = input.future
      ? (
          await pool.query<{ share_policy_link_epoch: string }>(
            "select share_policy_link_epoch from projects where id=$1",
            [projectId]
          )
        ).rows[0]!.share_policy_link_epoch
      : null;
    await pool.query(
      `insert into sessions
         (id,owner_user_id,source_runtime,capture_method,visibility,
          automatic_personal_project_id,external_session_id,source_kind,
          source_adapter_version,project_share_private_at,trashed_at,metadata,
          project_share_capture_policy_version,
          project_share_capture_workspace_project_id,
          project_share_capture_device_credential_id,
          project_share_capture_link_epoch,
          project_share_capture_context_version,
          project_share_capture_prepared_at)
       values($1,$2,'codex-cli','api','personal',$3,$4,'codex',
              'codex-transcript-v1',
              case when $5::boolean then now() else null end,
              case when $6::boolean then now() else null end,$7::jsonb,
              case when $8::boolean then 1 else null end,
              case when $8::boolean then $9::uuid else null end,
              case when $8::boolean then $10::uuid else null end,
              case when $8::boolean then $11::uuid else null end,
              case when $8::boolean then 1 else null end,
              case when $8::boolean then now() else null end)`,
      [
        sessionId,
        owner,
        owner === ownerUserId ? projectId : otherProjectId,
        externalSessionId,
        input.private ?? false,
        input.deleted ?? false,
        JSON.stringify(input.hq ? { managedConversation: true } : {}),
        input.future ?? false,
        workspaceProjectId,
        futureDeviceCredentialId,
        linkEpoch
      ]
    );
    await pool.query(
      `insert into conversation_source_artifacts
         (owner_user_id,session_id,logical_source_id,source_generation_id,
          replica_role,source_kind,source_runtime,external_session_id,
          source_fingerprint,artifact_format,artifact_format_version,
          source_adapter_version,source_created_at,storage_provider,storage_prefix,
          origin_deployment_id,origin_device_id,origin_key_id,origin_public_key,
          redacted_source_label)
       values($1,$2,$3,$4,'origin_local','codex','codex-cli',$5,
              $6,'jsonl',1,'codex-transcript-v1',now(),'filesystem','fixture',
              'deployment','device','key',$7,'Captured policy source')`,
      [
        owner,
        sessionId,
        randomUUID(),
        randomUUID(),
        externalSessionId,
        "a".repeat(64),
        "A".repeat(43)
      ]
    );
    await pool.query(
      `insert into memory_events
         (owner_user_id,visibility,event_type,capture_method,session_id,payload)
       values($1,'personal','captured','api',$2,'{}'::jsonb)`,
      [owner, sessionId]
    );
    const logicalMemoryId = crossIdentitySyncDeterministicUuid({
      protocol: "koed.captured-session-sync/v1",
      sourceDeploymentId: sourceDeploymentProtocolId,
      sourceUserId: owner,
      originSessionId: sessionId,
      identity: "logical-memory"
    });
    return { sessionId, logicalMemoryId, owner };
  };

  it("prepares the first local cursor exactly once and excludes private, HQ, deleted and unowned Sessions", async () => {
    const eligible = await seed();
    const privateSource = await seed({ private: true });
    const hqSource = await seed({ hq: true });
    const deletedSource = await seed({ deleted: true });
    const unownedSource = await seed({ ownerUserId: otherUserId });
    const policy = createPersonalProjectSharePolicyRepository(pool);
    const sync = createCrossIdentitySyncRepository(pool);

    expect(await policy.buildInitialManifest(scope)).toMatchObject({
      entries: []
    });
    expect(await policy.listInitialManifestSources(scope)).toEqual([
      { sessionId: eligible.sessionId, mappingRevision: 1 }
    ]);
    const firstCursor = await sync.prepareCapturedSessionSyncCandidateRevision(
      { userId: ownerUserId },
      eligible.sessionId
    );
    expect(firstCursor).toBeGreaterThan(0);
    expect(
      await sync.prepareCapturedSessionSyncCandidateRevision(
        { userId: ownerUserId },
        eligible.sessionId
      )
    ).toBe(firstCursor);
    const preparation = {
      ...scope,
      sessionId: eligible.sessionId,
      mappingRevision: 1,
      logicalMemoryId: eligible.logicalMemoryId,
      sourceRevision: firstCursor!,
      sourceDeploymentProtocolId
    };
    await policy.prepareInitialManifestSource(preparation);
    await policy.prepareInitialManifestSource(preparation);
    const manifest = await policy.buildInitialManifest(scope);
    expect(manifest.entries).toMatchObject([
      {
        sessionId: eligible.sessionId,
        logicalMemoryId: eligible.logicalMemoryId,
        sourceRevision: firstCursor,
        mappingRevision: 1
      }
    ]);
    const revision = await pool.query<{
      latest_source_revision: string;
      revision: string;
      source_cursor: string;
    }>(
      `select memory.latest_source_revision::text,
              source.revision::text,source.source_cursor::text
         from logical_memories memory
         join captured_session_source_revisions source
           on source.logical_memory_id=memory.id
        where memory.id=$1`,
      [eligible.logicalMemoryId]
    );
    expect(revision.rows).toEqual([
      {
        latest_source_revision: String(firstCursor),
        revision: String(firstCursor! + 1),
        source_cursor: String(firstCursor)
      }
    ]);
    for (const excluded of [
      privateSource,
      hqSource,
      deletedSource,
      unownedSource
    ]) {
      await expect(
        policy.prepareInitialManifestSource({
          ...preparation,
          sessionId: excluded.sessionId,
          logicalMemoryId: excluded.logicalMemoryId
        })
      ).rejects.toBeInstanceOf(PersonalProjectSharePolicyConflictError);
    }
    const sideEffects = await pool.query<{
      relationships: string;
      grants: string;
    }>(
      `select
        (select count(*)::text from cross_identity_sync_relationships) as relationships,
        (select count(*)::text from project_policy_session_grants) as grants`
    );
    expect(sideEffects.rows[0]).toEqual({ relationships: "0", grants: "0" });
  }, 120_000);

  it("prepares the exact newer private source cursor for a share-again offer", async () => {
    const source = await seed();
    const policy = createPersonalProjectSharePolicyRepository(pool);
    const sync = createCrossIdentitySyncRepository(pool);
    const firstCursor = await sync.prepareCapturedSessionSyncCandidateRevision(
      { userId: ownerUserId },
      source.sessionId
    );
    expect(firstCursor).toBeGreaterThan(0);
    await policy.prepareInitialManifestSource({
      ...scope,
      sessionId: source.sessionId,
      mappingRevision: 1,
      logicalMemoryId: source.logicalMemoryId,
      sourceRevision: firstCursor!,
      sourceDeploymentProtocolId
    });
    await pool.query(
      `update sessions set project_share_private_at=now() where id=$1`,
      [source.sessionId]
    );
    await pool.query(
      `insert into memory_events
         (owner_user_id,visibility,event_type,capture_method,session_id,payload)
       values($1,'personal','captured','api',$2,'{}'::jsonb)`,
      [ownerUserId, source.sessionId]
    );
    const newerCursor = await sync.prepareCapturedSessionSyncCandidateRevision(
      { userId: ownerUserId },
      source.sessionId
    );
    expect(newerCursor).toBeGreaterThan(firstCursor!);
    const offer = {
      ...scope,
      sessionId: source.sessionId,
      teamPrincipalUserId: ownerUserId,
      deviceCredentialId: futureDeviceCredentialId,
      reason: "share_again" as const,
      logicalMemoryId: source.logicalMemoryId,
      mappingRevision: 1,
      sourceRevision: newerCursor!,
      candidateHash: "a".repeat(64)
    };
    await expect(
      policy.prepareExplicitOffer({
        ...offer,
        sourceRevision: newerCursor! + 1
      })
    ).rejects.toBeInstanceOf(PersonalProjectSharePolicyConflictError);
    const preparedOffer = await policy.prepareExplicitOffer(offer);
    expect(typeof preparedOffer.offerId).toBe("string");
    expect(typeof preparedOffer.mutationId).toBe("string");
    const frontier = await pool.query<{
      latest_source_revision: string;
      source_cursor: string;
    }>(
      `select memory.latest_source_revision::text,
              source.source_cursor::text
         from logical_memories memory
         join captured_session_source_revisions source
           on source.logical_memory_id=memory.id
          and source.source_cursor=memory.latest_source_revision
        where memory.id=$1`,
      [source.logicalMemoryId]
    );
    expect(frontier.rows).toEqual([
      {
        latest_source_revision: String(newerCursor),
        source_cursor: String(newerCursor)
      }
    ]);
  }, 120_000);

  it("finds the first future source before any logical-memory revision and fences private, moved, HQ, deleted, and revoked sources", async () => {
    const policy = createPersonalProjectSharePolicyRepository(pool);
    const prePolicy = await seed();
    await policy.activateLocalPolicy({
      ...scope,
      version: 1,
      deviceCredentialId: futureDeviceCredentialId
    });
    const eligible = await seed({ future: true });
    const privateSource = await seed({ future: true, private: true });
    const hqSource = await seed({ future: true, hq: true });
    const deletedSource = await seed({ future: true, deleted: true });
    const movedIn = await seed();
    const otherPersonalProjectId = randomUUID();
    await pool.query(
      `insert into projects(id,owner_user_id,name,key)
       values($1,$2,'Moved source origin','hq713-moved-source')`,
      [otherPersonalProjectId, ownerUserId]
    );
    await pool.query(
      `update sessions set automatic_personal_project_id=$2,
          project_override_personal_project_id=$3,project_override_at=now(),
          project_override_id='hq713-test-move',
          project_override_name='Moved into active policy Project',
          project_override_by_user_id=$4,
          project_assignment_version=project_assignment_version+1
        where id=$1`,
      [movedIn.sessionId, otherPersonalProjectId, projectId, ownerUserId]
    );
    const page = await policy.listFutureSourceCandidates({
      ...scope,
      policyVersion: 1
    });
    expect(page.entries).toEqual([
      { sessionId: eligible.sessionId, mappingRevision: 1 }
    ]);
    expect(
      await policy.exactFutureSourceCandidate({
        ...scope,
        policyVersion: 1,
        sessionId: eligible.sessionId
      })
    ).toEqual({ sessionId: eligible.sessionId, mappingRevision: 1 });
    for (const excluded of [
      prePolicy,
      privateSource,
      hqSource,
      deletedSource,
      movedIn
    ])
      expect(
        await policy.exactFutureSourceCandidate({
          ...scope,
          policyVersion: 1,
          sessionId: excluded.sessionId
        })
      ).toBeNull();
    expect(
      await policy.exactFutureEligible({
        ...scope,
        policyVersion: 1,
        sessionId: eligible.sessionId
      })
    ).toBeNull();
    const cursor = await createCrossIdentitySyncRepository(
      pool
    ).prepareCapturedSessionSyncCandidateRevision(
      { userId: ownerUserId },
      eligible.sessionId
    );
    expect(cursor).toBeGreaterThan(0);
    const preparation = {
      ...scope,
      sessionId: eligible.sessionId,
      mappingRevision: 1,
      logicalMemoryId: eligible.logicalMemoryId,
      sourceRevision: cursor!,
      sourceDeploymentProtocolId
    };
    await policy.prepareInitialManifestSource(preparation);
    await policy.prepareInitialManifestSource(preparation);
    expect(
      await policy.exactFutureEligible({
        ...scope,
        policyVersion: 1,
        sessionId: eligible.sessionId
      })
    ).toMatchObject({
      sessionId: eligible.sessionId,
      logicalMemoryId: eligible.logicalMemoryId,
      sourceRevision: cursor,
      mappingRevision: 1
    });
    for (const excluded of [
      prePolicy,
      privateSource,
      hqSource,
      deletedSource,
      movedIn
    ])
      expect(
        await policy.exactFutureEligible({
          ...scope,
          policyVersion: 1,
          sessionId: excluded.sessionId
        })
      ).toBeNull();
    const sideEffects = await pool.query<{
      relationships: string;
      grants: string;
      pending: string;
    }>(
      `select
         (select count(*)::text from cross_identity_sync_relationships) as relationships,
         (select count(*)::text from project_policy_session_grants) as grants,
         (select count(*)::text from project_share_local_issues) as pending`
    );
    expect(sideEffects.rows[0]).toEqual({
      relationships: "0",
      grants: "0",
      pending: "0"
    });
    await policy.revokeLocalPolicy({ ...scope, expectedVersion: 1 });
    await expect(
      policy.listFutureSourceCandidates({ ...scope, policyVersion: 1 })
    ).rejects.toBeInstanceOf(PersonalProjectSharePolicyConflictError);
  }, 120_000);
});

import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  allPrivacyLabelsPolicy,
  createLocalTestKeyEnvelopeEncryptionProvider,
  repositoryScopeId,
  type RepositoryIdentity
} from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runDbMigrations } from "../src/migrate.js";
import { createPrivacyClassificationRepository } from "../src/privacy-classification-repository.js";
import { createMemoryAnswerTaskRepository } from "../src/memory-answer-task-repository.js";
import { snapshotOwnedTeamRepository } from "../src/team-repository-snapshot.js";
import {
  assertMemoryAnswerTeamAuthorityWithClient,
  freezeMemoryAnswerTeamAuthorityWithClient,
  MemoryAnswerTeamAuthorityError
} from "../src/memory-answer-team-authority.js";

const databaseUrl = process.env.MEMORY_ANSWER_TEAM_AUTHORITY_TEST_DATABASE_URL;

interface FixtureModule {
  createFixtureRuntime(
    pool: pg.Pool,
    options: { environment: { NODE_ENV: string } }
  ): Promise<unknown>;
  seedFixture(pool: pg.Pool, runtime: unknown): Promise<unknown>;
  validateFixture(pool: pg.Pool, runtime: unknown): Promise<unknown>;
  fixtureUsers: { alice: { id: string } };
  fixtureWorkspaces: { cloud: { id: string } };
}

describe.skipIf(!databaseUrl)(
  "transactional Memory Answer Team authority",
  // Full-fixture checks revalidate every grant; contention assertions below
  // retain their separate 100ms database lock deadlines.
  { timeout: 120_000 },
  () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const name = `team_authority_${randomUUID().replaceAll("-", "")}`;
    let pool: pg.Pool;
    let isolatedDatabaseUrl: string;
    let userId: string;
    let teamWorkspaceId: string;
    let fixtureUserId: string;
    let fixtureWorkspaceId: string;

    beforeAll(async () => {
      await admin.query(
        `create database ${name} template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`
      );
      const url = new URL(databaseUrl!);
      url.pathname = `/${name}`;
      isolatedDatabaseUrl = url.toString();
      pool = new pg.Pool({ connectionString: isolatedDatabaseUrl });
      await runDbMigrations(pool);
      const fixture = (await import(
        new URL("../../../scripts/team-saas-fixture-lib.mjs", import.meta.url)
          .href
      )) as FixtureModule;
      const runtime = await fixture.createFixtureRuntime(pool, {
        environment: { NODE_ENV: "test" }
      });
      await fixture.seedFixture(pool, runtime);
      await fixture.validateFixture(pool, runtime);
      fixtureUserId = fixture.fixtureUsers.alice.id;
      fixtureWorkspaceId = fixture.fixtureWorkspaces.cloud.id;
      const user = await pool.query<{ id: string }>(
        "insert into users(email) values($1) returning id",
        [`authority-${randomUUID()}@example.test`]
      );
      userId = user.rows[0]!.id;
      const team = await pool.query<{ id: string }>(
        "insert into teams(name,entitlement_status) values('Authority Team','active') returning id"
      );
      const teamId = team.rows[0]!.id;
      const workspace = await pool.query<{ id: string }>(
        "insert into team_workspaces(team_id,name) values($1,'Authority Workspace') returning id",
        [teamId]
      );
      teamWorkspaceId = workspace.rows[0]!.id;
      await pool.query(
        "insert into team_memberships(team_id,user_id,role,status,accepted_at) values($1,$2,'owner','enabled',now())",
        [teamId, userId]
      );
      await pool.query(
        "insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,granted_by_user_id) values($1,$2,$3,'write',$3)",
        [teamWorkspaceId, teamId, userId]
      );
    }, 120_000);

    afterAll(async () => {
      await pool?.end();
      await admin.query(`drop database if exists ${name}`);
      await admin.end();
    }, 120_000);

    it("holds membership authority through payload use and denies subsequent revocation", async () => {
      const actor = { userId };
      const client = await pool.connect();
      const competing = await pool.connect();
      try {
        await client.query("begin");
        const authority = await freezeMemoryAnswerTeamAuthorityWithClient(
          client,
          actor,
          { teamWorkspaceId }
        );
        expect(authority.recallBoundary.shareGrantIds).toEqual([]);
        await assertMemoryAnswerTeamAuthorityWithClient(
          client,
          actor,
          authority
        );
        await competing.query("begin");
        await competing.query("set local lock_timeout='100ms'");
        await expect(
          competing.query(
            "update team_memberships set status='disabled',disabled_at=now(),version=version+1 where user_id=$1",
            [userId]
          )
        ).rejects.toMatchObject({ code: "55P03" });
        await competing.query("rollback");
        await client.query("commit");
        await competing.query(
          "update team_memberships set status='disabled',disabled_at=now(),version=version+1 where user_id=$1",
          [userId]
        );
        await client.query("begin");
        await expect(
          assertMemoryAnswerTeamAuthorityWithClient(client, actor, authority)
        ).rejects.toBeInstanceOf(MemoryAnswerTeamAuthorityError);
        await client.query("rollback");
      } finally {
        await client.query("rollback");
        await competing.query("rollback");
        client.release();
        competing.release();
      }
    });

    const freezeFixture = async (client: pg.PoolClient) => {
      const authority = await freezeMemoryAnswerTeamAuthorityWithClient(
        client,
        { userId: fixtureUserId },
        { teamWorkspaceId: fixtureWorkspaceId }
      );
      expect(authority.recallBoundary.shareGrantIds.length).toBeGreaterThan(1);
      await assertMemoryAnswerTeamAuthorityWithClient(
        client,
        { userId: fixtureUserId },
        authority
      );
      return authority;
    };

    it.each([
      [
        "Project snapshot change",
        `update team_memory_share_grants set repository_snapshot='{"version":1,"classification":"portable_repository","fingerprint":"gr_changed","label":null,"branchObservation":null}'::jsonb where id=$1`
      ],
      [
        "grant revocation",
        "update team_memory_share_grants set lifecycle='revoked',revoked_at=now(),grant_version=grant_version+1 where id=$1"
      ],
      [
        "fidelity downgrade",
        "update team_memory_share_grants set maximum_fidelity='lcm_rollups',activation_representation='lcm_rollups',source_capabilities=array['lcm_rollups']::shared_memory_representation[],fidelity_policy_revision=fidelity_policy_revision+1,grant_version=grant_version+1 where id=$1"
      ],
      [
        "source privacy change",
        "update team_memory_representations set effective_privacy_policy_hash=repeat('a',64) where share_grant_id=$1"
      ],
      [
        "source provenance change",
        "update team_memory_representations set source_revision_hash=repeat('b',64) where share_grant_id=$1"
      ],
      [
        "classifier revocation",
        "update privacy_classifier_generations set status='revoked',revoked_at=now() where id in (select privacy_classifier_generation_id from team_memory_representations where share_grant_id=$1)"
      ],
      [
        "classifier revision change",
        "update privacy_classifier_generations set version=version+1 where id in (select privacy_classifier_generation_id from team_memory_representations where share_grant_id=$1)"
      ],
      [
        "effective privacy policy revocation",
        "update privacy_content_policies set status='revoked',revoked_at=now() where status='active' and $1::uuid is not null"
      ],
      [
        "source authorization revocation",
        "update cross_identity_sync_relationships set revoked_at=now() where local_replica_id in (select remote_replica_id from team_memory_share_grants where id=$1)"
      ]
    ])("denies %s before protected work", async (_label, sql) => {
      const client = await pool.connect();
      const protectedWork = vi.fn();
      try {
        await client.query("begin");
        const authority = await freezeFixture(client);
        let grantId = authority.recallBoundary.shareGrantIds[0]!;
        if (_label === "fidelity downgrade") {
          const eligible = await client.query<{ id: string }>(
            "select id from team_memory_share_grants where id=any($1::uuid[]) and maximum_fidelity in ('memory_events','lcm_leaves') limit 1",
            [authority.recallBoundary.shareGrantIds]
          );
          expect(eligible.rows).toHaveLength(1);
          grantId = eligible.rows[0]!.id;
        }
        await client.query(sql, [grantId]);
        const usePayload = async () => {
          await assertMemoryAnswerTeamAuthorityWithClient(
            client,
            { userId: fixtureUserId },
            authority
          );
          protectedWork();
        };
        await expect(usePayload()).rejects.toBeInstanceOf(
          MemoryAnswerTeamAuthorityError
        );
        expect(protectedWork).not.toHaveBeenCalled();
      } finally {
        await client.query("rollback");
        client.release();
      }
    });

    it("uses transferred source context rather than the receiver's local assignment or checkout", async () => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const source = await client.query<{
          owner_user_id: string;
          logical_memory_id: string;
          local_session_id: string;
        }>(
          `select m.owner_user_id,m.logical_memory_id,m.local_session_id
           from local_captured_session_logical_memories m
           join sessions s on s.id=m.local_session_id
           where s.visibility='personal' and s.invalidated_at is null
             and s.personal_deleted_at is null limit 1`
        );
        expect(source.rows).toHaveLength(1);
        const row = source.rows[0]!;
        const snapshot = {
          version: 1,
          classification: "portable_repository",
          fingerprint: "gr_source_repository",
          label: null,
          branchObservation: null
        };
        const localOverride: RepositoryIdentity = {
          kind: "device_local_repository",
          key: "local_receiver_repository",
          root: "/receiver/private-checkout",
          branch: "receiver-branch",
          reason: "local_fallback",
          checkoutId: "receiver_checkout",
          originatingDeviceId: "receiver_device",
          selectedRemote: null,
          anchorDisplay: null
        };
        await client.query(
          `update sessions set metadata=metadata || $2::jsonb,
            repository_override_identity=$3::jsonb,
            repository_assignment_version=repository_assignment_version+1
           where id=$1`,
          [
            row.local_session_id,
            JSON.stringify({ syncReplica: true, repositorySnapshot: snapshot }),
            JSON.stringify(localOverride)
          ]
        );
        expect(
          await snapshotOwnedTeamRepository(
            client,
            row.owner_user_id,
            row.logical_memory_id
          )
        ).toEqual(snapshot);
        expect(
          await snapshotOwnedTeamRepository(
            client,
            userId,
            row.logical_memory_id
          )
        ).toMatchObject({ classification: "unresolved", fingerprint: null });
        await client.query(
          "update sessions set metadata=metadata-'repositorySnapshot' where id=$1",
          [row.local_session_id]
        );
        expect(
          await snapshotOwnedTeamRepository(
            client,
            row.owner_user_id,
            row.logical_memory_id
          )
        ).toMatchObject({ classification: "unresolved", fingerprint: null });
      } finally {
        await client.query("rollback");
        client.release();
      }
    });

    // This round trip revalidates every fixture grant at each durable-task boundary.
    it("denies a completed Project answer before decrypting it when a Share Grant is revoked", async () => {
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 74).toString("base64url")
      );
      const tasks = createMemoryAnswerTaskRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const actor = { userId: fixtureUserId, allowTeam: true };
      const context: RepositoryIdentity = {
        kind: "portable_repository",
        key: "gr_team_project_fixture",
        root: "/teammate/another-clone",
        branch: "main",
        reason: "origin",
        checkoutId: "teammate_clone",
        originatingDeviceId: "teammate_device",
        selectedRemote: "origin",
        anchorDisplay: "example.test/team/project"
      };
      const projectId = repositoryScopeId(context);
      const accepted = await tasks.acceptMemoryAnswerTask(actor, {
        origin: "mcp",
        teamWorkspaceId: fixtureWorkspaceId,
        maxQueued: 4,
        request: {
          input: {
            query: "What decision was shared for this Project?",
            search_domain: "project",
            project_id: projectId,
            repository_context: context,
            team_workspace_id: fixtureWorkspaceId
          }
        }
      });
      const claimed = await tasks.claimMemoryAnswerTask(actor, {
        leaseOwner: "team-project-worker",
        leaseMs: 60_000,
        allowTeam: true,
        scopeFilter: "team"
      });
      expect(claimed.task?.id).toBe(accepted.id);
      await tasks.completeMemoryAnswerTask(actor, {
        taskId: accepted.id,
        leaseOwner: claimed.task!.leaseOwner,
        fenceGeneration: claimed.task!.fenceGeneration,
        finalQuestion: {
          idempotencyKey: randomUUID(),
          query: "What decision was shared for this Project?",
          searchDomain: "project",
          projectId,
          teamWorkspaceId: fixtureWorkspaceId,
          status: "answered",
          answerMarkdown: "Protected Team answer"
        },
        result: { markdown: "Protected Team answer" }
      });
      expect(
        (await tasks.getMemoryAnswerTask(actor, accepted.id))?.result
      ).toMatchObject({ markdown: "Protected Team answer" });
      const client = await pool.connect();
      try {
        await client.query("begin");
        const authority = await freezeFixture(client);
        await client.query("commit");
        const grantId = authority.recallBoundary.shareGrantIds[0]!;
        await pool.query(
          "update team_memory_share_grants set lifecycle='revoked',revoked_at=now(),grant_version=grant_version+1 where id=$1",
          [grantId]
        );
        const decrypt = vi.fn(() => {
          throw new Error("Revoked answer must not be decrypted");
        });
        const collector = createMemoryAnswerTaskRepository(pool, {
          envelopeEncryptionProvider: {
            ...provider,
            decrypt
          }
        });
        try {
          await expect(
            collector.getMemoryAnswerTask(actor, accepted.id)
          ).rejects.toMatchObject({ statusCode: 403 });
          expect(decrypt).not.toHaveBeenCalled();
        } finally {
          await pool.query(
            "update team_memory_share_grants set lifecycle='active',revoked_at=null,grant_version=grant_version+1 where id=$1",
            [grantId]
          );
        }
      } finally {
        await client.query("rollback");
        client.release();
      }
    }, 120_000);

    it("holds grant, source and privacy authority locks through protected work", async () => {
      const client = await pool.connect();
      const competing = await pool.connect();
      try {
        await client.query("begin");
        const authority = await freezeFixture(client);
        const grantId = authority.recallBoundary.shareGrantIds[0]!;
        for (const sql of [
          "update team_memory_share_grants set grant_version=grant_version+1 where id=$1",
          "update memory_replicas set disabled_at=now() where id=(select remote_replica_id from team_memory_share_grants where id=$1)",
          "update cross_identity_sync_relationships set revoked_at=now() where local_replica_id=(select remote_replica_id from team_memory_share_grants where id=$1)",
          "update privacy_classifier_generations set version=version+1 where id in (select privacy_classifier_generation_id from team_memory_representations where share_grant_id=$1)",
          "update privacy_content_policies set status='revoked',revoked_at=now() where status='active' and $1::uuid is not null"
        ]) {
          await competing.query("begin");
          await competing.query("set local lock_timeout='100ms'");
          await expect(competing.query(sql, [grantId])).rejects.toMatchObject({
            code: "55P03"
          });
          await competing.query("rollback");
        }
      } finally {
        await client.query("rollback");
        await competing.query("rollback");
        client.release();
        competing.release();
      }
    });

    it("keeps original authority valid when another existing grant becomes authorized", async () => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const initial = await freezeFixture(client);
        const additionalGrant = initial.recallBoundary.shareGrantIds[0]!;
        await client.query(
          "update team_memory_share_grants set lifecycle='revoked',revoked_at=now() where id=$1",
          [additionalGrant]
        );
        const authority = await freezeFixture(client);
        expect(authority.recallBoundary.shareGrantIds).not.toContain(
          additionalGrant
        );
        await client.query(
          "update team_memory_share_grants set lifecycle='active',revoked_at=null where id=$1",
          [additionalGrant]
        );
        await expect(
          assertMemoryAnswerTeamAuthorityWithClient(
            client,
            { userId: fixtureUserId },
            authority
          )
        ).resolves.toBeUndefined();
        expect(
          (await freezeFixture(client)).recallBoundary.shareGrantIds
        ).toContain(additionalGrant);
      } finally {
        await client.query("rollback");
        client.release();
      }
    }, 120_000);

    it("serializes new privacy scope policies with protected work and denies stale authority afterward", async () => {
      const client = await pool.connect();
      const competingPool = new pg.Pool({
        connectionString: isolatedDatabaseUrl,
        max: 1,
        options: "-c lock_timeout=100ms"
      });
      const privacy = createPrivacyClassificationRepository(competingPool, {
        fingerprintKey: Buffer.alloc(32, 73)
      });
      let insertedPolicyId: string | undefined;
      try {
        await client.query("begin");
        const authority = await freezeFixture(client);
        const source = await client.query<{
          owner_user_id: string;
          deployment_id: string;
        }>(
          "select g.owner_user_id,d.id as deployment_id from team_memory_share_grants g cross join deployment_identities d where g.id=$1 and d.locality='local' and d.disabled_at is null limit 1",
          [authority.recallBoundary.shareGrantIds[0]]
        );
        const subject = {
          deploymentIdentityId: source.rows[0]!.deployment_id,
          sourceOwnerUserId: source.rows[0]!.owner_user_id
        };
        expect(
          (
            await client.query(
              "select id from privacy_content_policies where deployment_identity_id=$1 and source_owner_user_id=$2 and scope='source_owner'",
              [subject.deploymentIdentityId, subject.sourceOwnerUserId]
            )
          ).rows
        ).toEqual([]);
        const input = {
          scope: "source_owner" as const,
          subject,
          labels: allPrivacyLabelsPolicy(),
          expectedPreviousVersion: 0
        };
        await expect(
          privacy.createContentPolicyVersion(input)
        ).rejects.toMatchObject({ code: "55P03" });
        await client.query("commit");
        insertedPolicyId = (await privacy.createContentPolicyVersion(input)).id;
        await client.query("begin");
        await expect(
          assertMemoryAnswerTeamAuthorityWithClient(
            client,
            { userId: fixtureUserId },
            authority
          )
        ).rejects.toBeInstanceOf(MemoryAnswerTeamAuthorityError);
      } finally {
        await client.query("rollback");
        client.release();
        if (insertedPolicyId)
          await pool.query("delete from privacy_content_policies where id=$1", [
            insertedPolicyId
          ]);
        await competingPool.end();
      }
    });
  }
);

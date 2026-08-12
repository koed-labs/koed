import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  FIXTURE_VERSION,
  assertFixtureEnvironment,
  createFixtureRuntime,
  fixtureConversationSources,
  fixtureDeviceSecrets,
  fixtureMemoryRows,
  fixtureShareGrantIds,
  fixtureSessionRows,
  fixtureTeam,
  fixtureTeamMemberships,
  fixtureThreadRows,
  fixtureThreads,
  fixtureUserEmails,
  fixtureUserIds,
  fixtureUsers,
  fixtureWorkspaceAccess,
  fixtureWorkspaceIds,
  fixtureWorkspaces,
  normalizedFixtureSnapshot,
  resetFixture,
  seedFixture,
  validateFixture
} from "./team-saas-fixture-lib.mjs";

test("Team SaaS fixture definition is deterministic and realistic", () => {
  assert.equal(FIXTURE_VERSION, "team-saas-fixture-v1");
  assert.equal(fixtureTeam.name, "Koed Fixture Team");
  assert.deepEqual(Object.keys(fixtureUsers).sort(), [
    "alice",
    "bob",
    "carol",
    "dana",
    "david",
    "erin",
    "frank"
  ]);
  assert.deepEqual(Object.keys(fixtureWorkspaces).sort(), [
    "cloud",
    "electron",
    "ingestion"
  ]);
  assert.equal(new Set(fixtureUserIds).size, fixtureUserIds.length);
  assert.deepEqual(
    fixtureConversationSources.map((source) => [source.mode, source.lifecycle]),
    [
      ["continuous", "active"],
      ["snapshot", "active"],
      ["continuous", "revoked"]
    ]
  );
  for (const source of fixtureConversationSources) {
    assert.match(
      source.originKeyId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  }
  assert.ok(
    fixtureMemoryRows.filter((memory) => memory.shareState === "active")
      .length >
      fixtureConversationSources.filter(
        (source) => source.lifecycle === "active"
      ).length
  );
  assert.equal(new Set(fixtureUserEmails).size, fixtureUserEmails.length);
  assert.deepEqual(
    Object.keys(fixtureDeviceSecrets).sort(),
    Object.keys(fixtureUsers).sort()
  );
  assert.equal(new Set(fixtureWorkspaceIds).size, fixtureWorkspaceIds.length);
  assert.equal(
    new Set(fixtureMemoryRows.map((memory) => memory.idempotencyKey)).size,
    fixtureMemoryRows.length
  );
  assert.equal(
    new Set(fixtureMemoryRows.map((memory) => memory.sourceHash)).size,
    fixtureMemoryRows.length
  );
  assert.equal(new Set(fixtureThreadRows.map((thread) => thread.id)).size, 6);
  for (const idField of [
    "logicalMemoryId",
    "ownerPrincipalId",
    "remoteReplicaId",
    "remoteSyncReplicaId",
    "syncRelationshipId",
    "sourceOwnerPolicyId",
    "consentId",
    "representationId",
    "representationChunkId"
  ]) {
    assert.equal(
      new Set(fixtureMemoryRows.map((memory) => memory[idField])).size,
      fixtureMemoryRows.length,
      `${idField} values must be deterministic and unique`
    );
  }
});

test("Team SaaS fixture fails closed outside local fixture and test profiles", () => {
  assert.doesNotThrow(() => assertFixtureEnvironment({ NODE_ENV: "test" }));
  assert.doesNotThrow(() =>
    assertFixtureEnvironment({
      NODE_ENV: "development",
      KOED_DEPLOYMENT_PROFILE: "developer"
    })
  );
  assert.throws(
    () =>
      assertFixtureEnvironment({
        NODE_ENV: "production",
        KOED_DEPLOYMENT_PROFILE: "team_self_hosted"
      }),
    /local-only test bearers/
  );
  assert.throws(
    () =>
      assertFixtureEnvironment({
        NODE_ENV: "development",
        KOED_DEPLOYMENT_PROFILE: "private_vps"
      }),
    /local-only test bearers/
  );
});

test("Team SaaS fixture covers required access states", () => {
  const shareStates = new Set(
    fixtureMemoryRows.map((memory) => memory.shareState)
  );
  assert.ok(shareStates.has("active"));
  assert.ok(shareStates.has("private"));
  assert.ok(shareStates.has("revoked"));
  assert.ok(shareStates.has("personal_deleted_retained"));

  assert.deepEqual(
    [
      ...new Set(fixtureMemoryRows.map((memory) => memory.representation))
    ].sort(),
    ["lcm_leaves", "lcm_rollups", "memory_events"]
  );
  assert.deepEqual(
    [...new Set(fixtureThreads.map((thread) => thread.kind))].sort(),
    [
      "dm",
      "group_dm",
      "notes_to_self",
      "personal_channel",
      "shared_session_discussion",
      "workspace_channel"
    ]
  );
  assert.equal(fixtureUsers.dana.disabled, true);
  assert.equal(fixtureUsers.frank.removed, true);
  assert.equal(
    fixtureTeamMemberships.some(([userKey]) => userKey === "frank"),
    false
  );

  assert.ok(
    fixtureMemoryRows.some(
      (memory) => memory.key === "bob-cloud-removed-member"
    )
  );
  assert.ok(
    fixtureWorkspaceAccess.some(
      ([workspace, user, access]) =>
        workspace === "cloud" && user === "bob" && access === "disabled"
    )
  );
});

test("Team SaaS fixture uses the active deployment encryption providers", async () => {
  const runtime = await createFixtureRuntime(
    {},
    {
      environment: {
        API_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 91).toString("base64"),
        OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY: Buffer.alloc(
          32,
          92
        ).toString("base64")
      }
    }
  );

  assert.equal(runtime.teamProvider.mode, "local_test_key");
  assert.equal(runtime.ownerProvider.mode, "local_test_key");
  assert.notEqual(runtime.teamProvider.keyId, runtime.ownerProvider.keyId);
  await assert.rejects(
    createFixtureRuntime(
      {},
      {
        environment: {
          API_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 93).toString("base64")
        }
      }
    ),
    /requires both Team\/general and owner-private/
  );
});

test("Team SaaS fixture can seed and validate a live database", async (t) => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    t.skip("DATABASE_URL is not set");
    return;
  }
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousPepper = process.env.API_TOKEN_PEPPER;
  process.env.NODE_ENV = "test";
  process.env.API_TOKEN_PEPPER = "team-fixture-db-test-pepper";

  const { createRequire } = await import("node:module");
  const { resolve } = await import("node:path");
  const requireFromDbPackage = createRequire(
    resolve("packages/db/package.json")
  );
  const pg = requireFromDbPackage("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const sentinelEventId = "1fffffff-ffff-4fff-8fff-ffffffffffff";
  const staleFixtureEventId = "1eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const hostileCanonicalSecret =
    "HOSTILE_CANONICAL_SECRET_CANARY_must_never_enter_team_representation";
  const originalFixtureShareGrantIds = [...fixtureShareGrantIds];
  await client.connect();
  try {
    const schema = await client.query(
      "select to_regclass('public.semantic_memory_rebuild_jobs') as table_name"
    );
    if (!schema.rows[0]?.table_name) {
      t.skip("Koed database schema is not migrated");
      return;
    }

    const runtime = await createFixtureRuntime(pool);
    await seedFixture(client, runtime);
    const first = await validateFixture(client, runtime);
    assert.equal(first.users, 7);
    assert.equal(first.workspaces, 3);
    assert.equal(first.memories, fixtureMemoryRows.length);
    assert.equal(first.threads, fixtureThreads.length);
    const firstSnapshot = await normalizedFixtureSnapshot(client, runtime);
    const acknowledgedFixtureEvent = await client.query(
      `select id, cursor
       from collaboration_outbox
       where team_id = $1
       order by cursor asc
       limit 1`,
      [fixtureTeam.id]
    );
    assert.ok(acknowledgedFixtureEvent.rows[0]);
    const fixtureSubscriptionId = randomUUID();
    await client.query(
      `insert into collaboration_stream_subscriptions (
         id, backend_identity_hash, principal_id_hash, client_instance_hash,
         subscription_key_hash, protocol_version, scope, team_id, state,
         acknowledged_event_id, acknowledged_cursor, expires_at
       ) values (
         $1, $2, $3, $4, $5, 1, 'team', $6, 'active', $7, $8,
         now() + interval '1 hour'
       )`,
      [
        fixtureSubscriptionId,
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
        fixtureTeam.id,
        acknowledgedFixtureEvent.rows[0].id,
        acknowledgedFixtureEvent.rows[0].cursor
      ]
    );

    const hostileMemory = fixtureMemoryRows.find(
      (memory) => memory.key === "bob-electron-timeline"
    );
    await client.query("update messages set content = $2 where id = $1", [
      hostileMemory.messageId,
      hostileCanonicalSecret
    ]);
    await client.query(
      "update memory_events set payload = jsonb_build_object('secret', $2::text) where id = $1",
      [hostileMemory.eventId, hostileCanonicalSecret]
    );
    await client.query(
      "update memory_nodes set summary_text = $2 where id = $1",
      [hostileMemory.nodeId, hostileCanonicalSecret]
    );
    const afterHostileCanonicalMutation = await validateFixture(
      client,
      runtime
    );
    assert.equal(
      JSON.stringify(afterHostileCanonicalMutation).includes(
        hostileCanonicalSecret
      ),
      false
    );

    await client.query(
      `insert into memory_events (
         id, actor_user_id, owner_user_id, visibility, event_type,
         capture_method, idempotency_key, source_hash, payload
       ) values (
         $1, $2, $2, 'personal', 'captured', 'transcript',
         'review-sentinel-outside-fixture-markers',
         'review-sentinel-outside-fixture-markers',
         '{"sentinel":true}'::jsonb
       )`,
      [sentinelEventId, fixtureUsers.alice.id]
    );
    await client.query(
      `insert into memory_events (
         id, actor_user_id, owner_user_id, visibility, event_type,
         capture_method, idempotency_key, source_hash, payload
       ) values (
         $1, $2, $2, 'personal', 'captured', 'transcript', $3, $3, '{}'
       )`,
      [
        staleFixtureEventId,
        fixtureUsers.alice.id,
        `${FIXTURE_VERSION}:stale-review-row`
      ]
    );

    const highRiskConfirmationId = randomUUID();
    const highRiskActionGrantId = randomUUID();
    const retentionDecisionId = randomUUID();
    const purgeJobId = randomUUID();
    const purgeAttemptId = randomUUID();
    const purgeEvidenceId = randomUUID();
    const fixtureDeviceCredential = await client.query(
      `select id
       from device_credentials
       where credential_key_id = $1`,
      [`${FIXTURE_VERSION}-bob-device`]
    );
    assert.ok(fixtureDeviceCredential.rows[0]?.id);
    await client.query(
      `insert into high_risk_browser_confirmations (
         id, selector, client_request_id, owner_user_id,
         decision_user_session_id, device_credential_id,
         upstream_backend_id, team_id, operation_family, action, target_id,
         scope_hash, request_hash, secret_commitment, approval_tier,
         review_summary, state, expires_at, decision_freshly_authenticated_at,
         decided_at
       ) values (
         $1, $2, $3, $4, $5, $6, 'fixture-backend', $7,
         'share_grant_management', 'fixture.reset', $8,
         $9, $9, $10, 'step_up', $11::jsonb, 'approved',
         now() + interval '5 minutes', now(), now()
       )`,
      [
        highRiskConfirmationId,
        randomUUID(),
        randomUUID(),
        fixtureUsers.bob.id,
        fixtureSessionRows.bob.id,
        fixtureDeviceCredential.rows[0].id,
        fixtureTeam.id,
        randomUUID(),
        "a".repeat(64),
        `v1:${"b".repeat(64)}`,
        JSON.stringify({
          version: 1,
          title: "Reset the Team fixture?",
          description: "Remove deterministic Team fixture records.",
          consequence: "Fixture-owned records will be deleted.",
          confirmLabel: "Reset fixture",
          details: []
        })
      ]
    );
    await client.query(
      `insert into high_risk_device_action_grants (
         id, confirmation_id, device_credential_id, owner_user_id,
         upstream_backend_id, team_id, operation_family, action, target_id,
         scope_hash, request_hash, secret_commitment, expires_at
       ) values (
         $1, $2, $3, $4, 'fixture-backend', $5,
         'share_grant_management', 'fixture.reset', $6,
         $7, $7, $8, now() + interval '1 minute'
       )`,
      [
        highRiskActionGrantId,
        highRiskConfirmationId,
        fixtureDeviceCredential.rows[0].id,
        fixtureUsers.bob.id,
        fixtureTeam.id,
        randomUUID(),
        "c".repeat(64),
        `v1:${"d".repeat(64)}`
      ]
    );
    await client.query(
      `insert into high_risk_action_grant_execution_receipts (
         action_grant_id, owner_user_id, status_code, receipt_body,
         receipt_hash
       ) values ($1, $2, 200, '{}'::jsonb, $3)`,
      [highRiskActionGrantId, fixtureUsers.bob.id, "e".repeat(64)]
    );
    const revokedMemory = fixtureMemoryRows.find(
      (memory) => memory.key === "bob-electron-timeline"
    );
    assert.ok(revokedMemory);
    const omittedGrantIndex = fixtureShareGrantIds.indexOf(
      revokedMemory.shareGrantId
    );
    assert.notEqual(omittedGrantIndex, -1);
    fixtureShareGrantIds.splice(omittedGrantIndex, 1);
    const revocationScope = await client.query(
      `select grant_row.team_workspace_id, grant_row.logical_memory_id,
              policy.policy_id, policy.version, policy.effective_at
         from team_session_share_grants grant_row
         join retention_policies policy
           on policy.team_id = grant_row.team_id
          and policy.scope = 'team'
          and policy.superseded_at is null
        where grant_row.id = $1`,
      [revokedMemory.shareGrantId]
    );
    assert.ok(revocationScope.rows[0]);
    await client.query(
      `insert into retention_decisions (
         id, policy_id, policy_version, target_kind, team_id,
         team_workspace_id, share_grant_id, logical_memory_id, trigger,
         trigger_epoch, policy_effective_at, triggered_at, retain_until,
         eligible, eligibility_reason_code, decision_snapshot_hash
       ) values (
         $1, $2, $3, 'share_grant', $4, $5, $6, $7, 'share_revoked',
         1, $8, now(), now() + interval '30 days', false,
         'retention_period_active', $9
       )`,
      [
        retentionDecisionId,
        revocationScope.rows[0].policy_id,
        revocationScope.rows[0].version,
        fixtureTeam.id,
        revocationScope.rows[0].team_workspace_id,
        revokedMemory.shareGrantId,
        revocationScope.rows[0].logical_memory_id,
        revocationScope.rows[0].effective_at,
        "f".repeat(64)
      ]
    );
    await client.query(
      `insert into purge_jobs (
         id, retention_decision_id, target_kind, target_id, team_id,
         team_workspace_id, share_grant_id, logical_memory_id, state,
         target_epoch, idempotency_key
       ) values (
         $1, $2, 'share_grant', $3, $4, $5, $3, $6, 'pending', 1, $7
       )`,
      [
        purgeJobId,
        retentionDecisionId,
        revokedMemory.shareGrantId,
        fixtureTeam.id,
        revocationScope.rows[0].team_workspace_id,
        revocationScope.rows[0].logical_memory_id,
        `fixture-reset-purge-${purgeJobId}`
      ]
    );
    await client.query(
      `insert into purge_job_attempts (
         id, purge_job_id, attempt_number, state
       ) values ($1, $2, 1, 'running')`,
      [purgeAttemptId, purgeJobId]
    );
    await client.query(
      `insert into purge_job_evidence (
         id, purge_job_id, purge_attempt_id, artifact_kind,
         artifact_locator_hash, state, removed_record_count,
         removed_byte_count
       ) values ($1, $2, $3, 'database_row', $4, 'pending', 0, 0)`,
      [purgeEvidenceId, purgeJobId, purgeAttemptId, "1".repeat(64)]
    );
    await client.query(
      `update team_session_share_grants
          set lifecycle = 'revoked', revoked_at = now(),
              revocation_epoch = 1,
              retention_policy_id = $2,
              retention_policy_version = $3,
              retention_triggered_at = now(),
              retain_until = now() + interval '30 days',
              active_retention_decision_id = $4,
              active_purge_job_id = $5
        where id = $1`,
      [
        revokedMemory.shareGrantId,
        revocationScope.rows[0].policy_id,
        revocationScope.rows[0].version,
        retentionDecisionId,
        purgeJobId
      ]
    );

    await seedFixture(client, runtime);
    fixtureShareGrantIds.splice(
      0,
      fixtureShareGrantIds.length,
      ...originalFixtureShareGrantIds
    );
    const second = await validateFixture(client, runtime);
    const secondSnapshot = await normalizedFixtureSnapshot(client, runtime);
    assert.deepEqual(secondSnapshot, firstSnapshot);
    assert.deepEqual(second.threadIds, first.threadIds);
    const sentinelAfterReseed = await client.query(
      "select owner_user_id from memory_events where id = $1",
      [sentinelEventId]
    );
    assert.equal(
      sentinelAfterReseed.rows[0]?.owner_user_id,
      fixtureUsers.alice.id
    );
    const staleAfterReseed = await client.query(
      "select count(*)::int as count from memory_events where id = $1",
      [staleFixtureEventId]
    );
    assert.equal(staleAfterReseed.rows[0]?.count, 0);
    const fixtureSubscriptionAfterReseed = await client.query(
      "select count(*)::int as count from collaboration_stream_subscriptions where id = $1",
      [fixtureSubscriptionId]
    );
    assert.equal(fixtureSubscriptionAfterReseed.rows[0]?.count, 0);
    const highRiskRowsAfterReseed = await client.query(
      `select
         (select count(*)::int from high_risk_browser_confirmations
          where id = $1) as confirmations,
         (select count(*)::int from high_risk_device_action_grants
          where id = $2) as grants,
         (select count(*)::int from high_risk_action_grant_execution_receipts
          where action_grant_id = $2) as receipts`,
      [highRiskConfirmationId, highRiskActionGrantId]
    );
    assert.deepEqual(highRiskRowsAfterReseed.rows[0], {
      confirmations: 0,
      grants: 0,
      receipts: 0
    });
    const retentionRowsAfterReseed = await client.query(
      `select
         (select count(*)::int from retention_decisions
          where id = $1) as decisions,
         (select count(*)::int from purge_jobs
          where id = $2) as jobs,
         (select count(*)::int from purge_job_attempts
          where id = $3) as attempts,
         (select count(*)::int from purge_job_evidence
          where id = $4) as evidence`,
      [retentionDecisionId, purgeJobId, purgeAttemptId, purgeEvidenceId]
    );
    assert.deepEqual(retentionRowsAfterReseed.rows[0], {
      decisions: 0,
      jobs: 0,
      attempts: 0,
      evidence: 0
    });
    const omittedGrantAfterReseed = await client.query(
      `select lifecycle, active_retention_decision_id, active_purge_job_id
       from team_session_share_grants
       where id = $1`,
      [revokedMemory.shareGrantId]
    );
    assert.deepEqual(omittedGrantAfterReseed.rows[0], {
      lifecycle: "active",
      active_retention_decision_id: null,
      active_purge_job_id: null
    });

    await resetFixture(client);
    const fixtureEventsAfterReset = await client.query(
      "select count(*)::int as count from memory_events where source_hash like $1",
      [`${FIXTURE_VERSION}:%`]
    );
    assert.equal(fixtureEventsAfterReset.rows[0]?.count, 0);
    const sentinelAfterReset = await client.query(
      "select owner_user_id from memory_events where id = $1",
      [sentinelEventId]
    );
    assert.equal(
      sentinelAfterReset.rows[0]?.owner_user_id,
      fixtureUsers.alice.id
    );
  } finally {
    fixtureShareGrantIds.splice(
      0,
      fixtureShareGrantIds.length,
      ...originalFixtureShareGrantIds
    );
    await resetFixture(client).catch(() => {});
    await client
      .query("delete from memory_events where id = any($1::uuid[])", [
        [sentinelEventId, staleFixtureEventId]
      ])
      .catch(() => {});
    await client
      .query("delete from teams where id = $1", [fixtureTeam.id])
      .catch(() => {});
    await client
      .query("delete from users where id = any($1::uuid[])", [fixtureUserIds])
      .catch(() => {});
    await client.end();
    await pool.end();
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
    if (previousPepper === undefined) delete process.env.API_TOKEN_PEPPER;
    else process.env.API_TOKEN_PEPPER = previousPepper;
  }
});

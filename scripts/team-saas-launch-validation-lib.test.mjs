import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLaunchEmbeddingReadiness,
  assertSeparateLaunchTestDatabase,
  assertLaunchValidationEnvironment,
  automatedLaunchTestCommands,
  buildAutomatedLaunchTestEnvironment,
  formatLaunchValidationReport,
  launchValidationGates,
  provisionAutomatedLaunchTestDatabase,
  runAutomatedLaunchTests,
  runStagedRemoteValidation,
  summarizeLaunchValidation
} from "./team-saas-launch-validation-lib.mjs";
import { fixtureMemoryRows } from "./team-saas-fixture-lib.mjs";

test("launch validation requires API_TOKEN_PEPPER for Auth gate coverage", () => {
  assert.doesNotThrow(() =>
    assertLaunchValidationEnvironment({ API_TOKEN_PEPPER: "pepper" })
  );
  assert.throws(
    () => assertLaunchValidationEnvironment({ API_TOKEN_PEPPER: "" }),
    /API_TOKEN_PEPPER is required/
  );
  assert.throws(
    () => assertLaunchValidationEnvironment({}),
    /API_TOKEN_PEPPER is required/
  );
});

const completedEmbeddingRow = (memory) => ({
  semantic_item_id: `${memory.representationId}:semantic`,
  representation_id: memory.representationId,
  item_type: {
    memory_events: "user_message",
    lcm_leaves: "lcm_leaf",
    lcm_rollups: "lcm_rollup",
    curated_assertions: "curated_assertion"
  }[memory.representation],
  embedding_state: "embedded",
  embedding_model: "qwen3-0.6b",
  embedding_dimensions: 1024,
  embedding_version: "fixture-model-v1",
  embedding_input_hash: "a".repeat(64),
  embedded_at: new Date("2026-01-01T09:00:00.000Z"),
  last_error_class: null,
  has_vector: true
});

test("launch embedding readiness requires completed vectors for all four Team representations", async () => {
  const visibleMemories = fixtureMemoryRows.filter(
    (memory) => memory.expectedTeamVisible
  );
  const client = {
    async query(sql, [representationIds]) {
      for (const dimensions of [384, 1024, 1536, 3072]) {
        assert.match(
          sql,
          new RegExp(`team_memory_semantic_vectors_${dimensions}`)
        );
      }
      assert.deepEqual(
        representationIds,
        visibleMemories.map((memory) => memory.representationId)
      );
      return { rows: visibleMemories.map(completedEmbeddingRow) };
    }
  };

  const proof = await assertLaunchEmbeddingReadiness(client);
  assert.equal(proof.embeddedItems, visibleMemories.length);
  assert.deepEqual(proof.representations, [
    "memory_events",
    "lcm_leaves",
    "lcm_rollups",
    "curated_assertions"
  ]);
});

test("launch embedding readiness rejects pending and processing items", async () => {
  const visibleMemories = fixtureMemoryRows.filter(
    (memory) => memory.expectedTeamVisible
  );
  for (const embeddingState of ["pending", "processing"]) {
    const rows = visibleMemories.map(completedEmbeddingRow);
    rows[0] = {
      ...rows[0],
      embedding_state: embeddingState,
      embedded_at: null,
      has_vector: false
    };
    await assert.rejects(
      () =>
        assertLaunchEmbeddingReadiness({
          async query() {
            return { rows };
          }
        }),
      new RegExp(`requires a completed embedding, got ${embeddingState}`)
    );
  }
});

test("launch embedding readiness rejects embedded metadata without a stored vector", async () => {
  const visibleMemories = fixtureMemoryRows.filter(
    (memory) => memory.expectedTeamVisible
  );
  const rows = visibleMemories.map(completedEmbeddingRow);
  rows[0] = { ...rows[0], has_vector: false };

  await assert.rejects(
    () =>
      assertLaunchEmbeddingReadiness({
        async query() {
          return { rows };
        }
      }),
    /missing its vector or model provenance/
  );
});

test("automated launch commands select only their intended test files", () => {
  const migrationCommand = automatedLaunchTestCommands.find(
    (command) => command.id === "migration-acceptance"
  );
  const requiredSuitesCommand = automatedLaunchTestCommands.find(
    (command) => command.id === "required-collaboration-suites"
  );
  const pdsFixtureCommand = automatedLaunchTestCommands.find(
    (command) => command.id === "personal-device-sync-fixture"
  );
  const dbCommand = automatedLaunchTestCommands.find(
    (command) => command.id === "db-encrypted-tenant-boundaries"
  );
  const apiCommand = automatedLaunchTestCommands.find(
    (command) => command.id === "api-auth-runtime-boundaries"
  );
  const desktopCommand = automatedLaunchTestCommands.find(
    (command) => command.id === "desktop-electron-interactions"
  );

  assert.deepEqual(migrationCommand?.args, ["db:migrate:acceptance"]);
  assert.deepEqual(requiredSuitesCommand?.args, ["test:required-suites"]);
  assert.deepEqual(pdsFixtureCommand?.args, ["pds-fixture:validate"]);

  assert.deepEqual(dbCommand?.args.slice(0, 5), [
    "--filter",
    "@koed/db",
    "exec",
    "vitest",
    "run"
  ]);
  assert.ok(dbCommand?.args.includes("tests/repository.test.ts"));
  assert.ok(dbCommand?.args.includes("--testNamePattern"));
  assert.ok(!dbCommand?.args.includes("--"));

  assert.deepEqual(apiCommand?.args.slice(0, 5), [
    "--filter",
    "@koed/api",
    "exec",
    "vitest",
    "run"
  ]);
  assert.ok(apiCommand?.args.includes("src/server.test.ts"));
  assert.ok(apiCommand?.args.includes("--testNamePattern"));
  assert.ok(
    apiCommand?.args.some((arg) =>
      arg.includes("encrypted Memory Event companions")
    )
  );
  assert.ok(!apiCommand?.args.includes("--"));
  assert.deepEqual(desktopCommand?.args, [
    "--filter",
    "@koed/desktop",
    "test:browser"
  ]);
});

test("automated launch tests remove inherited deployment secrets and profiles", () => {
  const parent = {
    PATH: "/usr/bin",
    DATABASE_URL: "postgres://fixture",
    API_TOKEN_PEPPER: "production-pepper",
    SESSION_SECRET: "production-session-secret",
    KOED_LAUNCH_SESSION_COOKIE: "production-session-cookie",
    KOED_LAUNCH_DEVICE_CREDENTIAL: "production-device-credential",
    KOED_DEPLOYMENT_PROFILE: "team_self_hosted",
    KOED_MANAGED_CLOUD_RELEASE_STAGE: "paid",
    KOED_TEAM_COLLABORATION_ENABLED: "true",
    NODE_ENV: "production",
    API_ENVELOPE_ENCRYPTION_PROVIDER: "local_test_key",
    API_DATA_ENCRYPTION_KEY: "do-not-inherit",
    MANAGED_KMS_AUTH_TOKEN: "do-not-inherit",
    OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY: "do-not-inherit",
    OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER: "local_test_key",
    OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN: "do-not-inherit",
    WORKOS_API_KEY: "do-not-inherit"
  };
  const child = buildAutomatedLaunchTestEnvironment(parent, {
    API_TOKEN_PEPPER: "synthetic-pepper",
    DATABASE_URL: "postgres://scratch",
    NODE_ENV: "test",
    SESSION_SECRET: "synthetic-session-secret"
  });

  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.API_TOKEN_PEPPER, "synthetic-pepper");
  assert.equal(child.SESSION_SECRET, "synthetic-session-secret");
  assert.equal(child.DATABASE_URL, "postgres://scratch");
  assert.equal(child.NODE_ENV, "test");
  assert.equal(child.KOED_DEPLOYMENT_PROFILE, undefined);
  assert.equal(child.KOED_MANAGED_CLOUD_RELEASE_STAGE, undefined);
  assert.equal(child.KOED_TEAM_COLLABORATION_ENABLED, undefined);
  assert.equal(child.API_ENVELOPE_ENCRYPTION_PROVIDER, undefined);
  assert.equal(child.API_DATA_ENCRYPTION_KEY, undefined);
  assert.equal(child.MANAGED_KMS_AUTH_TOKEN, undefined);
  assert.equal(child.OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY, undefined);
  assert.equal(
    child.OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER,
    undefined
  );
  assert.equal(child.OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN, undefined);
  assert.equal(child.WORKOS_API_KEY, undefined);
  assert.equal(child.KOED_LAUNCH_SESSION_COOKIE, undefined);
  assert.equal(child.KOED_LAUNCH_DEVICE_CREDENTIAL, undefined);
  assert.equal(parent.API_TOKEN_PEPPER, "production-pepper");
  assert.equal(parent.NODE_ENV, "production");
  assert.equal(parent.KOED_DEPLOYMENT_PROFILE, "team_self_hosted");
});

test("automated launch test failures identify the failing gate", () => {
  const calls = [];
  assert.throws(
    () =>
      runAutomatedLaunchTests({
        commands: [
          { id: "first-gate", command: "first", args: ["test"] },
          { id: "second-gate", command: "second", args: ["test"] }
        ],
        cwd: "/repo",
        environment: {
          PATH: "/usr/bin",
          KOED_DEPLOYMENT_PROFILE: "team_self_hosted"
        },
        environmentOverrides: { DATABASE_URL: "postgres://scratch" },
        spawn(command, args, options) {
          calls.push({ command, args, options });
          return { status: 7 };
        }
      }),
    /Automated launch test command failed: first-gate \(exit 7\)/
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.KOED_DEPLOYMENT_PROFILE, undefined);
  assert.equal(calls[0].options.env.DATABASE_URL, "postgres://scratch");
});

test("launch validation refuses to use the fixture database for destructive tests", () => {
  assert.throws(
    () =>
      assertSeparateLaunchTestDatabase(
        "postgres://koed:secret@postgres:5432/koed",
        "postgresql://other:secret@postgres/koed?sslmode=require"
      ),
    /must not target the fixture database/
  );
  assert.doesNotThrow(() =>
    assertSeparateLaunchTestDatabase(
      "postgres://koed:secret@postgres:5432/koed",
      "postgres://koed:secret@separate-cluster:5432/koed"
    )
  );
  assert.doesNotThrow(() =>
    assertSeparateLaunchTestDatabase(
      "postgres://koed:secret@postgres:5432/koed",
      "postgres://koed:secret@postgres:5432/koed_launch_test"
    )
  );
});

const databaseIdentityClientFactory =
  (identityForUrl, clients) => (connectionString) => {
    const client = {
      connectionString,
      ends: 0,
      async connect() {},
      async query() {
        return { rows: [identityForUrl(connectionString)] };
      },
      async end() {
        this.ends += 1;
      }
    };
    clients.push(client);
    return client;
  };

test("launch validation rejects database aliases resolving to the fixture", async () => {
  const clients = [];
  const createClient = databaseIdentityClientFactory(
    () => ({
      database_name: "koed",
      server_address: "10.0.0.12",
      server_port: 5432
    }),
    clients
  );

  await assert.rejects(
    () =>
      provisionAutomatedLaunchTestDatabase({
        fixtureDatabaseUrl: "postgres://koed:secret@postgres:5432/koed",
        explicitTestDatabaseUrl:
          "postgres://koed:secret@database-alias:5432/koed",
        createClient
      }),
    /resolves to the fixture database/
  );
  assert.equal(clients.length, 2);
  assert.ok(clients.every((client) => client.ends === 1));
});

test("launch validation allows the same database name on a separate server", async () => {
  const clients = [];
  const createClient = databaseIdentityClientFactory(
    (connectionString) => ({
      database_name: "koed",
      server_address: connectionString.includes("separate-cluster")
        ? "10.0.1.20"
        : "10.0.0.12",
      server_port: 5432
    }),
    clients
  );
  const explicitTestDatabaseUrl =
    "postgres://koed:secret@separate-cluster:5432/koed";

  const provisioned = await provisionAutomatedLaunchTestDatabase({
    fixtureDatabaseUrl: "postgres://koed:secret@postgres:5432/koed",
    explicitTestDatabaseUrl,
    createClient
  });
  assert.equal(provisioned.databaseUrl, explicitTestDatabaseUrl);
  assert.equal(provisioned.managed, false);
  assert.equal(clients.length, 2);
  assert.ok(clients.every((client) => client.ends === 1));
});

test("launch validation provisions and cleans up a disposable test database", async () => {
  const clients = [];
  const createClient = (connectionString) => {
    const client = {
      connectionString,
      queries: [],
      connects: 0,
      ends: 0,
      async connect() {
        this.connects += 1;
      },
      async query(...args) {
        this.queries.push(args);
      },
      async end() {
        this.ends += 1;
      }
    };
    clients.push(client);
    return client;
  };

  const provisioned = await provisionAutomatedLaunchTestDatabase({
    fixtureDatabaseUrl: "postgres://koed:secret@postgres:5432/koed",
    createClient,
    uniqueId: "A1-B2-C3"
  });
  assert.equal(provisioned.managed, true);
  assert.equal(
    provisioned.databaseUrl,
    "postgres://koed:secret@postgres:5432/koed_launch_a1b2c3"
  );
  assert.match(clients[0].queries[0][0], /create database/);
  await provisioned.cleanup();
  await provisioned.cleanup();
  assert.equal(clients.length, 2);
  assert.match(clients[1].queries[0][0], /pg_terminate_backend/);
  assert.match(clients[1].queries[1][0], /drop database/);
});

test("launch validation gates cover Team SaaS critical path areas", () => {
  const criteria = launchValidationGates.map((gate) => gate.launchCriterion);
  const descriptions = launchValidationGates.map((gate) => gate.description);

  assert.ok(criteria.some((criterion) => criterion.includes("signs up")));
  assert.ok(criteria.some((criterion) => criterion.includes("Team")));
  assert.ok(criteria.some((criterion) => criterion.includes("Workspace")));
  assert.ok(criteria.some((criterion) => criterion.includes("shared")));
  assert.ok(criteria.some((criterion) => criterion.includes("Unauthorized")));
  assert.ok(criteria.some((criterion) => criterion.includes("Member removal")));
  assert.ok(
    criteria.some((criterion) => criterion.includes("Personal deletion"))
  );
  assert.ok(criteria.some((criterion) => criterion.includes("Billing")));
  assert.ok(criteria.some((criterion) => criterion.includes("observability")));
  assert.ok(criteria.some((criterion) => criterion.includes("Backups")));
  assert.ok(criteria.some((criterion) => criterion.includes("capacity")));
  assert.ok(criteria.some((criterion) => criterion.includes("API-token")));
  assert.ok(criteria.some((criterion) => criterion.includes("Local edge")));
  assert.ok(criteria.some((criterion) => criterion.includes("Share Grants")));
  assert.ok(criteria.some((criterion) => criterion.includes("Encrypted")));
  assert.ok(criteria.some((criterion) => criterion.includes("identity")));
  assert.ok(
    descriptions.some((description) =>
      description.includes("Capability discovery")
    )
  );
  assert.ok(
    descriptions.some((description) =>
      description.includes("Encrypted Team fixture")
    )
  );
  assert.ok(
    descriptions.some((description) =>
      description.includes("Unauthorized memory is excluded")
    )
  );
  assert.ok(
    descriptions.some(
      (description) =>
        description.includes("Memory Event") &&
        description.includes("LCM leaf") &&
        description.includes("LCM rollup") &&
        description.includes("Curated Memory") &&
        description.includes("completed vector-backed embedding")
    )
  );
  assert.ok(
    automatedLaunchTestCommands.some(
      (command) => command.id === "db-encrypted-tenant-boundaries"
    )
  );
  assert.ok(
    automatedLaunchTestCommands.some(
      (command) => command.id === "api-auth-runtime-boundaries"
    )
  );
  assert.ok(
    automatedLaunchTestCommands.some(
      (command) => command.id === "team-conversation-source-boundaries"
    )
  );
  assert.ok(
    automatedLaunchTestCommands.some(
      (command) => command.id === "agentic-retrieval-team-boundaries"
    )
  );
});

test("launch validation report separates automated and manual gates", () => {
  const summary = summarizeLaunchValidation({
    memories: 13,
    checks: ["Fixture access check"]
  });
  const report = formatLaunchValidationReport(summary);

  assert.equal(summary.byMode.automated, 15);
  assert.equal(summary.byMode.manual, 3);
  assert.equal(summary.byMode.staging, 4);
  assert.equal(summary.automatedTestStatus, "not_run");
  assert.match(report, /Automated launch gates:/);
  assert.match(report, /Automated repository test gates: not_run/);
  assert.match(report, /db-encrypted-tenant-boundaries/);
  assert.match(report, /Manual launch gates:/);
  assert.match(report, /Staging launch gates:/);
  assert.match(
    report,
    /Remote Shared Memory semantic evidence respects session/
  );
  assert.match(report, /Encrypted Team fixture cases prove/);
  assert.match(report, /Independent Conversation Source Access grants/);
  assert.match(report, /Capability discovery and diagnostics/);
  assert.match(report, /without refresh or polling/);
  assert.match(report, /Any failed launch blocker/);
});

test("launch validation report includes completed multi-device Electron proof", () => {
  const summary = summarizeLaunchValidation(
    { memories: 1, checks: [] },
    {
      multiDevice: {
        backendId: "team-vps",
        flows: {
          aToB: { eventType: "update" },
          bToA: { eventType: "update" },
          channelBToA: { eventType: "update" },
          rendererReloadCatchUp: { recovered: true }
        }
      }
    }
  );

  const report = formatLaunchValidationReport(summary);
  assert.match(report, /Multi-device Electron dogfood: passed \(team-vps\)/);
  assert.match(report, /Notes A to B: update/);
  assert.match(report, /Personal channel B to A: update/);
  assert.match(report, /Renderer reload catch-up: passed/);
});

test("launch validation report omits staged URLs and internal identifiers", () => {
  const privateUrl = "https://private-vps.example.test/internal";
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const report = formatLaunchValidationReport({
    fixture: "fixture-v1",
    users: 2,
    workspaces: 1,
    memories: 1,
    gates: 1,
    byMode: { automated: 1, manual: 0, staging: 0 },
    automatedChecks: ["content-safe check"],
    automatedTestStatus: "passed",
    automatedTestCommands: [],
    stagedRemote: {
      baseUrl: privateUrl,
      teamWorkspaceId: workspaceId,
      probes: [
        { name: "allowed-probe", status: 200, ok: true },
        { name: "optional-probe", status: "skipped", ok: true }
      ]
    }
  });

  assert.doesNotMatch(report, /private-vps/);
  assert.doesNotMatch(report, new RegExp(workspaceId));
  assert.match(report, /1 completed, 1 skipped/);
  assert.match(report, /allowed-probe: 200/);
});

test("staged remote validation requires explicit route credentials", async () => {
  await assert.rejects(
    () => runStagedRemoteValidation({ baseUrl: "http://localhost:3300" }),
    /requires .*session-cookie.*device-credential/
  );
});

test("staged remote validation exercises Team semantic evidence and keeps graph/API Tokens closed", async () => {
  const calls = [];
  const result = await runStagedRemoteValidation(
    {
      baseUrl: "http://hosted.local/",
      browserOrigin: "https://app.hosted.local/path",
      sessionCookie: "cm_session=session-secret",
      deviceCredential: "device-key:secret",
      apiToken: "koed_test",
      teamWorkspaceId: "30000000-0000-4000-8000-000000000001",
      teamNodeId: "60000000-0000-4000-8000-000000000001",
      localEdgeBaseUrl: "http://edge.local/",
      localEdgeBackendId: "team-vps"
    },
    async (url, init) => {
      calls.push({ url, init });
      if (url === "http://hosted.local/v1/capabilities") {
        return new Response(
          JSON.stringify({
            deployment: { profile: "team_self_hosted" }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url === "http://hosted.local/openapi.json") {
        return new Response(
          JSON.stringify({
            paths: {
              "/v1/collaboration/teams/{teamId}/threads": {
                get: {
                  security: [{ deviceCredential: [] }, { sessionCookie: [] }],
                  "x-koed-identity": "session_or_device_credential",
                  "x-koed-domain": "collaboration",
                  "x-koed-team-authority": "request_time_team_membership",
                  "x-koed-deployment-modes": ["team_self_hosted"]
                }
              },
              "/v1/shared-memory/share-grants/{shareGrantId}/revoke": {
                post: {
                  security: [{ deviceCredential: [] }, { sessionCookie: [] }],
                  "x-koed-identity": "session_or_device_credential",
                  "x-koed-domain": "shared_memory",
                  "x-koed-team-authority": "request_time_shared_memory_owner",
                  "x-koed-deployment-modes": ["team_self_hosted"]
                }
              },
              "/v1/memory/answer": {
                post: {
                  security: [{ bearerApiToken: [] }],
                  "x-koed-identity": "conditional_team_session_or_device",
                  "x-koed-domain": "personal_memory",
                  "x-koed-team-authority": "request_time_team_workspace",
                  "x-koed-deployment-modes": ["team_self_hosted"]
                }
              },
              "/v1/local-edge/team-memory/answer": {
                post: {
                  security: [{ localEdgeClientCredential: [] }],
                  "x-koed-identity": "local_edge_client_credential",
                  "x-koed-domain": "future_remote",
                  "x-koed-team-authority": "future_request_time",
                  "x-koed-deployment-modes": ["developer", "local_personal"]
                }
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (init?.headers?.authorization === "Bearer koed_test") {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/v1/memory/graph/")) {
        return new Response(JSON.stringify({ error: "not available" }), {
          status: 404,
          headers: { "content-type": "application/json" }
        });
      }
      if (
        url === "http://hosted.local/v1/memory/answer" ||
        url === "http://hosted.local/v1/memory/search"
      ) {
        return new Response(
          JSON.stringify({
            hits: [],
            retrieval: {
              retrievalMode: "semantic_vector",
              stages: [
                { name: "rollup_search", ran: true },
                { name: "scoped_leaf_search", ran: true },
                { name: "fresh_pending_search", ran: true }
              ]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (
        url.includes("/v1/memory/nodes/") &&
        url.includes("/expand?team_workspace_id=")
      ) {
        return new Response(
          JSON.stringify({ nodeId: "candidate", sourceItems: [] }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      if (url === "http://edge.local/v1/local-edge/team-memory/answer") {
        return new Response(
          JSON.stringify({ ok: true, retrieval: { stages: [] } }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      if (url.includes("/v1/shared-memory/teams/") && url.includes("/items?")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                itemType: "user_message",
                sourceId: "shared-source-id",
                sourceRevision: 1
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true, shareGrants: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  );

  assert.equal(result.baseUrl, "http://hosted.local");
  assert.equal(result.localEdgeBaseUrl, "http://edge.local");
  assert.ok(
    result.probes.some(
      (probe) => probe.name === "api-token-team-answer-rejected"
    )
  );
  assert.ok(
    result.probes.some(
      (probe) => probe.name === "api-token-team-graph-rejected"
    )
  );
  assert.ok(
    result.probes.some(
      (probe) =>
        probe.name ===
        "api-token-denied:GET:/v1/collaboration/teams/{teamId}/threads"
    )
  );
  assert.ok(
    result.probes.some(
      (probe) =>
        probe.name ===
        "api-token-denied:POST:/v1/shared-memory/share-grants/{shareGrantId}/revoke"
    )
  );
  assert.equal(
    result.probes.some(
      (probe) =>
        probe.name === "api-token-denied:POST:/v1/local-edge/team-memory/answer"
    ),
    false
  );
  assert.ok(
    result.probes.some((probe) => probe.name === "public-capabilities")
  );
  assert.ok(
    result.probes.some(
      (probe) => probe.name === "session-authenticated-capabilities"
    )
  );
  assert.ok(
    result.probes.some(
      (probe) => probe.name === "device-shared-memory-grant-list"
    )
  );
  assert.ok(
    result.probes.some(
      (probe) => probe.name === "session-shared-memory-representation-timeline"
    )
  );
  assert.ok(
    result.probes.some(
      (probe) => probe.name === "device-shared-memory-representation-detail"
    )
  );
  assert.ok(
    result.probes.some(
      (probe) => probe.name === "local-edge-team-semantic-answer"
    )
  );
  const semanticTeamProbes = result.probes.filter((probe) =>
    /team-semantic|team-node-expand|local-edge-team-semantic/.test(probe.name)
  );
  assert.ok(semanticTeamProbes.length >= 7);
  assert.ok(semanticTeamProbes.every((probe) => probe.status === 200));
  const graphProbes = result.probes.filter((probe) =>
    /team-graph|team-node-detail/.test(probe.name)
  );
  assert.ok(
    graphProbes.every((probe) => probe.status === 404 || probe.status === 403)
  );
  assert.ok(
    calls.some((call) => call.url === "http://hosted.local/v1/capabilities")
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === "http://hosted.local/v1/capabilities/authenticated" &&
        call.init.headers.cookie === "cm_session=session-secret" &&
        call.init.headers.origin === "https://app.hosted.local" &&
        call.init.headers["sec-fetch-site"] === "same-origin"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url.includes(
          "/v1/shared-memory/teams/20000000-0000-4000-8000-000000000001/workspaces/30000000-0000-4000-8000-000000000001/share-grants?"
        ) && call.init.headers.cookie === "cm_session=session-secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url ===
          "http://hosted.local/v1/memory/graph/events?teamWorkspaceId=30000000-0000-4000-8000-000000000001" &&
        call.init.headers.authorization === "Bearer koed_test"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url.includes("/items/shared-source-id?") &&
        call.init.headers.cookie === "cm_session=session-secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url.includes("/items?representation=memory_events") &&
        call.init.headers.authorization === "Koed-Device device-key:secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === "http://hosted.local/v1/memory/search" &&
        call.init.headers.authorization === "Koed-Device device-key:secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url ===
          "http://hosted.local/v1/memory/nodes/60000000-0000-4000-8000-000000000001/expand?team_workspace_id=30000000-0000-4000-8000-000000000001" &&
        call.init.headers.cookie === "cm_session=session-secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === "http://edge.local/v1/local-edge/team-memory/answer" &&
        JSON.parse(call.init.body).upstream_backend_id === "team-vps"
    )
  );
});

test("staged remote validation fails if a remote response leaks route credentials", async () => {
  await assert.rejects(
    () =>
      runStagedRemoteValidation(
        {
          baseUrl: "http://hosted.local/",
          sessionCookie: "cm_session=session-secret",
          deviceCredential: "device-key:secret",
          apiToken: "koed_test",
          teamWorkspaceId: "30000000-0000-4000-8000-000000000001"
        },
        async () =>
          new Response(
            JSON.stringify({ echoed: "cm_session=session-secret" }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
      ),
    /leaked staged credential sentinel/
  );
});

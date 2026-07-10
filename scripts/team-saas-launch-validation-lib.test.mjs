import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("automated launch commands select only their intended test files", () => {
  const dbCommand = automatedLaunchTestCommands.find(
    (command) => command.id === "db-encrypted-tenant-boundaries"
  );
  const apiCommand = automatedLaunchTestCommands.find(
    (command) => command.id === "api-auth-runtime-boundaries"
  );

  assert.deepEqual(dbCommand?.args.slice(0, 6), [
    "--filter",
    "@koed/db",
    "exec",
    "vitest",
    "run",
    "--passWithNoTests"
  ]);
  assert.ok(dbCommand?.args.includes("tests/repository.test.ts"));
  assert.ok(dbCommand?.args.includes("--testNamePattern"));
  assert.ok(!dbCommand?.args.includes("--"));

  assert.deepEqual(apiCommand?.args.slice(0, 6), [
    "--filter",
    "@koed/api",
    "exec",
    "vitest",
    "run",
    "--passWithNoTests"
  ]);
  assert.ok(apiCommand?.args.includes("src/server.test.ts"));
  assert.ok(apiCommand?.args.includes("--testNamePattern"));
  assert.ok(
    apiCommand?.args.some((arg) =>
      arg.includes("encrypted Memory Event companions")
    )
  );
  assert.ok(!apiCommand?.args.includes("--"));
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
    NODE_ENV: "production",
    API_ENVELOPE_ENCRYPTION_PROVIDER: "local_test_key",
    API_DATA_ENCRYPTION_KEY: "do-not-inherit",
    MANAGED_KMS_AUTH_TOKEN: "do-not-inherit",
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
  assert.equal(child.API_ENVELOPE_ENCRYPTION_PROVIDER, undefined);
  assert.equal(child.API_DATA_ENCRYPTION_KEY, undefined);
  assert.equal(child.MANAGED_KMS_AUTH_TOKEN, undefined);
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
    automatedLaunchTestCommands.some(
      (command) => command.id === "db-encrypted-tenant-boundaries"
    )
  );
  assert.ok(
    automatedLaunchTestCommands.some(
      (command) => command.id === "api-auth-runtime-boundaries"
    )
  );
});

test("launch validation report separates automated and manual gates", () => {
  const summary = summarizeLaunchValidation({
    memories: 13,
    checks: ["Fixture access check"]
  });
  const report = formatLaunchValidationReport(summary);

  assert.equal(summary.byMode.automated, 12);
  assert.equal(summary.byMode.manual, 3);
  assert.equal(summary.byMode.staging, 4);
  assert.equal(summary.automatedTestStatus, "not_run");
  assert.match(report, /Automated launch gates:/);
  assert.match(report, /Automated repository test gates: not_run/);
  assert.match(report, /db-encrypted-tenant-boundaries/);
  assert.match(report, /Manual launch gates:/);
  assert.match(report, /Staging launch gates:/);
  assert.match(report, /Remote Team recall respects session/);
  assert.match(report, /Encrypted Team fixture cases prove/);
  assert.match(report, /Capability discovery and diagnostics/);
  assert.match(report, /Any failed launch blocker/);
});

test("staged remote validation requires explicit route credentials", async () => {
  await assert.rejects(
    () => runStagedRemoteValidation({ baseUrl: "http://localhost:3300" }),
    /requires .*session-cookie.*device-credential/
  );
});

test("staged remote validation probes Team routes and local-edge proxy", async () => {
  const calls = [];
  const result = await runStagedRemoteValidation(
    {
      baseUrl: "http://hosted.local/",
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
      const status =
        init?.headers?.authorization === "Bearer koed_test" ? 403 : 200;
      return new Response(JSON.stringify({ ok: true, nodes: [] }), {
        status,
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
    result.probes.some((probe) => probe.name === "public-capabilities")
  );
  assert.ok(
    result.probes.some(
      (probe) => probe.name === "session-authenticated-capabilities"
    )
  );
  assert.ok(result.probes.some((probe) => probe.name === "device-team-search"));
  assert.ok(
    result.probes.some((probe) => probe.name === "session-team-graph-events")
  );
  assert.ok(
    result.probes.some((probe) => probe.name === "session-team-node-expand")
  );
  assert.ok(
    result.probes.some((probe) => probe.name === "local-edge-team-answer-proxy")
  );
  assert.ok(
    calls.some((call) => call.url === "http://hosted.local/v1/capabilities")
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === "http://hosted.local/v1/capabilities/authenticated" &&
        call.init.headers.cookie === "cm_session=session-secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === "http://hosted.local/v1/memory/answer" &&
        call.init.headers.cookie === "cm_session=session-secret"
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
        call.url ===
          "http://hosted.local/v1/memory/graph/events?teamWorkspaceId=30000000-0000-4000-8000-000000000001" &&
        call.init.headers.cookie === "cm_session=session-secret"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === "http://hosted.local/v1/memory/answer" &&
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
        call.url === "http://edge.local/v1/local-edge/upstream-operations" &&
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

import { randomUUID } from "node:crypto";
import {
  FIXTURE_VERSION,
  fixtureTeam,
  fixtureMemoryRows,
  fixtureUsers,
  fixtureWorkspaces,
  validateFixture
} from "./team-saas-fixture-lib.mjs";

export const launchValidationGates = [
  {
    id: "auth-fixture-sessions",
    area: "Auth",
    mode: "automated",
    description:
      "Synthetic users can authenticate through deterministic fixture sessions when API_TOKEN_PEPPER is configured.",
    launchCriterion: "User signs up or signs in."
  },
  {
    id: "team-workspace-data-shape",
    area: "Team and Workspace",
    mode: "automated",
    description:
      "The fixture contains one Team, three Workspaces, accepted memberships, and Workspace access grants.",
    launchCriterion: "User creates or joins a Team and Workspace."
  },
  {
    id: "shared-session-recall",
    area: "Shared Memory",
    mode: "automated",
    description:
      "Authorized Workspace members can list Share Grants and read representation timeline/detail items without reading canonical owner-private rows.",
    launchCriterion:
      "Captured Session is shared to a Workspace and represented to another authorized member."
  },
  {
    id: "revoked-private-access",
    area: "Access control",
    mode: "automated",
    description:
      "Revoked shares and private memories are excluded from Shared Memory grant and representation reads.",
    launchCriterion: "Unauthorized user cannot access hidden memory."
  },
  {
    id: "removed-member-retention",
    area: "Retention",
    mode: "automated",
    description:
      "A removed Workspace member loses access while their previously shared Team knowledge remains visible to authorized members.",
    launchCriterion:
      "Member removal stops access but retained Team knowledge remains."
  },
  {
    id: "personal-deletion-retention",
    area: "Retention",
    mode: "automated",
    description:
      "Personal soft-deletion does not remove retained Shared Memory representations from authorized Workspace reads.",
    launchCriterion:
      "Personal deletion and Team-retained representation access."
  },
  {
    id: "team-route-auth-boundaries",
    area: "Remote Team routing",
    mode: "automated",
    description:
      "Dedicated Shared Memory grant/list/timeline/detail routes require browser sessions or scoped device credentials; generic Team search, answer, graph, evidence, and expansion remain unavailable and fail closed.",
    launchCriterion:
      "Remote Shared Memory representations respect session, device, API-token, and unavailable-surface contracts."
  },
  {
    id: "local-edge-fail-closed",
    area: "Remote Team routing",
    mode: "automated",
    description:
      "Local-edge upstream operations fail closed for stale credentials, stale capabilities, disabled route policy, and disabled/private/paused Capture Policy.",
    launchCriterion:
      "Local edge cannot reconfigure MCP/Capture Hooks or write upstream capture without current policy, capabilities, and device authorization."
  },
  {
    id: "candidate-evidence-boundaries",
    area: "Access control",
    mode: "automated",
    description:
      "Unauthorized memory is excluded from Shared Memory grant listing and representation timeline/detail reads before decrypt or display.",
    launchCriterion:
      "Revoked Workspace Access, revoked Share Grants, and private memory are absent from Shared Memory representations."
  },
  {
    id: "encrypted-fixture-boundaries",
    area: "Encryption",
    mode: "automated",
    description:
      "Encrypted Team fixture cases prove shared, private, revoked, removed-member, suspended-entitlement, queue, audit, and embedding-source boundaries before decrypt or diagnostics exposure.",
    launchCriterion:
      "Encrypted Memory is decrypted only after authorization, and raw Memory is absent from storage companions, queues, audit metadata, request logs, and diagnostics."
  },
  {
    id: "workos-user-mapping-boundary",
    area: "Auth",
    mode: "automated",
    description:
      "WorkOS/AuthKit is only an identity provider; mapped Koed Users still pass normal Team membership, Workspace Access, Share Grant, and entitlement authorization.",
    launchCriterion: "External identity cannot bypass Koed Team authorization."
  },
  {
    id: "capability-diagnostics-redaction",
    area: "Operations",
    mode: "automated",
    description:
      "Capability discovery, hook environment, route diagnostics, request logs, and status endpoints redact secrets, raw Memory, and local-only paths.",
    launchCriterion:
      "Capability discovery and diagnostics are useful without leaking sensitive data."
  },
  {
    id: "electron-cloud-connection",
    area: "Electron",
    mode: "manual",
    description:
      "Run Electron against the target backend, confirm capability discovery, connection status, and account context.",
    launchCriterion: "Electron app connects to cloud backend."
  },
  {
    id: "multi-device-personal-realtime",
    area: "Electron",
    mode: "automated",
    description:
      "Two enrolled Electron devices share remote Personal Notes and channels through durable sends and unsolicited realtime updates.",
    launchCriterion:
      "Personal messages and channel creation move in both directions without refresh or polling."
  },
  {
    id: "guided-client-setup",
    area: "Electron",
    mode: "manual",
    description:
      "Walk through MCP Server and Supported Capture Hook setup from the app and confirm Codex can call memory_answer.",
    launchCriterion:
      "MCP and Supported Capture Hook setup are guided from the app."
  },
  {
    id: "capture-to-recall-flow",
    area: "End-to-end",
    mode: "manual",
    description:
      "Capture a real session, share it to a Workspace, then list and inspect its Shared Memory representation as another member.",
    launchCriterion:
      "User captures, shares, lists, and inspects a Shared Memory representation."
  },
  {
    id: "billing-seat-state",
    area: "Billing",
    mode: "staging",
    description:
      "Exercise paid, grace, plan-limited, and blocked states against the staging billing provider or stub.",
    launchCriterion: "Billing/seat state updates appropriately."
  },
  {
    id: "audit-observability",
    area: "Operations",
    mode: "staging",
    description:
      "Verify audit events, health checks, error logs, and alerting for the critical launch path.",
    launchCriterion: "Audit log and observability show health and errors."
  },
  {
    id: "backup-restore-smoke",
    area: "Operations",
    mode: "staging",
    description:
      "Create a hosted backup, verify the archive, restore-smoke it into a clean target database, and confirm /ops/status reports fresh backup status.",
    launchCriterion: "Backups are fresh, verified, and restorable."
  },
  {
    id: "capacity-load-test",
    area: "Operations",
    mode: "staging",
    description:
      "Run the hosted capacity harness against the target deployment and review API latency, error rate, queue pressure, embedding progress, database growth, and storage growth.",
    launchCriterion:
      "Hosted backend capacity has been measured against the first 1,000 paid-customer assumptions."
  }
];

const automatedLaunchTestEnvironmentKeys = [
  "API_CORS_ORIGINS",
  "API_DATA_ENCRYPTION_KEY",
  "API_ENVELOPE_ENCRYPTION_PROVIDER",
  "API_TOKEN_PEPPER",
  "CACHE_REDIS_URL",
  "CACHE_STORE",
  "CORS_ORIGINS",
  "EMBEDDING_SERVICE_URL",
  "GRAPH_CACHE_TTL_SECONDS",
  "KOED_ALLOW_PUBLIC_REGISTRATION",
  "KOED_BACKUP_STATUS_PATH",
  "KOED_DEPLOYMENT_PROFILE",
  "KOED_HOME",
  "KOED_LAUNCH_API_TOKEN",
  "KOED_LAUNCH_BASE_URL",
  "KOED_LAUNCH_DEVICE_CREDENTIAL",
  "KOED_LAUNCH_LOCAL_EDGE_BACKEND_ID",
  "KOED_LAUNCH_LOCAL_EDGE_BASE_URL",
  "KOED_LAUNCH_SESSION_COOKIE",
  "KOED_LAUNCH_TEAM_NODE_ID",
  "KOED_LAUNCH_TEAM_WORKSPACE_ID",
  "KOED_LAUNCH_TEST_DATABASE_URL",
  "KOED_MANAGED_CLOUD_RELEASE_STAGE",
  "KOED_OPS_ALERT_WEBHOOK_TOKEN",
  "KOED_OPS_ALERT_WEBHOOK_URL",
  "KOED_OPS_OPERATOR_EMAILS",
  "KOED_OPS_REQUEST_METRICS_STATUS_PATH",
  "KOED_RUNBOOK_BASE_URL",
  "KOED_TEAM_COLLABORATION_ENABLED",
  "MEMORY_API_TOKEN",
  "MANAGED_KMS_AUTH_TOKEN",
  "MANAGED_KMS_ENDPOINT_URL",
  "MANAGED_KMS_KEY_ID",
  "MANAGED_KMS_KEY_VERSION",
  "MEMORY_PLAINTEXT_LEXICAL_SEARCH_ENABLED",
  "NODE_ENV",
  "OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY",
  "OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER",
  "OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN",
  "OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL",
  "OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID",
  "OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION",
  "POSTGRES_PASSWORD",
  "RATE_LIMIT_REDIS_URL",
  "RATE_LIMIT_STORE",
  "REDIS_URL",
  "SESSION_SECRET",
  "WORK_QUEUE_BACKEND",
  "WORKOS_API_BASE_URL",
  "WORKOS_API_KEY",
  "WORKOS_AUTHKIT_ENABLED",
  "WORKOS_CLIENT_ID",
  "WORKOS_PROVIDER_ENVIRONMENT",
  "WORKOS_REDIRECT_URI"
];

export const automatedLaunchTestCommands = [
  {
    id: "migration-acceptance",
    command: "pnpm",
    args: ["db:migrate:acceptance"]
  },
  {
    id: "required-collaboration-suites",
    command: "pnpm",
    args: ["test:required-suites"]
  },
  {
    id: "personal-device-sync-fixture",
    command: "pnpm",
    args: ["pds-fixture:validate"]
  },
  {
    id: "db-encrypted-tenant-boundaries",
    command: "pnpm",
    args: [
      "--filter",
      "@koed/db",
      "exec",
      "vitest",
      "run",
      "tests/repository.test.ts",
      "--testNamePattern",
      "encrypted|support overview|activation analytics|billing seats|Cross-Identity Sync|device credentials|Captured Session Share Grants|Team fixture boundaries|managed-cloud|plaintext lexical"
    ]
  },
  {
    id: "api-auth-runtime-boundaries",
    command: "pnpm",
    args: [
      "--filter",
      "@koed/api",
      "exec",
      "vitest",
      "run",
      "src/server.test.ts",
      "src/server/logging.test.ts",
      "src/server/route-identity.test.ts",
      "--testNamePattern",
      "WorkOS|AuthKit|capabilities|support overview|activation analytics|billing seats|entitlement|redact|route identity|device|local-edge|ops|backup|export|return targets|encrypted Memory Event companions"
    ]
  },
  {
    id: "hosted-ops-boundaries",
    command: "node",
    args: [
      "--test",
      "scripts/hosted-backup-lib.test.mjs",
      "scripts/hosted-db-roles-lib.test.mjs",
      "scripts/hosted-capacity-lib.test.mjs",
      "scripts/electron-cdp-lib.test.mjs",
      "scripts/multi-device-profile-lib.test.mjs",
      "scripts/multi-device-dogfood-lib.test.mjs",
      "scripts/team-saas-launch-validation-lib.test.mjs"
    ]
  },
  {
    id: "desktop-electron-interactions",
    command: "pnpm",
    args: ["--filter", "@koed/desktop", "test:browser"]
  }
];

export const buildAutomatedLaunchTestEnvironment = (
  parentEnvironment,
  overrides = {}
) => {
  const environment = { ...parentEnvironment };
  for (const key of automatedLaunchTestEnvironmentKeys) {
    delete environment[key];
  }
  return { ...environment, ...overrides };
};

export const runAutomatedLaunchTests = ({
  commands = automatedLaunchTestCommands,
  cwd,
  environment,
  environmentOverrides = {},
  spawn,
  onStart = () => {}
}) => {
  const childEnvironment = buildAutomatedLaunchTestEnvironment(
    environment,
    environmentOverrides
  );
  for (const testCommand of commands) {
    const displayCommand = [testCommand.command, ...testCommand.args].join(" ");
    onStart(testCommand, displayCommand);
    const result = spawn(testCommand.command, testCommand.args, {
      cwd,
      env: childEnvironment,
      stdio: "inherit"
    });
    if (result.error) {
      throw new Error(
        `Automated launch test command could not start: ${testCommand.id} (${result.error.message})`
      );
    }
    if (result.status !== 0) {
      const outcome =
        result.status === null
          ? `signal ${result.signal ?? "unknown"}`
          : `exit ${result.status}`;
      throw new Error(
        `Automated launch test command failed: ${testCommand.id} (${outcome})`
      );
    }
  }
};

const databaseIdentity = (value, label) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL.`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${label} must be a PostgreSQL URL.`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName || databaseName.includes("/")) {
    throw new Error(`${label} must name exactly one PostgreSQL database.`);
  }
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    databaseName
  };
};

export const assertSeparateLaunchTestDatabase = (
  fixtureDatabaseUrl,
  testDatabaseUrl
) => {
  const fixture = databaseIdentity(fixtureDatabaseUrl, "DATABASE_URL");
  const test = databaseIdentity(
    testDatabaseUrl,
    "KOED_LAUNCH_TEST_DATABASE_URL"
  );
  if (
    fixture.host === test.host &&
    fixture.port === test.port &&
    fixture.databaseName === test.databaseName
  ) {
    throw new Error(
      "KOED_LAUNCH_TEST_DATABASE_URL must not target the fixture database. Automated repository tests are destructive and require a separate disposable database."
    );
  }
};

const readDatabaseRuntimeIdentity = async (
  databaseUrl,
  label,
  createClient
) => {
  const client = createClient(databaseUrl);
  try {
    await client.connect();
    const result = await client.query(
      "select current_database() as database_name, inet_server_addr()::text as server_address, inet_server_port() as server_port"
    );
    const row = result.rows?.[0];
    if (
      !row ||
      typeof row.database_name !== "string" ||
      (row.server_address !== null && typeof row.server_address !== "string") ||
      (typeof row.server_port !== "number" &&
        typeof row.server_port !== "string")
    ) {
      throw new Error("PostgreSQL returned an invalid database identity.");
    }
    const urlIdentity = databaseIdentity(databaseUrl, label);
    return {
      databaseName: row.database_name,
      serverAddress: row.server_address ?? urlIdentity.host,
      serverPort: String(row.server_port)
    };
  } catch (error) {
    throw new Error(
      `${label} could not be verified as a separate PostgreSQL database target.`,
      { cause: error }
    );
  } finally {
    await client.end().catch(() => {});
  }
};

const runtimeDatabaseIdentityMatches = (fixture, test) =>
  fixture.databaseName === test.databaseName &&
  fixture.serverAddress === test.serverAddress &&
  fixture.serverPort === test.serverPort;

const testDatabaseUrlFrom = (sourceDatabaseUrl, databaseName) => {
  const parsed = new URL(sourceDatabaseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
};

export const provisionAutomatedLaunchTestDatabase = async ({
  fixtureDatabaseUrl,
  explicitTestDatabaseUrl,
  createClient,
  uniqueId = randomUUID()
}) => {
  if (explicitTestDatabaseUrl?.trim()) {
    const normalizedTestDatabaseUrl = explicitTestDatabaseUrl.trim();
    assertSeparateLaunchTestDatabase(
      fixtureDatabaseUrl,
      normalizedTestDatabaseUrl
    );
    const [fixtureIdentity, testIdentity] = await Promise.all([
      readDatabaseRuntimeIdentity(
        fixtureDatabaseUrl,
        "DATABASE_URL",
        createClient
      ),
      readDatabaseRuntimeIdentity(
        normalizedTestDatabaseUrl,
        "KOED_LAUNCH_TEST_DATABASE_URL",
        createClient
      )
    ]);
    if (runtimeDatabaseIdentityMatches(fixtureIdentity, testIdentity)) {
      throw new Error(
        "KOED_LAUNCH_TEST_DATABASE_URL resolves to the fixture database. Automated repository tests are destructive and require a separate disposable database."
      );
    }
    return {
      databaseUrl: normalizedTestDatabaseUrl,
      managed: false,
      cleanup: async () => {}
    };
  }

  databaseIdentity(fixtureDatabaseUrl, "DATABASE_URL");
  const suffix = uniqueId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 24);
  if (!suffix) {
    throw new Error("Could not create a safe launch-test database name.");
  }
  const databaseName = `koed_launch_${suffix}`;
  const adminClient = createClient(fixtureDatabaseUrl);
  try {
    await adminClient.connect();
    await adminClient.query(
      `create database "${databaseName}" template template0`
    );
  } catch (error) {
    throw new Error(
      `Could not create the disposable launch-test database. Grant the validation database user CREATEDB or set KOED_LAUNCH_TEST_DATABASE_URL to a separate disposable database. (${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  } finally {
    await adminClient.end().catch(() => {});
  }

  let cleaned = false;
  return {
    databaseUrl: testDatabaseUrlFrom(fixtureDatabaseUrl, databaseName),
    managed: true,
    cleanup: async () => {
      if (cleaned) {
        return;
      }
      const cleanupClient = createClient(fixtureDatabaseUrl);
      try {
        await cleanupClient.connect();
        await cleanupClient.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
          [databaseName]
        );
        await cleanupClient.query(`drop database if exists "${databaseName}"`);
        cleaned = true;
      } finally {
        await cleanupClient.end().catch(() => {});
      }
    }
  };
};

const modeOrder = ["automated", "manual", "staging"];

export const assertLaunchValidationEnvironment = (env = process.env) => {
  if (!env.API_TOKEN_PEPPER?.trim()) {
    throw new Error(
      "API_TOKEN_PEPPER is required for Team SaaS launch validation because the Auth gate depends on deterministic fixture sessions."
    );
  }
};

const fixtureDefaultNode = fixtureMemoryRows.find(
  (memory) => memory.workspace === "electron" && memory.expectedTeamVisible
);

export const defaultStagedRemoteOptions = (env = process.env) => ({
  baseUrl: env.KOED_LAUNCH_BASE_URL || env.MEMORY_API_URL || "",
  browserOrigin: env.KOED_LAUNCH_BROWSER_ORIGIN || "",
  sessionCookie: env.KOED_LAUNCH_SESSION_COOKIE || "",
  deviceCredential: env.KOED_LAUNCH_DEVICE_CREDENTIAL || "",
  apiToken: env.KOED_LAUNCH_API_TOKEN || "",
  teamWorkspaceId:
    env.KOED_LAUNCH_TEAM_WORKSPACE_ID || fixtureWorkspaces.electron.id,
  teamNodeId: env.KOED_LAUNCH_TEAM_NODE_ID || fixtureDefaultNode?.nodeId || "",
  teamId: fixtureTeam.id,
  teamShareGrantId: fixtureDefaultNode?.shareGrantId || "",
  teamRepresentation: fixtureDefaultNode?.representation || "memory_events",
  localEdgeBaseUrl: env.KOED_LAUNCH_LOCAL_EDGE_BASE_URL || "",
  localEdgeBackendId: env.KOED_LAUNCH_LOCAL_EDGE_BACKEND_ID || ""
});

const normalizeBaseUrl = (value) => {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
};

const normalizeDeviceAuthorization = (value) => {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("koed-device ")
    ? trimmed
    : `Koed-Device ${trimmed}`;
};

const readResponseJson = async (response) => {
  const text = await response.text().catch(() => "");
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const stagedProbe = async ({
  fetcher,
  baseUrl,
  name,
  method = "GET",
  path,
  headers = {},
  body,
  expect = "ok",
  redactionSentinels = []
}) => {
  const response = await fetcher(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  const json = await readResponseJson(response);
  const ok =
    expect === "ok"
      ? response.ok
      : Array.isArray(expect)
        ? expect.includes(response.status)
        : response.status === expect;
  if (!ok) {
    throw new Error(
      `${name} returned HTTP ${response.status}; expected ${Array.isArray(expect) ? expect.join("/") : expect}`
    );
  }
  const serialized =
    typeof json === "string" ? json : JSON.stringify(json ?? null);
  for (const sentinel of redactionSentinels.filter(Boolean)) {
    if (serialized.includes(sentinel)) {
      throw new Error(`${name} response leaked staged credential sentinel.`);
    }
  }
  return {
    name,
    status: response.status,
    ok: true,
    json
  };
};

const stagedRoutePath = (path) =>
  path.replaceAll(/\{([^}]+)\}/g, (_match, parameter) => {
    if (parameter === "chunkIndex") return "0";
    if (parameter === "representation") return "memory_events";
    return randomUUID();
  });

const stagedApiTokenBoundaryRoutes = (openApi, deploymentProfile) => {
  if (!openApi?.paths || typeof openApi.paths !== "object") {
    throw new Error("Staged OpenAPI response does not contain route paths.");
  }
  const teamDomains = new Set([
    "collaboration",
    "high_risk",
    "retention",
    "shared_memory",
    "team_memory"
  ]);
  const routes = [];
  for (const [path, operations] of Object.entries(openApi.paths)) {
    if (!operations || typeof operations !== "object") continue;
    for (const [method, operation] of Object.entries(operations)) {
      if (!new Set(["get", "post", "put", "patch", "delete"]).has(method)) {
        continue;
      }
      if (!operation || typeof operation !== "object") continue;
      const identity = operation["x-koed-identity"];
      const domain = operation["x-koed-domain"];
      const teamAuthority = operation["x-koed-team-authority"];
      const deploymentModes = operation["x-koed-deployment-modes"];
      if (
        Array.isArray(deploymentModes) &&
        !deploymentModes.includes(deploymentProfile)
      ) {
        continue;
      }
      const security = Array.isArray(operation.security)
        ? operation.security
        : [];
      const acceptsBearer = security.some(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          Object.hasOwn(entry, "bearerApiToken")
      );
      const relevant =
        teamDomains.has(domain) ||
        (typeof teamAuthority === "string" && teamAuthority !== "none");
      if (
        !relevant ||
        acceptsBearer ||
        identity === "public" ||
        identity === "optional_session"
      ) {
        continue;
      }
      routes.push({
        method: method.toUpperCase(),
        path,
        identity,
        domain,
        teamAuthority
      });
    }
  }
  return routes.sort((left, right) =>
    `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`)
  );
};

export const runStagedApiTokenBoundaryMatrix = async (
  { baseUrl, apiToken, deploymentProfile, openApi, redactionSentinels = [] },
  fetcher = fetch
) => {
  const routes = stagedApiTokenBoundaryRoutes(openApi, deploymentProfile);
  if (!routes.length) {
    throw new Error(
      "Staged OpenAPI route inventory contains no Team API-token boundary routes."
    );
  }
  const probes = [];
  for (const route of routes) {
    probes.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: `api-token-denied:${route.method}:${route.path}`,
        method: route.method,
        path: stagedRoutePath(route.path),
        headers: { authorization: `Bearer ${apiToken}` },
        expect: [401, 403],
        redactionSentinels
      })
    );
  }
  return { routes, probes };
};

export const runStagedRemoteValidation = async (input, fetcher = fetch) => {
  const options = {
    ...defaultStagedRemoteOptions({}),
    ...input
  };
  const missing = [];
  if (!options.baseUrl?.trim()) {
    missing.push("--base-url or KOED_LAUNCH_BASE_URL");
  }
  if (!options.sessionCookie?.trim()) {
    missing.push("--session-cookie or KOED_LAUNCH_SESSION_COOKIE");
  }
  if (!options.deviceCredential?.trim()) {
    missing.push("--device-credential or KOED_LAUNCH_DEVICE_CREDENTIAL");
  }
  if (!options.teamWorkspaceId?.trim()) {
    missing.push("--team-workspace-id or KOED_LAUNCH_TEAM_WORKSPACE_ID");
  }
  if (missing.length) {
    throw new Error(`Staged remote validation requires ${missing.join(", ")}.`);
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const browserOrigin = options.browserOrigin?.trim()
    ? new URL(options.browserOrigin).origin
    : new URL(baseUrl).origin;
  const localEdgeBaseUrl = options.localEdgeBaseUrl?.trim()
    ? normalizeBaseUrl(options.localEdgeBaseUrl)
    : "";
  const deviceAuthorization = normalizeDeviceAuthorization(
    options.deviceCredential
  );
  const sessionHeaders = {
    cookie: options.sessionCookie,
    origin: browserOrigin,
    "sec-fetch-site": "same-origin"
  };
  const credentialSentinels = [
    options.sessionCookie,
    options.deviceCredential,
    deviceAuthorization,
    options.apiToken
  ];
  const answerBody = {
    query: "Workspace Memory Timeline UX",
    retrieval_scope: "personal",
    retrieval_stage: "score_scan",
    strict_limit: true,
    limit: 3,
    team_workspace_id: options.teamWorkspaceId
  };
  const scopedGrantPath = `/v1/shared-memory/teams/${encodeURIComponent(options.teamId)}/workspaces/${encodeURIComponent(options.teamWorkspaceId)}/share-grants`;
  const results = [];

  const publicCapabilities = await stagedProbe({
    fetcher,
    baseUrl,
    name: "public-capabilities",
    path: "/v1/capabilities",
    redactionSentinels: credentialSentinels
  });
  results.push(publicCapabilities);
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "session-authenticated-capabilities",
      path: "/v1/capabilities/authenticated",
      headers: sessionHeaders,
      redactionSentinels: credentialSentinels
    })
  );
  for (const [actor, headers] of [
    ["session", sessionHeaders],
    ["device", { authorization: deviceAuthorization }]
  ]) {
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: `${actor}-shared-memory-grant-list`,
        path: `${scopedGrantPath}?limit=100&offset=0`,
        headers,
        redactionSentinels: credentialSentinels
      })
    );
  }
  const representationQuery = `representation=${encodeURIComponent(options.teamRepresentation)}`;
  const itemPath = `${scopedGrantPath}/${encodeURIComponent(options.teamShareGrantId)}/items?${representationQuery}`;
  const sessionTimeline = await stagedProbe({
    fetcher,
    baseUrl,
    name: "session-shared-memory-representation-timeline",
    path: itemPath,
    headers: sessionHeaders,
    redactionSentinels: credentialSentinels
  });
  results.push(sessionTimeline);
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "device-shared-memory-representation-timeline",
      path: itemPath,
      headers: { authorization: deviceAuthorization },
      redactionSentinels: credentialSentinels
    })
  );
  const stagedSourceId = sessionTimeline.json?.items?.[0]?.sourceId;
  if (typeof stagedSourceId !== "string" || !stagedSourceId) {
    throw new Error(
      "Shared Memory representation timeline did not return a detail source ID."
    );
  }
  for (const [actor, headers] of [
    ["session", sessionHeaders],
    ["device", { authorization: deviceAuthorization }]
  ]) {
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: `${actor}-shared-memory-representation-detail`,
        path: `${scopedGrantPath}/${encodeURIComponent(options.teamShareGrantId)}/items/${encodeURIComponent(stagedSourceId)}?${representationQuery}`,
        headers,
        redactionSentinels: credentialSentinels
      })
    );
  }

  for (const [actor, headers] of [
    ["session", sessionHeaders],
    ["device", { authorization: deviceAuthorization }]
  ]) {
    for (const [surface, path] of [
      ["answer", "/v1/memory/answer"],
      ["search", "/v1/memory/search"]
    ]) {
      results.push(
        await stagedProbe({
          fetcher,
          baseUrl,
          name: `${actor}-generic-team-${surface}-unavailable`,
          method: "POST",
          path,
          headers,
          body: answerBody,
          expect: 404,
          redactionSentinels: credentialSentinels
        })
      );
    }
  }
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "session-team-graph-nodes",
      path: `/v1/memory/graph/nodes?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
      headers: sessionHeaders,
      expect: 404,
      redactionSentinels: credentialSentinels
    })
  );
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "session-team-graph-events",
      path: `/v1/memory/graph/events?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
      headers: sessionHeaders,
      expect: 404,
      redactionSentinels: credentialSentinels
    })
  );
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "device-team-graph-nodes",
      path: `/v1/memory/graph/nodes?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
      headers: { authorization: deviceAuthorization },
      expect: 404,
      redactionSentinels: credentialSentinels
    })
  );
  results.push(
    await stagedProbe({
      fetcher,
      baseUrl,
      name: "device-team-graph-events",
      path: `/v1/memory/graph/events?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
      headers: { authorization: deviceAuthorization },
      expect: 404,
      redactionSentinels: credentialSentinels
    })
  );

  if (options.teamNodeId?.trim()) {
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: "device-team-node-detail",
        path: `/v1/memory/graph/nodes/${encodeURIComponent(options.teamNodeId)}?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
        headers: { authorization: deviceAuthorization },
        expect: 404,
        redactionSentinels: credentialSentinels
      })
    );
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: "session-team-node-detail",
        path: `/v1/memory/graph/nodes/${encodeURIComponent(options.teamNodeId)}?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
        headers: sessionHeaders,
        expect: 404,
        redactionSentinels: credentialSentinels
      })
    );
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: "device-team-node-expand",
        path: `/v1/memory/nodes/${encodeURIComponent(options.teamNodeId)}/expand?team_workspace_id=${encodeURIComponent(options.teamWorkspaceId)}`,
        headers: { authorization: deviceAuthorization },
        expect: 404,
        redactionSentinels: credentialSentinels
      })
    );
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: "session-team-node-expand",
        path: `/v1/memory/nodes/${encodeURIComponent(options.teamNodeId)}/expand?team_workspace_id=${encodeURIComponent(options.teamWorkspaceId)}`,
        headers: sessionHeaders,
        expect: 404,
        redactionSentinels: credentialSentinels
      })
    );
  }

  if (options.apiToken?.trim()) {
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: "api-token-team-answer-rejected",
        method: "POST",
        path: "/v1/memory/answer",
        headers: { authorization: `Bearer ${options.apiToken}` },
        body: answerBody,
        expect: [401, 403],
        redactionSentinels: credentialSentinels
      })
    );
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl,
        name: "api-token-team-graph-rejected",
        path: `/v1/memory/graph/events?teamWorkspaceId=${encodeURIComponent(options.teamWorkspaceId)}`,
        headers: { authorization: `Bearer ${options.apiToken}` },
        expect: [401, 403],
        redactionSentinels: credentialSentinels
      })
    );
    const openApi = await stagedProbe({
      fetcher,
      baseUrl,
      name: "openapi-route-inventory",
      path: "/openapi.json",
      redactionSentinels: credentialSentinels
    });
    results.push(openApi);
    const deploymentProfile = publicCapabilities.json?.deployment?.profile;
    if (typeof deploymentProfile !== "string") {
      throw new Error(
        "Staged capability response does not identify the deployment profile."
      );
    }
    const apiTokenMatrix = await runStagedApiTokenBoundaryMatrix(
      {
        baseUrl,
        apiToken: options.apiToken,
        deploymentProfile,
        openApi: openApi.json,
        redactionSentinels: credentialSentinels
      },
      fetcher
    );
    results.push(...apiTokenMatrix.probes);
  }

  if (localEdgeBaseUrl && options.localEdgeBackendId?.trim()) {
    results.push(
      await stagedProbe({
        fetcher,
        baseUrl: localEdgeBaseUrl,
        name: "local-edge-generic-team-answer-unavailable",
        method: "POST",
        path: "/v1/local-edge/team-memory/answer",
        headers: { authorization: deviceAuthorization },
        body: {
          upstream_backend_id: options.localEdgeBackendId,
          input: answerBody
        },
        expect: [403, 404],
        redactionSentinels: credentialSentinels
      })
    );
  } else {
    results.push({
      name: "local-edge-generic-team-answer-unavailable",
      status: "skipped",
      ok: true,
      reason:
        "Set KOED_LAUNCH_LOCAL_EDGE_BASE_URL and KOED_LAUNCH_LOCAL_EDGE_BACKEND_ID to prove generic local-edge Team answer fails closed."
    });
  }

  return {
    baseUrl,
    localEdgeBaseUrl: localEdgeBaseUrl || null,
    teamWorkspaceId: options.teamWorkspaceId,
    probes: results
  };
};

export const summarizeLaunchValidation = (
  fixtureResult,
  options = { automatedTestStatus: "not_run" }
) => {
  const byMode = Object.fromEntries(modeOrder.map((mode) => [mode, 0]));
  for (const gate of launchValidationGates) {
    byMode[gate.mode] += 1;
  }

  return {
    fixture: FIXTURE_VERSION,
    team: fixtureTeam.name,
    users: Object.keys(fixtureUsers).length,
    workspaces: Object.keys(fixtureWorkspaces).length,
    memories: fixtureResult.memories,
    gates: launchValidationGates.length,
    byMode,
    automatedChecks: fixtureResult.checks,
    automatedTestStatus: options.automatedTestStatus ?? "not_run",
    stagedRemote: options.stagedRemote ?? null,
    multiDevice: options.multiDevice ?? null,
    automatedTestCommands: automatedLaunchTestCommands.map((item) => ({
      id: item.id,
      command: [item.command, ...item.args].join(" ")
    }))
  };
};

export const validateLaunchReadiness = async (client, options) => {
  const fixtureResult = await validateFixture(client, options?.fixtureRuntime);
  return summarizeLaunchValidation(fixtureResult, options);
};

export const formatLaunchValidationReport = (summary) => {
  const lines = [
    `Team SaaS launch validation report (${summary.fixture})`,
    "",
    `Fixture: ${summary.users} users, ${summary.workspaces} Workspaces, ${summary.memories} memories`,
    `Gates: ${summary.gates} total, ${summary.byMode.automated} automated, ${summary.byMode.manual} manual, ${summary.byMode.staging} staging`,
    "",
    "Automated fixture checks:"
  ];

  for (const check of summary.automatedChecks) {
    lines.push(`- ${check}`);
  }

  lines.push(
    "",
    `Automated repository test gates: ${summary.automatedTestStatus}`
  );
  for (const command of summary.automatedTestCommands) {
    lines.push(`- [${command.id}] ${command.command}`);
  }

  if (summary.stagedRemote) {
    const probeCounts = summary.stagedRemote.probes.reduce(
      (counts, probe) => {
        const key = probe.status === "skipped" ? "skipped" : "completed";
        counts[key] += 1;
        return counts;
      },
      { completed: 0, skipped: 0 }
    );
    lines.push(
      "",
      `Staged remote HTTP probes: ${probeCounts.completed} completed, ${probeCounts.skipped} skipped`
    );
    for (const probe of summary.stagedRemote.probes) {
      lines.push(`- ${probe.name}: ${probe.status}`);
      if (probe.reason) {
        lines.push(`  ${probe.reason}`);
      }
    }
  }

  if (summary.multiDevice) {
    lines.push(
      "",
      `Multi-device Electron dogfood: passed (${summary.multiDevice.backendId})`,
      `- Notes A to B: ${summary.multiDevice.flows.aToB.eventType}`,
      `- Notes B to A: ${summary.multiDevice.flows.bToA.eventType}`,
      `- Personal channel B to A: ${summary.multiDevice.flows.channelBToA.eventType}`,
      `- Renderer reload catch-up: ${summary.multiDevice.flows.rendererReloadCatchUp.recovered ? "passed" : "failed"}`
    );
  }

  for (const mode of modeOrder) {
    lines.push("", `${mode[0].toUpperCase()}${mode.slice(1)} launch gates:`);
    for (const gate of launchValidationGates.filter(
      (candidate) => candidate.mode === mode
    )) {
      lines.push(`- [${gate.area}] ${gate.description}`);
      lines.push(`  Criterion: ${gate.launchCriterion}`);
    }
  }

  lines.push(
    "",
    "Any failed launch blocker should be linked to a Linear ticket before release."
  );

  return `${lines.join("\n")}\n`;
};

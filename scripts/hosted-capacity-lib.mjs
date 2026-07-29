import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export const DEFAULT_CAPACITY_BASE_URL = "http://127.0.0.1:3300";
export const DEFAULT_DURATION_SECONDS = 60;
export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_MAX_P95_MS = 1000;
export const DEFAULT_MAX_ERROR_RATE = 0.01;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const usage = `Usage:
  pnpm hosted:capacity -- run [--base-url <url>] [--scenario <name>] [--duration-seconds <n>] [--concurrency <n>] [--requests <n>] [--api-token <token>] [--session-cookie <cookie>] [--device-credential <credential>] [--team-workspace-id <uuid>] [--upstream-backend-id <id>] [--database-url <url>] [--json]
  pnpm hosted:capacity -- plan

Scenarios:
  public-smoke             GET /ready and GET /v1/capabilities
  personal-capture         POST /v1/memory/capture-personal-event with an API Token
  personal-recall          POST /v1/memory/search with an API Token
  team-workspace-recall    POST /v1/memory/answer with a browser session cookie and Team Workspace
  team-device-recall       POST /v1/memory/answer with a scoped Koed-Device credential and Team Workspace
  local-edge-team-recall   POST /v1/local-edge/team-memory/answer for Team Workspace recall
  ops-status               GET /ops/status with a browser session cookie
  mixed                    Weighted public, capture, recall, graph, Team, local-edge, and ops traffic where credentials are available

Environment:
  MEMORY_API_URL                    API base URL, default ${DEFAULT_CAPACITY_BASE_URL}
  KOED_CAPACITY_API_TOKEN           API Token for personal capture/recall scenarios
  KOED_CAPACITY_SESSION_COOKIE      Browser session Cookie header for Team/ops scenarios
  KOED_CAPACITY_DEVICE_CREDENTIAL   Koed-Device credential value or full header for Team device scenarios
  KOED_CAPACITY_TEAM_WORKSPACE_ID   Team Workspace id for Team scenarios
  KOED_CAPACITY_UPSTREAM_BACKEND_ID Upstream backend id for local-edge proxy scenarios
  DATABASE_URL                      Optional database snapshot source
`;

const scenarioNames = new Set([
  "public-smoke",
  "personal-capture",
  "personal-recall",
  "team-workspace-recall",
  "team-device-recall",
  "local-edge-team-recall",
  "ops-status",
  "mixed"
]);

const positiveInteger = (value, name) => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
};

const nonNegativeNumber = (value, name) => {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return parsed;
};

const takeValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.\n\n${usage}`);
  }
  return value;
};

const normalizeBaseUrl = (value) => {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
};

export const hostedCapacityUsage = () => usage;

export const parseHostedCapacityArgs = (argv, env = process.env) => {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = normalizedArgv;
  if (!command || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (!["plan", "run"].includes(command)) {
    throw new Error(`Unknown hosted capacity command: ${command}\n\n${usage}`);
  }

  const parsed = {
    command,
    scenario: "public-smoke",
    baseUrl: env.MEMORY_API_URL || DEFAULT_CAPACITY_BASE_URL,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    concurrency: DEFAULT_CONCURRENCY,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    maxP95Ms: DEFAULT_MAX_P95_MS,
    maxErrorRate: DEFAULT_MAX_ERROR_RATE,
    apiToken: env.KOED_CAPACITY_API_TOKEN,
    sessionCookie: env.KOED_CAPACITY_SESSION_COOKIE,
    deviceCredential: env.KOED_CAPACITY_DEVICE_CREDENTIAL,
    teamWorkspaceId: env.KOED_CAPACITY_TEAM_WORKSPACE_ID,
    upstreamBackendId: env.KOED_CAPACITY_UPSTREAM_BACKEND_ID,
    databaseUrl: env.DATABASE_URL,
    json: false
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--scenario") {
      parsed.scenario = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--base-url") {
      parsed.baseUrl = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--duration-seconds") {
      parsed.durationSeconds = positiveInteger(
        takeValue(rest, index, arg),
        arg
      );
      index += 1;
    } else if (arg === "--concurrency") {
      parsed.concurrency = positiveInteger(takeValue(rest, index, arg), arg);
      index += 1;
    } else if (arg === "--requests") {
      parsed.requests = positiveInteger(takeValue(rest, index, arg), arg);
      index += 1;
    } else if (arg === "--api-token") {
      parsed.apiToken = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--session-cookie") {
      parsed.sessionCookie = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--device-credential") {
      parsed.deviceCredential = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--team-workspace-id") {
      parsed.teamWorkspaceId = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--upstream-backend-id") {
      parsed.upstreamBackendId = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--database-url") {
      parsed.databaseUrl = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--request-timeout-ms") {
      parsed.requestTimeoutMs = positiveInteger(
        takeValue(rest, index, arg),
        arg
      );
      index += 1;
    } else if (arg === "--max-p95-ms") {
      parsed.maxP95Ms = positiveInteger(takeValue(rest, index, arg), arg);
      index += 1;
    } else if (arg === "--max-error-rate") {
      parsed.maxErrorRate = nonNegativeNumber(takeValue(rest, index, arg), arg);
      index += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage}`);
    }
  }

  if (command === "run" && !scenarioNames.has(parsed.scenario)) {
    throw new Error(`Unknown scenario: ${parsed.scenario}\n\n${usage}`);
  }

  parsed.baseUrl = normalizeBaseUrl(parsed.baseUrl);
  return parsed;
};

const authorizationHeaders = (options) => {
  const headers = {};
  if (options.apiToken) {
    headers.authorization = `Bearer ${options.apiToken}`;
  }
  if (options.sessionCookie) {
    headers.cookie = options.sessionCookie;
  }
  return headers;
};

const jsonHeaders = (options) => ({
  "content-type": "application/json",
  ...authorizationHeaders(options)
});

const sessionHeaders = (options) =>
  options.sessionCookie ? { cookie: options.sessionCookie } : {};

const sessionJsonHeaders = (options) => ({
  "content-type": "application/json",
  ...sessionHeaders(options)
});

const normalizeDeviceAuthorization = (credential) => {
  const trimmed = String(credential ?? "").trim();
  return trimmed.toLowerCase().startsWith("koed-device ")
    ? trimmed
    : `Koed-Device ${trimmed}`;
};

const deviceHeaders = (options) =>
  options.deviceCredential
    ? { authorization: normalizeDeviceAuthorization(options.deviceCredential) }
    : {};

const deviceJsonHeaders = (options) => ({
  "content-type": "application/json",
  ...deviceHeaders(options)
});

const scenarioOperationDefinitions = (options, runId) => {
  const publicOperations = [
    {
      name: "ready",
      weight: 2,
      method: "GET",
      path: "/ready",
      headers: {}
    },
    {
      name: "capabilities",
      weight: 1,
      method: "GET",
      path: "/v1/capabilities",
      headers: {}
    }
  ];

  const captureOperation = {
    name: "personal-capture",
    weight: 4,
    method: "POST",
    path: "/v1/memory/capture-personal-event",
    headers: jsonHeaders(options),
    body: (sequence) => ({
      workspaceId: `capacity-${runId}`,
      actor: sequence % 2 === 0 ? "user" : "agent",
      eventType: "capacity_probe",
      content: `Hosted capacity probe ${runId} event ${sequence}`,
      metadata: {
        source: "hosted-capacity",
        runId,
        sequence,
        externalSessionId: `capacity-${runId}`,
        threadName: "Hosted capacity probe"
      },
      sourceRuntime: "codex-cli",
      captureMethod: "api",
      idempotencyKey: `capacity-${runId}-${sequence}`
    })
  };

  const recallOperation = {
    name: "personal-recall",
    weight: 2,
    method: "POST",
    path: "/v1/memory/search",
    headers: jsonHeaders(options),
    body: (sequence) => ({
      query: `Hosted capacity probe ${sequence % 10}`,
      retrieval_scope: "personal",
      search_domain: "global",
      limit: 5
    })
  };

  const graphOperation = {
    name: "graph-overview",
    weight: 1,
    method: "GET",
    path: "/v1/memory/graph/overview",
    headers: authorizationHeaders(options)
  };

  const opsOperation = {
    name: "ops-status",
    weight: 1,
    method: "GET",
    path: "/ops/status",
    headers: authorizationHeaders(options)
  };

  const teamAnswerBody = (sequence) => ({
    query: `Hosted Team capacity probe ${sequence % 10}`,
    retrieval_scope: "personal",
    retrieval_stage: "score_scan",
    strict_limit: true,
    limit: 5,
    team_workspace_id: options.teamWorkspaceId
  });

  const teamWorkspaceRecallOperation = {
    name: "team-workspace-recall",
    weight: 2,
    method: "POST",
    path: "/v1/memory/answer",
    headers: sessionJsonHeaders(options),
    body: teamAnswerBody
  };

  const teamDeviceRecallOperation = {
    name: "team-device-recall",
    weight: 2,
    method: "POST",
    path: "/v1/memory/answer",
    headers: deviceJsonHeaders(options),
    body: teamAnswerBody
  };

  const localEdgeTeamRecallOperation = {
    name: "local-edge-team-recall",
    weight: 1,
    method: "POST",
    path: "/v1/local-edge/team-memory/answer",
    headers: deviceJsonHeaders(options),
    body: (sequence) => ({
      upstream_backend_id: options.upstreamBackendId,
      input: teamAnswerBody(sequence)
    })
  };

  if (options.scenario === "public-smoke") {
    return publicOperations;
  }
  if (options.scenario === "personal-capture") {
    return [captureOperation];
  }
  if (options.scenario === "personal-recall") {
    return [recallOperation];
  }
  if (options.scenario === "team-workspace-recall") {
    return [teamWorkspaceRecallOperation];
  }
  if (options.scenario === "team-device-recall") {
    return [teamDeviceRecallOperation];
  }
  if (options.scenario === "local-edge-team-recall") {
    return [localEdgeTeamRecallOperation];
  }
  if (options.scenario === "ops-status") {
    return [opsOperation];
  }

  const mixed = [...publicOperations];
  if (options.apiToken) {
    mixed.push(captureOperation, recallOperation, graphOperation);
  }
  if (options.sessionCookie) {
    mixed.push(opsOperation);
    if (options.teamWorkspaceId) {
      mixed.push(teamWorkspaceRecallOperation);
    }
  }
  if (options.deviceCredential && options.teamWorkspaceId) {
    mixed.push(teamDeviceRecallOperation);
    if (options.upstreamBackendId) {
      mixed.push(localEdgeTeamRecallOperation);
    }
  }
  return mixed;
};

export const buildScenarioOperations = (options, runId = "test") => {
  const operations = scenarioOperationDefinitions(options, runId);
  if (
    ["personal-capture", "personal-recall"].includes(options.scenario) &&
    !options.apiToken
  ) {
    throw new Error(
      `${options.scenario} requires --api-token or KOED_CAPACITY_API_TOKEN.`
    );
  }
  if (options.scenario === "ops-status" && !options.sessionCookie) {
    throw new Error(
      "ops-status requires --session-cookie or KOED_CAPACITY_SESSION_COOKIE."
    );
  }
  if (options.scenario === "team-workspace-recall") {
    if (!options.sessionCookie) {
      throw new Error(
        "team-workspace-recall requires --session-cookie or KOED_CAPACITY_SESSION_COOKIE."
      );
    }
    if (!options.teamWorkspaceId) {
      throw new Error(
        "team-workspace-recall requires --team-workspace-id or KOED_CAPACITY_TEAM_WORKSPACE_ID."
      );
    }
  }
  if (options.scenario === "team-device-recall") {
    if (!options.deviceCredential) {
      throw new Error(
        "team-device-recall requires --device-credential or KOED_CAPACITY_DEVICE_CREDENTIAL."
      );
    }
    if (!options.teamWorkspaceId) {
      throw new Error(
        "team-device-recall requires --team-workspace-id or KOED_CAPACITY_TEAM_WORKSPACE_ID."
      );
    }
  }
  if (options.scenario === "local-edge-team-recall") {
    if (!options.deviceCredential) {
      throw new Error(
        "local-edge-team-recall requires --device-credential or KOED_CAPACITY_DEVICE_CREDENTIAL."
      );
    }
    if (!options.teamWorkspaceId) {
      throw new Error(
        "local-edge-team-recall requires --team-workspace-id or KOED_CAPACITY_TEAM_WORKSPACE_ID."
      );
    }
    if (!options.upstreamBackendId) {
      throw new Error(
        "local-edge-team-recall requires --upstream-backend-id or KOED_CAPACITY_UPSTREAM_BACKEND_ID."
      );
    }
  }
  if (!operations.length) {
    throw new Error(`Scenario ${options.scenario} produced no operations.`);
  }
  return operations;
};

const pickOperation = (operations, sequence) => {
  const totalWeight = operations.reduce(
    (sum, operation) => sum + operation.weight,
    0
  );
  let slot = sequence % totalWeight;
  for (const operation of operations) {
    if (slot < operation.weight) {
      return operation;
    }
    slot -= operation.weight;
  }
  return operations[operations.length - 1];
};

const percentile = (values, quantile) => {
  if (!values.length) {
    return null;
  }
  const index = Math.min(
    values.length - 1,
    Math.ceil((values.length * quantile) / 100) - 1
  );
  return values[index];
};

export const summarizeSamples = ({ samples, startedAt, finishedAt }) => {
  const sorted = samples
    .map((sample) => sample.latencyMs)
    .sort((a, b) => a - b);
  const total = samples.length;
  const failed = samples.filter((sample) => !sample.ok).length;
  const durationSeconds = Math.max(
    0.001,
    (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000
  );
  const byOperation = {};
  const byStatus = {};
  for (const sample of samples) {
    byOperation[sample.operation] ??= { total: 0, failed: 0 };
    byOperation[sample.operation].total += 1;
    if (!sample.ok) {
      byOperation[sample.operation].failed += 1;
    }
    const statusKey = String(sample.statusCode ?? sample.error ?? "unknown");
    byStatus[statusKey] = (byStatus[statusKey] ?? 0) + 1;
  }

  return {
    total,
    failed,
    errorRate: total ? failed / total : 1,
    durationSeconds,
    requestsPerSecond: total / durationSeconds,
    latencyMs: {
      min: sorted[0] ?? null,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1] ?? null
    },
    byOperation,
    byStatus
  };
};

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    return null;
  }
  return response.json().catch(() => null);
};

const collectOpsStatus = async (options, fetcher = fetchJson) => {
  if (!options.sessionCookie) {
    return null;
  }
  try {
    return await fetcher(`${options.baseUrl}/ops/status`, {
      headers: { cookie: options.sessionCookie }
    });
  } catch {
    return null;
  }
};

export const collectDatabaseSnapshot = async ({
  databaseUrl,
  createPgClient
}) => {
  if (!databaseUrl || !createPgClient) {
    return null;
  }
  const client = createPgClient(databaseUrl);
  await client.connect();
  try {
    const result = await client.query(`
      select
        pg_database_size(current_database())::bigint as database_bytes,
        (select count(*)::bigint from conversation_items) as conversation_items,
        (select count(*)::bigint from memory_events) as memory_events,
        (select count(*)::bigint from memory_embeddings where invalidated_at is null) as active_embeddings,
        (select count(*)::bigint from local_work_queue where status = 'pending') as queue_pending,
        (select count(*)::bigint from local_work_queue where status = 'active') as queue_active,
        (select count(*)::bigint from local_work_queue where status = 'failed') as queue_failed,
        (select count(*)::bigint from local_work_queue where status = 'completed') as queue_completed,
        coalesce((select extract(epoch from now() - min(available_at)) from local_work_queue where status = 'pending'), 0)::float as queue_oldest_pending_seconds,
        coalesce((select extract(epoch from now() - min(locked_at)) from local_work_queue where status = 'active'), 0)::float as queue_oldest_active_seconds
    `);
    return Object.fromEntries(
      Object.entries(result.rows[0] ?? {}).map(([key, value]) => [
        key,
        Number(value)
      ])
    );
  } finally {
    await client.end().catch(() => {});
  }
};

const loadPgClientFactory = () => {
  try {
    const requireFromDbPackage = createRequire(
      new URL("../packages/db/package.json", import.meta.url)
    );
    const pg = requireFromDbPackage("pg");
    return (databaseUrl) => new pg.Client({ connectionString: databaseUrl });
  } catch {
    return null;
  }
};

const snapshotDelta = (before, after) => {
  if (!before || !after) {
    return null;
  }
  return Object.fromEntries(
    Object.keys(after).map((key) => [key, after[key] - (before[key] ?? 0)])
  );
};

const formatRatio = (value) => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(4));
};

const thresholdHeadroom = (used, threshold) => {
  if (
    used === null ||
    used === undefined ||
    threshold === null ||
    threshold === undefined ||
    threshold <= 0
  ) {
    return null;
  }
  return formatRatio((threshold - used) / threshold);
};

export const buildCapacityLaunchGate = (summary, options) => {
  const p95 = summary.requests.latencyMs.p95;
  const errorRate = summary.requests.errorRate;
  const databaseDelta = summary.snapshots.databaseDelta;
  const afterDatabase = summary.snapshots.after.database;
  const bottlenecks = [];
  const observations = [];

  if (summary.requests.total === 0) {
    bottlenecks.push({
      kind: "request-volume",
      severity: "fail",
      message: "No requests completed, so no capacity signal was produced."
    });
  }
  if (errorRate > options.maxErrorRate) {
    bottlenecks.push({
      kind: "api-errors",
      severity: "fail",
      message: `Error rate ${errorRate.toFixed(4)} exceeded ${options.maxErrorRate}.`
    });
  }
  if (p95 !== null && p95 > options.maxP95Ms) {
    bottlenecks.push({
      kind: "api-latency",
      severity: "fail",
      message: `p95 latency ${p95.toFixed(1)}ms exceeded ${options.maxP95Ms}ms.`
    });
  }

  if (databaseDelta) {
    if (databaseDelta.queue_failed > 0) {
      bottlenecks.push({
        kind: "queue-failures",
        severity: "fail",
        message: `${databaseDelta.queue_failed} queue jobs failed during the run.`
      });
    }
    if (databaseDelta.queue_pending > 0) {
      observations.push({
        kind: "queue-backlog",
        severity: "watch",
        message: `${databaseDelta.queue_pending} additional queue jobs were still pending after the run.`
      });
    }
    if (afterDatabase?.queue_active > 0) {
      observations.push({
        kind: "queue-active",
        severity: "watch",
        message: `${afterDatabase.queue_active} queue jobs were still active after the run.`
      });
    }
    if (afterDatabase?.queue_oldest_pending_seconds > 60) {
      observations.push({
        kind: "queue-age",
        severity: "watch",
        message: `Oldest pending queue job was ${afterDatabase.queue_oldest_pending_seconds.toFixed(1)}s old after the run.`
      });
    }
    if (databaseDelta.database_bytes !== 0) {
      const perRequest =
        summary.requests.total > 0
          ? databaseDelta.database_bytes / summary.requests.total
          : null;
      observations.push({
        kind: "storage-growth",
        severity: "info",
        message:
          perRequest === null
            ? `Database size changed by ${databaseDelta.database_bytes} bytes.`
            : `Database size changed by ${databaseDelta.database_bytes} bytes (${perRequest.toFixed(1)} bytes/request).`
      });
    }
  } else {
    observations.push({
      kind: "database-snapshot",
      severity: "info",
      message:
        "DATABASE_URL was not available, so database, queue, embedding, and storage deltas were not measured."
    });
  }

  if (!summary.snapshots.before.ops || !summary.snapshots.after.ops) {
    observations.push({
      kind: "ops-status",
      severity: "info",
      message:
        "A browser session cookie was not available, so /ops/status before/after snapshots were not measured."
    });
  }

  return {
    thresholds: {
      maxP95Ms: options.maxP95Ms,
      maxErrorRate: options.maxErrorRate
    },
    headroom: {
      p95LatencyRatio: thresholdHeadroom(p95, options.maxP95Ms),
      errorRateRatio: thresholdHeadroom(errorRate, options.maxErrorRate)
    },
    bottlenecks,
    observations,
    passed: bottlenecks.every((item) => item.severity !== "fail")
  };
};

export const evaluateCapacitySummary = (summary, options) => {
  if (summary.launchGate?.bottlenecks?.length) {
    return summary.launchGate.bottlenecks
      .filter((bottleneck) => bottleneck.severity === "fail")
      .map((bottleneck) => bottleneck.message);
  }

  const failures = [];
  if (summary.requests.total === 0) {
    failures.push("No requests were completed.");
  }
  if (summary.requests.errorRate > options.maxErrorRate) {
    failures.push(
      `Error rate ${summary.requests.errorRate.toFixed(4)} exceeded ${options.maxErrorRate}.`
    );
  }
  if (
    summary.requests.latencyMs.p95 !== null &&
    summary.requests.latencyMs.p95 > options.maxP95Ms
  ) {
    failures.push(
      `p95 latency ${summary.requests.latencyMs.p95.toFixed(1)}ms exceeded ${options.maxP95Ms}ms.`
    );
  }
  return failures;
};

const invokeOperation = async ({ options, operation, sequence, fetcher }) => {
  const body =
    typeof operation.body === "function"
      ? operation.body(sequence)
      : operation.body;
  const started = performance.now();
  try {
    const response = await fetcher(`${options.baseUrl}${operation.path}`, {
      method: operation.method,
      headers: operation.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs)
    });
    await response.arrayBuffer().catch(() => undefined);
    return {
      operation: operation.name,
      statusCode: response.status,
      ok: response.ok,
      latencyMs: performance.now() - started
    };
  } catch (error) {
    return {
      operation: operation.name,
      error: error instanceof Error ? error.name : "error",
      ok: false,
      latencyMs: performance.now() - started
    };
  }
};

export const runHostedCapacity = async ({
  options,
  now = new Date(),
  fetcher = fetch,
  createPgClient = loadPgClientFactory()
}) => {
  const runId = `cap-${now.toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
  const operations = buildScenarioOperations(options, runId);
  const startedAt = new Date();
  const deadline = Date.now() + options.durationSeconds * 1000;
  const samples = [];
  let sequence = 0;

  const before = {
    ops: await collectOpsStatus(options, async (url, init) => {
      const response = await fetcher(url, init);
      if (!response.ok) {
        return null;
      }
      return response.json().catch(() => null);
    }),
    database: await collectDatabaseSnapshot({
      databaseUrl: options.databaseUrl,
      createPgClient
    })
  };

  const worker = async () => {
    while (Date.now() < deadline) {
      if (options.requests && sequence >= options.requests) {
        return;
      }
      const current = sequence;
      sequence += 1;
      const operation = pickOperation(operations, current);
      samples.push(
        await invokeOperation({
          options,
          operation,
          sequence: current,
          fetcher
        })
      );
    }
  };

  await Promise.all(
    Array.from({ length: options.concurrency }, () => worker())
  );

  const finishedAt = new Date();
  const after = {
    ops: await collectOpsStatus(options, async (url, init) => {
      const response = await fetcher(url, init);
      if (!response.ok) {
        return null;
      }
      return response.json().catch(() => null);
    }),
    database: await collectDatabaseSnapshot({
      databaseUrl: options.databaseUrl,
      createPgClient
    })
  };
  const requests = summarizeSamples({ samples, startedAt, finishedAt });
  const summary = {
    schemaVersion: 1,
    runId,
    scenario: options.scenario,
    baseUrl: options.baseUrl,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    requested: {
      durationSeconds: options.durationSeconds,
      concurrency: options.concurrency,
      requests: options.requests ?? null
    },
    requests,
    snapshots: {
      before,
      after,
      databaseDelta: snapshotDelta(before.database, after.database)
    }
  };
  summary.launchGate = buildCapacityLaunchGate(summary, options);
  return {
    summary,
    failures: evaluateCapacitySummary(summary, options)
  };
};

export const formatCapacityPlan = () => `Hosted capacity plan baseline

Assumptions for the first paid launch target:
- 1,000 paid customers.
- 4 users per paying customer on average.
- 20 captured AI-client turns per active user per workday.
- 10 recall or answer lookups per active user per workday.
- 3 Team Workspaces per paying customer.
- 2 GB initial Postgres storage budget per 1,000 active users before customer-specific retention policies.

Runbook:
- Start with public-smoke against every deployment.
- Run personal-capture with an API Token to measure capture/write and queue pressure.
- Run personal-recall after seeded/captured data has embedded.
- Run ops-status with a browser session cookie to verify private operations reporting under load.
- Run mixed after credentials and seeded memory are ready.

Launch gate:
- p95 API latency stays below ${DEFAULT_MAX_P95_MS}ms for the selected scenario.
- Error rate stays below ${(DEFAULT_MAX_ERROR_RATE * 100).toFixed(1)}%.
- /ops/status and optional database snapshots do not show growing failed queues, runaway active jobs, or unexpected storage deltas.
- Any failed gate gets a follow-up Linear issue before launch.
`;

export const formatCapacityReport = ({ summary, failures }) => {
  const lines = [
    `Hosted capacity run ${summary.runId}`,
    `Scenario: ${summary.scenario}`,
    `Target: ${summary.baseUrl}`,
    `Requests: ${summary.requests.total} total, ${summary.requests.failed} failed, ${summary.requests.requestsPerSecond.toFixed(2)} req/s`,
    `Latency: p50=${summary.requests.latencyMs.p50?.toFixed(1) ?? "n/a"}ms p95=${summary.requests.latencyMs.p95?.toFixed(1) ?? "n/a"}ms p99=${summary.requests.latencyMs.p99?.toFixed(1) ?? "n/a"}ms max=${summary.requests.latencyMs.max?.toFixed(1) ?? "n/a"}ms`,
    `Error rate: ${(summary.requests.errorRate * 100).toFixed(2)}%`,
    "",
    "Operations:"
  ];
  for (const [name, stats] of Object.entries(summary.requests.byOperation)) {
    lines.push(`- ${name}: ${stats.total} total, ${stats.failed} failed`);
  }
  lines.push("", "Status codes:");
  for (const [status, count] of Object.entries(summary.requests.byStatus)) {
    lines.push(`- ${status}: ${count}`);
  }
  if (summary.launchGate) {
    const latencyHeadroom = summary.launchGate.headroom.p95LatencyRatio;
    const errorHeadroom = summary.launchGate.headroom.errorRateRatio;
    lines.push("", "Launch gate:");
    lines.push(
      `- p95 latency headroom: ${latencyHeadroom === null ? "n/a" : `${(latencyHeadroom * 100).toFixed(1)}%`}`
    );
    lines.push(
      `- error-rate headroom: ${errorHeadroom === null ? "n/a" : `${(errorHeadroom * 100).toFixed(1)}%`}`
    );
    if (summary.launchGate.bottlenecks.length) {
      lines.push("- bottlenecks:");
      for (const bottleneck of summary.launchGate.bottlenecks) {
        lines.push(`  - [${bottleneck.severity}] ${bottleneck.message}`);
      }
    } else {
      lines.push("- bottlenecks: none detected by configured thresholds");
    }
    if (summary.launchGate.observations.length) {
      lines.push("- observations:");
      for (const observation of summary.launchGate.observations) {
        lines.push(`  - [${observation.severity}] ${observation.message}`);
      }
    }
  }
  if (summary.snapshots.databaseDelta) {
    lines.push("", "Database deltas:");
    for (const [key, value] of Object.entries(
      summary.snapshots.databaseDelta
    )) {
      lines.push(`- ${key}: ${value}`);
    }
  }
  if (failures.length) {
    lines.push("", "Failures:");
    for (const failure of failures) {
      lines.push(`- ${failure}`);
    }
  } else {
    lines.push("", "Result: passed configured thresholds");
  }
  return `${lines.join("\n")}\n`;
};

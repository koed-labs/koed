import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCapacityLaunchGate,
  buildScenarioOperations,
  collectDatabaseSnapshot,
  evaluateCapacitySummary,
  parseHostedCapacityArgs,
  runHostedCapacity,
  summarizeSamples
} from "./hosted-capacity-lib.mjs";

test("parseHostedCapacityArgs supports package-script separator and env defaults", () => {
  const parsed = parseHostedCapacityArgs(
    [
      "--",
      "run",
      "--scenario",
      "mixed",
      "--base-url",
      "http://localhost:3300/",
      "--duration-seconds",
      "5",
      "--concurrency",
      "2",
      "--requests",
      "10",
      "--max-error-rate",
      "0.05",
      "--json"
    ],
    {
      KOED_CAPACITY_API_TOKEN: "token",
      KOED_CAPACITY_SESSION_COOKIE: "cm_session=session",
      KOED_CAPACITY_DEVICE_CREDENTIAL: "device-key:secret",
      KOED_CAPACITY_TEAM_WORKSPACE_ID: "30000000-0000-4000-8000-000000000001",
      KOED_CAPACITY_UPSTREAM_BACKEND_ID: "team-vps"
    }
  );

  assert.equal(parsed.command, "run");
  assert.equal(parsed.scenario, "mixed");
  assert.equal(parsed.baseUrl, "http://localhost:3300");
  assert.equal(parsed.durationSeconds, 5);
  assert.equal(parsed.concurrency, 2);
  assert.equal(parsed.requests, 10);
  assert.equal(parsed.maxErrorRate, 0.05);
  assert.equal(parsed.apiToken, "token");
  assert.equal(parsed.sessionCookie, "cm_session=session");
  assert.equal(parsed.deviceCredential, "device-key:secret");
  assert.equal(parsed.teamWorkspaceId, "30000000-0000-4000-8000-000000000001");
  assert.equal(parsed.upstreamBackendId, "team-vps");
  assert.equal(parsed.json, true);
});

test("scenario validation requires the right credentials", () => {
  assert.throws(
    () =>
      buildScenarioOperations({
        scenario: "personal-capture",
        apiToken: ""
      }),
    /requires --api-token/
  );
  assert.throws(
    () =>
      buildScenarioOperations({
        scenario: "ops-status",
        sessionCookie: ""
      }),
    /requires --session-cookie/
  );
  assert.throws(
    () =>
      buildScenarioOperations({
        scenario: "team-workspace-recall",
        sessionCookie: "",
        teamWorkspaceId: "30000000-0000-4000-8000-000000000001"
      }),
    /requires --session-cookie/
  );
  assert.throws(
    () =>
      buildScenarioOperations({
        scenario: "team-device-recall",
        deviceCredential: "",
        teamWorkspaceId: "30000000-0000-4000-8000-000000000001"
      }),
    /requires --device-credential/
  );
  assert.throws(
    () =>
      buildScenarioOperations({
        scenario: "local-edge-team-recall",
        deviceCredential: "device-key:secret",
        teamWorkspaceId: "30000000-0000-4000-8000-000000000001",
        upstreamBackendId: ""
      }),
    /requires --upstream-backend-id/
  );
});

test("Team scenarios build session, device, and local-edge operations", () => {
  const teamWorkspaceId = "30000000-0000-4000-8000-000000000001";
  const sessionOperations = buildScenarioOperations({
    scenario: "team-workspace-recall",
    sessionCookie: "cm_session=session",
    teamWorkspaceId
  });
  const deviceOperations = buildScenarioOperations({
    scenario: "team-device-recall",
    deviceCredential: "device-key:secret",
    teamWorkspaceId
  });
  const localEdgeOperations = buildScenarioOperations({
    scenario: "local-edge-team-recall",
    deviceCredential: "Koed-Device device-key:secret",
    teamWorkspaceId,
    upstreamBackendId: "team-vps"
  });

  assert.equal(sessionOperations[0].path, "/v1/memory/answer");
  assert.equal(sessionOperations[0].headers.cookie, "cm_session=session");
  assert.equal(sessionOperations[0].body(1).team_workspace_id, teamWorkspaceId);
  assert.equal(
    deviceOperations[0].headers.authorization,
    "Koed-Device device-key:secret"
  );
  assert.equal(
    localEdgeOperations[0].path,
    "/v1/local-edge/team-memory/answer"
  );
  assert.equal(localEdgeOperations[0].body(1).upstream_backend_id, "team-vps");
});

test("summarizeSamples calculates latency and failure metrics", () => {
  const summary = summarizeSamples({
    startedAt: "2026-07-03T10:00:00.000Z",
    finishedAt: "2026-07-03T10:00:02.000Z",
    samples: [
      { operation: "ready", ok: true, statusCode: 200, latencyMs: 10 },
      { operation: "ready", ok: true, statusCode: 200, latencyMs: 20 },
      { operation: "capture", ok: false, statusCode: 500, latencyMs: 40 }
    ]
  });

  assert.equal(summary.total, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.requestsPerSecond, 1.5);
  assert.equal(summary.latencyMs.p50, 20);
  assert.equal(summary.latencyMs.p95, 40);
  assert.equal(summary.byOperation.ready.total, 2);
  assert.equal(summary.byStatus["500"], 1);
});

test("evaluateCapacitySummary fails on p95 and error thresholds", () => {
  const failures = evaluateCapacitySummary(
    {
      requests: {
        total: 10,
        errorRate: 0.2,
        latencyMs: { p95: 1500 }
      }
    },
    { maxErrorRate: 0.01, maxP95Ms: 1000 }
  );

  assert.equal(failures.length, 2);
});

test("buildCapacityLaunchGate reports headroom and queue bottlenecks", () => {
  const launchGate = buildCapacityLaunchGate(
    {
      requests: {
        total: 10,
        errorRate: 0,
        latencyMs: { p95: 250 }
      },
      snapshots: {
        before: {
          ops: null,
          database: {
            queue_failed: 0,
            queue_pending: 0,
            queue_active: 0,
            database_bytes: 1000
          }
        },
        after: {
          ops: null,
          database: {
            queue_failed: 1,
            queue_pending: 3,
            queue_active: 2,
            queue_oldest_pending_seconds: 90,
            database_bytes: 2500
          }
        },
        databaseDelta: {
          queue_failed: 1,
          queue_pending: 3,
          database_bytes: 1500
        }
      }
    },
    { maxP95Ms: 1000, maxErrorRate: 0.01 }
  );

  assert.equal(launchGate.passed, false);
  assert.equal(launchGate.headroom.p95LatencyRatio, 0.75);
  assert.equal(launchGate.bottlenecks[0].kind, "queue-failures");
  assert.ok(
    launchGate.observations.some(
      (observation) => observation.kind === "queue-backlog"
    )
  );
  assert.ok(
    evaluateCapacitySummary(
      {
        requests: {
          total: 10,
          errorRate: 0,
          latencyMs: { p95: 250 }
        },
        launchGate
      },
      { maxP95Ms: 1000, maxErrorRate: 0.01 }
    ).some((failure) => failure.includes("queue jobs failed"))
  );
});

test("collectDatabaseSnapshot returns numeric counts from pg rows", async () => {
  const queries = [];
  const snapshot = await collectDatabaseSnapshot({
    databaseUrl: "postgres://koed:secret@localhost/koed",
    createPgClient: (databaseUrl) => ({
      async connect() {
        queries.push(["connect", databaseUrl]);
      },
      async query(sql) {
        queries.push(["query", sql]);
        return {
          rows: [
            {
              database_bytes: "100",
              conversation_items: "2",
              memory_events: "3",
              active_embeddings: "4",
              queue_pending: "5",
              queue_active: "6",
              queue_failed: "7",
              queue_completed: "8",
              queue_oldest_pending_seconds: "9.25",
              queue_oldest_active_seconds: "10.5"
            }
          ]
        };
      },
      async end() {
        queries.push(["end"]);
      }
    })
  });

  assert.equal(snapshot.database_bytes, 100);
  assert.equal(snapshot.queue_failed, 7);
  assert.equal(snapshot.queue_pending, 5);
  assert.equal(snapshot.queue_oldest_active_seconds, 10.5);
  assert.equal(queries[0][0], "connect");
  assert.equal(queries.at(-1)[0], "end");
});

test("runHostedCapacity executes a bounded public scenario", async () => {
  const calls = [];
  const result = await runHostedCapacity({
    options: {
      scenario: "public-smoke",
      baseUrl: "http://test.local",
      durationSeconds: 60,
      concurrency: 2,
      requests: 4,
      requestTimeoutMs: 1000,
      maxP95Ms: 1000,
      maxErrorRate: 0.01
    },
    now: new Date("2026-07-03T10:00:00.000Z"),
    createPgClient: null,
    fetcher: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return new ArrayBuffer(0);
        }
      };
    }
  });

  assert.equal(result.summary.requests.total, 4);
  assert.equal(result.failures.length, 0);
  assert.equal(result.summary.launchGate.passed, true);
  assert.equal(result.summary.launchGate.headroom.errorRateRatio, 1);
  assert.ok(calls.some((url) => url.endsWith("/ready")));
  assert.ok(calls.some((url) => url.endsWith("/v1/capabilities")));
});

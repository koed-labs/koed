import assert from "node:assert/strict";
import test from "node:test";

// Removing the second startup, skipping doctor after restart, or accepting a
// failed stop must prevent the acceptance runner from reporting success.
const invoke = async (overrides = {}) => {
  const { verifyHeadlessLifecycle } = await import("./headless-lifecycle.mjs");
  let cycle = 0;
  let stopped = 0;
  let ready = 0;
  const cycles = await verifyHeadlessLifecycle({
    command(args) {
      const verb = args[0];
      overrides.events?.push(verb);
      if (verb === "start") {
        cycle += 1;
        assert.deepEqual(args, ["start", "--daemon", "--json"]);
        return JSON.stringify({
          ok: !overrides.failedStart,
          state: "starting",
          koedHome: "/isolated-test-home",
          message: "Koed server daemon start requested.",
          startedPid: overrides.reusedPid ? 101 : cycle + 100
        });
      }
      if (verb === "doctor") {
        assert.deepEqual(args, ["doctor", "--json"]);
        return JSON.stringify({
          checks: [
            "api",
            "database",
            "workerQueues",
            "embeddingService",
            "privacyService",
            "localAiRuntime",
            "apiToken",
            "mcpServer",
            "deviceIdentity"
          ].map((id) => ({
            id,
            state:
              overrides.failedCheck === id && cycle === 2 ? "error" : "healthy"
          }))
        });
      }
      assert.deepEqual(args, ["stop", "--json"]);
      stopped += 1;
      return JSON.stringify({ ok: !overrides.failedStop });
    },
    async waitForHealthy() {
      ready += 1;
      if (overrides.failedReady) throw new Error("startup failed");
      return { pid: overrides.staleSupervisor ? 99 : cycle + 100 };
    },
    async waitForStopped() {
      return !overrides.leftRunning;
    },
    recordDoctor(phase, doctor) {
      overrides.reports?.push({ phase, doctor });
    }
  });
  return { cycles, stopped, ready };
};

test("acceptance checks both initial startup and fresh startup after stop", async () => {
  const result = await invoke();
  assert.deepEqual(
    result.cycles.map(({ phase, startedPid }) => ({ phase, startedPid })),
    [
      { phase: "initial", startedPid: 101 },
      { phase: "restart", startedPid: 102 }
    ]
  );
  assert.equal(result.stopped, 2);
  assert.equal(result.ready, 2);
});

test("unhealthy restart preserves both doctor reports before failing", async () => {
  const reports = [];
  await assert.rejects(
    invoke({ failedCheck: "database", reports }),
    /restart: doctor database/
  );
  assert.deepEqual(
    reports.map(({ phase }) => phase),
    ["initial", "restart"]
  );
  assert.equal(
    reports[1].doctor.checks.find(({ id }) => id === "database").state,
    "error"
  );
});

test("stop failure preserves doctor evidence and blocks acceptance", async () => {
  const reports = [];
  await assert.rejects(
    invoke({ failedStop: true, reports }),
    /initial: stop failed/
  );
  assert.equal(reports.length, 1);
  assert.equal(reports[0].phase, "initial");
});

test("new launcher cannot validate a stale healthy supervisor", async () => {
  await assert.rejects(
    invoke({ staleSupervisor: true }),
    /initial: healthy supervisor PID/
  );
});

test("successful stop response cannot hide supervisor left running", async () => {
  await assert.rejects(
    invoke({ leftRunning: true }),
    /initial: supervisor did not exit/
  );
});

test("startup failure stops services and blocks acceptance", async () => {
  const events = [];
  await assert.rejects(invoke({ failedReady: true, events }), /startup failed/);
  assert.deepEqual(events, ["start", "stop"]);
});

test("failed start blocks acceptance before doctor", async () => {
  const events = [];
  await assert.rejects(
    invoke({ failedStart: true, events }),
    /initial: start failed/
  );
  assert.deepEqual(events, ["start", "stop"]);
});

test("restart must create a new supervisor instead of reusing one left running", async () => {
  await assert.rejects(
    invoke({ reusedPid: true }),
    /restart reused the previous supervisor/
  );
});

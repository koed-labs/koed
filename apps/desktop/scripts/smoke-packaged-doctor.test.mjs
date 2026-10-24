import assert from "node:assert/strict";
import test from "node:test";
import * as smoke from "./smoke-packaged-desktop-app-lib.mjs";

const healthy = { status: 0, stdout: "healthy", json: { ok: true } };
const local429 = () => ({
  status: 1,
  stdout: "local429",
  json: {
    ok: false,
    checks: [
      { id: "apiToken", details: { httpStatus: 429 } },
      {
        id: "mcpServer",
        details: {
          stderr: JSON.stringify({
            error: "Local Koed API request limit reached. Retry later."
          })
        }
      }
    ]
  }
});
const fixture = (results, extra = {}) => {
  let clock = 0;
  const calls = [];
  return {
    calls,
    options: {
      run: async () => {
        calls.push("doctor");
        const result = results.shift();
        if (result instanceof Error) throw result;
        return result;
      },
      wait: async (ms) => {
        calls.push(ms);
        clock += ms;
      },
      now: () => clock,
      isAlive: () => true,
      ...extra
    }
  };
};

test("smoke doctor returns healthy first result without cooldown", async () => {
  const { options, calls } = fixture([healthy]);
  assert.equal(await smoke.runSmokeDoctor(options), healthy);
  assert.deepEqual(calls, ["doctor"]);
});

test("smoke doctor rejects persistent local throttling after one retry", async () => {
  const { options, calls } = fixture([local429(), local429()]);
  await assert.rejects(smoke.runSmokeDoctor(options), /retry failed/);
  assert.deepEqual(calls, ["doctor", 61_000, "doctor"]);
});

test("smoke doctor recovers confirmed local429 once without probing during cooldown", async () => {
  const { options, calls } = fixture([local429(), healthy]);
  assert.equal(await smoke.runSmokeDoctor(options), healthy);
  assert.deepEqual(calls, ["doctor", 61_000, "doctor"]);
});

test("smoke doctor preserves first and final failures and never retries twice", async () => {
  const { options, calls } = fixture([
    local429(),
    { status: 1, stdout: "final failure", json: { ok: false } }
  ]);
  await assert.rejects(
    smoke.runSmokeDoctor(options),
    /local429[\s\S]*final failure/
  );
  assert.equal(calls.filter((call) => call === "doctor").length, 2);
});

test("smoke doctor rejects unknown429, auth failures, handshake and invalid output immediately", async () => {
  for (const first of [
    {
      status: 1,
      stdout: "remote429",
      json: { checks: [{ id: "apiToken", details: { httpStatus: 429 } }] }
    },
    {
      status: 1,
      stdout: "unauthorized",
      json: { checks: [{ id: "apiToken", details: { httpStatus: 401 } }] }
    },
    new Error("Desktop supervisor exited before completing handshake."),
    new Error("invalid JSON")
  ]) {
    const { options, calls } = fixture([first]);
    await assert.rejects(smoke.runSmokeDoctor(options));
    assert.deepEqual(calls, ["doctor"]);
  }
});

test("smoke doctor rejects expired deadline or stopped supervisor before retry", async () => {
  for (const extra of [{ timeoutMs: 60_000 }, { isAlive: () => false }]) {
    const { options, calls } = fixture([local429(), healthy], extra);
    await assert.rejects(smoke.runSmokeDoctor(options));
    assert.deepEqual(calls, ["doctor"]);
  }
  let alive = true;
  const { options, calls } = fixture([local429(), healthy], {
    isAlive: () => alive,
    wait: async () => {
      alive = false;
    }
  });
  await assert.rejects(smoke.runSmokeDoctor(options));
  assert.deepEqual(calls, ["doctor"]);
});

test("smoke doctor permits only known quota-dependent capability unavailability", async () => {
  const first = local429();
  first.json.checks.push({
    id: "aiClientFlow:conversations",
    state: "needs_attention",
    message:
      'AI Client instance "codex.default" is unavailable for conversations.'
  });
  const { options } = fixture([first, healthy]);
  assert.equal(await smoke.runSmokeDoctor(options), healthy);
  first.json.checks.at(-1).message = "Invalid flow configuration";
  await assert.rejects(smoke.runSmokeDoctor(fixture([first, healthy]).options));
});

test("smoke doctor rejects unrelated failures mixed with local throttling", async () => {
  const first = local429();
  first.json.checks.push({
    id: "database",
    state: "needs_attention",
    details: {}
  });
  const { options, calls } = fixture([first, healthy]);
  await assert.rejects(smoke.runSmokeDoctor(options));
  assert.deepEqual(calls, ["doctor"]);
});

test("smoke doctor bounds stalled calls and rejects late first success", async () => {
  await assert.rejects(
    smoke.runSmokeDoctor({
      run: () => new Promise(() => {}),
      isAlive: () => true,
      timeoutMs: 10
    }),
    /deadline/
  );
  let clock = 0;
  await assert.rejects(
    smoke.runSmokeDoctor({
      run: async () => {
        clock = 11;
        return healthy;
      },
      now: () => clock,
      isAlive: () => true,
      timeoutMs: 10
    }),
    /deadline/
  );
});

test("smoke doctor never swallows provenance violations on retry", async () => {
  const { options, calls } = fixture([
    local429(),
    new Error("source checkout resolution")
  ]);
  await assert.rejects(
    smoke.runSmokeDoctor(options),
    /source checkout resolution/
  );
  assert.deepEqual(calls, ["doctor", 61_000, "doctor"]);
});

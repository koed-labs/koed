import assert from "node:assert/strict";
import test from "node:test";
import {
  createSmokeEnv,
  verifyPackagedSetupAfterReadiness
} from "../apps/desktop/scripts/smoke-packaged-desktop-app.mjs";
import { resolve } from "node:path";

test("packaged smoke confines every supported AI Client home and Pi session override to its owned fixture", () => {
  const home = resolve("/fixture/smoke");
  const env = createSmokeEnv({ resourcesPath: "/fixture/resources" }, home, {
    CODEX_HOME: "/host/codex",
    CLAUDE_CONFIG_DIR: "/host/claude",
    CLAUDE_SETTINGS_PATH: "/host/claude-settings.json",
    PI_CODING_AGENT_DIR: "/host/pi",
    PI_CODING_AGENT_SESSION_DIR: "/host/pi-sessions"
  });
  assert.equal(env.CODEX_HOME, resolve(home, "codex"));
  assert.equal(env.CLAUDE_CONFIG_DIR, resolve(home, "claude"));
  assert.equal(
    env.CLAUDE_SETTINGS_PATH,
    resolve(home, "claude", "settings.json")
  );
  assert.equal(env.PI_CODING_AGENT_DIR, resolve(home, "pi"));
  assert.equal(
    env.PI_CODING_AGENT_SESSION_DIR,
    resolve(home, "pi", "sessions")
  );
});

const healthyStatus = () =>
  Object.fromEntries(
    [
      "api",
      "database",
      "redis",
      "workerQueues",
      "embeddingService",
      "privacyService",
      "localAiRuntime",
      "apiToken",
      "mcpServer",
      "captureHook"
    ].map((component) => [component, { state: "healthy" }])
  );

const setupOptions = {
  timeoutMs: 10,
  pollIntervalMs: 1,
  supervisorPid: 123
};

const setupVerificationHarness = (
  snapshots,
  { running = true, doctor = { status: 0, stdout: '{"ok":true}' } } = {}
) => {
  let elapsed = 0;
  let polls = 0;
  const commands = [];
  return {
    commands,
    dependencies: {
      now: () => elapsed,
      isRunning: () => running,
      runCommand: (_layout, _koedHome, args) => {
        commands.push(args.join(" "));
        if (args[0] === "doctor") return doctor;
        const snapshot = snapshots[Math.min(polls++, snapshots.length - 1)];
        return { status: 0, stdout: JSON.stringify(snapshot) };
      },
      delay: async (ms) => {
        elapsed += ms;
      }
    }
  };
};

test("packaged setup runs strict doctor only after privacy and client integration recover", async () => {
  const privacyPending = healthyStatus();
  privacyPending.privacyService.state = "starting";
  const clientPending = healthyStatus();
  clientPending.captureHook.state = "starting";
  const harness = setupVerificationHarness([
    privacyPending,
    clientPending,
    healthyStatus()
  ]);
  const result = await verifyPackagedSetupAfterReadiness(
    setupOptions,
    harness.dependencies
  );
  assert.equal(result.reconnectStatus.privacyService.state, "healthy");
  assert.equal(result.reconnectStatus.captureHook.state, "healthy");
  assert.equal(result.doctor.ok, true);
  assert.deepEqual(harness.commands, [
    "status --json",
    "status --json",
    "status --json",
    "doctor --json"
  ]);
});

test("packaged setup does not run doctor after readiness timeout or supervisor exit", async () => {
  const pending = healthyStatus();
  pending.privacyService.state = "starting";
  for (const [reason, harness] of [
    ["Timed out waiting", setupVerificationHarness([pending])],
    [
      "supervisor 123 exited",
      setupVerificationHarness([pending], { running: false })
    ]
  ]) {
    await assert.rejects(
      verifyPackagedSetupAfterReadiness(setupOptions, harness.dependencies),
      new RegExp(reason)
    );
    assert.equal(harness.commands.includes("doctor --json"), false);
  }
});

test("packaged setup still rejects a hard doctor failure", async () => {
  const harness = setupVerificationHarness([healthyStatus()], {
    doctor: { status: 1, stdout: '{"ok":false}', stderr: "doctor failed" }
  });
  await assert.rejects(
    verifyPackagedSetupAfterReadiness(setupOptions, harness.dependencies),
    /doctor --json failed with 1: doctor failed/
  );
  assert.deepEqual(harness.commands, ["status --json", "doctor --json"]);
});

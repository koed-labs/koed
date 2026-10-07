import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  removeSmokeHome,
  createSmokeHome,
  smokeExecutionPlan,
  withPackagedNativeAssetsMasked
} from "./smoke-packaged-desktop-app-lib.mjs";
import {
  assertNoSourceCheckoutResolution,
  assertFailClosedPrivacy,
  assertFailClosedTeamStart,
  waitForHealthyStatus
} from "./smoke-packaged-desktop-app.mjs";

test("smoke home canonicalizes temporary paths before authenticated lifecycle selection", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-smoke-home-test-"));
  try {
    const link = resolve(root, "linked-temp");
    const target = resolve(root, "real-temp");
    mkdirSync(target);
    symlinkSync(target, link, "dir");
    const home = createSmokeHome("smoke-", link);
    assert.equal(home, realpathSync(home));
    assert.equal(home.startsWith(realpathSync(target)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Base privacy rejects enabled assets or missing trust-root denial", () => {
  assert.doesNotThrow(() =>
    assertFailClosedPrivacy({
      available: false,
      state: "unavailable",
      message:
        "Production Privacy Filter signer trust is not configured in this Desktop release."
    })
  );
  assert.throws(
    () => assertFailClosedPrivacy({ available: true, state: "ready" }),
    /fail.closed/i
  );
  assert.throws(
    () =>
      assertFailClosedPrivacy({
        available: false,
        state: "unavailable",
        message: "not required"
      }),
    /fail.closed/i
  );
});

test("Team start must fail for Privacy gate, not unrelated startup errors", () => {
  assert.doesNotThrow(() =>
    assertFailClosedTeamStart({
      ok: false,
      error: "required privacy component is missing"
    })
  );
  assert.throws(
    () => assertFailClosedTeamStart({ ok: true, startedPid: 123 }),
    /fail.closed/i
  );
  assert.throws(
    () =>
      assertFailClosedTeamStart({ ok: false, error: "database unavailable" }),
    /fail.closed/i
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

const statusPollHarness = (snapshots, { running = true } = {}) => {
  let elapsed = 0;
  let polls = 0;
  return {
    get polls() {
      return polls;
    },
    dependencies: {
      now: () => elapsed,
      isRunning: () => running,
      runCommand: () => {
        const snapshot = snapshots[Math.min(polls++, snapshots.length - 1)];
        return { status: 0, stdout: JSON.stringify(snapshot) };
      },
      delay: async (ms) => {
        elapsed += ms;
      }
    }
  };
};

const reconnectPollOptions = {
  timeoutMs: 10,
  pollIntervalMs: 1,
  supervisorPid: 123,
  requireClientIntegration: true
};

test("reconnect waits through transient Privacy Filter Service health failures", async () => {
  const pending = healthyStatus();
  pending.privacyService.state = "starting";
  const healthy = healthyStatus();
  const harness = statusPollHarness([pending, healthy]);
  assert.deepEqual(
    await waitForHealthyStatus(reconnectPollOptions, harness.dependencies),
    healthy
  );
  assert.equal(harness.polls, 2);
});

test("reconnect does not accept healthy services until client integration is ready", async () => {
  const pending = healthyStatus();
  pending.captureHook.state = "starting";
  const harness = statusPollHarness([pending, healthyStatus()]);
  const result = await waitForHealthyStatus(
    reconnectPollOptions,
    harness.dependencies
  );
  assert.equal(result.captureHook.state, "healthy");
  assert.equal(harness.polls, 2);
});

test("reconnect fails with the last status if privacy never recovers", async () => {
  const pending = healthyStatus();
  pending.privacyService.state = "starting";
  const harness = statusPollHarness([pending]);
  await assert.rejects(
    waitForHealthyStatus(reconnectPollOptions, harness.dependencies),
    /Timed out waiting for packaged daemon health.*Last status:[\s\S]*privacyService[\s\S]*starting/
  );
  assert.equal(harness.polls, 10);
});

test("reconnect fails immediately if the daemon supervisor exited", async () => {
  const harness = statusPollHarness([healthyStatus()], { running: false });
  await assert.rejects(
    waitForHealthyStatus(reconnectPollOptions, harness.dependencies),
    /supervisor 123 exited/
  );
  assert.equal(harness.polls, 0);
});

const createRuntimeRoot = ({ withAssets = true } = {}) => {
  const runtimeRoot = mkdtempSync(resolve(tmpdir(), "koed-smoke-assets-"));
  if (withAssets) {
    for (const [directory, file] of [
      ["postgres", "bin/postgres"],
      ["llama.cpp", "llama-server"]
    ]) {
      const target = resolve(runtimeRoot, directory, file);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, `${directory}\n`);
    }
  }
  return runtimeRoot;
};

test("missing-assets execution excludes collaboration and renderer probes", () => {
  assert.deepEqual(smokeExecutionPlan({ missingAssets: true }), {
    collaborationBroker: false,
    rendererFaults: false,
    missingAssets: true,
    healthyDaemon: false
  });
  assert.deepEqual(smokeExecutionPlan({ missingAssets: false }), {
    collaborationBroker: true,
    rendererFaults: true,
    missingAssets: false,
    healthyDaemon: true
  });
});

test("smoke home cleanup retries transient non-empty directory failures", () => {
  let call;
  removeSmokeHome("/tmp/owned-koed-smoke-home", (path, options) => {
    call = { path, options };
  });
  assert.deepEqual(call, {
    path: "/tmp/owned-koed-smoke-home",
    options: {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    }
  });
});

test("native asset masking restores packaged directories after success", async () => {
  const runtimeRoot = createRuntimeRoot();
  try {
    const result = await withPackagedNativeAssetsMasked({
      runtimeRoot,
      work: ({ maskedEntries }) => {
        assert.deepEqual(maskedEntries.sort(), ["llama.cpp", "postgres"]);
        assert.equal(existsSync(resolve(runtimeRoot, "postgres")), false);
        assert.equal(existsSync(resolve(runtimeRoot, "llama.cpp")), false);
        return "complete";
      }
    });
    assert.equal(result, "complete");
    assert.equal(existsSync(resolve(runtimeRoot, "postgres")), true);
    assert.equal(existsSync(resolve(runtimeRoot, "llama.cpp")), true);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("native asset masking restores packaged directories after failure", async () => {
  const runtimeRoot = createRuntimeRoot();
  try {
    await assert.rejects(
      withPackagedNativeAssetsMasked({
        runtimeRoot,
        work: () => {
          throw new Error("expected smoke failure");
        }
      }),
      /expected smoke failure/
    );
    assert.equal(existsSync(resolve(runtimeRoot, "postgres")), true);
    assert.equal(existsSync(resolve(runtimeRoot, "llama.cpp")), true);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("native asset masking supports an app whose assets are already absent", async () => {
  const runtimeRoot = createRuntimeRoot({ withAssets: false });
  try {
    let called = false;
    await withPackagedNativeAssetsMasked({
      runtimeRoot,
      work: ({ maskedEntries }) => {
        called = true;
        assert.deepEqual(maskedEntries, []);
      }
    });
    assert.equal(called, true);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("packaged smoke rejects source-checkout artifact resolution", () => {
  const sourceCheckoutArtifact = resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "apps",
    "api",
    "dist",
    "index.js"
  );
  assert.throws(
    () =>
      assertNoSourceCheckoutResolution("runtime status", {
        artifactPath: sourceCheckoutArtifact
      }),
    /resolved packaged runtime artifacts from source checkout/
  );
  assert.doesNotThrow(() =>
    assertNoSourceCheckoutResolution("runtime status", {
      artifactPath: "/Applications/Koed.app/Contents/Resources/koed-runtime/api"
    })
  );
});

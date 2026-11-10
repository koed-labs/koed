/* global Response */
import assert from "node:assert/strict";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import process from "node:process";
import { resolve } from "node:path";
import { inspectDeviceIdentityAtKoedHome } from "../../../packages/shared/dist/index.js";
import { ensureDeviceIdentity } from "../../../packages/koed-server/dist/device-identity.js";
import { resolveKoedServerPaths } from "../../../packages/koed-server/dist/paths.js";
import {
  removeSmokeHome,
  createSmokeHome,
  smokeExecutionPlan,
  withSmokeFailureDiagnostics,
  withPackagedNativeAssetsMasked
} from "./smoke-packaged-desktop-app-lib.mjs";
import * as smokeLib from "./smoke-packaged-desktop-app-lib.mjs";
import {
  createSmokeEnv,
  setAppImageInstallationEnv,
  withProcessEnv,
  assertNoSourceCheckoutResolution,
  assertFailClosedPrivacy,
  assertFailClosedTeamStart,
  parseArgs,
  waitForHealthyStatus
} from "./smoke-packaged-desktop-app.mjs";
import * as smokeApp from "./smoke-packaged-desktop-app.mjs";
import * as accelerationSmoke from "./acceleration-packaged-smoke.mjs";

test("acceleration smoke allows AppImage startup beyond 180 seconds", async () => {
  let time = 0;
  let polls = 0;
  const result = await accelerationSmoke.waitForAccelerationChange(
    {
      invoke: async () => ({
        operation: { id: "op", state: ++polls === 1 ? "running" : "complete" }
      })
    },
    { operation: { id: "op", state: "running" } },
    {
      now: () => time,
      sleep: async () => {
        time = 181_000;
      }
    }
  );
  assert.equal(result.operation.state, "complete");
});

test("acceleration smoke tracks the current supervisor for stop and cleanup", async () => {
  const pids = [101];
  const pid = await smokeApp.trackCurrentSupervisor(
    async () => ({ lifecycle: { state: "running", pid: 202 } }),
    pids
  );
  assert.equal(pid, 202);
  assert.deepEqual(pids, [101, 202]);
  await assert.rejects(
    smokeApp.trackCurrentSupervisor(async () => ({ lifecycle: {} }), pids),
    /supervisor PID/
  );
});

test("failure diagnostics read failing home before cleanup and retain original cause", async () => {
  const home = createSmokeHome("koed-team-diagnostics-test-");
  const failure = new Error("Team handshake failed");
  writeFileSync(resolve(home, "failure.log"), "supervisor failure");
  try {
    await assert.rejects(
      withSmokeFailureDiagnostics(
        async () => {
          throw failure;
        },
        () => {
          assert.equal(existsSync(resolve(home, "failure.log")), true);
          return "Team diagnostics preserved";
        }
      ),
      (error) =>
        error.cause === failure &&
        /Team diagnostics preserved/.test(error.message)
    );
  } finally {
    removeSmokeHome(home);
  }
  assert.equal(existsSync(home), false);
});

test("diagnostics failure does not replace original smoke failure", async () => {
  await assert.rejects(
    withSmokeFailureDiagnostics(
      async () => {
        throw new Error("Team handshake failed");
      },
      () => {
        throw new Error("diagnostic read failed");
      }
    ),
    /Team handshake failed[\s\S]*diagnostic read failed/
  );
});

test("AppImage mode requires exactly one explicit path and rejects build", () => {
  assert.equal(
    parseArgs(["--appimage", "./Koed.AppImage"]).appImage,
    resolve("./Koed.AppImage")
  );
  assert.throws(() => parseArgs(["--appimage"]), /requires a path/);
  assert.throws(
    () => parseArgs(["--appimage", "a", "--appimage", "b"]),
    /once/
  );
  assert.throws(() => parseArgs(["--appimage", "a", "--build"]), /--build/);
});

test("AppImage extraction uses supplied image and removes owned directory on failure", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "appimage-test-"));
  const image = resolve(root, "Koed.AppImage");
  writeFileSync(
    image,
    "#!/bin/sh\nmkdir -p squashfs-root/resources\ntouch squashfs-root/koed\nchmod +x squashfs-root/koed\n"
  );
  chmodSync(image, 0o755);
  let extracted;
  try {
    assert.equal(typeof smokeLib.withExtractedAppImage, "function");
    await assert.rejects(
      smokeLib.withExtractedAppImage(image, async (path) => {
        extracted = path;
        assert.equal(existsSync(resolve(path, "koed")), true);
        throw new Error("test failure");
      }),
      /test failure/
    );
    assert.equal(existsSync(extracted), false);
    await assert.rejects(
      smokeLib.withExtractedAppImage(
        resolve(root, "missing.AppImage"),
        async () => {}
      ),
      /missing/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct AppImage mode rejects root, unavailable FUSE, and conflicting options", () => {
  assert.throws(() => parseArgs(["--appimage-direct"]), /requires --appimage/);
  assert.throws(
    () =>
      parseArgs([
        "--appimage",
        "image",
        "--appimage-direct",
        "--missing-assets"
      ]),
    /missing-assets/
  );
  assert.equal(typeof smokeLib.assertDirectAppImagePrerequisites, "function");
  assert.throws(
    () =>
      smokeLib.assertDirectAppImagePrerequisites({
        platform: "linux",
        uid: 0,
        fuseAvailable: true
      }),
    /non-root/
  );
  assert.throws(
    () =>
      smokeLib.assertDirectAppImagePrerequisites({
        platform: "linux",
        uid: 1000,
        fuseAvailable: false
      }),
    /FUSE/
  );
  assert.doesNotThrow(() =>
    smokeLib.assertDirectAppImagePrerequisites({
      platform: "linux",
      uid: 1000,
      fuseAvailable: true
    })
  );
});

test("direct GUI uses exact AppImage and strips extraction fallback environment", () => {
  assert.equal(typeof smokeApp.smokeGuiExecutable, "function");
  assert.equal(
    smokeApp.smokeGuiExecutable({
      executable: "/tmp/extracted/koed",
      guiExecutable: "/tmp/Koed.AppImage"
    }),
    "/tmp/Koed.AppImage"
  );
  const original = process.env.APPIMAGE_EXTRACT_AND_RUN;
  try {
    process.env.APPIMAGE_EXTRACT_AND_RUN = "1";
    assert.equal(
      createSmokeEnv("/tmp/koed-home").APPIMAGE_EXTRACT_AND_RUN,
      undefined
    );
  } finally {
    if (original === undefined) delete process.env.APPIMAGE_EXTRACT_AND_RUN;
    else process.env.APPIMAGE_EXTRACT_AND_RUN = original;
  }
});

test("AppImage extraction discards large stdout and bounds error diagnostics", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "appimage-output-"));
  const image = resolve(root, "image");
  try {
    writeFileSync(
      image,
      "#!/bin/sh\nyes x | head -c 2000000\nmkdir -p squashfs-root\n"
    );
    chmodSync(image, 0o755);
    await smokeLib.withExtractedAppImage(image, async (path) =>
      assert.equal(existsSync(path), true)
    );
    writeFileSync(image, "#!/bin/sh\nyes x | head -c 2000000 >&2\nexit 1\n");
    await assert.rejects(
      smokeLib.withExtractedAppImage(image, async () => {}),
      (error) =>
        /extraction failed/.test(error.message) && error.message.length < 20000
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extracted AppImage layout uses only its own executable and rejects overrides", () => {
  const root = mkdtempSync(resolve(tmpdir(), "appimage-layout-"));
  try {
    mkdirSync(resolve(root, "resources"));
    assert.equal(typeof smokeApp.resolvePackagedLayout, "function");
    const layout = smokeApp.resolvePackagedLayout(root);
    assert.equal(layout.executable, resolve(root, "koed"));
    assert.equal(layout.resourcesPath, resolve(root, "resources"));
    const previous = process.env.KOED_DESKTOP_PACKAGE_SMOKE_EXECUTABLE;
    try {
      process.env.KOED_DESKTOP_PACKAGE_SMOKE_EXECUTABLE = "/elsewhere/koed";
      assert.throws(() => smokeApp.resolvePackagedLayout(root), /conflicts/);
    } finally {
      if (previous === undefined)
        delete process.env.KOED_DESKTOP_PACKAGE_SMOKE_EXECUTABLE;
      else process.env.KOED_DESKTOP_PACKAGE_SMOKE_EXECUTABLE = previous;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged smoke defaults health polling to five seconds", () => {
  assert.equal(parseArgs([]).pollIntervalMs, 5_000);
  assert.equal(parseArgs(["--poll-interval-ms", "2000"]).pollIntervalMs, 2_000);
});

test("packaged smoke reserves API budget for repeated readiness and doctor probes", () => {
  assert.equal(
    createSmokeEnv("/tmp/koed-smoke-home").API_AUTH_RATE_LIMIT_MAX,
    "1000"
  );
});

test("packaged smoke verifies host proof beneath a private parent outside its profile", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-smoke-proof-"));
  try {
    chmodSync(root, 0o755);
    const home = resolve(root, "home");
    const environment = createSmokeEnv(home, { NODE_ENV: "production" });
    const identity = await ensureDeviceIdentity(
      resolveKoedServerPaths(environment),
      { environment }
    );
    assert.equal(identity.health, "healthy");
    assert.equal(
      inspectDeviceIdentityAtKoedHome({ koedHome: home, environment }).health,
      "healthy"
    );
    assert.equal(
      environment.KOED_DEVICE_PROOF_DIR.startsWith(home + "/"),
      false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged smoke ignores inherited external service endpoints", () => {
  const keys = [
    "DATABASE_URL",
    "REDIS_URL",
    "KOED_EXTERNAL_DATABASE_URL",
    "KOED_EXTERNAL_REDIS_URL",
    "EMBEDDING_SERVICE_URL",
    "PRIVACY_SERVICE_URL",
    "KOED_EXTERNAL_EMBEDDING_SERVICE_URL",
    "KOED_EXTERNAL_PRIVACY_SERVICE_URL"
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]])
  );
  try {
    for (const key of keys) process.env[key] = "host-service";
    const env = createSmokeEnv("/tmp/private-smoke-home");
    assert.equal(env.KOED_HOME, "/tmp/private-smoke-home");
    for (const key of keys) assert.equal(env[key], undefined, key);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("packaged smoke strips untrusted resources path overrides", () => {
  const original = process.env.KOED_PACKAGED_RESOURCES_PATH;
  process.env.KOED_PACKAGED_RESOURCES_PATH = "/host/resources";
  try {
    const environment = createSmokeEnv("/tmp/koed-smoke-home", {
      KOED_PACKAGED_RESOURCES_PATH: "/extra/resources"
    });
    assert.equal(environment.KOED_PACKAGED_DESKTOP, "1");
    assert.equal(environment.KOED_PACKAGED_RESOURCES_PATH, undefined);
  } finally {
    if (original === undefined) delete process.env.KOED_PACKAGED_RESOURCES_PATH;
    else process.env.KOED_PACKAGED_RESOURCES_PATH = original;
  }
});

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

test("Base privacy remains disabled with configured roots or absent signer trust", () => {
  assert.doesNotThrow(() =>
    assertFailClosedPrivacy({
      available: false,
      state: "unavailable",
      message:
        "Production Privacy Filter signer trust is not configured in this Desktop release."
    })
  );
  assert.doesNotThrow(() =>
    assertFailClosedPrivacy({
      available: false,
      state: "unavailable",
      message:
        "Privacy Filter is not required by current runtime configuration."
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

const statusPollHarness = (
  snapshots,
  { running = true, readinessStatuses = [200], statusProbeIntervalMs } = {}
) => {
  let elapsed = 0;
  let polls = 0;
  let readinessPolls = 0;
  const readyRequests = [];
  const koedHome = mkdtempSync(resolve(tmpdir(), "koed-smoke-status-"));
  mkdirSync(resolve(koedHome, "run"), { recursive: true });
  writeFileSync(
    resolve(koedHome, "run", "koed-server.json"),
    JSON.stringify({ apiUrl: "http://127.0.0.1:3300" })
  );
  return {
    get polls() {
      return polls;
    },
    get readinessPolls() {
      return readinessPolls;
    },
    readyRequests,
    koedHome,
    cleanup: () => rmSync(koedHome, { recursive: true, force: true }),
    dependencies: {
      now: () => elapsed,
      isRunning: () => running,
      fetcher: async (url, options) => {
        readyRequests.push({
          url: String(url),
          authorization:
            options?.headers?.authorization ?? options?.headers?.Authorization
        });
        const status =
          readinessStatuses[
            Math.min(readinessPolls++, readinessStatuses.length - 1)
          ];
        return new Response(JSON.stringify({ status }), { status });
      },
      ...(statusProbeIntervalMs === undefined ? {} : { statusProbeIntervalMs }),
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

const waitForHarnessStatus = (harness, options = {}) =>
  waitForHealthyStatus(
    { ...reconnectPollOptions, koedHome: harness.koedHome, ...options },
    harness.dependencies
  );

test("reconnect waits through transient Privacy Filter Service health failures", async (t) => {
  const pending = healthyStatus();
  pending.privacyService.state = "starting";
  const healthy = healthyStatus();
  const harness = statusPollHarness([pending, healthy], {
    statusProbeIntervalMs: 1
  });
  t.after(harness.cleanup);
  assert.deepEqual(await waitForHarnessStatus(harness), healthy);
  assert.equal(harness.polls, 2);
});

test("readiness polling avoids repeated full status probes", async (t) => {
  const healthy = healthyStatus();
  const harness = statusPollHarness([healthy], {
    readinessStatuses: [503, 200]
  });
  t.after(harness.cleanup);
  assert.deepEqual(await waitForHarnessStatus(harness), healthy);
  assert.equal(harness.readinessPolls, 2);
  assert.equal(harness.polls, 1);
  assert.deepEqual(harness.readyRequests, [
    { url: "http://127.0.0.1:3300/ready", authorization: undefined },
    { url: "http://127.0.0.1:3300/ready", authorization: undefined }
  ]);
});

test("full status probes stay throttled while API readiness remains healthy", async (t) => {
  const pending = healthyStatus();
  pending.privacyService.state = "starting";
  const harness = statusPollHarness([pending, healthyStatus()], {
    statusProbeIntervalMs: 4
  });
  t.after(harness.cleanup);
  await waitForHarnessStatus(harness);
  assert.equal(harness.polls, 2);
  assert.equal(harness.readinessPolls, 5);
});

test("default full status retry interval is thirty seconds", async (t) => {
  const pending = healthyStatus();
  pending.privacyService.state = "starting";
  const harness = statusPollHarness([pending, healthyStatus()]);
  t.after(harness.cleanup);
  await waitForHarnessStatus(harness, {
    timeoutMs: 30_001,
    pollIntervalMs: 15_000
  });
  assert.equal(harness.polls, 2);
  assert.equal(harness.readinessPolls, 3);
});

test("reconnect does not accept healthy services until client integration is ready", async (t) => {
  const pending = healthyStatus();
  pending.captureHook.state = "starting";
  const harness = statusPollHarness([pending, healthyStatus()], {
    statusProbeIntervalMs: 1
  });
  t.after(harness.cleanup);
  const result = await waitForHarnessStatus(harness);
  assert.equal(result.captureHook.state, "healthy");
  assert.equal(harness.polls, 2);
});

test("reconnect fails with the last status if privacy never recovers", async (t) => {
  const pending = healthyStatus();
  pending.privacyService.state = "starting";
  const harness = statusPollHarness([pending], { statusProbeIntervalMs: 1 });
  t.after(harness.cleanup);
  await assert.rejects(
    waitForHarnessStatus(harness),
    /Timed out waiting for packaged daemon health.*Last status:[\s\S]*privacyService[\s\S]*starting/
  );
  assert.equal(harness.polls, 10);
});

test("reconnect fails immediately if the daemon supervisor exited", async (t) => {
  const harness = statusPollHarness([healthyStatus()], { running: false });
  t.after(harness.cleanup);
  await assert.rejects(waitForHarnessStatus(harness), /supervisor 123 exited/);
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

test("direct AppImage smoke gives CLI steps the AppImage installation identity", () => {
  const original = {
    APPIMAGE: process.env.APPIMAGE,
    APPDIR: process.env.APPDIR
  };
  try {
    process.env.APPIMAGE = "/inherited/Other.AppImage";
    process.env.APPDIR = "/inherited/mount";
    const plain = createSmokeEnv("/tmp/koed-home");
    assert.equal(plain.APPIMAGE, undefined);
    assert.equal(plain.APPDIR, undefined);
    setAppImageInstallationEnv({
      APPIMAGE: "/tmp/Koed.AppImage",
      APPDIR: "/tmp/extract/squashfs-root"
    });
    const direct = createSmokeEnv("/tmp/koed-home", { APPIMAGE: "/ignored" });
    assert.equal(direct.APPIMAGE, "/tmp/Koed.AppImage");
    assert.equal(direct.APPDIR, "/tmp/extract/squashfs-root");
  } finally {
    setAppImageInstallationEnv({});
    for (const [key, value] of Object.entries(original))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("withProcessEnv applies and restores process environment overrides", () => {
  const before = process.env.APPDIR;
  delete process.env.APPDIR;
  try {
    const restore = withProcessEnv({ APPDIR: "/tmp/extract/squashfs-root" });
    assert.equal(process.env.APPDIR, "/tmp/extract/squashfs-root");
    restore();
    assert.equal(process.env.APPDIR, undefined);
    assert.doesNotThrow(() => withProcessEnv({})());
  } finally {
    if (before === undefined) delete process.env.APPDIR;
    else process.env.APPDIR = before;
  }
});

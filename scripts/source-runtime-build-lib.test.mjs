import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";
import {
  acquireSourceRuntimeLock,
  calculateSourceRuntimeFingerprint,
  checkSourceRuntime,
  prepareSourceRuntime,
  reclaimStaleSourceRuntimeLock,
  releaseSourceRuntimeLease,
  releaseSourceRuntimeLock,
  resolveSourceRuntimeBuildPaths,
  resolveSourceRuntimePackageClosure
} from "./source-runtime-build-lib.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const write = (root, path, value = "") => {
  const target = resolve(root, path);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, value);
};

const createFixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-source-runtime-"));
  roots.push(root);
  const lock = "lockfileVersion: '9.0'\n";
  write(
    root,
    "package.json",
    `${JSON.stringify({ packageManager: "pnpm@11.1.2" })}\n`
  );
  write(root, "pnpm-lock.yaml", lock);
  write(root, "node_modules/.pnpm/lock.yaml", lock);
  write(
    root,
    "pnpm-workspace.yaml",
    'packages:\n  - "apps/*"\n  - "packages/*"\n'
  );
  write(root, "build-config.json", '{"target":"node"}\n');
  write(
    root,
    "apps/service/package.json",
    `${JSON.stringify({
      name: "@test/service",
      dependencies: { "@test/shared": "workspace:*" }
    })}\n`
  );
  write(root, "apps/service/src/index.ts", "export const value = 1;\n");
  write(
    root,
    "packages/shared/package.json",
    `${JSON.stringify({ name: "@test/shared" })}\n`
  );
  write(root, "packages/shared/src/index.ts", "export const shared = 1;\n");
  write(root, "assets/prompt.md", "prompt one\n");
  const spec = {
    rootPackages: ["@test/service"],
    extraInputs: [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "build-config.json",
      "assets"
    ],
    requiredOutputs: ["apps/service/dist/index.js"],
    copiedTrees: [{ source: "assets", output: "apps/service/dist/assets" }]
  };
  return { root, spec };
};

const options = (spec, extra = {}) => ({
  spec,
  pnpmVersion: "11.1.2",
  nodeVersion: "24.1.0",
  platform: "test",
  architecture: "test",
  identify: (pid) => `test-process:${pid}`,
  isRunning: (pid) => pid === process.pid,
  ...extra
});

const writeOutputs = (root) => {
  write(root, "apps/service/dist/index.js", "export const value = 1;\n");
  write(root, "apps/service/dist/assets/prompt.md", "prompt one\n");
};

test("resolves the transitive workspace package closure", () => {
  const { root, spec } = createFixture();
  assert.deepEqual(
    resolveSourceRuntimePackageClosure(root, spec).map((entry) => entry.name),
    ["@test/service", "@test/shared"]
  );
});

test("calculates a stable fingerprint and includes untracked inputs", () => {
  const { root, spec } = createFixture();
  const first = calculateSourceRuntimeFingerprint(root, options(spec));
  const second = calculateSourceRuntimeFingerprint(root, options(spec));
  assert.equal(first.fingerprint, second.fingerprint);

  write(root, "apps/service/src/untracked.ts", "export const added = true;\n");
  const changed = calculateSourceRuntimeFingerprint(root, options(spec));
  assert.notEqual(first.fingerprint, changed.fingerprint);
});

test("includes root configuration and copied assets", () => {
  const { root, spec } = createFixture();
  const first = calculateSourceRuntimeFingerprint(root, options(spec));
  write(root, "build-config.json", '{"target":"browser"}\n');
  const configChanged = calculateSourceRuntimeFingerprint(root, options(spec));
  assert.notEqual(first.fingerprint, configChanged.fingerprint);

  write(root, "assets/prompt.md", "prompt two\n");
  const assetChanged = calculateSourceRuntimeFingerprint(root, options(spec));
  assert.notEqual(configChanged.fingerprint, assetChanged.fingerprint);
});

test("builds once and skips a current runtime", async () => {
  const { root, spec } = createFixture();
  let builds = 0;
  const runBuild = () => {
    builds += 1;
    writeOutputs(root);
  };
  const first = await prepareSourceRuntime(root, options(spec, { runBuild }));
  const second = await prepareSourceRuntime(root, options(spec, { runBuild }));
  assert.equal(first.state, "built");
  assert.equal(second.state, "current");
  assert.equal(builds, 1);
});

test("keeps the dirty marker after a failed build and source revert", async () => {
  const { root, spec } = createFixture();
  await prepareSourceRuntime(
    root,
    options(spec, { runBuild: () => writeOutputs(root) })
  );
  const manifestPath = resolveSourceRuntimeBuildPaths(root).manifestPath;
  const previousManifest = readFileSync(manifestPath, "utf8");
  const originalSource = readFileSync(
    resolve(root, "apps/service/src/index.ts"),
    "utf8"
  );
  write(root, "apps/service/src/index.ts", "export const value = 2;\n");

  await assert.rejects(
    prepareSourceRuntime(
      root,
      options(spec, {
        runBuild: () => {
          write(root, "apps/service/dist/index.js", "partial\n");
          throw new Error("compile failed");
        }
      })
    ),
    /compile failed/
  );
  write(root, "apps/service/src/index.ts", originalSource);

  assert.equal(readFileSync(manifestPath, "utf8"), previousManifest);
  assert.equal(
    existsSync(resolveSourceRuntimeBuildPaths(root).dirtyPath),
    true
  );
  await assert.rejects(
    checkSourceRuntime(root, options(spec)),
    /do not match the current checkout/
  );
});

test("does not publish a manifest when inputs change during the build", async () => {
  const { root, spec } = createFixture();
  await assert.rejects(
    prepareSourceRuntime(
      root,
      options(spec, {
        runBuild: () => {
          writeOutputs(root);
          write(root, "apps/service/src/index.ts", "export const value = 3;\n");
        }
      })
    ),
    /inputs changed during the build/
  );
  const paths = resolveSourceRuntimeBuildPaths(root);
  assert.equal(existsSync(paths.manifestPath), false);
  assert.equal(existsSync(paths.dirtyPath), true);
});

test("treats malformed manifests and missing outputs as stale", async () => {
  const { root, spec } = createFixture();
  await prepareSourceRuntime(
    root,
    options(spec, { runBuild: () => writeOutputs(root) })
  );
  const paths = resolveSourceRuntimeBuildPaths(root);
  write(
    root,
    "node_modules/.cache/koed/source-runtime-build.json",
    "bad json\n"
  );
  await assert.rejects(
    checkSourceRuntime(root, options(spec)),
    /do not match the current checkout/
  );

  await prepareSourceRuntime(
    root,
    options(spec, { runBuild: () => writeOutputs(root) })
  );
  rmSync(resolve(root, "apps/service/dist/index.js"));
  await assert.rejects(
    checkSourceRuntime(root, options(spec)),
    /Missing: apps\/service\/dist\/index.js/
  );
  assert.equal(existsSync(paths.dirtyPath), false);
});

test("blocks a stale build while a live supervisor lease exists", async () => {
  const { root, spec } = createFixture();
  await prepareSourceRuntime(
    root,
    options(spec, { runBuild: () => writeOutputs(root) })
  );
  await checkSourceRuntime(root, options(spec, { leasePid: process.pid }));
  write(root, "apps/service/src/index.ts", "export const value = 4;\n");
  await assert.rejects(
    prepareSourceRuntime(
      root,
      options(spec, { runBuild: () => writeOutputs(root) })
    ),
    /source supervisor is using them/
  );
  assert.equal(
    await releaseSourceRuntimeLease(root, process.pid, options(spec)),
    true
  );
});

test("fails when installed dependencies do not match the checkout", () => {
  const { root, spec } = createFixture();
  write(root, "node_modules/.pnpm/lock.yaml", "different\n");
  assert.throws(
    () => calculateSourceRuntimeFingerprint(root, options(spec)),
    /Run: pnpm install/
  );
});

test("uses an exclusive preparation lock", async () => {
  const { root } = createFixture();
  const lockOptions = {
    identify: (pid) => `test-process:${pid}`,
    isRunning: (pid) => pid === process.pid
  };
  const first = await acquireSourceRuntimeLock(root, lockOptions);
  try {
    await assert.rejects(
      acquireSourceRuntimeLock(root, {
        ...lockOptions,
        timeoutMs: 20,
        pollIntervalMs: 5
      }),
      /Timed out/
    );
  } finally {
    assert.equal(releaseSourceRuntimeLock(first), true);
  }
});

test("reclaims a stale lock without deleting its replacement", () => {
  const { root } = createFixture();
  const paths = resolveSourceRuntimeBuildPaths(root);
  mkdirSync(paths.lockDir, { recursive: true });
  const staleOwner = {
    pid: 41,
    processIdentity: "stale-process",
    acquiredAt: "2026-08-27T00:00:00.000Z"
  };
  writeFileSync(
    resolve(paths.lockDir, "owner.json"),
    `${JSON.stringify(staleOwner)}\n`
  );

  const replacement = {
    pid: 42,
    processIdentity: "replacement-process",
    acquiredAt: "2026-08-27T00:00:01.000Z"
  };
  const staleObservation = { owner: staleOwner };
  assert.equal(
    reclaimStaleSourceRuntimeLock(paths.lockDir, staleObservation),
    true
  );
  mkdirSync(paths.lockDir);
  writeFileSync(
    resolve(paths.lockDir, "owner.json"),
    `${JSON.stringify(replacement)}\n`
  );

  assert.equal(
    reclaimStaleSourceRuntimeLock(paths.lockDir, staleObservation),
    false
  );
  assert.deepEqual(
    JSON.parse(readFileSync(resolve(paths.lockDir, "owner.json"), "utf8")),
    replacement
  );
});

test("configures Desktop preparation before Electron startup", () => {
  const repoRoot = resolve(import.meta.dirname, "..");
  const rootManifest = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8")
  );
  const desktopManifest = JSON.parse(
    readFileSync(resolve(repoRoot, "apps/desktop/package.json"), "utf8")
  );
  assert.equal(
    rootManifest.scripts["source-runtime:prepare"],
    "node scripts/source-runtime-build.mjs prepare"
  );
  assert.equal(
    rootManifest.scripts["source-runtime:check"],
    "node scripts/source-runtime-build.mjs check"
  );
  assert.equal(
    desktopManifest.scripts.prestart,
    "pnpm --filter @koed/koed-server build && pnpm -w source-runtime:prepare"
  );
  assert.equal(desktopManifest.scripts.start, "pnpm build && electron .");
});

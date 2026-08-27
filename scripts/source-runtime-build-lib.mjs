import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { hostname } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

export const SOURCE_RUNTIME_SCHEMA_VERSION = 1;

export const SOURCE_RUNTIME_BUILD_SPEC = Object.freeze({
  rootPackages: [
    "@koed/api",
    "@koed/worker",
    "@koed/mcp-server",
    "@koed/embedding-service",
    "@koed/privacy-service"
  ],
  extraInputs: [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "prompts",
    "scripts/source-runtime-build-lib.mjs",
    "scripts/source-runtime-build.mjs"
  ],
  requiredOutputs: [
    "apps/api/dist/index.js",
    "apps/api/dist/browser-approval/index.html",
    "apps/worker/dist/index.js",
    "apps/embedding-service/dist/index.js",
    "apps/privacy-service/dist/index.js",
    "packages/mcp-server/dist/cli.js",
    "packages/mcp-server/dist/local-runtime-cli.js",
    "packages/mcp-server/dist/capture-hook.js"
  ],
  copiedTrees: [
    { source: "prompts", output: "packages/mcp-server/dist/prompts" }
  ]
});

const CACHE_RELATIVE_PATH = "node_modules/.cache/koed";
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".venv",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "release",
  "reports"
]);
const IGNORED_FILES = new Set([".DS_Store"]);

const normalizePath = (value) => value.split(sep).join("/");

export const resolveSourceRuntimeBuildPaths = (repoRoot) => {
  const cacheDir = resolve(repoRoot, CACHE_RELATIVE_PATH);
  return {
    cacheDir,
    manifestPath: resolve(cacheDir, "source-runtime-build.json"),
    dirtyPath: resolve(cacheDir, "source-runtime-build.dirty"),
    lockDir: resolve(cacheDir, "source-runtime-build.lock"),
    leasesDir: resolve(cacheDir, "source-runtime-build.leases")
  };
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const writeAtomic = (path, value, mode = 0o600) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, value, { mode });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
};

const processIsRunning = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

export const resolveProcessIdentity = (pid) => {
  if (!processIsRunning(pid)) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fields = stat
        .slice(commandEnd + 2)
        .trim()
        .split(/\s+/);
      const startTime = fields[19];
      if (!startTime) return null;
      const bootId = readFileSync(
        "/proc/sys/kernel/random/boot_id",
        "utf8"
      ).trim();
      return `${hostname()}:linux:${bootId}:${startTime}`;
    }
    if (process.platform === "win32") {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
        ],
        { encoding: "utf8", windowsHide: true, timeout: 2_000 }
      );
      const startedAt = result.status === 0 ? result.stdout.trim() : "";
      return startedAt ? `${hostname()}:win32:${startedAt}` : null;
    }
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000
    });
    const startedAt = result.status === 0 ? result.stdout.trim() : "";
    return startedAt ? `${hostname()}:${process.platform}:${startedAt}` : null;
  } catch {
    return null;
  }
};

const ownerIsLive = (
  owner,
  isRunning = processIsRunning,
  identify = resolveProcessIdentity
) => {
  if (
    !owner ||
    !Number.isInteger(owner.pid) ||
    typeof owner.processIdentity !== "string"
  ) {
    return false;
  }
  if (!isRunning(owner.pid)) return false;
  const identity = identify(owner.pid);
  return identity === null || identity === owner.processIdentity;
};

const wait = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

export const reclaimStaleSourceRuntimeLock = (lockDir, observation) => {
  const serializedObservation = JSON.stringify(observation);
  const quarantineId = createHash("sha256")
    .update(serializedObservation)
    .digest("hex")
    .slice(0, 24);
  // Keep one non-empty tombstone per stale ownership generation. A delayed
  // contender then collides with this path instead of moving a replacement lock.
  const quarantinePath = `${lockDir}.stale.${quarantineId}`;
  try {
    writeFileSync(
      resolve(lockDir, "reclaim-observation.json"),
      `${serializedObservation}\n`,
      { flag: "wx", mode: 0o600 }
    );
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.code !== "EEXIST") throw error;
  }
  try {
    renameSync(lockDir, quarantinePath);
  } catch (error) {
    if (["EEXIST", "ENOENT", "ENOTEMPTY"].includes(error?.code)) return false;
    throw error;
  }
  return true;
};

export const acquireSourceRuntimeLock = async (
  repoRoot,
  {
    timeoutMs = 300_000,
    pollIntervalMs = 100,
    pid = process.pid,
    now = () => new Date(),
    isRunning = processIsRunning,
    identify = resolveProcessIdentity
  } = {}
) => {
  const paths = resolveSourceRuntimeBuildPaths(repoRoot);
  mkdirSync(paths.cacheDir, { recursive: true });
  const processIdentity = identify(pid);
  if (!processIdentity) {
    throw new Error(`Could not resolve process identity for PID ${pid}.`);
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      mkdirSync(paths.lockDir);
      writeAtomic(
        resolve(paths.lockDir, "owner.json"),
        `${JSON.stringify(
          {
            pid,
            processIdentity,
            acquiredAt: now().toISOString()
          },
          null,
          2
        )}\n`
      );
      return { ...paths, pid, processIdentity };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const ownerPath = resolve(paths.lockDir, "owner.json");
    const owner = readJson(ownerPath);
    if (!owner) {
      try {
        const metadata = statSync(paths.lockDir);
        const ageMs = Date.now() - metadata.mtimeMs;
        if (ageMs > 5_000)
          reclaimStaleSourceRuntimeLock(paths.lockDir, {
            owner: null,
            device: metadata.dev,
            inode: metadata.ino,
            createdAt: metadata.birthtimeMs,
            modifiedAt: metadata.mtimeMs
          });
      } catch {
        continue;
      }
    } else if (!ownerIsLive(owner, isRunning, identify)) {
      reclaimStaleSourceRuntimeLock(paths.lockDir, { owner });
    }
    await wait(pollIntervalMs);
  }
  throw new Error("Timed out while waiting for the source-runtime lock.");
};

export const releaseSourceRuntimeLock = (lock) => {
  const owner = readJson(resolve(lock.lockDir, "owner.json"));
  if (
    owner?.pid !== lock.pid ||
    owner?.processIdentity !== lock.processIdentity
  ) {
    return false;
  }
  rmSync(lock.lockDir, { recursive: true, force: true });
  return true;
};

const workspacePackages = (repoRoot) => {
  const result = new Map();
  for (const parent of ["apps", "packages"]) {
    const parentPath = resolve(repoRoot, parent);
    if (!existsSync(parentPath)) continue;
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packagePath = resolve(parentPath, entry.name);
      const manifestPath = resolve(packagePath, "package.json");
      const manifest = readJson(manifestPath);
      if (typeof manifest?.name !== "string") continue;
      result.set(manifest.name, {
        name: manifest.name,
        path: packagePath,
        relativePath: normalizePath(relative(repoRoot, packagePath)),
        manifest
      });
    }
  }
  return result;
};

export const resolveSourceRuntimePackageClosure = (
  repoRoot,
  spec = SOURCE_RUNTIME_BUILD_SPEC
) => {
  const packages = workspacePackages(repoRoot);
  const queue = [...spec.rootPackages];
  const selected = new Map();
  while (queue.length > 0) {
    const name = queue.shift();
    if (selected.has(name)) continue;
    const workspacePackage = packages.get(name);
    if (!workspacePackage) {
      throw new Error(`Source-runtime package is missing: ${name}.`);
    }
    selected.set(name, workspacePackage);
    for (const group of [
      "dependencies",
      "devDependencies",
      "optionalDependencies"
    ]) {
      for (const [dependencyName, version] of Object.entries(
        workspacePackage.manifest[group] ?? {}
      )) {
        if (String(version).startsWith("workspace:"))
          queue.push(dependencyName);
      }
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
};

const includeFile = (path) => {
  const name = path.split(sep).at(-1) ?? "";
  return (
    !IGNORED_FILES.has(name) &&
    name !== ".env" &&
    !name.startsWith(".env.") &&
    !name.endsWith(".tsbuildinfo")
  );
};

const collectPath = (repoRoot, absolutePath, files) => {
  if (!existsSync(absolutePath)) {
    throw new Error(
      `Source-runtime build input is missing: ${normalizePath(relative(repoRoot, absolutePath))}.`
    );
  }
  const metadata = lstatSync(absolutePath);
  if (metadata.isSymbolicLink()) {
    files.set(
      normalizePath(relative(repoRoot, absolutePath)),
      Buffer.from(`symlink:${readlinkSync(absolutePath)}`, "utf8")
    );
    return;
  }
  if (metadata.isFile()) {
    if (includeFile(absolutePath)) {
      files.set(
        normalizePath(relative(repoRoot, absolutePath)),
        readFileSync(absolutePath)
      );
    }
    return;
  }
  if (!metadata.isDirectory()) return;
  for (const entry of readdirSync(absolutePath, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name)
  )) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    collectPath(repoRoot, resolve(absolutePath, entry.name), files);
  }
};

const configuredPnpmVersion = (repoRoot) => {
  const manifest = readJson(resolve(repoRoot, "package.json"));
  const match = /^pnpm@(.+)$/.exec(String(manifest?.packageManager ?? ""));
  if (!match) throw new Error("The root packageManager must configure pnpm.");
  return match[1];
};

const activePnpmVersion = () => {
  const result = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("Could not read the active pnpm version.");
  }
  return result.stdout.trim();
};

export const verifySourceRuntimeToolchain = (
  repoRoot,
  { pnpmVersion = activePnpmVersion() } = {}
) => {
  const configuredVersion = configuredPnpmVersion(repoRoot);
  if (pnpmVersion !== configuredVersion) {
    throw new Error(
      `The active pnpm version is ${pnpmVersion}. This checkout requires ${configuredVersion}.`
    );
  }
  const checkoutLock = resolve(repoRoot, "pnpm-lock.yaml");
  const installedLock = resolve(repoRoot, "node_modules/.pnpm/lock.yaml");
  if (
    !existsSync(installedLock) ||
    !readFileSync(checkoutLock).equals(readFileSync(installedLock))
  ) {
    throw new Error(
      "Workspace dependencies do not match pnpm-lock.yaml. Run: pnpm install"
    );
  }
  return configuredVersion;
};

const updateFramed = (hash, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
};

export const calculateSourceRuntimeFingerprint = (
  repoRoot,
  {
    spec = SOURCE_RUNTIME_BUILD_SPEC,
    pnpmVersion,
    nodeVersion = process.versions.node,
    platform = process.platform,
    architecture = process.arch
  } = {}
) => {
  const configuredVersion = verifySourceRuntimeToolchain(repoRoot, {
    ...(pnpmVersion ? { pnpmVersion } : {})
  });
  const packages = resolveSourceRuntimePackageClosure(repoRoot, spec);
  const files = new Map();
  for (const workspacePackage of packages) {
    collectPath(repoRoot, workspacePackage.path, files);
  }
  for (const input of spec.extraInputs) {
    collectPath(repoRoot, resolve(repoRoot, input), files);
  }

  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);
  if (!Number.isInteger(nodeMajor)) {
    throw new Error(`Invalid Node.js version: ${nodeVersion}.`);
  }
  const metadata = {
    schemaVersion: SOURCE_RUNTIME_SCHEMA_VERSION,
    nodeMajor,
    pnpmVersion: configuredVersion,
    platform,
    architecture
  };
  const hash = createHash("sha256");
  updateFramed(hash, JSON.stringify(metadata));
  for (const [path, content] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    updateFramed(hash, path);
    updateFramed(hash, content);
  }
  return {
    ...metadata,
    fingerprint: `sha256:${hash.digest("hex")}`,
    packages,
    fileCount: files.size
  };
};

const requiredOutputPaths = (repoRoot, spec) => {
  const outputs = spec.requiredOutputs.map((path) => resolve(repoRoot, path));
  for (const tree of spec.copiedTrees ?? []) {
    const sourceFiles = new Map();
    collectPath(repoRoot, resolve(repoRoot, tree.source), sourceFiles);
    for (const sourcePath of sourceFiles.keys()) {
      const childPath = normalizePath(relative(tree.source, sourcePath));
      outputs.push(resolve(repoRoot, tree.output, childPath));
    }
  }
  return outputs;
};

const validManifest = (value) =>
  value &&
  value.schemaVersion === SOURCE_RUNTIME_SCHEMA_VERSION &&
  typeof value.fingerprint === "string" &&
  typeof value.createdAt === "string" &&
  Number.isInteger(value.nodeMajor) &&
  typeof value.pnpmVersion === "string" &&
  typeof value.platform === "string" &&
  typeof value.architecture === "string" &&
  Array.isArray(value.rootPackages) &&
  Number.isInteger(value.packageCount) &&
  Number.isInteger(value.fileCount);

export const inspectSourceRuntime = (repoRoot, options = {}) => {
  const spec = options.spec ?? SOURCE_RUNTIME_BUILD_SPEC;
  const paths = resolveSourceRuntimeBuildPaths(repoRoot);
  const calculated = calculateSourceRuntimeFingerprint(repoRoot, options);
  const manifestValue = readJson(paths.manifestPath);
  const missingOutputs = requiredOutputPaths(repoRoot, spec)
    .filter((path) => !existsSync(path))
    .map((path) => normalizePath(relative(repoRoot, path)));
  let reason = null;
  if (existsSync(paths.dirtyPath)) reason = "dirty";
  else if (!existsSync(paths.manifestPath)) reason = "missing_manifest";
  else if (!validManifest(manifestValue)) reason = "malformed_manifest";
  else if (manifestValue.fingerprint !== calculated.fingerprint)
    reason = "fingerprint_mismatch";
  else if (missingOutputs.length > 0) reason = "missing_outputs";
  return {
    current: reason === null,
    reason,
    missingOutputs,
    calculated,
    manifest: validManifest(manifestValue) ? manifestValue : null,
    paths
  };
};

const cleanAndListLiveLeases = (
  paths,
  { isRunning = processIsRunning, identify = resolveProcessIdentity } = {}
) => {
  mkdirSync(paths.leasesDir, { recursive: true });
  const live = [];
  for (const entry of readdirSync(paths.leasesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const leasePath = resolve(paths.leasesDir, entry.name);
    const lease = readJson(leasePath);
    if (ownerIsLive(lease, isRunning, identify)) live.push(lease);
    else rmSync(leasePath, { force: true });
  }
  return live;
};

const createLease = (paths, pid, identify = resolveProcessIdentity) => {
  const processIdentity = identify(pid);
  if (!processIdentity) {
    throw new Error(`Could not resolve process identity for PID ${pid}.`);
  }
  mkdirSync(paths.leasesDir, { recursive: true });
  writeAtomic(
    resolve(paths.leasesDir, `${pid}.json`),
    `${JSON.stringify(
      { pid, processIdentity, acquiredAt: new Date().toISOString() },
      null,
      2
    )}\n`
  );
};

export const releaseSourceRuntimeLease = async (
  repoRoot,
  pid,
  options = {}
) => {
  const lock = await acquireSourceRuntimeLock(repoRoot, options);
  try {
    const leasePath = resolve(lock.leasesDir, `${pid}.json`);
    const lease = readJson(leasePath);
    const processIdentity = (options.identify ?? resolveProcessIdentity)(pid);
    if (lease?.pid === pid && lease.processIdentity === processIdentity) {
      rmSync(leasePath, { force: true });
      return true;
    }
    return false;
  } finally {
    releaseSourceRuntimeLock(lock);
  }
};

const manifestFor = (state, spec, now) => ({
  schemaVersion: SOURCE_RUNTIME_SCHEMA_VERSION,
  fingerprint: state.calculated.fingerprint,
  createdAt: now().toISOString(),
  nodeMajor: state.calculated.nodeMajor,
  pnpmVersion: state.calculated.pnpmVersion,
  platform: state.calculated.platform,
  architecture: state.calculated.architecture,
  rootPackages: [...spec.rootPackages],
  packageCount: state.calculated.packages.length,
  fileCount: state.calculated.fileCount
});

const defaultBuild = (repoRoot, spec) => {
  const args = spec.rootPackages.flatMap((name) => ["--filter", `${name}...`]);
  args.push("build");
  const result = spawnSync("pnpm", args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Source-runtime build failed with exit code ${result.status ?? 1}.`
    );
  }
};

export const prepareSourceRuntime = async (
  repoRoot,
  {
    spec = SOURCE_RUNTIME_BUILD_SPEC,
    runBuild = defaultBuild,
    now = () => new Date(),
    ...options
  } = {}
) => {
  const lock = await acquireSourceRuntimeLock(repoRoot, options);
  try {
    const before = inspectSourceRuntime(repoRoot, { ...options, spec });
    if (before.current) return { state: "current", ...before };
    const liveLeases = cleanAndListLiveLeases(before.paths, options);
    if (liveLeases.length > 0) {
      throw new Error(
        "Source runtime artifacts are stale, but a source supervisor is using them. Stop the source koed-server, then run: pnpm source-runtime:prepare"
      );
    }
    writeAtomic(
      before.paths.dirtyPath,
      `${JSON.stringify(
        {
          pid: process.pid,
          startedAt: now().toISOString(),
          reason: before.reason
        },
        null,
        2
      )}\n`
    );
    runBuild(repoRoot, spec);
    const after = inspectSourceRuntime(repoRoot, { ...options, spec });
    if (before.calculated.fingerprint !== after.calculated.fingerprint) {
      throw new Error(
        "Source-runtime inputs changed during the build. Run: pnpm source-runtime:prepare"
      );
    }
    if (after.missingOutputs.length > 0) {
      throw new Error(
        `Source-runtime build outputs are missing: ${after.missingOutputs.join(", ")}.`
      );
    }
    const manifest = manifestFor(after, spec, now);
    writeAtomic(
      after.paths.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    rmSync(after.paths.dirtyPath, { force: true });
    return { state: "built", ...after, manifest, current: true, reason: null };
  } finally {
    releaseSourceRuntimeLock(lock);
  }
};

export const checkSourceRuntime = async (
  repoRoot,
  { leasePid, ...options } = {}
) => {
  const lock = await acquireSourceRuntimeLock(repoRoot, options);
  try {
    const state = inspectSourceRuntime(repoRoot, options);
    if (!state.current) {
      const detail =
        state.missingOutputs.length > 0
          ? ` Missing: ${state.missingOutputs.join(", ")}.`
          : "";
      throw new Error(
        `Source runtime artifacts do not match the current checkout.${detail} Run: pnpm source-runtime:prepare`
      );
    }
    cleanAndListLiveLeases(state.paths, options);
    if (leasePid !== undefined) {
      createLease(
        state.paths,
        leasePid,
        options.identify ?? resolveProcessIdentity
      );
    }
    return { state: "current", ...state };
  } finally {
    releaseSourceRuntimeLock(lock);
  }
};

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { RuntimeOwner, VerifiedGeneration } from "./component-contract.js";
import {
  resolveDesktopRuntimeOwner,
  validateDesktopRuntimeCapability,
  verifyDesktopRuntimeBundle,
  type DesktopRuntimeCapability
} from "./desktop-runtime-capability.js";
import type { KoedServerPaths } from "./paths.js";
import { readStagedGeneration } from "./component-store.js";
import {
  readSupervisorLock,
  resolveProcessIdentity
} from "./supervisor-lock.js";
import {
  isRuntimeGenerationState,
  type RuntimeGenerationState
} from "./runtime-state.js";
import { assertPackageMigrationCompatible } from "./package-runtime.js";
import { renameAtomically } from "./generation-lifecycle-filesystem.js";
import { acquireDirectoryLock } from "./directory-lock.js";

interface LifecycleLockRecord {
  pid: number;
  processIdentity: string;
  token: string;
}

const generationStatePath = (paths: KoedServerPaths): string =>
  paths.generationStatePath ?? resolve(paths.runDir, "runtime-generation.json");
const lockPath = (paths: KoedServerPaths): string =>
  resolve(paths.runDir, "generation-lifecycle.lock");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const readRegularFile = (path: string): string => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("runtime lifecycle state is not a regular file");
  return readFileSync(path, "utf8");
};
const sameOwner = (left: RuntimeOwner, right: RuntimeOwner): boolean =>
  left.kind === right.kind && left.installationId === right.installationId;
const assertDirectoryChain = (base: string, target: string): void => {
  const relativePath = relative(resolve(base), resolve(target));
  if (relativePath.startsWith("..") || isAbsolute(relativePath))
    throw new Error("runtime lifecycle path escaped KOED_HOME");
  const absolute = resolve(target);
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(
          "runtime lifecycle path contains a symbolic link or non-directory"
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
};
const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
const readLockRecord = (path: string): LifecycleLockRecord | null => {
  try {
    const parsed: unknown = JSON.parse(
      readRegularFile(resolve(path, "owner.json"))
    );
    if (!isRecord(parsed)) return null;
    const record = parsed;
    if (
      Object.keys(record).length !== 3 ||
      typeof record.pid !== "number" ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.processIdentity !== "string" ||
      record.processIdentity.length === 0 ||
      typeof record.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.token)
    )
      return null;
    return {
      pid: Number(record.pid),
      processIdentity: record.processIdentity,
      token: record.token
    };
  } catch {
    return null;
  }
};
const acquireLifecycleLock = (paths: KoedServerPaths): LifecycleLockRecord => {
  assertDirectoryChain(paths.koedHome, paths.runDir);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  assertDirectoryChain(paths.koedHome, paths.runDir);
  const path = lockPath(paths);
  assertDirectoryChain(paths.koedHome, path);
  const identity = resolveProcessIdentity(process.pid);
  if (!identity) throw new Error("runtime process identity is unavailable");
  const record = {
    pid: process.pid,
    processIdentity: identity,
    token: randomBytes(32).toString("hex")
  };
  try {
    mkdirSync(path, { mode: 0o700 });
    assertDirectoryChain(paths.koedHome, path);
    writeFileSync(resolve(path, "owner.json"), `${JSON.stringify(record)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      "runtime lifecycle is locked; stale locks require stopped-runtime operator recovery",
      { cause: error }
    );
  }
};
const releaseLifecycleLock = (
  paths: KoedServerPaths,
  expected: LifecycleLockRecord
): void => {
  const path = lockPath(paths);
  const actual = readLockRecord(path);
  if (
    !actual ||
    actual.pid !== expected.pid ||
    actual.token !== expected.token ||
    actual.processIdentity !== expected.processIdentity
  )
    return;
  rmSync(path, { recursive: true, force: true });
};
const withStoreLock = async <T>(
  paths: KoedServerPaths,
  action: () => Promise<T>
): Promise<T> => {
  assertDirectoryChain(paths.koedHome, paths.componentsDir);
  mkdirSync(paths.componentsDir, { recursive: true, mode: 0o700 });
  assertDirectoryChain(paths.koedHome, paths.componentsDir);
  const lockPath = `${paths.componentsDir}.lock`;
  assertDirectoryChain(paths.koedHome, lockPath);
  const release = acquireDirectoryLock(lockPath);
  try {
    return await action();
  } finally {
    release();
  }
};
const readCurrentId = (paths: KoedServerPaths): string | null => {
  assertDirectoryChain(paths.koedHome, paths.componentsDir);
  const pointerPath = resolve(paths.componentsDir, "current.json");
  if (!existsSync(pointerPath)) return null;
  const value: unknown = JSON.parse(readRegularFile(pointerPath));
  if (!isRecord(value))
    throw new Error("current generation pointer is invalid");
  const pointer = value;
  if (
    Object.keys(pointer).length !== 2 ||
    pointer.schemaVersion !== 1 ||
    typeof pointer.generationId !== "string" ||
    !/^[a-f0-9]{64}$/.test(pointer.generationId)
  )
    throw new Error("current generation pointer is invalid");
  return pointer.generationId;
};
const writeCurrentPointer = (paths: KoedServerPaths, id: string): void => {
  const pointer = resolve(paths.componentsDir, "current.json");
  const temporary = resolve(
    dirname(pointer),
    `.current-${randomBytes(8).toString("hex")}.tmp`
  );
  writeFileSync(
    temporary,
    `${JSON.stringify({ schemaVersion: 1, generationId: id })}\n`,
    { flag: "wx", mode: 0o600 }
  );
  try {
    renameAtomically(temporary, pointer);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};
const readPinState = (
  paths: KoedServerPaths
): RuntimeGenerationState | null => {
  const path = generationStatePath(paths);
  assertDirectoryChain(paths.koedHome, dirname(path));
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readRegularFile(path));
  if (!isRuntimeGenerationState(parsed))
    throw new Error("runtime generation state is invalid");
  return parsed;
};
const assertOwner = (
  generation: VerifiedGeneration,
  requester: RuntimeOwner
): void => {
  if (!sameOwner(generation.owner, requester))
    throw new Error("runtime owner mismatch");
};
const assertNoActivePin = (paths: KoedServerPaths): void => {
  const pin = readPinState(paths);
  if (pin) {
    const identity = resolveProcessIdentity(pin.pid);
    if (
      identity === pin.processIdentity ||
      (!identity && processIsRunning(pin.pid))
    )
      throw new Error("runtime generation is running or pinned");
    rmSync(generationStatePath(paths), { force: true });
  }
  const supervisorPath = resolve(paths.runDir, "koed-server.lock");
  if (!existsSync(supervisorPath)) return;
  const supervisor = readSupervisorLock(supervisorPath);
  if (!supervisor) throw new Error("supervisor liveness is uncertain");
  const identity = resolveProcessIdentity(supervisor.pid);
  if (
    identity === supervisor.processIdentity ||
    (!identity && processIsRunning(supervisor.pid)) ||
    (!supervisor.processIdentity && processIsRunning(supervisor.pid))
  )
    throw new Error("runtime generation is running or pinned");
};
const currentManifest = (generation: VerifiedGeneration) => ({
  schemaVersion: 2 as const,
  id: "koed-server" as const,
  version: generation.productVersion,
  platform: generation.base.manifest.target.platform,
  architecture: generation.base.manifest.target.architecture,
  packageKind: "app-runtime" as const,
  createdAt: "1970-01-01T00:00:00.000Z"
});

export async function readCurrentGeneration(
  paths: KoedServerPaths
): Promise<VerifiedGeneration> {
  const id = readCurrentId(paths);
  if (!id) throw new Error("no active runtime generation");
  return readStagedGeneration(paths, id);
}

export async function readCurrentGenerationForOwner(
  paths: KoedServerPaths,
  requester: RuntimeOwner
): Promise<VerifiedGeneration> {
  const generation = await readCurrentGeneration(paths);
  assertOwner(generation, requester);
  return generation;
}

const persistPinState = (
  paths: KoedServerPaths,
  generation: VerifiedGeneration,
  requester: RuntimeOwner,
  lock: LifecycleLockRecord,
  source: "signed-store" | "desktop-bundle" = "signed-store"
): { path: string; processIdentity: string } => {
  const processIdentity = resolveProcessIdentity(process.pid);
  if (!processIdentity)
    throw new Error("runtime process identity is unavailable");
  const state: RuntimeGenerationState = {
    schemaVersion: 1,
    generationId: generation.id,
    pid: process.pid,
    processIdentity,
    startedAt: new Date().toISOString(),
    owner: requester,
    pinToken: lock.token,
    ...(source === "desktop-bundle" ? { source } : {})
  };
  const path = generationStatePath(paths);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${lock.token}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  renameSync(temporary, path);
  return { path, processIdentity };
};
const createPinRelease = (
  paths: KoedServerPaths,
  lock: LifecycleLockRecord,
  pinPath: string,
  processIdentity: string
): (() => Promise<void>) => {
  let released = false;
  return () =>
    Promise.resolve().then(() => {
      if (released) return;
      released = true;
      try {
        const current = readPinState(paths);
        if (
          current?.pinToken === lock.token &&
          current.processIdentity === processIdentity
        )
          rmSync(pinPath, { force: true });
      } finally {
        releaseLifecycleLock(paths, lock);
      }
    });
};

export async function readDesktopBundleGeneration(
  paths: KoedServerPaths,
  capability: DesktopRuntimeCapability
): Promise<VerifiedGeneration> {
  if (!validateDesktopRuntimeCapability(capability))
    throw new Error("validated private Desktop runtime capability is required");
  const currentCapability = verifyDesktopRuntimeBundle(
    capability.resourcesPath
  );
  if (
    currentCapability.productVersion !== capability.productVersion ||
    currentCapability.bundleDigest !== capability.bundleDigest
  )
    throw new Error("Desktop runtime bundle changed after verification");
  const owner = resolveDesktopRuntimeOwner(capability, paths.koedHome);
  const generation = desktopBundleGeneration(currentCapability, owner);
  return generation;
}

export async function pinDesktopBundleGenerationForStart(
  paths: KoedServerPaths,
  capability: DesktopRuntimeCapability
): Promise<{ generation: VerifiedGeneration; release(): Promise<void> }> {
  if (!validateDesktopRuntimeCapability(capability))
    throw new Error("validated private Desktop runtime capability is required");
  const requester = resolveDesktopRuntimeOwner(capability, paths.koedHome);
  const lock = acquireLifecycleLock(paths);
  try {
    return await withStoreLock(paths, async () => {
      assertNoActivePin(paths);
      const bundled = await readDesktopBundleGeneration(paths, capability);
      const activeId = readCurrentId(paths);
      const active = activeId
        ? await readStagedGeneration(paths, activeId)
        : null;
      const generation =
        active &&
        sameOwner(active.owner, requester) &&
        active.productVersion === bundled.productVersion &&
        active.base.manifestDigest === bundled.base.manifestDigest
          ? active
          : bundled;
      if (activeId !== generation.id) writeCurrentPointer(paths, generation.id);
      const pin = persistPinState(
        paths,
        generation,
        requester,
        lock,
        "desktop-bundle"
      );
      return {
        generation,
        release: createPinRelease(paths, lock, pin.path, pin.processIdentity)
      };
    });
  } catch (error) {
    releaseLifecycleLock(paths, lock);
    throw error;
  }
}

const desktopBundleGeneration = (
  capability: DesktopRuntimeCapability,
  owner: RuntimeOwner
): VerifiedGeneration => {
  const manifest = capability.manifest;
  const id = createHash("sha256")
    .update(`${owner.installationId}\n${capability.bundleDigest}`)
    .digest("hex");
  return {
    id,
    productVersion: capability.productVersion,
    base: {
      manifest: manifest as unknown as VerifiedGeneration["base"]["manifest"],
      root: resolve(capability.resourcesPath, "koed-runtime"),
      manifestDigest: capability.bundleDigest
    },
    owner
  };
};

export async function pinGenerationForStart(
  paths: KoedServerPaths,
  requester: RuntimeOwner
): Promise<{ generation: VerifiedGeneration; release(): Promise<void> }> {
  const lock = acquireLifecycleLock(paths);
  try {
    return await withStoreLock(paths, async () => {
      assertNoActivePin(paths);
      const generation = await readCurrentGeneration(paths);
      assertOwner(generation, requester);
      const pin = persistPinState(paths, generation, requester, lock);
      return {
        generation,
        release: createPinRelease(paths, lock, pin.path, pin.processIdentity)
      };
    });
  } catch (error) {
    releaseLifecycleLock(paths, lock);
    throw error;
  }
}

export async function activateGeneration(
  paths: KoedServerPaths,
  id: string,
  requester: RuntimeOwner
): Promise<VerifiedGeneration> {
  const lock = acquireLifecycleLock(paths);
  try {
    return await withStoreLock(paths, async () => {
      assertNoActivePin(paths);
      const candidate = await readStagedGeneration(paths, id);
      assertOwner(candidate, requester);
      const currentId = readCurrentId(paths);
      if (currentId) {
        const current = await readStagedGeneration(paths, currentId);
        assertOwner(current, requester);
        assertPackageMigrationCompatible(
          currentManifest(current),
          currentManifest(candidate)
        );
      }
      writeCurrentPointer(paths, candidate.id);
      return candidate;
    });
  } finally {
    releaseLifecycleLock(paths, lock);
  }
}

interface VerifiedGenerationDirectory {
  id: string;
  path: string;
  mtime: number;
}
const listOwnedGenerations = async (
  paths: KoedServerPaths,
  requester: RuntimeOwner
): Promise<VerifiedGenerationDirectory[]> => {
  assertDirectoryChain(paths.koedHome, paths.generationsDir);
  let entries;
  try {
    entries = readdirSync(paths.generationsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => ({
      id: entry.name,
      path: resolve(paths.generationsDir, entry.name),
      mtime: statSync(resolve(paths.generationsDir, entry.name)).mtimeMs
    }))
    .sort(
      (left, right) =>
        right.mtime - left.mtime || left.id.localeCompare(right.id)
    );
  const verified: VerifiedGenerationDirectory[] = [];
  for (const entry of candidates) {
    try {
      const generation = await readStagedGeneration(paths, entry.id);
      if (sameOwner(generation.owner, requester)) verified.push(entry);
    } catch {
      // Invalid or untrusted generations are never cleanup targets.
    }
  }
  return verified;
};
const removeUnretainedGenerations = (
  generations: VerifiedGenerationDirectory[],
  retain: number,
  currentId: string | null
): string[] => {
  const kept = new Set(generations.slice(0, retain).map((entry) => entry.id));
  if (currentId) kept.add(currentId);
  const removed: string[] = [];
  for (const entry of generations) {
    if (kept.has(entry.id)) continue;
    rmSync(entry.path, { recursive: true, force: true });
    removed.push(entry.id);
  }
  return removed;
};

export async function cleanupGenerations(
  paths: KoedServerPaths,
  retain: number,
  requester: RuntimeOwner
): Promise<string[]> {
  if (!Number.isInteger(retain) || retain < 1)
    throw new Error("generation retention must be a positive integer");
  const lock = acquireLifecycleLock(paths);
  try {
    return await withStoreLock(paths, async () => {
      assertNoActivePin(paths);
      const currentId = readCurrentId(paths);
      const current = currentId
        ? await readStagedGeneration(paths, currentId)
        : null;
      if (current) assertOwner(current, requester);
      const generations = await listOwnedGenerations(paths, requester);
      return removeUnretainedGenerations(generations, retain, currentId);
    });
  } finally {
    releaseLifecycleLock(paths, lock);
  }
}

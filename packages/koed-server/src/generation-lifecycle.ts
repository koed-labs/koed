import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
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
import {
  readGenerationOrderingEvidence,
  readGenerationRecord,
  readStagedGeneration
} from "./component-store.js";
import {
  readSupervisorLock,
  resolveProcessIdentity
} from "./supervisor-lock.js";
import {
  isRuntimeGenerationState,
  type RuntimeGenerationState
} from "./runtime-state.js";
import { isVersionDowngrade } from "./package-runtime.js";
import { renameAtomically } from "./generation-lifecycle-filesystem.js";
import { acquireDirectoryLock } from "./directory-lock.js";
import { canonicalArtifactJson } from "./artifact-canonical-json.mjs";

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
const isRuntimeOwnerRecord = (value: unknown): value is RuntimeOwner =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  ["cli", "desktop", "standalone"].includes(String(value.kind)) &&
  typeof value.installationId === "string" &&
  /^[A-Za-z0-9._-]{1,128}$/.test(value.installationId);
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
  generation: { readonly owner: Readonly<RuntimeOwner> },
  requester: RuntimeOwner
): void => {
  if (!sameOwner(generation.owner, requester))
    throw new Error("runtime owner mismatch");
};
const assertNoActivePin = (
  paths: KoedServerPaths,
  allowCurrentSupervisor = false
): void => {
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
  // Startup already holds the supervisor lock; only its exact live owner may pin.
  if (
    allowCurrentSupervisor &&
    supervisor.pid === process.pid &&
    identity !== null &&
    identity === supervisor.processIdentity
  )
    return;
  if (
    identity === supervisor.processIdentity ||
    (!identity && processIsRunning(supervisor.pid)) ||
    (!supervisor.processIdentity && processIsRunning(supervisor.pid))
  )
    throw new Error("runtime generation is running or pinned");
};
export function readCurrentGenerationOrderingEvidence(paths: KoedServerPaths) {
  const id = readCurrentId(paths);
  if (!id) throw new Error("no active runtime generation");
  return readGenerationOrderingEvidence(paths, id);
}

export async function readCurrentGeneration(
  paths: KoedServerPaths
): Promise<VerifiedGeneration> {
  const id = readCurrentId(paths);
  if (!id) throw new Error("no active runtime generation");
  return readStagedGeneration(paths, id);
}

const desktopBundleRecordPath = (paths: KoedServerPaths, id: string): string =>
  resolve(paths.generationsDir, id, "desktop-bundle.json");
const persistDesktopBundleRecord = (
  paths: KoedServerPaths,
  generation: VerifiedGeneration,
  capability: DesktopRuntimeCapability
): void => {
  const root = resolve(paths.generationsDir, generation.id);
  assertDirectoryChain(paths.koedHome, root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = desktopBundleRecordPath(paths, generation.id);
  const record = {
    schemaVersion: 1,
    kind: "desktop-bundle",
    id: generation.id,
    productVersion: generation.productVersion,
    owner: generation.owner,
    bundleDigest: capability.bundleDigest,
    resourcesPath: capability.resourcesPath
  };
  try {
    writeFileSync(path, `${JSON.stringify(record)}\n`, {
      flag: "wx",
      mode: 0o600
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing: unknown = JSON.parse(readRegularFile(path));
    if (
      !isRecord(existing) ||
      existing.schemaVersion !== record.schemaVersion ||
      existing.kind !== record.kind ||
      existing.id !== record.id ||
      existing.productVersion !== record.productVersion ||
      existing.bundleDigest !== record.bundleDigest ||
      existing.resourcesPath !== record.resourcesPath ||
      !isRecord(existing.owner) ||
      existing.owner.kind !== generation.owner.kind ||
      existing.owner.installationId !== generation.owner.installationId
    )
      throw new Error("private Desktop bundle generation record is invalid", {
        cause: error
      });
  }
};
const readDesktopBundleGenerationById = async (
  paths: KoedServerPaths,
  id: string,
  capability: DesktopRuntimeCapability
): Promise<VerifiedGeneration> => {
  const generation = await readDesktopBundleGeneration(paths, capability);
  if (generation.id !== id) throw new Error("runtime owner mismatch");
  const record: unknown = JSON.parse(
    readRegularFile(desktopBundleRecordPath(paths, id))
  );
  if (
    !isRecord(record) ||
    record.schemaVersion !== 1 ||
    record.kind !== "desktop-bundle" ||
    record.id !== generation.id ||
    record.productVersion !== generation.productVersion ||
    record.bundleDigest !== capability.bundleDigest ||
    record.resourcesPath !== capability.resourcesPath ||
    !isRecord(record.owner) ||
    record.owner.kind !== generation.owner.kind ||
    record.owner.installationId !== generation.owner.installationId
  )
    throw new Error("private Desktop bundle generation record is invalid");
  return generation;
};
export async function readDesktopGenerationForCapability(
  paths: KoedServerPaths,
  id: string,
  capability: DesktopRuntimeCapability
): Promise<VerifiedGeneration> {
  if (!validateDesktopRuntimeCapability(capability))
    throw new Error("validated private Desktop runtime capability is required");
  try {
    return await readDesktopBundleGenerationById(paths, id, capability);
  } catch (error) {
    if (error instanceof Error && error.message === "runtime owner mismatch")
      return readStagedGeneration(paths, id);
    throw error;
  }
}

export async function readCurrentDesktopGeneration(
  paths: KoedServerPaths,
  capability: DesktopRuntimeCapability
): Promise<VerifiedGeneration> {
  if (!validateDesktopRuntimeCapability(capability))
    throw new Error("validated private Desktop runtime capability is required");
  const id = readCurrentId(paths);
  if (!id) throw new Error("no active runtime generation");
  const generation = await readDesktopGenerationForCapability(
    paths,
    id,
    capability
  );
  assertOwner(
    generation,
    resolveDesktopRuntimeOwner(capability, paths.koedHome)
  );
  return generation;
}

export async function readCurrentGenerationForOwner(
  paths: KoedServerPaths,
  requester: RuntimeOwner
): Promise<VerifiedGeneration> {
  const generation = await readCurrentGeneration(paths);
  assertOwner(generation, requester);
  return generation;
}

export interface DesktopGenerationOrderingEvidence {
  readonly kind: "desktop-generation-ordering-evidence";
  readonly id: string;
  readonly productVersion: string;
  readonly owner: Readonly<RuntimeOwner>;
  readonly bundleDigest: string;
  readonly resourcesPath: string;
  readonly components: readonly ("base" | "privacy")[];
}

const readOrderingJournalFile = (path: string): string => {
  if (constants.O_NOFOLLOW === undefined)
    throw new Error("component metadata no-follow access is unavailable");
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("generation journal is not a bounded regular file");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null
      );
      if (count === 0) break;
      length += count;
    }
    if (length > stat.size)
      throw new Error("generation journal changed while reading");
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
};

const readDesktopOrderingJournal = (
  paths: KoedServerPaths,
  id: string
): DesktopGenerationOrderingEvidence | null => {
  const bundlePath = desktopBundleRecordPath(paths, id);
  const hasBundle = existsSync(bundlePath);
  if (hasBundle) assertDirectoryChain(paths.koedHome, dirname(bundlePath));
  const record: unknown = hasBundle
    ? JSON.parse(readOrderingJournalFile(bundlePath))
    : readGenerationRecord(paths, id);
  if (!isRecord(record)) throw new Error("generation record is invalid");
  if (
    record.kind !== "desktop-bundle" &&
    record.kind !== "desktop-bundle-with-privacy"
  )
    return null;
  validateDesktopOrderingJournal(record, id);
  return Object.freeze({
    kind: "desktop-generation-ordering-evidence",
    id,
    productVersion: record.productVersion,
    owner: Object.freeze({ ...record.owner }),
    bundleDigest: record.bundleDigest,
    resourcesPath: record.resourcesPath,
    components: Object.freeze(
      record.kind === "desktop-bundle"
        ? (["base"] as const)
        : (["base", "privacy"] as const)
    )
  });
};

function validateDesktopOrderingJournal(
  record: Record<string, unknown>,
  id: string
): asserts record is Record<string, unknown> & {
  productVersion: string;
  owner: RuntimeOwner;
  bundleDigest: string;
  resourcesPath: string;
} {
  const privacy = record.kind === "desktop-bundle-with-privacy";
  const keys = [
    "schemaVersion",
    "kind",
    "id",
    "productVersion",
    "owner",
    "bundleDigest",
    "resourcesPath",
    ...(privacy ? ["privacy"] : [])
  ];
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(record, key)) ||
    record.schemaVersion !== 1 ||
    record.id !== id ||
    typeof record.productVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(record.productVersion) ||
    !isRuntimeOwnerRecord(record.owner) ||
    record.owner.kind !== "desktop" ||
    typeof record.resourcesPath !== "string" ||
    !isAbsolute(record.resourcesPath) ||
    typeof record.bundleDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.bundleDigest)
  )
    throw new Error("private Desktop bundle generation record is invalid");
  if (privacy) validateDesktopPrivacyJournal(record, id);
  else if (
    createHash("sha256")
      .update(`${record.owner.installationId}\n${record.bundleDigest}`)
      .digest("hex") !== id
  )
    throw new Error("Desktop bundle generation identity mismatch");
}

function validateDesktopPrivacyJournal(
  record: Record<string, unknown>,
  id: string
): void {
  if (
    !isRecord(record.privacy) ||
    Object.keys(record.privacy).length !== 2 ||
    typeof record.privacy.root !== "string" ||
    isAbsolute(record.privacy.root) ||
    record.privacy.root.split(/[\\/]/).includes("..") ||
    typeof record.privacy.manifestDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.privacy.manifestDigest)
  )
    throw new Error("private Desktop privacy journal is invalid");
  const identity = { ...record };
  delete identity.id;
  if (
    createHash("sha256")
      .update(canonicalArtifactJson(identity))
      .digest("hex") !== id
  )
    throw new Error("Desktop privacy generation digest mismatch");
}

export function readCurrentDesktopGenerationOrderingEvidence(
  paths: KoedServerPaths,
  capability: DesktopRuntimeCapability
):
  | DesktopGenerationOrderingEvidence
  | ReturnType<typeof readGenerationOrderingEvidence> {
  if (!validateDesktopRuntimeCapability(capability))
    throw new Error("validated private Desktop runtime capability is required");
  const id = readCurrentId(paths);
  if (!id) throw new Error("no active runtime generation");
  const evidence =
    readDesktopOrderingJournal(paths, id) ??
    readGenerationOrderingEvidence(paths, id);
  if (
    evidence.kind === "desktop-generation-ordering-evidence" &&
    evidence.resourcesPath !== capability.resourcesPath
  )
    throw new Error("runtime owner mismatch");
  assertOwner(evidence, resolveDesktopRuntimeOwner(capability, paths.koedHome));
  return evidence;
}

export async function readCurrentRuntimeOwner(
  paths: KoedServerPaths
): Promise<RuntimeOwner | null> {
  if (!existsSync(resolve(paths.componentsDir, "current.json"))) return null;
  const id = readCurrentId(paths);
  if (!id) return null;
  // Ownership discovery is not admission to execute historical payloads.
  return (
    await Promise.resolve(
      readDesktopOrderingJournal(paths, id) ??
        readGenerationOrderingEvidence(paths, id)
    )
  ).owner;
}

const persistPinState = (
  paths: KoedServerPaths,
  generation: VerifiedGeneration,
  requester: RuntimeOwner,
  lock: LifecycleLockRecord,
  source: "manifest-pinned-store" | "desktop-bundle" = "manifest-pinned-store"
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

export function readDesktopBundleGeneration(
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
  return Promise.resolve(generation);
}

// Installation can precede the first start. Persist a verified Base recovery
// record without selecting or pinning a generation.
export async function stageDesktopBundleForRecovery(
  paths: KoedServerPaths,
  capability: DesktopRuntimeCapability
): Promise<VerifiedGeneration> {
  return withStoreLock(paths, async () => {
    const generation = await readDesktopBundleGeneration(paths, capability);
    persistDesktopBundleRecord(paths, generation, capability);
    return generation;
  });
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
      assertNoActivePin(paths, true);
      const bundled = await readDesktopBundleGeneration(paths, capability);
      const activeId = readCurrentId(paths);
      let active: VerifiedGeneration | null = null;
      if (activeId) {
        const prior = readCurrentDesktopGenerationOrderingEvidence(
          paths,
          capability
        );
        if (isVersionDowngrade(prior.productVersion, bundled.productVersion))
          throw new Error("Desktop generation downgrades are not supported.");
        if (
          prior.kind === "desktop-generation-ordering-evidence"
            ? prior.bundleDigest === capability.bundleDigest
            : prior.productVersion === bundled.productVersion
        ) {
          active = await readDesktopGenerationForCapability(
            paths,
            activeId,
            capability
          );
        }
      }
      if (active) assertOwner(active, requester);
      persistDesktopBundleRecord(paths, bundled, capability);
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
      kind: "desktop-bundle",
      manifest,
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
      assertNoActivePin(paths, true);
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
  requester: RuntimeOwner,
  capability?: DesktopRuntimeCapability,
  selection?: { expectedCurrentGeneration: string | null }
): Promise<VerifiedGeneration> {
  const lock = acquireLifecycleLock(paths);
  try {
    return await withStoreLock(paths, async () => {
      assertNoActivePin(paths);
      const currentId = readCurrentId(paths);
      if (selection && currentId !== selection.expectedCurrentGeneration)
        throw new Error(
          "Runtime selection changed during Privacy installation. Retry from the current selection; no generation was replaced."
        );
      const candidate = capability
        ? await readDesktopGenerationForCapability(paths, id, capability)
        : await readStagedGeneration(paths, id);
      assertOwner(candidate, requester);
      if (currentId) {
        const current = capability
          ? await readDesktopGenerationForCapability(
              paths,
              currentId,
              capability
            )
          : readGenerationOrderingEvidence(paths, currentId);
        assertOwner(current, requester);
        if (
          isVersionDowngrade(current.productVersion, candidate.productVersion)
        )
          throw new Error(
            `Cannot activate generation ${candidate.productVersion} over active ${current.productVersion}: generation downgrades are not supported.`
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

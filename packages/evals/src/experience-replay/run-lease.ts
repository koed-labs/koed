import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  unlink,
  type FileHandle
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertNoDotPathComponents,
  assertNoSymlinkComponents,
  readTextFileNoFollow
} from "./artifacts.js";

const LEASE_FILE = ".experience-replay.lease";
const MAX_LEASE_BYTES = 16 * 1024;
const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

export interface RunLeaseOwner {
  schema: "koed-experience-replay-run-lease-v1";
  ownerToken: string;
  hostname: string;
  machineId: string;
  bootId: string;
  pid: number;
  processStartTicks: string;
  acquiredAt: string;
}

export interface RunLeaseSystem {
  currentOwner(): Promise<
    Omit<RunLeaseOwner, "schema" | "ownerToken" | "acquiredAt">
  >;
  processStartTicks(pid: number): Promise<string | null>;
}

export interface RunLease {
  readonly owner: Readonly<RunLeaseOwner>;
  readonly path: string;
  release(): Promise<void>;
}

const procStartTicks = async (pid: number): Promise<string | null> => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) throw new Error("Malformed Linux process stat");
    // Fields following comm begin at field 3; starttime is field 22.
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/u);
    const startTicks = fields[19];
    if (!startTicks || !/^\d+$/u.test(startTicks)) {
      throw new Error("Malformed Linux process start time");
    }
    return startTicks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const linuxIdentity = async (file: string, label: string): Promise<string> => {
  const value = (await readFile(file, "utf8")).trim();
  if (!value || /[\r\n]/u.test(value)) {
    throw new Error(`Cannot establish ${label} for the run lease`);
  }
  return value;
};

const defaultSystem: RunLeaseSystem = {
  async currentOwner() {
    if (process.platform !== "linux") {
      throw new Error(
        "Safe cross-process stale lease proof is currently supported only on Linux"
      );
    }
    const [machineId, bootId, processStartTicks] = await Promise.all([
      linuxIdentity("/etc/machine-id", "machine identity"),
      linuxIdentity("/proc/sys/kernel/random/boot_id", "boot identity"),
      procStartTicks(process.pid)
    ]);
    if (!processStartTicks) {
      throw new Error("Cannot establish the current process identity");
    }
    return {
      hostname: os.hostname(),
      machineId,
      bootId,
      pid: process.pid,
      processStartTicks
    };
  },
  processStartTicks: procStartTicks
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(
    directory,
    constants.O_RDONLY | noFollow | (constants.O_DIRECTORY ?? 0)
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const parseOwner = (text: string): RunLeaseOwner => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Run lease owner record is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Run lease owner record is malformed");
  }
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).length !== 8 ||
    value.schema !== "koed-experience-replay-run-lease-v1" ||
    typeof value.ownerToken !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.ownerToken) ||
    typeof value.hostname !== "string" ||
    !value.hostname ||
    typeof value.machineId !== "string" ||
    !value.machineId ||
    typeof value.bootId !== "string" ||
    !value.bootId ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    typeof value.processStartTicks !== "string" ||
    !/^\d+$/u.test(value.processStartTicks) ||
    typeof value.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(value.acquiredAt))
  ) {
    throw new Error("Run lease owner record is malformed");
  }
  return value as unknown as RunLeaseOwner;
};

const sameFile = (
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<typeof lstat>>
): boolean => left.dev === right.dev && left.ino === right.ino;

const readOwnerWithIdentity = async (
  leasePath: string
): Promise<{
  owner: RunLeaseOwner;
  stats: Awaited<ReturnType<FileHandle["stat"]>>;
}> => {
  const handle = await open(leasePath, constants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    const pathname = await lstat(leasePath);
    if (!stats.isFile() || !sameFile(stats, pathname)) {
      throw new Error("Run lease pathname changed while being inspected");
    }
    if (stats.size > MAX_LEASE_BYTES) {
      throw new Error("Run lease owner record is too large");
    }
    return { owner: parseOwner(await handle.readFile("utf8")), stats };
  } finally {
    await handle.close();
  }
};

const proveStale = async (
  owner: RunLeaseOwner,
  current: Awaited<ReturnType<RunLeaseSystem["currentOwner"]>>,
  system: RunLeaseSystem
): Promise<boolean> => {
  if (
    owner.hostname !== current.hostname ||
    owner.machineId !== current.machineId
  ) {
    return false;
  }
  if (owner.bootId !== current.bootId) return true;
  const observedStart = await system.processStartTicks(owner.pid);
  return observedStart === null || observedStart !== owner.processStartTicks;
};

const publishOwner = async (
  runRoot: string,
  leasePath: string,
  owner: RunLeaseOwner
): Promise<boolean> => {
  const temporary = path.join(runRoot, `.${LEASE_FILE}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600
    );
    created = true;
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    try {
      await link(temporary, leasePath);
      await syncDirectory(runRoot);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await handle?.close();
    if (created) await unlink(temporary).catch(() => undefined);
  }
};

export const acquireRunLease = async (
  runDirectory: string,
  options: { system?: RunLeaseSystem; now?: () => Date } = {}
): Promise<RunLease> => {
  if (!path.isAbsolute(runDirectory)) {
    throw new Error("Run lease directory must be absolute");
  }
  assertNoDotPathComponents(runDirectory, "Run lease directory");
  await assertNoSymlinkComponents(runDirectory);
  const runRoot = await realpath(runDirectory);
  if (runRoot !== path.resolve(runDirectory)) {
    throw new Error("Run lease directory must not use symlinks");
  }
  const system = options.system ?? defaultSystem;
  const current = await system.currentOwner();
  const owner: RunLeaseOwner = {
    schema: "koed-experience-replay-run-lease-v1",
    ownerToken: randomBytes(32).toString("hex"),
    ...current,
    acquiredAt: (options.now ?? (() => new Date()))().toISOString()
  };
  const leasePath = path.join(runRoot, LEASE_FILE);
  const reclaimPath = `${leasePath}.reclaim`;

  try {
    await lstat(reclaimPath);
    throw new Error("Run lease stale-owner recovery is already in progress");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (!(await publishOwner(runRoot, leasePath, owner))) {
    const existing = await readOwnerWithIdentity(leasePath);
    if (!(await proveStale(existing.owner, current, system))) {
      throw new Error("Experience Replay run is already leased");
    }
    let reclaim: FileHandle | undefined;
    let reclaimCreated = false;
    try {
      reclaim = await open(
        reclaimPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600
      );
      reclaimCreated = true;
      await reclaim.writeFile(`${owner.ownerToken}\n`, "utf8");
      await reclaim.sync();
      await syncDirectory(runRoot);
      const rechecked = await readOwnerWithIdentity(leasePath);
      if (
        !sameFile(existing.stats, await lstat(leasePath)) ||
        !sameFile(rechecked.stats, await lstat(leasePath)) ||
        rechecked.owner.ownerToken !== existing.owner.ownerToken ||
        !(await proveStale(rechecked.owner, current, system))
      ) {
        throw new Error("Run lease owner changed during stale-owner proof");
      }
      await unlink(leasePath);
      if (!(await publishOwner(runRoot, leasePath, owner))) {
        throw new Error(
          "Experience Replay run lease was acquired concurrently"
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          "Run lease stale-owner recovery is already in progress",
          { cause: error }
        );
      }
      throw error;
    } finally {
      await reclaim?.close();
      if (reclaimCreated) {
        await unlink(reclaimPath).catch(() => undefined);
        await syncDirectory(runRoot);
      }
    }
  }

  let released = false;
  return {
    owner: Object.freeze({ ...owner }),
    path: leasePath,
    async release() {
      if (released) return;
      const existing = await readOwnerWithIdentity(leasePath);
      if (existing.owner.ownerToken !== owner.ownerToken) {
        throw new Error("Cannot release a run lease owned by another process");
      }
      if (!sameFile(existing.stats, await lstat(leasePath))) {
        throw new Error("Run lease pathname changed before release");
      }
      await unlink(leasePath);
      await syncDirectory(runRoot);
      released = true;
    }
  };
};

export const readRunLeaseOwner = async (
  runDirectory: string
): Promise<RunLeaseOwner> =>
  parseOwner(
    await readTextFileNoFollow(
      path.join(runDirectory, LEASE_FILE),
      MAX_LEASE_BYTES
    )
  );

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";

interface SupervisorLockRecord {
  pid: number;
  acquiredAt: string;
}

export interface KoedServerSupervisorLock {
  acquired: boolean;
  lockPath: string;
  ownerPid?: number;
}

const processIsRunning = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readLock = (lockPath: string): SupervisorLockRecord | null => {
  try {
    const value = JSON.parse(
      readFileSync(lockPath, "utf8")
    ) as Partial<SupervisorLockRecord>;
    return Number.isInteger(value.pid) && Number(value.pid) > 0
      ? {
          pid: Number(value.pid),
          acquiredAt: String(value.acquiredAt ?? "unknown")
        }
      : null;
  } catch {
    return null;
  }
};

export const acquireKoedServerSupervisorLock = (
  paths: KoedServerPaths,
  options: {
    pid?: number;
    now?: () => Date;
    isProcessRunning?: (pid: number) => boolean;
  } = {}
): KoedServerSupervisorLock => {
  const pid = options.pid ?? process.pid;
  const isRunning = options.isProcessRunning ?? processIsRunning;
  const lockPath = resolve(paths.runDir, "koed-server.lock");
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(
          descriptor,
          `${JSON.stringify({ pid, acquiredAt: (options.now ?? (() => new Date()))().toISOString() }, null, 2)}\n`
        );
      } finally {
        closeSync(descriptor);
      }
      return { acquired: true, lockPath, ownerPid: pid };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readLock(lockPath);
      if (owner && isRunning(owner.pid)) {
        return { acquired: false, lockPath, ownerPid: owner.pid };
      }
      rmSync(lockPath, { force: true });
    }
  }

  const owner = readLock(lockPath);
  return {
    acquired: false,
    lockPath,
    ...(owner ? { ownerPid: owner.pid } : {})
  };
};

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";

export interface SupervisorLockRecord {
  pid: number;
  acquiredAt: string;
  processIdentity?: string;
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

const resolveProcessIdentity = (pid: number): string | null => {
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

export const readSupervisorLock = (
  lockPath: string
): SupervisorLockRecord | null => {
  try {
    const value = JSON.parse(
      readFileSync(lockPath, "utf8")
    ) as Partial<SupervisorLockRecord>;
    return Number.isInteger(value.pid) && Number(value.pid) > 0
      ? {
          pid: Number(value.pid),
          acquiredAt: String(value.acquiredAt ?? "unknown"),
          ...(typeof value.processIdentity === "string" &&
          value.processIdentity.length > 0
            ? { processIdentity: value.processIdentity }
            : {})
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
    resolveProcessIdentity?: (pid: number) => string | null;
  } = {}
): KoedServerSupervisorLock => {
  const pid = options.pid ?? process.pid;
  const isRunning = options.isProcessRunning ?? processIsRunning;
  const identify = options.resolveProcessIdentity ?? resolveProcessIdentity;
  const processIdentity = identify(pid);
  if (!processIdentity) {
    throw new Error(`Could not resolve process identity for PID ${pid}.`);
  }
  const lockPath = resolve(paths.runDir, "koed-server.lock");
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(
          descriptor,
          `${JSON.stringify(
            {
              pid,
              acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
              processIdentity
            },
            null,
            2
          )}\n`
        );
      } finally {
        closeSync(descriptor);
      }
      return { acquired: true, lockPath, ownerPid: pid };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readSupervisorLock(lockPath);
      if (owner && isRunning(owner.pid)) {
        const ownerIdentity = identify(owner.pid);
        if (!ownerIdentity && isRunning(owner.pid)) {
          return { acquired: false, lockPath, ownerPid: owner.pid };
        }
        if (ownerIdentity) {
          if (!owner.processIdentity && owner.pid !== pid) {
            return { acquired: false, lockPath, ownerPid: owner.pid };
          }
          if (
            owner.processIdentity &&
            ownerIdentity === owner.processIdentity
          ) {
            return { acquired: false, lockPath, ownerPid: owner.pid };
          }
        }
      }
      rmSync(lockPath, { force: true });
    }
  }

  const owner = readSupervisorLock(lockPath);
  return {
    acquired: false,
    lockPath,
    ...(owner ? { ownerPid: owner.pid } : {})
  };
};

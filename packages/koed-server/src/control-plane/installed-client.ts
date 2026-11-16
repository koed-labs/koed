import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync
} from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  deriveDesktopRuntimeOwner,
  resolveDesktopControlAddon,
  type DesktopRuntimeCapability
} from "../desktop-runtime-capability.js";
import { ensureKoedHome, resolveKoedServerPaths } from "../paths.js";
import {
  readSupervisorLock,
  resolveProcessIdentity
} from "../supervisor-lock.js";
import { connectControlClient } from "./client.js";
import { connectOrLaunchControlPlane } from "./connect-or-launch.js";
import { readControlDiscovery, type ControlDiscovery } from "./discovery.js";
import { recordOfflineStop } from "./offline-stop.js";
import {
  createNativeControlTransport,
  type NativeLocalControl
} from "./native-transport.js";

export function installedAgentTeamId(
  capability: DesktopRuntimeCapability
): string {
  const require = createRequire(import.meta.url);
  const addon: unknown = require(resolveDesktopControlAddon(capability));
  if (
    !addon ||
    typeof addon !== "object" ||
    !("teamId" in addon) ||
    typeof addon.teamId !== "string" ||
    !/^[A-Z0-9]{10}$/u.test(addon.teamId)
  )
    throw new Error("Background Agent signing identity is unavailable");
  return addon.teamId;
}

export function tryRecordOfflineStop(
  environment: NodeJS.ProcessEnv,
  capability: DesktopRuntimeCapability
): { clean: boolean } | undefined {
  const paths = resolveKoedServerPaths(environment);
  ensureKoedHome(paths);
  const require = createRequire(import.meta.url);
  const addon: unknown = require(resolveDesktopControlAddon(capability));
  if (!addon || typeof addon !== "object" || !("localControl" in addon))
    throw new Error("Packaged local control addon is unavailable");
  const native = (
    addon as { localControl: { tryReclaimLock?: (fd: number) => boolean } }
  ).localControl;
  if (typeof native?.tryReclaimLock !== "function")
    throw new Error("Packaged reclaim lock is unavailable");
  return recordOfflineStop(paths, { tryReclaimLock: native.tryReclaimLock });
}

export async function openInstalledControlPlane(input: {
  capability: DesktopRuntimeCapability;
  environment: NodeJS.ProcessEnv;
  executable: string;
  entrypoint: string;
  launchIfMissing?: boolean;
}) {
  const paths = resolveKoedServerPaths(input.environment);
  ensureKoedHome(paths);
  const home = realpathSync(paths.koedHome);
  const owner = deriveDesktopRuntimeOwner(
    home,
    input.capability.installationPath
  );
  if (owner.kind !== "desktop") throw new Error("Desktop owner required");
  const require = createRequire(import.meta.url);
  const addon = require(resolveDesktopControlAddon(input.capability)) as {
    localControl: NativeLocalControl;
  };
  const transport = createNativeControlTransport(addon.localControl);
  const lockPath = resolve(paths.runDir, "koed-server.lock");
  const isLocked = () => {
    try {
      lstatSync(lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const assertOwner = (record: ControlDiscovery) => {
    const lock = readSupervisorLock(lockPath);
    if (
      !lock ||
      lock.pid !== record.pid ||
      lock.processIdentity !== record.processIdentity ||
      resolveProcessIdentity(record.pid) !== record.processIdentity
    )
      throw new Error("Control-plane discovery owner cannot be verified");
  };
  let launchFailure: Error | undefined;
  return connectOrLaunchControlPlane({
    launchIfMissing: input.launchIfMissing,
    waitForOwner: true,
    launchFailure: () => launchFailure,
    read: () => readControlDiscovery(paths),
    isLocked,
    hasLiveOwner: () => {
      const lock = readSupervisorLock(lockPath);
      if (!lock) return true;
      try {
        process.kill(lock.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        return true;
      }
      // A live PID cannot be treated as dead solely because identity changed.
      return true;
    },
    isCurrentDiscovery: (record) => {
      const lock = readSupervisorLock(lockPath);
      return (
        !!lock &&
        lock.pid === record.pid &&
        lock.processIdentity === record.processIdentity
      );
    },
    isDiscoveryDead: (record) => {
      try {
        process.kill(record.pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        throw error;
      }
    },
    installationId: owner.installationId,
    productVersion: input.capability.productVersion,
    connect: async (record) => {
      assertOwner(record);
      const client = await connectControlClient({
        transport,
        discovery: record
      });
      try {
        assertOwner(record);
      } catch (error) {
        client.close();
        throw error;
      }
      return client;
    },
    launch: () => {
      const fd = openSync(
        resolve(paths.logsDir, "control-plane.log"),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          constants.O_NOFOLLOW,
        0o600
      );
      try {
        const stats = fstatSync(fd);
        if (
          !stats.isFile() ||
          stats.nlink !== 1 ||
          (stats.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" &&
            stats.uid !== process.getuid())
        )
          throw new Error("Control-plane log is not private");
        const child = spawn(
          input.executable,
          [input.entrypoint, "__control-plane-host"],
          { detached: true, stdio: ["ignore", fd, fd], env: input.environment }
        );
        child.once("error", (error) => {
          launchFailure = new Error(
            `Could not launch control plane: ${error.message}; check ${resolve(paths.logsDir, "control-plane.log")}`
          );
        });
        child.once("exit", (code, signal) => {
          launchFailure ??= new Error(
            `Control plane exited before discovery (${signal ?? code}); check ${resolve(paths.logsDir, "control-plane.log")}`
          );
        });
        child.unref();
      } finally {
        closeSync(fd);
      }
    }
  });
}

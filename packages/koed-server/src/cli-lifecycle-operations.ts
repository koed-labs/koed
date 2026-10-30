import type { KoedServerCliDependencies } from "./cli-contract.js";
import type { LifecycleOptions, LifecycleOperation } from "./cli-lifecycle.js";
import { createCliServiceContext } from "./cli-service-context.js";
import {
  safeLifecycle,
  printJson,
  persistDoctorVerification,
  checkCoreSetupNeeded,
  getNoAgentsWarning
} from "./cli-service-output.js";

export const runLifecycleCommand = async (
  command: LifecycleOperation,
  options: LifecycleOptions,
  dependencies: KoedServerCliDependencies
): Promise<number> => {
  const {
    collectStatus,
    collectStartupStatus,
    collectDoctor,
    inspectDeviceIdentity,
    rotateIdentity,
    invalidateEnrollmentReferences,
    start,
    startDaemon,
    stop,
    restart,
    resolvePaths,
    stdout,
    stderr
  } = createCliServiceContext(dependencies);
  const wantsJson = options.json;
  const subcommand = options.identityAction;
  try {
    if (command === "status") {
      const paths = resolvePaths();
      const setupNeeded = checkCoreSetupNeeded(paths);
      if (setupNeeded) {
        stderr.write(`${setupNeeded}\n`);
        return 1;
      }
      const isStartup = Boolean(options.startup);
      const status = isStartup
        ? await collectStartupStatus()
        : await collectStatus();
      if (wantsJson) {
        printJson(
          stdout,
          isStartup ? status : { ...status, lifecycle: safeLifecycle(paths) }
        );
      } else {
        stdout.write(`${status.state}\n`);
        if (!isStartup && "codex" in status) {
          const warning = getNoAgentsWarning(
            status as typeof status & { codex: { configured: boolean } }
          );
          if (warning) stdout.write(`Warning: ${warning}\n`);
        }
      }
      return 0;
    }

    if (command === "doctor") {
      const doctor = await collectDoctor();
      persistDoctorVerification(resolvePaths(), doctor);
      if (wantsJson) {
        printJson(stdout, doctor);
      } else {
        stdout.write(`${doctor.summary}\n`);
        const status = await collectStatus();
        const warning = getNoAgentsWarning(status);
        if (warning) stdout.write(`Warning: ${warning}\n`);
      }
      return doctor.ok ? 0 : 1;
    }

    if (command === "identity") {
      const paths = resolvePaths();
      const identity =
        subcommand === "status"
          ? await inspectDeviceIdentity(paths)
          : subcommand === "rotate"
            ? await rotateIdentity(paths, {
                invalidateRemoteReferences: () =>
                  invalidateEnrollmentReferences(paths)
              })
            : null;
      if (!identity) {
        throw new Error("identity command must be status or rotate.");
      }
      if (wantsJson) {
        printJson(stdout, identity);
      } else {
        stdout.write(`${identity.health}\n`);
      }
      return identity.remoteOperationsAllowed ? 0 : 1;
    }

    if (command === "start") {
      if (options.daemon) {
        const result = startDaemon();
        if (wantsJson) {
          printJson(stdout, result);
        } else {
          stdout.write(`${result.message}\n`);
        }
        return result.ok ? 0 : 1;
      }
      await start();
      return 0;
    }

    if (command === "stop") {
      const result = stop();
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "restart") {
      const result = await restart();
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    throw new Error("Unknown lifecycle operation.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson) printJson(stdout, { ok: false, error: message });
    else stderr.write(`${message}\n`);
    return 1;
  }
};

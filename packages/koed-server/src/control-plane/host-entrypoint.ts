import { createRequire } from "node:module";
import {
  resolveDesktopControlAddon,
  type DesktopRuntimeCapability
} from "../desktop-runtime-capability.js";
import {
  createNativeControlTransport,
  type NativeLocalControl
} from "./native-transport.js";
import { startControlPlaneProcess } from "./host-process.js";
import { createControlPlaneShutdown } from "./host-shutdown.js";

/** The packaged CLI invokes this only after verifying the running installation. */
export async function runInstalledControlPlaneHost(input: {
  capability: DesktopRuntimeCapability;
  environment: NodeJS.ProcessEnv;
}): Promise<number> {
  const require = createRequire(import.meta.url);
  const addon: unknown = require(resolveDesktopControlAddon(input.capability));
  if (!addon || typeof addon !== "object" || !("localControl" in addon))
    throw new Error("Packaged local control addon is unavailable");
  const native = (
    addon as {
      localControl: NativeLocalControl & {
        tryReclaimLock(fd: number): boolean;
      };
    }
  ).localControl;
  if (
    !native ||
    [
      "listen",
      "accept",
      "connect",
      "finishConnect",
      "read",
      "write",
      "flush",
      "close",
      "tryReclaimLock"
    ].some(
      (key) => typeof native[key as keyof NativeLocalControl] !== "function"
    )
  )
    throw new Error("Packaged local control addon is invalid");
  return runControlPlaneHost({ ...input, native });
}

export async function runControlPlaneHost(input: {
  capability: DesktopRuntimeCapability;
  environment: NodeJS.ProcessEnv;
  native: NativeLocalControl & { tryReclaimLock(fd: number): boolean };
}): Promise<number> {
  let fatal: Error | undefined;
  const wakeTarget: { wake?: () => void } = {};
  const host = await startControlPlaneProcess({
    ...input,
    transport: createNativeControlTransport(input.native),
    tryReclaimLock: (fd) => input.native.tryReclaimLock(fd),
    onFatal(error) {
      fatal = error;
      wakeTarget.wake?.();
    },
    onRetired() {
      wakeTarget.wake?.();
    }
  });
  const shutdown = createControlPlaneShutdown({
    ...host,
    fatal: () => fatal,
    log: (message) => process.stderr.write(message)
  });
  wakeTarget.wake = shutdown.request;
  process.on("SIGINT", shutdown.request);
  process.on("SIGTERM", shutdown.request);
  if (fatal) shutdown.request();
  try {
    return await shutdown.done;
  } finally {
    process.off("SIGINT", shutdown.request);
    process.off("SIGTERM", shutdown.request);
  }
}

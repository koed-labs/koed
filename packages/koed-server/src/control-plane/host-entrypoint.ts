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

/** The packaged CLI invokes this only after verifying the running installation. */
export async function runInstalledControlPlaneHost(input: {
  capability: DesktopRuntimeCapability;
  environment: NodeJS.ProcessEnv;
}): Promise<number> {
  const require = createRequire(import.meta.url);
  const addon: unknown = require(resolveDesktopControlAddon(input.capability));
  if (!addon || typeof addon !== "object" || !("localControl" in addon))
    throw new Error("Packaged local control addon is unavailable");
  const native = (addon as { localControl: NativeLocalControl }).localControl;
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
      "close"
    ].some(
      (key) => typeof native[key as keyof NativeLocalControl] !== "function"
    )
  )
    throw new Error("Packaged local control addon is invalid");
  let fatal: Error | undefined;
  let wake: (() => void) | undefined;
  const host = await startControlPlaneProcess({
    ...input,
    transport: createNativeControlTransport(native),
    onFatal(error) {
      fatal = error;
      wake?.();
    }
  });
  return new Promise<number>((resolve) => {
    let stopping = false;
    let warned = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      try {
        host.core.stop(false);
      } catch (error) {
        process.stderr.write(`Control-plane stop failed: ${String(error)}\n`);
      }
    };
    wake = stop;
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    if (fatal) stop();
    const timer = setInterval(() => {
      if (!stopping) return;
      const state = host.core.status().state;
      if (state === "needs_attention" && !warned) {
        warned = true;
        process.stderr.write(
          "Control-plane cleanup is uncertain; retaining admission for Operator attention.\n"
        );
      }
      if (state !== "stopped") return;
      clearInterval(timer);
      void host
        .close()
        .finally(() => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
        })
        .then(
          () => resolve(fatal ? 1 : 0),
          (error: unknown) => {
            process.stderr.write(
              `Control-plane shutdown failed: ${String(error)}\n`
            );
            resolve(1);
          }
        );
    }, 250);
  });
}

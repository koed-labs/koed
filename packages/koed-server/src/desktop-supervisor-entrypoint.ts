import { pinDesktopBundleGenerationForStart } from "./generation-lifecycle.js";
import { realpathSync } from "node:fs";
import { startKoedServer } from "./start.js";
import { createDesktopStatusRpcHandler } from "./desktop-status-rpc.js";
import {
  createAccelerationManagement,
  createDesktopAccelerationRpcHandler
} from "./acceleration-management.js";
import {
  createDesktopPrivacyRpcHandler,
  createDesktopComponentManagerBridge
} from "./desktop-component-manager.js";
import { discoverActualRuntimeIdentity } from "./component-runtime-identity.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  resolveDesktopRuntimeOwner,
  verifyDesktopRuntimeBundle
} from "./desktop-runtime-capability.js";
import {
  observeRuntimeLifecycle,
  runtimeOwnedBy
} from "./runtime-lifecycle.js";

interface InitMessage {
  type: "koed.desktop.supervisor.init";
  nonce: string;
  managerPid: number;
  resourcesPath: string;
  mode?:
    | "runtime"
    | "privacy-activation"
    | "privacy-management"
    | "acceleration-management";
}

const isInitMessage = (value: unknown): value is InitMessage => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    (Object.keys(item).length === 4 || Object.keys(item).length === 5) &&
    item.type === "koed.desktop.supervisor.init" &&
    (item.mode === undefined ||
      item.mode === "runtime" ||
      item.mode === "privacy-activation" ||
      item.mode === "acceleration-management" ||
      item.mode === "privacy-management") &&
    typeof item.nonce === "string" &&
    /^[a-f0-9]{64}$/.test(item.nonce) &&
    Number.isSafeInteger(item.managerPid) &&
    item.managerPid === process.ppid &&
    typeof item.resourcesPath === "string"
  );
};

const waitForManagerAuthority = (): Promise<InitMessage> =>
  new Promise((resolve, reject) => {
    if (typeof process.send !== "function" || process.connected !== true) {
      reject(
        new Error("private Desktop supervisor IPC channel is unavailable")
      );
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("Desktop supervisor handshake timed out")),
      10_000
    );
    const onMessage = (message: unknown): void => {
      clearTimeout(timer);
      process.off("message", onMessage);
      if (!isInitMessage(message)) {
        reject(new Error("private Desktop supervisor handshake is invalid"));
        return;
      }
      resolve(message);
    };
    process.on("message", onMessage);
  });

export const createDesktopSupervisorEnvironment = (
  source: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    ...source,
    KOED_PACKAGED_DESKTOP: "1"
  };
  delete environment.KOED_PACKAGED_RESOURCES_PATH;
  return environment;
};

const assertParentExecutable = (managerPid: number): void => {
  if (process.platform === "linux") {
    const parentExecutable = realpathSync.native(`/proc/${managerPid}/exe`);
    if (parentExecutable !== realpathSync.native(process.execPath)) {
      throw new Error("Desktop supervisor parent executable identity mismatch");
    }
  }
};

export const sendDesktopSupervisorStartupFailure = async ({
  nonce,
  bundleDigest,
  error
}: {
  nonce: string;
  bundleDigest: string;
  error: unknown;
}): Promise<void> => {
  if (!process.connected || typeof process.send !== "function") return;
  const message = error instanceof Error ? error.message : String(error);
  await new Promise<void>((resolve) => {
    process.send?.(
      {
        type: "koed.desktop.supervisor.start-failed",
        nonce,
        childPid: process.pid,
        bundleDigest,
        mode: "runtime",
        error: message.slice(0, 4_000)
      },
      () => resolve()
    );
  });
};

export const sendDesktopSupervisorStatus = (
  response: Record<string, unknown>
): void => {
  if (!process.connected) return;
  process.send?.(response, (error: Error | null) => {
    if (error && process.connected)
      process.stderr.write(
        `Desktop status response failed: ${error.message}\n`
      );
  });
};

const entryStartedAt = process.hrtime.bigint();
const traceEntrypoint = (phase: string): void => {
  if (process.env.KOED_SUPERVISOR_STARTUP_TRACE !== "1") return;
  process.stderr.write(
    `${JSON.stringify({
      event: "koed.supervisor.entrypoint",
      phase,
      elapsedMs: Number(process.hrtime.bigint() - entryStartedAt) / 1_000_000
    })}\n`
  );
};

export async function runDesktopSupervisorEntrypoint(): Promise<void> {
  traceEntrypoint("loaded");
  const handshake = await waitForManagerAuthority();
  traceEntrypoint(`handshake:${handshake.mode ?? "runtime"}`);
  assertParentExecutable(handshake.managerPid);
  const capability = verifyDesktopRuntimeBundle(handshake.resourcesPath);
  traceEntrypoint("bundle-verified");
  if (typeof process.send !== "function")
    throw new Error("Desktop supervisor IPC channel is unavailable");
  const supervisorEnvironment = createDesktopSupervisorEnvironment(process.env);
  const paths = resolveKoedServerPaths(supervisorEnvironment);
  const live =
    handshake.mode === "privacy-management"
      ? observeRuntimeLifecycle(paths)
      : null;
  const privacyManager = createDesktopComponentManagerBridge({
    capability,
    paths,
    environment: supervisorEnvironment,
    runtime: discoverActualRuntimeIdentity(),
    isRunning:
      handshake.mode === undefined ||
      handshake.mode === "runtime" ||
      (live !== null && live.state !== "stopped"),
    target: capability.target,
    controlPlaneVersion: capability.productVersion
  });
  const handleStatusRpc = createDesktopStatusRpcHandler({
    nonce: handshake.nonce,
    capability,
    environment: createDesktopSupervisorEnvironment(process.env),
    send: sendDesktopSupervisorStatus
  });
  let accelerationEnvironment: NodeJS.ProcessEnv | undefined;
  const handleAccelerationRpc = createDesktopAccelerationRpcHandler({
    manager: createAccelerationManagement({
      paths,
      capability,
      environment: () => supervisorEnvironment,
      serviceEnvironment: () => accelerationEnvironment
    }),
    nonce: handshake.nonce,
    send: sendDesktopSupervisorStatus
  });
  if (handshake.mode === "acceleration-management") {
    // Read-only inspection can describe a foreign owner. Each mutation separately
    // acquires stopped-runtime authority using this verified bundle capability.
    process.on("message", handleAccelerationRpc);
    process.once("disconnect", () => {
      // Abort downloads/probes and let the installer release locks and staging
      // before exiting. A completed activation is reconciled by the next main.
      void handleAccelerationRpc.close().finally(() => process.exit(0));
    });
    process.send?.({
      type: "koed.desktop.supervisor.ready",
      nonce: handshake.nonce,
      childPid: process.pid,
      bundleDigest: capability.bundleDigest,
      mode: handshake.mode
    });
    return;
  }
  const handlePrivacyRpc = createDesktopPrivacyRpcHandler({
    manager: privacyManager,
    nonce: handshake.nonce,
    send: (response) =>
      process.send?.(response, () => {
        if (handshake.mode === "privacy-activation") process.disconnect?.();
      })
  });
  if (
    handshake.mode === "privacy-activation" ||
    handshake.mode === "privacy-management"
  ) {
    if (live) {
      if (live.state === "stopped") {
        const pin = await pinDesktopBundleGenerationForStart(paths, capability);
        await pin.release();
      } else if (
        live.owner &&
        !runtimeOwnedBy(
          live,
          resolveDesktopRuntimeOwner(capability, paths.koedHome)
        )
      ) {
        // A live supervisor keeps its pin; management never rewrites the
        // generation pointer underneath it and never manages another owner.
        throw new Error("runtime owner mismatch");
      }
    }
    traceEntrypoint("management-ready");
    process.on("message", (message: unknown) => {
      if (
        handshake.mode === "privacy-management" &&
        (handleStatusRpc(message) || handleAccelerationRpc(message))
      )
        return;
      if (
        handshake.mode === "privacy-activation" &&
        (!message ||
          typeof message !== "object" ||
          Array.isArray(message) ||
          (message as Record<string, unknown>).action !== "activate")
      ) {
        process.send?.(
          {
            type: "koed.desktop.privacy.response",
            requestId: (message as Record<string, unknown> | null)?.requestId,
            error: "Stopped activation mode only accepts activate requests"
          },
          () => process.disconnect?.()
        );
        return;
      }
      if (!handlePrivacyRpc(message)) {
        process.send?.(
          {
            type: "koed.desktop.privacy.response",
            requestId: (message as Record<string, unknown> | null)?.requestId,
            error: "Desktop privacy IPC request is invalid"
          },
          () => process.disconnect?.()
        );
      }
    });
    process.once("disconnect", () => process.exit(0));
    process.send?.({
      type: "koed.desktop.supervisor.ready",
      nonce: handshake.nonce,
      childPid: process.pid,
      bundleDigest: capability.bundleDigest,
      mode: handshake.mode
    });
    return;
  }
  process.on("message", (message: unknown) => {
    if (
      handleStatusRpc(message) ||
      handlePrivacyRpc(message) ||
      handleAccelerationRpc(message)
    )
      return;
    if (
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).type ===
        "koed.desktop.supervisor.stop"
    )
      process.kill(process.pid, "SIGTERM");
  });
  process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
  traceEntrypoint("starting-server");
  try {
    await startKoedServer({
      environment: createDesktopSupervisorEnvironment(process.env),
      desktopRuntimeCapability: capability,
      onReady: (serviceEnvironment) => {
        accelerationEnvironment = serviceEnvironment;
        process.send?.({
          type: "koed.desktop.supervisor.ready",
          nonce: handshake.nonce,
          childPid: process.pid,
          bundleDigest: capability.bundleDigest
        });
      }
    });
  } catch (error) {
    await sendDesktopSupervisorStartupFailure({
      nonce: handshake.nonce,
      bundleDigest: capability.bundleDigest,
      error
    });
    throw error;
  } finally {
    process.disconnect?.();
  }
}

if (process.argv[1]?.endsWith("desktop-supervisor-entrypoint.js")) {
  void runDesktopSupervisorEntrypoint().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  });
}

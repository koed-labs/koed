import {
  startEnrollmentFenceIpcDispatcher,
  type EnrollmentFenceIpcEndpoint
} from "@koed-labs/shared/enrollment-fence-ipc";
import {
  buildServer,
  type BuildServerOptions
} from "../server/build-server.js";
import { resolveApiServerConfig } from "../server/config.js";
import {
  EnrollmentFence,
  EnrollmentFenceError,
  type EnrollmentFenceRequest
} from "./enrollment-fence.js";
import { createEnrollmentFenceAdapter } from "./enrollment-fence-adapter.js";
import { resolveOwnerBinding } from "./owner-binding.js";

/** Internal, explicitly constructed coordinator. The caller owns a trusted IPC
 * channel; neither loopback nor this factory authenticates its peer. Its fence
 * covers tagged enrollment effects only, not the entire API runtime. */
export async function createManagedIpcCoordinator(options: {
  endpoint: EnrollmentFenceIpcEndpoint;
  repository?: NonNullable<BuildServerOptions["repository"]>;
  serverOptions?: Omit<
    BuildServerOptions,
    | "repository"
    | "enrollmentFence"
    | "managedEnrollmentMode"
    | "onRepositoryReady"
  >;
}) {
  const endpoint = options.endpoint;
  if (!endpoint.connected) throw new Error("IPC channel unavailable");
  const config = resolveApiServerConfig();
  let capturedRepository: BuildServerOptions["repository"] | null = null;
  let admissionOpen = true;
  let dispatcher:
    | ReturnType<typeof startEnrollmentFenceIpcDispatcher>
    | undefined;
  class ManagedFence extends EnrollmentFence {
    override enter(request: EnrollmentFenceRequest): () => void {
      if (
        !admissionOpen ||
        !endpoint.connected ||
        dispatcher?.state() !== "ready"
      )
        throw new EnrollmentFenceError("fenced");
      return super.enter(request);
    }
  }
  const fence = new ManagedFence();
  const app = await buildServer({
    ...options.serverOptions,
    repository: options.repository,
    onRepositoryReady: (repository) => {
      capturedRepository = repository;
    },
    enrollmentFence: fence,
    managedEnrollmentMode: true
  });
  try {
    const repository = capturedRepository as
      | BuildServerOptions["repository"]
      | null;
    if (!repository)
      throw new Error("Managed enrollment repository unavailable");
    dispatcher = startEnrollmentFenceIpcDispatcher(endpoint, {
      instanceId: fence.instanceId,
      bind: async (signal) => {
        const bindingOptions = {
          koedHome: config.koedHome,
          deploymentProfile: config.deploymentProfile,
          resolveActiveLocalUser: (userId: string) =>
            repository.getUser(userId),
          reportOperationalFailure: (category: "custody" | "user_lookup") => {
            app.log.error(
              { category },
              "Managed enrollment owner lookup failed"
            );
          }
        };
        const binding = await resolveOwnerBinding(bindingOptions);
        if (!binding || signal.aborted)
          throw new Error("Owner binding unavailable");
        const adapter = createEnrollmentFenceAdapter(
          fence,
          binding,
          bindingOptions
        );
        if (signal.aborted) {
          await adapter.closeAdmission();
          throw new Error("Owner binding cancelled");
        }
        return {
          ...adapter,
          closeAdmission: () => {
            admissionOpen = false;
            return adapter.closeAdmission();
          }
        };
      }
    });
    const activeDispatcher = dispatcher;
    if (activeDispatcher.state() === "poisoned")
      throw new Error("IPC channel unavailable");
    const closeApp = app.close.bind(app);
    let cleanup: Promise<void> | undefined;
    const beginClose = () => {
      admissionOpen = false;
      activeDispatcher.close();
      if (!cleanup) {
        cleanup = (async () => {
          await activeDispatcher.settled();
          await closeApp();
        })();
        void cleanup.catch((error) =>
          app.log.error(error, "Managed IPC cleanup failed")
        );
      }
      return cleanup;
    };
    // Fastify's callback overload must remain available to callers of app.close.
    app.close = ((callback?: (error?: unknown) => void) => {
      const pending = beginClose();
      if (callback) {
        void pending.then(
          () => callback(),
          (error) => callback(error)
        );
        return undefined;
      }
      return pending.then(() => undefined);
    }) as typeof app.close;
    return {
      app,
      // Settlement describes resource cleanup only, never proof that effects drained.
      close: async (timeoutMs = 5000) => {
        if (
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs < 0 ||
          timeoutMs > 2147483647
        )
          throw new Error("Invalid managed IPC close timeout");
        const settled = beginClose();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"uncertain">((resolve) => {
          timer = setTimeout(() => resolve("uncertain"), timeoutMs);
        });
        try {
          const status = await Promise.race([
            settled.then(() => "settled" as const),
            timeout
          ]);
          return { status, settled };
        } finally {
          clearTimeout(timer);
        }
      }
    };
  } catch (error) {
    dispatcher?.close();
    await dispatcher?.settled();
    await app.close();
    throw error;
  }
}

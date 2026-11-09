import { z } from "zod";
import { resolveKoedRuntimeOwner } from "./app-runtime.js";
import { createAccelerationInspector } from "./acceleration-inspection.js";
import { resolveKoedServerConfig, writeKoedServerConfig } from "./config.js";
import { resolveDesktopRuntimeOwner } from "./desktop-runtime-capability.js";
import { withStoppedRuntime } from "./generation-lifecycle.js";
import {
  createAccelerationInstaller,
  accelerationInstallSchema
} from "./acceleration-installation.js";

export const accelerationSaveSchema = z
  .object({
    preference: z.enum(["auto", "cpu"]),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export function createAccelerationManagement(
  options: Parameters<typeof createAccelerationInspector>[0]
) {
  const inspector = createAccelerationInspector(options);
  const owner = options.capability
    ? resolveDesktopRuntimeOwner(options.capability, options.paths.koedHome)
    : resolveKoedRuntimeOwner();
  return {
    ...createAccelerationInstaller(options, inspector),
    inspect: inspector.inspect,
    async save(input: unknown) {
      const choice = accelerationSaveSchema.parse(input);
      return withStoppedRuntime(options.paths, owner, async () => {
        const current = await inspector.inspect(true);
        if (current.readOnlyReason) throw new Error(current.readOnlyReason);
        if (current.revision !== choice.expectedRevision)
          throw new Error(
            "Processing configuration changed. Check again before applying your choice."
          );
        if (choice.preference === "auto" && current.preference !== "auto") {
          if (current.hardware.state !== "available")
            throw new Error(current.hardware.reason);
          if (
            current.hardware.backend === "cuda" &&
            !["installed", "outdated"].includes(current.cuda.state)
          )
            throw new Error(
              "Install a compatible CUDA add-on before enabling GPU processing."
            );
        }
        const config = resolveKoedServerConfig(
          options.paths,
          {},
          { strict: true }
        );
        writeKoedServerConfig(options.paths, {
          ...config,
          hardwareAcceleration: choice.preference
        });
        inspector.invalidate();
        return inspector.inspect();
      });
    }
  };
}

const requestSchema = z.discriminatedUnion("action", [
  z
    .object({
      type: z.literal("koed.desktop.acceleration.request"),
      nonce: z.string(),
      requestId: z.string().uuid(),
      action: z.literal("inspect"),
      refresh: z.boolean()
    })
    .strict(),
  z
    .object({
      type: z.literal("koed.desktop.acceleration.request"),
      nonce: z.string(),
      requestId: z.string().uuid(),
      action: z.literal("save"),
      ...accelerationSaveSchema.shape
    })
    .strict(),
  z
    .object({
      type: z.literal("koed.desktop.acceleration.request"),
      nonce: z.string(),
      requestId: z.string().uuid(),
      action: z.literal("runtime-status")
    })
    .strict(),
  z
    .object({
      type: z.literal("koed.desktop.acceleration.request"),
      nonce: z.string(),
      requestId: z.string().uuid(),
      action: z.literal("install"),
      ...accelerationInstallSchema.shape
    })
    .strict(),
  z
    .object({
      type: z.literal("koed.desktop.acceleration.request"),
      nonce: z.string(),
      requestId: z.string().uuid(),
      action: z.literal("cancel"),
      targetRequestId: z.string().uuid()
    })
    .strict()
]);

export function createDesktopAccelerationRpcHandler(options: {
  manager: ReturnType<typeof createAccelerationManagement>;
  nonce: string;
  send: (message: Record<string, unknown>) => void;
}) {
  const installs = new Map<string, AbortController>();
  const pending = new Map<string, Promise<unknown>>();
  let closing = false;
  const send = (message: Record<string, unknown>) => {
    if (!closing) options.send(message);
  };
  const handle = (message: unknown): boolean => {
    if (closing) return false;
    const parsed = requestSchema.safeParse(message);
    if (!parsed.success || parsed.data.nonce !== options.nonce) return false;
    const request = parsed.data;
    // A duplicate cannot replace the cancellation target or settle the original
    // request with a different response while its work is still running.
    if (pending.has(request.requestId)) return true;
    const response = {
      type: "koed.desktop.acceleration.response",
      nonce: options.nonce,
      requestId: request.requestId,
      action: request.action
    };
    let task: Promise<unknown>;
    if (request.action === "install") {
      const controller = new AbortController();
      installs.set(request.requestId, controller);
      task = options.manager
        .install(
          { mode: request.mode, expectedRevision: request.expectedRevision },
          controller.signal,
          (progress) =>
            send({
              ...response,
              type: "koed.desktop.acceleration.progress",
              progress
            })
        )
        .finally(() => installs.delete(request.requestId));
    } else if (request.action === "cancel") {
      installs.get(request.targetRequestId)?.abort();
      task = Promise.resolve({
        cancelled: installs.has(request.targetRequestId)
      });
    } else if (request.action === "runtime-status") {
      task = Promise.resolve(options.manager.runtimeStatus());
    } else
      task =
        request.action === "inspect"
          ? options.manager.inspect(request.refresh)
          : options.manager.save({
              preference: request.preference,
              expectedRevision: request.expectedRevision
            });
    pending.set(request.requestId, task);
    void task
      .then(
        (result) => send({ ...response, result }),
        (error: unknown) =>
          send({
            ...response,
            error:
              error instanceof Error
                ? error.message
                : "Acceleration operation failed."
          })
      )
      .finally(() => pending.delete(request.requestId));
    return true;
  };
  return Object.assign(handle, {
    async close() {
      closing = true;
      for (const controller of installs.values()) controller.abort();
      await Promise.allSettled(pending.values());
    }
  });
}

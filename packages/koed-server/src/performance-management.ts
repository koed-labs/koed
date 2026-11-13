import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { z } from "zod";
import {
  resolveKoedAppRuntimeExecution,
  resolveKoedRuntimeOwner
} from "./app-runtime.js";
import {
  resolveKoedServerConfig,
  writePerformancePreference
} from "./config.js";
import {
  resolveDesktopRuntimeOwner,
  type DesktopRuntimeCapability
} from "./desktop-runtime-capability.js";
import { resolveEffectiveRuntimeConfig } from "./effective-runtime-config.js";
import {
  readCurrentRuntimeOwner,
  withStoppedRuntime
} from "./generation-lifecycle.js";
import { isPackagedRuntimeMode } from "./runtime-artifact-source.js";
import { observeRuntimeLifecycle } from "./runtime-lifecycle.js";
import {
  isPerformanceChoiceRejection,
  PerformanceChoiceRejectedError,
  resourceProfileValues,
  type PerformanceSnapshot,
  type ResourceValues
} from "./performance-contract.js";
import { performanceChoiceSchema } from "./performance-schema.js";
import type { KoedServerPaths } from "./paths.js";

const variables = {
  backgroundNice: ["KOED_BACKGROUND_NICE"],
  embeddingThreads: ["EMBEDDING_LLAMA_N_THREADS", "LLAMA_N_THREADS"],
  transcriptPollMs: ["MEMORY_CODEX_TRANSCRIPT_POLL_MS"]
} as const;

// Read each variable the way its component does. null means the component
// ignores the value and uses its own default, which matches Balanced.
const positiveInteger = (raw: string): number | null => {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
};
const readers: Record<keyof ResourceValues, (raw: string) => number | null> = {
  // process-priority.ts resolveBackgroundNice
  backgroundNice: (raw) =>
    /^\d+$/.test(raw) && Number(raw) <= 19 ? Number(raw) : null,
  // embedding-service env-config.ts intEnv
  embeddingThreads: positiveInteger,
  // codex-transcript-watcher.ts positiveInt
  transcriptPollMs: (raw) => {
    const value = positiveInteger(raw);
    return value === null ? null : Math.min(value, 60_000);
  }
};

export function createPerformanceManagement(options: {
  paths: KoedServerPaths;
  environment: () => NodeJS.ProcessEnv;
  capability?: DesktopRuntimeCapability;
  cpuCount?: number;
}) {
  const { paths } = options;
  const owner = options.capability
    ? resolveDesktopRuntimeOwner(options.capability, paths.koedHome)
    : resolveKoedRuntimeOwner();
  const inspect = async (): Promise<PerformanceSnapshot> => {
    const requested = options.environment();
    const execution =
      options.capability || isPackagedRuntimeMode(requested)
        ? "packaged"
        : resolveKoedAppRuntimeExecution();
    const { environment } = resolveEffectiveRuntimeConfig(
      paths,
      requested,
      execution
    );
    const config = resolveKoedServerConfig(paths, environment, {
      strict: true
    });
    const lifecycle = observeRuntimeLifecycle(paths);
    let readOnlyReason: string | null =
      config.runtimeMode === "external"
        ? "Performance is managed by the external runtime."
        : null;
    try {
      const current =
        lifecycle.state === "stopped"
          ? await readCurrentRuntimeOwner(paths)
          : lifecycle.owner;
      if (
        lifecycle.state === "unavailable" ||
        (lifecycle.state !== "stopped" && !current)
      )
        readOnlyReason =
          "Runtime ownership could not be verified. Check service status before changing performance.";
      else if (
        current &&
        (current.kind !== owner.kind ||
          current.installationId !== owner.installationId)
      )
        readOnlyReason =
          "Another Koed installation owns this runtime. Change performance from that installation.";
    } catch {
      readOnlyReason =
        "Runtime ownership could not be verified. Check service status before changing performance.";
    }
    const cpuCount = Math.max(1, options.cpuCount ?? cpus().length);
    const overrides = config.resourceOverrides ?? {};
    const effective = {
      ...resourceProfileValues(config.resourceProfile, cpuCount),
      ...overrides
    };
    const managed: PerformanceSnapshot["managed"] = {};
    const invalid: PerformanceSnapshot["invalid"] = {};
    const explicit: Record<string, string> = {};
    const defaults = resourceProfileValues("balanced", cpuCount);
    for (const key of Object.keys(variables) as (keyof ResourceValues)[]) {
      const name = variables[key].find((variable) =>
        environment[variable]?.trim()
      );
      if (!name) continue;
      const raw = environment[name]!.trim();
      const value = readers[key](raw);
      effective[key] = value ?? defaults[key];
      if (value === null)
        invalid[key] = `${name} is not valid, so ${defaults[key]} is used.`;
      managed[key] = "Managed by the environment";
      explicit[name] = environment[name]!;
    }
    if (config.dependencyMode === "external")
      managed.embeddingThreads = "Managed by the external Embedding Service";
    const profileManaged = !!environment.KOED_RESOURCE_PROFILE?.trim();
    const revision = createHash("sha256")
      .update(
        JSON.stringify([
          existsSync(paths.serverConfigPath)
            ? readFileSync(paths.serverConfigPath, "utf8")
            : null,
          explicit,
          environment.KOED_RESOURCE_PROFILE,
          config.runtimeMode,
          config.dependencyMode,
          owner,
          readOnlyReason,
          managed,
          cpuCount
        ])
      )
      .digest("hex");
    return {
      revision,
      runtimeEpoch: lifecycle.epoch,
      runtimeState: lifecycle.state,
      cpuCount,
      preference: { profile: config.resourceProfile, overrides },
      effective,
      profileManaged,
      managed,
      invalid,
      readOnlyReason
    };
  };
  return {
    inspect,
    async save(input: unknown) {
      const parsed = performanceChoiceSchema.safeParse(input);
      if (!parsed.success)
        throw new PerformanceChoiceRejectedError(
          "Performance settings are not valid."
        );
      const choice = parsed.data;
      const reject = (message: string): never => {
        throw new PerformanceChoiceRejectedError(message);
      };
      return withStoppedRuntime(paths, owner, async () => {
        const current = await inspect();
        if (current.readOnlyReason) reject(current.readOnlyReason);
        if (current.revision !== choice.expectedRevision)
          reject(
            "Performance settings changed. Discard your draft and try again."
          );
        if (
          current.profileManaged &&
          choice.profile !== current.preference.profile
        )
          reject("The environment controls the resource profile.");
        const saved = resolveKoedServerConfig(paths, {}, { strict: true });
        const overrides = { ...choice.overrides };
        for (const key of Object.keys(
          current.managed
        ) as (keyof ResourceValues)[]) {
          if (
            overrides[key] !== undefined &&
            overrides[key] !== saved.resourceOverrides?.[key]
          )
            reject(`${current.managed[key]}.`);
        }
        if (
          overrides.embeddingThreads !== undefined &&
          overrides.embeddingThreads > current.cpuCount
        )
          reject(
            "Choose no more embedding threads than the available logical CPUs."
          );
        writePerformancePreference(paths, {
          profile: current.profileManaged
            ? saved.resourceProfile
            : choice.profile,
          overrides
        });
        return inspect();
      });
    }
  };
}

const requestSchema = z.discriminatedUnion("action", [
  z
    .object({
      type: z.literal("koed.desktop.performance.request"),
      nonce: z.string(),
      requestId: z.string().uuid(),
      action: z.literal("inspect")
    })
    .strict(),
  z
    .object({
      type: z.literal("koed.desktop.performance.request"),
      nonce: z.string(),
      requestId: z.string().uuid(),
      action: z.literal("save"),
      ...performanceChoiceSchema.shape
    })
    .strict()
]);
export function createDesktopPerformanceRpcHandler(options: {
  manager: ReturnType<typeof createPerformanceManagement>;
  nonce: string;
  send: (value: Record<string, unknown>) => void;
}) {
  const pending = new Map<string, Promise<unknown>>();
  let closing = false;
  const handle = (value: unknown): boolean => {
    if (closing) return false;
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success || parsed.data.nonce !== options.nonce) return false;
    const request = parsed.data;
    if (pending.has(request.requestId)) return true;
    const task =
      request.action === "inspect"
        ? options.manager.inspect()
        : options.manager.save({
            profile: request.profile,
            overrides: request.overrides,
            expectedRevision: request.expectedRevision
          });
    pending.set(request.requestId, task);
    const response = {
      type: "koed.desktop.performance.response",
      nonce: options.nonce,
      requestId: request.requestId,
      action: request.action
    };
    void task
      .then(
        (result) => {
          if (!closing) options.send({ ...response, result });
        },
        (error: unknown) => {
          if (!closing)
            options.send({
              ...response,
              error:
                error instanceof Error
                  ? error.message
                  : "Performance settings could not be saved.",
              ...(isPerformanceChoiceRejection(error) && { rejected: true })
            });
        }
      )
      .finally(() => pending.delete(request.requestId));
    return true;
  };
  return Object.assign(handle, {
    async close() {
      closing = true;
      await Promise.allSettled(pending.values());
    }
  });
}

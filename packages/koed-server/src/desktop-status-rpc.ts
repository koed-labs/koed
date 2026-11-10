import type { AiClientConnectionId } from "@koed/shared/ai-client-connections";
import {
  connectAiClientAfterSetup,
  verifyAiClientIntegration
} from "./ai-client-authorization.js";
import { setupClaude } from "./claude-setup.js";
import { setupPi } from "./pi-setup.js";
import { persistDoctorVerification } from "./cli-service-output.js";
import {
  resolveDesktopRuntimeOwner,
  type DesktopRuntimeCapability
} from "./desktop-runtime-capability.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  observeRuntimeLifecycle,
  runtimeOwnedBy
} from "./runtime-lifecycle.js";
import {
  collectKoedServerDoctor,
  collectKoedServerStartupStatus,
  collectKoedServerStatus
} from "./status.js";
import { repairCodexIntegration, setupCore, setupCodex } from "./setup.js";

export const createDesktopStatusRpcHandler = (options: {
  nonce: string;
  capability: DesktopRuntimeCapability;
  environment: NodeJS.ProcessEnv;
  send: (message: Record<string, unknown>) => void;
}): ((message: unknown) => boolean) => {
  const dependencies = { desktopRuntimeCapability: options.capability };
  const setupOptions = { ...dependencies, environment: options.environment };
  // Setup and repair connect the AI Client only once verified for this
  // KOED_HOME; status checks never connect one.
  const connect = <R extends { ok: boolean; koedHome: string }>(
    client: AiClientConnectionId,
    run: () => Promise<R>
  ) =>
    connectAiClientAfterSetup({
      client,
      koedHome: resolveKoedServerPaths(options.environment).koedHome,
      run,
      verify: (koedHome) =>
        verifyAiClientIntegration(
          client,
          koedHome,
          options.environment,
          collectKoedServerStatus,
          dependencies
        )
    });
  const actions = {
    status: (startup: boolean) =>
      startup
        ? collectKoedServerStartupStatus(options.environment, dependencies)
        : collectKoedServerStatus(options.environment, dependencies),
    doctor: async () => {
      const doctor = await collectKoedServerDoctor(
        options.environment,
        dependencies
      );
      persistDoctorVerification(
        resolveKoedServerPaths(options.environment),
        doctor
      );
      return doctor;
    },
    // Ownership is judged with the verified capability, never by API health.
    lifecycle: () => {
      const paths = resolveKoedServerPaths(options.environment);
      const observation = observeRuntimeLifecycle(paths);
      return Promise.resolve({
        ...observation,
        owned: runtimeOwnedBy(
          observation,
          resolveDesktopRuntimeOwner(options.capability, paths.koedHome)
        )
      });
    },
    "setup-core": () => setupCore(setupOptions),
    "setup-codex": () => connect("codex", () => setupCodex(setupOptions)),
    "repair-codex": () =>
      connect("codex", () => repairCodexIntegration(setupOptions)),
    "setup-claude": () =>
      connect("claude", () =>
        setupClaude(options.environment, undefined, dependencies)
      ),
    "repair-claude": () =>
      connect("claude", () =>
        setupClaude(options.environment, undefined, dependencies)
      ),
    "setup-pi": () =>
      connect("pi", () =>
        setupPi(options.environment, undefined, dependencies)
      ),
    "repair-pi": () =>
      connect("pi", () => setupPi(options.environment, undefined, dependencies))
  };
  return (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message))
      return false;
    const item = message as Record<string, unknown>;
    if (
      item.type !== "koed.desktop.status.request" ||
      item.nonce !== options.nonce ||
      typeof item.requestId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(item.requestId) ||
      typeof item.action !== "string" ||
      !Object.hasOwn(actions, item.action) ||
      typeof item.startup !== "boolean" ||
      Object.keys(item).length !== 5
    )
      return false;
    const response = {
      type: "koed.desktop.status.response",
      nonce: options.nonce,
      requestId: item.requestId,
      action: item.action
    };
    void actions[item.action as keyof typeof actions](item.startup).then(
      (result) => options.send({ ...response, result }),
      (error: unknown) =>
        options.send({
          ...response,
          error: error instanceof Error ? error.message : String(error)
        })
    );
    return true;
  };
};

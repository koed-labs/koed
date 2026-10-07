import type { DesktopRuntimeCapability } from "./desktop-runtime-capability.js";
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
  const actions = {
    status: (startup: boolean) =>
      startup
        ? collectKoedServerStartupStatus(options.environment, dependencies)
        : collectKoedServerStatus(options.environment, dependencies),
    doctor: () => collectKoedServerDoctor(options.environment, dependencies),
    "setup-core": () => setupCore(setupOptions),
    "setup-codex": () => setupCodex(setupOptions),
    "repair-codex": () => repairCodexIntegration(setupOptions)
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

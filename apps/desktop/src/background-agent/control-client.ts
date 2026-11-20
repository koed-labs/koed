import type { BackgroundAgentLaunchService } from "./launch-service.js";

export type AgentCommand =
  | "start"
  | "stop"
  | "agent-enable"
  | "agent-disable"
  | "agent-status"
  | "start-automatic";
export interface AgentCommandResult {
  ok: boolean;
  error?: string;
  snapshot?: {
    backgroundEnabled?: boolean;
    stopIntent: boolean;
    state?: string;
  };
}

export function createBackgroundAgentControl(input: {
  registration: Pick<BackgroundAgentLaunchService, "get" | "set">;
  ensureStopped(): Promise<void>;
  command(command: AgentCommand): Promise<AgentCommandResult>;
}) {
  const command = async (value: AgentCommand): Promise<void> => {
    const result = await input.command(value);
    if (!result.ok)
      throw new Error(result.error ?? `Background Agent ${value} failed`);
  };
  let pending: Promise<void> = Promise.resolve();
  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  };
  return {
    resume: (): Promise<void> =>
      serialize(async () => {
        const registration = await input.registration.get();
        if (
          !registration.supported ||
          !registration.enabled ||
          registration.status !== "enabled"
        )
          throw new Error(
            "Background Agent registration is not confirmed enabled"
          );
        const status = await input.command("agent-status");
        if (
          !status.ok ||
          !status.snapshot ||
          typeof status.snapshot.backgroundEnabled !== "boolean"
        )
          throw new Error(
            status.error ?? "Background Agent control status is unavailable"
          );
        if (
          !status.snapshot.backgroundEnabled ||
          status.snapshot.stopIntent ||
          status.snapshot.state === "ready" ||
          status.snapshot.state === "starting"
        )
          return;
        if (status.snapshot.state !== "stopped")
          throw new Error("Background Agent runtime requires attention");
        await command("start-automatic");
      }),
    enable: (): Promise<void> =>
      serialize(async () => {
        const before = await input.registration.get();
        if (
          !before.supported ||
          (before.status !== "disabled" && before.status !== "enabled")
        )
          throw new Error(
            "Background Agent registration requires Operator attention"
          );
        await input.ensureStopped();
        const registered =
          before.status === "enabled"
            ? before
            : await input.registration.set(true);
        if (
          !registered.supported ||
          registered.status !== "enabled" ||
          !registered.enabled
        )
          throw new Error(
            "Background Agent registration is not confirmed enabled"
          );
        // A lost response can follow a committed attach; leave registration intact
        // so a retry can reconcile rather than silently disabling the Agent.
        await command("agent-enable");
      }),
    disable: (): Promise<void> =>
      serialize(async () => {
        const before = await input.registration.get();
        if (
          !before.supported ||
          (before.status !== "enabled" && before.status !== "requires-approval")
        )
          throw new Error(
            "Background Agent registration is not confirmed enabled"
          );
        await command("stop");
        await command("agent-disable");
        const unregistered = await input.registration.set(false);
        if (
          !unregistered.supported ||
          unregistered.status !== "disabled" ||
          unregistered.enabled
        )
          throw new Error("Background Agent unregister is unconfirmed");
      })
  };
}

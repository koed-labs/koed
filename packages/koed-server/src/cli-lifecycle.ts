import type { Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import { withCliService } from "./cli-service-loader.js";

export type LifecycleOperation =
  | "start"
  | "stop"
  | "restart"
  | "status"
  | "doctor"
  | "identity";
export interface LifecycleOptions {
  json?: boolean;
  daemon?: boolean;
  startup?: boolean;
  identityAction?: "status" | "rotate";
}

export const registerLifecycleCommands = (
  program: Command,
  dependencies: KoedServerCliDependencies,
  complete: (code: number) => void
): void => {
  const descriptions = {
    start: "Start and supervise local Koed services",
    stop: "Stop supervised local Koed services",
    restart: "Restart supervised local Koed services",
    status: "Show local service state",
    doctor: "Inspect setup and dependencies"
  };
  const bind = (
    command: Command,
    operation: LifecycleOperation,
    identityAction?: "status" | "rotate"
  ) => {
    command
      .option("--json", "Emit JSON output")
      .action(async (options: LifecycleOptions) => {
        complete(
          await withCliService(
            () => import("./cli-lifecycle-operations.js"),
            (service) =>
              service.runLifecycleCommand(
                operation,
                { ...options, identityAction },
                dependencies
              ),
            dependencies,
            options.json
          )
        );
      });
  };
  for (const operation of Object.keys(descriptions) as Array<
    keyof typeof descriptions
  >) {
    const command = program
      .command(operation)
      .description(descriptions[operation]);
    if (operation === "start")
      command.option("--daemon", "Start the supervisor detached");
    if (operation === "status")
      command.option("--startup", "Show lightweight supervisor startup state");
    bind(command, operation);
  }
  const identity = program
    .command("identity")
    .description("Manage deployment and device identity");
  identity.action(() => identity.outputHelp());
  bind(
    identity
      .command("status")
      .description("Show redacted deployment and device identity"),
    "identity",
    "status"
  );
  bind(
    identity
      .command("rotate")
      .description(
        "Create a fresh device identity and invalidate enrollment references"
      ),
    "identity",
    "rotate"
  );
};

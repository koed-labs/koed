import type { Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import { withCliService } from "./cli-service-loader.js";

export type IntegrationOperation = "setup" | "check" | "repair" | "remove";
export interface IntegrationOptions {
  client: "core" | "codex" | "claude" | "pi";
  json?: boolean;
  withMemoryGuidance?: boolean;
  withoutMemoryGuidance?: boolean;
  deferredRecall?: boolean;
  blockingRecall?: boolean;
  backgroundRecall?: boolean;
  capabilitiesRefreshedSince?: string;
  includeStatus?: boolean;
}

export const registerIntegrationCommands = (
  program: Command,
  dependencies: KoedServerCliDependencies,
  complete: (code: number) => void
): void => {
  const descriptions = {
    setup: "Configure core services and AI Client integrations",
    check: "Inspect an AI Client integration without mutation",
    repair: "Repair an AI Client integration",
    remove: "Remove Koed-owned AI Client integration state"
  };
  for (const operation of Object.keys(descriptions) as IntegrationOperation[]) {
    const group = program
      .command(operation)
      .description(descriptions[operation]);
    group.action(() => group.outputHelp());
    const clients: IntegrationOptions["client"][] =
      operation === "setup"
        ? ["core", "codex", "claude", "pi"]
        : ["codex", "claude", "pi"];
    for (const client of clients) {
      const command = group
        .command(client)
        .description(
          client === "core"
            ? "Prepare core services and the local API Token"
            : `${descriptions[operation]} for ${client}`
        )
        .option("--json", "Emit JSON output");
      if (operation === "setup" && client === "codex")
        command
          .option(
            "--with-memory-guidance",
            "Install the recommended global guidance (default)"
          )
          .option(
            "--without-memory-guidance",
            "Disable recommended global guidance installation"
          )
          .option(
            "--deferred-recall",
            "Legacy recall flag; delivery is selected per tool call"
          )
          .option(
            "--blocking-recall",
            "Legacy recall flag; delivery is selected per tool call"
          );
      if (operation === "setup" && client === "claude")
        command.option(
          "--background-recall",
          "Opt in to 500 ms background recall for main-Conversation MCP calls"
        );
      if (operation === "check")
        command
          .option(
            "--capabilities-refreshed-since <value>",
            "Minimum capability refresh timestamp"
          )
          .option(
            "--include-status",
            "Include complete service status in the result"
          );
      command.action(async (options: Omit<IntegrationOptions, "client">) => {
        complete(
          await withCliService(
            () => import("./cli-integration-operations.js"),
            (service) =>
              service.runIntegrationCommand(
                operation,
                { ...options, client },
                dependencies
              ),
            dependencies,
            options.json
          )
        );
      });
    }
  }
};

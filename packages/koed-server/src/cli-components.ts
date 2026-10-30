import { CommanderError, type Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import { reportMissingCliService } from "./cli-service-loader.js";

export type ComponentOperation = "status" | "install" | "activate" | "cleanup";
export interface ComponentOptions {
  json?: boolean;
  component?: string;
  variant?: string;
  version?: string;
  archive?: string;
  manifest?: string;
  archiveUrl?: string;
  manifestUrl?: string;
  stageOnly?: boolean;
}

export const componentSyntaxError = (error: CommanderError): string => {
  const flag = error.message.match(/'(--[a-z][a-z-]*)(?:[^']*)'/)?.[1];
  if (flag && error.code === "commander.unknownOption")
    return `Unsupported components option: ${flag}`;
  if (flag && error.code === "commander.optionMissingArgument")
    return `${flag} requires a value.`;
  return "Invalid components command. Run koed components --help.";
};

export const registerComponentCommands = (
  program: Command,
  dependencies: KoedServerCliDependencies,
  complete: (code: number) => void
): void => {
  const components = program
    .command("components")
    .description("Manage manifest-pinned components");
  components.action(() => components.outputHelp());
  const descriptions = {
    status: "Inspect required, installed, staged, and active components",
    install: "Stage a manifest-pinned exact-version component",
    activate: "Activate a complete staged generation",
    cleanup: "Remove inactive unreferenced generations"
  };
  for (const operation of Object.keys(descriptions) as ComponentOperation[]) {
    const command = components
      .command(operation)
      .description(descriptions[operation])
      .option("--json", "Emit JSON output");
    if (operation === "install")
      command
        .option("--component <id>", "Component identifier: base or privacy")
        .option("--variant <variant>", "Linux x64 Privacy bundle: cpu or cuda")
        .option("--version <version>", "Exact component version")
        .option("--archive <path>", "Offline component archive")
        .option("--manifest <path>", "Offline component manifest")
        .option("--archive-url <url>", "Exact-version component archive URL")
        .option("--manifest-url <url>", "Exact-version component manifest URL")
        .option("--stage-only", "Stage the component without activation");
    if (operation === "activate")
      command.option(
        "--version <version>",
        "Complete staged generation version"
      );
    const seen = new Set<string>();
    for (const option of command.options)
      command.on(`option:${option.name()}`, () => {
        if (seen.has(option.long!))
          throw new CommanderError(
            1,
            "koed.componentInput",
            `Duplicate components option: ${option.long}`
          );
        seen.add(option.long!);
      });
    command.exitOverride((error) => {
      if (error.exitCode === 0) throw error;
      throw new CommanderError(
        1,
        "koed.componentInput",
        componentSyntaxError(error)
      );
    });
    command.action(async (options: ComponentOptions) => {
      // Keep the literal import and its consumer together. Release inspection
      // follows this edge statically without executing candidate package code.
      let service: typeof import("./cli-component-operations.js");
      try {
        service = await import("./cli-component-operations.js");
      } catch {
        complete(reportMissingCliService(dependencies, options.json));
        return;
      }
      complete(
        await service.runComponentCommand(operation, options, dependencies)
      );
    });
  }
};

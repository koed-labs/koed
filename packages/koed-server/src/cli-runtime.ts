import type { Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import { resolveKoedServerPaths } from "./paths.js";

interface RuntimeOptions {
  provider: string;
  dependencyMode?: string;
  json?: boolean;
}

// Runtime actions deliberately do not import the service dispatcher.
export const runRuntimeCommand = async (
  operation: "status" | "install",
  options: RuntimeOptions,
  dependencies: KoedServerCliDependencies
): Promise<number> => {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    if (options.provider !== "homebrew" && options.provider !== "packaged")
      throw new Error("--provider must be homebrew or packaged.");
    if (operation === "install" && options.dependencyMode !== "bundled-local")
      throw new Error(
        "runtime install requires --dependency-mode bundled-local."
      );
    const paths = (dependencies.resolvePaths ?? resolveKoedServerPaths)();
    const loadEnvironment =
      dependencies.loadEnvironment ??
      (await import("./env-file.js")).loadRepoEnv;
    const environment = {
      ...loadEnvironment(paths.repoRoot),
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, value]) => value?.trim())
      )
    };
    let result: { ok: boolean; message: string };
    if (options.provider === "packaged") {
      const execute =
        operation === "status"
          ? (dependencies.collectPackagedRuntimeStatus ??
            (await import("./runtime-packaged.js"))
              .collectPackagedRuntimeStatus)
          : (dependencies.installPackagedRuntime ??
            (await import("./runtime-packaged.js")).installPackagedRuntime);
      result = execute(paths, environment);
    } else {
      const execute =
        operation === "status"
          ? (dependencies.collectRuntimeStatus ??
            (await import("./runtime-homebrew.js"))
              .collectHomebrewRuntimeStatus)
          : (dependencies.installRuntime ??
            (await import("./runtime-homebrew.js")).installHomebrewRuntime);
      result = execute(paths, environment);
    }
    stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${result.message}\n`
    );
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json)
      stdout.write(
        `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`
      );
    else stderr.write(`${message}\n`);
    return 1;
  }
};

export const registerRuntimeCommands = (
  program: Command,
  dependencies: KoedServerCliDependencies,
  complete: (code: number) => void
): void => {
  const runtime = program
    .command("runtime")
    .description("Manage local runtime dependencies");
  runtime.action(() => runtime.outputHelp());
  for (const operation of ["status", "install"] as const) {
    const command = runtime
      .command(operation)
      .description(
        operation === "status"
          ? "Show runtime installation status"
          : "Install local runtime dependencies explicitly"
      )
      .option(
        "--provider <provider>",
        "Runtime provider: homebrew or packaged",
        "homebrew"
      )
      .option(
        "--dependency-mode <mode>",
        "Dependency mode; installation requires bundled-local"
      )
      .option("--json", "Emit JSON output")
      .action(async (options: RuntimeOptions) => {
        complete(await runRuntimeCommand(operation, options, dependencies));
      });
    if (operation === "install")
      command.addHelpText(
        "after",
        "\nExample:\n  koed runtime install --provider homebrew --dependency-mode bundled-local --json"
      );
  }
};

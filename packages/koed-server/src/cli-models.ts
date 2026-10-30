import type { Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import { resolveKoedServerPaths } from "./paths.js";

interface ModelOptions {
  kind: string;
  json?: boolean;
}

export const runModelCommand = async (
  operation: "status" | "install",
  options: ModelOptions,
  dependencies: KoedServerCliDependencies
): Promise<number> => {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    if (options.kind !== "embedding" && options.kind !== "privacy")
      throw new Error("--kind must be embedding or privacy.");
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
    let result: { ok?: boolean; state: string; message: string };
    if (options.kind === "privacy") {
      if (operation === "status") {
        const execute =
          dependencies.collectPrivacyModelStatus ??
          (await import("./privacy-model-runtime.js"))
            .collectPrivacyModelStatus;
        result = await execute(paths);
      } else {
        const execute =
          dependencies.installPrivacyModel ??
          (await import("./privacy-model-runtime.js")).installPrivacyModel;
        result = await execute(paths, environment);
      }
    } else {
      const execute =
        operation === "status"
          ? (dependencies.collectModelStatus ??
            (await import("./local-models-runtime.js")).collectLocalModelStatus)
          : (dependencies.installModel ??
            (await import("./local-models-runtime.js")).installLocalModel);
      result = await execute(paths, options.kind, environment);
    }
    stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${result.message}\n`
    );
    return operation === "status"
      ? result.state === "checksum_mismatch"
        ? 1
        : 0
      : result.ok
        ? 0
        : 1;
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

export const registerModelCommands = (
  program: Command,
  dependencies: KoedServerCliDependencies,
  complete: (code: number) => void
): void => {
  const models = program
    .command("models")
    .description("Manage embedding and privacy models");
  models.action(() => models.outputHelp());
  for (const operation of ["status", "install"] as const)
    models
      .command(operation)
      .description(
        operation === "status"
          ? "Show model installation status"
          : "Download and verify a local model"
      )
      .option("--kind <kind>", "Model kind: embedding or privacy", "embedding")
      .option("--json", "Emit JSON output")
      .action(async (options: ModelOptions) => {
        complete(await runModelCommand(operation, options, dependencies));
      });
};

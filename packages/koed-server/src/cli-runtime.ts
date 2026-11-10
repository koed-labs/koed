import type { Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import { resolveKoedServerPaths } from "./paths.js";

interface RuntimeOptions {
  provider: string;
  dependencyMode?: string;
  json?: boolean;
  runtimeRoot?: string;
  requireModel?: boolean;
  withCuda?: boolean;
  withoutCuda?: boolean;
}

async function withRuntimeCancellation<T>(
  action: (signal: AbortSignal) => Promise<T>
) {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(new Error("Native runtime operation cancelled."));
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    return await action(controller.signal);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

// Runtime actions deliberately do not import the service dispatcher.
export const runRuntimeCommand = async (
  operation: "status" | "install" | "validate",
  options: RuntimeOptions,
  dependencies: KoedServerCliDependencies
): Promise<number> => {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    if (options.withCuda && options.withoutCuda)
      throw new Error("--with-cuda and --without-cuda are mutually exclusive.");
    if (
      (options.withCuda || options.withoutCuda) &&
      (operation !== "install" || options.provider !== "release")
    )
      throw new Error(
        "CUDA asset flags require runtime install --provider release --dependency-mode bundled-local."
      );
    if (
      options.provider !== "homebrew" &&
      options.provider !== "packaged" &&
      options.provider !== "release"
    )
      throw new Error("--provider must be homebrew, packaged, or release.");
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
        // An explicitly empty CUDA mask hides all GPUs.
        Object.entries(process.env).filter(
          ([key, value]) => key === "CUDA_VISIBLE_DEVICES" || value?.trim()
        )
      )
    };
    let result: { ok: boolean; message: string };
    if (options.provider === "release") {
      if (dependencies.desktopRuntimeCapability)
        throw new Error("Use Koed Desktop to manage its runtime.");
      const release = await import("./runtime-release.js");
      if (operation === "validate") {
        if (!options.runtimeRoot?.trim())
          throw new Error("Provide a trusted staged runtime directory.");
        const root = options.runtimeRoot;
        release.assertReleaseHost();
        if (process.platform === "darwin")
          throw new Error("CUDA runtime validation is not supported on macOS.");
        const { withStoppedRuntime } =
          await import("./generation-lifecycle.js");
        const { resolveKoedRuntimeOwner } = await import("./app-runtime.js");
        const { validateStagedCuda } =
          await import("./runtime-release-validation.js");
        result = await withRuntimeCancellation((signal) =>
          withStoppedRuntime(paths, resolveKoedRuntimeOwner(), () =>
            validateStagedCuda(paths, root, environment, {
              signal,
              requireModel: options.requireModel === true
            })
          )
        );
      } else if (operation === "status")
        result = release.collectReleaseRuntimeStatus(paths, environment);
      else {
        let last = 0;
        result = await withRuntimeCancellation((signal) =>
          release.installReleaseRuntime(paths, {
            signal,
            cuda: options.withCuda
              ? "with"
              : options.withoutCuda
                ? "without"
                : "preserve",
            environment,
            progress(event) {
              if (
                Date.now() - last < 1000 &&
                event.transferredBytes !== event.totalBytes
              )
                return;
              last = Date.now();
              stderr.write(
                `Downloading native runtime asset: ${event.transferredBytes} of ${event.totalBytes ?? "unknown"} bytes\n`
              );
            }
          })
        );
      }
    } else if (options.provider === "packaged") {
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
        : `${result.message}\n${"executionPolicy" in result ? `Embedding execution policy: ${String(result.executionPolicy)}.\n` : ""}`
    );
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason =
      error instanceof Error && "reason" in error ? error.reason : undefined;
    if (options.json)
      stdout.write(
        `${JSON.stringify({ ok: false, error: message, reason }, null, 2)}\n`
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
  runtime
    .command("validate")
    .description(
      "Run stopped-runtime CPU/CUDA checks on a trusted, staged Linux runtime"
    )
    .requiredOption(
      "--runtime-root <directory>",
      "Trusted directory containing llama.cpp/cpu and llama.cpp/cuda; its binaries will execute"
    )
    .option(
      "--require-model",
      "Require CPU/GPU inference with the already installed embedding model"
    )
    .option("--json", "Emit JSON output")
    .action(async (options: Omit<RuntimeOptions, "provider">) => {
      complete(
        await runRuntimeCommand(
          "validate",
          { ...options, provider: "release" },
          dependencies
        )
      );
    });
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
        "Runtime provider: homebrew, packaged, or release",
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
      command
        .option(
          "--with-cuda",
          "Install the pinned CUDA add-on with its compatible CPU core"
        )
        .option(
          "--without-cuda",
          "Select CPU only and retain the previous payloads"
        )
        .addHelpText(
          "after",
          "\nExample:\n  koed runtime install --provider homebrew --dependency-mode bundled-local --json"
        );
  }
};

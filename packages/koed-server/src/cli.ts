#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolveKoedServerPaths } from "./paths.js";
import {
  personalSyncAdvancedUsageText,
  personalSyncUsageText,
  usageText
} from "./cli-help.js";
import { startKoedServerDaemon } from "./daemon-start.js";
import type { KoedServerCliDependencies } from "./cli-implementation.js";

export {
  personalSyncAdvancedUsageText,
  personalSyncUsageText,
  usageText,
  startKoedServerDaemon
};
export type { KoedServerCliDependencies } from "./cli-implementation.js";
export type {
  KoedServerStartDaemonOptions,
  KoedServerStartDaemonResult
} from "./daemon-start.js";

const printJson = (
  stdout: Pick<NodeJS.WriteStream, "write">,
  value: unknown
): void => {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const mergeRepoEnvironment = (
  repoEnv: Record<string, string>,
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => ({
  ...repoEnv,
  ...Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value?.trim())
  )
});

const lightweightStatus = async (
  args: string[],
  stdout: Pick<NodeJS.WriteStream, "write">
): Promise<number | null> => {
  const [command, subcommand] = args;
  const wantsJson = args.includes("--json");
  const paths = resolveKoedServerPaths();
  if (command === "models" && subcommand === "status") {
    const kindFlag = args.indexOf("--kind");
    const kind = kindFlag < 0 ? "embedding" : args[kindFlag + 1];
    if (kind !== "embedding" && kind !== "reranker" && kind !== "privacy")
      throw new Error("--kind must be embedding, reranker, or privacy.");
    const [
      { collectLocalModelStatus },
      { collectPrivacyModelStatus },
      { loadRepoEnv }
    ] = await Promise.all([
      import("./local-models-runtime.js"),
      import("./privacy-model-runtime.js"),
      import("./env-file.js")
    ]);
    const environment = mergeRepoEnvironment(loadRepoEnv(paths.repoRoot));
    const result =
      kind === "privacy"
        ? await collectPrivacyModelStatus(paths)
        : await collectLocalModelStatus(paths, kind, environment);
    if (wantsJson) printJson(stdout, result);
    else stdout.write(`${result.message}\n`);
    return result.state === "checksum_mismatch" ? 1 : 0;
  }
  if (command === "runtime" && subcommand === "status") {
    const providerFlag = args.indexOf("--provider");
    const provider = providerFlag < 0 ? "homebrew" : args[providerFlag + 1];
    if (provider !== "homebrew" && provider !== "packaged")
      throw new Error("--provider must be homebrew or packaged.");
    const [
      { collectHomebrewRuntimeStatus },
      { collectPackagedRuntimeStatus },
      { loadRepoEnv }
    ] = await Promise.all([
      import("./runtime-homebrew.js"),
      import("./runtime-packaged.js"),
      import("./env-file.js")
    ]);
    const environment = mergeRepoEnvironment(loadRepoEnv(paths.repoRoot));
    const result =
      provider === "packaged"
        ? collectPackagedRuntimeStatus(paths, environment)
        : collectHomebrewRuntimeStatus(paths, environment);
    if (wantsJson) printJson(stdout, result);
    else stdout.write(`${result.message}\n`);
    return result.ok ? 0 : 1;
  }
  return null;
};

export const runKoedServerCli = async (
  args: string[],
  dependencies?: KoedServerCliDependencies
): Promise<number> => {
  const [command] = args;
  const wantsHelp = args.includes("--help") || args.includes("-h");
  const stdout = dependencies?.stdout ?? process.stdout;
  if (wantsHelp || !command) {
    stdout.write(
      command === "personal-sync"
        ? args.includes("--advanced")
          ? personalSyncAdvancedUsageText
          : personalSyncUsageText
        : usageText
    );
    return 0;
  }
  if (
    (command === "models" || command === "runtime") &&
    !dependencies?.collectModelStatus &&
    !dependencies?.collectPrivacyModelStatus &&
    !dependencies?.collectRuntimeStatus &&
    !dependencies?.collectPackagedRuntimeStatus
  ) {
    try {
      const status = await lightweightStatus(args, stdout);
      if (status !== null) return status;
    } catch (error) {
      const stderr = process.stderr;
      stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      );
      return 1;
    }
  }
  let implementation: typeof import("./cli-implementation.js");
  try {
    implementation = await import("./cli-implementation.js");
  } catch {
    const message =
      "Koed service runtime is not provisioned. Install the signed base component from a trusted offline archive set, then run `koed doctor`.";
    const stderr = dependencies?.stderr ?? process.stderr;
    if (args.includes("--json"))
      printJson(dependencies?.stdout ?? process.stdout, {
        ok: false,
        error: message,
        action: "components install --component base"
      });
    else stderr.write(`${message}\n`);
    return 1;
  }
  return implementation.runKoedServerCli(args, dependencies);
};

export const isKoedServerCliEntrypoint = (
  moduleUrl: string | undefined,
  argvPath: string | undefined
): boolean => {
  if (!moduleUrl || !argvPath) return false;
  try {
    return pathToFileURL(argvPath).href === moduleUrl;
  } catch {
    return false;
  }
};

export const shouldExitPackagedSupervisor = (
  args: string[],
  environment: NodeJS.ProcessEnv = process.env
): boolean =>
  environment.KOED_PACKAGED_DESKTOP === "1" &&
  args[0] === "start" &&
  !args.includes("--daemon");

if (isKoedServerCliEntrypoint(import.meta.url, process.argv[1])) {
  const entrypointArgs = process.argv.slice(2);
  void runKoedServerCli(entrypointArgs).then((exitCode) => {
    if (shouldExitPackagedSupervisor(entrypointArgs)) process.exit(exitCode);
    process.exitCode = exitCode;
  });
}

#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommandTree } from "./cli-command-tree.js";
import { startKoedServerDaemon } from "./daemon-start.js";
import type { KoedServerCliDependencies } from "./cli-contract.js";

export { startKoedServerDaemon };
export type { KoedServerCliDependencies } from "./cli-contract.js";
export type {
  KoedServerStartDaemonOptions,
  KoedServerStartDaemonResult
} from "./daemon-start.js";

export const runKoedServerCli = async (
  args: string[],
  dependencies?: KoedServerCliDependencies
): Promise<number> => runCommandTree(args, dependencies);

export const isKoedServerCliEntrypoint = (
  moduleUrl: string | undefined,
  argvPath: string | undefined
): boolean => {
  if (!moduleUrl || !argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    try {
      return pathToFileURL(argvPath).href === moduleUrl;
    } catch {
      return false;
    }
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

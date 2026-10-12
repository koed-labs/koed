#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  personalSyncUsageText,
  personalSyncAdvancedUsageText,
  usageText
} from "./cli-help.js";
import type { KoedServerCliDependencies } from "./cli-implementation.js";

export { personalSyncUsageText, personalSyncAdvancedUsageText, usageText };
export { startKoedServerDaemon } from "./daemon-start.js";
export type { KoedServerCliDependencies } from "./cli-implementation.js";
export type {
  KoedServerStartDaemonOptions,
  KoedServerStartDaemonResult
} from "./daemon-start.js";

export const runKoedServerCli = async (
  args: string[],
  dependencies?: KoedServerCliDependencies
): Promise<number> => {
  const [command] = args;
  if (!command || args.includes("--help") || args.includes("-h")) {
    (dependencies?.stdout ?? process.stdout).write(
      command === "personal-sync"
        ? args.includes("--advanced")
          ? personalSyncAdvancedUsageText
          : personalSyncUsageText
        : usageText
    );
    return 0;
  }
  const implementation = await import("./cli-implementation.js");
  return implementation.runKoedServerCli(args, dependencies);
};

export const isKoedServerCliEntrypoint = (
  metaUrl: string,
  argvPath: string | undefined
): boolean => {
  if (!argvPath) {
    return false;
  }
  const normalize = (path: string) => {
    const resolved = resolve(path);
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  return normalize(fileURLToPath(metaUrl)) === normalize(argvPath);
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
    if (shouldExitPackagedSupervisor(entrypointArgs)) {
      process.exit(exitCode);
    }
    process.exitCode = exitCode;
  });
}

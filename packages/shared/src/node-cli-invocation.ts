import { realpathSync } from "node:fs";
import { extname } from "node:path";

export interface NodeCliInvocation {
  command: string;
  args: string[];
}

const NODE_ENTRY_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

export const nodeCliInvocation = (
  executablePath: string,
  args: string[],
  nodeExecutable: string = process.execPath
): NodeCliInvocation => {
  let resolvedExecutablePath = executablePath;
  try {
    resolvedExecutablePath = realpathSync(executablePath);
  } catch {
    // Bare PATH commands and missing paths retain their original diagnostics.
  }
  return NODE_ENTRY_EXTENSIONS.has(
    extname(resolvedExecutablePath).toLowerCase()
  )
    ? {
        command: nodeExecutable,
        args: [resolvedExecutablePath, ...args]
      }
    : { command: resolvedExecutablePath, args };
};

export const nodeCliProcessEnvironment = (
  invocation: NodeCliInvocation,
  environment: NodeJS.ProcessEnv,
  runtimeEnvironment: NodeJS.ProcessEnv = process.env,
  nodeExecutable: string = process.execPath
): NodeJS.ProcessEnv =>
  invocation.command === nodeExecutable &&
  runtimeEnvironment.ELECTRON_RUN_AS_NODE === "1"
    ? { ...environment, ELECTRON_RUN_AS_NODE: "1" }
    : environment;

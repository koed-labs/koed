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
): NodeCliInvocation =>
  NODE_ENTRY_EXTENSIONS.has(extname(executablePath).toLowerCase())
    ? { command: nodeExecutable, args: [executablePath, ...args] }
    : { command: executablePath, args };

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

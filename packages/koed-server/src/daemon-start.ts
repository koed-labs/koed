import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { capSupervisorLog } from "./supervisor-log.js";
import { resolveKoedServerPaths } from "./paths.js";

type SpawnLike = typeof nodeSpawn;

export interface KoedServerStartDaemonResult {
  ok: boolean;
  state: "starting" | "needs_attention";
  koedHome: string;
  message: string;
  startedPid?: number;
  logPath?: string;
  error?: string;
}

export interface KoedServerStartDaemonOptions {
  environment?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  startCommand?: string;
  startArgs?: string[];
  resolvePaths?: typeof resolveKoedServerPaths;
}

const configuredDaemonInvocation = (
  environment: NodeJS.ProcessEnv
): { command: string; args: string[] } | null => {
  const command = environment.KOED_SERVER_DAEMON_COMMAND?.trim();
  const argsJson = environment.KOED_SERVER_DAEMON_ARGS_JSON?.trim();
  if (!command || !argsJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every((arg) => typeof arg === "string")
    ) {
      throw new Error("KOED_SERVER_DAEMON_ARGS_JSON must be a string array.");
    }
    return { command, args: parsed };
  } catch (error) {
    throw new Error(
      `Could not parse KOED_SERVER_DAEMON_ARGS_JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

export const startKoedServerDaemon = ({
  environment = process.env,
  spawn = nodeSpawn,
  startCommand = process.argv[1],
  startArgs,
  resolvePaths = resolveKoedServerPaths
}: KoedServerStartDaemonOptions = {}): KoedServerStartDaemonResult => {
  const paths = resolvePaths(environment);
  const configured = configuredDaemonInvocation(environment);
  const command = configured?.command ?? process.execPath;
  const args =
    configured?.args ??
    startArgs ??
    (startCommand ? [startCommand, "start"] : []);
  if (args.length === 0) {
    return {
      ok: false,
      state: "needs_attention",
      koedHome: paths.koedHome,
      message: "Could not resolve koed-server CLI path for daemon start.",
      error: "Could not resolve koed-server CLI path for daemon start."
    };
  }
  const logPath = resolve(paths.logsDir, "supervisor.log");
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try {
    mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
    capSupervisorLog(logPath);
    appendFileSync(
      logPath,
      `\n[${new Date().toISOString()}] Starting koed-server supervisor.\n`,
      { mode: 0o600 }
    );
    stdoutFd = openSync(logPath, "a", 0o600);
    stderrFd = openSync(logPath, "a", 0o600);
    const child = spawn(command, args, {
      cwd: environment.KOED_REPO_ROOT ?? process.cwd(),
      detached: true,
      env: { ...environment, KOED_SERVER_SUPERVISOR_LOG_PATH: logPath },
      stdio: ["ignore", stdoutFd, stderrFd]
    }) as ChildProcess;
    if (!child.pid) {
      throw new Error("koed-server daemon child process did not report a pid.");
    }
    child.unref();
    return {
      ok: true,
      state: "starting",
      koedHome: paths.koedHome,
      message: "Koed server daemon start requested.",
      startedPid: child.pid,
      logPath
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      state: "needs_attention",
      koedHome: paths.koedHome,
      message,
      logPath,
      error: message
    };
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
};

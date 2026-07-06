#!/usr/bin/env node
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { loadRepoEnv } from "./env-file.js";
import { repairCodexIntegration, setupCodex } from "./setup.js";
import { collectKoedServerDoctor, collectKoedServerStatus } from "./status.js";
import { restartKoedServer } from "./restart.js";
import { startKoedServer } from "./start.js";
import { stopKoedServer } from "./stop.js";
import {
  collectLocalModelStatus,
  installLocalModel,
  type LocalModelKind
} from "./local-models-runtime.js";
import {
  collectHomebrewRuntimeStatus,
  installHomebrewRuntime
} from "./runtime-homebrew.js";
import {
  collectPackagedRuntimeStatus,
  installPackagedRuntime
} from "./runtime-packaged.js";
import { resolveKoedServerPaths } from "./paths.js";

export const usageText = `Usage: koed-server <command> [options]

Commands:
  start                  Start and supervise local Koed services
  start --daemon --json  Start koed-server supervisor detached
  stop --json            Stop supervised local Koed services
  restart --json         Restart supervised local Koed services
  status --json          Print machine-readable local service state
  doctor --json          Print actionable setup/dependency diagnostics
  setup codex --json     Configure the supported Codex integration
  repair codex --json    Rewrite Codex integration for the active local API
  models status --json   Print bundled local model install state
  models install --json  Download bundled local model with SHA-256 verification
  runtime status --json  Print native bundled-local runtime install state
  runtime install --json Install native bundled-local runtime assets explicitly

Runtime providers:
  --provider homebrew       Use Homebrew-backed runtime assets (default)
  --provider packaged       Use packaged runtime resources from the app bundle

Options:
  --json                 Emit JSON output for commands that support it
  --help, -h             Show this help

Environment:
  KOED_HOME              Directory for local Koed config, logs, and runtime state
  KOED_REPO_ROOT         Koed checkout path used by this development build
`;

export interface KoedServerCliDependencies {
  collectStatus?: typeof collectKoedServerStatus;
  collectDoctor?: typeof collectKoedServerDoctor;
  start?: typeof startKoedServer;
  startDaemon?: typeof startKoedServerDaemon;
  stop?: typeof stopKoedServer;
  restart?: typeof restartKoedServer;
  setupCodex?: typeof setupCodex;
  repairCodex?: typeof repairCodexIntegration;
  collectModelStatus?: typeof collectLocalModelStatus;
  installModel?: typeof installLocalModel;
  collectRuntimeStatus?: typeof collectHomebrewRuntimeStatus;
  installRuntime?: typeof installHomebrewRuntime;
  collectPackagedRuntimeStatus?: typeof collectPackagedRuntimeStatus;
  installPackagedRuntime?: typeof installPackagedRuntime;
  loadEnvironment?: typeof loadRepoEnv;
  resolvePaths?: typeof resolveKoedServerPaths;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

const printJson = (
  stdout: Pick<NodeJS.WriteStream, "write">,
  value: unknown
) => {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const flagValue = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

type SpawnLike = typeof nodeSpawn;

export interface KoedServerStartDaemonResult {
  ok: boolean;
  state: "starting" | "needs_attention";
  koedHome: string;
  message: string;
  startedPid?: number;
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
  try {
    const child = spawn(command, args, {
      cwd: environment.KOED_REPO_ROOT ?? process.cwd(),
      detached: true,
      env: environment,
      stdio: "ignore"
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
      startedPid: child.pid
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      state: "needs_attention",
      koedHome: paths.koedHome,
      message,
      error: message
    };
  }
};

const assertRuntimeFlags = (
  args: string[],
  command: "status" | "install"
): "homebrew" | "packaged" => {
  const provider = flagValue(args, "--provider") ?? "homebrew";
  if (provider !== "homebrew" && provider !== "packaged") {
    throw new Error("--provider must be homebrew or packaged.");
  }
  const dependencyMode = flagValue(args, "--dependency-mode");
  if (command === "install" && dependencyMode !== "bundled-local") {
    throw new Error(
      "runtime install requires --dependency-mode bundled-local."
    );
  }
  return provider;
};

export const runKoedServerCli = async (
  args: string[],
  {
    collectStatus = collectKoedServerStatus,
    collectDoctor = collectKoedServerDoctor,
    start = startKoedServer,
    startDaemon = startKoedServerDaemon,
    stop = stopKoedServer,
    restart = restartKoedServer,
    setupCodex: setup = setupCodex,
    repairCodex = repairCodexIntegration,
    collectModelStatus = collectLocalModelStatus,
    installModel = installLocalModel,
    collectRuntimeStatus = collectHomebrewRuntimeStatus,
    installRuntime = installHomebrewRuntime,
    collectPackagedRuntimeStatus:
      collectPackagedRuntime = collectPackagedRuntimeStatus,
    installPackagedRuntime: installPackaged = installPackagedRuntime,
    loadEnvironment = loadRepoEnv,
    resolvePaths = resolveKoedServerPaths,
    stdout = process.stdout,
    stderr = process.stderr
  }: KoedServerCliDependencies = {}
): Promise<number> => {
  const command = args[0];
  const subcommand = args[1];
  const wantsHelp = args.includes("--help") || args.includes("-h");
  const wantsJson = args.includes("--json");
  const kindFlagIndex = args.indexOf("--kind");
  const modelKind = (
    kindFlagIndex >= 0 ? args[kindFlagIndex + 1] : "embedding"
  ) as LocalModelKind | undefined;

  try {
    if (wantsHelp || !command) {
      stdout.write(usageText);
      return 0;
    }

    if (command === "status") {
      const status = await collectStatus();
      if (wantsJson) {
        printJson(stdout, status);
      } else {
        stdout.write(`${status.state}\n`);
      }
      return 0;
    }

    if (command === "doctor") {
      const doctor = await collectDoctor();
      if (wantsJson) {
        printJson(stdout, doctor);
      } else {
        stdout.write(`${doctor.summary}\n`);
      }
      return doctor.ok ? 0 : 1;
    }

    if (command === "start") {
      if (args.includes("--daemon")) {
        const result = startDaemon();
        if (wantsJson) {
          printJson(stdout, result);
        } else {
          stdout.write(`${result.message}\n`);
        }
        return result.ok ? 0 : 1;
      }
      await start();
      return 0;
    }

    if (command === "stop") {
      const result = stop();
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "restart") {
      const result = await restart();
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "setup" && subcommand === "codex") {
      const result = setup();
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(
          result.ok
            ? "Codex setup completed.\n"
            : `${result.error ?? "Codex setup failed."}\n`
        );
      }
      return result.ok ? 0 : 1;
    }

    if (command === "repair" && subcommand === "codex") {
      const result = repairCodex();
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(
          result.ok
            ? "Codex integration repaired. Restart Codex and trust updated hooks if prompted.\n"
            : `${result.error ?? "Codex integration repair failed."}\n`
        );
      }
      return result.ok ? 0 : 1;
    }

    if (command === "models" && subcommand === "status") {
      if (modelKind !== "embedding" && modelKind !== "reranker") {
        throw new Error("--kind must be embedding or reranker.");
      }
      const paths = resolvePaths();
      const modelEnvironment = {
        ...loadEnvironment(paths.repoRoot),
        ...process.env
      };
      const result = await collectModelStatus(
        paths,
        modelKind,
        modelEnvironment
      );
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.state === "checksum_mismatch" ? 1 : 0;
    }

    if (command === "models" && subcommand === "install") {
      if (modelKind !== "embedding" && modelKind !== "reranker") {
        throw new Error("--kind must be embedding or reranker.");
      }
      const paths = resolvePaths();
      const modelEnvironment = {
        ...loadEnvironment(paths.repoRoot),
        ...process.env
      };
      const result = await installModel(paths, modelKind, modelEnvironment);
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "runtime" && subcommand === "status") {
      const provider = assertRuntimeFlags(args, "status");
      const paths = resolvePaths();
      const runtimeEnvironment = {
        ...loadEnvironment(paths.repoRoot),
        ...process.env
      };
      const result =
        provider === "packaged"
          ? collectPackagedRuntime(paths, runtimeEnvironment)
          : collectRuntimeStatus(paths, runtimeEnvironment);
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "runtime" && subcommand === "install") {
      const provider = assertRuntimeFlags(args, "install");
      const paths = resolvePaths();
      const runtimeEnvironment = {
        ...loadEnvironment(paths.repoRoot),
        ...process.env
      };
      const result =
        provider === "packaged"
          ? installPackaged(paths, runtimeEnvironment)
          : installRuntime(paths, runtimeEnvironment);
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    stderr.write(`Unknown command.\n\n${usageText}`);
    return 2;
  } catch (error) {
    const payload = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
    if (wantsJson) {
      printJson(stdout, payload);
    } else {
      stderr.write(`${payload.error}\n`);
    }
    return 1;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void runKoedServerCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

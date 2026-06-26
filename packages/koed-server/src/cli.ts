#!/usr/bin/env node
import { loadRepoEnv } from "./env-file.js";
import { setupCodex } from "./setup.js";
import { collectKoedServerDoctor, collectKoedServerStatus } from "./status.js";
import { restartKoedServer } from "./restart.js";
import { startKoedServer } from "./start.js";
import { stopKoedServer } from "./stop.js";
import {
  collectLocalModelStatus,
  installLocalModel,
  type LocalModelKind
} from "./local-models-runtime.js";
import { resolveKoedServerPaths } from "./paths.js";

export const usageText = `Usage: koed-server <command> [options]

Commands:
  start                  Start and supervise local Koed services
  stop --json            Stop supervised local Koed services
  restart --json         Restart supervised local Koed services
  status --json          Print machine-readable local service state
  doctor --json          Print actionable setup/dependency diagnostics
  setup codex --json     Configure the supported Codex integration
  models status --json   Print bundled local model install state
  models install --json  Download bundled local model with SHA-256 verification

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
  stop?: typeof stopKoedServer;
  restart?: typeof restartKoedServer;
  setupCodex?: typeof setupCodex;
  collectModelStatus?: typeof collectLocalModelStatus;
  installModel?: typeof installLocalModel;
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

export const runKoedServerCli = async (
  args: string[],
  {
    collectStatus = collectKoedServerStatus,
    collectDoctor = collectKoedServerDoctor,
    start = startKoedServer,
    stop = stopKoedServer,
    restart = restartKoedServer,
    setupCodex: setup = setupCodex,
    collectModelStatus = collectLocalModelStatus,
    installModel = installLocalModel,
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

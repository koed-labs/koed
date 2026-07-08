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
import {
  listUpstreamBackends,
  refreshUpstreamBackendCapabilities,
  registerUpstreamBackend,
  removeUpstreamBackend,
  updateUpstreamBackendRoutePolicy,
  type UpstreamRoutePolicyUpdate
} from "./upstream-registry.js";
import {
  getProjectTeamWorkspaceLink,
  linkProjectTeamWorkspace,
  listProjectTeamWorkspaceLinks,
  removeProjectTeamWorkspaceLink
} from "./project-team-workspace-links.js";
import { shareProjectCapturedSession } from "./team-dogfood.js";
import {
  cancelUpstreamEnrollment,
  disconnectUpstreamBackendEnrollment,
  getUpstreamEnrollmentStatus,
  startUpstreamEnrollment
} from "./upstream-enrollment.js";

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
  upstream list --json   List registered upstream backend status
  upstream register --json Register or update an upstream backend
  upstream refresh --json Refresh cached upstream capabilities
  upstream policy --json  Update explicit upstream route-policy families
  upstream remove --json Remove an upstream backend
  upstream enroll start --json Start local upstream enrollment orchestration
  upstream enroll status --json Print local upstream enrollment state
  upstream enroll cancel --json Cancel local upstream enrollment orchestration
  upstream disconnect --json Disable local upstream routes and enrollment state
  team workspace link --json Link a local Project root to a Team Workspace id
  team workspace list --json List local Project to Team Workspace links
  team workspace show --json Show the Team Workspace link for a Project root
  team workspace remove --json Remove the Team Workspace link for a Project root
  team capture share-latest --json Share latest/selected Captured Session into linked Team Workspace

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
  listUpstreams?: typeof listUpstreamBackends;
  registerUpstream?: typeof registerUpstreamBackend;
  refreshUpstream?: typeof refreshUpstreamBackendCapabilities;
  updateUpstreamPolicy?: typeof updateUpstreamBackendRoutePolicy;
  removeUpstream?: typeof removeUpstreamBackend;
  startUpstreamEnroll?: typeof startUpstreamEnrollment;
  getUpstreamEnrollStatus?: typeof getUpstreamEnrollmentStatus;
  cancelUpstreamEnroll?: typeof cancelUpstreamEnrollment;
  disconnectUpstream?: typeof disconnectUpstreamBackendEnrollment;
  linkProjectTeamWorkspace?: typeof linkProjectTeamWorkspace;
  listProjectTeamWorkspaceLinks?: typeof listProjectTeamWorkspaceLinks;
  getProjectTeamWorkspaceLink?: typeof getProjectTeamWorkspaceLink;
  removeProjectTeamWorkspaceLink?: typeof removeProjectTeamWorkspaceLink;
  shareProjectCapturedSession?: typeof shareProjectCapturedSession;
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

const mergeRepoEnvironment = (
  repoEnv: Record<string, string>,
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const nonEmptyEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value?.trim())
  );
  return {
    ...repoEnv,
    ...nonEmptyEnvironment
  };
};

const flagValue = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const requireFlagValue = (args: string[], name: string): string => {
  const value = flagValue(args, name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
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

const routePolicyFlags: Array<{
  flag: string;
  key: keyof UpstreamRoutePolicyUpdate;
}> = [
  { flag: "--personal-memory-read", key: "personalMemoryRead" },
  { flag: "--team-workspace-read", key: "teamWorkspaceRead" },
  { flag: "--share-grant-management", key: "shareGrantManagement" },
  { flag: "--capture-writes", key: "captureWrites" },
  { flag: "--sync", key: "sync" },
  { flag: "--admin", key: "admin" }
];

const parseRoutePolicyUpdate = (args: string[]): UpstreamRoutePolicyUpdate => {
  const update: UpstreamRoutePolicyUpdate = {};
  for (const { flag, key } of routePolicyFlags) {
    const value = flagValue(args, flag);
    if (!value) continue;
    if (value !== "enabled" && value !== "disabled") {
      throw new Error(`${flag} must be enabled or disabled.`);
    }
    update[key] = value;
  }
  return update;
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
    listUpstreams = listUpstreamBackends,
    registerUpstream = registerUpstreamBackend,
    refreshUpstream = refreshUpstreamBackendCapabilities,
    updateUpstreamPolicy = updateUpstreamBackendRoutePolicy,
    removeUpstream = removeUpstreamBackend,
    startUpstreamEnroll = startUpstreamEnrollment,
    getUpstreamEnrollStatus = getUpstreamEnrollmentStatus,
    cancelUpstreamEnroll = cancelUpstreamEnrollment,
    disconnectUpstream = disconnectUpstreamBackendEnrollment,
    linkProjectTeamWorkspace: linkProjectWorkspace = linkProjectTeamWorkspace,
    listProjectTeamWorkspaceLinks:
      listProjectWorkspaceLinks = listProjectTeamWorkspaceLinks,
    getProjectTeamWorkspaceLink:
      getProjectWorkspaceLink = getProjectTeamWorkspaceLink,
    removeProjectTeamWorkspaceLink:
      removeProjectWorkspaceLink = removeProjectTeamWorkspaceLink,
    shareProjectCapturedSession:
      shareProjectSession = shareProjectCapturedSession,
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
      const modelEnvironment = mergeRepoEnvironment(
        loadEnvironment(paths.repoRoot)
      );
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
      const modelEnvironment = mergeRepoEnvironment(
        loadEnvironment(paths.repoRoot)
      );
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
      const runtimeEnvironment = mergeRepoEnvironment(
        loadEnvironment(paths.repoRoot)
      );
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
      const runtimeEnvironment = mergeRepoEnvironment(
        loadEnvironment(paths.repoRoot)
      );
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

    if (command === "upstream" && subcommand === "list") {
      const paths = resolvePaths();
      const result = listUpstreams(paths);
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "upstream" && subcommand === "register") {
      const paths = resolvePaths();
      const result = registerUpstream(paths, {
        url: requireFlagValue(args, "--url"),
        id: flagValue(args, "--id"),
        displayName: flagValue(args, "--name"),
        profile: flagValue(args, "--profile")
      });
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "upstream" && subcommand === "refresh") {
      const paths = resolvePaths();
      const result = await refreshUpstream(
        paths,
        requireFlagValue(args, "--id")
      );
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "upstream" && subcommand === "policy") {
      const paths = resolvePaths();
      const result = updateUpstreamPolicy(
        paths,
        requireFlagValue(args, "--id"),
        parseRoutePolicyUpdate(args)
      );
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "upstream" && subcommand === "remove") {
      const paths = resolvePaths();
      const result = removeUpstream(paths, requireFlagValue(args, "--id"));
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "upstream" && subcommand === "enroll") {
      const enrollCommand = args[2];
      const paths = resolvePaths();
      const id = requireFlagValue(args, "--id");
      const result =
        enrollCommand === "start"
          ? startUpstreamEnroll(paths, id)
          : enrollCommand === "status"
            ? getUpstreamEnrollStatus(paths, id)
            : enrollCommand === "cancel"
              ? cancelUpstreamEnroll(paths, id)
              : null;
      if (!result) {
        throw new Error(
          "upstream enroll command must be start, status, or cancel."
        );
      }
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "upstream" && subcommand === "disconnect") {
      const paths = resolvePaths();
      const result = disconnectUpstream(paths, requireFlagValue(args, "--id"));
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "team" && subcommand === "workspace") {
      const teamWorkspaceCommand = args[2];
      const paths = resolvePaths();
      const result =
        teamWorkspaceCommand === "link"
          ? linkProjectWorkspace(paths, {
              projectRoot: requireFlagValue(args, "--project-root"),
              teamWorkspaceId: requireFlagValue(args, "--team-workspace-id"),
              backendId: flagValue(args, "--backend-id")
            })
          : teamWorkspaceCommand === "list"
            ? listProjectWorkspaceLinks(paths)
            : teamWorkspaceCommand === "show"
              ? getProjectWorkspaceLink(
                  paths,
                  requireFlagValue(args, "--project-root")
                )
              : teamWorkspaceCommand === "remove"
                ? removeProjectWorkspaceLink(
                    paths,
                    requireFlagValue(args, "--project-root")
                  )
                : null;
      if (!result) {
        throw new Error(
          "team workspace command must be link, list, show, or remove."
        );
      }
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (
      command === "team" &&
      subcommand === "capture" &&
      args[2] === "share-latest"
    ) {
      const paths = resolvePaths();
      const repoEnv = loadEnvironment(paths.repoRoot);
      const result = await shareProjectSession(
        paths,
        {
          projectRoot: flagValue(args, "--project-root") ?? process.cwd(),
          sessionId: flagValue(args, "--session-id")
        },
        process.env,
        repoEnv
      );
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

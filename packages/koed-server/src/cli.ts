#!/usr/bin/env node
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepoEnv } from "./env-file.js";
import { capSupervisorLog } from "./supervisor-log.js";
import {
  removeCodexIntegration,
  repairCodexIntegration,
  setupCodex,
  setupCore
} from "./setup.js";
import { removePi, setupPi } from "./pi-setup.js";
import { removeClaude, setupClaude } from "./claude-setup.js";
import {
  collectKoedServerDoctor,
  collectKoedServerStartupStatus,
  collectKoedServerStatus,
  evaluateAiClientReadiness
} from "./status.js";
import { restartKoedServer } from "./restart.js";
import { startKoedServer } from "./start.js";
import { stopKoedServer } from "./stop.js";
import { runDesktopCollaborationBrokerProcess } from "./desktop-collaboration-broker.js";
import {
  collectLocalModelStatus,
  installLocalModel,
  type LocalModelKind
} from "./local-models-runtime.js";
import {
  collectPrivacyModelStatus,
  installPrivacyModel
} from "./privacy-model-runtime.js";
import {
  collectHomebrewRuntimeStatus,
  installHomebrewRuntime
} from "./runtime-homebrew.js";
import {
  collectPackagedRuntimeStatus,
  installPackagedRuntime
} from "./runtime-packaged.js";
import {
  activateServerPackage,
  cleanupServerPackages,
  collectServerPackageStatus,
  installServerPackage
} from "./package-runtime.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  listUpstreamBackends,
  refreshUpstreamBackendCapabilities,
  registerUpstreamBackend,
  removeUpstreamBackend,
  setActiveUpstreamBackend,
  updateUpstreamBackendRoutePolicy,
  type UpstreamRoutePolicyUpdate
} from "./upstream-registry.js";
import {
  getProjectTeamWorkspaceLink,
  linkProjectTeamWorkspace,
  listProjectTeamWorkspaceLinks,
  removeProjectTeamWorkspaceLink
} from "./project-team-workspace-links.js";
import {
  discoverProjectMetadata,
  forgetProjectMetadata,
  getProjectMetadataForCwd,
  listProjectMetadata
} from "./project-metadata.js";
import {
  cancelUpstreamEnrollment,
  disconnectUpstreamBackendEnrollment,
  getUpstreamEnrollmentStatus,
  invalidateUpstreamEnrollmentReferences,
  startUpstreamEnrollment
} from "./upstream-enrollment.js";
import {
  inspectDeviceIdentityStatus,
  rotateDeviceIdentity
} from "./device-identity.js";
import { runPersonalSyncCommand } from "./personal-sync.js";
import type { KoedServerDoctorResult } from "./types.js";

export const usageText = `Usage: koed-server <command> [options]

Commands:
  start                  Start and supervise local Koed services
  start --daemon --json  Start koed-server supervisor detached
  stop --json            Stop supervised local Koed services
  restart --json         Restart supervised local Koed services
  status --json          Print machine-readable local service state
  status --startup --json Print lightweight supervisor startup state
  doctor --json          Print actionable setup/dependency diagnostics
  identity status --json Print clone-safe deployment/device identity state
  identity rotate --json Create fresh device identity and invalidate local enrollment references
  personal-sync status --json             Print redacted Personal Sync status
  personal-sync group bootstrap --json    Create group and encrypted recovery kit
  personal-sync recovery-kit create|verify --json
  personal-sync join request|challenge|complete --json
  personal-sync active-device approve|refresh --json
  personal-sync recovery approve|guidance --json
  personal-sync policy enable|pause|resume --json
  personal-sync start --future-only --json
  personal-sync device list|revoke --json
  personal-sync credential status --json
  personal-sync key-epoch status --json
  personal-sync replica status --json
  personal-sync retry --json
  personal-sync local-replica remove --json
  personal-sync conflict resolve --json
  setup core --json      Prepare Koed core services and local credential
  setup codex --json     Configure the supported Codex integration
    --without-memory-guidance  Do not install the recommended global guidance
    --with-memory-guidance     Install the recommended global guidance (default)
  setup claude --json    Configure the supported Claude Code integration
  setup pi --json        Configure the supported Pi integration
  check <client> --json  Check one AI Client integration without mutation
  repair codex --json    Rewrite Codex integration for the active local API
  repair <client> --json Repair one AI Client integration
  remove <client> --json Remove only Koed-owned client integration state
  models status --json   Print bundled local model install state
  models install --json  Download bundled local model with SHA-256 verification
  runtime status --json  Print native bundled-local runtime install state
  runtime install --json Install native bundled-local runtime assets explicitly
  package status --json  Print standalone koed-server package install state
  package install --json Verify and install standalone koed-server package
  package activate --json Activate an installed koed-server package version
  package cleanup --json Remove inactive versions and stale cached archives
  upstream list --json   List registered upstream backend status
  upstream register --json Register or update an upstream backend
  upstream refresh --json Refresh cached upstream capabilities
  upstream policy --json  Update explicit upstream route-policy families
  upstream activate --json Select the registered upstream used for remote work
  upstream remove --json Remove an upstream backend
  upstream enroll start --json Start enrollment with --source-owner-principal-id
  upstream enroll status --json Print local upstream enrollment state
  upstream enroll cancel --json Cancel local upstream enrollment orchestration
  upstream disconnect --json Disable local upstream routes and enrollment state
  project discover --json Discover and store local Project metadata
  project list --json     List discovered local Project metadata
  project show --json     Show discovered Project metadata for a cwd
  project forget --json   Forget discovered Project metadata by local Project id
  team workspace link --json Link a local Project root to a Team Workspace id
  team workspace list --json List local Project to Team Workspace links
  team workspace show --json Show the Team Workspace link for a Project root
  team workspace remove --json Remove the Team Workspace link for a Project root

Runtime providers:
  --provider homebrew       Use Homebrew-backed runtime assets (default)
  --provider packaged       Use packaged runtime resources from the app bundle

Options:
  --json                 Emit JSON output for commands that support it
  --help, -h             Show this help

Environment:
  KOED_HOME              Directory for local Koed config, logs, and runtime state
  KOED_REPO_ROOT         Koed checkout path used by this development build
  KOED_SERVER_PACKAGE_TRUSTED_PUBLIC_KEY_PEM
                         Ed25519 public key PEM used to verify package provenance signatures
`;

export interface KoedServerCliDependencies {
  collectStatus?: typeof collectKoedServerStatus;
  collectStartupStatus?: typeof collectKoedServerStartupStatus;
  collectDoctor?: typeof collectKoedServerDoctor;
  inspectDeviceIdentity?: typeof inspectDeviceIdentityStatus;
  rotateDeviceIdentity?: typeof rotateDeviceIdentity;
  invalidateUpstreamEnrollmentReferences?: typeof invalidateUpstreamEnrollmentReferences;
  start?: typeof startKoedServer;
  startDaemon?: typeof startKoedServerDaemon;
  stop?: typeof stopKoedServer;
  restart?: typeof restartKoedServer;
  setupCore?: typeof setupCore;
  setupCodex?: typeof setupCodex;
  setupClaude?: typeof setupClaude;
  setupPi?: typeof setupPi;
  removeClaude?: typeof removeClaude;
  removePi?: typeof removePi;
  removeCodex?: typeof removeCodexIntegration;
  repairCodex?: typeof repairCodexIntegration;
  collectModelStatus?: typeof collectLocalModelStatus;
  installModel?: typeof installLocalModel;
  collectPrivacyModelStatus?: typeof collectPrivacyModelStatus;
  installPrivacyModel?: typeof installPrivacyModel;
  collectRuntimeStatus?: typeof collectHomebrewRuntimeStatus;
  installRuntime?: typeof installHomebrewRuntime;
  collectPackagedRuntimeStatus?: typeof collectPackagedRuntimeStatus;
  installPackagedRuntime?: typeof installPackagedRuntime;
  collectPackageStatus?: typeof collectServerPackageStatus;
  installPackage?: typeof installServerPackage;
  activatePackage?: typeof activateServerPackage;
  cleanupPackages?: typeof cleanupServerPackages;
  listUpstreams?: typeof listUpstreamBackends;
  registerUpstream?: typeof registerUpstreamBackend;
  refreshUpstream?: typeof refreshUpstreamBackendCapabilities;
  updateUpstreamPolicy?: typeof updateUpstreamBackendRoutePolicy;
  activateUpstream?: typeof setActiveUpstreamBackend;
  removeUpstream?: typeof removeUpstreamBackend;
  startUpstreamEnroll?: typeof startUpstreamEnrollment;
  getUpstreamEnrollStatus?: typeof getUpstreamEnrollmentStatus;
  cancelUpstreamEnroll?: typeof cancelUpstreamEnrollment;
  disconnectUpstream?: typeof disconnectUpstreamBackendEnrollment;
  linkProjectTeamWorkspace?: typeof linkProjectTeamWorkspace;
  listProjectTeamWorkspaceLinks?: typeof listProjectTeamWorkspaceLinks;
  getProjectTeamWorkspaceLink?: typeof getProjectTeamWorkspaceLink;
  removeProjectTeamWorkspaceLink?: typeof removeProjectTeamWorkspaceLink;
  discoverProjectMetadata?: typeof discoverProjectMetadata;
  listProjectMetadata?: typeof listProjectMetadata;
  getProjectMetadataForCwd?: typeof getProjectMetadataForCwd;
  forgetProjectMetadata?: typeof forgetProjectMetadata;
  runPersonalSync?: typeof runPersonalSyncCommand;
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

const persistDoctorVerification = (
  paths: ReturnType<typeof resolveKoedServerPaths>,
  doctor: KoedServerDoctorResult
): void => {
  mkdirSync(resolve(paths.lastVerificationPath, ".."), {
    recursive: true,
    mode: 0o700
  });
  writeFileSync(
    paths.lastVerificationPath,
    `${JSON.stringify(
      {
        ok: doctor.ok,
        checkedAt: doctor.generatedAt,
        message: doctor.summary
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
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

const packageTrustPolicy = (
  value: string | undefined
): "sha256-only" | "require-provenance" | "require-signature" | undefined => {
  if (value === undefined) return undefined;
  if (
    value === "sha256-only" ||
    value === "require-provenance" ||
    value === "require-signature"
  ) {
    return value;
  }
  throw new Error(
    "--trust-policy must be sha256-only, require-provenance, or require-signature."
  );
};

const compactOptions = <T extends Record<string, unknown>>(options: T): T =>
  Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined)
  ) as T;

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
  { flag: "--personal-collaboration", key: "personalCollaboration" },
  { flag: "--team-workspace-read", key: "teamWorkspaceRead" },
  { flag: "--share-grant-management", key: "shareGrantManagement" },
  { flag: "--capture-writes", key: "captureWrites" },
  { flag: "--sync", key: "sync" },
  { flag: "--managed-execution", key: "managedExecution" },
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
    collectStartupStatus = collectKoedServerStartupStatus,
    collectDoctor = collectKoedServerDoctor,
    inspectDeviceIdentity = inspectDeviceIdentityStatus,
    rotateDeviceIdentity: rotateIdentity = rotateDeviceIdentity,
    invalidateUpstreamEnrollmentReferences:
      invalidateEnrollmentReferences = invalidateUpstreamEnrollmentReferences,
    start = startKoedServer,
    startDaemon = startKoedServerDaemon,
    stop = stopKoedServer,
    restart = restartKoedServer,
    setupCore: setupCoreIntegration = setupCore,
    setupCodex: setup = setupCodex,
    setupClaude: setupClaudeIntegration = setupClaude,
    setupPi: setupPiIntegration = setupPi,
    removeClaude: removeClaudeIntegration = removeClaude,
    removePi: removePiIntegration = removePi,
    removeCodex: removeCodexIntegrationFn = removeCodexIntegration,
    repairCodex = repairCodexIntegration,
    collectModelStatus = collectLocalModelStatus,
    installModel = installLocalModel,
    collectPrivacyModelStatus: collectPrivacyStatus = collectPrivacyModelStatus,
    installPrivacyModel: installPrivacy = installPrivacyModel,
    collectRuntimeStatus = collectHomebrewRuntimeStatus,
    installRuntime = installHomebrewRuntime,
    collectPackagedRuntimeStatus:
      collectPackagedRuntime = collectPackagedRuntimeStatus,
    installPackagedRuntime: installPackaged = installPackagedRuntime,
    collectPackageStatus = collectServerPackageStatus,
    installPackage = installServerPackage,
    activatePackage = activateServerPackage,
    cleanupPackages = cleanupServerPackages,
    listUpstreams = listUpstreamBackends,
    registerUpstream = registerUpstreamBackend,
    refreshUpstream = refreshUpstreamBackendCapabilities,
    updateUpstreamPolicy = updateUpstreamBackendRoutePolicy,
    activateUpstream = setActiveUpstreamBackend,
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
    discoverProjectMetadata: discoverProject = discoverProjectMetadata,
    listProjectMetadata: listProjects = listProjectMetadata,
    getProjectMetadataForCwd: getProjectForCwd = getProjectMetadataForCwd,
    forgetProjectMetadata: forgetProject = forgetProjectMetadata,
    runPersonalSync = runPersonalSyncCommand,
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
  ) as LocalModelKind | "privacy" | undefined;

  try {
    if (wantsHelp || !command) {
      stdout.write(usageText);
      return 0;
    }

    if (command === "status") {
      const status = args.includes("--startup")
        ? await collectStartupStatus()
        : await collectStatus();
      if (wantsJson) {
        printJson(stdout, status);
      } else {
        stdout.write(`${status.state}\n`);
      }
      return 0;
    }

    if (command === "doctor") {
      const doctor = await collectDoctor();
      persistDoctorVerification(resolvePaths(), doctor);
      if (wantsJson) {
        printJson(stdout, doctor);
      } else {
        stdout.write(`${doctor.summary}\n`);
      }
      return doctor.ok ? 0 : 1;
    }

    if (command === "identity") {
      const paths = resolvePaths();
      const identity =
        subcommand === "status"
          ? await inspectDeviceIdentity(paths)
          : subcommand === "rotate"
            ? await rotateIdentity(paths, {
                invalidateRemoteReferences: () =>
                  invalidateEnrollmentReferences(paths)
              })
            : null;
      if (!identity) {
        throw new Error("identity command must be status or rotate.");
      }
      if (wantsJson) {
        printJson(stdout, identity);
      } else {
        stdout.write(`${identity.health}\n`);
      }
      return identity.remoteOperationsAllowed ? 0 : 1;
    }

    if (command === "personal-sync") {
      const paths = resolvePaths();
      const result = await runPersonalSync(
        args.slice(1).filter((arg) => arg !== "--json"),
        paths,
        process.env
      );
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
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

    if (command === "setup" && subcommand === "core") {
      const result = await setupCoreIntegration();
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(
          result.ok
            ? "Koed core setup completed.\n"
            : `${result.error ?? "Koed core setup failed."}\n`
        );
      }
      return result.ok ? 0 : 1;
    }

    if (command === "setup" && subcommand === "codex") {
      const withoutGuidance = args.includes("--without-memory-guidance");
      const withGuidance = args.includes("--with-memory-guidance");
      if (withoutGuidance && withGuidance) {
        throw new Error(
          "Use only one of --with-memory-guidance or --without-memory-guidance."
        );
      }
      const result = await setup({
        environment:
          withoutGuidance || withGuidance
            ? {
                ...process.env,
                KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED: String(withGuidance)
              }
            : process.env
      });
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

    if (command === "setup" && subcommand === "pi") {
      const result = setupPiIntegration();
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(
          result.ok
            ? "Pi setup completed.\n"
            : `${result.error ?? "Pi setup failed."}\n`
        );
      }
      return result.ok ? 0 : 1;
    }

    if (command === "setup" && subcommand === "claude") {
      const result = setupClaudeIntegration();
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(
          result.ok
            ? "Claude Code setup completed. Restart Claude Code before verifying capture and recall.\n"
            : `${result.error ?? "Claude Code setup failed."}\n`
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

    if (command === "check" && subcommand) {
      const status = await collectStatus();
      const components: Record<string, unknown> = {
        codex: status.codex,
        claude: status.claudeCode,
        pi: status.pi
      };
      const readiness = components[subcommand]
        ? status.aiClients?.[subcommand]
        : undefined;
      if (!components[subcommand])
        throw new Error("check client must be codex, claude, or pi.");
      const result = {
        client: subcommand,
        readiness: readiness ?? null,
        ...evaluateAiClientReadiness(readiness)
      };
      if (wantsJson) printJson(stdout, result);
      else stdout.write(`${result.message}\n`);
      return result.ok ? 0 : 1;
    }

    if (command === "repair" && subcommand) {
      const result =
        subcommand === "codex"
          ? repairCodex()
          : subcommand === "claude"
            ? setupClaudeIntegration()
            : subcommand === "pi"
              ? setupPiIntegration()
              : null;
      if (!result)
        throw new Error("repair client must be codex, claude, or pi.");
      if (wantsJson) printJson(stdout, result);
      else
        stdout.write(
          `${result.ok ? "AI Client integration repaired." : (result.error ?? "AI Client integration repair failed.")}\n`
        );
      return result.ok ? 0 : 1;
    }

    if (command === "remove" && subcommand) {
      const result =
        subcommand === "codex"
          ? removeCodexIntegrationFn()
          : subcommand === "claude"
            ? removeClaudeIntegration()
            : subcommand === "pi"
              ? removePiIntegration()
              : null;
      if (!result)
        throw new Error("remove client must be codex, claude, or pi.");
      if (wantsJson) printJson(stdout, result);
      else
        stdout.write(
          `${result.ok ? "AI Client integration removed." : (result.error ?? "AI Client integration removal failed.")}\n`
        );
      return result.ok ? 0 : 1;
    }

    if (command === "models" && subcommand === "status") {
      if (
        modelKind !== "embedding" &&
        modelKind !== "reranker" &&
        modelKind !== "privacy"
      ) {
        throw new Error("--kind must be embedding, reranker, or privacy.");
      }
      const paths = resolvePaths();
      const modelEnvironment = mergeRepoEnvironment(
        loadEnvironment(paths.repoRoot)
      );
      const result =
        modelKind === "privacy"
          ? await collectPrivacyStatus(paths)
          : await collectModelStatus(paths, modelKind, modelEnvironment);
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.state === "checksum_mismatch" ? 1 : 0;
    }

    if (command === "models" && subcommand === "install") {
      if (
        modelKind !== "embedding" &&
        modelKind !== "reranker" &&
        modelKind !== "privacy"
      ) {
        throw new Error("--kind must be embedding, reranker, or privacy.");
      }
      const paths = resolvePaths();
      const modelEnvironment = mergeRepoEnvironment(
        loadEnvironment(paths.repoRoot)
      );
      const result =
        modelKind === "privacy"
          ? await installPrivacy(paths, modelEnvironment)
          : await installModel(paths, modelKind, modelEnvironment);
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

    if (command === "package" && subcommand === "status") {
      const paths = resolvePaths();
      const result = collectPackageStatus(paths);
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "package" && subcommand === "install") {
      const paths = resolvePaths();
      const result = await installPackage(
        paths,
        compactOptions({
          source: requireFlagValue(args, "--source"),
          sha256: flagValue(args, "--sha256"),
          sha256File: flagValue(args, "--sha256-file"),
          activate: args.includes("--activate"),
          provenanceFile: flagValue(args, "--provenance-file"),
          signatureFile: flagValue(args, "--signature-file"),
          trustedPublicKey: flagValue(args, "--trusted-public-key"),
          trustedPublicKeyFile: flagValue(args, "--trusted-public-key-file"),
          trustPolicy: packageTrustPolicy(flagValue(args, "--trust-policy")),
          allowDowngrade: args.includes("--allow-downgrade") ? true : undefined
        })
      );
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "package" && subcommand === "activate") {
      const paths = resolvePaths();
      const result = activatePackage(
        paths,
        requireFlagValue(args, "--version"),
        { allowDowngrade: args.includes("--allow-downgrade") }
      );
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "package" && subcommand === "cleanup") {
      const paths = resolvePaths();
      const keep = flagValue(args, "--keep");
      const result = cleanupPackages(
        paths,
        keep === undefined ? 1 : Number.parseInt(keep, 10)
      );
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

    if (command === "upstream" && subcommand === "activate") {
      const paths = resolvePaths();
      const result = activateUpstream(paths, requireFlagValue(args, "--id"));
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
          ? await startUpstreamEnroll(paths, id, {
              sourceOwnerPrincipalId: requireFlagValue(
                args,
                "--source-owner-principal-id"
              )
            })
          : enrollCommand === "status"
            ? await getUpstreamEnrollStatus(paths, id)
            : enrollCommand === "cancel"
              ? await cancelUpstreamEnroll(paths, id)
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
      const result = await disconnectUpstream(
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

    if (command === "project") {
      const projectCommand = subcommand;
      const paths = resolvePaths();
      const result =
        projectCommand === "discover"
          ? await discoverProject(paths, {
              cwd: flagValue(args, "--cwd") ?? process.cwd(),
              aiClientSource: args.includes("--codex") ? "codex" : undefined
            })
          : projectCommand === "list"
            ? listProjects(paths)
            : projectCommand === "show"
              ? getProjectForCwd(
                  paths,
                  flagValue(args, "--cwd") ?? process.cwd()
                )
              : projectCommand === "forget"
                ? forgetProject(
                    paths,
                    requireFlagValue(args, "--local-project-id")
                  )
                : null;
      if (!result) {
        throw new Error(
          "project command must be discover, list, show, or forget."
        );
      }
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(`${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === "desktop" && subcommand === "collaboration-broker") {
      await runDesktopCollaborationBrokerProcess();
      return 0;
    }

    if (command === "team" && subcommand === "workspace") {
      const teamWorkspaceCommand = args[2];
      const paths = resolvePaths();
      const result =
        teamWorkspaceCommand === "link"
          ? linkProjectWorkspace(paths, {
              projectRoot: requireFlagValue(args, "--project-root"),
              teamWorkspaceId: requireFlagValue(args, "--team-workspace-id"),
              backendId:
                flagValue(args, "--backend-id") ??
                flagValue(args, "--upstream-backend-id"),
              localProjectId: flagValue(args, "--local-project-id"),
              projectDisplayName: flagValue(args, "--project-display-name")
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

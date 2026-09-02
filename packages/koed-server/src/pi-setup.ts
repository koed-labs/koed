import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { dirname, delimiter, isAbsolute, join, resolve } from "node:path";
import { nodeCliInvocation, nodeCliProcessEnvironment } from "@koed/shared";
import { installPiPackageTransaction } from "./pi-package-transaction.mjs";
import { resolveKoedServerPaths } from "./paths.js";
import {
  assertAiClientRegistryWritable,
  captureAiClientRegistry,
  platformExecutableSearchDirectories,
  registerExplicitAiClient,
  removeExplicitAiClient,
  restoreAiClientRegistry
} from "./ai-client-registry.js";

export const MINIMUM_PI_VERSION = "0.84.2";

export const isSupportedPiVersion = (value: string): boolean => {
  const parsed = value
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  return Boolean(
    parsed &&
    (parsed[0]! > 0 ||
      (parsed[0] === 0 &&
        (parsed[1]! > 84 || (parsed[1] === 84 && parsed[2]! >= 2))))
  );
};

const PI_SETUP_ENVIRONMENT_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "PI_CODING_AGENT_DIR",
  "SYSTEMROOT",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT"
] as const;

export const piSetupEnvironment = (
  environment: NodeJS.ProcessEnv,
  koedHome: string
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    PI_SETUP_ENVIRONMENT_KEYS.flatMap((name) =>
      environment[name] ? [[name, environment[name]]] : []
    )
  ),
  KOED_HOME: koedHome
});

export const piModelIdsFromListOutput = (stdout: string): string[] =>
  stdout
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const match = line.trim().match(/^(\S+)\s+(\S+)/);
      return match ? [`${match[1]}/${match[2]}`] : [];
    });

const executableNames = (platform: NodeJS.Platform): string[] =>
  platform === "win32" ? ["pi.exe", "pi.cmd", "pi"] : ["pi"];

const WINDOWS_PI_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

export const resolvePiSetupNodeEntry = (
  candidate: string,
  platform: NodeJS.Platform = process.platform
): string => {
  if (
    platform !== "win32" ||
    !WINDOWS_PI_SHIM_EXTENSIONS.has(
      candidate.slice(candidate.lastIndexOf(".")).toLowerCase()
    )
  )
    return candidate;
  const entry = join(
    dirname(candidate),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js"
  );
  if (existsSync(entry) && statSync(entry).isFile()) return realpathSync(entry);
  throw new Error(
    `Pi launcher ${candidate} cannot be executed safely. Install Pi through npm with a verifiable package entry or configure a native executable.`
  );
};

export const piSetupInvocation = (
  executablePath: string,
  args: string[]
): { command: string; args: string[] } =>
  nodeCliInvocation(executablePath, args);

export const resolvePiSetupLauncher = (
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string => {
  const configured = environment.KOED_PI_EXECUTABLE?.trim();
  if (configured && !isAbsolute(configured)) {
    throw new Error("KOED_PI_EXECUTABLE must be an absolute path.");
  }
  let candidate = configured;
  if (!candidate) {
    const pathDelimiter = platform === "win32" ? ";" : delimiter;
    const directories = [
      ...(environment.PATH ?? "").split(pathDelimiter),
      ...platformExecutableSearchDirectories(environment, platform)
    ];
    for (const directory of directories) {
      if (!isAbsolute(directory)) continue;
      candidate = executableNames(platform)
        .map((name) => join(directory, name))
        .find((path) => {
          try {
            return statSync(path).isFile();
          } catch {
            return false;
          }
        });
      if (candidate) break;
    }
  }
  if (!candidate) {
    throw new Error(
      "Pi was not found. Install Pi, or set KOED_PI_EXECUTABLE to its absolute path."
    );
  }
  return resolve(candidate);
};

export const resolvePiSetupExecutable = (
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string => {
  const launcher = resolvePiSetupLauncher(environment, platform);
  const canonical = realpathSync(resolvePiSetupNodeEntry(launcher, platform));
  if (!statSync(canonical).isFile()) {
    throw new Error(`Pi executable is not a file: ${canonical}`);
  }
  if (platform !== "win32") accessSync(canonical, constants.X_OK);
  return canonical;
};

export interface KoedServerSetupPiResult {
  ok: boolean;
  state: "healthy" | "needs_attention";
  command: string;
  koedHome: string;
  checkedAt: string;
  executablePath?: string;
  modelCount?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  action?: string;
}

export const removePi = (
  environment: NodeJS.ProcessEnv = process.env,
  spawnSync: typeof nodeSpawnSync = nodeSpawnSync
): KoedServerSetupPiResult => {
  const paths = resolveKoedServerPaths(environment);
  const target = resolve(paths.koedHome, "integrations/pi");
  const checkedAt = new Date().toISOString();
  const command = `${environment.KOED_PI_EXECUTABLE?.trim() || "pi"} remove ${target}`;
  const registryEnvironment = { ...environment, KOED_HOME: paths.koedHome };
  let backup: string | null = null;
  let profileRemovalAttempted = false;
  let profileRemoved = false;
  let runPiForRollback:
    | ((args: string[], timeout: number) => SpawnSyncReturns<string>)
    | null = null;
  let registrySnapshot;
  try {
    assertAiClientRegistryWritable(registryEnvironment);
    registrySnapshot = captureAiClientRegistry(registryEnvironment);
    const executable = resolvePiSetupExecutable(environment);
    const childEnvironment = piSetupEnvironment(environment, paths.koedHome);
    const runPi = (args: string[], timeout: number) => {
      const invocation = piSetupInvocation(executable, args);
      return spawnSync(invocation.command, invocation.args, {
        env: nodeCliProcessEnvironment(
          invocation,
          childEnvironment,
          environment
        ),
        encoding: "utf8",
        timeout,
        ...(args[0] === "list" ? { maxBuffer: 4 * 1024 * 1024 } : {})
      });
    };
    runPiForRollback = runPi;
    if (existsSync(target)) {
      backup = `${target}.remove-backup-${process.pid}-${Date.now()}`;
      cpSync(target, backup, { recursive: true });
      profileRemovalAttempted = true;
      const removed = runPi(["remove", target], 30_000);
      if (removed.error || removed.status !== 0) {
        throw new Error(
          removed.error?.message ??
            removed.stderr?.trim() ??
            "Pi package removal failed."
        );
      }
      profileRemoved = true;
    }
    const listed = runPi(["list"], 10_000);
    if (listed.error || listed.status !== 0) {
      throw new Error(
        listed.error?.message ??
          listed.stderr?.trim() ??
          "Pi profile verification failed after removal."
      );
    }
    if ((listed.stdout ?? "").includes(target)) {
      throw new Error(
        "Pi active profile still references Koed package after removal."
      );
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: false });
    if (existsSync(target)) {
      throw new Error("Koed Pi package directory could not be removed.");
    }
    removeExplicitAiClient({
      environment: registryEnvironment,
      driverId: "pi"
    });
    if (backup) {
      rmSync(backup, { recursive: true, force: false });
      backup = null;
    }
    return {
      ok: true,
      state: "healthy",
      command: `${executable} remove ${target}`,
      koedHome: paths.koedHome,
      checkedAt,
      executablePath: executable,
      stdout:
        "Pi integration removed; unrelated packages and profile settings were preserved."
    };
  } catch (error) {
    const failures: string[] = [
      error instanceof Error ? error.message : String(error)
    ];
    if (backup) {
      try {
        if (existsSync(target))
          rmSync(target, { recursive: true, force: true });
        cpSync(backup, target, { recursive: true });
        rmSync(backup, { recursive: true, force: true });
      } catch (restoreError) {
        failures.push(
          `Pi package rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    if (registrySnapshot) {
      try {
        restoreAiClientRegistry(registryEnvironment, registrySnapshot);
      } catch (restoreError) {
        failures.push(
          `AI Client registry rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    if ((profileRemoved || profileRemovalAttempted) && runPiForRollback) {
      try {
        const installed = runPiForRollback(["install", target], 30_000);
        if (installed.error || installed.status !== 0) {
          failures.push(
            `Pi profile rollback failed: ${installed.error?.message ?? installed.stderr?.trim() ?? "Pi profile rollback failed."}`
          );
        } else {
          const listed = runPiForRollback(["list"], 10_000);
          if (
            listed.error ||
            listed.status !== 0 ||
            !(listed.stdout ?? "").includes(target)
          ) {
            failures.push(
              `Pi profile rollback failed: ${listed.error?.message ?? listed.stderr?.trim() ?? "Pi profile rollback verification failed."}`
            );
          }
        }
      } catch (restoreError) {
        failures.push(
          `Pi profile rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    return {
      ok: false,
      state: "needs_attention",
      command,
      koedHome: paths.koedHome,
      checkedAt,
      error: failures.join(" "),
      action: "Fix Pi profile or filesystem state, then retry removal."
    };
  }
};

export const setupPi = (
  environment: NodeJS.ProcessEnv = process.env,
  spawnSync: typeof nodeSpawnSync = nodeSpawnSync
): KoedServerSetupPiResult => {
  const paths = resolveKoedServerPaths(environment);
  try {
    assertAiClientRegistryWritable({
      ...environment,
      KOED_HOME: paths.koedHome
    });
  } catch (error) {
    return {
      ok: false,
      state: "needs_attention",
      command: `${environment.KOED_PI_EXECUTABLE?.trim() || "pi"} install ${resolve(paths.koedHome, "integrations/pi")}`,
      koedHome: paths.koedHome,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      action: "Fix malformed AI Client registry, then rerun Pi setup."
    };
  }
  const sourceCandidates = [
    resolve(paths.repoRoot, "packages/mcp-server/integrations/pi"),
    resolve(paths.repoRoot, "koed-runtime/mcp-server/integrations/pi"),
    resolve(paths.repoRoot, "mcp-server/integrations/pi")
  ];
  const source = sourceCandidates.find(existsSync);
  const target = resolve(paths.koedHome, "integrations/pi");
  const requestedExecutable = environment.KOED_PI_EXECUTABLE?.trim() || "pi";
  const checkedAt = new Date().toISOString();
  if (!source) {
    return {
      ok: false,
      state: "needs_attention",
      command: `${requestedExecutable} install ${target}`,
      koedHome: paths.koedHome,
      checkedAt,
      error: "Koed Pi integration package is missing from this installation.",
      action:
        "Repair Koed installation, then rerun koed-server setup pi --json."
    };
  }
  try {
    const launcher = resolvePiSetupLauncher(environment);
    const executable = resolvePiSetupExecutable(environment);
    const childEnvironment = piSetupEnvironment(environment, paths.koedHome);
    const runPi = (args: string[], timeout: number) => {
      const invocation = piSetupInvocation(executable, args);
      return spawnSync(invocation.command, invocation.args, {
        env: nodeCliProcessEnvironment(
          invocation,
          childEnvironment,
          environment
        ),
        encoding: "utf8",
        timeout,
        ...(args[0] === "--list-models" ? { maxBuffer: 4 * 1024 * 1024 } : {})
      });
    };
    const version = runPi(["--version"], 10_000);
    if (
      version.error ||
      version.status !== 0 ||
      !isSupportedPiVersion(version.stdout?.trim() ?? "")
    ) {
      throw new Error(
        `Pi ${version.stdout?.trim() || "version"} is unsupported. Koed requires Pi ${MINIMUM_PI_VERSION} or newer.`
      );
    }
    const listedModels = runPi(["--list-models"], 15_000);
    const models =
      listedModels.error || listedModels.status !== 0
        ? []
        : piModelIdsFromListOutput(listedModels.stdout ?? "");
    if (models.length === 0) {
      throw new Error(
        "Pi has no authenticated models. Authenticate at least one Pi model before setup."
      );
    }
    const registryEnvironment = { ...environment, KOED_HOME: paths.koedHome };
    const registrySnapshot = captureAiClientRegistry(registryEnvironment);
    const transaction = installPiPackageTransaction({
      source,
      target,
      install: () => runPi(["install", target], 30_000),
      installSucceeded: (candidate) => {
        const result = candidate as ReturnType<typeof runPi>;
        return !result.error && result.status === 0;
      }
    });
    const result = transaction.installResult as
      | ReturnType<typeof runPi>
      | undefined;
    const rollback = transaction.registrationResult as
      | ReturnType<typeof runPi>
      | undefined;
    const ok = transaction.ok;
    const hadPrevious = transaction.hadPrevious;
    const rollbackError = rollback
      ? rollback.error?.message ||
        rollback.stderr?.trim() ||
        `rollback exited with code ${rollback.status ?? 1}`
      : transaction.registrationError;
    let registrationError: string | undefined;
    if (ok) {
      try {
        const registered = registerExplicitAiClient({
          environment: registryEnvironment,
          driverId: "pi",
          executablePath: launcher,
          displayName: "Pi",
          configHome: environment.PI_CODING_AGENT_DIR
        });
        if (!registered) registrationError = "Pi registration failed.";
      } catch (error) {
        registrationError =
          error instanceof Error ? error.message : String(error);
      }
    }
    const setupOk = ok && !registrationError;
    if (!setupOk && registrySnapshot) {
      try {
        restoreAiClientRegistry(registryEnvironment, registrySnapshot);
      } catch (restoreError) {
        registrationError = `${registrationError ?? "Pi setup failed."} Registry rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
      }
    }
    return {
      ok: setupOk,
      state: setupOk ? "healthy" : "needs_attention",
      command: `${executable} install ${target}`,
      koedHome: paths.koedHome,
      checkedAt,
      executablePath: executable,
      modelCount: models.length,
      ...(result?.stdout ? { stdout: result.stdout.trim() } : {}),
      ...(result?.stderr ? { stderr: result.stderr.trim() } : {}),
      ...(!setupOk
        ? {
            error:
              registrationError ??
              result?.error?.message ??
              result?.stderr?.trim() ??
              transaction.error ??
              "Pi integration registration failed.",
            action: registrationError
              ? "Pi package was installed, but registry registration failed. Repair the AI Client registry, then rerun Pi setup."
              : transaction.restorationError
                ? `The previous package could not be restored (${transaction.restorationError}). It remains at ${transaction.backupPath ?? "the backup path"}; repair the filesystem before retrying.`
                : rollbackError
                  ? `The previous package was restored but its Pi registration could not be verified: ${rollbackError}. Fix Pi, then rerun koed-server setup pi --json.`
                  : hadPrevious
                    ? "The previous Koed Pi package was restored. Fix the Pi package installation error, then rerun koed-server setup pi --json."
                    : "The failed package candidate was removed. Fix the Pi package installation error, then rerun koed-server setup pi --json."
          }
        : {})
    };
  } catch (error) {
    return {
      ok: false,
      state: "needs_attention",
      command: `${requestedExecutable} install ${target}`,
      koedHome: paths.koedHome,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
      action:
        "Install and authenticate supported Pi, then rerun koed-server setup pi --json."
    };
  }
};

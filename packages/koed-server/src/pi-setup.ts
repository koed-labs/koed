import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { dirname, delimiter, isAbsolute, join, resolve } from "node:path";
import { resolveKoedServerPaths } from "./paths.js";

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

const executableNames = (): string[] =>
  process.platform === "win32" ? ["pi.exe", "pi.cmd", "pi"] : ["pi"];

export const resolvePiSetupExecutable = (
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const configured = environment.KOED_PI_EXECUTABLE?.trim();
  if (configured && !isAbsolute(configured)) {
    throw new Error("KOED_PI_EXECUTABLE must be an absolute path.");
  }
  let candidate = configured;
  if (!candidate) {
    for (const directory of (environment.PATH ?? "").split(delimiter)) {
      if (!isAbsolute(directory)) continue;
      candidate = executableNames()
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
  const canonical = realpathSync(candidate);
  if (!statSync(canonical).isFile()) {
    throw new Error(`Pi executable is not a file: ${canonical}`);
  }
  if (process.platform !== "win32") accessSync(canonical, constants.X_OK);
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

export const setupPi = (
  environment: NodeJS.ProcessEnv = process.env,
  spawnSync: typeof nodeSpawnSync = nodeSpawnSync
): KoedServerSetupPiResult => {
  const paths = resolveKoedServerPaths(environment);
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
    const executable = resolvePiSetupExecutable(environment);
    const childEnvironment = piSetupEnvironment(environment, paths.koedHome);
    const version = spawnSync(executable, ["--version"], {
      env: childEnvironment,
      encoding: "utf8",
      timeout: 10_000
    });
    if (
      version.error ||
      version.status !== 0 ||
      !isSupportedPiVersion(version.stdout?.trim() ?? "")
    ) {
      throw new Error(
        `Pi ${version.stdout?.trim() || "version"} is unsupported. Koed requires Pi ${MINIMUM_PI_VERSION} or newer.`
      );
    }
    const listedModels = spawnSync(executable, ["--list-models"], {
      env: childEnvironment,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024
    });
    const models =
      listedModels.error || listedModels.status !== 0
        ? []
        : piModelIdsFromListOutput(listedModels.stdout ?? "");
    if (models.length === 0) {
      throw new Error(
        "Pi has no authenticated models. Authenticate at least one Pi model before setup."
      );
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
    const result = spawnSync(executable, ["install", target], {
      env: childEnvironment,
      encoding: "utf8",
      timeout: 30_000
    });
    const ok = !result.error && result.status === 0;
    return {
      ok,
      state: ok ? "healthy" : "needs_attention",
      command: `${executable} install ${target}`,
      koedHome: paths.koedHome,
      checkedAt,
      executablePath: executable,
      modelCount: models.length,
      ...(result.stdout ? { stdout: result.stdout.trim() } : {}),
      ...(result.stderr ? { stderr: result.stderr.trim() } : {}),
      ...(!ok
        ? {
            error:
              result.error?.message ??
              result.stderr?.trim() ??
              `Pi setup failed with exit code ${result.status ?? 1}.`,
            action:
              "Fix the Pi package installation error, then rerun koed-server setup pi --json."
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

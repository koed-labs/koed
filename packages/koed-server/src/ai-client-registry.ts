import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { parseCodexOwnershipBlock } from "./codex-ownership-marker.js";

export type RegisteredAiClient = "codex" | "claude" | "pi";

type RegistryEntry = Record<string, unknown> & {
  instanceId: string;
  driverId: string;
  displayName: string;
  executablePath: string;
};
type RegistryRoot = { version: 1; instances: RegistryEntry[] };

export interface ExecutablePathDependencies {
  existsSync?: typeof existsSync;
  statSync?: typeof statSync;
  accessSync?: typeof accessSync;
}

export const platformExecutableSearchDirectories = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): readonly string[] =>
  platform === "darwin"
    ? [
        join(environment.HOME ?? homedir(), ".local", "bin"),
        join(
          environment.HOME ?? homedir(),
          ".local",
          "share",
          "fnm",
          "aliases",
          "default",
          "bin"
        ),
        "/opt/homebrew/bin",
        "/usr/local/bin"
      ]
    : [];

const validateExecutableCandidate = (
  candidate: string,
  dependencies: Required<ExecutablePathDependencies>
): "missing" | "not-file" | "not-executable" | "valid" => {
  if (!dependencies.existsSync(candidate)) return "missing";
  try {
    if (!dependencies.statSync(candidate).isFile()) return "not-file";
  } catch {
    return "missing";
  }
  try {
    dependencies.accessSync(candidate, constants.X_OK);
  } catch {
    return "not-executable";
  }
  return "valid";
};

export const resolveExecutablePath = (
  requestedPath: string,
  environment: NodeJS.ProcessEnv,
  dependencies: ExecutablePathDependencies = {},
  additionalDirectories: readonly string[] = []
): string => {
  const requested = requestedPath.trim();
  if (!requested) throw new Error("AI Client executable path is empty.");
  const fs: Required<ExecutablePathDependencies> = {
    existsSync,
    statSync,
    accessSync,
    ...dependencies
  };
  const directories = [
    ...(environment.PATH ?? process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean),
    ...additionalDirectories
  ];
  const candidates = isAbsolute(requested)
    ? [requested]
    : directories.map((directory) => join(directory, requested));
  let invalid: "not-file" | "not-executable" | undefined;
  for (const candidate of candidates) {
    const result = validateExecutableCandidate(candidate, fs);
    if (result === "valid") return resolve(candidate);
    if (result === "not-file" || result === "not-executable") invalid = result;
  }
  if (invalid === "not-file") {
    throw new Error(`AI Client executable is not a regular file: ${requested}`);
  }
  if (invalid === "not-executable") {
    throw new Error(`AI Client executable is not executable: ${requested}`);
  }
  throw new Error(`AI Client executable was not found: ${requested}`);
};

export const resolveExecutablePathWithPlatformFallbacks = (
  requestedPath: string,
  environment: NodeJS.ProcessEnv,
  dependencies: ExecutablePathDependencies = {},
  platform: NodeJS.Platform = process.platform
): string =>
  resolveExecutablePath(
    requestedPath,
    environment,
    dependencies,
    platformExecutableSearchDirectories(environment, platform)
  );

export const resolveCodexExecutablePath = (
  environment: NodeJS.ProcessEnv,
  dependencies: ExecutablePathDependencies = {}
): string => {
  const requested =
    environment.MEMORY_CODEX_APP_SERVER_BINARY?.trim() || "codex";
  return resolveExecutablePathWithPlatformFallbacks(
    requested,
    environment,
    dependencies
  );
};

export const aiClientRegistryPath = (environment: NodeJS.ProcessEnv): string =>
  resolve(
    environment.KOED_AI_CLIENT_INSTANCE_REGISTRY ??
      join(
        environment.KOED_HOME ?? join(homedir(), ".koed"),
        "config",
        "ai-client-instances.json"
      )
  );

const registryPath = aiClientRegistryPath;

export interface AiClientRegistrySnapshot {
  exists: boolean;
  content: string | null;
  mode: number | null;
}

export const captureAiClientRegistry = (
  environment: NodeJS.ProcessEnv
): AiClientRegistrySnapshot => {
  const target = registryPath(environment);
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) {
      throw new Error(
        "AI Client instance registry must not be a symbolic link."
      );
    }
    return {
      exists: true,
      content: readFileSync(target, "utf8"),
      mode: stats.mode & 0o777
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, content: null, mode: null };
    }
    throw error;
  }
};

export const restoreAiClientRegistry = (
  environment: NodeJS.ProcessEnv,
  snapshot: AiClientRegistrySnapshot
): void => {
  const target = registryPath(environment);
  if (!snapshot.exists) {
    try {
      if (lstatSync(target).isSymbolicLink()) {
        throw new Error(
          "AI Client instance registry must not be a symbolic link."
        );
      }
      unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  if (snapshot.content === null) throw new Error("Registry snapshot is empty.");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, snapshot.content, { mode: snapshot.mode ?? 0o600 });
  chmodSync(target, snapshot.mode ?? 0o600);
};

const readRegistry = (target: string): RegistryRoot => {
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(
        "AI Client instance registry must not be a symbolic link."
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, instances: [] };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(
      `AI Client instance registry is malformed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { instances?: unknown }).instances)
  ) {
    throw new Error(
      "AI Client instance registry version is unsupported or malformed."
    );
  }
  const instances = (parsed as { instances: unknown[] }).instances;
  const ids = new Set<string>();
  for (const entry of instances) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { instanceId?: unknown }).instanceId !== "string" ||
      typeof (entry as { driverId?: unknown }).driverId !== "string" ||
      typeof (entry as { displayName?: unknown }).displayName !== "string" ||
      typeof (entry as { executablePath?: unknown }).executablePath !== "string"
    ) {
      throw new Error(
        "AI Client instance registry contains malformed entries."
      );
    }
    const id = (entry as { instanceId: string }).instanceId;
    if (ids.has(id))
      throw new Error(`AI Client instance registry duplicates ${id}.`);
    ids.add(id);
  }
  return { version: 1, instances: instances as RegistryEntry[] };
};

export const assertAiClientRegistryWritable = (
  environment: NodeJS.ProcessEnv
): void => {
  readRegistry(registryPath(environment));
};

const writeRegistry = (target: string, root: RegistryRoot): void => {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(
        "AI Client instance registry must not be a symbolic link."
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx"
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
};

export const removeExplicitAiClient = (input: {
  environment: NodeJS.ProcessEnv;
  driverId: RegisteredAiClient;
}): boolean => {
  const target = registryPath(input.environment);
  const root = readRegistry(target);
  const instances = root.instances.filter(
    (candidate) => candidate.instanceId !== `${input.driverId}.default`
  );
  if (instances.length === root.instances.length) return false;
  writeRegistry(target, { version: 1, instances });
  return true;
};

export const registerExplicitAiClient = (input: {
  environment: NodeJS.ProcessEnv;
  driverId: RegisteredAiClient;
  executablePath?: string;
  displayName: string;
  configHome?: string;
}): boolean => {
  if (!input.executablePath?.trim()) return false;
  const executablePath = resolveExecutablePath(
    input.executablePath,
    input.environment
  );
  const target = registryPath(input.environment);
  const root = readRegistry(target);
  const instanceId = `${input.driverId}.default`;
  const entry: RegistryEntry = {
    instanceId,
    driverId: input.driverId,
    displayName: input.displayName,
    executablePath,
    ...(input.configHome && existsSync(input.configHome)
      ? { configHome: resolve(input.configHome) }
      : {})
  };
  writeRegistry(target, {
    version: 1,
    instances: [
      ...root.instances.filter(
        (candidate) => candidate.instanceId !== instanceId
      ),
      entry
    ]
  });
  return true;
};

export interface CodexMigrationResult {
  migrated: boolean;
  diagnostic?: string;
}

export const migrateKoedOwnedCodexRegistrationBestEffort = (input: {
  environment: NodeJS.ProcessEnv;
  readFileSync?: typeof readFileSync;
}): CodexMigrationResult => {
  try {
    return {
      migrated: migrateKoedOwnedCodexRegistration(input)
    };
  } catch (error) {
    return {
      migrated: false,
      diagnostic: `Skipped legacy Codex registration migration: ${error instanceof Error ? error.message : String(error)}`
    };
  }
};

export const migrateKoedOwnedCodexRegistration = (input: {
  environment: NodeJS.ProcessEnv;
  readFileSync?: typeof readFileSync;
}): boolean => {
  const environment = input.environment;
  const target = registryPath(environment);
  const registry = readRegistry(target);
  if (
    registry.instances.some(
      (instance) => instance.instanceId === "codex.default"
    )
  ) {
    return false;
  }
  const configPath = resolve(
    environment.CODEX_CONFIG_PATH ??
      join(environment.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml")
  );
  if (!existsSync(configPath)) return false;
  const content = (input.readFileSync ?? readFileSync)(
    configPath,
    "utf8"
  ) as string;
  if (parseCodexOwnershipBlock(content).kind !== "valid") return false;
  const executablePath = resolveCodexExecutablePath(environment);
  registerExplicitAiClient({
    environment,
    driverId: "codex",
    executablePath,
    displayName: "Codex",
    configHome: environment.CODEX_HOME
  });
  return true;
};

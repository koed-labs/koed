import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertAiClientDriverId, assertAiClientInstanceId } from "@koed/shared";

export interface LocalAiClientInstanceConfiguration {
  instanceId: string;
  driverId: string;
  displayName: string;
  executablePath: string;
  configHome?: string;
  configurationError?: string;
}

interface LocalAiClientInstanceRegistry {
  version: 1;
  instances: LocalAiClientInstanceConfiguration[];
}

const exactKeys = (
  value: Record<string, unknown>,
  expected: string[],
  label: string
): void => {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
};

const nonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
};

export const aiClientInstanceRegistryPath = (
  env: NodeJS.ProcessEnv = process.env
): string =>
  path.resolve(
    env.KOED_AI_CLIENT_INSTANCE_REGISTRY ??
      path.join(
        env.KOED_HOME ?? path.join(os.homedir(), ".koed"),
        "config",
        "ai-client-instances.json"
      )
  );

const readableConfiguration = (
  candidate: unknown,
  index: number
): LocalAiClientInstanceConfiguration | null => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const entry = candidate as Record<string, unknown>;
  try {
    const hasConfigHome = Object.hasOwn(entry, "configHome");
    exactKeys(
      entry,
      [
        "instanceId",
        "driverId",
        "displayName",
        "executablePath",
        ...(hasConfigHome ? ["configHome"] : [])
      ],
      `AI Client instance ${index}`
    );
    const instanceId = assertAiClientInstanceId(
      nonEmpty(entry.instanceId, "AI Client instance ID")
    );
    const driverId = assertAiClientDriverId(
      nonEmpty(entry.driverId, "AI Client driver ID")
    );
    const displayName = nonEmpty(entry.displayName, "AI Client display name");
    const configuredExecutable = nonEmpty(
      entry.executablePath,
      "AI Client executable path"
    );
    if (!path.isAbsolute(configuredExecutable)) {
      throw new Error("AI Client executable path must be absolute");
    }
    const executablePath = path.resolve(configuredExecutable);
    const executableTarget = fs.realpathSync(executablePath);
    if (!fs.statSync(executableTarget).isFile()) {
      throw new Error("AI Client executable path is not a file");
    }
    if (process.platform !== "win32") {
      fs.accessSync(executableTarget, fs.constants.X_OK);
    }
    const configHome = hasConfigHome
      ? fs.realpathSync(nonEmpty(entry.configHome, "AI Client config home"))
      : undefined;
    if (configHome && !fs.statSync(configHome).isDirectory()) {
      throw new Error("AI Client config home is not a directory");
    }
    return {
      instanceId,
      driverId,
      displayName,
      executablePath,
      ...(configHome ? { configHome } : {})
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const instanceId =
      typeof entry.instanceId === "string" && entry.instanceId.trim()
        ? entry.instanceId.trim()
        : null;
    const driverId =
      typeof entry.driverId === "string" && entry.driverId.trim()
        ? entry.driverId.trim()
        : null;
    if (!instanceId || !driverId) {
      process.emitWarning(
        `Ignoring AI Client registry entry ${index}: ${message}`,
        "KoedAiClientRegistry"
      );
      return null;
    }
    try {
      assertAiClientInstanceId(instanceId);
      assertAiClientDriverId(driverId);
    } catch {
      process.emitWarning(
        `Ignoring AI Client registry entry ${index}: ${message}`,
        "KoedAiClientRegistry"
      );
      return null;
    }
    return {
      instanceId,
      driverId,
      displayName:
        typeof entry.displayName === "string" && entry.displayName.trim()
          ? entry.displayName.trim()
          : instanceId,
      executablePath:
        typeof entry.executablePath === "string" ? entry.executablePath : "",
      ...(typeof entry.configHome === "string"
        ? { configHome: entry.configHome }
        : {}),
      configurationError: message
    };
  }
};

export const loadLocalAiClientInstanceRegistry = (
  env: NodeJS.ProcessEnv = process.env
): LocalAiClientInstanceRegistry => {
  const target = aiClientInstanceRegistryPath(env);
  if (!fs.existsSync(target)) return { version: 1, instances: [] };
  const root = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("AI Client instance registry must be an object");
  }
  const value = root as Record<string, unknown>;
  exactKeys(value, ["version", "instances"], "AI Client instance registry");
  if (value.version !== 1 || !Array.isArray(value.instances)) {
    throw new Error("AI Client instance registry version is unsupported");
  }
  const seen = new Set<string>();
  const instances = value.instances.flatMap((candidate, index) => {
    const parsed = readableConfiguration(candidate, index);
    if (!parsed) return [];
    if (seen.has(parsed.instanceId)) {
      throw new Error(`Duplicate AI Client instance ID: ${parsed.instanceId}`);
    }
    seen.add(parsed.instanceId);
    return [parsed];
  });
  return { version: 1, instances };
};

const executableContentHashPrefixBytes = 65_536;

// Filesystem mtime resolution and inode reuse are unreliable change signals on
// some CI and container filesystems, so identity also hashes a bounded prefix
// of the executable's bytes to guarantee content replacement is detected even
// when stat metadata coincidentally matches the previous installation.
const hashExecutableContentPrefix = (executablePath: string): string | null => {
  let fd: number | undefined;
  try {
    fd = fs.openSync(executablePath, "r");
    const buffer = Buffer.alloc(executableContentHashPrefixBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return createHash("sha256")
      .update(buffer.subarray(0, bytesRead))
      .digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort close; identity computation must not throw on cleanup.
      }
    }
  }
};

export const localAiClientInstanceConfigIdentity = (
  instance: LocalAiClientInstanceConfiguration
): string => {
  let executableStat: Record<string, number> | null = null;
  try {
    const stat = fs.statSync(instance.executablePath);
    executableStat = {
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode,
      size: stat.size,
      modifiedMs: stat.mtimeMs,
      changedMs: stat.ctimeMs,
      birthMs: stat.birthtimeMs
    };
  } catch {
    // Unavailable executable identity must not collide with a valid installation.
  }
  const executableContentHash = hashExecutableContentPrefix(
    instance.executablePath
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        instanceId: instance.instanceId,
        driverId: instance.driverId,
        executablePath: instance.executablePath,
        executableStat,
        executableContentHash,
        configHome: instance.configHome ?? null
      })
    )
    .digest("hex");
};

export const resolveLocalAiClientInstance = (input: {
  instanceId: string;
  driverId: string;
  env?: NodeJS.ProcessEnv;
}): LocalAiClientInstanceConfiguration | null => {
  const instanceId = assertAiClientInstanceId(input.instanceId);
  const driverId = assertAiClientDriverId(input.driverId);
  const configured = loadLocalAiClientInstanceRegistry(
    input.env
  ).instances.find((instance) => instance.instanceId === instanceId);
  if (!configured) {
    if (instanceId === `${driverId}.default`) return null;
    throw new Error(`AI Client instance "${instanceId}" is not configured.`);
  }
  if (configured.driverId !== driverId) {
    throw new Error(
      `AI Client instance "${instanceId}" belongs to driver "${configured.driverId}", not "${driverId}".`
    );
  }
  if (configured.configurationError) {
    throw new Error(
      `AI Client instance "${instanceId}" configuration is unavailable: ${configured.configurationError}`
    );
  }
  return configured;
};

export const resolveConfiguredLocalAiClientInstance = (input: {
  instanceId: string;
  driverId: string;
  env?: NodeJS.ProcessEnv;
}): LocalAiClientInstanceConfiguration => {
  const instance = resolveLocalAiClientInstance(input);
  if (!instance) {
    throw new Error(
      `AI Client instance "${input.instanceId}" is not configured.`
    );
  }
  return instance;
};

export const environmentForLocalAiClientInstance = (input: {
  instance: LocalAiClientInstanceConfiguration | null;
  driverId: string;
  env: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv => {
  return {
    ...input.env,
    ...(input.instance
      ? input.driverId === "codex"
        ? {
            MEMORY_CODEX_APP_SERVER_BINARY: input.instance.executablePath,
            ...(input.instance.configHome
              ? { CODEX_HOME: input.instance.configHome }
              : {})
          }
        : input.driverId === "claude"
          ? {
              KOED_CLAUDE_CODE_EXECUTABLE: input.instance.executablePath,
              ...(input.instance.configHome
                ? { CLAUDE_CONFIG_DIR: input.instance.configHome }
                : {})
            }
          : input.driverId === "pi"
            ? {
                KOED_PI_EXECUTABLE: input.instance.executablePath,
                ...(input.instance.configHome
                  ? { PI_CODING_AGENT_DIR: input.instance.configHome }
                  : {})
              }
            : {}
      : {})
  };
};

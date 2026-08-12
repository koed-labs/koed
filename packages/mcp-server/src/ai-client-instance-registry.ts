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
  const instances = value.instances.map((candidate, index) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error(`AI Client instance ${index} must be an object`);
    }
    const entry = candidate as Record<string, unknown>;
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
    if (seen.has(instanceId)) {
      throw new Error(`Duplicate AI Client instance ID: ${instanceId}`);
    }
    seen.add(instanceId);
    const configuredExecutable = nonEmpty(
      entry.executablePath,
      "AI Client executable path"
    );
    if (!path.isAbsolute(configuredExecutable)) {
      throw new Error("AI Client executable path must be absolute");
    }
    const executablePath = fs.realpathSync(configuredExecutable);
    if (!fs.statSync(executablePath).isFile()) {
      throw new Error("AI Client executable path is not a file");
    }
    if (process.platform !== "win32") {
      fs.accessSync(executablePath, fs.constants.X_OK);
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
      displayName: nonEmpty(entry.displayName, "AI Client display name"),
      executablePath,
      ...(configHome ? { configHome } : {})
    };
  });
  return { version: 1, instances };
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
  return configured;
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
          : {}
      : {})
  };
};

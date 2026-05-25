import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface KoedPiConfig {
  apiUrl: string;
  apiToken?: string;
  captureEnabled: boolean;
  captureToolEvents: boolean;
  defaultRetrievalScope: "personal" | "personal+team";
  exposeLowLevelTools: boolean;
  lcmSummaryEnabled: boolean;
}

interface KoedPiFileConfig {
  apiUrl?: string;
  apiToken?: string;
  captureEnabled?: boolean;
  captureToolEvents?: boolean;
  defaultRetrievalScope?: "personal" | "personal+team";
  exposeLowLevelTools?: boolean;
  lcmSummaryEnabled?: boolean;
}

const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const parseBooleanEnv = (name: string): boolean | undefined => {
  const value = env(name)?.toLowerCase();
  if (value === undefined) {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value);
};

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const readConfigFile = (filePath: string): KoedPiFileConfig => {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as KoedPiFileConfig) : {};
  } catch {
    return {};
  }
};

const fileConfig = (): KoedPiFileConfig => {
  const packageDefaults = readConfigFile(
    path.join(packageRoot, "koed.defaults.json")
  );
  const globalConfig = readConfigFile(
    path.join(os.homedir(), ".pi", "agent", "koed.json")
  );
  const projectConfig = readConfigFile(
    path.join(process.cwd(), ".pi", "koed.json")
  );
  return { ...packageDefaults, ...globalConfig, ...projectConfig };
};

export const loadConfig = (): KoedPiConfig => {
  const config = fileConfig();
  return {
    apiUrl:
      env("KOED_API_URL") ??
      env("MEMORY_API_URL") ??
      env("CODEX_MEMORY_BASE_URL") ??
      config.apiUrl ??
      "http://localhost:4170",
    apiToken:
      env("KOED_API_TOKEN") ??
      env("MEMORY_API_TOKEN") ??
      env("CODEX_MEMORY_API_TOKEN") ??
      config.apiToken,
    captureEnabled:
      parseBooleanEnv("KOED_CAPTURE_ENABLED") ?? config.captureEnabled ?? true,
    captureToolEvents:
      parseBooleanEnv("KOED_CAPTURE_TOOL_EVENTS") ??
      config.captureToolEvents ??
      false,
    defaultRetrievalScope:
      env("KOED_DEFAULT_RETRIEVAL_SCOPE") === "personal+team" ||
      config.defaultRetrievalScope === "personal+team"
        ? "personal+team"
        : "personal",
    exposeLowLevelTools:
      parseBooleanEnv("KOED_EXPOSE_LOW_LEVEL_TOOLS") ??
      config.exposeLowLevelTools ??
      false,
    lcmSummaryEnabled: config.lcmSummaryEnabled ?? true
  };
};

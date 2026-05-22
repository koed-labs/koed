export interface KoedPiConfig {
  apiUrl: string;
  apiToken?: string;
  captureEnabled: boolean;
  captureToolEvents: boolean;
  defaultRetrievalScope: "personal" | "personal+team";
  exposeLowLevelTools: boolean;
}

const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const booleanEnv = (name: string, fallback: boolean): boolean => {
  const value = env(name)?.toLowerCase();
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
};

export const loadConfig = (): KoedPiConfig => ({
  apiUrl:
    env("KOED_API_URL") ??
    env("MEMORY_API_URL") ??
    env("CODEX_MEMORY_BASE_URL") ??
    "http://localhost:3000",
  apiToken:
    env("KOED_API_TOKEN") ??
    env("MEMORY_API_TOKEN") ??
    env("CODEX_MEMORY_API_TOKEN"),
  captureEnabled: booleanEnv("KOED_CAPTURE_ENABLED", true),
  captureToolEvents: booleanEnv("KOED_CAPTURE_TOOL_EVENTS", false),
  defaultRetrievalScope:
    env("KOED_DEFAULT_RETRIEVAL_SCOPE") === "personal+team"
      ? "personal+team"
      : "personal",
  exposeLowLevelTools: booleanEnv("KOED_EXPOSE_LOW_LEVEL_TOOLS", false)
});

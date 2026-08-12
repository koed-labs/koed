import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ExperienceReplayCodexAuthMode } from "./core/index.js";
import { ProductPathPrerequisiteError } from "./preflight.js";

export type RecordedCodexAuthentication =
  | { mode: "api_key"; apiKey: string }
  | { mode: "subscription"; authJsonPath: string; codexHome: string };

const required = (
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string
): string => {
  const value = environment[name]?.trim();
  if (!value || /[\0\r\n]/u.test(value))
    throw new ProductPathPrerequisiteError([`${name} is required`]);
  return value;
};

const validateSubscriptionAuth = (filename: string): string => {
  if (!path.isAbsolute(filename))
    throw new ProductPathPrerequisiteError([
      "KOED_EXPERIENCE_REPLAY_CODEX_AUTH_JSON_PATH must be absolute"
    ]);
  let canonical: string;
  let metadata: ReturnType<typeof statSync>;
  try {
    if (lstatSync(filename).isSymbolicLink())
      throw new ProductPathPrerequisiteError([
        "Codex subscription auth.json must not be a symbolic link"
      ]);
    canonical = realpathSync(filename);
    metadata = statSync(canonical);
  } catch (error) {
    if (error instanceof ProductPathPrerequisiteError) throw error;
    throw new ProductPathPrerequisiteError([
      "Codex subscription auth.json could not be read"
    ]);
  }
  if (!metadata.isFile())
    throw new ProductPathPrerequisiteError([
      "Codex subscription auth.json must be a regular file"
    ]);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    throw new ProductPathPrerequisiteError([
      "Codex subscription auth.json must not be accessible by group or other users"
    ]);
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    throw new ProductPathPrerequisiteError([
      "Codex subscription auth.json must be owned by the current user"
    ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(canonical, "utf8"));
  } catch {
    throw new ProductPathPrerequisiteError([
      "Codex subscription auth.json is not valid JSON"
    ]);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { auth_mode?: unknown }).auth_mode !== "string" ||
    !(parsed as { tokens?: unknown }).tokens ||
    typeof (parsed as { tokens?: unknown }).tokens !== "object" ||
    Array.isArray((parsed as { tokens?: unknown }).tokens) ||
    typeof (parsed as { OPENAI_API_KEY?: unknown }).OPENAI_API_KEY === "string"
  ) {
    throw new ProductPathPrerequisiteError([
      "Codex auth.json does not contain subscription authentication"
    ]);
  }
  return canonical;
};

export const resolveRecordedCodexAuthentication = (
  environment: Readonly<NodeJS.ProcessEnv>,
  mode: ExperienceReplayCodexAuthMode
): RecordedCodexAuthentication => {
  if (mode === "api_key")
    return { mode, apiKey: required(environment, "OPENAI_API_KEY") };
  const authJsonPath = validateSubscriptionAuth(
    required(environment, "KOED_EXPERIENCE_REPLAY_CODEX_AUTH_JSON_PATH")
  );
  return {
    mode,
    authJsonPath,
    codexHome: path.dirname(authJsonPath)
  };
};

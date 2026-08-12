import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const LOCAL_AI_RUNTIME_PROTOCOL_VERSION = 1 as const;

export const localRuntimeToolNames = [
  "memory_access_check",
  "memory_answer",
  "memory_intake_propose",
  "memory_search",
  "memory_expand"
] as const;

export type LocalRuntimeToolName = (typeof localRuntimeToolNames)[number];

export interface LocalRuntimeCallerContext {
  cwd: string;
  protocolVersion?: string;
  clientInfo?: Record<string, unknown>;
  clientCapabilities?: Record<string, unknown>;
}

export interface LocalRuntimeToolRequest {
  input: Record<string, unknown>;
  caller: LocalRuntimeCallerContext;
}

export interface LocalRuntimeCapabilities {
  protocolVersion: typeof LOCAL_AI_RUNTIME_PROTOCOL_VERSION;
  curatedMemoryIntakeAvailable: boolean;
}

const registrationSchema = z.object({
  protocolVersion: z.literal(LOCAL_AI_RUNTIME_PROTOCOL_VERSION),
  url: z
    .string()
    .url()
    .refine((value) => {
      const parsed = new URL(value);
      return (
        parsed.protocol === "http:" &&
        (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
      );
    }, "Local AI runtime URL must use loopback HTTP"),
  authorization: z.string().regex(/^Bearer [A-Za-z0-9_-]{32,}$/),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime()
});

export type LocalRuntimeRegistration = z.infer<typeof registrationSchema>;

export const resolveKoedHome = (
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const configured = environment.KOED_HOME?.trim();
  if (!configured) return path.join(os.homedir(), ".koed");
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return path.resolve(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
};

export const localRuntimeRegistrationPath = (koedHome: string): string =>
  path.join(koedHome, "run", "local-ai-runtime.json");

export const readLocalRuntimeRegistration = (
  environment: NodeJS.ProcessEnv = process.env
): LocalRuntimeRegistration => {
  const registrationPath = localRuntimeRegistrationPath(
    resolveKoedHome(environment)
  );
  let descriptor: number;
  try {
    descriptor = openSync(
      registrationPath,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
    );
  } catch (error) {
    throw new Error(
      "Koed local AI runtime is not running. Start Koed Desktop or koed-server before using memory tools.",
      { cause: error }
    );
  }
  try {
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile() ||
      (process.platform !== "win32" && (stats.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && stats.uid !== process.getuid())
    ) {
      throw new Error("Local AI runtime registration permissions are unsafe");
    }
    const content = readFileSync(descriptor, "utf8");
    return registrationSchema.parse(JSON.parse(content));
  } catch (error) {
    throw new Error(
      "Koed local AI runtime registration is invalid. Restart koed-server to repair it.",
      { cause: error }
    );
  } finally {
    closeSync(descriptor);
  }
};

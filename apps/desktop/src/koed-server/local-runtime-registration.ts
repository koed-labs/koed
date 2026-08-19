import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync
} from "node:fs";
import { resolve } from "node:path";
import { isLoopbackHostname } from "@koed/shared";
import { z } from "zod";

export const LOCAL_AI_RUNTIME_PROTOCOL_VERSION = 1 as const;

const registrationSchema = z
  .object({
    protocolVersion: z.literal(LOCAL_AI_RUNTIME_PROTOCOL_VERSION),
    url: z
      .string()
      .url()
      .refine((value) => {
        const parsed = new URL(value);
        return (
          parsed.protocol === "http:" &&
          isLoopbackHostname(parsed.hostname) &&
          parsed.port !== "" &&
          Number(parsed.port) > 0 &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash &&
          parsed.pathname === "/"
        );
      }, "Local AI runtime URL must be an authenticated loopback origin"),
    authorization: z.string().regex(/^Bearer [A-Za-z0-9_-]{32,}$/),
    pid: z.number().int().positive(),
    startedAt: z.string().datetime()
  })
  .strict();

export type LocalRuntimeRegistration = z.infer<typeof registrationSchema>;

export const localRuntimeRegistrationPath = (koedHome: string): string =>
  resolve(koedHome, "run", "local-ai-runtime.json");

export const readLocalRuntimeRegistration = (
  koedHome: string
): LocalRuntimeRegistration => {
  if ((process.platform as string) === "win32") {
    throw new Error(
      "Native Windows Desktop local AI runtime registration is unsupported. Use WSL or Linux."
    );
  }
  const registrationPath = localRuntimeRegistrationPath(koedHome);
  let descriptor: number;
  try {
    descriptor = openSync(
      registrationPath,
      constants.O_RDONLY |
        ((process.platform as string) === "win32" ? 0 : constants.O_NOFOLLOW)
    );
  } catch (error) {
    throw new Error("Local AI runtime registration is unavailable.", {
      cause: error
    });
  }

  try {
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile() ||
      ((process.platform as string) !== "win32" &&
        (stats.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && stats.uid !== process.getuid())
    ) {
      throw new Error("Local AI runtime registration permissions are unsafe.");
    }
    return registrationSchema.parse(
      JSON.parse(readFileSync(descriptor, "utf8"))
    );
  } catch (error) {
    throw new Error("Local AI runtime registration is invalid.", {
      cause: error
    });
  } finally {
    closeSync(descriptor);
  }
};

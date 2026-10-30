import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { resolveKoedServerPaths } from "./paths.js";
import type { KoedServerDoctorResult } from "./types.js";
import { observeRuntimeLifecycle } from "./runtime-lifecycle.js";

// Lifecycle is advisory context on status output; it must never fail the command.
export const safeLifecycle = (
  paths: ReturnType<typeof resolveKoedServerPaths>
) => {
  try {
    return observeRuntimeLifecycle(paths);
  } catch {
    return {
      state: "unavailable" as const,
      epoch: "unavailable",
      message: "Koed state could not be read."
    };
  }
};

export const printJson = (
  stdout: Pick<NodeJS.WriteStream, "write">,
  value: unknown
) => {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

export const persistDoctorVerification = (
  paths: ReturnType<typeof resolveKoedServerPaths>,
  doctor: KoedServerDoctorResult
): void => {
  mkdirSync(resolve(paths.lastVerificationPath, ".."), {
    recursive: true,
    mode: 0o700
  });
  writeFileSync(
    paths.lastVerificationPath,
    `${JSON.stringify(
      {
        ok: doctor.ok,
        checkedAt: doctor.generatedAt,
        message: doctor.summary
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
};

export const checkCoreSetupNeeded = (
  paths: ReturnType<typeof resolveKoedServerPaths>
): string | null => {
  if (!existsSync(paths.localAppCredentialPath)) {
    return `Core setup is required. Run:

  koed setup core

This will provision your local API Token and prepare Koed services.`;
  }
  return null;
};

export const getNoAgentsWarning = (status: {
  codex?: { configured?: boolean };
  claudeCode?: { configured?: boolean };
  pi?: { configured?: boolean };
}): string | null => {
  const anyConfigured =
    status.codex?.configured ||
    status.claudeCode?.configured ||
    status.pi?.configured;
  if (!anyConfigured) {
    return "No AI Clients configured. Run: koed setup codex, setup claude, or setup pi";
  }
  return null;
};

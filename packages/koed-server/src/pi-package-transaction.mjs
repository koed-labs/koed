import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const piPackageFileSystem = {
  copy: (source, target) => cpSync(source, target, { recursive: true }),
  exists: existsSync,
  mkdir: (target) => mkdirSync(target, { recursive: true, mode: 0o700 }),
  rename: renameSync,
  remove: (target) => rmSync(target, { recursive: true, force: true })
};

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

/**
 * Replace and register the stable Koed Pi package without losing the previous
 * working package on either filesystem or installer failure.
 *
 * @param {{
 *   source: string;
 *   target: string;
 *   install: (target: string) => unknown;
 *   installSucceeded: (result: unknown) => boolean;
 *   fileSystem?: typeof piPackageFileSystem;
 *   suffix?: string;
 * }} input
 */
export const installPiPackageTransaction = (input) => {
  const fileSystem = input.fileSystem ?? piPackageFileSystem;
  const suffix = input.suffix ?? `${Date.now()}-${randomUUID()}`;
  const staged = `${input.target}.stage-${suffix}`;
  const backup = `${input.target}.backup-${suffix}`;
  let previousMoved = false;
  let candidateAtTarget = false;
  let installAttempted = false;
  let installResult;

  fileSystem.mkdir(dirname(input.target));
  fileSystem.remove(staged);
  fileSystem.remove(backup);
  const hadPrevious = fileSystem.exists(input.target);

  try {
    fileSystem.copy(input.source, staged);
    if (
      !fileSystem.exists(resolve(staged, "package.json")) ||
      !fileSystem.exists(resolve(staged, "extensions/koed.mjs"))
    )
      throw new Error("The staged Koed Pi package is incomplete.");

    if (hadPrevious) {
      fileSystem.rename(input.target, backup);
      previousMoved = true;
    }
    fileSystem.rename(staged, input.target);
    candidateAtTarget = true;
    installAttempted = true;
    installResult = input.install(input.target);
    if (!input.installSucceeded(installResult))
      throw new Error("Pi package installation failed.");

    fileSystem.remove(backup);
    return {
      ok: true,
      hadPrevious,
      installResult,
      error: undefined,
      registrationError: undefined,
      registrationResult: undefined,
      restorationError: undefined,
      backupPath: undefined
    };
  } catch (error) {
    let restorationError;
    let registrationError;
    let registrationResult;
    if (candidateAtTarget) {
      try {
        fileSystem.remove(input.target);
        candidateAtTarget = false;
      } catch (restoreError) {
        restorationError = restoreError;
      }
    }
    if (previousMoved && !candidateAtTarget) {
      try {
        fileSystem.rename(backup, input.target);
        previousMoved = false;
      } catch (restoreError) {
        restorationError ??= restoreError;
      }
    }
    if (!previousMoved && hadPrevious && installAttempted) {
      try {
        registrationResult = input.install(input.target);
        if (!input.installSucceeded(registrationResult))
          registrationError = new Error(
            "The restored Pi package registration could not be verified."
          );
      } catch (registerError) {
        registrationError = registerError;
      }
    }
    try {
      fileSystem.remove(staged);
    } catch (cleanupError) {
      restorationError ??= cleanupError;
    }

    return {
      ok: false,
      hadPrevious,
      installResult,
      error: errorMessage(error),
      ...(registrationError
        ? {
            registrationError: errorMessage(registrationError),
            registrationResult
          }
        : {}),
      ...(restorationError
        ? {
            restorationError: errorMessage(restorationError),
            backupPath: previousMoved ? backup : undefined
          }
        : {})
    };
  }
};

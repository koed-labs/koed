import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { PINNED_PRIVACY_MODEL_REVISION } from "@koed/shared";
import type { KoedServerPaths } from "./paths.js";
import type { ComponentVariant } from "./component-contract.js";
import type { PrivacyDownloadCompatibility } from "./privacy-download-compatibility.js";
import {
  isPrivacyInferenceVerification,
  type PrivacyInferenceVerification
} from "./privacy-inference.js";

export interface PrivacyInstallationRecord {
  schemaVersion: 1;
  generationId: string;
  manifestDigest: string;
  variant?: ComponentVariant;
  modelRevision: string;
  verifiedAt: string;
  compatibility: PrivacyDownloadCompatibility;
  verification: PrivacyInferenceVerification;
}
const recordPath = (paths: KoedServerPaths, generationId: string) => {
  if (!/^[a-f0-9]{64}$/.test(generationId))
    throw new Error("Invalid Privacy installation generation.");
  return resolve(
    paths.configDir,
    "privacy-installations",
    `${generationId}.json`
  );
};
// Diagnostic evidence and a conservative CPU preference, never readiness or
// component authority. Startup still verifies the generation, model and service.
export function writePrivacyInstallationRecord(
  paths: KoedServerPaths,
  record: PrivacyInstallationRecord
): void {
  const target = recordPath(paths, record.generationId);
  mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readPrivacyInstallationRecord(
  paths: KoedServerPaths,
  generationId: string,
  manifestDigest: string
): PrivacyInstallationRecord | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      recordPath(paths, generationId),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 32768) return null;
    const value = JSON.parse(
      readFileSync(descriptor, "utf8")
    ) as Partial<PrivacyInstallationRecord>;
    if (
      value.schemaVersion !== 1 ||
      value.generationId !== generationId ||
      value.manifestDigest !== manifestDigest ||
      value.modelRevision !== PINNED_PRIVACY_MODEL_REVISION ||
      typeof value.verifiedAt !== "string" ||
      !Number.isFinite(Date.parse(value.verifiedAt)) ||
      !value.compatibility ||
      !isPrivacyInferenceVerification(value.verification)
    )
      return null;
    return value as PrivacyInstallationRecord;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

import type { ArtifactTarget, ComponentId } from "./component-contract.js";

export interface ManifestPinIdentity {
  component: ComponentId;
  productVersion: string;
  target: ArtifactTarget;
}
export interface ManifestPinEntry {
  component: ComponentId;
  target: ArtifactTarget;
  manifestSha256: string;
}
export interface ManifestPinCatalog {
  schemaVersion: 1;
  productVersion: string;
  entries: readonly ManifestPinEntry[];
}

const record = (
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid component pin catalog record.");
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result, key))
  )
    throw new Error("Invalid component pin catalog fields.");
  return result;
};
const validVersion = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
export const manifestPinKey = ({
  component,
  target
}: Pick<ManifestPinIdentity, "component" | "target">): string =>
  JSON.stringify([
    component,
    target.platform,
    target.architecture,
    target.libc?.family ?? null,
    target.libc?.minimumVersion ?? null
  ]);

function validateEntry(value: unknown): ManifestPinEntry {
  const entry = record(value, ["component", "target", "manifestSha256"]);
  if (
    (entry.component !== "base" && entry.component !== "privacy") ||
    typeof entry.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.manifestSha256)
  )
    throw new Error("Invalid component pin catalog entry.");
  const rawTarget = entry.target as Record<string, unknown> | null;
  const target = record(
    rawTarget,
    rawTarget && Object.hasOwn(rawTarget, "libc")
      ? ["platform", "architecture", "libc"]
      : ["platform", "architecture"]
  );
  if (
    (target.platform !== "linux" && target.platform !== "macos") ||
    (target.architecture !== "arm64" && target.architecture !== "x64")
  )
    throw new Error("Invalid component pin target.");
  let libc: ArtifactTarget["libc"];
  if (Object.hasOwn(target, "libc")) {
    const value = record(target.libc, ["family", "minimumVersion"]);
    if (
      target.platform !== "linux" ||
      value.family !== "glibc" ||
      typeof value.minimumVersion !== "string" ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/.test(
        value.minimumVersion
      )
    )
      throw new Error("Invalid component pin libc target.");
    libc = Object.freeze({
      family: "glibc",
      minimumVersion: value.minimumVersion
    });
  }
  return Object.freeze({
    component: entry.component,
    manifestSha256: entry.manifestSha256,
    target: Object.freeze({
      platform: target.platform,
      architecture: target.architecture,
      ...(libc ? { libc } : {})
    })
  });
}

export function validateManifestCatalog(value: unknown): ManifestPinCatalog {
  const input = record(value, ["schemaVersion", "productVersion", "entries"]);
  if (
    input.schemaVersion !== 1 ||
    !validVersion(input.productVersion) ||
    !Array.isArray(input.entries) ||
    input.entries.length === 0
  )
    throw new Error("Invalid component pin catalog identity or entries.");
  const entries = input.entries.map(validateEntry);
  const identities = new Set(entries.map(manifestPinKey));
  if (identities.size !== entries.length)
    throw new Error("Duplicate component pin catalog identity.");
  return Object.freeze({
    schemaVersion: 1,
    productVersion: input.productVersion,
    entries: Object.freeze(entries)
  });
}

export function lookupManifestPin(
  catalog: ManifestPinCatalog | null,
  identity: ManifestPinIdentity
): string {
  if (!catalog)
    throw new Error(
      "Component manifest pin catalog is unavailable; use a trusted versioned control plane."
    );
  if (catalog.productVersion !== identity.productVersion)
    throw new Error("Component pin catalog version mismatch.");
  const key = manifestPinKey(identity);
  const entry = catalog.entries.find((entry) => manifestPinKey(entry) === key);
  if (!entry)
    throw new Error(
      "Required component manifest pin is missing from this control plane."
    );
  return entry.manifestSha256;
}

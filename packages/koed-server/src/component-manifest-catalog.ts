import type {
  ArtifactTarget,
  ComponentId,
  ComponentVariant
} from "./component-contract.js";

export interface ManifestPinIdentity {
  component: ComponentId;
  variant?: ComponentVariant;
  productVersion: string;
  target: ArtifactTarget;
}
export interface ManifestPinEntry {
  component: ComponentId;
  variant?: ComponentVariant;
  target: ArtifactTarget;
  manifestSha256: string;
}
export interface ManifestPinCatalog {
  schemaVersion: 1 | 2;
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
  target,
  variant
}: Pick<ManifestPinIdentity, "component" | "target" | "variant">): string =>
  JSON.stringify([
    component,
    target.platform,
    target.architecture,
    target.libc?.family ?? null,
    target.libc?.minimumVersion ?? null,
    ...(variant === undefined ? [] : [variant])
  ]);

function validateEntry(value: unknown): ManifestPinEntry {
  const entry = record(value, [
    "component",
    "target",
    "manifestSha256",
    ...(value && typeof value === "object" && Object.hasOwn(value, "variant")
      ? ["variant"]
      : [])
  ]);
  if (
    (entry.component !== "base" && entry.component !== "privacy") ||
    typeof entry.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.manifestSha256)
  )
    throw new Error("Invalid component pin catalog entry.");
  if (
    Object.hasOwn(entry, "variant") &&
    (entry.component !== "privacy" ||
      !["cpu", "cuda"].includes(String(entry.variant)))
  )
    throw new Error("Invalid component pin variant.");
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
  if (
    entry.variant !== undefined &&
    (target.platform !== "linux" || target.architecture !== "x64")
  )
    throw new Error("Invalid component pin variant target.");
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
    ...(entry.variant === undefined
      ? {}
      : { variant: entry.variant as ComponentVariant }),
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
    (input.schemaVersion !== 1 && input.schemaVersion !== 2) ||
    !validVersion(input.productVersion) ||
    !Array.isArray(input.entries) ||
    input.entries.length === 0
  )
    throw new Error("Invalid component pin catalog identity or entries.");
  const entries = input.entries.map(validateEntry);
  const identities = new Set(entries.map(manifestPinKey));
  if (identities.size !== entries.length)
    throw new Error("Duplicate component pin catalog identity.");
  const variants = entries.filter((entry) => entry.variant !== undefined);
  if (input.schemaVersion === 1 && variants.length)
    throw new Error("Legacy component catalog cannot authenticate variants.");
  if (input.schemaVersion === 2) {
    if (variants.length === 0)
      throw new Error("Privacy variant catalog is incomplete.");
    for (const entry of entries.filter(
      (entry) =>
        entry.component === "privacy" && entry.target.platform === "linux"
    )) {
      if (
        entry.variant === undefined ||
        !["cpu", "cuda"].every((variant) =>
          entries.some(
            (other) =>
              other.component === "privacy" &&
              other.variant === variant &&
              manifestPinKey({ ...other, variant: undefined }) ===
                manifestPinKey({ ...entry, variant: undefined })
          )
        )
      )
        throw new Error("Privacy variant catalog is incomplete or ambiguous.");
    }
  }
  return Object.freeze({
    schemaVersion: input.schemaVersion as 1 | 2,
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

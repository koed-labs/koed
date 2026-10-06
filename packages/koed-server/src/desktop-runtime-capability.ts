import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface DesktopRuntimeCapability {
  readonly resourcesPath: string;
  readonly productVersion: string;
  readonly bundleDigest: string;
}

const issuedCapabilities = new WeakSet<object>();
const hash = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
const regularFile = (path: string): Buffer => {
  if (constants.O_NOFOLLOW === undefined)
    throw new Error("Desktop bundle no-follow access is unavailable");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!lstatSync(path).isFile())
      throw new Error("Desktop runtime bundle entry is not a regular file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
};

export function verifyDesktopRuntimeBundle(
  resourcesPath: string
): DesktopRuntimeCapability {
  const actualResources = realpathSync.native(resolve(resourcesPath));
  const runtimeRoot = resolve(actualResources, "koed-runtime");
  const manifestPath = resolve(runtimeRoot, "desktop-bundle-manifest.json");
  const manifestBytes = regularFile(manifestPath);
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Desktop runtime bundle manifest is invalid");
  }
  const record = manifest as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.component !== "base" ||
    typeof record.productVersion !== "string" ||
    !Array.isArray(record.files)
  )
    throw new Error("Desktop runtime bundle manifest is invalid");

  const seen = new Set<string>();
  for (const item of record.files) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Desktop runtime bundle manifest is invalid");
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !["file", "symlink"].includes(String(entry.kind))
    ) {
      throw new Error("Desktop runtime bundle manifest is invalid");
    }
    const path = entry.path;
    const absolute = resolve(runtimeRoot, path);
    const rel = relative(runtimeRoot, absolute);
    if (
      !path ||
      isAbsolute(path) ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      seen.has(path)
    ) {
      throw new Error("Desktop runtime bundle manifest path is invalid");
    }
    seen.add(path);
    const actualDigest =
      entry.kind === "file"
        ? hash(regularFile(absolute))
        : hash(readlinkSync(absolute));
    if (actualDigest !== entry.sha256) {
      throw new Error("Desktop runtime bundle file digest mismatch");
    }
    if (entry.kind === "symlink") {
      const target = realpathSync.native(absolute);
      const targetRelative = relative(runtimeRoot, target);
      if (
        targetRelative === ".." ||
        targetRelative.startsWith(`..${sep}`) ||
        isAbsolute(targetRelative)
      ) {
        throw new Error("Desktop runtime bundle symlink escaped resources");
      }
    }
  }
  const actualFiles: string[] = [];
  const collectFiles = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        collectFiles(resolve(directory, entry.name), path);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        if (path !== "desktop-bundle-manifest.json") actualFiles.push(path);
      } else
        throw new Error("Desktop runtime bundle contains an unsupported entry");
    }
  };
  collectFiles(runtimeRoot);
  if (
    actualFiles.some((path) => !seen.has(path)) ||
    actualFiles.length !== seen.size
  ) {
    throw new Error("Desktop runtime bundle contains an unlisted file");
  }
  const capability = Object.freeze({
    resourcesPath: actualResources,
    productVersion: record.productVersion,
    bundleDigest: hash(canonicalJson(record))
  });
  issuedCapabilities.add(capability);
  return capability;
}

export function validateDesktopRuntimeCapability(
  capability: unknown
): capability is DesktopRuntimeCapability {
  return (
    typeof capability === "object" &&
    capability !== null &&
    issuedCapabilities.has(capability)
  );
}

export function resolveDesktopRuntimeOwner(capability: unknown): {
  kind: "desktop";
  installationId: string;
} {
  if (!validateDesktopRuntimeCapability(capability)) {
    throw new Error("validated private Desktop runtime capability is required");
  }
  return {
    kind: "desktop",
    installationId: hash(capability.resourcesPath).slice(0, 32)
  };
}

import { createHash } from "node:crypto";
import { canonicalArtifactJson as canonicalJson } from "./artifact-canonical-json.mjs";
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
import type { RuntimeOwner } from "./component-contract.js";

export interface DesktopRuntimeManifest {
  readonly schemaVersion: 1;
  readonly productVersion: string;
  readonly component: "base";
  readonly target: {
    platform: "macos" | "linux";
    architecture: "arm64" | "x64";
  };
  readonly files: readonly {
    path: string;
    kind: "file" | "symlink";
    sha256: string;
  }[];
}

export interface DesktopRuntimeCapability {
  readonly resourcesPath: string;
  readonly productVersion: string;
  readonly bundleDigest: string;
  readonly manifest: DesktopRuntimeManifest;
  readonly target: DesktopRuntimeManifest["target"];
}

const issuedCapabilities = new WeakSet<object>();
const hash = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");
function validateDesktopRuntimeManifest(
  value: unknown
): asserts value is DesktopRuntimeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Desktop runtime bundle manifest is invalid");
  const record = value as Record<string, unknown>;
  const target = record.target as Record<string, unknown> | undefined;
  if (
    record.schemaVersion !== 1 ||
    record.component !== "base" ||
    typeof record.productVersion !== "string" ||
    !target ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    (target.platform !== "macos" && target.platform !== "linux") ||
    (target.architecture !== "arm64" && target.architecture !== "x64") ||
    !Array.isArray(record.files)
  )
    throw new Error("Desktop runtime bundle manifest is invalid");
  for (const item of record.files) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Desktop runtime bundle manifest is invalid");
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      (entry.kind !== "file" && entry.kind !== "symlink")
    )
      throw new Error("Desktop runtime bundle manifest is invalid");
  }
}
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
  validateDesktopRuntimeManifest(manifest);
  const record = manifest;

  const seen = new Set<string>();
  for (const entry of record.files) {
    const path = entry.path;
    const absolute = resolve(runtimeRoot, path);
    const rel = relative(runtimeRoot, absolute);
    if (
      !path ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      path.startsWith("privacy-service/") ||
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
  const verifiedManifest = Object.freeze({
    ...record,
    target: Object.freeze({ ...record.target }),
    files: Object.freeze(
      record.files.map((entry) => Object.freeze({ ...entry }))
    )
  });
  const capability = Object.freeze({
    resourcesPath: actualResources,
    productVersion: record.productVersion,
    bundleDigest: hash(canonicalJson(record)),
    manifest: verifiedManifest,
    target: verifiedManifest.target
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

export function deriveDesktopRuntimeOwner(
  koedHome: string,
  stableInstallationIdentity: string
): RuntimeOwner {
  return {
    kind: "desktop",
    installationId: hash(
      `${resolve(koedHome)}\n${resolve(stableInstallationIdentity)}`
    ).slice(0, 32)
  };
}

export function resolveDesktopRuntimeOwner(
  capability: unknown,
  koedHome: string
): RuntimeOwner {
  if (!validateDesktopRuntimeCapability(capability)) {
    throw new Error("validated private Desktop runtime capability is required");
  }
  return deriveDesktopRuntimeOwner(koedHome, capability.resourcesPath);
}

import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync
} from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type {
  ArtifactTarget,
  RuntimeIdentity,
  RuntimeOwner
} from "./component-contract.js";
export type { ArtifactTarget, RuntimeIdentity } from "./component-contract.js";
import type { KoedServerPaths } from "./paths.js";
import {
  runComponentStatus,
  type ComponentCommandContext
} from "./component-commands.js";

export interface DesktopBundleManifest {
  schemaVersion: 1;
  productVersion: string;
  component: "base";
  target: ArtifactTarget;
  files: Array<{ path: string; kind: "file" | "symlink"; sha256: string }>;
}

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
const digest = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export interface DesktopBundleCapability {
  readonly root: string;
  readonly digest: string;
  readonly manifest: DesktopBundleManifest;
  readonly capability: symbol;
}

const desktopCapability = Symbol("koed desktop bundled runtime");
const validatedCapabilities = new WeakSet<object>();

export const validateDesktopBundle = async (
  root: string,
  manifestPath: string,
  expectedTarget: ArtifactTarget,
  expectedVersion: string
): Promise<DesktopBundleCapability> => {
  const absoluteRoot = resolve(root);
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Desktop bundle manifest is not a regular file");
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    parsed.component !== "base" ||
    parsed.productVersion !== expectedVersion ||
    !Array.isArray(parsed.files) ||
    !isRecord(parsed.target) ||
    canonicalJson(parsed.target) !== canonicalJson(expectedTarget)
  )
    throw new Error("Desktop bundle manifest identity is invalid");
  const entries = parsed.files as DesktopBundleManifest["files"];
  const declared = new Map<string, string>();
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      (entry.kind !== "file" && entry.kind !== "symlink") ||
      !/^[a-f0-9]{64}$/.test(String(entry.sha256)) ||
      entry.path.startsWith("/") ||
      entry.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      entry.path.startsWith("privacy-service/")
    )
      throw new Error("Desktop bundle manifest file entry is invalid");
    if (declared.has(entry.path))
      throw new Error("Desktop bundle manifest contains duplicate files");
    declared.set(entry.path, entry.sha256 as string);
  }
  const actual = new Map<string, "file" | "symlink">();
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (name === "desktop-bundle-manifest.json") continue;
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        const relativeTarget = relative(absoluteRoot, target);
        if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget))
          throw new Error("Desktop bundle symlink escaped root");
        actual.set(name, "symlink");
      } else if (entry.isDirectory()) visit(path, name);
      else if (entry.isFile()) actual.set(name, "file");
      else
        throw new Error(
          "Desktop bundle contains an unsupported filesystem entry"
        );
    }
  };
  visit(absoluteRoot);
  if (actual.size !== declared.size)
    throw new Error("Desktop bundle file set differs from manifest");
  for (const [path, kind] of actual) {
    const relativePath = relative(absoluteRoot, resolve(absoluteRoot, path));
    if (isAbsolute(relativePath) || relativePath.startsWith(".."))
      throw new Error("Desktop bundle path escaped root");
    const declaredEntry = entries.find((entry) => entry.path === path);
    const content =
      kind === "symlink"
        ? readlinkSync(resolve(absoluteRoot, path))
        : readFileSync(resolve(absoluteRoot, path));
    if (declaredEntry?.kind !== kind || digest(content) !== declared.get(path))
      throw new Error(`Desktop bundle file digest mismatch: ${path}`);
  }
  const manifest = Object.freeze(
    parsed as unknown as DesktopBundleManifest
  );
  Object.freeze(manifest.target);
  for (const entry of manifest.files) Object.freeze(entry);
  Object.freeze(manifest.files);
  const capability: DesktopBundleCapability = Object.freeze({
    root: absoluteRoot,
    digest: digest(canonicalJson(manifest)),
    manifest,
    capability: desktopCapability
  });
  validatedCapabilities.add(capability);
  return capability;
};

export const createDesktopComponentManagerBridge = (input: {
  capability: DesktopBundleCapability;
  paths: KoedServerPaths;
  runtime: RuntimeIdentity;
  isRunning: boolean;
  target: ArtifactTarget;
  controlPlaneVersion: string;
}) => {
  const { capability } = input;
  if (
    !validatedCapabilities.has(capability) ||
    capability.capability !== desktopCapability ||
    capability.manifest.productVersion !== input.controlPlaneVersion ||
    canonicalJson(capability.manifest.target) !== canonicalJson(input.target)
  )
    throw new Error("Desktop bundled runtime capability is invalid");
  const installationId = digest(
    `${input.paths.koedHome}\n${capability.digest}`
  );
  const owner: RuntimeOwner = { kind: "desktop", installationId };
  const context: ComponentCommandContext = {
    paths: input.paths,
    controlPlaneVersion: input.controlPlaneVersion,
    target: input.target,
    runtime: input.runtime,
    owner,
    isRunning: input.isRunning,
    execution: "packaged",
    environment: {}
  };
  return Object.freeze({
    owner,
    bundleDigest: capability.digest,
    bundleRoot: capability.root,
    status: () => runComponentStatus(context),
    install: async (): Promise<never> => {
      throw new Error(
        "Desktop component installation is blocked until production trust roots are configured"
      );
    },
    newOperationId: () => randomUUID()
  });
};

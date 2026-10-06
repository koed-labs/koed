import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync
} from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { ArtifactTarget, RuntimeIdentity } from "./component-contract.js";
export type { ArtifactTarget, RuntimeIdentity } from "./component-contract.js";
import type { KoedServerPaths } from "./paths.js";
import { deriveDesktopRuntimeOwner } from "./desktop-runtime-capability.js";
import {
  runComponentStatus,
  type ComponentCommandContext
} from "./component-commands.js";
import type { ComponentSource } from "./component-store.js";
import {
  stageComponent,
  stageDesktopPrivacyGeneration
} from "./component-store.js";
import { activateGeneration } from "./generation-lifecycle.js";
import { productionComponentTrustRoots } from "./component-trust-roots.js";

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

export const createDesktopPrivacyRpcHandler =
  (input: {
    manager: ReturnType<typeof createDesktopComponentManagerBridge>;
    nonce?: string;
    send: (message: Record<string, unknown>) => void;
  }) =>
  (message: unknown): boolean => {
    if (
      !isRecord(message) ||
      message.type !== "koed.desktop.privacy.request" ||
      typeof message.requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        message.requestId
      ) ||
      typeof message.action !== "string" ||
      (input.nonce !== undefined && message.nonce !== input.nonce)
    )
      return false;
    const requestId = message.requestId;
    const hasExactKeys = (keys: readonly string[]) => {
      const expected = input.nonce ? [...keys, "nonce"] : keys;
      return (
        Object.keys(message).length === expected.length &&
        expected.every((key) => Object.hasOwn(message, key))
      );
    };
    const respond = (result: unknown) =>
      input.send({
        type: "koed.desktop.privacy.response",
        requestId,
        action: message.action,
        ...(input.nonce ? { nonce: input.nonce } : {}),
        result
      });
    const fail = (error: unknown) =>
      input.send({
        type: "koed.desktop.privacy.response",
        requestId,
        action: message.action,
        ...(input.nonce ? { nonce: input.nonce } : {}),
        error:
          error instanceof Error
            ? error.message
            : "Desktop privacy operation failed"
      });
    if (
      message.action === "status" &&
      hasExactKeys(["type", "requestId", "action"])
    ) {
      void input.manager.status().then(
        (status) =>
          respond({
            ...status,
            trustedSignerConfigured: productionComponentTrustRoots.size > 0
          }),
        fail
      );
      return true;
    }
    if (
      message.action === "cancel" &&
      hasExactKeys(["type", "requestId", "action"])
    ) {
      respond({ cancelled: input.manager.cancel(requestId) });
      return true;
    }
    if (
      message.action === "activate" &&
      hasExactKeys(["type", "requestId", "action", "generationId"]) &&
      typeof message.generationId === "string"
    ) {
      void input.manager.activate(message.generationId).then(respond, fail);
      return true;
    }
    if (
      message.action === "install" &&
      (hasExactKeys(["type", "requestId", "action", "source"]) ||
        hasExactKeys(["type", "requestId", "action", "source", "version"])) &&
      Object.hasOwn(message, "source") &&
      (message.version === undefined || typeof message.version === "string")
    ) {
      void input.manager
        .install({
          requestId,
          source: message.source as ComponentSource,
          ...(typeof message.version === "string"
            ? { version: message.version }
            : {}),
          progress: (event) =>
            input.send({
              type: "koed.desktop.privacy.progress",
              action: "install",
              ...(input.nonce ? { nonce: input.nonce } : {}),
              ...event
            })
        })
        .then(respond, fail);
      return true;
    }
    fail(new Error("Desktop privacy IPC request is invalid"));
    return true;
  };
const validatedCapabilities = new WeakSet<object>();

export const validateDesktopBundle = (
  root: string,
  manifestPath: string,
  expectedTarget: ArtifactTarget,
  expectedVersion: string
): DesktopBundleCapability => {
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
  const manifest = Object.freeze(parsed as unknown as DesktopBundleManifest);
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
  const owner = deriveDesktopRuntimeOwner(
    input.paths.koedHome,
    realpathSync.native(resolve(capability.root, ".."))
  );
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
  const operations = new Map<string, AbortController>();
  const requireRequestId = (requestId: unknown): string => {
    if (
      typeof requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        requestId
      )
    )
      throw new Error("Desktop privacy request ID is invalid");
    return requestId;
  };
  const parseSource = (value: unknown): ComponentSource => {
    if (!isRecord(value)) throw new Error("Desktop privacy source is invalid");
    if (
      value.kind === "offline" &&
      Object.keys(value).length === 4 &&
      [value.archivePath, value.manifestPath, value.signaturePath].every(
        (item) => typeof item === "string" && item.length > 0
      )
    )
      return value as ComponentSource;
    if (
      value.kind === "remote" &&
      Object.keys(value).length === 4 &&
      [value.archiveUrl, value.manifestUrl, value.signatureUrl].every(
        (item) => {
          if (typeof item !== "string") return false;
          try {
            return new URL(item).protocol === "https:";
          } catch {
            return false;
          }
        }
      )
    )
      return value as ComponentSource;
    throw new Error("Desktop privacy source is invalid");
  };
  return Object.freeze({
    owner,
    bundleDigest: capability.digest,
    bundleRoot: capability.root,
    status: () => runComponentStatus(context),
    newOperationId: () => randomUUID(),
    cancel: (requestId: string) => {
      const operation = operations.get(requireRequestId(requestId));
      if (!operation) return false;
      operation.abort();
      return true;
    },
    install: async (input: {
      requestId: string;
      source: ComponentSource;
      version?: string;
      progress?: (event: {
        requestId: string;
        phase: string;
        transferredBytes: number;
        totalBytes?: number;
      }) => void;
    }): Promise<{ state: "staged" | "active"; generationId: string }> => {
      const requestId = requireRequestId(input.requestId);
      if (operations.has(requestId))
        throw new Error("Desktop privacy request is already active");
      if (productionComponentTrustRoots.size === 0)
        throw new Error(
          "Production Privacy Filter signer trust is not configured in this Desktop release. Update to a release with approved signer trust roots; no component can be installed until then."
        );
      const source = parseSource(input.source);
      const version = input.version ?? context.controlPlaneVersion;
      if (version !== context.controlPlaneVersion)
        throw new Error(
          "Desktop privacy install requires current control plane version"
        );
      const controller = new AbortController();
      operations.set(requestId, controller);
      try {
        const status = await runComponentStatus(context);
        if (controller.signal.aborted)
          throw new Error("component installation cancelled");
        if (!status.required.includes("privacy"))
          throw new Error(
            "privacy component is not required by current runtime configuration."
          );
        const privacy = await stageComponent(context.paths, source, {
          expectedComponent: "privacy",
          expectedVersion: version,
          target: context.target,
          runtime: context.runtime,
          signal: controller.signal,
          progress: (event) => input.progress?.({ requestId, ...event })
        });
        const generation = await stageDesktopPrivacyGeneration(context.paths, {
          resourcesPath: resolve(capability.root, ".."),
          bundleDigest: capability.digest,
          productVersion: version,
          privacy,
          owner
        });
        if (controller.signal.aborted)
          throw new Error("component installation cancelled");
        if (context.isRunning)
          return { state: "staged", generationId: generation.id };
        const activated = await activateGeneration(
          context.paths,
          generation.id,
          owner
        );
        return { state: "active", generationId: activated.id };
      } finally {
        operations.delete(requestId);
      }
    },
    activate: async (generationId: string) => {
      if (context.isRunning)
        throw new Error(
          "Stop Koed services before activating a component generation."
        );
      if (!/^[a-f0-9]{64}$/.test(generationId))
        throw new Error("generation id is invalid");
      return activateGeneration(context.paths, generationId, owner);
    }
  });
};

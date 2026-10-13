import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactTarget, RuntimeIdentity } from "./component-contract.js";
export type { ArtifactTarget, RuntimeIdentity } from "./component-contract.js";
import type { KoedServerPaths } from "./paths.js";
import {
  type DesktopRuntimeCapability,
  validateDesktopRuntimeCapability,
  deriveDesktopRuntimeOwner,
  verifyDesktopRuntimeBundle
} from "./desktop-runtime-capability.js";
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

export type DesktopBundleManifest = DesktopRuntimeCapability["manifest"];
export type DesktopBundleCapability = DesktopRuntimeCapability;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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
// Compatibility entry point: authentication has one implementation and one issued capability.
export const validateDesktopBundle = (
  root: string,
  manifestPath: string,
  expectedTarget: ArtifactTarget,
  expectedVersion: string
): DesktopBundleCapability => {
  if (resolve(manifestPath) !== resolve(root, "desktop-bundle-manifest.json"))
    throw new Error("Desktop bundle manifest path is invalid");
  const capability = verifyDesktopRuntimeBundle(resolve(root, ".."));
  if (
    resolve(capability.resourcesPath, "koed-runtime") !==
      realpathSync.native(root) ||
    capability.productVersion !== expectedVersion ||
    capability.target.platform !== expectedTarget.platform ||
    capability.target.architecture !== expectedTarget.architecture
  )
    throw new Error("Desktop bundle manifest identity is invalid");
  return capability;
};

export const createDesktopComponentManagerBridge = (input: {
  capability: DesktopBundleCapability;
  paths: KoedServerPaths;
  runtime: RuntimeIdentity;
  isRunning: boolean;
  target: ArtifactTarget;
  controlPlaneVersion: string;
  // The supervisor's own validated environment. Required components (Base,
  // and Privacy when Team is enabled) are derived from it, so it must not be
  // empty here.
  environment: NodeJS.ProcessEnv;
}) => {
  const { capability } = input;
  if (
    !validateDesktopRuntimeCapability(capability) ||
    capability.manifest.productVersion !== input.controlPlaneVersion ||
    capability.target.platform !== input.target.platform ||
    capability.target.architecture !== input.target.architecture
  )
    throw new Error("Desktop bundled runtime capability is invalid");
  const desktopRuntimeCapability = capability;
  const owner = deriveDesktopRuntimeOwner(
    input.paths.koedHome,
    capability.resourcesPath
  );
  const context: ComponentCommandContext = {
    paths: input.paths,
    desktopRuntimeCapability,
    controlPlaneVersion: input.controlPlaneVersion,
    target: input.target,
    runtime: input.runtime,
    owner,
    isRunning: input.isRunning,
    execution: "packaged",
    environment: input.environment
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
    bundleDigest: capability.bundleDigest,
    bundleRoot: resolve(capability.resourcesPath, "koed-runtime"),
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
          resourcesPath: resolve(
            resolve(capability.resourcesPath, "koed-runtime"),
            ".."
          ),
          bundleDigest: capability.bundleDigest,
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
          owner,
          context.desktopRuntimeCapability
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
      return activateGeneration(
        context.paths,
        generationId,
        owner,
        context.desktopRuntimeCapability
      );
    }
  });
};

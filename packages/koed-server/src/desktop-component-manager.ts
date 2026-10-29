import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ArtifactTarget,
  RuntimeIdentity,
  ComponentVariant
} from "./component-contract.js";
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
  stageDesktopPrivacyGeneration,
  resolveComponentManifestPinTarget
} from "./component-store.js";
import {
  activateGeneration,
  stageDesktopBundleForRecovery
} from "./generation-lifecycle.js";
import { productionComponentManifestCatalog } from "./component-manifest-catalog-data.js";
import { validateManifestCatalog } from "./component-manifest-catalog.js";
import { PINNED_PRIVACY_MODEL_REVISION } from "@koed/shared";
import { probePrivacyDownloadCompatibility } from "./privacy-download-compatibility.js";
import { installPrivacyModel } from "./privacy-model-runtime.js";
import { verifyPrivacyComponentInference } from "./privacy-inference.js";
import { writePrivacyInstallationRecord } from "./privacy-installation-record.js";
import { collectDesktopPrivacyInstallStatus } from "./desktop-privacy-status.js";
import { readStoredComponents } from "./component-store.js";

const manifestPinCatalogAvailable = (): boolean => {
  if (productionComponentManifestCatalog === null) return false;
  validateManifestCatalog(productionComponentManifestCatalog);
  return true;
};

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
      void input.manager
        .status()
        .then((status) => respond({ ...status }), fail);
      return true;
    }
    if (
      message.action === "prepare" &&
      hasExactKeys(["type", "requestId", "action"])
    ) {
      void input.manager.prepare().then(respond, fail);
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
      hasExactKeys([
        "type",
        "requestId",
        "action",
        "generationId",
        "expectedCurrentGeneration"
      ]) &&
      typeof message.generationId === "string" &&
      (typeof message.expectedCurrentGeneration === "string" ||
        message.expectedCurrentGeneration === null)
    ) {
      void input.manager
        .activate(message.generationId, message.expectedCurrentGeneration)
        .then(respond, fail);
      return true;
    }
    if (
      message.action === "install" &&
      hasExactKeys([
        "type",
        "requestId",
        "action",
        "source",
        ...(Object.hasOwn(message, "version") ? ["version"] : []),
        ...(Object.hasOwn(message, "variant") ? ["variant"] : [])
      ]) &&
      Object.hasOwn(message, "source") &&
      (message.version === undefined || typeof message.version === "string") &&
      (message.variant === undefined ||
        message.variant === "cpu" ||
        message.variant === "cuda")
    ) {
      void input.manager
        .install({
          requestId,
          source: message.source as ComponentSource,
          ...(message.variant === "cpu" || message.variant === "cuda"
            ? { variant: message.variant }
            : {}),
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
  const prepare = (signal?: AbortSignal) =>
    probePrivacyDownloadCompatibility({
      platform: context.target.platform,
      architecture: context.target.architecture,
      environment: context.environment,
      preference:
        context.environment?.PRIVACY_RUNTIME_ENGINE === "onnx-worker"
          ? "cpu"
          : (context.environment?.PRIVACY_RUNTIME_PROVIDER ??
            context.environment?.KOED_HARDWARE_ACCELERATION ??
            "auto"),
      ...(signal ? { signal } : {})
    });
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
      Object.keys(value).length === 3 &&
      [value.archivePath, value.manifestPath].every(
        (item) => typeof item === "string" && item.length > 0
      )
    )
      return value as ComponentSource;
    if (
      value.kind === "remote" &&
      Object.keys(value).length === 3 &&
      [value.archiveUrl, value.manifestUrl].every((item) => {
        if (typeof item !== "string") return false;
        try {
          return new URL(item).protocol === "https:";
        } catch {
          return false;
        }
      })
    )
      return value as ComponentSource;
    throw new Error("Desktop privacy source is invalid");
  };
  return Object.freeze({
    owner,
    bundleDigest: capability.bundleDigest,
    bundleRoot: resolve(capability.resourcesPath, "koed-runtime"),
    status: () => collectDesktopPrivacyInstallStatus(context),
    prepare: async () => ({
      ...(await prepare()),
      recoveryGenerationId: (
        await stageDesktopBundleForRecovery(context.paths, capability)
      ).id
    }),
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
      variant?: ComponentVariant;
      version?: string;
      progress?: (event: {
        requestId: string;
        phase: string;
        transferredBytes: number;
        totalBytes?: number;
      }) => void;
    }): Promise<{ state: "staged" | "active"; generationId: string }> => {
      const requestId = requireRequestId(input.requestId);
      if (operations.size > 0)
        throw new Error("Desktop privacy request is already active");
      if (!manifestPinCatalogAvailable())
        throw new Error(
          "Production component manifest pin catalog is unavailable in this Desktop release. Update to a catalog-bearing control plane; no component can be installed until then."
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
        if (!status.requiredManifestPinsAvailable)
          throw new Error(
            "Required component manifest pins are unavailable for this Desktop runtime."
          );
        const compatibility = await prepare(controller.signal);
        if (compatibility.target === "unsupported")
          throw new Error(
            "Privacy Filter is unavailable for this device target."
          );
        if (input.variant !== compatibility.variant)
          throw new Error(
            "Privacy compatibility changed. Retry installation to select the matching bundle."
          );
        input.progress?.({
          requestId,
          phase: "compatibility",
          transferredBytes: 0
        });
        const pinnedTarget = resolveComponentManifestPinTarget(
          validateManifestCatalog(productionComponentManifestCatalog),
          {
            component: "privacy",
            variant: compatibility.variant,
            productVersion: version,
            target: context.target,
            runtime: context.runtime
          }
        );
        const cached =
          source.kind === "remote"
            ? (await readStoredComponents(context.paths, context.runtime)).find(
                (entry) =>
                  entry.manifest.component === "privacy" &&
                  entry.manifest.productVersion === version &&
                  entry.manifest.variant === compatibility.variant &&
                  entry.manifest.target.platform === context.target.platform &&
                  entry.manifest.target.architecture ===
                    pinnedTarget.architecture &&
                  entry.manifest.target.libc?.family ===
                    pinnedTarget.libc?.family &&
                  entry.manifest.target.libc?.minimumVersion ===
                    pinnedTarget.libc?.minimumVersion
              )
            : undefined;
        if (cached)
          input.progress?.({
            requestId,
            phase: "runtime-cache",
            transferredBytes: 0
          });
        const privacy =
          cached ??
          (await stageComponent(context.paths, source, {
            expectedComponent: "privacy",
            expectedVariant: input.variant,
            expectedVersion: version,
            target: context.target,
            runtime: context.runtime,
            signal: controller.signal,
            progress: (event) =>
              input.progress?.({
                requestId,
                ...event,
                phase: `runtime-${event.phase}`
              })
          }));
        const model = await installPrivacyModel(
          context.paths,
          context.environment,
          undefined,
          {
            signal: controller.signal,
            progress: (event) => input.progress?.({ requestId, ...event })
          }
        );
        if (!model.ok)
          throw new Error(
            `${model.message}${model.action ? ` ${model.action}` : ""}`
          );
        controller.signal.throwIfAborted();
        input.progress?.({
          requestId,
          phase: "inference",
          transferredBytes: 0
        });
        const verification = await verifyPrivacyComponentInference({
          paths: context.paths,
          componentRoot: privacy.root,
          modelPath: model.modelPath,
          provider: compatibility.variant === "cuda" ? "cuda" : "cpu",
          environment: context.environment ?? process.env,
          signal: controller.signal
        });
        if (verification.fallbackReason)
          input.progress?.({
            requestId,
            phase: "cpu-fallback",
            transferredBytes: 0
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
        writePrivacyInstallationRecord(context.paths, {
          schemaVersion: 1,
          generationId: generation.id,
          manifestDigest: privacy.manifestDigest,
          ...(privacy.manifest.variant
            ? { variant: privacy.manifest.variant }
            : {}),
          modelRevision: PINNED_PRIVACY_MODEL_REVISION,
          verifiedAt: new Date().toISOString(),
          compatibility,
          verification
        });
        // Activation is one explicit lifecycle boundary after both downloads and
        // real inference. A stopped install cannot report runtime-only readiness.
        return { state: "staged", generationId: generation.id };
      } catch (error) {
        if (controller.signal.aborted)
          throw new Error("Privacy Filter installation cancelled.", {
            cause: error
          });
        if ((error as NodeJS.ErrnoException).code === "ENOSPC")
          throw new Error(
            "There is not enough disk space to install Privacy Filter. Free some space and retry; the previous runtime selection was preserved.",
            { cause: error }
          );
        throw error;
      } finally {
        operations.delete(requestId);
      }
    },
    activate: async (
      generationId: string,
      expectedCurrentGeneration: string | null
    ) => {
      if (context.isRunning)
        throw new Error(
          "Stop Koed services before activating a component generation."
        );
      if (
        !/^[a-f0-9]{64}$/.test(generationId) ||
        (expectedCurrentGeneration !== null &&
          !/^[a-f0-9]{64}$/.test(expectedCurrentGeneration))
      )
        throw new Error("generation id is invalid");
      return activateGeneration(
        context.paths,
        generationId,
        owner,
        context.desktopRuntimeCapability,
        { expectedCurrentGeneration }
      );
    }
  });
};

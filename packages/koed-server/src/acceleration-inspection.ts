import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveKoedRuntimeOwner } from "./app-runtime.js";
import type {
  AccelerationCudaPackage,
  AccelerationSnapshot
} from "./acceleration-contract.js";
import { inspectAccelerationHardware } from "./acceleration-hardware.js";
import { inspectAccelerationServices } from "./acceleration-health.js";
import { resolveKoedServerConfig } from "./config.js";
import {
  resolveDesktopRuntimeOwner,
  type DesktopRuntimeCapability
} from "./desktop-runtime-capability.js";
import { environmentWithRepoEnv } from "./env-file.js";
import { readCurrentRuntimeOwner } from "./generation-lifecycle.js";
import { nativeLlamaServerOverride } from "./local-embedding-runtime.js";
import { resolveLocalModelManifest } from "./local-models-runtime.js";
import { readLocalServiceSecrets } from "./local-service-secrets.js";
import { getNativeRuntimeCatalog } from "./native-runtime-catalog.js";
import {
  coreStartBlocker,
  currentNativeId,
  nativePathExists,
  nativeStore,
  payloadRoot,
  readNativeSelection
} from "./native-selection.js";
import { applyPersistedLocalPorts } from "./ports.js";
import type { KoedServerPaths } from "./paths.js";
import { assertReleaseHost } from "./runtime-release.js";
import { embeddingPolicy } from "./runtime-release-assets.js";
import { observeRuntimeLifecycle } from "./runtime-lifecycle.js";

const blankCuda = (
  state: AccelerationCudaPackage["state"],
  reason: string
): AccelerationCudaPackage => ({
  validation: "unknown",
  state,
  selectionId: null,
  canInstall: false,
  downloadBytes: null,
  requiredFreeBytes: null,
  availableFreeBytes: null,
  reason
});
const fileStamp = (path: string) => {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return info ? `${info.ino}:${info.mtimeMs}:${info.size}` : "missing";
};
const hasSavedPreference = (path: string): boolean => {
  if (!existsSync(path)) return false;
  // Configuration has already passed strict validation before this call.
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return (
    !!value &&
    typeof value === "object" &&
    Object.hasOwn(value, "hardwareAcceleration")
  );
};
const availableBytes = (path: string) => {
  let parent = path;
  while (!existsSync(parent) && dirname(parent) !== parent)
    parent = dirname(parent);
  const disk = statfsSync(parent, { bigint: true });
  return Number(disk.bavail * disk.bsize);
};

export function inspectAccelerationPackage(
  paths: KoedServerPaths
): AccelerationCudaPackage {
  if (process.platform !== "linux" || process.arch !== "x64")
    return blankCuda(
      "not-applicable",
      "No optional CUDA package is needed on this device."
    );
  try {
    assertReleaseHost();
  } catch {
    return blankCuda(
      "unavailable",
      "The optional package requires Linux x64 with glibc 2.35 or later."
    );
  }
  let catalog;
  try {
    catalog = getNativeRuntimeCatalog();
  } catch {
    return blankCuda(
      "unavailable",
      "This build has no reviewed native runtime catalog. Use a release with CUDA support."
    );
  }
  try {
    const selected = readNativeSelection(paths, catalog);
    if (!catalog.cuda && !selected?.cuda)
      return blankCuda(
        "unavailable",
        "This release has no qualified CUDA add-on."
      );
    const missing = [
      catalog.core,
      ...(catalog.cuda ? [catalog.cuda] : [])
    ].filter((pin) => !nativePathExists(payloadRoot(paths, pin)));
    const downloadBytes = missing.reduce(
      (total, pin) => total + pin.archiveBytes,
      0
    );
    // The working reserve only matters when something must be downloaded.
    const requiredFreeBytes = missing.length
      ? missing.reduce(
          (total, pin) => total + pin.expandedBytes,
          128 * 1024 * 1024 + downloadBytes
        )
      : 0;
    const free = availableBytes(nativeStore(paths));
    const blocker = selected && coreStartBlocker(selected.pin, catalog);
    const state = blocker
      ? "incompatible"
      : !selected?.cuda
        ? "missing"
        : selected.pin.recipeId !== catalog.core.recipeId ||
            (catalog.cuda && selected.cuda.recipeId !== catalog.cuda.recipeId)
          ? "outdated"
          : "installed";
    return {
      validation: "unknown",
      state,
      selectionId: selected?.id ?? null,
      downloadBytes,
      requiredFreeBytes,
      availableFreeBytes: free,
      canInstall: !!catalog.cuda && free >= requiredFreeBytes,
      reason:
        !catalog.cuda && selected?.cuda
          ? "The compatible installed CUDA runtime can be reused. This release does not offer a new CUDA download."
          : free < requiredFreeBytes
            ? "Free more disk space before installing CUDA."
            : blocker
              ? "The native core requires an update before CUDA can be used."
              : state === "missing"
                ? "CUDA is an optional additional download."
                : state === "outdated"
                  ? "An updated core and CUDA pair is available. The installed compatible pair can still be used."
                  : "The selected CUDA package is installed. Active execution is verified separately."
    };
  } catch {
    return blankCuda(
      "incompatible",
      "The existing native runtime cannot be composed with this add-on. Keep its current provider, or repair the runtime before retrying."
    );
  }
}

export function createAccelerationInspector(options: {
  paths: KoedServerPaths;
  environment: () => NodeJS.ProcessEnv;
  serviceEnvironment?: () => NodeJS.ProcessEnv | undefined;
  capability?: DesktopRuntimeCapability;
  fetch?: typeof fetch;
}) {
  const { paths } = options;
  let cached: {
    key: string;
    value: Promise<Pick<AccelerationSnapshot, "hardware" | "cuda" | "model">>;
  } | null = null;
  let pending: Promise<AccelerationSnapshot> | null = null;
  const inspect = async (refresh = false): Promise<AccelerationSnapshot> => {
    const environment = applyPersistedLocalPorts(
      paths,
      environmentWithRepoEnv(paths.repoRoot, options.environment()),
      { force: true }
    );
    const config = resolveKoedServerConfig(paths, environment, {
      strict: true
    });
    const automaticPorts =
      environment.KOED_AUTO_PORTS === "1" ||
      (environment.KOED_AUTO_PORTS === undefined &&
        config.runtimeMode === "local-personal");
    if (config.dependencyMode === "bundled-local" && automaticPorts) {
      // Match startup's allocated endpoints, including ports moved after a
      // collision. Repository defaults describe the requested ports, not the
      // running services. Explicit native KOED_* port overrides still apply.
      Object.assign(
        environment,
        applyPersistedLocalPorts(paths, {}, { force: true })
      );
    }
    const savedConfig = resolveKoedServerConfig(paths, {}, { strict: true });
    const lifecycle = observeRuntimeLifecycle(paths);
    const model = resolveLocalModelManifest(paths, "embedding", environment);
    const managed =
      [
        "KOED_HARDWARE_ACCELERATION",
        "KOED_EMBEDDING_ACCELERATION",
        "PRIVACY_RUNTIME_PROVIDER"
      ].some((key) => environment[key]?.trim()) ||
      !!nativeLlamaServerOverride(environment);
    const external = config.dependencyMode === "external";
    const source = external
      ? "external"
      : managed
        ? "environment"
        : hasSavedPreference(paths.serverConfigPath)
          ? "saved"
          : "default";
    const owner = options.capability
      ? resolveDesktopRuntimeOwner(options.capability, paths.koedHome)
      : resolveKoedRuntimeOwner();
    let ownerMismatch = false;
    let ownerUnverified = lifecycle.state === "unavailable";
    try {
      const current =
        lifecycle.state === "stopped"
          ? await readCurrentRuntimeOwner(paths)
          : lifecycle.owner;
      ownerUnverified ||= lifecycle.state !== "stopped" && !current;
      ownerMismatch =
        !!current &&
        (current.kind !== owner.kind ||
          current.installationId !== owner.installationId);
    } catch {
      ownerUnverified = true;
    }
    const runtimeReadOnlyReason = external
      ? "The Operator manages the external Embedding Service."
      : ownerMismatch
        ? "Another Koed installation owns this runtime. Manage acceleration from that installation."
        : ownerUnverified
          ? "Runtime ownership could not be verified. Check Koed status before changing processing."
          : null;
    const readOnlyReason =
      !external && managed
        ? "The Operator environment controls local acceleration."
        : runtimeReadOnlyReason;
    let selectedId: string | null;
    try {
      selectedId = process.platform === "linux" ? currentNativeId(paths) : null;
    } catch {
      selectedId = "unavailable";
    }
    const configurationKey = JSON.stringify([
      fileStamp(paths.serverConfigPath),
      model.key,
      model.filename,
      environment.KOED_EMBEDDING_MODEL_PATH,
      environment.CUDA_VISIBLE_DEVICES,
      environment.CUDA_DEVICE_ORDER,
      source,
      config.hardwareAcceleration,
      environment.KOED_EMBEDDING_ACCELERATION,
      environment.PRIVACY_RUNTIME_PROVIDER,
      readOnlyReason,
      runtimeReadOnlyReason
    ]);
    const key = JSON.stringify([
      configurationKey,
      selectedId,
      fileStamp(model.modelPath)
    ]);
    const inspectionKey = JSON.stringify([key, lifecycle.epoch]);
    if (refresh || !cached || cached.key !== inspectionKey)
      cached = {
        key: inspectionKey,
        value: (async () => ({
          hardware: await inspectAccelerationHardware(environment),
          cuda: inspectAccelerationPackage(paths),
          model: {
            key: model.key,
            label: external
              ? "Operator-managed embedding model"
              : environment.KOED_EMBEDDING_MODEL_PATH?.trim()
                ? "Custom embedding model"
                : "Qwen3 Embedding · 0.6B",
            filename: model.filename,
            present: existsSync(model.modelPath)
          }
        }))()
      };
    const staticState = await cached.value;
    const privacyInstalled =
      existsSync(resolve(paths.modelsDir, "privacy")) ||
      Boolean(
        external &&
        (config.external?.privacyServiceUrl || environment.PRIVACY_SERVICE_URL)
      );
    // Source bundled-personal startup also provisions these service credentials.
    // Read only the existing tokens, and never create secrets during inspection.
    const secrets =
      !external &&
      config.runtimeMode === "local-personal" &&
      config.dependencyMode === "bundled-local"
        ? readLocalServiceSecrets(paths)
        : null;
    const serviceEnvironment =
      options.serviceEnvironment?.() ??
      (secrets?.state === "valid"
        ? {
            ...environment,
            EMBEDDING_SERVICE_TOKEN:
              options.environment().EMBEDDING_SERVICE_TOKEN ??
              secrets.secrets.EMBEDDING_SERVICE_TOKEN ??
              environment.EMBEDDING_SERVICE_TOKEN,
            PRIVACY_RUNTIME_CONTROL_TOKEN:
              options.environment().PRIVACY_RUNTIME_CONTROL_TOKEN ??
              secrets.secrets.PRIVACY_RUNTIME_CONTROL_TOKEN ??
              environment.PRIVACY_RUNTIME_CONTROL_TOKEN
          }
        : environment);
    const services = await inspectAccelerationServices({
      environment: serviceEnvironment,
      lifecycle,
      ...(external
        ? {
            externalEmbeddingUrl:
              config.external?.embeddingServiceUrl ??
              environment.EMBEDDING_SERVICE_URL,
            externalPrivacyUrl:
              config.external?.privacyServiceUrl ??
              environment.PRIVACY_SERVICE_URL
          }
        : {}),
      privacyInstalled,
      fetcher: options.fetch
    });
    return {
      observedAt: new Date().toISOString(),
      revision: createHash("sha256").update(key).digest("hex"),
      configurationRevision: createHash("sha256")
        .update(configurationKey)
        .digest("hex"),
      runtimeEpoch: lifecycle.epoch,
      preference: savedConfig.hardwareAcceleration,
      effectivePolicy: embeddingPolicy(paths, environment),
      source,
      readOnlyReason,
      runtimeReadOnlyReason,
      recommendedPreference:
        source !== "default" ||
        (selectedId !== null && selectedId !== "unavailable") ||
        existsSync(paths.lastVerificationPath)
          ? config.hardwareAcceleration
          : staticState.hardware.backend === "metal"
            ? "auto"
            : "cpu",
      ...staticState,
      ...services
    };
  };
  return {
    async inspect(refresh = false) {
      // A mutation must not reuse an inspection begun before its lifecycle lock.
      if (refresh && pending) await pending.catch(() => undefined);
      if (!pending)
        pending = inspect(refresh).finally(() => {
          pending = null;
        });
      return pending;
    },
    invalidate() {
      cached = null;
    }
  };
}

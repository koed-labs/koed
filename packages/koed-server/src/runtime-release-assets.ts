import { resolve } from "node:path";
import { resolveKoedServerConfig } from "./config.js";
import { fetchBounded, type DownloadProgress } from "./bounded-download.js";
import {
  compatibleCuda,
  nativeKind,
  type NativeCudaPin,
  type NativeRuntimeCatalog,
  type NativePin
} from "./native-runtime-catalog.js";
import {
  nativeFileDigest,
  verifyNativePayload
} from "./native-payload-admission.js";
import { extractNativeArchive } from "./package-runtime.js";
import { releaseInstallCommand } from "./native-selection.js";
import type { KoedServerPaths } from "./paths.js";

export type CudaAssetChoice = "preserve" | "with" | "without";

export function embeddingPolicy(
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv
) {
  const policy =
    environment.KOED_EMBEDDING_ACCELERATION?.trim().toLowerCase() ||
    resolveKoedServerConfig(paths, environment).hardwareAcceleration;
  if (!["auto", "cpu", "cuda", "metal"].includes(policy))
    throw new Error(
      "KOED_EMBEDDING_ACCELERATION must be auto, cpu, metal, or cuda."
    );
  return policy;
}

export function chooseCuda(
  catalog: NativeRuntimeCatalog,
  installed: NativeCudaPin | null,
  choice: CudaAssetChoice,
  policy: string
) {
  if (choice === "with") {
    if (!catalog.cuda)
      throw new Error(
        "This release has no reviewed CUDA add-on pin. Use a trusted release with a qualified CUDA add-on."
      );
    return catalog.cuda;
  }
  if (choice === "without") {
    if (policy !== "auto" && policy !== "cpu")
      throw new Error(
        "Select auto or cpu embedding acceleration before removing the CUDA add-on."
      );
    return null;
  }
  if (!installed || compatibleCuda(catalog.core, installed)) return installed;
  if (policy !== "cpu" && policy !== "auto")
    throw new Error(
      `This core update would remove the selected CUDA add-on under forced ${policy} policy. Stop Koed and run ${releaseInstallCommand} --with-cuda.`
    );
  return null;
}

// A core update keeps a compatible installed CUDA add-on by default and validates
// it on the new core. When that GPU check fails, point to the CPU-only update.
export function preservedCudaFailure(
  error: unknown,
  choice: CudaAssetChoice,
  policy: string
): unknown {
  if (
    choice === "preserve" &&
    (policy === "auto" || policy === "cpu") &&
    error instanceof Error
  )
    error.message += ` The installed CUDA add-on is kept by default. To update the CPU core without it, run ${releaseInstallCommand} --without-cuda.`;
  return error;
}

// Only compiled catalog pins may reach this acquisition path. Previously
// installed receipts can select and verify retained bytes but never supply a URL.
export async function stageNativeAsset(
  pin: NativePin,
  staging: string,
  signal: AbortSignal,
  progress?: DownloadProgress
) {
  const kind = nativeKind(pin),
    archive = resolve(staging, kind + ".tar.gz"),
    unpack = resolve(staging, kind);
  try {
    await fetchBounded(
      pin.url,
      archive,
      pin.archiveBytes,
      signal,
      progress,
      false
    );
    if (nativeFileDigest(archive, pin.archiveBytes) !== pin.sha256)
      throw new Error("Native archive digest mismatch.");
  } catch (cause) {
    throw new Error(
      `Could not acquire the pinned native ${kind}: ${cause instanceof Error ? cause.message : String(cause)}. Check connectivity and free space, then retry ${releaseInstallCommand}${kind === "cuda" ? " --with-cuda" : ""}.`,
      { cause }
    );
  }
  await extractNativeArchive(
    kind,
    archive,
    unpack,
    pin.expandedBytes,
    signal,
    pin.target.platform
  );
  const root = resolve(unpack, "koed-runtime");
  verifyNativePayload(root, pin, true);
  return root;
}

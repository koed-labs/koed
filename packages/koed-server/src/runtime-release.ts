import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
  lstatSync,
  readlinkSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { release as kernelRelease } from "node:os";
import { nativeCommand } from "./native-validation-process.js";
import { resolveKoedRuntimeOwner } from "./app-runtime.js";
import type { DownloadProgress } from "./bounded-download.js";
import {
  getNativeRuntimeCatalog,
  compareNativeVersions,
  nativeKind,
  type NativePin
} from "./native-runtime-catalog.js";
import {
  readNativeMetadata,
  syncNativeDirectory
} from "./native-payload-admission.js";
import {
  activateNativeSelection,
  assertStartableCore,
  coreStartBlocker,
  composeNativeSelection,
  payloadRoot,
  currentNativeId,
  nativePathExists,
  nativeStore,
  readNativeSelection,
  releaseInstallCommand,
  NativeSelectionTargetError
} from "./native-selection.js";
import {
  assertDirectoryChain,
  withStoppedRuntime
} from "./generation-lifecycle.js";
import {
  chooseCuda,
  embeddingPolicy,
  preservedCudaFailure,
  stageNativeAsset,
  type CudaAssetChoice
} from "./runtime-release-assets.js";
import {
  checkCudaHost,
  validateStagedCuda
} from "./runtime-release-validation.js";
import type { KoedServerPaths } from "./paths.js";
import {
  resolveDesktopRuntimeOwner,
  type DesktopRuntimeCapability
} from "./desktop-runtime-capability.js";

const reserve = 128 * 1024 * 1024;
class MacCudaPolicyError extends Error {
  constructor() {
    super(
      "CUDA is not supported by the macOS release runtime. Set KOED_EMBEDDING_ACCELERATION to auto or metal before installing or starting."
    );
  }
}
function assertMacPolicy(platform: string, policy: string): void {
  if (platform === "macos" && policy === "cuda") throw new MacCudaPolicyError();
}
export function assertReleaseHost(
  host = {
    platform: process.platform as string,
    arch: process.arch as string,
    kernel: kernelRelease(),
    libc:
      (
        process.report.getReport() as {
          header?: { glibcVersionRuntime?: string };
        }
      ).header?.glibcVersionRuntime ?? ""
  }
): void {
  if (host.platform === "darwin" && host.arch === "arm64") {
    if (
      !/^\d+\.\d+\.\d+$/.test(host.kernel) ||
      Number(host.kernel.split(".")[0]) < 23
    )
      throw new Error(
        "The release provider requires macOS 14 or later on arm64. Upgrade macOS before installing the release runtime."
      );
    return;
  }
  const libc = host.libc;
  const [major, minor] = libc.split(".").map(Number);
  if (
    host.platform !== "linux" ||
    host.arch !== "x64" ||
    !/^\d+\.\d+(\.\d+)?$/.test(libc) ||
    !(major! > 2 || (major === 2 && minor! >= 35))
  )
    throw new Error(
      "The release provider requires Linux x64 and glibc 2.35 or later. On a host supported by Homebrew, install Homebrew and its host prerequisites, then run koed runtime install --provider homebrew --dependency-mode bundled-local."
    );
}

export function collectReleaseRuntimeStatus(
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env
) {
  assertReleaseHost();
  const policy = embeddingPolicy(paths, environment);
  const catalog = getNativeRuntimeCatalog();
  const selected = readNativeSelection(paths, catalog);
  if (!selected)
    return {
      ok: false,
      provider: "release",
      state: "missing",
      pinnedCoreId: catalog.core.recipeId,
      installedCudaId: null,
      pinnedCudaId: catalog.cuda?.recipeId ?? null,
      executionPolicy: policy,
      message: `Install the ${catalog.core.target.platform === "macos" ? "Metal" : "CPU"} runtime with ${releaseInstallCommand}.`
    };
  const blocker = coreStartBlocker(selected.pin, catalog);
  if (blocker)
    return {
      ok: false,
      provider: "release",
      state: "incompatible",
      selectionId: selected.id,
      installedCoreId: selected.pin.recipeId,
      pinnedCoreId: catalog.core.recipeId,
      installedCudaId: selected.cuda?.recipeId ?? null,
      pinnedCudaId: catalog.cuda?.recipeId ?? null,
      executionPolicy: policy,
      runtimeVersion: selected.pin.runtimeVersion,
      message: `${blocker}. Stop Koed and run ${releaseInstallCommand}.`
    };
  const coreOutdated = selected.pin.recipeId !== catalog.core.recipeId;
  const cudaOutdated = !!(
    selected.cuda &&
    catalog.cuda &&
    selected.cuda.recipeId !== catalog.cuda.recipeId
  );
  const outdated = coreOutdated || cudaOutdated;
  return {
    ok: true,
    provider: "release",
    state: outdated ? "outdated" : "installed",
    selectionId: selected.id,
    installedCoreId: selected.pin.recipeId,
    pinnedCoreId: catalog.core.recipeId,
    installedCudaId: selected.cuda?.recipeId ?? null,
    pinnedCudaId: catalog.cuda?.recipeId ?? null,
    executionPolicy: policy,
    runtimeVersion: selected.pin.runtimeVersion,
    message: cudaOutdated
      ? `A CUDA add-on update is available. Stop Koed and run ${releaseInstallCommand} --with-cuda.`
      : coreOutdated
        ? `A native core update is available. Stop Koed and run ${releaseInstallCommand}.`
        : selected.cuda
          ? "The selected CPU core and CUDA add-on are installed."
          : `The selected ${catalog.core.target.platform === "macos" ? "Metal" : "CPU"} runtime is installed.`
  };
}

// Run short, foreground version probes from the composed selection. No probe opens
// a port or database. Wait for close even when cancellation kills its process group.
async function probeCore(
  root: string,
  signal: AbortSignal,
  platform: "linux" | "macos"
): Promise<void> {
  for (const binary of [
    "postgres/bin/postgres",
    "postgres/bin/psql",
    "llama.cpp/llama-server"
  ]) {
    try {
      await nativeCommand(resolve(root, binary), ["--version"], {
        cwd: root,
        signal,
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
          KOED_LLAMA_SERVER_BACKEND: platform === "macos" ? "metal" : "cpu"
        }
      });
    } catch (error) {
      throw new Error(
        `Staged native probe failed: ${binary}. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
  if (platform === "macos") {
    try {
      const devices = await nativeCommand(
        resolve(root, "llama.cpp/llama-server"),
        ["--list-devices"],
        {
          cwd: root,
          signal,
          env: {
            PATH: "/usr/bin:/bin",
            LANG: "C",
            LC_ALL: "C",
            KOED_LLAMA_SERVER_BACKEND: "metal",
            LLAMA_ARG_UI: "false"
          }
        }
      );
      if (!/^[ \t]*(?:MTL[0-9]+|Metal[0-9]*):[ \t]+\S/im.test(devices))
        throw new Error("No Metal device was reported.");
    } catch (cause) {
      throw new Error(
        `Staged Metal device discovery failed: ${cause instanceof Error ? cause.message : String(cause)}. Check Metal support and the native runtime, then retry.`,
        { cause }
      );
    }
  }
}

function recordStatus(paths: KoedServerPaths, id: string): string | undefined {
  const cache = resolve(paths.cacheDir, "runtime-release.json");
  const temp = `${cache}.${randomUUID()}.tmp`;
  try {
    assertDirectoryChain(paths.koedHome, paths.cacheDir);
    mkdirSync(paths.cacheDir, { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify({ schemaVersion: 1, selectionId: id });
    if (
      lstatSync(cache, { throwIfNoEntry: false })?.isFile() &&
      readNativeMetadata(cache, 16 * 1024).toString("utf8") === bytes
    )
      return;
    writeFileSync(temp, bytes, {
      flag: "wx",
      mode: 0o600,
      flush: true
    });
    renameSync(temp, cache);
    syncNativeDirectory(paths.cacheDir);
  } catch (error) {
    return `The selection is active. Could not refresh derived status: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* The cache is derived. */
    }
  }
  return undefined;
}

export async function installReleaseRuntime(
  paths: KoedServerPaths,
  options: {
    signal?: AbortSignal;
    progress?: DownloadProgress;
    cuda?: CudaAssetChoice;
    environment?: NodeJS.ProcessEnv;
    desktopRuntimeCapability?: DesktopRuntimeCapability;
    requireModel?: boolean;
    assertConfiguration?: () => Promise<void>;
    phase?: (
      phase: "checking" | "verifying" | "inference" | "activating"
    ) => void;
  } = {}
) {
  assertReleaseHost();
  if (
    process.platform === "darwin" &&
    options.cuda &&
    options.cuda !== "preserve"
  )
    throw new Error(
      "--with-cuda and --without-cuda are not supported on macOS."
    );
  const catalog = getNativeRuntimeCatalog(),
    pin = catalog.core,
    store = nativeStore(paths),
    owner = options.desktopRuntimeCapability
      ? resolveDesktopRuntimeOwner(
          options.desktopRuntimeCapability,
          paths.koedHome
        )
      : resolveKoedRuntimeOwner();
  const choice = options.cuda ?? "preserve",
    environment = options.environment ?? process.env;
  // No whole-install deadline: a large CUDA download on a slow link is legitimate.
  // Downloads fail after 30 s without data, probes and GPU validation keep their own
  // budgets, and the Operator's signal cancels everything else.
  const signal = options.signal ?? new AbortController().signal;
  const plan = () => {
    signal.throwIfAborted();
    const policy = embeddingPolicy(paths, environment);
    assertMacPolicy(pin.target.platform, policy);
    const selected = readNativeSelection(paths, catalog);
    const cuda = chooseCuda(catalog, selected?.cuda ?? null, choice, policy);
    if (
      selected &&
      selected.pin.recipeId !== pin.recipeId &&
      compareNativeVersions(pin.runtimeVersion, selected.pin.runtimeVersion) <=
        0
    )
      throw new Error(
        "Refusing a native core downgrade or replacement at the same runtime version."
      );
    assertPostgresDataVersion(paths, pin.components.postgres.major);
    return { selected, cuda, policy };
  };
  const before = await withStoppedRuntime(paths, owner, async () => {
    await options.assertConfiguration?.();
    options.phase?.("checking");
    const { selected, cuda, policy } = plan();
    for (const name of ["core", "selections", ...(cuda ? ["cuda"] : [])]) {
      const dir = resolve(store, name);
      assertDirectoryChain(paths.koedHome, dir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (
      selected?.pin.recipeId === pin.recipeId &&
      selected.cuda?.recipeId === cuda?.recipeId
    ) {
      if (choice === "with") options.phase?.("inference");
      const validation =
        choice === "with"
          ? await validateStagedCuda(paths, selected.root, environment, {
              signal,
              requireModel: options.requireModel
            })
          : undefined;
      const warning = recordStatus(paths, selected.id);
      return {
        unchanged: true as const,
        result: {
          ok: true,
          provider: "release",
          state: "installed",
          changed: false,
          selectionId: selected.id,
          coreId: pin.recipeId,
          cudaId: cuda?.recipeId ?? null,
          executionPolicy: policy,
          validation,
          downloadedBytes: 0,
          warning,
          message:
            warning ??
            "The selected native runtime is intact. Run koed start when ready."
        }
      };
    }
    // Check the host before downloading whenever the result keeps or adds CUDA,
    // including a core update that preserves a compatible add-on.
    if (cuda)
      await checkCudaHost(signal).catch((error: unknown) => {
        if (signal.aborted) throw error;
        throw preservedCudaFailure(error, choice, policy);
      });
    return {
      unchanged: false as const,
      previousId: selected?.id ?? null,
      cuda
    };
  });
  if (before.unchanged) return before.result;

  const assets: NativePin[] = before.cuda ? [pin, before.cuda] : [pin];
  const missing = assets.filter(
    (asset) => !nativePathExists(payloadRoot(paths, asset))
  );
  if (
    missing.some(
      (asset) =>
        nativeKind(asset) === "cuda" &&
        (choice !== "with" || asset !== catalog.cuda)
    )
  )
    throw new Error(
      "The retained CUDA add-on is missing. Inspect the native store before retrying."
    );
  const downloadBytes = missing.reduce((n, a) => n + a.archiveBytes, 0);
  const required = missing.reduce(
    (n, a) => n + a.expandedBytes,
    reserve + downloadBytes
  );
  const disk = statfsSync(store, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(required))
    throw new Error(
      `Insufficient free space. The install requires ${required} available bytes, including a ${reserve}-byte reserve. Retained payloads are already counted as used space.`
    );
  const staging = mkdtempSync(resolve(store, ".stage-"));
  try {
    const staged = new Map<NativePin, string>();
    let downloaded = 0;
    for (const asset of missing) {
      staged.set(
        asset,
        await stageNativeAsset(asset, staging, signal, (event) =>
          options.progress?.({
            ...event,
            transferredBytes: downloaded + event.transferredBytes,
            totalBytes: downloadBytes
          })
        )
      );
      downloaded += asset.archiveBytes;
    }
    return await withStoppedRuntime(paths, owner, async () => {
      await options.assertConfiguration?.();
      const { selected, cuda, policy } = plan();
      if (
        (selected?.id ?? null) !== before.previousId ||
        before.cuda?.recipeId !== cuda?.recipeId
      )
        throw new Error(
          "Another installer changed the selection. Inspect runtime status and retry."
        );
      for (const [asset, source] of staged) {
        const dest = payloadRoot(paths, asset);
        assertDirectoryChain(paths.koedHome, dest);
        if (!nativePathExists(dest)) {
          renameSync(source, dest);
          syncNativeDirectory(dirname(dest));
        }
      }
      const next = composeNativeSelection(paths, pin, staging, catalog, cuda);
      options.phase?.("verifying");
      await probeCore(next.root, signal, pin.target.platform);
      if (cuda) options.phase?.("inference");
      const validation = cuda
        ? await validateStagedCuda(paths, next.root, environment, {
            signal,
            requireModel: options.requireModel
          }).catch((error: unknown) => {
            if (signal.aborted) throw error;
            throw preservedCudaFailure(error, choice, policy);
          })
        : undefined;
      signal.throwIfAborted();
      options.phase?.("activating");
      signal.throwIfAborted();
      activateNativeSelection(paths, next.id);
      const warning = recordStatus(paths, next.id);
      const dropped = choice === "preserve" && selected?.cuda && !cuda;
      const message = dropped
        ? `CPU runtime selected. The prior CUDA add-on is incompatible; run ${releaseInstallCommand} --with-cuda for a compatible pair. Run koed start when ready.`
        : `${cuda ? "CPU core and CUDA add-on" : pin.target.platform === "macos" ? "Metal runtime" : "CPU runtime"} installed. Run koed start when ready.`;
      return {
        ok: true,
        provider: "release",
        state: "installed",
        changed: true,
        selectionId: next.id,
        coreId: pin.recipeId,
        cudaId: cuda?.recipeId ?? null,
        executionPolicy: policy,
        validation,
        downloadedBytes: downloadBytes,
        expandedBytes: assets.reduce((n, a) => n + a.expandedBytes, 0),
        requiredFreeBytes: required,
        warning,
        message: warning ?? message
      };
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function assertPostgresDataVersion(
  paths: KoedServerPaths,
  major: number
): void {
  const file = resolve(paths.postgresDataDir, "PG_VERSION");
  if (
    nativePathExists(file) &&
    readNativeMetadata(file, 32).toString("utf8").trim() !== String(major)
  ) {
    throw new Error(
      "Postgres data requires another major version. Database upgrades are outside runtime installation."
    );
  }
}

export function resolveSelectedCoreForStart(
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  useSelectedLlama = true
): string | undefined {
  try {
    const id = currentNativeId(paths);
    if (!id) {
      // A dangling fixed entry link indicates an interrupted first install.
      for (const name of ["postgres", "llama.cpp"]) {
        const entry = resolve(paths.koedHome, "runtime", name);
        if (
          lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink() &&
          readlinkSync(entry) === `native/current/${name}`
        )
          throw new Error("Incomplete native selection.");
      }
      return undefined;
    }
    assertReleaseHost();
    const catalog = getNativeRuntimeCatalog(),
      selected = readNativeSelection(paths, catalog)!;
    assertStartableCore(selected.pin, catalog);
    const policy = useSelectedLlama
      ? embeddingPolicy(paths, environment)
      : null;
    if (policy) assertMacPolicy(catalog.core.target.platform, policy);
    if (useSelectedLlama && policy === "cuda" && !selected.cuda)
      throw new Error(
        "The forced CUDA policy requires a selected CUDA add-on."
      );
    return selected.root;
  } catch (cause) {
    if (
      cause instanceof MacCudaPolicyError ||
      cause instanceof NativeSelectionTargetError
    )
      throw cause;
    const command =
      environment.KOED_EMBEDDING_ACCELERATION?.trim().toLowerCase() === "cuda"
        ? releaseInstallCommand + " --with-cuda"
        : releaseInstallCommand;
    throw new Error(
      `Cannot start the release-managed native runtime: ${cause instanceof Error ? cause.message : String(cause)}. Stop Koed, inspect runtime status, and run ${command}.`,
      { cause }
    );
  }
}

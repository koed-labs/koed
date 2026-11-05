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
  releaseInstallCommand
} from "./native-selection.js";
import {
  assertDirectoryChain,
  withStoppedRuntime
} from "./generation-lifecycle.js";
import {
  chooseCuda,
  embeddingPolicy,
  stageNativeAsset,
  type CudaAssetChoice
} from "./runtime-release-assets.js";
import {
  checkCudaHost,
  validateStagedCuda
} from "./runtime-release-validation.js";
import type { KoedServerPaths } from "./paths.js";

const reserve = 128 * 1024 * 1024;
export function assertReleaseHost(): void {
  const report = process.report.getReport() as {
    header?: { glibcVersionRuntime?: string };
  };
  const libc = report.header?.glibcVersionRuntime ?? "";
  const [major, minor] = libc.split(".").map(Number);
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
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
      message: `Install the CPU runtime with ${releaseInstallCommand}.`
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
          : "The selected CPU runtime is installed."
  };
}

// Run short, foreground version probes from the composed selection. No probe opens
// a port or database. Wait for close even when cancellation kills its process group.
async function probeCore(root: string, signal: AbortSignal): Promise<void> {
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
          KOED_LLAMA_SERVER_BACKEND: "cpu"
        }
      });
    } catch (error) {
      throw new Error(
        `Staged native probe failed: ${binary}. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
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
  } = {}
) {
  assertReleaseHost();
  const catalog = getNativeRuntimeCatalog(),
    pin = catalog.core,
    store = nativeStore(paths),
    owner = resolveKoedRuntimeOwner();
  const choice = options.cuda ?? "preserve",
    environment = options.environment ?? process.env;
  // No whole-install deadline: a large CUDA download on a slow link is legitimate.
  // Downloads fail after 30 s without data, probes and GPU validation keep their own
  // budgets, and the Operator's signal cancels everything else.
  const signal = options.signal ?? new AbortController().signal;
  const plan = () => {
    signal.throwIfAborted();
    const selected = readNativeSelection(paths, catalog);
    const policy = embeddingPolicy(paths, environment);
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
      const validation =
        choice === "with"
          ? await validateStagedCuda(paths, selected.root, environment, {
              signal
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
    if (choice === "with") await checkCudaHost(signal);
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
    for (const asset of missing)
      staged.set(
        asset,
        await stageNativeAsset(asset, staging, signal, options.progress)
      );
    return await withStoppedRuntime(paths, owner, async () => {
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
      await probeCore(next.root, signal);
      const validation = cuda
        ? await validateStagedCuda(paths, next.root, environment, { signal })
        : undefined;
      signal.throwIfAborted();
      activateNativeSelection(paths, next.id);
      const warning = recordStatus(paths, next.id);
      const dropped = choice === "preserve" && selected?.cuda && !cuda;
      const message = dropped
        ? `CPU runtime selected. The prior CUDA add-on is incompatible; run ${releaseInstallCommand} --with-cuda for a compatible pair. Run koed start when ready.`
        : `${cuda ? "CPU core and CUDA add-on" : "CPU runtime"} installed. Run koed start when ready.`;
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
    if (
      useSelectedLlama &&
      embeddingPolicy(paths, environment) === "cuda" &&
      !selected.cuda
    )
      throw new Error(
        "The forced CUDA policy requires a selected CUDA add-on."
      );
    return selected.root;
  } catch (cause) {
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

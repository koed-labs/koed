import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance
} from "vitest";
import { canonicalArtifactJson } from "./artifact-canonical-json.mjs";
import { nativeDigest } from "./native-payload-admission.js";
import {
  type NativeRuntimeCatalog,
  validateNativeRuntimeCatalog
} from "./native-runtime-catalog.js";
import {
  currentNativeId,
  nativeStore,
  readNativeSelection
} from "./native-selection.js";
import { resolveKoedServerPaths } from "./paths.js";
import { installReleaseRuntime } from "./runtime-release.js";
import { validateStagedCuda } from "./runtime-release-validation.js";
import { observeStoppedRuntime } from "./stopped-runtime.js";

const state = vi.hoisted(() => ({
  catalog: null as NativeRuntimeCatalog | null
}));
vi.mock("./native-runtime-catalog.js", async (original) => ({
  ...(await original<typeof import("./native-runtime-catalog.js")>()),
  getNativeRuntimeCatalog: () => {
    if (!state.catalog) throw new Error("No compiled native runtime catalog");
    return state.catalog;
  }
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, statfsSync: vi.fn(fs.statfsSync) };
});
vi.mock("./app-runtime.js", async (original) => ({
  ...(await original<typeof import("./app-runtime.js")>()),
  resolveKoedRuntimeOwner: () => ({ kind: "cli", installationId: "fixture" })
}));
vi.mock("./supervisor-lock.js", async (original) => ({
  ...(await original<typeof import("./supervisor-lock.js")>()),
  resolveProcessIdentity: () => "release-test-process"
}));
vi.mock("./stopped-runtime.js", async (original) => ({
  ...(await original<typeof import("./stopped-runtime.js")>()),
  observeStoppedRuntime: vi.fn()
}));
// Only host discovery and execution are substituted. Archive extraction, hashes,
// native admission, lifecycle locks and atomic selection use their real code.
vi.mock("./native-validation-process.js", () => ({
  nativeCommand: vi.fn(async () => "fixture version")
}));
vi.mock("./runtime-release-validation.js", () => ({
  checkCudaHost: vi.fn(async () => "595.91.07"),
  validateStagedCuda: vi.fn()
}));

const roots: string[] = [];
const archives = new Map<string, Buffer>();
let paths: ReturnType<typeof resolveKoedServerPaths>;
let fetcher: MockInstance<typeof fetch>;
const host = process;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(statfsSync).mockReturnValue({
    bavail: 1_000_000n,
    bsize: 4096n
  } as ReturnType<typeof statfsSync>);
  vi.stubGlobal(
    "process",
    new Proxy(host, {
      get: (target, key) =>
        key === "platform"
          ? "linux"
          : key === "arch"
            ? "x64"
            : (Reflect.get(target, key) as unknown)
    })
  );
  vi.spyOn(process.report, "getReport").mockReturnValue({
    header: { glibcVersionRuntime: "2.35" }
  } as ReturnType<typeof process.report.getReport>);
  vi.mocked(observeStoppedRuntime).mockReturnValue({
    state: "stopped",
    message: "Stopped"
  });
  vi.mocked(validateStagedCuda).mockResolvedValue({
    ok: true,
    scope: "inference",
    message: "Validated"
  } as Awaited<ReturnType<typeof validateStagedCuda>>);
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve(realpathSync("scratch"), "native-release-"));
  roots.push(root);
  paths = resolveKoedServerPaths({ KOED_HOME: resolve(root, "home") });
  mkdirSync(paths.koedHome, { mode: 0o700 });
  fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const bytes = archives.get(String(url));
    if (!bytes) throw new Error(`Unexpected archive URL: ${String(url)}`);
    return new Response(new Uint8Array(bytes));
  });
  state.catalog = candidate("1.0.0");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  archives.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function candidate(version: string): NativeRuntimeCatalog {
  const target = {
    platform: "linux",
    architecture: "x64",
    libc: { family: "glibc", minimumVersion: "2.35" }
  };
  const llamaCpp = { version: "b10514", revision: "a".repeat(40) };
  const pins = ["core", "cuda"].map((kind) => {
    const recipe = { kind, version },
      recipeId = nativeDigest(canonicalArtifactJson(recipe));
    const parent = resolve(dirname(paths.koedHome), `${kind}-${version}`);
    const root = resolve(parent, "koed-runtime");
    const names =
      kind === "core"
        ? [
            "llama.cpp",
            "llama.cpp/cpu",
            "llama.cpp/cpu/llama-server",
            "llama.cpp/llama-server",
            "postgres",
            "postgres/bin",
            "postgres/bin/postgres",
            "postgres/bin/psql"
          ]
        : ["llama.cpp", "llama.cpp/cuda", "llama.cpp/cuda/llama-server"];
    const data = Buffer.from("synthetic executable " + version);
    let expanded = 0;
    const inventory = names.map((path) => {
      const dest = resolve(root, path);
      if (
        !["llama-server", "postgres", "psql"].includes(
          path.split("/").at(-1)!
        ) ||
        path === "postgres"
      ) {
        mkdirSync(dest, { recursive: true, mode: 0o755 });
        return { path, type: "directory", mode: 0o755 };
      }
      writeFileSync(dest, data, { mode: 0o755 });
      expanded += data.length;
      return {
        path,
        type: "file",
        mode: 0o755,
        bytes: data.length,
        sha256: nativeDigest(data)
      };
    });
    const contracts =
      kind === "core"
        ? { layout: 1, postgres: 1, embedding: 1 }
        : { layout: 1, embedding: 1 };
    const details =
      kind === "core"
        ? {
            components: {
              postgres: { major: 17, version: "17.6" },
              pgvector: { version: "0.8.3" },
              llamaCpp
            }
          }
        : {
            llamaCpp,
            cuda: {
              toolkitVersion: "12.4",
              minimumDriverLinux: "550.54.14",
              architectures: [86]
            }
          };
    const manifest = Buffer.from(
      canonicalArtifactJson({
        schemaVersion: 1,
        kind,
        recipe,
        recipeId,
        runtimeVersion: version,
        target,
        contracts,
        ...details,
        inventory
      }) + "\n"
    );
    writeFileSync(
      resolve(
        root,
        kind === "core"
          ? "native-core-manifest.json"
          : "llama.cpp/cuda/native-cuda-manifest.json"
      ),
      manifest,
      { mode: 0o644 }
    );
    const archive = resolve(parent, "asset.tar.gz");
    execFileSync(
      "tar",
      ["--format=ustar", "-czf", archive, "-C", parent, "koed-runtime"],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } }
    );
    const bytes = readFileSync(archive);
    const url = `https://github.com/koed-labs/koed/releases/download/native-${kind}-${recipeId}/koed-native-${kind}-${recipeId}-linux-x64.tar.gz`;
    archives.set(url, bytes);
    return {
      recipeId,
      runtimeVersion: version,
      target,
      contracts,
      ...details,
      url,
      sha256: nativeDigest(bytes),
      manifestSha256: nativeDigest(manifest),
      archiveBytes: bytes.length,
      expandedBytes: expanded + manifest.length
    };
  });
  return validateNativeRuntimeCatalog({
    schemaVersion: 1,
    minimumCoreVersion: "1.0.0",
    core: pins[0],
    cuda: pins[1]
  });
}
const install = (options: Parameters<typeof installReleaseRuntime>[1] = {}) =>
  installReleaseRuntime(paths, {
    environment: { KOED_EMBEDDING_ACCELERATION: "cpu" },
    ...options
  });
const assertClean = (id: string | null) => {
  expect(currentNativeId(paths)).toBe(id);
  expect(
    readdirSync(nativeStore(paths)).filter((name) => name.startsWith(".stage-"))
  ).toEqual([]);
  expect(existsSync(resolve(paths.runDir, "generation-lifecycle.lock"))).toBe(
    false
  );
};

describe("native release installation and recovery", () => {
  it("installs CPU without CUDA consent, reuses it offline, and updates a compatible core", async () => {
    const first = await install();
    expect(first.cudaId).toBeNull();
    expect(validateStagedCuda).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    expect(await install()).toMatchObject({
      changed: false,
      selectionId: first.selectionId,
      downloadedBytes: 0
    });
    expect(fetcher).not.toHaveBeenCalled();
    state.catalog = candidate("1.1.0");
    expect(readNativeSelection(paths, state.catalog)?.id).toBe(
      first.selectionId
    );
    const updated = await install();
    expect(updated.selectionId).not.toBe(first.selectionId);
    expect(readNativeSelection(paths, state.catalog)?.pin.runtimeVersion).toBe(
      "1.1.0"
    );
    assertClean(updated.selectionId);
  });

  it("preserves a compatible installed CUDA add-on across a CPU core update without another add-on download", async () => {
    const first = await install({ cuda: "with", requireModel: true });
    const retained = state.catalog!.cuda!;
    // The catalog type also covers macOS, whose CUDA pin is always null.
    const updated = {
      ...candidate("1.1.0"),
      cuda: retained
    } as NativeRuntimeCatalog;
    state.catalog = updated;
    fetcher.mockClear();
    const next = await install();
    expect(next.cudaId).toBe(first.cudaId);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(updated.core.url);
    expect(readNativeSelection(paths, updated)?.cuda?.recipeId).toBe(
      retained.recipeId
    );
    assertClean(next.selectionId);
  });

  it("refuses insufficient disk before downloading and retains the prior core", async () => {
    const first = await install();
    vi.mocked(statfsSync).mockReturnValue({
      bavail: 0n,
      bsize: 4096n
    } as ReturnType<typeof statfsSync>);
    fetcher.mockClear();
    await expect(install({ cuda: "with", requireModel: true })).rejects.toThrow(
      "Insufficient free space"
    );
    expect(fetcher).not.toHaveBeenCalled();
    assertClean(first.selectionId);
  });

  it.each(["network", "digest"])(
    "retains the previous selection after a %s acquisition failure and permits retry",
    async (failure) => {
      const first = await install();
      if (failure === "network")
        fetcher.mockResolvedValueOnce(new Response("denied", { status: 403 }));
      else {
        const damaged = Buffer.from(archives.get(state.catalog!.cuda!.url)!);
        damaged[0] = damaged[0]! ^ 255;
        fetcher.mockResolvedValueOnce(new Response(new Uint8Array(damaged)));
      }
      await expect(
        install({ cuda: "with", requireModel: true })
      ).rejects.toThrow(failure === "network" ? "HTTP 403" : "digest mismatch");
      assertClean(first.selectionId);
      const retry = await install({ cuda: "with", requireModel: true });
      expect(retry.cudaId).toBe(state.catalog!.cuda!.recipeId);
      assertClean(retry.selectionId);
    }
  );

  it.each(["inference", "activation"])(
    "keeps CPU selected when cancelled during %s",
    async (phase) => {
      const first = await install();
      const abort = new AbortController();
      await expect(
        install({
          cuda: "with",
          requireModel: true,
          signal: abort.signal,
          phase: (value) => {
            if (value === (phase === "activation" ? "activating" : "inference"))
              abort.abort();
          }
        })
      ).rejects.toThrow();
      assertClean(first.selectionId);
      expect(readNativeSelection(paths, state.catalog!)?.cuda).toBeNull();
    }
  );

  it("does not activate a CUDA selection after inference fails and reuses the admitted bytes on retry", async () => {
    const first = await install();
    vi.mocked(validateStagedCuda).mockRejectedValueOnce(
      new Error("GPU inference failed")
    );
    await expect(install({ cuda: "with", requireModel: true })).rejects.toThrow(
      "GPU inference failed"
    );
    assertClean(first.selectionId);
    fetcher.mockClear();
    const retry = await install({ cuda: "with", requireModel: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(retry.cudaId).toBe(state.catalog!.cuda!.recipeId);
    assertClean(retry.selectionId);
  });

  it("rejects a concurrent runtime start before committing staged assets", async () => {
    const first = await install();
    vi.mocked(observeStoppedRuntime)
      .mockReturnValueOnce({ state: "stopped", message: "Stopped" })
      .mockReturnValueOnce({ state: "running", message: "Runtime started" });
    await expect(install({ cuda: "with", requireModel: true })).rejects.toThrow(
      "Run koed stop"
    );
    assertClean(first.selectionId);
  });

  it("rejects a missing compiled catalog without creating runtime state", async () => {
    state.catalog = null;
    await expect(install()).rejects.toThrow(
      "No compiled native runtime catalog"
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(nativeStore(paths))).toBe(false);
  });
  it("preserves a newer selection activated by another installer during acquisition", async () => {
    await install();
    const original = state.catalog!;
    let newerId: string | null = null;
    fetcher.mockImplementationOnce(async () => {
      state.catalog = candidate("1.1.0");
      newerId = (await install()).selectionId;
      state.catalog = original;
      return new Response(new Uint8Array(archives.get(original.cuda!.url)!));
    });
    await expect(install({ cuda: "with", requireModel: true })).rejects.toThrow(
      /downgrade|changed the selection/
    );
    expect(newerId).not.toBeNull();
    assertClean(newerId);
    expect(validateStagedCuda).not.toHaveBeenCalled();
  });
});

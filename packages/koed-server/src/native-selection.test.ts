import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalArtifactJson } from "./artifact-canonical-json.mjs";
import { nativeDigest } from "./native-payload-admission.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  selectNativeRuntimeCatalog,
  validateNativeRuntimeCatalog
} from "./native-runtime-catalog.js";
import {
  activateNativeSelection,
  assertStartableCore,
  composeNativeSelection,
  coreStartBlocker,
  currentNativeId,
  nativeStore,
  readNativeSelection
} from "./native-selection.js";
import * as filesystem from "./generation-lifecycle-filesystem.js";
import { chooseCuda, preservedCudaFailure } from "./runtime-release-assets.js";
import * as catalogModule from "./native-runtime-catalog.js";
import * as download from "./bounded-download.js";
import * as supervisor from "./supervisor-lock.js";
import {
  installReleaseRuntime,
  resolveSelectedCoreForStart
} from "./runtime-release.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  release: () => "23.0.0"
}));

const homes: string[] = [];
it("retains an admitted add-on without a new pin, but only a compatible core may reuse it", () => {
  const { catalog } = candidate(home(), "1.0.0");
  const recipeId = "b".repeat(64);
  const cuda = validateNativeRuntimeCatalog({
    ...catalog,
    cuda: {
      recipeId,
      runtimeVersion: "1.0.0",
      target: catalog.core.target,
      contracts: { layout: 1, embedding: 1 },
      llamaCpp: catalog.core.components.llamaCpp,
      cuda: {
        toolkitVersion: "12.4",
        minimumDriverLinux: "550.54.14",
        architectures: [89]
      },
      url: `https://github.com/koed-labs/koed/releases/download/native-cuda-${recipeId}/koed-native-cuda-${recipeId}-linux-x64.tar.gz`,
      sha256: "c".repeat(64),
      manifestSha256: "d".repeat(64),
      archiveBytes: 1,
      expandedBytes: 1
    }
  }).cuda!;
  expect(chooseCuda(catalog, cuda, "preserve", "cuda")).toEqual(cuda);
  expect(() => chooseCuda(catalog, cuda, "with", "auto")).toThrow(
    /no reviewed CUDA/
  );
  const changed = {
    ...cuda,
    llamaCpp: { ...cuda.llamaCpp, revision: "e".repeat(40) }
  };
  expect(() => chooseCuda(catalog, changed, "preserve", "cuda")).toThrow(
    /--with-cuda/
  );
  expect(chooseCuda(catalog, changed, "preserve", "auto")).toBeNull();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function home() {
  const path = mkdtempSync(
    resolve(realpathSync(tmpdir()), "koed-native-selection-")
  );
  homes.push(path);
  return resolveKoedServerPaths({ KOED_HOME: path });
}
function candidate(
  paths: ReturnType<typeof home>,
  version: string,
  mac = false
) {
  const recipe = { build: version },
    recipeId = nativeDigest(canonicalArtifactJson(recipe));
  const store = nativeStore(paths),
    root = resolve(store, "core", recipeId);
  const target = {
    platform: "linux",
    architecture: "x64",
    libc: { family: "glibc", minimumVersion: "2.35" }
  };
  const contracts = { layout: 1, postgres: 1, embedding: 1 };
  const components = {
    postgres: { major: 17, version: "17.6" },
    pgvector: { version: "0.8.3" },
    llamaCpp: { version: "b10514", revision: "a".repeat(40) }
  };
  const pathsInOrder = [
    "llama.cpp",
    `llama.cpp/${mac ? "metal" : "cpu"}`,
    `llama.cpp/${mac ? "metal" : "cpu"}/llama-server`,
    "llama.cpp/llama-server",
    "postgres",
    ...(mac
      ? [
          "postgres/bin",
          ...[
            "postgres",
            "initdb",
            "pg_ctl",
            "psql",
            "pg_dump",
            "pg_restore"
          ].map((name) => `postgres/bin/${name}`),
          "postgres/lib",
          "postgres/lib/vector.so",
          "postgres/lib/pgcrypto.so"
        ]
      : [])
  ].sort();
  const data = Buffer.from(version);
  const macho = Buffer.alloc(16);
  macho.writeUInt32LE(0xfeedfacf, 0);
  macho.writeUInt32LE(0x0100000c, 4);
  macho.writeUInt32LE(2, 12);
  const dylib = Buffer.from(macho);
  dylib.writeUInt32LE(6, 12);
  const inventory = pathsInOrder.map((path) => {
    const dest = resolve(root, path);
    if (
      [
        "llama.cpp",
        "llama.cpp/cpu",
        "llama.cpp/metal",
        "postgres",
        "postgres/bin",
        "postgres/lib"
      ].includes(path)
    ) {
      mkdirSync(dest, { recursive: true, mode: 0o755 });
      return { path, type: "directory", mode: 0o755 };
    }
    const content = mac
      ? path === "llama.cpp/llama-server"
        ? Buffer.from("#!/bin/sh\n")
        : path.endsWith(".so")
          ? dylib
          : macho
      : data;
    const mode = path.endsWith(".so") ? 0o644 : 0o755;
    writeFileSync(dest, content, { mode });
    return {
      path,
      type: "file",
      mode,
      bytes: content.length,
      sha256: nativeDigest(content)
    };
  });
  const selectedTarget = mac
    ? { platform: "macos", architecture: "arm64", minimumVersion: "14.0" }
    : target;
  const selectedComponents = mac
    ? { ...components, llamaCpp: { version: "b10514" } }
    : components;
  const bytes = Buffer.from(
    canonicalArtifactJson({
      schemaVersion: 1,
      kind: "core",
      recipe,
      recipeId,
      runtimeVersion: version,
      target: selectedTarget,
      contracts,
      components: selectedComponents,
      inventory
    }) + "\n"
  );
  writeFileSync(resolve(root, "native-core-manifest.json"), bytes, {
    mode: 0o644
  });
  const rawCatalog = {
    schemaVersion: 1,
    minimumCoreVersion: "1.0.0",
    cuda: null,
    core: {
      recipeId,
      runtimeVersion: version,
      target: selectedTarget,
      contracts,
      components: selectedComponents,
      url: `https://github.com/koed-labs/koed/releases/download/native-core-${recipeId}/koed-native-core-${recipeId}-${mac ? "macos-arm64" : "linux-x64"}.tar.gz`,
      sha256: "d".repeat(64),
      archiveBytes: 123,
      manifestSha256: nativeDigest(bytes),
      expandedBytes:
        bytes.length +
        inventory.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
    }
  };
  const catalog = mac
    ? selectNativeRuntimeCatalog(
        { schemaVersion: 2, linux: null, macos: rawCatalog },
        "darwin",
        "arm64"
      )
    : validateNativeRuntimeCatalog(rawCatalog);
  mkdirSync(resolve(store, "selections"), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(resolve(store, ".stage-"));
  const selection = composeNativeSelection(paths, catalog.core, stage, catalog);
  return { catalog, selection, root };
}

it("admits a Metal selection and rejects it against a Linux catalog", () => {
  const paths = home();
  const { catalog, selection } = candidate(paths, "1.0.0", true);
  activateNativeSelection(paths, selection.id);
  expect(readlinkSync(resolve(selection.root, "llama.cpp/metal"))).toContain(
    "llama.cpp/metal"
  );
  expect(readNativeSelection(paths, catalog)?.id).toBe(selection.id);
  const linux = candidate(home(), "1.0.0").catalog;
  expect(() => readNativeSelection(paths, linux)).toThrow(
    /target.*preserve.*fresh.*KOED_HOME/i
  );
  const other = home();
  const linuxSelection = candidate(other, "1.0.0");
  activateNativeSelection(other, linuxSelection.selection.id);
  expect(() => readNativeSelection(other, catalog)).toThrow(
    /target.*preserve.*fresh.*KOED_HOME/i
  );
});

it("preserves cross-target selections and refuses installation or startup before download", async () => {
  const macHome = home(),
    linuxHome = home();
  const mac = candidate(macHome, "1.0.0", true),
    linux = candidate(linuxHome, "1.0.0");
  activateNativeSelection(macHome, mac.selection.id);
  activateNativeSelection(linuxHome, linux.selection.id);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
  const pin = vi.spyOn(catalogModule, "getNativeRuntimeCatalog");
  const fetch = vi.spyOn(download, "fetchBounded");
  vi.spyOn(supervisor, "resolveProcessIdentity").mockReturnValue(
    "test-identity"
  );
  vi.spyOn(process.report, "getReport").mockReturnValue({
    header: { glibcVersionRuntime: "2.35" }
  } as unknown as NodeJS.ProcessReport);
  try {
    for (const [system, architecture, paths, target] of [
      ["darwin", "arm64", linuxHome, mac.catalog],
      ["linux", "x64", macHome, linux.catalog]
    ] as const) {
      Object.defineProperty(process, "platform", {
        value: system,
        configurable: true
      });
      Object.defineProperty(process, "arch", {
        value: architecture,
        configurable: true
      });
      pin.mockReturnValue(target);
      await expect(
        installReleaseRuntime(paths, {
          environment: { KOED_EMBEDDING_ACCELERATION: "auto" }
        })
      ).rejects.toThrow(/target.*preserve.*fresh.*KOED_HOME/i);
      expect(() =>
        resolveSelectedCoreForStart(paths, {
          KOED_EMBEDDING_ACCELERATION: "auto"
        })
      ).toThrow(/target.*preserve.*fresh.*KOED_HOME/i);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(currentNativeId(macHome)).toBe(mac.selection.id);
    expect(currentNativeId(linuxHome)).toBe(linux.selection.id);
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
  }
});

it("reuses the same archive from a later product release and rejects a changed digest", () => {
  const paths = home();
  const { catalog, selection } = candidate(paths, "1.0.0");
  activateNativeSelection(paths, selection.id);
  const current = validateNativeRuntimeCatalog({
    ...catalog,
    core: {
      ...catalog.core,
      url: catalog.core.url.replace(
        `/native-core-${catalog.core.recipeId}/`,
        "/v2.0.0/"
      )
    }
  });
  expect(readNativeSelection(paths, current)?.id).toBe(selection.id);
  current.core.sha256 = "f".repeat(64);
  expect(() => readNativeSelection(paths, current)).toThrow(
    /conflicts with the reviewed identity/
  );
});

it("keeps the previous complete selection on swap failure and verifies either selection independently of cache", () => {
  const paths = home(),
    first = candidate(paths, "1.0.0"),
    second = candidate(paths, "1.0.1");
  activateNativeSelection(paths, first.selection.id);
  vi.spyOn(filesystem, "renameAtomically").mockImplementationOnce(() => {
    throw new Error("swap failed");
  });
  expect(() => activateNativeSelection(paths, second.selection.id)).toThrow(
    "swap failed"
  );
  expect(readNativeSelection(paths, second.catalog)?.id).toBe(
    first.selection.id
  );
  expect(() =>
    assertStartableCore(first.catalog.core, {
      ...second.catalog,
      minimumCoreVersion: "1.0.1"
    })
  ).toThrow(/runtime install --provider release/);
  activateNativeSelection(paths, second.selection.id);
  mkdirSync(paths.cacheDir, { recursive: true });
  writeFileSync(resolve(paths.cacheDir, "runtime-release.json"), "broken");
  expect(readNativeSelection(paths, second.catalog)?.id).toBe(
    second.selection.id
  );
  expect(
    realpathSync(resolve(paths.koedHome, "runtime/llama.cpp/llama-server"))
  ).toBe(resolve(second.root, "llama.cpp/llama-server"));
  expect(
    realpathSync(resolve(first.selection.root, "llama.cpp/llama-server"))
  ).toBe(resolve(first.root, "llama.cpp/llama-server"));
});

it("starts an older core with the same contracts and refuses a contract change or a raised minimum", () => {
  const paths = home(),
    older = candidate(paths, "1.0.0"),
    newer = candidate(paths, "1.2.0");
  expect(coreStartBlocker(older.catalog.core, newer.catalog)).toBeNull();
  expect(() =>
    assertStartableCore(older.catalog.core, newer.catalog)
  ).not.toThrow();
  const changed = {
    ...newer.catalog,
    core: {
      ...newer.catalog.core,
      contracts: { ...newer.catalog.core.contracts, layout: 2 }
    }
  } as unknown as typeof newer.catalog;
  expect(coreStartBlocker(older.catalog.core, changed)).toMatch(
    /this Control Plane requires/
  );
  expect(() =>
    assertStartableCore(older.catalog.core, {
      ...newer.catalog,
      minimumCoreVersion: "1.1.0"
    })
  ).toThrow(/below the required 1\.1\.0/);
});

it("refuses changed payload bytes and unrecognized fixed entry links", () => {
  const paths = home(),
    c = candidate(paths, "1.0.0");
  activateNativeSelection(paths, c.selection.id);
  const launcher = resolve(c.root, "llama.cpp/llama-server");
  writeFileSync(launcher, "1.0.2");
  expect(() => readNativeSelection(paths, c.catalog)).toThrow(
    /inventory changed/
  );
  const entry = resolve(paths.koedHome, "runtime/postgres");
  rmSync(entry);
  symlinkSync("/tmp", entry);
  expect(() => readNativeSelection(paths, c.catalog)).toThrow(
    /Unrecognized native entry/
  );
  expect(readlinkSync(entry)).toBe("/tmp");
  expect(currentNativeId(paths)).toBe(c.selection.id);
});

it("refuses foreign provider metadata and escaping or dangling selection pointers", () => {
  const paths = home(),
    c = candidate(paths, "1.0.0"),
    pointer = resolve(nativeStore(paths), "current");
  mkdirSync(paths.cacheDir, { recursive: true });
  writeFileSync(resolve(paths.cacheDir, "runtime-homebrew.json"), "{}");
  expect(() => readNativeSelection(paths, c.catalog)).toThrow(
    /existing native provider/
  );
  rmSync(resolve(paths.cacheDir, "runtime-homebrew.json"));
  symlinkSync("../other", pointer);
  expect(() => currentNativeId(paths)).toThrow(/Invalid native selection/);
  rmSync(pointer);
  symlinkSync(`selections/${"f".repeat(64)}`, pointer);
  expect(() => readNativeSelection(paths, c.catalog)).toThrow();
});

it("suggests the CPU-only update only when a preserved CUDA check fails under auto or cpu policy", () => {
  const failure = () => new Error("CUDA device discovery failed.");
  expect(
    (preservedCudaFailure(failure(), "preserve", "auto") as Error).message
  ).toMatch(/--without-cuda\.$/);
  expect(
    (preservedCudaFailure(failure(), "preserve", "cuda") as Error).message
  ).toBe("CUDA device discovery failed.");
  expect(
    (preservedCudaFailure(failure(), "with", "auto") as Error).message
  ).toBe("CUDA device discovery failed.");
});

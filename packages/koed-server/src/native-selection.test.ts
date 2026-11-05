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
import { validateNativeRuntimeCatalog } from "./native-runtime-catalog.js";
import {
  activateNativeSelection,
  assertStartableCore,
  composeNativeSelection,
  currentNativeId,
  nativeStore,
  readNativeSelection
} from "./native-selection.js";
import * as filesystem from "./generation-lifecycle-filesystem.js";
import { chooseCuda } from "./runtime-release-assets.js";

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
function candidate(paths: ReturnType<typeof home>, version: string) {
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
    "llama.cpp/cpu",
    "llama.cpp/cpu/llama-server",
    "llama.cpp/llama-server",
    "postgres"
  ];
  const data = Buffer.from(version);
  const inventory = pathsInOrder.map((path) => {
    const dest = resolve(root, path);
    if (!path.endsWith("server")) {
      mkdirSync(dest, { recursive: true, mode: 0o755 });
      return { path, type: "directory", mode: 0o755 };
    }
    writeFileSync(dest, data, { mode: 0o755 });
    return {
      path,
      type: "file",
      mode: 0o755,
      bytes: data.length,
      sha256: nativeDigest(data)
    };
  });
  const bytes = Buffer.from(
    canonicalArtifactJson({
      schemaVersion: 1,
      kind: "core",
      recipe,
      recipeId,
      runtimeVersion: version,
      target,
      contracts,
      components,
      inventory
    }) + "\n"
  );
  writeFileSync(resolve(root, "native-core-manifest.json"), bytes, {
    mode: 0o644
  });
  const catalog = validateNativeRuntimeCatalog({
    schemaVersion: 1,
    minimumCoreVersion: "1.0.0",
    cuda: null,
    core: {
      recipeId,
      runtimeVersion: version,
      target,
      contracts,
      components,
      url: `https://github.com/koed-labs/koed/releases/download/native-core-${recipeId}/koed-native-core-${recipeId}-linux-x64.tar.gz`,
      sha256: "d".repeat(64),
      archiveBytes: 123,
      manifestSha256: nativeDigest(bytes),
      expandedBytes: bytes.length + data.length * 2
    }
  });
  mkdirSync(resolve(store, "selections"), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(resolve(store, ".stage-"));
  const selection = composeNativeSelection(paths, catalog.core, stage, catalog);
  return { catalog, selection, root };
}

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

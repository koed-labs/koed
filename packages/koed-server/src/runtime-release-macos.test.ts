import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalArtifactJson } from "./artifact-canonical-json.mjs";
import * as download from "./bounded-download.js";
import {
  nativeDigest,
  verifyNativePayload
} from "./native-payload-admission.js";
import * as catalogModule from "./native-runtime-catalog.js";
import { currentNativeId } from "./native-selection.js";
import * as command from "./native-validation-process.js";
import * as assets from "./runtime-release-assets.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  installReleaseRuntime,
  resolveSelectedCoreForStart
} from "./runtime-release.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  release: () => "23.0.0"
}));

let temp: string;
let platform: PropertyDescriptor;
let arch: PropertyDescriptor;
beforeEach(() => {
  temp = mkdtempSync(resolve(realpathSync(tmpdir()), "koed-mac-release-"));
  platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  arch = Object.getOwnPropertyDescriptor(process, "arch")!;
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true
  });
  Object.defineProperty(process, "arch", {
    value: "arm64",
    configurable: true
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "arch", arch);
  vi.restoreAllMocks();
  rmSync(temp, { recursive: true, force: true });
});

function fixture(
  version: string,
  options: {
    omit?: string;
    extraDir?: string;
    nonExecutable?: string;
    extraFiles?: Record<string, Buffer>;
  } = {}
) {
  const source = resolve(temp, `source-${version}`),
    root = resolve(source, "koed-runtime");
  const macho = Buffer.alloc(16);
  macho.writeUInt32LE(0xfeedfacf, 0);
  macho.writeUInt32LE(0x0100000c, 4);
  macho.writeUInt32LE(2, 12);
  const dylib = Buffer.from(macho);
  dylib.writeUInt32LE(6, 12);
  const files: Record<string, Buffer> = {
    ...Object.fromEntries(
      ["postgres", "initdb", "pg_ctl", "psql", "pg_dump", "pg_restore"].map(
        (name) => [`postgres/bin/${name}`, macho]
      )
    ),
    "postgres/lib/vector.so": dylib,
    "postgres/lib/pgcrypto.so": dylib,
    "llama.cpp/metal/llama-server": macho,
    "llama.cpp/llama-server": Buffer.from("#!/bin/sh\n"),
    ...options.extraFiles
  };
  if (options.omit) delete files[options.omit];
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(root, name);
    mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(path, content, {
      mode:
        name === options.nonExecutable || name in (options.extraFiles ?? {})
          ? 0o644
          : 0o755
    });
  }
  if (options.extraDir)
    mkdirSync(resolve(root, options.extraDir), {
      recursive: true,
      mode: 0o755
    });
  const inventory: Record<string, unknown>[] = [];
  function walk(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name),
        key = relative(root, path),
        stat = lstatSync(path);
      if (stat.isDirectory()) {
        inventory.push({
          path: key,
          type: "directory",
          mode: stat.mode & 0o777
        });
        walk(path);
      } else {
        const bytes = readFileSync(path);
        inventory.push({
          path: key,
          type: "file",
          mode: stat.mode & 0o777,
          bytes: bytes.length,
          sha256: nativeDigest(bytes)
        });
      }
    }
  }
  walk(root);
  const recipe = { version },
    recipeId = nativeDigest(canonicalArtifactJson(recipe));
  const target = {
    platform: "macos",
    architecture: "arm64",
    minimumVersion: "14.0"
  };
  const contracts = { layout: 1, postgres: 1, embedding: 1 };
  const components = {
    postgres: { major: 17, version: "17.6" },
    pgvector: { version: "0.8.3" },
    llamaCpp: { version: "b10514" }
  };
  const manifest = Buffer.from(
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
  writeFileSync(resolve(root, "native-core-manifest.json"), manifest, {
    mode: 0o644
  });
  const archive = resolve(temp, `core-${version}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", source, "koed-runtime"]);
  const bytes = readFileSync(archive);
  const core = {
    recipeId,
    runtimeVersion: version,
    target,
    contracts,
    components,
    url: `https://github.com/koed-labs/koed/releases/download/native-core-${recipeId}/koed-native-core-${recipeId}-macos-arm64.tar.gz`,
    sha256: nativeDigest(bytes),
    archiveBytes: statSync(archive).size,
    manifestSha256: nativeDigest(manifest),
    expandedBytes:
      manifest.length +
      Object.values(files).reduce((n, value) => n + value.length, 0)
  };
  const catalog = catalogModule.selectNativeRuntimeCatalog(
    {
      schemaVersion: 2,
      linux: null,
      macos: { schemaVersion: 1, minimumCoreVersion: "1.0.0", core, cuda: null }
    },
    "darwin",
    "arm64"
  );
  return { archive, catalog, root };
}

describe("synthetic macOS release lifecycle", () => {
  it("rejects invalid directories during staging and admits the resulting valid staged archive", async () => {
    const { root } = fixture("1.0.0");
    rmSync(resolve(root, "native-core-manifest.json"));
    for (const path of [
      "llama.cpp/metal/LICENSE",
      "third-party-licenses/openssl/LICENSE.txt",
      "third-party-licenses/postgres/COPYRIGHT",
      "third-party-licenses/pgvector/LICENSE"
    ]) {
      const file = resolve(root, path);
      mkdirSync(resolve(file, ".."), { recursive: true });
      writeFileSync(file, "license", { mode: 0o644 });
    }
    const repo = resolve(import.meta.dirname, "../../..");
    const manifestLib = resolve(
      repo,
      "scripts/native-runtime/manifest-lib.mjs"
    );
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      "import {pathToFileURL} from 'node:url'; const m = await import(pathToFileURL(process.argv[1])); m.writeRuntimeAssetManifest({runtimeRoot:process.argv[2],platform:'macos',architecture:'arm64'});",
      manifestLib,
      root
    ]);
    const sources = JSON.parse(
      readFileSync(
        resolve(repo, "scripts/native-runtime/sources.macos-arm64.json"),
        "utf8"
      )
    );
    writeFileSync(
      resolve(root, "provenance.json"),
      JSON.stringify({
        schemaVersion: 1,
        artifact: {
          platform: "macos",
          architecture: "arm64",
          version: "1.2.3"
        },
        source: { kind: "pinned-sources", manifest: sources }
      })
    );
    const script = resolve(repo, "scripts/native-runtime/stage-macos-core.mjs");
    const inspect = () =>
      spawnSync(
        process.execPath,
        [script, "--source-dir", root, "--inspect-inventory"],
        { cwd: repo, encoding: "utf8" }
      );
    for (const name of ["postgres/share/unrelated", "llama.cpp/metal/nested"]) {
      const path = resolve(root, name);
      mkdirSync(path, { recursive: true });
      const rejected = inspect();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toMatch(/unexpected.*directory/i);
      rmSync(path, { recursive: true });
      if (name.startsWith("postgres/share/"))
        rmSync(resolve(root, "postgres/share"), { recursive: true });
    }
    const inspected = inspect();
    expect(inspected.status).toBe(0);
    const out = resolve(temp, "staged");
    const staged = spawnSync(
      process.execPath,
      [
        script,
        "--source-dir",
        root,
        "--out-dir",
        out,
        "--version",
        "1.2.3",
        "--approved-inventory-sha256",
        inspected.stdout.trim()
      ],
      { cwd: repo, encoding: "utf8" }
    );
    expect(staged.status, staged.stderr).toBe(0);
    const report = JSON.parse(staged.stdout);
    const core = {
      recipeId: report.recipeId,
      runtimeVersion: report.runtimeVersion,
      target: report.target,
      contracts: report.contracts,
      components: report.components,
      url: `https://github.com/koed-labs/koed/releases/download/native-core-${report.recipeId}/${report.archive}`,
      sha256: report.sha256,
      archiveBytes: report.archiveBytes,
      manifestSha256: report.manifestSha256,
      expandedBytes: report.expandedBytes
    };
    const catalog = catalogModule.selectNativeRuntimeCatalog(
      {
        schemaVersion: 2,
        linux: null,
        macos: {
          schemaVersion: 1,
          minimumCoreVersion: "1.0.0",
          core,
          cuda: null
        }
      },
      "darwin",
      "arm64"
    );
    vi.spyOn(catalogModule, "getNativeRuntimeCatalog").mockReturnValue(catalog);
    vi.spyOn(download, "fetchBounded").mockImplementation(
      async (_url, destination) => {
        copyFileSync(resolve(out, report.archive), destination);
      }
    );
    vi.spyOn(command, "nativeCommand").mockResolvedValue("MTL0: synthetic GPU");
    const paths = resolveKoedServerPaths({ KOED_HOME: resolve(temp, "home") });
    const result = await installReleaseRuntime(paths, {
      environment: { KOED_EMBEDDING_ACCELERATION: "auto" }
    });
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      coreId: report.recipeId
    });
  });
  it.each([
    "postgres/bin/postgres",
    "postgres/bin/initdb",
    "postgres/bin/pg_ctl",
    "postgres/bin/psql",
    "postgres/bin/pg_dump",
    "postgres/bin/pg_restore",
    "postgres/lib/vector.so",
    "postgres/lib/pgcrypto.so",
    "llama.cpp/llama-server",
    "llama.cpp/metal/llama-server"
  ])("rejects pinned archive missing %s before activation", async (omit) => {
    const { archive, catalog, root } = fixture("1.0.0", { omit });
    expect(() => verifyNativePayload(root, catalog.core)).toThrow(
      /missing required/i
    );
    vi.spyOn(catalogModule, "getNativeRuntimeCatalog").mockReturnValue(catalog);
    vi.spyOn(download, "fetchBounded").mockImplementation(
      async (_url, dest) => {
        copyFileSync(archive, dest);
      }
    );
    const probe = vi
      .spyOn(command, "nativeCommand")
      .mockResolvedValue("MTL0: Apple GPU");
    const paths = resolveKoedServerPaths({ KOED_HOME: resolve(temp, "home") });
    await expect(
      installReleaseRuntime(paths, {
        environment: { KOED_EMBEDDING_ACCELERATION: "auto" }
      })
    ).rejects.toThrow(/missing required/i);
    expect(currentNativeId(paths)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
  it("retains directories that contain permitted nested data and licenses", () => {
    const { root, catalog } = fixture("1.0.0", {
      extraFiles: {
        "postgres/share/postgresql/timezone/Europe/London": Buffer.from("TZif"),
        "third-party-licenses/postgres/source/LICENSE": Buffer.from("license")
      }
    });
    expect(() => verifyNativePayload(root, catalog.core)).not.toThrow();
  });
  it("rejects a nonexecutable required PostgreSQL tool", () => {
    const { root, catalog } = fixture("1.0.0", {
      nonExecutable: "postgres/bin/initdb"
    });
    expect(() => verifyNativePayload(root, catalog.core)).toThrow(
      /missing required.*initdb/i
    );
  });
  it.each([
    "postgres/bin/unrelated",
    "postgres/share/unexpected",
    "llama.cpp/metal/unrelated",
    "third-party-licenses/unrelated/deep"
  ])(
    "rejects pinned archive and retained inventory with unrelated directory %s",
    async (extraDir) => {
      const { archive, catalog, root } = fixture("1.0.0", { extraDir });
      expect(() => verifyNativePayload(root, catalog.core)).toThrow(
        /unexpected native/i
      );
      vi.spyOn(catalogModule, "getNativeRuntimeCatalog").mockReturnValue(
        catalog
      );
      vi.spyOn(download, "fetchBounded").mockImplementation(
        async (_url, dest) => {
          copyFileSync(archive, dest);
        }
      );
      const probe = vi
        .spyOn(command, "nativeCommand")
        .mockResolvedValue("MTL0: Apple GPU");
      const paths = resolveKoedServerPaths({
        KOED_HOME: resolve(temp, "home")
      });
      await expect(
        installReleaseRuntime(paths, {
          environment: { KOED_EMBEDDING_ACCELERATION: "auto" }
        })
      ).rejects.toThrow(/unexpected native|unsafe native/i);
      expect(currentNativeId(paths)).toBeNull();
      expect(probe).not.toHaveBeenCalled();
    }
  );
  it("acquires authenticated archive, admits, probes Metal, activates and reuses selection", async () => {
    const { archive, catalog } = fixture("1.0.0");
    vi.spyOn(catalogModule, "getNativeRuntimeCatalog").mockReturnValue(catalog);
    const fetch = vi
      .spyOn(download, "fetchBounded")
      .mockImplementation(async (_url, dest) => {
        copyFileSync(archive, dest);
      });
    const probe = vi
      .spyOn(command, "nativeCommand")
      .mockImplementation(async (_binary, args) =>
        args[0] === "--list-devices"
          ? "Available devices:\n  MTL0: Apple GPU\n"
          : "version"
      );
    const paths = resolveKoedServerPaths({ KOED_HOME: resolve(temp, "home") });
    const result = await installReleaseRuntime(paths, {
      environment: { KOED_EMBEDDING_ACCELERATION: "auto" }
    });
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      coreId: catalog.core.recipeId
    });
    expect(currentNativeId(paths)).toBe(result.selectionId);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(probe).toHaveBeenCalledWith(
      expect.stringMatching(/llama-server$/),
      ["--list-devices"],
      expect.objectContaining({
        env: expect.objectContaining({
          KOED_LLAMA_SERVER_BACKEND: "metal",
          LLAMA_ARG_UI: "false"
        })
      })
    );
    expect(
      probe.mock.calls.every(
        ([, , context]) => context.env.KOED_LLAMA_SERVER_BACKEND === "metal"
      )
    ).toBe(true);
    const again = await installReleaseRuntime(paths, {
      environment: { KOED_EMBEDDING_ACCELERATION: "auto" }
    });
    expect(again.changed).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not activate when Metal discovery fails or lists no Metal device", async () => {
    const { archive, catalog } = fixture("1.0.0");
    vi.spyOn(catalogModule, "getNativeRuntimeCatalog").mockReturnValue(catalog);
    vi.spyOn(download, "fetchBounded").mockImplementation(
      async (_url, dest) => {
        copyFileSync(archive, dest);
      }
    );
    const probe = vi
      .spyOn(command, "nativeCommand")
      .mockImplementation(async (_binary, args) => {
        if (args[0] === "--list-devices")
          return "Available devices:\n  BLAS: Accelerate\n  MTL0:\nwarning: no device\n";
        return "version";
      });
    const paths = resolveKoedServerPaths({ KOED_HOME: resolve(temp, "home") });
    const options = { environment: { KOED_EMBEDDING_ACCELERATION: "auto" } };
    await expect(installReleaseRuntime(paths, options)).rejects.toThrow(
      /Metal.*device/i
    );
    expect(currentNativeId(paths)).toBeNull();
    probe.mockImplementation(async (_binary, args) => {
      if (args[0] === "--list-devices") throw new Error("backend unavailable");
      return "version";
    });
    await expect(installReleaseRuntime(paths, options)).rejects.toThrow(
      /Metal.*device/i
    );
    expect(currentNativeId(paths)).toBeNull();
  });
  it("rejects forced CUDA before acquisition and gives supported startup guidance", async () => {
    const { archive, catalog } = fixture("1.0.0");
    vi.spyOn(catalogModule, "getNativeRuntimeCatalog").mockReturnValue(catalog);
    const fetch = vi
      .spyOn(download, "fetchBounded")
      .mockImplementation(async (_url, dest) => {
        copyFileSync(archive, dest);
      });
    vi.spyOn(command, "nativeCommand").mockResolvedValue("MTL0: Apple GPU");
    const paths = resolveKoedServerPaths({ KOED_HOME: resolve(temp, "home") });
    await expect(
      installReleaseRuntime(paths, {
        environment: { KOED_EMBEDDING_ACCELERATION: "cuda" }
      })
    ).rejects.toThrow(/CUDA.*macOS.*(?:auto|metal)/i);
    expect(fetch).not.toHaveBeenCalled();
    const policy = vi.spyOn(assets, "embeddingPolicy").mockReturnValue("cuda");
    await expect(
      installReleaseRuntime(paths, { environment: {} })
    ).rejects.toThrow(/CUDA.*macOS.*(?:auto|metal)/i);
    expect(fetch).not.toHaveBeenCalled();
    policy.mockRestore();
    await installReleaseRuntime(paths, {
      environment: { KOED_EMBEDDING_ACCELERATION: "auto" }
    });
    expect(() =>
      resolveSelectedCoreForStart(paths, {
        KOED_EMBEDDING_ACCELERATION: "cuda"
      })
    ).toThrow(/CUDA.*macOS.*(?:auto|metal)/i);
    try {
      resolveSelectedCoreForStart(paths, {
        KOED_EMBEDDING_ACCELERATION: "cuda"
      });
    } catch (error) {
      expect(String(error)).not.toContain("--with-cuda");
    }
  });
  it("rejects missing pin and cancelled installs before acquisition", async () => {
    const { catalog } = fixture("1.0.0");
    const get = vi
      .spyOn(catalogModule, "getNativeRuntimeCatalog")
      .mockImplementation(() => {
        throw new Error("no reviewed native runtime pin");
      });
    const fetch = vi.spyOn(download, "fetchBounded");
    const paths = resolveKoedServerPaths({ KOED_HOME: resolve(temp, "home") });
    await expect(installReleaseRuntime(paths)).rejects.toThrow(
      /no reviewed native runtime pin/
    );
    get.mockReturnValue(catalog);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      installReleaseRuntime(paths, { signal: controller.signal })
    ).rejects.toThrow(/cancelled/);
    expect(fetch).not.toHaveBeenCalled();
    expect(currentNativeId(paths)).toBeNull();
  });
  it("rejects a corrupt archive without activating a selection", async () => {
    const { archive, catalog } = fixture("1.0.0");
    vi.spyOn(catalogModule, "getNativeRuntimeCatalog").mockReturnValue(catalog);
    vi.spyOn(download, "fetchBounded").mockImplementation(
      async (_url, dest) => {
        const bytes = readFileSync(archive);
        bytes[bytes.length - 1] ^= 1;
        writeFileSync(dest, bytes);
      }
    );
    const probe = vi
      .spyOn(command, "nativeCommand")
      .mockResolvedValue("version");
    const paths = resolveKoedServerPaths({ KOED_HOME: resolve(temp, "home") });
    await expect(
      installReleaseRuntime(paths, {
        environment: { KOED_EMBEDDING_ACCELERATION: "auto" }
      })
    ).rejects.toThrow(/digest mismatch/);
    expect(currentNativeId(paths)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
  it("keeps previous selection when update probe fails and rejects macOS CUDA before acquisition", async () => {
    const first = fixture("1.0.0"),
      second = fixture("1.1.0");
    const pin = vi
      .spyOn(catalogModule, "getNativeRuntimeCatalog")
      .mockReturnValue(first.catalog);
    let archive = first.archive;
    const fetch = vi
      .spyOn(download, "fetchBounded")
      .mockImplementation(async (_url, dest) => {
        copyFileSync(archive, dest);
      });
    const probe = vi
      .spyOn(command, "nativeCommand")
      .mockImplementation(async (_binary, args) =>
        args[0] === "--list-devices" ? "MTL0: Apple GPU" : "version"
      );
    const paths = resolveKoedServerPaths({ KOED_HOME: resolve(temp, "home") });
    const options = { environment: { KOED_EMBEDDING_ACCELERATION: "auto" } };
    const installed = await installReleaseRuntime(paths, options);
    pin.mockReturnValue(second.catalog);
    archive = second.archive;
    probe.mockImplementation(async (_binary, args) =>
      args[0] === "--list-devices"
        ? "Available devices:\n BLAS: Accelerate"
        : "version"
    );
    await expect(installReleaseRuntime(paths, options)).rejects.toThrow(
      /Metal device discovery failed/
    );
    expect(currentNativeId(paths)).toBe(installed.selectionId);
    const count = fetch.mock.calls.length;
    for (const cuda of ["with", "without"] as const)
      await expect(
        installReleaseRuntime(paths, { ...options, cuda })
      ).rejects.toThrow(/not supported on macOS/);
    expect(fetch).toHaveBeenCalledTimes(count);
  });
});

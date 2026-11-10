import { describe, expect, it } from "vitest";
import { permitsNativeEntry } from "./native-payload-admission.js";
import { validateMacFile } from "./native-macos-policy.js";
import {
  selectNativeRuntimeCatalog,
  validateCompiledNativeRuntimeCatalog
} from "./native-runtime-catalog.js";

const id = "a".repeat(64);
const common = {
  recipeId: id,
  runtimeVersion: "1.0.0",
  sha256: "b".repeat(64),
  manifestSha256: "c".repeat(64),
  archiveBytes: 100,
  expandedBytes: 500,
  contracts: { layout: 1, postgres: 1, embedding: 1 },
  components: {
    postgres: { major: 17, version: "17.6" },
    pgvector: { version: "0.8.3" },
    llamaCpp: { version: "b10514", revision: "d".repeat(40) }
  }
};
const linux = {
  schemaVersion: 1,
  minimumCoreVersion: "1.0.0",
  core: {
    ...common,
    target: {
      platform: "linux",
      architecture: "x64",
      libc: { family: "glibc", minimumVersion: "2.35" }
    },
    url: `https://github.com/koed-labs/koed/releases/download/native-core-${id}/koed-native-core-${id}-linux-x64.tar.gz`
  },
  cuda: null
};
const macos = {
  schemaVersion: 1,
  minimumCoreVersion: "1.0.0",
  core: {
    ...common,
    target: {
      platform: "macos",
      architecture: "arm64",
      minimumVersion: "14.0"
    },
    components: { ...common.components, llamaCpp: { version: "b10514" } },
    url: `https://github.com/koed-labs/koed/releases/download/native-core-${id}/koed-native-core-${id}-macos-arm64.tar.gz`
  },
  cuda: null
};
const compiled = { schemaVersion: 2, linux, macos };

describe("compiled native catalog target isolation", () => {
  it("selects only the matching platform and preserves legacy Linux catalogs", () => {
    expect(
      selectNativeRuntimeCatalog(compiled, "darwin", "arm64").core.target
        .platform
    ).toBe("macos");
    expect(
      selectNativeRuntimeCatalog(compiled, "linux", "x64").core.target.platform
    ).toBe("linux");
    expect(selectNativeRuntimeCatalog(linux, "linux", "x64")).toEqual(linux);
    expect(() => selectNativeRuntimeCatalog(linux, "darwin", "arm64")).toThrow(
      /no reviewed.*pin/i
    );
    expect(() =>
      selectNativeRuntimeCatalog(compiled, "linux", "arm64")
    ).toThrow(/unsupported/i);
    expect(() =>
      selectNativeRuntimeCatalog(
        { ...compiled, macos: null },
        "darwin",
        "arm64"
      )
    ).toThrow(/no reviewed.*pin/i);
  });

  it("restricts core inventory to the target layout", () => {
    expect(
      permitsNativeEntry("core", "llama.cpp/metal/llama-server", false, "macos")
    ).toBe(true);
    expect(
      permitsNativeEntry("core", "llama.cpp/cpu/llama-server", false, "macos")
    ).toBe(false);
    expect(
      permitsNativeEntry("core", "llama.cpp/metal/llama-server", false, "linux")
    ).toBe(false);
    expect(
      permitsNativeEntry("core", "unrelated/executable", false, "macos")
    ).toBe(false);
  });

  it("permits only macOS staged file paths, including declared libraries and licenses", () => {
    for (const path of [
      "postgres/bin/psql",
      "postgres/lib/postgresql/vector.so",
      "postgres/share/extension/vector.control",
      "llama.cpp/metal/libggml.dylib",
      "third-party-licenses/postgres/COPYRIGHT"
    ]) {
      expect(permitsNativeEntry("core", path, false, "macos"), path).toBe(true);
    }
    for (const path of [
      "postgres/bin/surprise",
      "postgres/share/executable",
      "postgres/lib/attack.sh",
      "llama.cpp/metal/notes.txt",
      "third-party-licenses/attack.sh",
      "provenance.json"
    ]) {
      expect(permitsNativeEntry("core", path, false, "macos"), path).toBe(
        false
      );
    }
  });

  it("enforces macOS binary, script and timezone content policy", () => {
    const arm = Buffer.alloc(16);
    arm.writeUInt32LE(0xfeedfacf, 0);
    arm.writeUInt32LE(0x0100000c, 4);
    arm.writeUInt32LE(2, 12);
    expect(() =>
      validateMacFile("postgres/bin/postgres", arm, 0o755)
    ).not.toThrow();
    expect(() =>
      validateMacFile("postgres/bin/postgres", Buffer.from("#!/bin/sh"), 0o755)
    ).toThrow();
    expect(() =>
      validateMacFile("llama.cpp/llama-server", Buffer.from("#!/bin/sh"), 0o755)
    ).not.toThrow();
    expect(() =>
      validateMacFile("llama.cpp/metal/libggml.dylib", arm, 0o644)
    ).toThrow();
    arm.writeUInt32LE(6, 12);
    expect(() =>
      validateMacFile("llama.cpp/metal/libggml.dylib", arm, 0o644)
    ).not.toThrow();
    expect(() =>
      validateMacFile("postgres/share/timezone/UTC", Buffer.from("bad!"), 0o644)
    ).toThrow();
    expect(() =>
      validateMacFile("postgres/share/timezone/UTC", Buffer.from("TZif"), 0o644)
    ).not.toThrow();
    expect(() =>
      validateMacFile(
        "postgres/share/postgres.bki",
        Buffer.from("\x7fELF"),
        0o644
      )
    ).toThrow();
  });

  it("rejects wrong target, archive URL, unsupported fields and macOS CUDA", () => {
    for (const bad of [
      { ...macos, core: { ...macos.core, target: linux.core.target } },
      { ...macos, core: { ...macos.core, url: linux.core.url } },
      {
        ...macos,
        core: {
          ...macos.core,
          target: { ...macos.core.target, libc: linux.core.target.libc }
        }
      },
      { ...macos, cuda: { bogus: true } },
      { ...macos, core: { ...macos.core, components: common.components } }
    ])
      expect(() =>
        validateCompiledNativeRuntimeCatalog({ ...compiled, macos: bad })
      ).toThrow(/Invalid compiled/);
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  boundedMap,
  collectPlatformBinaries,
  linuxLoaderEnvironment,
  linuxLoaderIssues,
  macLoaderIssues
} from "./loader-validation-lib.mjs";

test("bounded work preserves input order when tasks finish out of order", async () => {
  let active = 0;
  let maximumActive = 0;
  const result = await boundedMap([30, 5, 15, 1], 2, async (delay, index) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    active -= 1;
    return index;
  });

  assert.deepEqual(result, [0, 1, 2, 3]);
  assert.equal(maximumActive, 2);
});

const runtimeRoot = "/tmp/koed-runtime";
const postgres = `${runtimeRoot}/postgres/bin/postgres`;
const libpq = `${runtimeRoot}/postgres/lib/libpq.5.dylib`;

test("accepts system and resolved runtime-relative macOS dependencies", () => {
  const issues = macLoaderIssues({
    file: postgres,
    runtimeRoot,
    runtimeFiles: [postgres, libpq],
    output: `${postgres}:
\t@loader_path/../lib/libpq.5.dylib (compatibility version 5.0.0, current version 5.17.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.120.2)`
  });
  assert.deepEqual(issues, []);
});

test("rejects Homebrew and build-workspace loader dependencies", () => {
  const issues = macLoaderIssues({
    file: libpq,
    runtimeRoot,
    runtimeFiles: [postgres, libpq],
    output: `${libpq}:
\t/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib (compatibility version 3.0.0, current version 3.5.0)
\t/Users/runner/work/koed/build/libcrypto.3.dylib (compatibility version 3.0.0, current version 3.5.0)`
  });
  assert.deepEqual(issues, [
    "external absolute dependency: /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib",
    "external absolute dependency: /Users/runner/work/koed/build/libcrypto.3.dylib"
  ]);
});

test("rejects unresolved runtime-relative dependencies", () => {
  const issues = macLoaderIssues({
    file: postgres,
    runtimeRoot,
    runtimeFiles: [postgres],
    output: `${postgres}:
\t@rpath/libssl.3.dylib (compatibility version 3.0.0, current version 3.5.0)
\t@loader_path/../lib/libpq.5.dylib (compatibility version 5.0.0, current version 5.17.0)`
  });
  assert.deepEqual(issues, [
    "unresolved runtime-relative dependency: @rpath/libssl.3.dylib",
    "unresolved loader-relative dependency: @loader_path/../lib/libpq.5.dylib"
  ]);
});

test("allows only the host NVIDIA driver dependency in the CUDA payload", () => {
  assert.deepEqual(
    linuxLoaderIssues({
      file: `${runtimeRoot}/llama.cpp/cuda/libggml-cuda.so`,
      output: `libcuda.so.1 => not found
libcudart.so.12 => ${runtimeRoot}/llama.cpp/cuda/libcudart.so.12`,
      runtimeRoot
    }),
    []
  );
  assert.deepEqual(
    linuxLoaderIssues({
      file: `${runtimeRoot}/llama.cpp/cuda/libggml-cuda.so`,
      output: `libcuda.so.1 => not found
libcublas.so.12 => not found`,
      runtimeRoot
    }),
    ["unresolved loader dependency: libcublas.so.12"]
  );
  assert.deepEqual(
    linuxLoaderIssues({
      file: `${runtimeRoot}/llama.cpp/cpu/libggml-cpu.so`,
      output: "libcuda.so.1 => not found",
      runtimeRoot
    }),
    ["unresolved loader dependency: libcuda.so.1"]
  );
});

test("resolves Linux libraries only through their packaged runtime directories", () => {
  assert.deepEqual(
    linuxLoaderEnvironment({
      file: `${runtimeRoot}/postgres/lib/libecpg.so.6`,
      runtimeRoot,
      environment: { LD_LIBRARY_PATH: "/existing" }
    }).LD_LIBRARY_PATH,
    `${runtimeRoot}/postgres/lib:/existing`
  );
  assert.deepEqual(
    linuxLoaderEnvironment({
      file: `${runtimeRoot}/llama.cpp/cuda/libggml-cuda.so`,
      runtimeRoot,
      environment: {}
    }).LD_LIBRARY_PATH,
    `${runtimeRoot}/llama.cpp/cuda`
  );
  assert.equal(
    linuxLoaderEnvironment({
      file: "/outside/libunexpected.so",
      runtimeRoot,
      environment: {}
    }).LD_LIBRARY_PATH,
    undefined
  );
});

test("recursively identifies Mach-O and ELF files by binary magic", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-loader-test-"));
  try {
    const macho = resolve(root, "extension-without-a-file-suffix");
    const elf = resolve(root, "linux-binary");
    const text = resolve(root, "README.txt");
    writeFileSync(macho, Buffer.from("feedfacf", "hex"));
    writeFileSync(elf, Buffer.from("7f454c46", "hex"));
    writeFileSync(text, "not a binary");
    assert.deepEqual(
      collectPlatformBinaries({ runtimeRoot: root, platform: "darwin" }),
      [realpathSync(macho)]
    );
    assert.deepEqual(
      collectPlatformBinaries({ runtimeRoot: root, platform: "linux" }),
      [realpathSync(elf)]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  boundedMap,
  collectPlatformBinaries,
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

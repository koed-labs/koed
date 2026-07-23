import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { normalizePackagedSymlinks } from "../apps/desktop/scripts/after-pack.mjs";
import { copyNativeRuntimeSource } from "./native-runtime-copy.mjs";

describe("packaged native runtime symlinks", () => {
  it("preserves relative targets while copying staged runtime sources", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-native-runtime-copy-"));
    const source = resolve(root, "source");
    const destination = resolve(root, "destination");
    const sourceLib = resolve(source, "postgres", "lib");
    try {
      mkdirSync(sourceLib, { recursive: true });
      mkdirSync(destination, { recursive: true });
      writeFileSync(resolve(sourceLib, "libpq.5.dylib"), "fixture");
      symlinkSync("libpq.5.dylib", resolve(sourceLib, "libpq.dylib"));

      copyNativeRuntimeSource(source, destination);

      assert.equal(
        readlinkSync(resolve(destination, "postgres", "lib", "libpq.dylib")),
        "libpq.5.dylib"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute links instead of guessing a packaged target", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-native-runtime-copy-"));
    try {
      symlinkSync("/staging/libpq.5.dylib", resolve(root, "libpq.dylib"));

      assert.throws(
        () => normalizePackagedSymlinks(root),
        /Packaged app contains an absolute symlink/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

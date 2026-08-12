import assert from "node:assert/strict";
import {
  existsSync,
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
import afterPack, {
  normalizePackagedSymlinks,
  packagedResourcesRoot
} from "../apps/desktop/scripts/after-pack.mjs";
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

describe("desktop provider runtime packaging policy", () => {
  it("removes a verified Claude Agent SDK executable from Linux resources", async () => {
    const appOutDir = mkdtempSync(resolve(tmpdir(), "koed-after-pack-"));
    const context = {
      appOutDir,
      electronPlatformName: "linux",
      packager: { appInfo: { productFilename: "Koed" } }
    };
    const packageRoot = resolve(
      packagedResourcesRoot(context),
      "koed-runtime",
      "mcp-server",
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk-linux-x64"
    );
    try {
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        resolve(packageRoot, "package.json"),
        JSON.stringify({
          name: "@anthropic-ai/claude-agent-sdk-linux-x64",
          version: "0.3.226",
          os: ["linux"],
          cpu: ["x64"],
          libc: ["glibc"],
          files: ["claude", "README.md", "LICENSE.md"]
        })
      );
      writeFileSync(resolve(packageRoot, "README.md"), "fixture");
      writeFileSync(resolve(packageRoot, "LICENSE.md"), "fixture");
      writeFileSync(resolve(packageRoot, "claude"), "fixture", { mode: 0o755 });

      await afterPack(context);

      assert.equal(existsSync(packageRoot), false);
    } finally {
      rmSync(appOutDir, { recursive: true, force: true });
    }
  });
});

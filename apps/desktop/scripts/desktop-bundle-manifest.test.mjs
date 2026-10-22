import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync
} from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { comparePackageTrees } from "../../../scripts/compare-package-trees.mjs";
import { writeDesktopBundleManifest } from "./finalize-runtime-manifests.mjs";

test("Desktop bundle manifest matches Electron Builder's packaged mode", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-bundle-manifest-"));
  const source = resolve(root, "source");
  const packaged = resolve(root, "packaged");
  mkdirSync(source);
  try {
    writeDesktopBundleManifest(source, {
      schemaVersion: 1,
      productVersion: "0.8.1",
      component: "base",
      target: { platform: "macos", architecture: "arm64" },
      files: []
    });
    cpSync(source, packaged, { recursive: true });
    chmodSync(resolve(packaged, "desktop-bundle-manifest.json"), 0o644);

    assert.equal(
      statSync(resolve(source, "desktop-bundle-manifest.json")).mode & 0o777,
      0o644
    );
    assert.equal(comparePackageTrees(source, packaged).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

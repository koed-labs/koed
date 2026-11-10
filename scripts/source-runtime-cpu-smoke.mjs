import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { getNativeRuntimeCatalog } from "../packages/koed-server/dist/native-runtime-catalog.js";

// Run after building and embedding source catalogs on Linux x64. This exercises real
// downloads, archive/file verification, native executable probes and activation.
assert.equal(process.platform, "linux", "This smoke requires Linux x64.");
assert.equal(process.arch, "x64", "This smoke requires Linux x64.");
const root = resolve(import.meta.dirname, "..");
mkdirSync(resolve(root, "scratch"), { recursive: true });
const home = mkdtempSync(resolve(root, "scratch/source-cpu-home-"));
const cli = resolve(root, "packages/koed-server/dist/cli.js");
const invoke = (args) => {
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    env: {
      ...process.env,
      KOED_HOME: home,
      KOED_DEPENDENCY_MODE: "bundled-local",
      KOED_HARDWARE_ACCELERATION: "cpu",
      KOED_EMBEDDING_ACCELERATION: "cpu"
    }
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};
try {
  const catalog = getNativeRuntimeCatalog();
  const installed = invoke([
    "runtime",
    "install",
    "--provider",
    "release",
    "--dependency-mode",
    "bundled-local",
    "--without-cuda"
  ]);
  assert.equal(installed.ok, true);
  assert.equal(installed.coreId, catalog.core.recipeId);
  assert.equal(installed.cudaId, null);
  const status = invoke(["runtime", "status", "--provider", "release"]);
  assert.equal(status.state, "installed");
  assert.equal(status.installedCoreId, catalog.core.recipeId);
  assert.equal(status.installedCudaId, null);
  console.log(
    JSON.stringify({
      ok: true,
      freshHome: true,
      coreId: catalog.core.recipeId,
      archiveSha256: catalog.core.sha256,
      scope: "cpu-runtime-installation"
    })
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}

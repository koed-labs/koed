import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  smokeExecutionPlan,
  withPackagedNativeAssetsMasked
} from "./smoke-packaged-desktop-app-lib.mjs";
import { assertNoSourceCheckoutResolution } from "./smoke-packaged-desktop-app.mjs";

const createRuntimeRoot = ({ withAssets = true } = {}) => {
  const runtimeRoot = mkdtempSync(resolve(tmpdir(), "koed-smoke-assets-"));
  if (withAssets) {
    for (const [directory, file] of [
      ["postgres", "bin/postgres"],
      ["llama.cpp", "llama-server"]
    ]) {
      const target = resolve(runtimeRoot, directory, file);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, `${directory}\n`);
    }
  }
  return runtimeRoot;
};

test("missing-assets execution excludes collaboration and renderer probes", () => {
  assert.deepEqual(smokeExecutionPlan({ missingAssets: true }), {
    collaborationBroker: false,
    rendererFaults: false,
    missingAssets: true,
    healthyDaemon: false
  });
  assert.deepEqual(smokeExecutionPlan({ missingAssets: false }), {
    collaborationBroker: true,
    rendererFaults: true,
    missingAssets: false,
    healthyDaemon: true
  });
});

test("native asset masking restores packaged directories after success", async () => {
  const runtimeRoot = createRuntimeRoot();
  try {
    const result = await withPackagedNativeAssetsMasked({
      runtimeRoot,
      work: ({ maskedEntries }) => {
        assert.deepEqual(maskedEntries.sort(), ["llama.cpp", "postgres"]);
        assert.equal(existsSync(resolve(runtimeRoot, "postgres")), false);
        assert.equal(existsSync(resolve(runtimeRoot, "llama.cpp")), false);
        return "complete";
      }
    });
    assert.equal(result, "complete");
    assert.equal(existsSync(resolve(runtimeRoot, "postgres")), true);
    assert.equal(existsSync(resolve(runtimeRoot, "llama.cpp")), true);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("native asset masking restores packaged directories after failure", async () => {
  const runtimeRoot = createRuntimeRoot();
  try {
    await assert.rejects(
      withPackagedNativeAssetsMasked({
        runtimeRoot,
        work: () => {
          throw new Error("expected smoke failure");
        }
      }),
      /expected smoke failure/
    );
    assert.equal(existsSync(resolve(runtimeRoot, "postgres")), true);
    assert.equal(existsSync(resolve(runtimeRoot, "llama.cpp")), true);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("native asset masking supports an app whose assets are already absent", async () => {
  const runtimeRoot = createRuntimeRoot({ withAssets: false });
  try {
    let called = false;
    await withPackagedNativeAssetsMasked({
      runtimeRoot,
      work: ({ maskedEntries }) => {
        called = true;
        assert.deepEqual(maskedEntries, []);
      }
    });
    assert.equal(called, true);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("packaged smoke rejects source-checkout artifact resolution", () => {
  const sourceCheckoutArtifact = resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "apps",
    "api",
    "dist",
    "index.js"
  );
  assert.throws(
    () =>
      assertNoSourceCheckoutResolution("runtime status", {
        artifactPath: sourceCheckoutArtifact
      }),
    /resolved packaged runtime artifacts from source checkout/
  );
  assert.doesNotThrow(() =>
    assertNoSourceCheckoutResolution("runtime status", {
      artifactPath: "/Applications/Koed.app/Contents/Resources/koed-runtime/api"
    })
  );
});

import {
  pinDesktopBundleGenerationForStart,
  readCurrentDesktopGeneration
} from "./generation-lifecycle.js";
import {
  realpathSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const trust = vi.hoisted(() => ({
  runtime: undefined as
    | import("./component-contract.js").RuntimeIdentity
    | undefined
}));
vi.mock("./component-manifest-catalog-data.js", async () => {
  const fixtures = await import("./component-test-fixtures.js");
  return {
    get productionComponentManifestCatalog() {
      return fixtures.getFixtureManifestPinCatalog();
    }
  };
});
vi.mock("./component-runtime-identity.js", () => ({
  discoverActualRuntimeIdentity: () => trust.runtime
}));
import {
  resetFixtureManifestPinCatalog,
  componentFixture
} from "./component-test-fixtures.js";
import { verifyDesktopRuntimeBundle } from "./desktop-runtime-capability.js";
import { createDesktopComponentManagerBridge } from "./desktop-component-manager.js";
import { resolveKoedServerPaths } from "./paths.js";
vi.mock("./privacy-model-runtime.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  installPrivacyModel: async () => ({ ok: true, modelPath: "/synthetic-model" })
}));
vi.mock("./privacy-inference.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  verifyPrivacyComponentInference: async () => ({
    activeProvider: "cpu",
    requestedProvider: "cpu",
    executedProviders: ["CPUExecutionProvider"],
    proof: "onnx-execution-profile",
    maskingSha256: "a".repeat(64)
  })
}));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  trust.runtime = undefined;
  resetFixtureManifestPinCatalog();
});
it("stages complete first Privacy assets before an explicit stopped activation", async () => {
  const home = realpathSync.native(
    mkdtempSync(resolve(tmpdir(), "koed-privacy-first-"))
  );
  roots.push(home);
  const fixture = await componentFixture({
    component: "privacy",
    productVersion: "0.8.1",
    target: { platform: "macos", architecture: "arm64" }
  });
  roots.push(fixture.root);
  trust.runtime = fixture.input.runtime;
  const resources = resolve(home, "resources"),
    runtimeRoot = resolve(resources, "koed-runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(
    resolve(runtimeRoot, "desktop-bundle-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      component: "base",
      productVersion: "0.8.1",
      target: {
        platform: fixture.input.runtime.platform,
        architecture: fixture.input.runtime.architecture
      },
      files: []
    })
  );
  const environment = {
    KOED_HOME: resolve(home, "state"),
    KOED_TEAM_COLLABORATION_ENABLED: "true"
  };
  const paths = resolveKoedServerPaths(environment);
  const capability = verifyDesktopRuntimeBundle(resources);
  const basePin = await pinDesktopBundleGenerationForStart(paths, capability);
  await basePin.release();
  const manager = createDesktopComponentManagerBridge({
    capability,
    paths,
    environment,
    runtime: fixture.input.runtime,
    target: {
      platform: fixture.input.runtime.platform,
      architecture: fixture.input.runtime.architecture
    },
    controlPlaneVersion: "0.8.1",
    isRunning: false
  });
  const status = await manager.status();
  expect(status.required).toContain("privacy");
  expect(status.requiredManifestPinsAvailable).toBe(true);
  const manifestPath = resolve(home, "privacy.json");
  writeFileSync(manifestPath, fixture.input.manifestBytes);
  const installed = await manager.install({
    requestId: "11111111-1111-4111-8111-111111111111",
    source: {
      kind: "offline",
      archivePath: fixture.input.archivePath,
      manifestPath
    }
  });
  expect(installed.state).toBe("staged");
  expect((await manager.status()).components.privacy).toBe("staged");
  await manager.activate(installed.generationId, basePin.generation.id);
  expect((await readCurrentDesktopGeneration(paths, capability)).id).toBe(
    installed.generationId
  );
});

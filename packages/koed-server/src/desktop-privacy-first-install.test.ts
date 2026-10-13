import { pinDesktopBundleGenerationForStart } from "./generation-lifecycle.js";
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
  keys: new Map<string, string>(),
  runtime: undefined as
    | import("./component-contract.js").RuntimeIdentity
    | undefined
}));
vi.mock("./component-trust-roots.js", () => ({
  productionComponentTrustRoots: trust.keys
}));
vi.mock("./component-runtime-identity.js", () => ({
  discoverActualRuntimeIdentity: () => trust.runtime
}));
import { signedComponentFixture } from "./component-test-fixtures.js";
import { verifyDesktopRuntimeBundle } from "./desktop-runtime-capability.js";
import { createDesktopComponentManagerBridge } from "./desktop-component-manager.js";
import { resolveKoedServerPaths } from "./paths.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  trust.keys.clear();
});
it("installs and activates a signed first Privacy generation with Team enabled and no running services", async () => {
  const home = realpathSync.native(
    mkdtempSync(resolve(tmpdir(), "koed-privacy-first-"))
  );
  roots.push(home);
  const fixture = await signedComponentFixture({
    component: "privacy",
    productVersion: "0.8.1"
  });
  roots.push(fixture.root);
  trust.runtime = fixture.input.runtime;
  for (const [key, value] of fixture.input.trustedKeys)
    trust.keys.set(key, value);
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
  expect((await manager.status()).required).toContain("privacy");
  const manifestPath = resolve(home, "privacy.json"),
    signaturePath = resolve(home, "privacy.sig.json");
  writeFileSync(manifestPath, fixture.input.manifestBytes);
  writeFileSync(signaturePath, JSON.stringify(fixture.input.signature));
  const installed = await manager.install({
    requestId: "11111111-1111-4111-8111-111111111111",
    source: {
      kind: "offline",
      archivePath: fixture.input.archivePath,
      manifestPath,
      signaturePath
    }
  });
  expect(installed.state).toBe("active");
  expect((await manager.status()).components.privacy).toBe("active");
});

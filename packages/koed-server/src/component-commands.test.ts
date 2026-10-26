import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactTarget, RuntimeIdentity } from "./component-contract.js";

const fixtureRuntime = vi.hoisted(() => ({
  current: undefined as RuntimeIdentity | undefined
}));
vi.mock("./component-runtime-identity.js", () => ({
  discoverActualRuntimeIdentity: () => {
    if (!fixtureRuntime.current) throw new Error("fixture runtime missing");
    return fixtureRuntime.current;
  }
}));
vi.mock("./component-manifest-catalog-data.js", async () => {
  const fixtures = await import("./component-test-fixtures.js");
  return {
    get productionComponentManifestCatalog() {
      return fixtures.getFixtureManifestPinCatalog();
    }
  };
});

import { writeFileSync } from "node:fs";
import {
  resetFixtureManifestPinCatalog,
  componentFixture
} from "./component-test-fixtures.js";
import { resolveKoedServerPaths } from "./paths.js";
import { stageComponent } from "./component-store.js";
import {
  canonicalComponentManifestBytes,
  validateComponentManifest
} from "./component-verification.js";
import { pinDesktopBundleGenerationForStart } from "./generation-lifecycle.js";
import { verifyDesktopRuntimeBundle } from "./desktop-runtime-capability.js";
import {
  runComponentActivate,
  runComponentInstall,
  runComponentStatus
} from "./component-commands.js";
import type { ComponentCommandContext } from "./component-commands.js";

const roots: string[] = [];
const fixtures: Array<Awaited<ReturnType<typeof componentFixture>>> = [];
const context = (
  overrides: Partial<ComponentCommandContext> = {}
): ComponentCommandContext => {
  const home = mkdtempSync(
    resolve(realpathSync(tmpdir()), "koed-component-cli-")
  );
  roots.push(home);
  if (process.arch !== "arm64" && process.arch !== "x64")
    throw new Error(`Unsupported fixture architecture: ${process.arch}`);
  const runtime = {
    kind: "node",
    version: process.versions.node,
    nodeVersion: process.versions.node,
    modulesAbi: process.versions.modules,
    napiVersion: Number(process.versions.napi),
    platform: process.platform === "darwin" ? "macos" : "linux",
    architecture: process.arch
  } as const;
  return {
    paths: resolveKoedServerPaths({ KOED_HOME: home }),
    controlPlaneVersion: "0.9.0",
    target: { platform: runtime.platform, architecture: runtime.architecture },
    runtime,
    owner: { kind: "cli", installationId: "component-cli-test" },
    isRunning: false,
    ...overrides
  };
};

const pinnedOfflineSource = async (
  version: string,
  component: "base" | "privacy" = "base"
) => {
  const target: ArtifactTarget = { platform: "linux", architecture: "x64" };
  const fixture = await componentFixture({
    productVersion: version,
    component,
    target
  });
  const manifestPath = resolve(fixture.root, "manifest.json");
  writeFileSync(manifestPath, fixture.input.manifestBytes);
  fixtureRuntime.current = fixture.input.runtime;
  return {
    fixture,
    source: {
      kind: "offline" as const,
      archivePath: fixture.input.archivePath,
      manifestPath
    },
    runtime: fixture.input.runtime,
    target
  };
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  fixtureRuntime.current = undefined;
  resetFixtureManifestPinCatalog();
  vi.unstubAllGlobals();
});

describe("component status command", () => {
  it.each([false, true])(
    "provisions new-version Base over prior selection (stageOnly=%s)",
    async (stageOnly) => {
      const old = await pinnedOfflineSource("0.9.0");
      fixtures.push(old.fixture);
      const current = context({ runtime: old.runtime, target: old.target });
      await runComponentInstall(current, {
        component: "base",
        source: old.source
      });
      const next = await pinnedOfflineSource("0.9.1");
      fixtures.push(next.fixture);
      const upgraded = { ...current, controlPlaneVersion: "0.9.1" };
      const status = await runComponentStatus(upgraded);
      expect(status.activeVersion).toBe("0.9.0");
      expect(status.components.base).toBe("incompatible");
      const result = await runComponentInstall(upgraded, {
        component: "base",
        source: next.source,
        stageOnly
      });
      expect(result.state).toBe(stageOnly ? "staged" : "active");
      expect((await runComponentStatus(upgraded)).activeVersion).toBe(
        stageOnly ? "0.9.0" : "0.9.1"
      );
    }
  );
  it("does not reuse old-version Base while staging new Privacy", async () => {
    const old = await pinnedOfflineSource("0.9.0");
    fixtures.push(old.fixture);
    const current = context({ runtime: old.runtime, target: old.target });
    await runComponentInstall(current, {
      component: "base",
      source: old.source
    });
    const pointerPath = resolve(current.paths.componentsDir, "current.json");
    const pointer = readFileSync(pointerPath);
    const next = await pinnedOfflineSource("0.9.1", "privacy");
    fixtures.push(next.fixture);
    const upgraded = {
      ...current,
      controlPlaneVersion: "0.9.1",
      execution: "packaged" as const,
      environment: {
        KOED_DEPENDENCY_MODE: "bundled-local",
        KOED_TEAM_COLLABORATION_ENABLED: "true"
      }
    };
    expect((await runComponentStatus(upgraded)).components.privacy).toBe(
      "missing"
    );
    const result = await runComponentInstall(upgraded, {
      component: "privacy",
      source: next.source
    });
    expect(result.state).toBe("staged");
    expect((await runComponentStatus(upgraded)).components.privacy).toBe(
      "installed"
    );
    expect(readFileSync(pointerPath)).toEqual(pointer);
    expect((await runComponentStatus(upgraded)).activeVersion).toBe("0.9.0");
  });

  it("stages privacy without treating active Desktop bundle as a pinned base", async () => {
    const pinned = await pinnedOfflineSource("0.9.0", "privacy");
    fixtures.push(pinned.fixture);
    const current = context({
      runtime: pinned.runtime,
      target: pinned.target,
      execution: "packaged",
      environment: {
        KOED_DEPENDENCY_MODE: "bundled-local",
        KOED_TEAM_COLLABORATION_ENABLED: "true"
      }
    });
    const resources = resolve(current.paths.koedHome, "resources");
    mkdirSync(resolve(resources, "koed-runtime"), { recursive: true });
    writeFileSync(
      resolve(resources, "koed-runtime/desktop-bundle-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        component: "base",
        productVersion: "0.9.0",
        target: pinned.target,
        files: []
      })
    );
    const capability = verifyDesktopRuntimeBundle(resources);
    const pin = await pinDesktopBundleGenerationForStart(
      current.paths,
      capability
    );
    current.owner = pin.generation.owner;
    current.desktopRuntimeCapability = capability;
    const desktopId = pin.generation.id;
    await pin.release();
    await expect(
      runComponentInstall(current, {
        component: "privacy",
        source: pinned.source
      })
    ).resolves.toEqual({ state: "staged" });
    expect((await runComponentStatus(current)).activeGeneration).toBe(
      desktopId
    );
  });
  it("reports required base as missing when no generation is installed", async () => {
    const result = await runComponentStatus(context());
    expect(result.components).toEqual({
      base: "missing",
      privacy: "not-required"
    });
    expect(result.activeGeneration).toBeNull();
    expect(result.requiredManifestPinsAvailable).toBe(false);
  });

  it("reports required pin catalog unavailable when required component entry is missing", async () => {
    const pinned = await pinnedOfflineSource("0.9.0");
    fixtures.push(pinned.fixture);
    const current = context({
      runtime: pinned.runtime,
      target: pinned.target,
      environment: {
        KOED_DEPENDENCY_MODE: "bundled-local",
        KOED_TEAM_COLLABORATION_ENABLED: "true"
      }
    });
    const status = await runComponentStatus(current);
    expect(status.required).toEqual(["base", "privacy"]);
    expect(status.requiredManifestPinsAvailable).toBe(false);
  });

  it("reports verified cached components that are not in a generation as installed", async () => {
    const pinned = await pinnedOfflineSource("0.9.0");
    fixtures.push(pinned.fixture);
    const current = context({ runtime: pinned.runtime, target: pinned.target });
    await stageComponent(current.paths, pinned.source, {
      expectedComponent: "base",
      expectedVersion: "0.9.0",
      target: pinned.target,
      runtime: pinned.runtime
    });
    const status = await runComponentStatus(current);
    expect(status.components.base).toBe("installed");
    expect(status.requiredManifestPinsAvailable).toBe(true);
  });

  it("rejects requested versions outside embedded pin catalog", async () => {
    const pinned = await pinnedOfflineSource("0.9.0");
    fixtures.push(pinned.fixture);
    const current = context({ runtime: pinned.runtime, target: pinned.target });
    await expect(
      runComponentInstall(current, {
        component: "base",
        version: "0.8.1",
        source: pinned.source
      })
    ).rejects.toThrow("Component pin catalog version mismatch");
  });

  it("rejects remote manifest mutation before fetching archive", async () => {
    const pinned = await pinnedOfflineSource("0.9.0");
    fixtures.push(pinned.fixture);
    const manifest: unknown = JSON.parse(
      pinned.fixture.input.manifestBytes.toString("utf8")
    );
    validateComponentManifest(manifest);
    manifest.runtimes[0]!.runtimeRange = ">=23 <24";
    const mutatedManifest = canonicalComponentManifestBytes(manifest);
    const archive = readFileSync(pinned.fixture.input.archivePath);
    const urls = {
      manifest: "https://artifacts.example/base.manifest.json",
      archive: "https://artifacts.example/base.tar.gz"
    };
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        const body = url === urls.manifest ? mutatedManifest : archive;
        return new Response(new Uint8Array(body), { status: 200 });
      })
    );
    const current = context({
      runtime: pinned.runtime,
      target: pinned.target,
      controlPlaneVersion: "0.9.0"
    });
    await expect(
      runComponentInstall(current, {
        component: "base",
        version: "0.9.0",
        source: {
          kind: "remote",
          manifestUrl: urls.manifest,
          archiveUrl: urls.archive
        }
      })
    ).rejects.toThrow("component manifest pin mismatch");
    expect(requested).toEqual([urls.manifest]);
  });

  it("activates a pinned prerelease matching its control plane", async () => {
    const version = "1.0.0-alpha.1";
    const pinned = await pinnedOfflineSource(version);
    fixtures.push(pinned.fixture);
    const current = context({
      runtime: pinned.runtime,
      target: pinned.target,
      controlPlaneVersion: version
    });
    const installed = await runComponentInstall(current, {
      component: "base",
      source: pinned.source
    });
    expect(installed.state).toBe("active");
    expect((await runComponentStatus(current)).components.base).toBe("active");
  });

  it("installs a pinned exact-version remote source only when explicitly requested", async () => {
    const pinned = await pinnedOfflineSource("0.9.0");
    fixtures.push(pinned.fixture);
    const archive = readFileSync(pinned.fixture.input.archivePath);
    const urls = {
      manifest: "https://artifacts.example/base.manifest.json",
      archive: "https://artifacts.example/base.tar.gz"
    };
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        const body =
          url === urls.manifest ? pinned.fixture.input.manifestBytes : archive;
        return new Response(new Uint8Array(body), { status: 200 });
      })
    );
    const current = context({
      runtime: pinned.runtime,
      target: pinned.target,
      controlPlaneVersion: "0.9.0"
    });
    const result = await runComponentInstall(current, {
      component: "base",
      version: "0.9.0",
      source: {
        kind: "remote",
        manifestUrl: urls.manifest,
        archiveUrl: urls.archive
      }
    });
    expect(result.state).toBe("active");
    expect(requested).toEqual([urls.manifest, urls.archive]);
  });

  it("never activates during install while services are running", async () => {
    const pinned = await pinnedOfflineSource("0.9.0");
    fixtures.push(pinned.fixture);
    const running = context({
      runtime: pinned.runtime,
      target: pinned.target,
      controlPlaneVersion: "0.9.0",
      isRunning: true
    });
    const result = await runComponentInstall(running, {
      component: "base",
      source: pinned.source
    });
    expect(result.state).toBe("staged");
    expect((await runComponentStatus(running)).components.base).toBe("staged");
    await expect(runComponentActivate(running, "0.9.0")).rejects.toThrow(
      /Stop Koed services/
    );
    const activated = await runComponentActivate(
      { ...running, isRunning: false },
      "0.9.0"
    );
    expect(activated.productVersion).toBe("0.9.0");
  });
});

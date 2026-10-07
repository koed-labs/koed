import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactTarget, RuntimeIdentity } from "./component-contract.js";

const fixtureRuntime = vi.hoisted(() => ({
  current: undefined as RuntimeIdentity | undefined
}));
const fixtureKeys = vi.hoisted(() => ({ current: new Map<string, string>() }));
vi.mock("./component-runtime-identity.js", () => ({
  discoverActualRuntimeIdentity: () => {
    if (!fixtureRuntime.current) throw new Error("fixture runtime missing");
    return fixtureRuntime.current;
  }
}));
vi.mock("./component-trust-roots.js", () => ({
  productionComponentTrustRoots: fixtureKeys.current
}));

import { writeFileSync } from "node:fs";
import { signedComponentFixture } from "./component-test-fixtures.js";
import { resolveKoedServerPaths } from "./paths.js";
import { stageComponent } from "./component-store.js";
import {
  runComponentActivate,
  runComponentInstall,
  runComponentStatus
} from "./component-commands.js";
import type { ComponentCommandContext } from "./component-commands.js";

const roots: string[] = [];
const fixtures: Array<Awaited<ReturnType<typeof signedComponentFixture>>> = [];
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

const signedOfflineSource = async (version: string) => {
  const target: ArtifactTarget = { platform: "linux", architecture: "x64" };
  const fixture = await signedComponentFixture({
    productVersion: version,
    target
  });
  const manifestPath = resolve(fixture.root, "manifest.json");
  const signaturePath = resolve(fixture.root, "signature.json");
  writeFileSync(manifestPath, fixture.input.manifestBytes);
  writeFileSync(signaturePath, JSON.stringify(fixture.input.signature));
  fixtureRuntime.current = fixture.input.runtime;
  fixtureKeys.current.clear();
  for (const [key, value] of fixture.input.trustedKeys)
    fixtureKeys.current.set(key, value);
  return {
    fixture,
    source: {
      kind: "offline" as const,
      archivePath: fixture.input.archivePath,
      manifestPath,
      signaturePath
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
  fixtureKeys.current.clear();
  vi.unstubAllGlobals();
});

describe("component status command", () => {
  it("reports required base as missing when no signed generation is installed", async () => {
    const result = await runComponentStatus(context());
    expect(result.components).toEqual({
      base: "missing",
      privacy: "not-required"
    });
    expect(result.activeGeneration).toBeNull();
  });

  it("reports verified cached components that are not in a generation as installed", async () => {
    const signed = await signedOfflineSource("0.9.0");
    fixtures.push(signed.fixture);
    const current = context({ runtime: signed.runtime, target: signed.target });
    await stageComponent(current.paths, signed.source, {
      expectedComponent: "base",
      expectedVersion: "0.9.0",
      target: signed.target,
      runtime: signed.runtime
    });
    expect((await runComponentStatus(current)).components.base).toBe(
      "installed"
    );
  });

  it("stages another version and activates only under matching stopped control plane", async () => {
    const signed = await signedOfflineSource("0.8.1");
    fixtures.push(signed.fixture);
    const initial = context({ runtime: signed.runtime, target: signed.target });
    const staged = await runComponentInstall(initial, {
      component: "base",
      version: "0.8.1",
      source: signed.source
    });
    expect(staged.state).toBe("staged");
    expect((await runComponentStatus(initial)).components.base).toBe(
      "incompatible"
    );
    await expect(runComponentActivate(initial, "0.8.1")).rejects.toThrow(
      /matching control plane/
    );
    const activated = await runComponentActivate(
      { ...initial, controlPlaneVersion: "0.8.1" },
      "0.8.1"
    );
    expect(activated.productVersion).toBe("0.8.1");
    const status = await runComponentStatus({
      ...initial,
      controlPlaneVersion: "0.8.1"
    });
    expect(status.components.base).toBe("active");
  });

  it("installs a signed exact-version remote source only when explicitly requested", async () => {
    const signed = await signedOfflineSource("0.9.0");
    fixtures.push(signed.fixture);
    const archive = readFileSync(signed.fixture.input.archivePath);
    const urls = {
      manifest: "https://artifacts.example/base.manifest.json",
      signature: "https://artifacts.example/base.signature.json",
      archive: "https://artifacts.example/base.tar.gz"
    };
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        const body =
          url === urls.manifest
            ? signed.fixture.input.manifestBytes
            : url === urls.signature
              ? Buffer.from(JSON.stringify(signed.fixture.input.signature))
              : archive;
        return new Response(new Uint8Array(body), { status: 200 });
      })
    );
    const current = context({
      runtime: signed.runtime,
      target: signed.target,
      controlPlaneVersion: "0.9.0"
    });
    const result = await runComponentInstall(current, {
      component: "base",
      version: "0.9.0",
      source: {
        kind: "remote",
        manifestUrl: urls.manifest,
        signatureUrl: urls.signature,
        archiveUrl: urls.archive
      }
    });
    expect(result.state).toBe("active");
    expect(requested).toEqual([urls.manifest, urls.signature, urls.archive]);
  });

  it("never activates during install while services are running", async () => {
    const signed = await signedOfflineSource("0.9.0");
    fixtures.push(signed.fixture);
    const running = context({
      runtime: signed.runtime,
      target: signed.target,
      controlPlaneVersion: "0.9.0",
      isRunning: true
    });
    const result = await runComponentInstall(running, {
      component: "base",
      source: signed.source
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

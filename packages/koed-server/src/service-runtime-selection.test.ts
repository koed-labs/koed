import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactTarget, RuntimeIdentity } from "./component-contract.js";

const fixtureRuntime = vi.hoisted(() => ({
  value: undefined as RuntimeIdentity | undefined
}));
const fixtureKeys = vi.hoisted(() => ({ value: new Map<string, string>() }));
vi.mock("./component-runtime-identity.js", () => ({
  discoverActualRuntimeIdentity: () => {
    if (!fixtureRuntime.value) throw new Error("fixture runtime missing");
    return fixtureRuntime.value;
  }
}));
vi.mock("./component-trust-roots.js", () => ({
  productionComponentTrustRoots: fixtureKeys.value
}));

import { signedComponentFixture } from "./component-test-fixtures.js";
import * as appRuntime from "./app-runtime.js";
import { collectKoedServerStatus } from "./status.js";
import { createDesktopStatusRpcHandler } from "./desktop-status-rpc.js";
import { stageComponent, stageGeneration } from "./component-store.js";
import { activateGeneration } from "./generation-lifecycle.js";
import {
  resolveKoedControlPlaneVersion,
  resolveKoedRuntimeOwner
} from "./app-runtime.js";
import { resolveKoedServerPaths } from "./paths.js";
import { pinAndResolvePackagedRuntime } from "./service-runtime-selection.js";
import {
  readCurrentDesktopGeneration,
  readCurrentGeneration
} from "./generation-lifecycle.js";
import { runComponentStatus } from "./component-commands.js";
import {
  resolveDesktopRuntimeOwner,
  verifyDesktopRuntimeBundle
} from "./desktop-runtime-capability.js";
import { resolveVerifiedPackagedRuntime } from "./service-runtime-selection.js";
import {
  acquireKoedServerSupervisorLock,
  releaseKoedServerSupervisorLock
} from "./supervisor-lock.js";

const roots: string[] = [];
const initialCwd = process.cwd();
const tempDir = () => {
  const path = mkdtempSync(resolve(process.cwd(), ".koed-service-selection-"));
  roots.push(path);
  return path;
};
const requiredFiles = [
  "api/dist/index.js",
  "worker/dist/index.js",
  "embedding-service/dist/index.js",
  "mcp-server/dist/cli.js",
  "mcp-server/dist/local-runtime-cli.js",
  "mcp-server/dist/capture-hook.js",
  "node_modules/@koed/db/dist/index.js",
  "node_modules/@koed/db/dist/connection.js",
  "node_modules/@koed/db/dist/user-api-token-repository.js",
  "node_modules/@koed/db/drizzle/meta/_journal.json"
];
const requirements = {
  components: ["base"] as const,
  processes: [
    "api",
    "worker",
    "local-ai-runtime",
    "embedding-service"
  ] as const,
  queue: "local" as const,
  native: [],
  models: []
};
const makeGeneration = async (
  root: string,
  productVersion: string,
  owner = resolveKoedRuntimeOwner()
) => {
  const paths = resolveKoedServerPaths({
    KOED_HOME: root,
    KOED_REPO_ROOT: root
  });
  mkdirSync(paths.componentsDir, { recursive: true, mode: 0o700 });
  const target: ArtifactTarget = { platform: "linux", architecture: "x64" };
  const fixture = await signedComponentFixture(
    { productVersion, component: "base", requiredFiles, target },
    requiredFiles.map((path) => ({ path })),
    {},
    true
  );
  fixtureRuntime.value = fixture.input.runtime;
  for (const [key, value] of fixture.input.trustedKeys)
    fixtureKeys.value.set(key, value);
  const metadataPath = (name: string, data: Buffer) => {
    const path = resolve(root, name);
    writeFileSync(path, data, { mode: 0o600 });
    return path;
  };
  const base = await stageComponent(
    paths,
    {
      kind: "offline",
      archivePath: fixture.input.archivePath,
      manifestPath: metadataPath("manifest.json", fixture.input.manifestBytes),
      signaturePath: metadataPath(
        "signature.json",
        Buffer.from(JSON.stringify(fixture.input.signature))
      )
    },
    {
      expectedComponent: "base",
      expectedVersion: productVersion,
      target,
      runtime: fixture.input.runtime
    }
  );
  const generation = await stageGeneration(paths, { base, owner });
  await activateGeneration(paths, generation.id, owner);
  return paths;
};

afterEach(() => {
  process.chdir(initialCwd);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  fixtureRuntime.value = undefined;
  fixtureKeys.value.clear();
  vi.restoreAllMocks();
});

describe("packaged service runtime selection", () => {
  it("admits and pins verified Desktop bundle on fresh KOED_HOME", async () => {
    const root = tempDir();
    const resourcesPath = resolve(root, "resources");
    const runtimeRoot = resolve(resourcesPath, "koed-runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    const files = requiredFiles.map((path) => {
      const absolute = resolve(runtimeRoot, path);
      mkdirSync(resolve(absolute, ".."), { recursive: true });
      writeFileSync(absolute, "bundled runtime");
      return {
        path,
        kind: "file",
        sha256: createHash("sha256").update("bundled runtime").digest("hex")
      };
    });
    writeFileSync(
      resolve(runtimeRoot, "desktop-bundle-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        productVersion: resolveKoedControlPlaneVersion(),
        component: "base",
        target: {
          platform: process.platform === "darwin" ? "macos" : process.platform,
          architecture: process.arch
        },
        files
      })
    );
    const capability = verifyDesktopRuntimeBundle(resourcesPath);
    const paths = resolveKoedServerPaths({
      KOED_HOME: resolve(root, "koed-home")
    });
    const supervisor = acquireKoedServerSupervisorLock(paths);
    expect(supervisor.acquired).toBe(true);
    const selection = await pinAndResolvePackagedRuntime(
      paths,
      {},
      requirements,
      existsSync,
      capability
    );
    vi.spyOn(appRuntime, "resolveKoedAppRuntimeExecution").mockReturnValue(
      "packaged"
    );
    const environment = {
      KOED_HOME: paths.koedHome,
      KOED_AUTO_PORTS: "1"
    };
    const dependencies = {
      spawnSync: vi.fn(() => ({
        status: 0,
        stdout: "{}",
        stderr: "",
        pid: 0,
        output: [],
        signal: null
      })),
      resolveCodexExecutable: () => {
        throw new Error("not installed");
      },
      resolveClaudeExecutable: () => {
        throw new Error("not installed");
      },
      resolvePiExecutable: () => {
        throw new Error("not installed");
      }
    };
    const standaloneStatus = await collectKoedServerStatus(
      environment,
      dependencies
    );
    expect(standaloneStatus.mcpServer.state).toBe("not_configured");
    const desktopStatus = await collectKoedServerStatus(environment, {
      ...dependencies,
      desktopRuntimeCapability: capability
    });
    expect(desktopStatus.mcpServer).toMatchObject({
      state: "healthy",
      details: { runtimeRoot }
    });
    const send = vi.fn<(message: Record<string, unknown>) => void>();
    const handle = createDesktopStatusRpcHandler({
      nonce: "a".repeat(64),
      capability,
      environment,
      send
    });
    const request = {
      type: "koed.desktop.status.request",
      nonce: "a".repeat(64),
      requestId: "11111111-1111-4111-8111-111111111111",
      action: "status",
      startup: true
    };
    expect(handle({ ...request, nonce: "b".repeat(64) })).toBe(false);
    expect(handle({ ...request, action: "constructor" })).toBe(false);
    expect(
      handle({
        ...request,
        environment: { KOED_PACKAGED_RESOURCES_PATH: resourcesPath }
      })
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(handle(request)).toBe(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: "koed.desktop.status.response",
      nonce: request.nonce,
      requestId: request.requestId,
      action: "status",
      result: { koedHome: paths.koedHome }
    });
    expect(selection.runtime.root).toBe(runtimeRoot);
    expect(selection.runtime.apiEntry).toBe(
      resolve(runtimeRoot, "api/dist/index.js")
    );
    expect(selection.pin.generation.base.manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "api/dist/index.js",
          sha256: createHash("sha256").update("bundled runtime").digest("hex")
        })
      ])
    );
    expect(selection.pin.generation.owner).toEqual(
      resolveDesktopRuntimeOwner(capability, paths.koedHome)
    );
    expect(readFileSync(paths.generationStatePath!, "utf8")).toContain(
      "desktop-bundle"
    );
    await expect(readCurrentGeneration(paths)).rejects.toThrow();
    await selection.pin.release();
    const restarted = await pinAndResolvePackagedRuntime(
      paths,
      {},
      requirements,
      existsSync,
      capability
    );
    expect(restarted.pin.generation.id).toBe(selection.pin.generation.id);
    const active = await readCurrentDesktopGeneration(paths, capability);
    expect(active.id).toBe(selection.pin.generation.id);
    const runtime: RuntimeIdentity = {
      kind: "node",
      version: process.versions.node,
      nodeVersion: process.versions.node,
      modulesAbi: process.versions.modules,
      napiVersion: Number(process.versions.napi),
      platform: process.platform === "darwin" ? "macos" : "linux",
      architecture: process.arch as "arm64" | "x64"
    };
    const status = await runComponentStatus({
      paths,
      controlPlaneVersion: capability.productVersion,
      target: capability.target,
      runtime,
      owner: active.owner,
      desktopRuntimeCapability: capability,
      isRunning: false,
      execution: "packaged",
      environment: {}
    });
    expect(status.activeGeneration).toBe(active.id);
    expect(status.components.base).toBe("active");
    await restarted.pin.release();
    expect(releaseKoedServerSupervisorLock(supervisor)).toBe(true);
    await activateGeneration(paths, active.id, active.owner, capability);
    const foreignOwner = resolveKoedRuntimeOwner();
    rmSync(resolve(paths.componentsDir, "current.json"));
    const foreignPaths = await makeGeneration(
      paths.koedHome,
      capability.productVersion,
      foreignOwner
    );
    const foreignPointer = readFileSync(
      resolve(foreignPaths.componentsDir, "current.json"),
      "utf8"
    );
    await expect(
      pinAndResolvePackagedRuntime(
        paths,
        {},
        requirements,
        existsSync,
        capability
      )
    ).rejects.toThrow(/owner/);
    expect(
      readFileSync(resolve(paths.componentsDir, "current.json"), "utf8")
    ).toBe(foreignPointer);
    expect(existsSync(paths.generationStatePath!)).toBe(false);
    // Restore the verified Desktop selection before checking bundle tampering.
    writeFileSync(
      resolve(paths.componentsDir, "current.json"),
      JSON.stringify({ schemaVersion: 1, generationId: active.id })
    );
    writeFileSync(resolve(runtimeRoot, requiredFiles[0]!), "tampered");
    await expect(
      resolveVerifiedPackagedRuntime(
        paths,
        {},
        requirements,
        existsSync,
        capability
      )
    ).rejects.toThrow("Desktop runtime bundle file digest mismatch");
  });

  it("rejects caller-constructed Desktop capability before selecting a generation", async () => {
    const paths = resolveKoedServerPaths({ KOED_HOME: tempDir() });
    await expect(
      resolveVerifiedPackagedRuntime(paths, {}, requirements, existsSync, {
        resourcesPath: "/untrusted",
        productVersion: "1.2.3",
        bundleDigest: "0".repeat(64)
      } as never)
    ).rejects.toThrow(
      "validated private Desktop runtime capability is required"
    );
  });

  it("resolves authenticated runtime without creating a generation pin", async () => {
    const root = tempDir();
    const paths = await makeGeneration(root, resolveKoedControlPlaneVersion());
    const runtime = await resolveVerifiedPackagedRuntime(
      paths,
      {},
      requirements
    );

    expect(runtime.apiEntry).toBe(resolve(runtime.root, "api/dist/index.js"));
    expect(() => readFileSync(paths.generationStatePath!, "utf8")).toThrow();
  });

  it("pins a verified generation after supervisor acquires its startup lock", async () => {
    const root = tempDir();
    const paths = await makeGeneration(root, resolveKoedControlPlaneVersion());
    expect(acquireKoedServerSupervisorLock(paths).acquired).toBe(true);
    const selection = await pinAndResolvePackagedRuntime(
      paths,
      {},
      requirements
    );

    expect(selection.runtime.apiEntry).toBe(
      resolve(selection.runtime.root, "api/dist/index.js")
    );
    expect(readFileSync(paths.generationStatePath!, "utf8")).toContain(
      selection.pin.generation.id
    );
    expect((await readCurrentGeneration(paths)).id).toBe(
      selection.pin.generation.id
    );

    await selection.pin.release();
    expect(() => readFileSync(paths.generationStatePath!, "utf8")).toThrow();
  });

  it("releases pin when control-plane version mismatches", async () => {
    const root = tempDir();
    const paths = await makeGeneration(root, "999.0.0");

    await expect(
      pinAndResolvePackagedRuntime(paths, {}, requirements)
    ).rejects.toThrow(/does not match Koed server control plane/);
    expect(() => readFileSync(paths.generationStatePath!, "utf8")).toThrow();
  });

  it("never spawns a current-directory MCP artifact without a verified generation", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    process.chdir(root);
    const paths = resolveKoedServerPaths({
      KOED_HOME: resolve(root, "koed"),
      KOED_REPO_ROOT: root
    });
    const spawn = vi.fn();
    const launch = async () => {
      const runtime = await resolveVerifiedPackagedRuntime(
        paths,
        {},
        requirements
      );
      spawn(process.execPath, [runtime.mcpCli]);
    };

    await expect(launch()).rejects.toThrow("no active runtime generation");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails without active verified generation and does not provision one", async () => {
    const root = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: root,
      KOED_REPO_ROOT: root
    });
    mkdirSync(paths.koedHome, { recursive: true });

    await expect(
      pinAndResolvePackagedRuntime(paths, {}, requirements)
    ).rejects.toThrow("no active runtime generation");
    expect(existsSync(resolve(paths.componentsDir, "current.json"))).toBe(
      false
    );
  });
});

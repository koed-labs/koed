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
import type { RuntimeIdentity } from "./component-contract.js";

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
import { stageComponent, stageGeneration } from "./component-store.js";
import { activateGeneration } from "./generation-lifecycle.js";
import {
  resolveKoedControlPlaneVersion,
  resolveKoedRuntimeOwner
} from "./app-runtime.js";
import { resolveKoedServerPaths } from "./paths.js";
import { pinAndResolvePackagedRuntime } from "./service-runtime-selection.js";
import { readCurrentGeneration } from "./generation-lifecycle.js";
import { resolveVerifiedPackagedRuntime } from "./service-runtime-selection.js";

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
const makeGeneration = async (root: string, productVersion: string) => {
  const paths = resolveKoedServerPaths({
    KOED_HOME: root,
    KOED_REPO_ROOT: root
  });
  mkdirSync(paths.componentsDir, { recursive: true, mode: 0o700 });
  const fixture = await signedComponentFixture(
    { productVersion, component: "base", requiredFiles },
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
      expectedVersion: fixture.input.expectedVersion,
      target: fixture.input.target,
      runtime: fixture.input.runtime
    }
  );
  const generation = await stageGeneration(paths, {
    base,
    owner: resolveKoedRuntimeOwner()
  });
  await activateGeneration(paths, generation.id, resolveKoedRuntimeOwner());
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

  it("pins a verified generation until supervisor releases it", async () => {
    const root = tempDir();
    const paths = await makeGeneration(root, resolveKoedControlPlaneVersion());
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

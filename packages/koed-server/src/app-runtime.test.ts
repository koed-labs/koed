import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
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

import type { RuntimeRequirements } from "./component-contract.js";
import {
  assertKoedAppRuntimeAvailable,
  resolveKoedAppRuntime,
  resolveKoedAppRuntimeForExecution
} from "./app-runtime.js";
import { signedComponentFixture } from "./component-test-fixtures.js";
import { stageComponent, stageGeneration } from "./component-store.js";
import type { KoedServerPaths } from "./paths.js";
import { resolveKoedServerPaths } from "./paths.js";

const temps: string[] = [];
const tempDir = () => {
  const root = mkdtempSync(resolve(process.cwd(), ".koed-app-runtime-"));
  temps.push(root);
  return root;
};
const owner = { kind: "standalone" as const, installationId: "runtime-test" };
const packagedRuntime = (
  rootPaths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  selection?: Parameters<typeof resolveKoedAppRuntimeForExecution>[3],
  requirements?: RuntimeRequirements
) =>
  resolveKoedAppRuntimeForExecution(
    rootPaths,
    environment,
    existsSync,
    selection,
    requirements,
    "packaged"
  );
const paths = (root: string): KoedServerPaths =>
  resolveKoedServerPaths({ KOED_HOME: root, KOED_REPO_ROOT: root });
const baseEntries = [
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
const baseRequirements: RuntimeRequirements = {
  components: ["base"],
  processes: ["api", "worker", "local-ai-runtime", "embedding-service"],
  queue: "local",
  native: [],
  models: []
};
const temporaryMetadata = (root: string, bytes: Buffer): string => {
  const path = resolve(root, `metadata-${Math.random()}.json`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
};
const verifiedGeneration = async (root: string, includePrivacy = false) => {
  mkdirSync(paths(root).componentsDir, { recursive: true, mode: 0o700 });
  const stage = async (
    component: "base" | "privacy",
    requiredFiles: string[]
  ) => {
    const productVersion = "0.8.1";
    const target: ArtifactTarget = { platform: "linux", architecture: "x64" };
    const fixture = await signedComponentFixture(
      { component, requiredFiles, productVersion, target },
      requiredFiles.map((path) => ({ path })),
      {},
      true
    );
    fixtureRuntime.value = fixture.input.runtime;
    for (const [key, value] of fixture.input.trustedKeys)
      fixtureKeys.value.set(key, value);
    const staged = await stageComponent(
      paths(root),
      {
        kind: "offline",
        archivePath: fixture.input.archivePath,
        manifestPath: temporaryMetadata(root, fixture.input.manifestBytes),
        signaturePath: temporaryMetadata(
          root,
          Buffer.from(JSON.stringify(fixture.input.signature))
        )
      },
      {
        expectedComponent: component,
        expectedVersion: productVersion,
        target,
        runtime: fixture.input.runtime
      }
    );
    return staged;
  };
  const base = await stage("base", baseEntries);
  const privacy = includePrivacy
    ? await stage("privacy", ["privacy-service/dist/index.js"])
    : undefined;
  const generation = await stageGeneration(paths(root), {
    base,
    ...(privacy ? { privacy } : {}),
    owner
  });
  return { generation };
};

afterEach(() => {
  for (const path of temps.splice(0))
    rmSync(path, { recursive: true, force: true });
  fixtureRuntime.value = undefined;
  fixtureKeys.value.clear();
  vi.restoreAllMocks();
});

describe("Koed app runtime resolution", () => {
  it.each([
    ["KOED_JS_RUNTIME_ROOT", "/tmp/untrusted"],
    ["KOED_REPO_ROOT", "/tmp/untrusted"],
    ["KOED_PACKAGED_RESOURCES_PATH", "/tmp/untrusted"],
    ["KOED_ALLOW_PACKAGED_SOURCE_FALLBACK", "1"]
  ])("rejects packaged resolution with caller override %s", (name, value) => {
    const root = tempDir();
    expect(() =>
      packagedRuntime(paths(root), {
        KOED_PACKAGED_EXECUTION: "1",
        KOED_SERVER_PACKAGE_ROOT: "/tmp/control",
        [name]: value
      })
    ).toThrow(/unsupported packaged runtime override/i);
  });

  it("fails closed when no verified generation is selected", () => {
    const root = tempDir();
    const runtime = packagedRuntime(
      paths(root),
      {
        KOED_PACKAGED_EXECUTION: "1",
        KOED_SERVER_PACKAGE_ROOT: "/tmp/control"
      },
      undefined,
      baseRequirements
    );
    expect(runtime.kind).toBe("packaged");
    expect(runtime.missing).toContain("authenticated base generation");
    expect(() => assertKoedAppRuntimeAvailable(runtime, paths(root))).toThrow(
      /authenticated base generation/
    );
  });

  it("resolves services only from authenticated component roots", async () => {
    const root = tempDir();
    const { generation } = await verifiedGeneration(root, true);
    const runtime = packagedRuntime(
      paths(root),
      { KOED_SERVER_PACKAGE_ROOT: "/tmp/control" },
      generation,
      {
        ...baseRequirements,
        components: ["base", "privacy"],
        processes: [...baseRequirements.processes, "privacy-service"]
      }
    );
    expect(runtime.root).toBe(generation.base.root);
    expect(runtime.apiEntry).toBe(
      resolve(generation.base.root, "api/dist/index.js")
    );
    expect(runtime.privacyServiceEntry).toBe(
      resolve(generation.privacy!.root, "privacy-service/dist/index.js")
    );
    expect(runtime.missing).toEqual([]);
  });

  it("does not require privacy files for Personal base-only configuration", async () => {
    const root = tempDir();
    const { generation } = await verifiedGeneration(root, false);
    const runtime = packagedRuntime(
      paths(root),
      {},
      generation,
      baseRequirements
    );
    expect(runtime.privacyServiceEntry).toBeUndefined();
    expect(runtime.missing).toEqual([]);
  });

  it("keeps source runtime available only through explicit source execution", () => {
    const root = tempDir();
    for (const entry of [
      "scripts/setup-env.mjs",
      "apps/api/package.json",
      "apps/worker/package.json",
      "apps/privacy-service/package.json",
      "packages/db/package.json",
      "packages/mcp-server/package.json"
    ]) {
      const path = resolve(root, entry);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{}");
    }
    const runtime = resolveKoedAppRuntime(paths(root));
    expect(runtime.kind).toBe("source");
    expect(runtime.root).toBe(root);
    expect(runtime.missing).toEqual([]);
  });
});

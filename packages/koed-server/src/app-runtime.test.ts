import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertKoedAppRuntimeAvailable,
  resolveKoedAppRuntime
} from "./app-runtime.js";
import type { KoedServerPaths } from "./paths.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-app-runtime-"));
  temps.push(path);
  return path;
};

const paths = (root: string): KoedServerPaths => ({
  koedHome: root,
  configDir: resolve(root, "config"),
  logsDir: resolve(root, "logs"),
  runDir: resolve(root, "run"),
  dataDir: resolve(root, "data"),
  modelsDir: resolve(root, "models"),
  cacheDir: resolve(root, "cache"),
  postgresDataDir: resolve(root, "data", "postgres"),
  postgresRunDir: resolve(root, "run", "postgres"),
  postgresLogPath: resolve(root, "logs", "postgres.log"),
  runtimeStatePath: resolve(root, "run", "koed-server.json"),
  lastVerificationPath: resolve(root, "run", "last-verification.json"),
  serverConfigPath: resolve(root, "config", "server.json"),
  localPortsPath: resolve(root, "config", "local-ports.json"),
  explorerTokenPath: resolve(root, "config", "explorer-token.json"),
  upstreamBackendsPath: resolve(root, "config", "upstream-backends.json"),
  projectTeamWorkspaceLinksPath: resolve(
    root,
    "config",
    "project-team-workspaces.json"
  ),
  upstreamEnrollmentsPath: resolve(root, "run", "upstream-enrollments.json"),
  repoRoot: root
});

const touch = (path: string) => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, "");
};

const createPackagedRuntime = (root: string) => {
  for (const entry of [
    "koed-runtime/api/dist/index.js",
    "koed-runtime/worker/dist/index.js",
    "koed-runtime/embedding-service/dist/index.js",
    "koed-runtime/explorer-dist/index.html",
    "koed-runtime/mcp-server/dist/cli.js",
    "koed-runtime/mcp-server/dist/capture-hook.js",
    "koed-runtime/api/node_modules/@koed/db/dist/index.js",
    "koed-runtime/api/node_modules/@koed/db/drizzle/meta/_journal.json"
  ]) {
    touch(resolve(root, entry));
  }
};

const createKoedHomeRuntime = (root: string) => {
  for (const entry of [
    "runtime/koed-runtime/api/dist/index.js",
    "runtime/koed-runtime/worker/dist/index.js",
    "runtime/koed-runtime/embedding-service/dist/index.js",
    "runtime/koed-runtime/explorer-dist/index.html",
    "runtime/koed-runtime/mcp-server/dist/cli.js",
    "runtime/koed-runtime/mcp-server/dist/capture-hook.js",
    "runtime/koed-runtime/api/node_modules/@koed/db/dist/index.js",
    "runtime/koed-runtime/api/node_modules/@koed/db/drizzle/meta/_journal.json"
  ]) {
    touch(resolve(root, entry));
  }
};

const createSourceCheckout = (root: string) => {
  for (const entry of [
    "scripts/setup-env.mjs",
    "apps/api/package.json",
    "apps/worker/package.json",
    "apps/embedding-service/package.json",
    "apps/explorer/package.json",
    "packages/db/package.json",
    "packages/mcp-server/package.json"
  ]) {
    touch(resolve(root, entry));
  }
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Koed app runtime resolution", () => {
  it("resolves packaged Desktop JS runtime artifacts from resources with KOED_REPO_ROOT unset", () => {
    const root = tempDir();
    createPackagedRuntime(root);
    const appPaths = { ...paths(root), repoRoot: resolve(root, "app.asar") };

    const runtime = resolveKoedAppRuntime(appPaths, {
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root
    });

    expect(runtime.kind).toBe("packaged");
    expect(runtime.artifactSource).toBe("packaged-resource");
    expect(runtime.missing).toEqual([]);
    expect(runtime.apiEntry).toBe(
      resolve(root, "koed-runtime/api/dist/index.js")
    );
    expect(runtime.mcpCli).toBe(
      resolve(root, "koed-runtime/mcp-server/dist/cli.js")
    );
    expect(runtime.embeddingServiceEntry).toBe(
      resolve(root, "koed-runtime/embedding-service/dist/index.js")
    );
  });

  it("requires packaged Embedding Service entry", () => {
    const root = tempDir();
    createPackagedRuntime(root);
    rmSync(resolve(root, "koed-runtime", "embedding-service"), {
      recursive: true,
      force: true
    });

    const runtime = resolveKoedAppRuntime(paths(root), {
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root
    });

    expect(runtime.kind).toBe("packaged");
    expect(runtime.missing).toContain(
      resolve(root, "koed-runtime/embedding-service/dist/index.js")
    );
    expect(() => assertKoedAppRuntimeAvailable(runtime, paths(root))).toThrow(
      "Embedding Service"
    );
  });

  it("reports actionable missing packaged resources", () => {
    const root = tempDir();
    const runtime = resolveKoedAppRuntime(paths(root), {
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root
    });

    expect(() => assertKoedAppRuntimeAvailable(runtime, paths(root))).toThrow(
      "Packaged Koed JS runtime artifacts are missing."
    );
    expect(runtime.missing).toContain(
      resolve(root, "koed-runtime/api/dist/index.js")
    );
  });

  it("prefers KOED_HOME JS runtime before packaged resources", () => {
    const root = tempDir();
    createKoedHomeRuntime(root);
    createPackagedRuntime(root);

    const runtime = resolveKoedAppRuntime(paths(root), {
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root
    });

    expect(runtime.artifactSource).toBe("koed-home-runtime");
    expect(runtime.root).toBe(resolve(root, "runtime", "koed-runtime"));
  });

  it("keeps source checkout fallback for development", () => {
    const root = tempDir();
    createSourceCheckout(root);

    const runtime = resolveKoedAppRuntime(paths(root), {});

    expect(runtime.kind).toBe("source");
    expect(runtime.missing).toEqual([]);
    expect(runtime.workerEntry).toBe(
      resolve(root, "apps/worker/dist/index.js")
    );
    expect(runtime.embeddingServiceEntry).toBe(
      resolve(root, "apps/embedding-service/dist/index.js")
    );
  });

  it("rejects packaged source checkout fallback without developer override", () => {
    const root = tempDir();
    createSourceCheckout(root);

    const runtime = resolveKoedAppRuntime(paths(root), {
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root
    });

    expect(runtime.kind).toBe("packaged");
    expect(runtime.artifactSource).toBe("packaged-resource");
    expect(runtime.missing).toContain(
      resolve(root, "koed-runtime/api/dist/index.js")
    );
  });

  it("allows packaged source checkout fallback with explicit developer override", () => {
    const root = tempDir();
    createSourceCheckout(root);

    const runtime = resolveKoedAppRuntime(paths(root), {
      KOED_PACKAGED_DESKTOP: "1",
      KOED_ALLOW_PACKAGED_SOURCE_FALLBACK: "1",
      KOED_PACKAGED_RESOURCES_PATH: root
    });

    expect(runtime.kind).toBe("source");
    expect(runtime.artifactSource).toBe("source-checkout");
  });
});

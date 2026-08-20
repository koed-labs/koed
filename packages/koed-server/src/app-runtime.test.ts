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
  localAppCredentialPath: resolve(root, "config", "local-app-credential.json"),
  upstreamBackendsPath: resolve(root, "config", "upstream-backends.json"),
  projectMetadataPath: resolve(root, "config", "projects.json"),
  projectTeamWorkspaceLinksPath: resolve(
    root,
    "config",
    "project-team-workspaces.json"
  ),
  upstreamEnrollmentsPath: resolve(root, "run", "upstream-enrollments.json"),
  upstreamDisconnectCleanupPath: resolve(
    root,
    "run",
    "upstream-disconnect-cleanup.json"
  ),
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
    "koed-runtime/mcp-server/dist/cli.js",
    "koed-runtime/mcp-server/dist/local-runtime-cli.js",
    "koed-runtime/mcp-server/dist/capture-hook.js",
    "koed-runtime/api/node_modules/@koed/db/dist/index.js",
    "koed-runtime/api/node_modules/@koed/db/dist/connection.js",
    "koed-runtime/api/node_modules/@koed/db/dist/user-api-token-repository.js",
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
    "runtime/koed-runtime/mcp-server/dist/cli.js",
    "runtime/koed-runtime/mcp-server/dist/local-runtime-cli.js",
    "runtime/koed-runtime/mcp-server/dist/capture-hook.js",
    "runtime/koed-runtime/api/node_modules/@koed/db/dist/index.js",
    "runtime/koed-runtime/api/node_modules/@koed/db/dist/connection.js",
    "runtime/koed-runtime/api/node_modules/@koed/db/dist/user-api-token-repository.js",
    "runtime/koed-runtime/api/node_modules/@koed/db/drizzle/meta/_journal.json"
  ]) {
    touch(resolve(root, entry));
  }
};

const createKoedHomeServerPackageRuntime = (root: string) => {
  for (const entry of [
    "runtime/koed-server/current/koed-runtime/api/dist/index.js",
    "runtime/koed-server/current/koed-runtime/worker/dist/index.js",
    "runtime/koed-server/current/koed-runtime/embedding-service/dist/index.js",
    "runtime/koed-server/current/koed-runtime/mcp-server/dist/cli.js",
    "runtime/koed-server/current/koed-runtime/mcp-server/dist/local-runtime-cli.js",
    "runtime/koed-server/current/koed-runtime/mcp-server/dist/capture-hook.js",
    "runtime/koed-server/current/koed-runtime/api/node_modules/@koed/db/dist/index.js",
    "runtime/koed-server/current/koed-runtime/api/node_modules/@koed/db/dist/connection.js",
    "runtime/koed-server/current/koed-runtime/api/node_modules/@koed/db/dist/user-api-token-repository.js",
    "runtime/koed-server/current/koed-runtime/api/node_modules/@koed/db/drizzle/meta/_journal.json"
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

  it("prefers KOED_SERVER_PACKAGE_ROOT before KOED_JS_RUNTIME_ROOT", () => {
    const root = tempDir();
    const packageRoot = resolve(root, "server-package");
    const runtimeRoot = resolve(root, "js-runtime");
    createPackagedRuntime(packageRoot);
    createPackagedRuntime(runtimeRoot);

    const runtime = resolveKoedAppRuntime(paths(root), {
      KOED_SERVER_PACKAGE_ROOT: packageRoot,
      KOED_JS_RUNTIME_ROOT: resolve(runtimeRoot, "koed-runtime")
    });

    expect(runtime.kind).toBe("packaged");
    expect(runtime.artifactSource).toBe("explicit-override");
    expect(runtime.root).toBe(resolve(packageRoot, "koed-runtime"));
  });

  it("uses explicit KOED_JS_RUNTIME_ROOT before KOED_HOME runtimes", () => {
    const root = tempDir();
    const runtimeRoot = resolve(root, "js-runtime");
    createPackagedRuntime(runtimeRoot);
    createKoedHomeServerPackageRuntime(root);

    const runtime = resolveKoedAppRuntime(paths(root), {
      KOED_JS_RUNTIME_ROOT: resolve(runtimeRoot, "koed-runtime")
    });

    expect(runtime.artifactSource).toBe("explicit-override");
    expect(runtime.root).toBe(resolve(runtimeRoot, "koed-runtime"));
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

  it("prefers standalone KOED_HOME server package runtime before legacy KOED_HOME runtime and packaged resources", () => {
    const root = tempDir();
    createKoedHomeServerPackageRuntime(root);
    createKoedHomeRuntime(root);
    createPackagedRuntime(root);

    const runtime = resolveKoedAppRuntime(paths(root), {
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root
    });

    expect(runtime.artifactSource).toBe("koed-home-runtime");
    expect(runtime.root).toBe(
      resolve(root, "runtime", "koed-server", "current", "koed-runtime")
    );
  });

  it("uses legacy KOED_HOME JS runtime before packaged resources when standalone current is missing", () => {
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

  it("uses legacy KOED_HOME JS runtime when standalone current is missing the Embedding Service entry", () => {
    const root = tempDir();
    createKoedHomeServerPackageRuntime(root);
    rmSync(
      resolve(
        root,
        "runtime",
        "koed-server",
        "current",
        "koed-runtime",
        "embedding-service"
      ),
      { recursive: true, force: true }
    );
    createKoedHomeRuntime(root);

    const runtime = resolveKoedAppRuntime(paths(root), {
      KOED_PACKAGED_DESKTOP: "1"
    });

    expect(runtime.artifactSource).toBe("koed-home-runtime");
    expect(runtime.root).toBe(resolve(root, "runtime", "koed-runtime"));
    expect(runtime.missing).toEqual([]);
  });

  it("reports broken standalone current before source checkout in packaged mode", () => {
    const root = tempDir();
    createKoedHomeServerPackageRuntime(root);
    rmSync(
      resolve(
        root,
        "runtime",
        "koed-server",
        "current",
        "koed-runtime",
        "embedding-service"
      ),
      { recursive: true, force: true }
    );
    createSourceCheckout(root);

    const runtime = resolveKoedAppRuntime(paths(root), {
      KOED_PACKAGED_DESKTOP: "1"
    });

    expect(runtime.kind).toBe("packaged");
    expect(runtime.artifactSource).toBe("koed-home-runtime");
    expect(runtime.root).toBe(
      resolve(root, "runtime", "koed-server", "current", "koed-runtime")
    );
    expect(runtime.missing).toContain(
      resolve(
        root,
        "runtime",
        "koed-server",
        "current",
        "koed-runtime",
        "embedding-service",
        "dist",
        "index.js"
      )
    );
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

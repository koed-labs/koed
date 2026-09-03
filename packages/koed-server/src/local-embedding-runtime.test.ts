import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectLocalEmbeddingRuntimeStatus,
  localEmbeddingEnv,
  localEmbeddingRuntimeAvailable,
  resolveBundledEmbeddingMode,
  resolveLocalEmbeddingRuntimePaths,
  startLocalEmbeddingRuntime
} from "./local-embedding-runtime.js";
import type { KoedServerPaths } from "./paths.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-local-embedding-"));
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

const response = (ok: boolean, status: number, body: unknown): Response =>
  ({ ok, status, text: async () => JSON.stringify(body) }) as Response;

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("local Embedding Service runtime", () => {
  it("resolves default native paths under KOED_HOME runtime", () => {
    const root = tempDir();
    const runtime = resolveLocalEmbeddingRuntimePaths(paths(root), {});

    expect(runtime.appDir).toBe(resolve(root, "runtime", "embedding-service"));
    expect(runtime.serviceEntry).toBe(
      resolve(root, "runtime", "embedding-service", "dist", "index.js")
    );
    expect(runtime.llamaServerBin).toBe(
      resolve(root, "runtime", "llama.cpp", "llama-server")
    );
    expect(runtime.healthUrl).toBe("http://127.0.0.1:3800/health");
    expect(localEmbeddingEnv(runtime).EMBEDDING_SERVICE_URL).toBe(
      "http://127.0.0.1:3800"
    );
    expect(localEmbeddingEnv(runtime).EMBEDDING_SERVICE_HOST).toBe("127.0.0.1");
    expect(localEmbeddingEnv(runtime).EMBEDDING_SERVICE_PORT).toBe("3800");
  });

  it("prefers packaged Embedding Service resources over source checkout in packaged mode", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "koed-runtime", "embedding-service"), {
      recursive: true
    });
    mkdirSync(resolve(root, "koed-runtime", "llama.cpp"), { recursive: true });
    mkdirSync(resolve(root, "apps", "embedding-service"), { recursive: true });
    mkdirSync(resolve(root, "vendor", "llama.cpp"), { recursive: true });
    mkdirSync(resolve(root, "koed-runtime", "embedding-service", "dist"), {
      recursive: true
    });
    writeFileSync(
      resolve(root, "koed-runtime", "embedding-service", "dist", "index.js"),
      ""
    );
    writeFileSync(
      resolve(root, "koed-runtime", "llama.cpp", "llama-server"),
      ""
    );
    mkdirSync(resolve(root, "apps", "embedding-service", "dist"), {
      recursive: true
    });
    writeFileSync(
      resolve(root, "apps", "embedding-service", "dist", "index.js"),
      ""
    );
    writeFileSync(resolve(root, "vendor", "llama.cpp", "llama-server"), "");

    const runtime = resolveLocalEmbeddingRuntimePaths(paths(root), {
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root
    });

    expect(runtime.artifactSource).toBe("packaged-resource");
    expect(runtime.appDir).toBe(
      resolve(root, "koed-runtime", "embedding-service")
    );
    expect(runtime.serviceEntry).toBe(
      resolve(root, "koed-runtime", "embedding-service", "dist", "index.js")
    );
    expect(runtime.llamaServerBin).toBe(
      resolve(root, "koed-runtime", "llama.cpp", "llama-server")
    );
  });

  it("uses the active standalone app runtime with KOED_HOME native assets", () => {
    const root = tempDir();
    const appRuntimeRoot = resolve(
      root,
      "runtime",
      "koed-server",
      "current",
      "koed-runtime"
    );
    for (const entry of [
      "api/dist/index.js",
      "worker/dist/index.js",
      "embedding-service/dist/index.js",
      "privacy-service/dist/index.js",
      "mcp-server/dist/cli.js",
      "mcp-server/dist/local-runtime-cli.js",
      "mcp-server/dist/capture-hook.js",
      "mcp-server/dist/prompts/codex-global-agent-guidance.md",
      "node_modules/@koed/db/dist/index.js",
      "node_modules/@koed/db/dist/connection.js",
      "node_modules/@koed/db/dist/user-api-token-repository.js",
      "node_modules/@koed/db/drizzle/meta/_journal.json"
    ]) {
      const file = resolve(appRuntimeRoot, entry);
      mkdirSync(resolve(file, ".."), { recursive: true });
      writeFileSync(file, "");
    }
    const llama = resolve(root, "runtime", "llama.cpp", "llama-server");
    mkdirSync(resolve(llama, ".."), { recursive: true });
    writeFileSync(llama, "");
    chmodSync(llama, 0o755);

    const runtime = resolveLocalEmbeddingRuntimePaths(paths(root), {});

    expect(runtime.serviceEntry).toBe(
      resolve(appRuntimeRoot, "embedding-service", "dist", "index.js")
    );
    expect(runtime.llamaServerBin).toBe(llama);
    expect(runtime.artifactSources).toEqual({
      service: "koed-home-runtime",
      llamaServer: "koed-home-runtime"
    });
  });

  it("rejects source checkout Embedding Service fallback in packaged mode", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "apps", "embedding-service"), { recursive: true });
    mkdirSync(resolve(root, "vendor", "llama.cpp"), { recursive: true });
    mkdirSync(resolve(root, "apps", "embedding-service", "dist"), {
      recursive: true
    });
    writeFileSync(
      resolve(root, "apps", "embedding-service", "dist", "index.js"),
      ""
    );
    writeFileSync(resolve(root, "vendor", "llama.cpp", "llama-server"), "");

    const runtime = resolveLocalEmbeddingRuntimePaths(paths(root), {
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root
    });

    expect(runtime.artifactSource).toBe("koed-home-runtime");
    expect(runtime.appDir).toBe(resolve(root, "runtime", "embedding-service"));
    expect(runtime.llamaServerBin).toBe(
      resolve(root, "runtime", "llama.cpp", "llama-server")
    );
  });

  it("ignores Docker llama-server default when resolving native paths", () => {
    const root = tempDir();
    const runtime = resolveLocalEmbeddingRuntimePaths(paths(root), {
      EMBEDDING_LLAMA_SERVER_BINARY: "/opt/llama.cpp/llama-server"
    });

    expect(runtime.llamaServerBin).toBe(
      resolve(root, "runtime", "llama.cpp", "llama-server")
    );
  });

  it("honors dedicated native llama-server override", () => {
    const root = tempDir();
    const runtime = resolveLocalEmbeddingRuntimePaths(paths(root), {
      EMBEDDING_LLAMA_SERVER_BINARY: "/opt/llama.cpp/llama-server",
      KOED_EMBEDDING_LLAMA_SERVER_BIN: resolve(root, "custom", "llama-server")
    });

    expect(runtime.llamaServerBin).toBe(
      resolve(root, "custom", "llama-server")
    );
  });

  it("resolves bundled-local Embedding Service to native-only mode", () => {
    const root = tempDir();
    expect(resolveBundledEmbeddingMode(paths(root), {})).toBe("native");
    expect(
      resolveBundledEmbeddingMode(paths(root), {
        KOED_BUNDLED_EMBEDDING_MODE: "compose"
      })
    ).toBe("native");

    mkdirSync(resolve(root, "apps", "embedding-service", "dist"), {
      recursive: true
    });
    mkdirSync(resolve(root, "vendor", "llama.cpp"), { recursive: true });
    writeFileSync(
      resolve(root, "apps", "embedding-service", "dist", "index.js"),
      ""
    );
    const llama = resolve(root, "vendor", "llama.cpp", "llama-server");
    writeFileSync(llama, "");
    chmodSync(llama, 0o755);

    expect(localEmbeddingRuntimeAvailable(paths(root), {})).toBe(true);
  });

  it("starts packaged/native runtime without Python virtualenv", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "runtime", "embedding-service", "dist"), {
      recursive: true
    });
    mkdirSync(resolve(root, "runtime", "llama.cpp"), { recursive: true });
    writeFileSync(
      resolve(root, "runtime", "embedding-service", "dist", "index.js"),
      ""
    );
    const llama = resolve(root, "runtime", "llama.cpp", "llama-server");
    writeFileSync(llama, "");
    chmodSync(llama, 0o755);
    const spawned: string[][] = [];

    const result = startLocalEmbeddingRuntime(
      paths(root),
      {},
      {
        spawn: (_command, args) => {
          spawned.push(args);
          return { pid: 12, on: () => undefined } as never;
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(spawned[0]).toEqual([
      resolve(root, "runtime", "embedding-service", "dist", "index.js")
    ]);
  });

  it("reports missing runtime files without tokens", async () => {
    const root = tempDir();
    const status = await collectLocalEmbeddingRuntimeStatus(paths(root), {
      EMBEDDING_SERVICE_TOKEN: "secret"
    });

    expect(status.state).toBe("not_configured");
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(status.action).toContain("WSL");
    expect(status.details?.missing).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Embedding Service entry"),
        expect.stringContaining("llama-server")
      ])
    );
  });

  it("maps health response to healthy", async () => {
    const root = tempDir();
    const status = await collectLocalEmbeddingRuntimeStatus(
      paths(root),
      {},
      {
        existsSync: () => true,
        fetch: async () => response(true, 200, { status: "ok" })
      }
    );

    expect(status.state).toBe("healthy");
    expect(status.details?.healthUrl).toBe("http://127.0.0.1:3800/health");
  });

  it("spawns the Embedding Service entry with native environment", () => {
    const root = tempDir();
    const serviceEntry = resolve(
      root,
      "runtime",
      "embedding-service",
      "dist",
      "index.js"
    );
    const llamaServer = resolve(root, "runtime", "llama.cpp", "llama-server");
    const spawned: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
      cwd?: string | URL;
    }> = [];
    const result = startLocalEmbeddingRuntime(
      paths(root),
      { EMBEDDING_SERVICE_HOST_PORT: "3900" },
      {
        existsSync: (path) => path === serviceEntry || path === llamaServer,
        spawn: (command, args, options) => {
          spawned.push({ command, args, env: options?.env, cwd: options?.cwd });
          return { pid: 12, on: () => undefined } as never;
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(spawned[0]?.command).toBe(process.execPath);
    expect(spawned[0]?.args).toEqual([serviceEntry]);
    expect(spawned[0]?.cwd).toBe(resolve(root, "runtime", "embedding-service"));
    expect(spawned[0]?.env?.EMBEDDING_SERVICE_URL).toBe(
      "http://127.0.0.1:3900"
    );
    expect(spawned[0]?.env?.EMBEDDING_SERVICE_HOST).toBe("127.0.0.1");
    expect(spawned[0]?.env?.EMBEDDING_SERVICE_PORT).toBe("3900");
    expect(spawned[0]?.env?.LLAMA_SERVER_BINARY).toBe(llamaServer);
  });
});

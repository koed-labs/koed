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
  explorerTokenPath: resolve(root, "config", "explorer-token.json"),
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
    expect(runtime.pythonBin).toBe(
      resolve(root, "runtime", "embedding-service", ".venv", "bin", "python")
    );
    expect(runtime.llamaServerBin).toBe(
      resolve(root, "runtime", "llama.cpp", "llama-server")
    );
    expect(runtime.healthUrl).toBe("http://127.0.0.1:3800/health");
    expect(localEmbeddingEnv(runtime).EMBEDDING_SERVICE_URL).toBe(
      "http://127.0.0.1:3800"
    );
  });

  it("prefers packaged Embedding Service resources over source checkout in packaged mode", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "koed-runtime", "embedding-service"), {
      recursive: true
    });
    mkdirSync(resolve(root, "koed-runtime", "llama.cpp"), { recursive: true });
    mkdirSync(resolve(root, "apps", "embedding-service"), { recursive: true });
    mkdirSync(resolve(root, "vendor", "llama.cpp"), { recursive: true });
    writeFileSync(
      resolve(root, "koed-runtime", "embedding-service", "app.py"),
      ""
    );
    writeFileSync(
      resolve(root, "koed-runtime", "llama.cpp", "llama-server"),
      ""
    );
    writeFileSync(resolve(root, "apps", "embedding-service", "app.py"), "");
    writeFileSync(resolve(root, "vendor", "llama.cpp", "llama-server"), "");

    const runtime = resolveLocalEmbeddingRuntimePaths(paths(root), {
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root
    });

    expect(runtime.artifactSource).toBe("packaged-resource");
    expect(runtime.appDir).toBe(
      resolve(root, "koed-runtime", "embedding-service")
    );
    expect(runtime.llamaServerBin).toBe(
      resolve(root, "koed-runtime", "llama.cpp", "llama-server")
    );
  });

  it("rejects source checkout Embedding Service fallback in packaged mode", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "apps", "embedding-service"), { recursive: true });
    mkdirSync(resolve(root, "vendor", "llama.cpp"), { recursive: true });
    writeFileSync(resolve(root, "apps", "embedding-service", "app.py"), "");
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

    mkdirSync(resolve(root, "apps", "embedding-service", ".venv", "bin"), {
      recursive: true
    });
    mkdirSync(resolve(root, "vendor", "llama.cpp"), { recursive: true });
    writeFileSync(resolve(root, "apps", "embedding-service", "app.py"), "");
    const python = resolve(
      root,
      "apps",
      "embedding-service",
      ".venv",
      "bin",
      "python"
    );
    const llama = resolve(root, "vendor", "llama.cpp", "llama-server");
    writeFileSync(python, "");
    writeFileSync(llama, "");
    chmodSync(python, 0o755);
    chmodSync(llama, 0o755);

    expect(localEmbeddingRuntimeAvailable(paths(root), {})).toBe(true);
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
        expect.stringContaining("python"),
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

  it("spawns uvicorn with native environment", () => {
    const root = tempDir();
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
        existsSync: () => true,
        spawn: (command, args, options) => {
          spawned.push({ command, args, env: options?.env, cwd: options?.cwd });
          return { pid: 12, on: () => undefined } as never;
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(spawned[0]?.command).toContain("python");
    expect(spawned[0]?.args).toEqual([
      "-m",
      "uvicorn",
      "app:app",
      "--host",
      "127.0.0.1",
      "--port",
      "3900"
    ]);
    expect(spawned[0]?.cwd).toBe(resolve(root, "runtime", "embedding-service"));
    expect(spawned[0]?.env?.EMBEDDING_SERVICE_URL).toBe(
      "http://127.0.0.1:3900"
    );
  });
});

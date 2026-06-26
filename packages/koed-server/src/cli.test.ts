import { describe, expect, it } from "vitest";
import { runKoedServerCli } from "./cli.js";
import type { KoedServerDoctorResult, KoedServerStatus } from "./types.js";

const writer = () => {
  let text = "";
  return {
    stream: { write: (chunk: string) => (text += chunk) } as never,
    text: () => text
  };
};

const status: KoedServerStatus = {
  ok: true,
  state: "healthy",
  koedHome: "/tmp/koed",
  generatedAt: "2026-01-01T00:00:00.000Z",
  runtimeMode: "developer",
  dependencyMode: "external",
  api: { state: "healthy", url: "http://localhost:3300" },
  database: { state: "healthy" },
  redis: { state: "healthy" },
  workerQueues: { state: "healthy" },
  embeddingService: { state: "healthy" },
  apiToken: { state: "healthy", configured: true },
  mcpServer: { state: "healthy" },
  captureHook: { state: "healthy" },
  codex: { state: "healthy", configured: true },
  lcmSummaryService: { state: "healthy" },
  explorer: { state: "healthy", url: "http://localhost:5174" },
  lastVerification: { state: "healthy", checkedAt: "2026-01-01T00:00:00.000Z" }
};

const doctor: KoedServerDoctorResult = {
  ok: false,
  state: "needs_attention",
  summary: "API is not ready",
  koedHome: "/tmp/koed",
  generatedAt: "2026-01-01T00:00:00.000Z",
  runtimeMode: "developer",
  dependencyMode: "external",
  checks: [{ id: "api", label: "API", state: "needs_attention" }]
};

describe("JSON command output", () => {
  it("prints models status --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["models", "status", "--json"], {
      stdout: stdout.stream,
      resolvePaths: () => ({ repoRoot: "/repo" }) as never,
      loadEnvironment: () => ({}),
      collectModelStatus: async () => ({
        state: "missing",
        message: "missing",
        action: "install",
        modelPath: "/tmp/model.gguf",
        manifest: {
          kind: "embedding",
          key: "qwen3-0.6b",
          filename: "model.gguf",
          modelPath: "/tmp/model.gguf",
          urlEnv: "KOED_EMBEDDING_MODEL_URL",
          sha256Env: "KOED_EMBEDDING_MODEL_SHA256",
          pathEnv: "KOED_EMBEDDING_MODEL_PATH"
        }
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      state: "missing",
      modelPath: "/tmp/model.gguf"
    });
  });

  it("prints models install --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["models", "install", "--json"], {
      stdout: stdout.stream,
      resolvePaths: () => ({ repoRoot: "/repo" }) as never,
      loadEnvironment: () => ({}),
      installModel: async () => ({
        ok: true,
        state: "installed",
        message: "installed",
        modelPath: "/tmp/model.gguf",
        manifest: {
          kind: "embedding",
          key: "qwen3-0.6b",
          filename: "model.gguf",
          modelPath: "/tmp/model.gguf",
          urlEnv: "KOED_EMBEDDING_MODEL_URL",
          sha256Env: "KOED_EMBEDDING_MODEL_SHA256",
          pathEnv: "KOED_EMBEDDING_MODEL_PATH"
        }
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "installed"
    });
  });

  it("passes repo .env values to model install commands", async () => {
    const stdout = writer();
    const seen: NodeJS.ProcessEnv[] = [];

    const exitCode = await runKoedServerCli(["models", "install", "--json"], {
      stdout: stdout.stream,
      resolvePaths: () => ({ repoRoot: "/repo" }) as never,
      loadEnvironment: () => ({
        KOED_EMBEDDING_MODEL_URL: "https://example.test/model.gguf",
        KOED_EMBEDDING_MODEL_SHA256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }),
      installModel: async (_paths, _kind, environment) => {
        seen.push(environment ?? {});
        return {
          ok: true,
          state: "installed",
          message: "installed",
          modelPath: "/tmp/model.gguf",
          manifest: {
            kind: "embedding",
            key: "qwen3-0.6b",
            filename: "model.gguf",
            modelPath: "/tmp/model.gguf",
            urlEnv: "KOED_EMBEDDING_MODEL_URL",
            sha256Env: "KOED_EMBEDDING_MODEL_SHA256",
            pathEnv: "KOED_EMBEDDING_MODEL_PATH"
          }
        };
      }
    });

    expect(exitCode).toBe(0);
    expect(seen[0]?.KOED_EMBEDDING_MODEL_URL).toBe(
      "https://example.test/model.gguf"
    );
  });

  it("prints stop --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["stop", "--json"], {
      stdout: stdout.stream,
      stop: () => ({
        ok: true,
        state: "healthy",
        koedHome: "/tmp/koed",
        message: "Koed server stop completed.",
        stoppedPids: [12, 11, 10],
        missingPids: [],
        stoppedServices: ["explorer", "worker", "api"],
        missingServices: []
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      stoppedPids: [12, 11, 10]
    });
  });

  it("prints restart --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["restart", "--json"], {
      stdout: stdout.stream,
      restart: async () => ({
        ok: true,
        state: "starting",
        koedHome: "/tmp/koed",
        message: "Koed server restarted.",
        stoppedPids: [12, 11, 10],
        missingPids: [],
        stoppedServices: ["explorer", "worker", "api"],
        missingServices: []
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      stoppedPids: [12, 11, 10]
    });
  });

  it("prints status --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["status", "--json"], {
      stdout: stdout.stream,
      collectStatus: async () => status
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "healthy"
    });
  });

  it("prints doctor --json and returns non-zero for failures", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["doctor", "--json"], {
      stdout: stdout.stream,
      collectDoctor: async () => doctor
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      summary: "API is not ready"
    });
  });
});

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
  checks: [{ id: "api", label: "API", state: "needs_attention" }]
};

describe("JSON command output", () => {
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

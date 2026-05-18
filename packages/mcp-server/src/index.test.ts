import http from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryApiClient, memoryAccessCheck } from "./index.js";
import {
  resolveLcmSummaryServiceConfig,
  startLcmSummaryService
} from "./lcm-summary-service.js";
import {
  resolveLcmSummaryWorkerConfig,
  summarizePendingLcmNodes,
  type LcmSummaryNode
} from "./lcm-summary-worker.js";

const servers: http.Server[] = [];

const createApi = async (handler: http.RequestListener): Promise<string> => {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
});

describe("MemoryApiClient", () => {
  it("validates bearer token access through /v1/access/check", async () => {
    const apiUrl = await createApi((request, response) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe("/v1/access/check");
      expect(request.headers.authorization).toBe("Bearer cmt_test");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          auth: "bearer_api_token",
          user: { id: "user-1", email: "solo@example.com", displayName: null },
          currentTeam: null,
          canWritePersonal: true,
          canWriteTeam: false,
          enabledProviderConfigs: 1
        })
      );
    });

    const result = await memoryAccessCheck(
      new MemoryApiClient({ apiUrl, apiToken: "cmt_test" }),
      false
    );

    expect(result.ok).toBe(true);
    expect(result.configuredApiUrl).toBe(apiUrl);
    expect(result.defaultAutomaticCaptureScope).toBe("personal");
    expect(result.defaultAnswerScope).toBe("personal");
    expect(result.notes).toEqual([]);
  });

  it("defaults memory_answer scope to personal unless personal+team is configured", async () => {
    const apiUrl = await createApi((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          auth: "bearer_api_token",
          user: { id: "user-1", email: "team@example.com", displayName: null },
          currentTeam: {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Team",
            inviteCode: null
          },
          canWritePersonal: true,
          canWriteTeam: true,
          enabledProviderConfigs: 1
        })
      );
    });

    const result = await memoryAccessCheck(
      new MemoryApiClient({ apiUrl, apiToken: "cmt_test" }),
      false
    );

    expect(result.defaultAnswerScope).toBe("personal");

    vi.stubEnv("MEMORY_DEFAULT_RETRIEVAL_SCOPE", "personal+team");
    const configured = await memoryAccessCheck(
      new MemoryApiClient({ apiUrl, apiToken: "cmt_test" }),
      false
    );
    expect(configured.defaultAnswerScope).toBe("personal+team");
  });
});

describe("LCM summary background service", () => {
  it("resolves conservative enabled defaults", () => {
    expect(resolveLcmSummaryServiceConfig({})).toEqual({
      enabled: true,
      initialDelayMs: 30_000,
      pushDelayMs: 10_000,
      intervalMs: 1_800_000,
      batchLimit: 2
    });
  });

  it("uses a single in-process summarisation run", async () => {
    let releasePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    const fakeClient = {
      async listPendingLcmSummaries() {
        await pending;
        return { nodes: [] };
      }
    } as unknown as MemoryApiClient;

    const service = startLcmSummaryService(fakeClient, {
      serviceConfig: {
        enabled: true,
        initialDelayMs: 60_000,
        pushDelayMs: 10_000,
        intervalMs: 60_000,
        batchLimit: 2
      }
    });

    expect(service).not.toBeNull();
    const firstRun = service!.trigger("test");
    const secondRun = await service!.trigger("test");
    expect(secondRun).toEqual({
      ran: false,
      skippedReason: "already_running"
    });
    releasePending();
    expect(await firstRun).toMatchObject({ ran: true });
    service!.stop();
  });

  it("summarizes oversized nodes through token-bounded local map/reduce prompts", async () => {
    const node: LcmSummaryNode = {
      id: "node-large",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: `placeholder ${"Aston Villa and Paul McGrath ".repeat(
        2_000
      )}`,
      sourceTokenEstimate: null,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: "event-large",
          actor: "user",
          text: "Aston Villa and Paul McGrath ".repeat(2_000),
          payload: { lcmSessionKey: "session-large" },
          position: 0
        }
      ]
    };
    const submissions: Record<string, unknown>[] = [];
    let listed = false;
    const fakeClient = {
      async listPendingLcmSummaries() {
        if (listed) {
          return { nodes: [] };
        }
        listed = true;
        return { nodes: [node] };
      },
      async submitLcmSummary(_nodeId: string, input: Record<string, unknown>) {
        submissions.push(input);
        return {};
      }
    } as unknown as MemoryApiClient;
    const config = resolveLcmSummaryWorkerConfig(
      {
        MEMORY_LCM_SUMMARY_LOCK_PATH: `/tmp/codex-memory-lcm-test-${randomUUID()}.lock`
      },
      {
        model: "gpt-5.4-mini",
        maxPromptTokens: 1_500,
        maxAttempts: 1,
        retryDelayMs: 0,
        timeoutMs: 1_000
      }
    );

    const result = await summarizePendingLcmNodes(fakeClient, {
      limit: 1,
      config,
      runner: async (prompt) => ({
        text: prompt.includes("Combine these shard summaries")
          ? "Final summary: Aston Villa and Paul McGrath were discussed."
          : "Shard summary: Aston Villa and Paul McGrath were discussed.",
        model: "codex:test"
      })
    });

    expect(result.submittedCount).toBe(1);
    expect(result.results[0]).toMatchObject({
      submitted: true,
      summaryModel: "codex:test"
    });
    expect(typeof result.results[0]?.promptCallCount).toBe("number");
    expect(result.results[0]?.promptCallCount).toBeGreaterThan(1);
    expect(result.results[0]?.maxPromptTokenEstimate).toBeLessThanOrEqual(
      config.maxPromptTokens
    );
    expect(submissions[0]).toMatchObject({
      summaryText:
        "Final summary: Aston Villa and Paul McGrath were discussed.",
      summaryModel: "codex:test"
    });
  });
});

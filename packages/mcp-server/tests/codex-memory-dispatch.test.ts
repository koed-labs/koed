import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle
} from "@modelcontextprotocol/server/stdio";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryAnswerTask } from "@koed/shared";
import { createKoedMcpServer } from "../src/mcp-server-factory.js";
import {
  LocalAiRuntimeError,
  LocalAiRuntimeClient
} from "../src/local-runtime-client.js";
import {
  startLocalAiRuntime,
  type LocalAiRuntimeToolExecutor
} from "../src/local-runtime-server.js";
import { memoryAnswerInputSchema } from "../src/memory-tool-schemas.js";
const pairs: { client: Client; server: StdioServerHandle; home: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of pairs.splice(0)) {
    await p.client.close();
    await p.server.close();
    rmSync(p.home, { recursive: true, force: true });
  }
});
async function connect(runtimeClient?: LocalAiRuntimeClient) {
  const home = mkdtempSync(path.join(os.tmpdir(), "koed-codex-dispatch-"));
  const callTool = vi.fn<LocalAiRuntimeClient["callTool"]>(async () => ({
    markdown: "blocking"
  }));
  const start = vi.fn<LocalAiRuntimeClient["startMemoryAnswerTask"]>(
    async (_input, _caller, key) =>
      ({
        id: "aaaabbbb-1111-4111-8111-111111111111",
        invocationKey: key,
        status: "accepted",
        version: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }) as MemoryAnswerTask
  );
  const runtime = {
    capabilities: async () => ({
      protocolVersion: 1,
      curatedMemoryIntakeAvailable: false,
      memoryAnswerTeamBackendAvailable: true
    }),
    callTool,
    startMemoryAnswerTask: start
  } as unknown as LocalAiRuntimeClient;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(
    (context) =>
      createKoedMcpServer(context, {
        runtimeClient: runtimeClient ?? runtime,
        environment: { KOED_HOME: home },
        callerContextResolver: ({ defaultContext }) => ({
          ...defaultContext,
          cwd: "/fixture"
        })
      }),
    { transport: b, legacy: "reject" }
  );
  const client = new Client(
    { name: "ordinary-harness", version: "1" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } }
    }
  );
  await client.connect(a);
  pairs.push({ client, server, home });
  return { client, start, callTool };
}
const metadata = {
  sessionId: "session-1",
  callId: "call-1",
  threadId: "native-thread-1"
};
describe("shared MCP recall dispatch boundary", () => {
  it.each([undefined, "auto", "blocking"])(
    "returns blocking recall for mode %s",
    async (deliveryMode) => {
      const f = await connect();
      const result = await f.client.callTool({
        name: "memory_answer",
        arguments: {
          query: "decision",
          ...(deliveryMode ? { delivery_mode: deliveryMode } : {})
        },
        _meta: metadata
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("blocking");
      expect(f.callTool).toHaveBeenCalledTimes(1);
      expect(
        memoryAnswerInputSchema.parse(f.callTool.mock.calls[0]![1])
      ).toEqual(f.callTool.mock.calls[0]![1]);
      expect(f.start).not.toHaveBeenCalled();
    }
  );
  it("submits explicit non-blocking recall with a compact durable receipt", async () => {
    const f = await connect();
    const result = await f.client.callTool({
      name: "memory_answer",
      arguments: {
        query: "decision",
        delivery_mode: "non_blocking"
      },
      _meta: metadata
    });
    expect(result.structuredContent).toMatchObject({
      status: "pending",
      task_id: "aaaabbbb-1111-4111-8111-111111111111"
    });
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(memoryAnswerInputSchema.parse(f.start.mock.calls[0]![0])).toEqual(
      f.start.mock.calls[0]![0]
    );
    expect(f.start.mock.calls[0]![2]).toEqual(expect.any(String));
    expect(f.callTool).not.toHaveBeenCalled();
  });
  it.each(["invalid", null, 1])(
    "rejects invalid mode %s before execution",
    async (deliveryMode) => {
      const f = await connect();
      const result = await f.client.callTool({
        name: "memory_answer",
        arguments: { query: "decision", delivery_mode: deliveryMode }
      });
      expect(result.isError).toBe(true);
      expect(f.start).not.toHaveBeenCalled();
      expect(f.callTool).not.toHaveBeenCalled();
    }
  );
  it("rejects unknown input fields before execution", async () => {
    const f = await connect();
    const result = await f.client.callTool({
      name: "memory_answer",
      arguments: { query: "decision", authorization: "untrusted" }
    });
    expect(result.isError).toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.callTool).not.toHaveBeenCalled();
  });
  it("preserves caller and Team context without treating session metadata as authority", async () => {
    const f = await connect();
    const workspace = "11111111-1111-4111-8111-111111111111";
    const input = {
      query: "decision",
      delivery_mode: "non_blocking",
      search_domain: "global",
      team_workspace_id: workspace,
      team_backend_id: "remote"
    };
    for (const sessionId of ["session-1", "another-session"]) {
      const result = await f.client.callTool({
        name: "memory_answer",
        arguments: input,
        _meta: { ...metadata, sessionId }
      });
      expect(result.structuredContent).toMatchObject({ status: "pending" });
    }
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.start.mock.calls[0]![0]).toMatchObject({
      team_workspace_id: workspace,
      team_backend_id: "remote"
    });
    expect(f.start.mock.calls[0]![1]).toMatchObject({
      cwd: "/fixture",
      clientInfo: { name: "ordinary-harness" }
    });
    expect(f.start.mock.calls[1]![1]).toEqual(f.start.mock.calls[0]![1]);
    expect(f.callTool).not.toHaveBeenCalled();
  });
  it.each([
    new LocalAiRuntimeError("uncertain start", 409),
    new LocalAiRuntimeError("Team Workspace access denied", 403),
    new Error("PRIVATE_PROVIDER_MESSAGE")
  ])(
    "returns a safe admission failure without blocking fallback: %s",
    async (error) => {
      const f = await connect();
      f.start.mockRejectedValueOnce(error);
      const result = await f.client.callTool({
        name: "memory_answer",
        arguments: { query: "decision", delivery_mode: "non_blocking" }
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_MESSAGE");
      expect(f.start).toHaveBeenCalledTimes(1);
      expect(f.callTool).not.toHaveBeenCalled();
    }
  );
  it.each(["mapped-team", "untrusted-conflict"] as const)(
    "preserves authoritative task admission and rejects unavailable routes: %s",
    async (mode) => {
      const home = mkdtempSync(path.join(os.tmpdir(), "koed-team-dispatch-"));
      const environment = {
        KOED_HOME: home,
        KOED_TEAM_WORKSPACE_AUTO_RESOLUTION_ENABLED: "1"
      };
      mkdirSync(path.join(home, "config"));
      writeFileSync(
        path.join(home, "config/project-team-workspaces.json"),
        JSON.stringify({
          links: [
            {
              projectRoot: "/fixture",
              teamWorkspaceId: "11111111-1111-4111-8111-111111111111"
            }
          ]
        })
      );
      const execute = vi
        .fn<LocalAiRuntimeToolExecutor["execute"]>()
        .mockResolvedValue({
          markdown: "blocking Team answer"
        });
      const executeMemoryAnswerTask = vi.fn();
      const accept = vi.fn(async () => {
        throw Object.assign(new Error("PRIVATE_PROVIDER_MESSAGE"), {
          status: 409,
          statusCode: 409
        });
      });
      const runtime = await startLocalAiRuntime({
        environment,
        serviceFactory: async ({ apiClient }) => {
          apiClient.acceptMemoryAnswerTask = accept;
          apiClient.claimMemoryAnswerTask = vi.fn(async () => ({
            task: null,
            reconciled: []
          }));
          apiClient.deleteExpiredMemoryAnswerTasks = vi.fn(async () => ({
            deleted: 0
          }));
          return {
            executor: {
              capabilities: async () => ({
                curatedMemoryIntakeAvailable: false
              }),
              execute,
              executeMemoryAnswerTask
            },
            close: vi.fn(async () => undefined)
          };
        }
      });
      try {
        const input = {
          query: "decision",
          search_domain: mode === "mapped-team" ? "project" : "global"
        };
        const f = await connect(new LocalAiRuntimeClient(environment));
        const result = await f.client.callTool({
          name: "memory_answer",
          arguments: { ...input, delivery_mode: "non_blocking" },
          _meta: metadata
        });
        expect(executeMemoryAnswerTask).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(execute).not.toHaveBeenCalled();
        if (mode === "mapped-team") {
          expect(accept).not.toHaveBeenCalled();
        } else {
          expect(accept).toHaveBeenCalledTimes(1);
          expect(JSON.stringify(result)).not.toContain(
            "PRIVATE_PROVIDER_MESSAGE"
          );
        }
      } finally {
        await runtime.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
  );
});

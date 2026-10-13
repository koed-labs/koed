import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle
} from "@modelcontextprotocol/server/stdio";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryAnswerTask } from "@koed/shared";
import {
  CodexMemoryReceiptStore,
  CODEX_DELIVERY_NONCE,
  canonicalCodexMemoryInput
} from "../src/codex-memory-delivery.js";
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
import { logger } from "../src/logger.js";
const pairs: { client: Client; server: StdioServerHandle; home: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of pairs.splice(0)) {
    await p.client.close();
    await p.server.close();
    rmSync(p.home, { recursive: true, force: true });
  }
});
async function connect(
  enabled = true,
  runtimeClient?: LocalAiRuntimeClient,
  toolInput: Record<string, unknown> = { query: "decision" }
) {
  const home = mkdtempSync(path.join(os.tmpdir(), "koed-codex-dispatch-"));
  const callTool = vi.fn(
    async (...args: Parameters<LocalAiRuntimeClient["callTool"]>) => {
      void args;
      return { markdown: "blocking" };
    }
  );
  const start = vi.fn(
    async (_input, _caller, key: string) =>
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
        environment: {
          KOED_HOME: home,
          ...(enabled
            ? {
                KOED_CODEX_STOP_DELIVERY: "1",
                KOED_CODEX_MEMORY_TOOL: "mcp__koed__memory_answer"
              }
            : {})
        },
        callerContextResolver: () => ({ cwd: "/fixture" })
      }),
    { transport: b, legacy: "reject" }
  );
  const client = new Client(
    { name: "codex-test", version: "1" },
    { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  await client.connect(a);
  pairs.push({ client, server, home });
  const store = new CodexMemoryReceiptStore(home);
  const prepared = store.prepare(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      turn_id: "turn-1",
      tool_use_id: "call-1",
      tool_name: "mcp__koed__memory_answer",
      cwd: "/fixture",
      tool_input: toolInput
    },
    "mcp__koed__memory_answer"
  );
  const input =
    (
      prepared.hookSpecificOutput as
        | { updatedInput: Record<string, unknown> }
        | undefined
    )?.updatedInput ?? toolInput;
  return { client, start, callTool, input, store };
}
const metadata = {
  sessionId: "session-1",
  callId: "call-1",
  threadId: "native-thread-1",
  "x-codex-turn-metadata": { turn_id: "turn-1", thread_source: "user" }
};
describe("maintained MCP dispatch deferred recall boundary", () => {
  it.each([undefined, "auto", "non_blocking"])(
    "uses eligible Stop delivery and strips presentation inputs: %s",
    async (deliveryMode) => {
      const f = await connect(true, undefined, {
        query: "decision",
        ...(deliveryMode === undefined ? {} : { delivery_mode: deliveryMode })
      });
      const result = await f.client.callTool({
        name: "memory_answer",
        arguments: f.input,
        _meta: metadata
      });
      expect(result.structuredContent).toMatchObject({ status: "pending" });
      expect(f.start).toHaveBeenCalledTimes(1);
      expect(memoryAnswerInputSchema.parse(f.start.mock.calls[0]![0])).toEqual(
        f.start.mock.calls[0]![0]
      );
      expect(f.start.mock.calls[0]![0]).not.toHaveProperty("delivery_mode");
      expect(f.callTool).not.toHaveBeenCalled();
    }
  );
  it("blocks explicitly without preparing a receipt or using the deferred turn allowance", async () => {
    const report = vi.spyOn(logger, "info");
    const f = await connect(true, undefined, {
      query: "decision",
      delivery_mode: "blocking"
    });
    expect(f.input).not.toHaveProperty(CODEX_DELIVERY_NONCE);
    const result = await f.client.callTool({
      name: "memory_answer",
      arguments: f.input,
      _meta: metadata
    });
    expect(result.isError).not.toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.callTool).toHaveBeenCalledTimes(1);
    expect(f.callTool.mock.calls[0]![1]).toEqual(
      canonicalCodexMemoryInput(f.input)
    );
    expect(report).toHaveBeenCalledWith(
      {
        memoryAnswerDelivery: {
          requestedMode: "blocking",
          effectiveRoute: "mcp_result",
          fallbackReason: null
        }
      },
      "Memory Answer delivery route"
    );
    const prepared = f.store.prepare(
      {
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        turn_id: "turn-1",
        tool_use_id: "call-2",
        tool_name: "mcp__koed__memory_answer",
        cwd: "/fixture",
        tool_input: { query: "next decision", delivery_mode: "non_blocking" }
      },
      "mcp__koed__memory_answer"
    );
    const nextInput = (
      prepared.hookSpecificOutput as { updatedInput: Record<string, unknown> }
    ).updatedInput;
    expect(nextInput[CODEX_DELIVERY_NONCE]).toBeDefined();
    await f.client.callTool({
      name: "memory_answer",
      arguments: nextInput,
      _meta: { ...metadata, callId: "call-2" }
    });
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });
  it("rejects a changed mode before falling back to blocking", async () => {
    const f = await connect(true, undefined, {
      query: "decision",
      delivery_mode: "non_blocking"
    });
    const result = await f.client.callTool({
      name: "memory_answer",
      arguments: { ...f.input, delivery_mode: "blocking" },
      _meta: metadata
    });
    expect(result.isError).toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.callTool).not.toHaveBeenCalled();
    await f.client.callTool({
      name: "memory_answer",
      arguments: f.input,
      _meta: metadata
    });
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("binds omitted and explicit auto equivalently", async () => {
    const f = await connect();
    const result = await f.client.callTool({
      name: "memory_answer",
      arguments: { ...f.input, delivery_mode: "auto" },
      _meta: metadata
    });
    expect(result.structuredContent).toMatchObject({ status: "pending" });
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it.each(["invalid", null, 1])(
    "rejects an invalid mode without any execution: %s",
    async (deliveryMode) => {
      const f = await connect();
      const result = await f.client.callTool({
        name: "memory_answer",
        arguments: { query: "decision", delivery_mode: deliveryMode },
        _meta: metadata
      });
      expect(result.isError).toBe(true);
      expect(f.start).not.toHaveBeenCalled();
      expect(f.callTool).not.toHaveBeenCalled();
    }
  );
  it.each(["auto", "blocking", "non_blocking"])(
    "retains ordinary MCP delivery on disabled integrations: %s",
    async (deliveryMode) => {
      const report = vi.spyOn(logger, "info");
      const f = await connect(false);
      const result = await f.client.callTool({
        name: "memory_answer",
        arguments: { query: "PRIVATE_QUERY", delivery_mode: deliveryMode }
      });
      expect(result.isError).not.toBe(true);
      expect(f.start).not.toHaveBeenCalled();
      expect(f.callTool).toHaveBeenCalledTimes(1);
      expect(
        memoryAnswerInputSchema.parse(f.callTool.mock.calls[0]![1])
      ).toEqual(f.callTool.mock.calls[0]![1]);
      expect(report).toHaveBeenCalledWith(
        {
          memoryAnswerDelivery: {
            requestedMode: deliveryMode,
            effectiveRoute: "mcp_result",
            fallbackReason:
              deliveryMode === "blocking" ? null : "integration_disabled"
          }
        },
        "Memory Answer delivery route"
      );
      expect(JSON.stringify(report.mock.calls)).not.toContain("PRIVATE_QUERY");
    }
  );
  it("admits only opt-in transport nonce and propagates native _meta to exact binding", async () => {
    const f = await connect();
    const result = await f.client.callTool({
      name: "memory_answer",
      arguments: f.input,
      _meta: metadata
    });
    expect(result.structuredContent).toMatchObject({ status: "pending" });
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.start.mock.calls[0]![0]).toEqual(
      canonicalCodexMemoryInput({ query: "decision" })
    );
    expect(f.callTool).not.toHaveBeenCalled();
  });
  it("missing prehook remains ordinary blocking, including opt-in mode", async () => {
    const f = await connect();
    await f.client.callTool({
      name: "memory_answer",
      arguments: { query: "decision" },
      _meta: metadata
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });
  it("starts with blocking recall when the receipt store is unusable", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "koed-codex-dispatch-"));
    const directory = path.join(home, "codex-memory-delivery");
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    const callTool = vi.fn(
      async (...args: Parameters<LocalAiRuntimeClient["callTool"]>) => {
        void args;
        return { markdown: "blocking" };
      }
    );
    const start = vi.fn();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(
      (context) =>
        createKoedMcpServer(context, {
          runtimeClient: {
            capabilities: async () => ({
              protocolVersion: 1,
              curatedMemoryIntakeAvailable: false
            }),
            callTool,
            startMemoryAnswerTask: start
          } as unknown as LocalAiRuntimeClient,
          environment: { KOED_HOME: home, KOED_CODEX_STOP_DELIVERY: "1" },
          callerContextResolver: () => ({ cwd: "/fixture" })
        }),
      { transport: b, legacy: "reject" }
    );
    const client = new Client(
      { name: "codex-test", version: "1" },
      { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await client.connect(a);
    pairs.push({ client, server, home });
    const result = await client.callTool({
      name: "memory_answer",
      arguments: { query: "decision", delivery_mode: "non_blocking" },
      _meta: metadata
    });
    expect(result.isError).not.toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]![1]).not.toHaveProperty(CODEX_DELIVERY_NONCE);
    const invalidReceipt = await client.callTool({
      name: "memory_answer",
      arguments: {
        query: "decision",
        delivery_mode: "blocking",
        [CODEX_DELIVERY_NONCE]: "a".repeat(64)
      },
      _meta: metadata
    });
    expect(invalidReceipt.isError).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
  it("default schema never admits adapter nonce and preserves ordinary blocking", async () => {
    const f = await connect(false);
    await f.client.callTool({
      name: "memory_answer",
      arguments: { query: "decision" }
    });
    expect(
      (
        await f.client.callTool({
          name: "memory_answer",
          arguments: f.input,
          _meta: metadata
        })
      ).isError
    ).toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });
  it("foreign session metadata cannot consume another Conversation nonce", async () => {
    const f = await connect();
    expect(
      (
        await f.client.callTool({
          name: "memory_answer",
          arguments: f.input,
          _meta: { ...metadata, sessionId: "foreign" }
        })
      ).isError
    ).toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.callTool).not.toHaveBeenCalled();
  });
  it("unsupported native subagent mode strips nonce and blocks before acceptance", async () => {
    const f = await connect();
    await f.client.callTool({
      name: "memory_answer",
      arguments: f.input,
      _meta: {
        ...metadata,
        "x-codex-turn-metadata": {
          turn_id: "turn-1",
          thread_source: "subagent"
        }
      }
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.callTool.mock.calls[0]![1]).toEqual(
      canonicalCodexMemoryInput({ query: "decision" })
    );
    expect(f.callTool.mock.calls[0]![1]).not.toHaveProperty(
      CODEX_DELIVERY_NONCE
    );
  });
  it("accepts authorized Team recall through native durable delivery", async () => {
    const workspace = "11111111-1111-4111-8111-111111111111";
    const f = await connect(true, undefined, {
      query: "decision",
      search_domain: "global",
      team_workspace_id: workspace,
      team_backend_id: "remote"
    });
    const result = await f.client.callTool({
      name: "memory_answer",
      arguments: f.input,
      _meta: metadata
    });
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({ status: "pending" });
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({
      team_workspace_id: workspace,
      team_backend_id: "remote"
    });
    expect(f.callTool).not.toHaveBeenCalled();
  });
  it.each([
    new LocalAiRuntimeError("uncertain start", 409),
    new LocalAiRuntimeError("Team Workspace access denied", 403),
    new Error("network start failure")
  ])(
    "uncertain start failure does not fall back or resubmit a consumed nonce: %s",
    async (error) => {
      const f = await connect();
      f.start.mockRejectedValueOnce(error);
      for (let i = 0; i < 2; i++)
        expect(
          (
            await f.client.callTool({
              name: "memory_answer",
              arguments: f.input,
              _meta: metadata
            })
          ).isError
        ).toBe(true);
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
        const f = await connect(
          true,
          new LocalAiRuntimeClient(environment),
          input
        );
        const result = await f.client.callTool({
          name: "memory_answer",
          arguments: f.input,
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

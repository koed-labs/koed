import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle
} from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKoedMcpServer } from "../src/mcp-server-factory.js";
import type { LocalAiRuntimeClient } from "../src/local-runtime-client.js";
import type {
  LocalRuntimeCallerContext,
  LocalRuntimeToolName
} from "../src/local-runtime-protocol.js";

const connected: Array<{
  client: Client;
  server: StdioServerHandle;
}> = [];

afterEach(async () => {
  for (const pair of connected.splice(0)) {
    await pair.client.close();
    await pair.server.close();
  }
});

const connect = async ({
  curatedMemoryIntakeAvailable = true,
  environment = {},
  callTool = vi.fn(async (name: LocalRuntimeToolName) => ({ ok: true, name }))
}: {
  curatedMemoryIntakeAvailable?: boolean;
  environment?: NodeJS.ProcessEnv;
  callTool?: (
    name: LocalRuntimeToolName,
    input: Record<string, unknown>,
    caller: LocalRuntimeCallerContext,
    signal?: AbortSignal
  ) => Promise<Record<string, unknown>>;
} = {}) => {
  const runtimeClient = {
    capabilities: async () => ({
      protocolVersion: 1 as const,
      curatedMemoryIntakeAvailable
    }),
    callTool
  } as unknown as LocalAiRuntimeClient;
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = serveStdio(
    (context) =>
      createKoedMcpServer(context, {
        runtimeClient,
        environment
      }),
    { transport: serverTransport, legacy: "reject" }
  );
  const client = new Client(
    { name: "koed-mcp-v2-test", version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } }
    }
  );
  await client.connect(clientTransport);
  connected.push({ client, server });
  return { client, callTool };
};

describe("Koed MCP 2026-07-28 protocol", () => {
  it("negotiates through server/discover and returns deterministic cacheable tools", async () => {
    const { client } = await connect();

    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getDiscoverResult()).toMatchObject({
      supportedVersions: ["2026-07-28"]
    });
    const first = await client.listTools();
    const second = await client.listTools();
    expect(first.tools.map((tool) => tool.name)).toEqual([
      "memory_answer",
      "memory_intake_propose"
    ]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      ttlMs: 30_000,
      cacheScope: "private"
    });
  });

  it("gates Curated Memory and diagnostic tools by capability and configuration", async () => {
    const { client } = await connect({
      curatedMemoryIntakeAvailable: false,
      environment: {
        MEMORY_EXPOSE_DIAGNOSTIC_MEMORY_TOOLS: "true",
        MEMORY_EXPOSE_LOW_LEVEL_MEMORY_TOOLS: "true"
      }
    });
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "memory_answer",
      "memory_access_check",
      "memory_search",
      "memory_expand"
    ]);
  });

  it("fails initialization while Local AI Runtime capabilities are unavailable", async () => {
    const runtimeClient = {
      capabilities: async () => {
        throw new Error("runtime is starting");
      },
      callTool: vi.fn()
    } as unknown as LocalAiRuntimeClient;

    await expect(
      createKoedMcpServer({} as never, { runtimeClient })
    ).rejects.toThrow("runtime is starting");
  });

  it("forwards per-request caller metadata and returns structured content", async () => {
    const callTool = vi.fn(
      async (
        name: LocalRuntimeToolName,
        input: Record<string, unknown>,
        caller: LocalRuntimeCallerContext
      ) => ({ name, input, caller })
    );
    const { client } = await connect({ callTool });
    const result = await client.callTool({
      name: "memory_answer",
      arguments: {
        query: "What did the team decide?",
        search_domain: "global"
      }
    });

    expect(result.structuredContent).toMatchObject({
      name: "memory_answer",
      input: {
        query: "What did the team decide?",
        response_detail: "answer_only",
        search_domain: "global",
        limit: 10,
        include_evidence: false
      },
      caller: {
        cwd: process.cwd(),
        protocolVersion: "2026-07-28",
        clientInfo: { name: "koed-mcp-v2-test", version: "1.0.0" }
      }
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("validates and forwards bounded retrieval hints", async () => {
    const { client, callTool } = await connect();

    await client.callTool({
      name: "memory_answer",
      arguments: {
        query: "Which exact migration was discussed?",
        retrieval_hints: {
          exact: ["0027_mute_ozymandias"],
          semantic: ["database migration decision"]
        }
      }
    });

    expect(callTool).toHaveBeenCalledWith(
      "memory_answer",
      expect.objectContaining({
        retrieval_hints: {
          exact: ["0027_mute_ozymandias"],
          semantic: ["database migration decision"]
        }
      }),
      expect.any(Object),
      expect.any(AbortSignal)
    );
  });

  it("keeps one adapter connection independent from another", async () => {
    const callTool = vi.fn(async (name: LocalRuntimeToolName) => ({
      ok: true,
      name
    }));
    const first = await connect({ callTool });
    const second = await connect({ callTool });

    await first.client.close();
    await expect(
      second.client.callTool({
        name: "memory_answer",
        arguments: { query: "The second adapter remains available." }
      })
    ).resolves.toMatchObject({
      structuredContent: { ok: true, name: "memory_answer" }
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("cancels active runtime work when the shared stdio connection closes", async () => {
    let observedSignal: AbortSignal | undefined;
    const callTool = vi.fn(
      async (
        _name: LocalRuntimeToolName,
        _input: Record<string, unknown>,
        _caller: LocalRuntimeCallerContext,
        signal?: AbortSignal
      ) => {
        observedSignal = signal;
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new Error("runtime cancelled")),
            { once: true }
          )
        );
        return { ok: true };
      }
    );
    const { client } = await connect({ callTool });
    const pending = client.callTool({
      name: "memory_answer",
      arguments: { query: "cancel me" }
    });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await client.close();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
  });

  it("serves current initialize clients through the same stateless adapter", async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const runtimeClient = {
      capabilities: async () => ({
        protocolVersion: 1 as const,
        curatedMemoryIntakeAvailable: false
      }),
      callTool
    } as unknown as LocalAiRuntimeClient;
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = serveStdio(
      (context) => createKoedMcpServer(context, { runtimeClient }),
      { transport: serverTransport, legacy: "serve" }
    );
    const client = new Client(
      { name: "current-initialize-client", version: "1.0.0" },
      {
        capabilities: {},
        versionNegotiation: { mode: "legacy" }
      }
    );
    await client.connect(clientTransport);
    await expect(
      client.callTool({
        name: "memory_answer",
        arguments: { query: "Can this AI Client recall memory?" }
      })
    ).resolves.toMatchObject({ structuredContent: { ok: true } });
    expect(callTool).toHaveBeenCalledTimes(1);
    await client.close();
    await server.close();
  });
});

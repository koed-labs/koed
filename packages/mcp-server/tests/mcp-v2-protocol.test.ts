import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle
} from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";
import releaseManifest from "@koed/koed/package.json" with { type: "json" };
import {
  createKoedMcpServer,
  KOED_MCP_PROTOCOL_VERSION,
  KOED_MCP_SERVER_VERSION,
  KOED_MCP_UNAVAILABLE_MESSAGE,
  resolveKoedMcpServerVersion,
  type McpCallerContextResolver
} from "../src/mcp-server-factory.js";
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
  callerContextResolver,
  callTool = vi.fn(async (name: LocalRuntimeToolName) => ({ ok: true, name }))
}: {
  curatedMemoryIntakeAvailable?: boolean;
  environment?: NodeJS.ProcessEnv;
  callerContextResolver?: McpCallerContextResolver;
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
        environment,
        callerContextResolver
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
  it("advertises the Koed release independently from its protocol version", () => {
    expect(KOED_MCP_SERVER_VERSION).toBe(releaseManifest.version);
    expect(KOED_MCP_PROTOCOL_VERSION).toBe("2026-07-28");
    expect(resolveKoedMcpServerVersion({ version: "1.2.3-beta.1" })).toBe(
      "1.2.3-beta.1"
    );
    expect(() => resolveKoedMcpServerVersion({ version: "01.2.3" })).toThrow(
      /valid SemVer/
    );
    expect(() =>
      resolveKoedMcpServerVersion({ version: "1.2.3-foo..bar" })
    ).toThrow(/valid SemVer/);
    expect(() => resolveKoedMcpServerVersion({ version: "unknown" })).toThrow(
      /valid SemVer/
    );
  });

  it("negotiates through server/discover and returns deterministic cacheable tools", async () => {
    const { client } = await connect();

    expect(client.getServerVersion()).toMatchObject({
      name: "koed-mcp",
      version: releaseManifest.version
    });
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

  it("starts in degraded mode and recovers when Koed becomes available", async () => {
    const callTool = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime is starting"))
      .mockResolvedValue({ ok: true });
    const capabilities = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime is starting"))
      .mockResolvedValue({
        protocolVersion: 1 as const,
        curatedMemoryIntakeAvailable: true
      });
    const runtimeClient = {
      capabilities,
      callTool
    } as unknown as LocalAiRuntimeClient;
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = serveStdio(
      (context) => createKoedMcpServer(context, { runtimeClient }),
      { transport: serverTransport, legacy: "serve" }
    );
    const client = new Client(
      { name: "unavailable-koed-test", version: "1.0.0" },
      { capabilities: {}, versionNegotiation: { mode: "legacy" } }
    );

    await expect(client.connect(clientTransport)).resolves.toBeUndefined();
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ name: "memory_answer" }]
    });

    await expect(
      client.callTool({
        name: "memory_answer",
        arguments: { query: "Can Koed recall this?" }
      })
    ).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: KOED_MCP_UNAVAILABLE_MESSAGE }]
    });

    await expect(
      client.callTool({
        name: "memory_answer",
        arguments: { query: "Can Koed recall this now?" }
      })
    ).resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ name: "memory_answer" }, { name: "memory_intake_propose" }]
    });
    await expect(
      client.callTool({
        name: "memory_intake_propose",
        arguments: {
          proposed_claim: "Remember this after Koed reconnects."
        }
      })
    ).resolves.toMatchObject({ structuredContent: { ok: true } });
    expect(capabilities).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenCalledTimes(3);
    await client.close();
    await server.close();
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

  it("allows a trusted transport to bind caller cwd without losing protocol metadata", async () => {
    const callTool = vi.fn(
      async (
        _name: LocalRuntimeToolName,
        _input: Record<string, unknown>,
        caller: LocalRuntimeCallerContext
      ) => ({ caller })
    );
    const { client } = await connect({
      callTool,
      callerContextResolver: ({ defaultContext }) => ({
        ...defaultContext,
        cwd: "/benchmark/project-a"
      })
    });

    const result = await client.callTool({
      name: "memory_answer",
      arguments: { query: "Use the trial Project." }
    });

    expect(result.structuredContent).toMatchObject({
      caller: {
        cwd: "/benchmark/project-a",
        protocolVersion: "2026-07-28",
        clientInfo: { name: "koed-mcp-v2-test", version: "1.0.0" }
      }
    });
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

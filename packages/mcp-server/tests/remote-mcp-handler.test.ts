import {
  Client,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRemoteKoedMcpHandler,
  type RemoteKoedMcpHandlerOptions
} from "../src/remote-mcp-handler.js";
import type { KoedMcpRuntimeClient } from "../src/mcp-server-factory.js";

const handles: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) await handle.close();
});

const runtime = () => ({
  capabilities: vi.fn(async () => ({
    protocolVersion: 1 as const,
    curatedMemoryIntakeAvailable: false,
    memoryAnswerTeamBackendAvailable: false,
    supportedTools: ["memory_answer" as const]
  })),
  callTool: vi.fn<KoedMcpRuntimeClient["callTool"]>(async () => ({
    markdown: "Retained evidence."
  })),
  startMemoryAnswerTask: vi.fn(),
  getMemoryAnswerTask: vi.fn(),
  cancelMemoryAnswerTask: vi.fn()
});

const setup = (options: Partial<RemoteKoedMcpHandlerOptions> = {}) => {
  const executor = runtime();
  const authenticate = vi.fn(async (request: Request) =>
    request.headers.get("authorization") === "Bearer valid"
      ? {
          principal: { userId: "user-one", tokenId: "token-one" },
          runtimeClient: executor as KoedMcpRuntimeClient
        }
      : null
  );
  const handler = createRemoteKoedMcpHandler({
    authenticate,
    allowedHosts: ["memory.test"],
    ...options
  });
  handles.push(handler);
  const connect = async (
    token = "valid",
    version: "2026-07-28" | "2025-11-25" = "2026-07-28"
  ) => {
    const client = new Client(
      { name: "remote-test", version: "1.0.0" },
      {
        capabilities: {},
        versionNegotiation: {
          mode: version === "2026-07-28" ? { pin: version } : "legacy"
        }
      }
    );
    handles.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://memory.test/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (input, init) =>
          handler.fetch(new Request(input as RequestInfo, init))
      })
    );
    return client;
  };
  return { handler, executor, authenticate, connect };
};

describe("authenticated remote MCP transport", () => {
  it("delivers a Team helper answer through the shared compact presentation", async () => {
    const executor = runtime();
    executor.capabilities.mockResolvedValue({
      protocolVersion: 1,
      curatedMemoryIntakeAvailable: false,
      memoryAnswerTeamBackendAvailable: true,
      supportedTools: ["memory_answer"]
    });
    const answerResponse = {
      markdown: "Team helper answer.",
      evidence: [{ text: "Shared fact" }],
      citations: [{ sourceId: "shared-source" }]
    };
    executor.callTool.mockResolvedValue(answerResponse);
    const { connect } = setup({
      authenticate: async () => ({
        principal: { userId: "user", tokenId: "token" },
        runtimeClient: executor
      })
    });
    const client = await connect();
    const response = await client.callTool({
      name: "memory_answer",
      arguments: {
        query: "fact",
        search_domain: "global",
        team_workspace_id: "7c07a3cc-5679-4df2-bb67-c86571df93c2",
        team_backend_id: "team"
      }
    });
    expect(response.structuredContent).toBeUndefined();
    expect(JSON.stringify(response.content)).toContain("Team helper answer.");
  });
  it.each(["2026-07-28", "2025-11-25"] as const)(
    "shares gated discovery and tool behavior over %s HTTP",
    async (version) => {
      const { connect, executor, authenticate } = setup({
        environment: { KOED_CODEX_STOP_DELIVERY: "1" }
      });
      const client = await connect("valid", version);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["memory_answer"]);
      const response = await client.callTool({
        name: "memory_answer",
        arguments: { query: "retained fact" }
      });
      expect(JSON.stringify(response.content)).toContain("Retained evidence.");
      expect(executor.callTool).toHaveBeenCalledWith(
        "memory_answer",
        expect.objectContaining({ query: "retained fact" }),
        expect.objectContaining({ cwd: "" }),
        expect.any(AbortSignal),
        expect.any(String)
      );
      expect(executor.startMemoryAnswerTask).not.toHaveBeenCalled();
      expect(authenticate.mock.calls.length).toBeGreaterThanOrEqual(3);
    }
  );

  it("denies discovery and calls without touching the executor", async () => {
    const { handler, executor, connect } = setup();
    await expect(connect("denied")).rejects.toThrow();
    const response = await handler.fetch(
      new Request("https://memory.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "memory_answer", arguments: { query: "secret" } }
        })
      })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.text()).not.toContain("memory_answer");
    expect(executor.capabilities).not.toHaveBeenCalled();
    expect(executor.callTool).not.toHaveBeenCalled();
  });

  it("revalidates credentials after successful discovery", async () => {
    const { connect, authenticate, executor } = setup();
    const client = await connect();
    await client.listTools();
    authenticate.mockResolvedValue(null);
    await expect(
      client.callTool({ name: "memory_answer", arguments: { query: "secret" } })
    ).rejects.toThrow();
    expect(executor.callTool).not.toHaveBeenCalled();
  });

  it("rejects browser origins and bounded bodies before discovery", async () => {
    const { handler, executor, authenticate } = setup({ maxBodyBytes: 8 });
    const deniedOrigin = await handler.fetch(
      new Request("https://memory.test/mcp", {
        headers: {
          origin: "https://untrusted.test",
          authorization: "Bearer valid"
        }
      })
    );
    expect(deniedOrigin.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
    const oversized = await handler.fetch(
      new Request("https://memory.test/mcp", {
        method: "POST",
        headers: { authorization: "Bearer valid" },
        body: "123456789"
      })
    );
    expect(oversized.status).toBe(413);
    expect(executor.capabilities).not.toHaveBeenCalled();
  });

  it("denies untrusted Host and advertises protected resource metadata on 401", async () => {
    const { handler, authenticate } = setup({
      protectedResourceMetadataUrl:
        "https://memory.test/.well-known/oauth-protected-resource"
    });
    const hostDenied = await handler.fetch(
      new Request("https://other.test/mcp")
    );
    expect(hostDenied.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
    const denied = await handler.fetch(new Request("https://memory.test/mcp"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://memory.test/.well-known/oauth-protected-resource"'
    );
  });

  it("keeps simultaneous authenticated executors isolated", async () => {
    const first = runtime();
    const second = runtime();
    second.callTool.mockResolvedValue({ markdown: "Second User evidence." });
    const { connect } = setup({
      authenticate: async (request) => {
        const isFirst = request.headers.get("authorization") === "Bearer first";
        return {
          principal: { userId: isFirst ? "first" : "second", tokenId: "token" },
          runtimeClient: isFirst ? first : second
        };
      }
    });
    const firstClient = await connect("first");
    const secondClient = await connect("second");
    const [firstResult, secondResult] = await Promise.all([
      firstClient.callTool({
        name: "memory_answer",
        arguments: { query: "one" }
      }),
      secondClient.callTool({
        name: "memory_answer",
        arguments: { query: "two" }
      })
    ]);
    expect(JSON.stringify(firstResult)).toContain("Retained evidence.");
    expect(JSON.stringify(secondResult)).toContain("Second User evidence.");
    expect(first.callTool.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ query: "one" })
    );
    expect(second.callTool.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ query: "two" })
    );
  });

  it.each(["2026-07-28", "2025-11-25"] as const)(
    "propagates %s closure to the waiter without explicitly cancelling durable work",
    async (version) => {
      const executor = runtime();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let signal: AbortSignal | undefined;
      executor.callTool = vi.fn(
        async (...args: Parameters<KoedMcpRuntimeClient["callTool"]>) => {
          signal = args[3];
          entered();
          await new Promise<void>((resolve) =>
            signal!.addEventListener("abort", () => resolve(), { once: true })
          );
          return { markdown: "Detached waiter." };
        }
      );
      const { handler, connect } = setup({
        authenticate: async () => ({
          principal: { userId: "user", tokenId: "token" },
          runtimeClient: executor
        })
      });
      const client = await connect("valid", version);
      const pending = client.callTool({
        name: "memory_answer",
        arguments: { query: "one" }
      });
      const settled = pending.catch(() => undefined);
      await started;
      await handler.close();
      await client.close();
      await settled;
      expect(signal?.aborted).toBe(true);
      expect(executor.cancelMemoryAnswerTask).not.toHaveBeenCalled();
    }
  );
});

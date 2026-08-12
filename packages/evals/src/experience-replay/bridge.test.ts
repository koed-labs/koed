import {
  Client,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAiRuntimeClient } from "@koed/mcp-server/runtime-contracts";
import { startBenchmarkBridge, type BenchmarkBridgeHandle } from "./bridge.js";

const open: BenchmarkBridgeHandle[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((bridge) => bridge.close()));
});

const start = async () => {
  const callTool = vi.fn<LocalAiRuntimeClient["callTool"]>(
    async (_name, _input, caller) => ({ caller })
  );
  const runtimeClient = {
    capabilities: async () => ({
      protocolVersion: 1 as const,
      curatedMemoryIntakeAvailable: false
    }),
    callTool
  } as unknown as LocalAiRuntimeClient;
  const bridge = await startBenchmarkBridge({
    runtimeClient,
    projectCwd: "/benchmark/task-a",
    identity: {
      runId: "run-a",
      trialId: "trial-a",
      taskDigest: `sha256:${"a".repeat(64)}`,
      condition: "relevant"
    }
  });
  open.push(bridge);
  return { bridge, callTool };
};

const rawStatus = async (
  bridge: BenchmarkBridgeHandle,
  options: http.RequestOptions
): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const request = http.request(bridge.url, options, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });

describe("experience replay MCP bridge", () => {
  it("rejects inactive credentials and forged origins", async () => {
    const { bridge } = await start();
    expect(
      await fetch(bridge.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.token}`,
          "content-type": "application/json"
        },
        body: "{}"
      })
    ).toMatchObject({ status: 401 });
    bridge.activate(60_000);
    expect(
      await fetch(bridge.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.token}`,
          "content-type": "application/json",
          origin: "https://attacker.example"
        },
        body: "{}"
      })
    ).toMatchObject({ status: 403 });
    await expect(
      rawStatus(bridge, {
        method: "POST",
        path: bridge.url,
        headers: {
          authorization: `Bearer ${bridge.token}`,
          host: new URL(bridge.url).host,
          "content-length": "0"
        }
      })
    ).resolves.toBe(400);
  });

  it("rejects cross-trial credentials and forged Host values", async () => {
    const first = await start();
    const second = await start();
    first.bridge.activate(60_000);
    second.bridge.activate(60_000);
    await expect(
      fetch(second.bridge.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${first.bridge.token}`,
          "content-type": "application/json"
        },
        body: "{}"
      })
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      rawStatus(second.bridge, {
        method: "POST",
        headers: {
          authorization: `Bearer ${second.bridge.token}`,
          host: "attacker.example",
          "content-length": "0"
        }
      })
    ).resolves.toBe(421);
  });

  it("rejects peers outside the trial allowlist before authentication", async () => {
    const runtimeClient = {
      capabilities: async () => ({
        protocolVersion: 1 as const,
        curatedMemoryIntakeAvailable: false
      }),
      callTool: vi.fn()
    } as unknown as LocalAiRuntimeClient;
    const bridge = await startBenchmarkBridge({
      runtimeClient,
      projectCwd: "/benchmark/task-a",
      identity: {
        runId: "run-a",
        trialId: "trial-unapproved-peer",
        taskDigest: `sha256:${"a".repeat(64)}`,
        condition: "empty"
      },
      allowedRemoteAddresses: []
    });
    open.push(bridge);
    bridge.activate(60_000);
    await expect(
      fetch(bridge.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.token}`,
          "content-type": "application/json"
        },
        body: "{}"
      })
    ).resolves.toMatchObject({ status: 403 });
  });

  it("rejects expired credentials and oversized declared bodies", async () => {
    const { bridge } = await start();
    bridge.activate(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      fetch(bridge.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.token}`,
          "content-type": "application/json"
        },
        body: "{}"
      })
    ).resolves.toMatchObject({ status: 401 });

    const active = await start();
    active.bridge.activate(60_000);
    const oversizedStatus = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        active.bridge.url,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${active.bridge.token}`,
            "content-length": String(16 * 1024 * 1024),
            "content-type": "application/json"
          }
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        }
      );
      request.once("error", reject);
      request.end();
    });
    expect(oversizedStatus).toBe(413);
  });

  it("serves repeated MCP 2026-07-28 calls with the trial-bound Project", async () => {
    const { bridge, callTool } = await start();
    bridge.activate(60_000);
    const client = new Client(
      { name: "experience-replay-test", version: "1.0.0" },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: "2026-07-28" } }
      }
    );
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      authProvider: { token: async () => bridge.token }
    });
    await client.connect(transport);
    try {
      expect(client.getProtocolEra()).toBe("modern");
      for (const query of ["first", "second"]) {
        await expect(
          client.callTool({ name: "memory_answer", arguments: { query } })
        ).resolves.toMatchObject({
          structuredContent: {
            caller: {
              cwd: "/benchmark/task-a",
              protocolVersion: "2026-07-28"
            }
          }
        });
      }
      expect(callTool).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
    }
  });

  it("rejects any MCP protocol other than 2026-07-28", async () => {
    const { bridge } = await start();
    bridge.activate(60_000);
    const client = new Client(
      { name: "experience-replay-old-client", version: "1.0.0" },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: "2025-11-25" } }
      }
    );
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      authProvider: { token: async () => bridge.token }
    });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("revokes a credential without retaining a secret-derived attestation", async () => {
    const { bridge } = await start();
    bridge.activate(60_000);
    bridge.revoke();
    const attestation = bridge.attestation();
    expect(attestation).toMatchObject({
      id: bridge.credentialId,
      identity: {
        runId: "run-a",
        trialId: "trial-a",
        condition: "relevant"
      }
    });
    expect(typeof attestation.activatedAt).toBe("number");
    expect(typeof attestation.revokedAt).toBe("number");
    expect(JSON.stringify(attestation)).not.toContain(bridge.token);
    expect(
      await fetch(bridge.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.token}`,
          "content-type": "application/json"
        },
        body: "{}"
      })
    ).toMatchObject({ status: 401 });
  });
});

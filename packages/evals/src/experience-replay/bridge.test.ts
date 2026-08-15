import {
  Client,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalAiRuntimeClient } from "@koed/mcp-server/runtime-contracts";
import {
  isBenchmarkDockerPeer,
  resolveDockerBridgeHost,
  startBenchmarkBridge,
  type BenchmarkBridgeHandle
} from "./bridge.js";
import { collectBridgeTelemetry } from "./bridge-telemetry.js";

const open: BenchmarkBridgeHandle[] = [];
let trialWorkspaceRoot: string;
let projectCwd: string;

beforeEach(async () => {
  trialWorkspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), "koed-replay-bridge-")
  );
  projectCwd = path.join(trialWorkspaceRoot, "task-a");
  await mkdir(projectCwd);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((bridge) => bridge.close()));
  await rm(trialWorkspaceRoot, { recursive: true, force: true });
});

const start = async () => {
  const callTool = vi.fn<LocalAiRuntimeClient["callTool"]>(
    async (_name, _input, caller) => ({
      caller,
      retrieval: { evidenceCount: 2, stages: [{ name: "dense" }] },
      localMemoryWorker: {
        searchCount: 1,
        expandCount: 0,
        appServerExecutions: [{ processMetrics: { peakRssBytes: 12_288 } }]
      }
    })
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
    projectCwd,
    trialWorkspaceRoot,
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
  it("advertises Docker's stable host gateway", () => {
    expect(resolveDockerBridgeHost()).toBe("host.docker.internal");
  });

  it("accepts only the dedicated Docker private pool as container peers", () => {
    expect(isBenchmarkDockerPeer("172.16.0.2")).toBe(true);
    expect(isBenchmarkDockerPeer("::ffff:172.31.255.254")).toBe(true);
    expect(isBenchmarkDockerPeer("172.15.255.254")).toBe(false);
    expect(isBenchmarkDockerPeer("192.168.1.2")).toBe(false);
    expect(isBenchmarkDockerPeer("172.16.0.999")).toBe(false);
  });

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
      projectCwd,
      trialWorkspaceRoot,
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
    let now = 1_000;
    const runtimeClient = {
      capabilities: async () => ({
        protocolVersion: 1 as const,
        curatedMemoryIntakeAvailable: false
      }),
      callTool: vi.fn()
    } as unknown as LocalAiRuntimeClient;
    const bridge = await startBenchmarkBridge({
      runtimeClient,
      projectCwd,
      trialWorkspaceRoot,
      identity: {
        runId: "run-a",
        trialId: "trial-expiry",
        taskDigest: `sha256:${"a".repeat(64)}`,
        condition: "relevant"
      },
      now: () => now
    });
    open.push(bridge);
    bridge.activate(1);
    now += 1;
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
              cwd: projectCwd,
              protocolVersion: "2026-07-28"
            }
          }
        });
      }
      expect(callTool).toHaveBeenCalledTimes(2);
      expect(bridge.telemetry()).toEqual({
        mcpCalls: 2,
        mcpFailures: 0,
        memoryAnswerCalls: 2,
        memoryAnswerFailures: 0,
        searches: 2,
        expansions: 0,
        stages: 2,
        evidenceCount: 4,
        workerPeakRssBytes: 12_288,
        memoryAnswerRequests: [
          { responseDetail: null, searchDomain: null },
          { responseDetail: null, searchDomain: null }
        ]
      });
      expect(collectBridgeTelemetry(bridge.url)).toEqual(bridge.telemetry());
    } finally {
      await client.close();
    }
  });

  it("canonicalizes a real Project beneath its explicit trial root", async () => {
    const nested = path.join(trialWorkspaceRoot, "nested", "task-b");
    await mkdir(nested, { recursive: true });
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
      projectCwd: path.join(nested, "..", "task-b"),
      trialWorkspaceRoot,
      identity: {
        runId: "run-a",
        trialId: "trial-canonical",
        taskDigest: `sha256:${"a".repeat(64)}`,
        condition: "empty"
      }
    });
    open.push(bridge);
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
      await client.callTool({
        name: "memory_answer",
        arguments: { query: "canonical" }
      });
      expect(callTool.mock.calls[0]?.[2]).toMatchObject({ cwd: nested });
    } finally {
      await client.close();
    }
  });

  it("rejects nonexistent, outside, root-equal, and symlinked Projects", async () => {
    const runtimeClient = {
      capabilities: vi.fn(),
      callTool: vi.fn()
    } as unknown as LocalAiRuntimeClient;
    const identity = {
      runId: "run-a",
      trialId: "trial-invalid-project",
      taskDigest: `sha256:${"a".repeat(64)}`,
      condition: "empty" as const
    };
    await expect(
      startBenchmarkBridge({
        runtimeClient,
        projectCwd: path.join(trialWorkspaceRoot, "missing"),
        trialWorkspaceRoot,
        identity
      })
    ).rejects.toThrow("must exist");
    await expect(
      startBenchmarkBridge({
        runtimeClient,
        projectCwd: path.dirname(trialWorkspaceRoot),
        trialWorkspaceRoot,
        identity
      })
    ).rejects.toThrow("beneath");
    await expect(
      startBenchmarkBridge({
        runtimeClient,
        projectCwd: trialWorkspaceRoot,
        trialWorkspaceRoot,
        identity
      })
    ).rejects.toThrow("beneath");
    const link = path.join(trialWorkspaceRoot, "linked-task");
    await symlink(projectCwd, link, "dir");
    await expect(
      startBenchmarkBridge({
        runtimeClient,
        projectCwd: link,
        trialWorkspaceRoot,
        identity
      })
    ).rejects.toThrow("without symlinks");
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

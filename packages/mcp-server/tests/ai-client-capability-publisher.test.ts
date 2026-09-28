import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiClientCapabilityDescriptor,
  AiClientModelCapability
} from "@koed/shared";
import { storeLocalEdgeClientCredential } from "@koed/shared";
import { MemoryApiClient } from "../src/index.js";
import {
  aiClientDriverRegistry,
  type AiClientDriver
} from "../src/ai-client-runner.js";
import { publishAiClientCapabilities } from "../src/ai-client-capability-publisher.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

const executable = (root: string, name: string): string => {
  const target = path.join(root, name);
  fs.writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return target;
};

const descriptor = (): AiClientCapabilityDescriptor => ({
  id: "local_synthesis",
  support: "supported",
  readiness: "ready",
  diagnostics: []
});

const driver = (
  id: AiClientDriver["id"],
  seen: Array<{ instanceId: string; executablePath?: string }>
): AiClientDriver => {
  const discover: AiClientDriver["discover"] = async (input) => {
    seen.push({
      instanceId: input.instanceId,
      executablePath: input.executablePath
    });
    return {
      installationIdentityHash: "a".repeat(64),
      clientVersion: "test",
      authenticationState: "authenticated" as const,
      healthState: "healthy" as const,
      models: [
        {
          id: `${id}-model`,
          model: `${id}-model`,
          provenance: "reported" as const,
          options: {
            api_key: "private-model-secret",
            config_path: "/Users/private/provider.json"
          }
        } satisfies AiClientModelCapability
      ],
      capabilities: [descriptor()],
      diagnostics: []
    };
  };
  return {
    id,
    displayName: id,
    runJsonTask: vi.fn(),
    discover: vi.fn(discover)
  };
};

describe("AI Client capability publisher", () => {
  it("publishes no instances for an empty explicit registry", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-publisher-empty-")
    );
    roots.push(root);
    const registryPath = path.join(root, "instances.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ version: 1, instances: [] })
    );
    const apiClient = {
      upsertAiClientInstance: vi.fn(async () => ({})),
      recordAiClientCapabilitySnapshot: vi.fn(async () => ({}))
    } as unknown as MemoryApiClient;

    await expect(
      publishAiClientCapabilities(apiClient, {
        KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath
      })
    ).resolves.toEqual([]);
    expect(apiClient.upsertAiClientInstance).not.toHaveBeenCalled();
    expect(apiClient.recordAiClientCapabilitySnapshot).not.toHaveBeenCalled();
  });

  it("publishes safe capability metadata through the enrolled upstream route", async () => {
    const original = aiClientDriverRegistry.get("codex");
    const seen: Array<{ instanceId: string; executablePath?: string }> = [];
    aiClientDriverRegistry.set("codex", driver("codex", seen));
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-publisher-upstream-")
    );
    roots.push(root);
    const executablePath = executable(root, "local-secret-path");
    const registryPath = path.join(root, "instances.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "codex.default",
            driverId: "codex",
            displayName: "/Users/private-machine/AI Client",
            executablePath,
            configHome: "/Users/private-machine/.codex"
          }
        ]
      })
    );
    storeLocalEdgeClientCredential(root, {
      backendId: "hosted",
      secret: "local-edge-secret",
      operationFamilies: ["ai_client_capability_publish"]
    });
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config", "upstream-backends.json"),
      JSON.stringify({
        schemaVersion: 2,
        activeBackendId: "hosted",
        backends: [
          {
            id: "hosted",
            baseUrl: "https://hosted.example.test",
            routePolicy: { managedExecution: "enabled" },
            capabilities: {
              state: "validated",
              expiresAt: new Date(Date.now() + 60_000).toISOString()
            }
          }
        ]
      })
    );
    const upstreamOperations: Array<Record<string, unknown>> = [];
    const publishUpstream = vi.fn(
      async (
        _backendId: string,
        _authorization: string,
        operation: Record<string, unknown>
      ) => {
        upstreamOperations.push(operation);
        return {};
      }
    );
    const apiClient = {
      upsertAiClientInstance: vi.fn(async () => ({})),
      recordAiClientCapabilitySnapshot: vi.fn(async () => ({})),
      publishAiClientUpstreamOperation: publishUpstream
    } as unknown as MemoryApiClient;
    try {
      await expect(
        publishAiClientCapabilities(apiClient, {
          KOED_HOME: root,
          KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath
        })
      ).resolves.toMatchObject([
        { instanceId: "codex.default", published: true }
      ]);
    } finally {
      if (original) aiClientDriverRegistry.set("codex", original);
      else aiClientDriverRegistry.delete("codex");
    }

    expect(apiClient.upsertAiClientInstance).toHaveBeenCalledOnce();
    expect(apiClient.recordAiClientCapabilitySnapshot).toHaveBeenCalledOnce();
    expect(upstreamOperations).toHaveLength(2);
    expect(upstreamOperations[0]).toMatchObject({
      method: "PUT",
      path: "/v1/memory/ai-client-instances/codex.default",
      body: { driver_id: "codex", display_name: "codex" }
    });
    expect(upstreamOperations[1]).toMatchObject({
      method: "POST",
      path: "/v1/memory/ai-client-instances/codex.default/capability-snapshots"
    });
    expect(JSON.stringify(upstreamOperations)).not.toContain("private-machine");
    expect(JSON.stringify(upstreamOperations)).not.toContain(executablePath);
    expect(JSON.stringify(upstreamOperations)).not.toContain("/Users/");
    expect(JSON.stringify(upstreamOperations)).not.toContain(
      "private-model-secret"
    );
    expect(JSON.stringify(upstreamOperations)).not.toContain('"options"');
    publishUpstream.mockRejectedValue(new Error("private upstream detail"));
    const localStillPublished = await publishAiClientCapabilities(apiClient, {
      KOED_HOME: root,
      KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath
    });
    expect(localStillPublished).toMatchObject([
      {
        published: true,
        hostedPublication: "failed"
      }
    ]);
    expect(apiClient.upsertAiClientInstance).toHaveBeenCalledTimes(2);
    expect(apiClient.recordAiClientCapabilitySnapshot).toHaveBeenCalledTimes(2);
  });

  it("uses only the active managed-execution backend for every refresh", async () => {
    const original = aiClientDriverRegistry.get("codex");
    const seen: Array<{ instanceId: string; executablePath?: string }> = [];
    aiClientDriverRegistry.set("codex", driver("codex", seen));
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-publisher-active-backend-")
    );
    roots.push(root);
    const registryPath = path.join(root, "instances.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "codex.default",
            driverId: "codex",
            displayName: "Codex",
            executablePath: executable(root, "codex"),
            configHome: path.join(root, "codex-home")
          }
        ]
      })
    );
    for (const backendId of ["backend-a", "backend-b"]) {
      storeLocalEdgeClientCredential(root, {
        backendId,
        secret: `${backendId}-secret`,
        operationFamilies: ["ai_client_capability_publish"]
      });
    }
    const upstreamRegistryPath = path.join(
      root,
      "config",
      "upstream-backends.json"
    );
    fs.mkdirSync(path.dirname(upstreamRegistryPath), { recursive: true });
    const setActive = (activeBackendId: string | null) => {
      fs.writeFileSync(
        upstreamRegistryPath,
        JSON.stringify({
          schemaVersion: 2,
          activeBackendId,
          backends: ["backend-a", "backend-b"].map((id) => ({
            id,
            baseUrl: `https://${id}.example.test`,
            routePolicy: { managedExecution: "enabled" },
            capabilities: {
              state: "validated",
              expiresAt: new Date(Date.now() + 60_000).toISOString()
            }
          }))
        })
      );
      const future = new Date(Date.now() + 1_000 + Math.random() * 1_000);
      fs.utimesSync(upstreamRegistryPath, future, future);
    };
    const publishedBackendIds: string[] = [];
    const apiClient = {
      upsertAiClientInstance: vi.fn(async () => ({})),
      recordAiClientCapabilitySnapshot: vi.fn(async () => ({})),
      publishAiClientUpstreamOperation: vi.fn(async (backendId: string) => {
        publishedBackendIds.push(backendId);
        return {};
      })
    } as unknown as MemoryApiClient;
    try {
      for (const selected of ["backend-a", "backend-b", null]) {
        setActive(selected);
        await publishAiClientCapabilities(apiClient, {
          KOED_HOME: root,
          KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath
        });
      }
      fs.writeFileSync(upstreamRegistryPath, "{invalid");
      const future = new Date(Date.now() + 3_000);
      fs.utimesSync(upstreamRegistryPath, future, future);
      await publishAiClientCapabilities(apiClient, {
        KOED_HOME: root,
        KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath
      });
    } finally {
      if (original) aiClientDriverRegistry.set("codex", original);
      else aiClientDriverRegistry.delete("codex");
    }
    expect(publishedBackendIds).toEqual([
      "backend-a",
      "backend-a",
      "backend-b",
      "backend-b"
    ]);
  });

  it("refreshes expired active upstream capabilities before hosted publication", async () => {
    const original = aiClientDriverRegistry.get("codex");
    const seen: Array<{ instanceId: string; executablePath?: string }> = [];
    aiClientDriverRegistry.set("codex", driver("codex", seen));
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-publisher-stale-upstream-")
    );
    roots.push(root);
    const registryPath = path.join(root, "instances.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "codex.default",
            driverId: "codex",
            displayName: "Codex",
            executablePath: executable(root, "codex")
          }
        ]
      })
    );
    storeLocalEdgeClientCredential(root, {
      backendId: "hosted",
      secret: "local-edge-secret",
      operationFamilies: ["ai_client_capability_publish"]
    });
    const upstreamRegistryPath = path.join(
      root,
      "config",
      "upstream-backends.json"
    );
    fs.mkdirSync(path.dirname(upstreamRegistryPath), { recursive: true });
    fs.writeFileSync(
      upstreamRegistryPath,
      JSON.stringify({
        schemaVersion: 2,
        activeBackendId: "hosted",
        backends: [
          {
            id: "hosted",
            baseUrl: "https://hosted.example.test",
            routePolicy: { managedExecution: "enabled" },
            capabilities: {
              state: "validated",
              expiresAt: "2000-01-01T00:00:00.000Z"
            }
          }
        ]
      })
    );
    const refreshTracePath = path.join(root, "refresh-trace.txt");
    const serverCliPath = path.join(root, "fake-koed-server-cli.cjs");
    fs.writeFileSync(
      serverCliPath,
      [
        'const fs = require("node:fs");',
        'const expected = ["upstream", "refresh", "--id", "hosted", "--json"];',
        'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(2);',
        'fs.appendFileSync(process.env.REFRESH_TRACE_PATH, "refresh\\n");',
        'process.stdout.write(JSON.stringify({ ok: true, state: "validated" }));'
      ].join("\n")
    );
    const events: string[] = [];
    const apiClient = {
      upsertAiClientInstance: vi.fn(async () => ({})),
      recordAiClientCapabilitySnapshot: vi.fn(async () => ({})),
      publishAiClientUpstreamOperation: vi.fn(async () => {
        events.push(
          fs.existsSync(refreshTracePath)
            ? "publish-after-refresh"
            : "publish-before-refresh"
        );
        return {};
      })
    } as unknown as MemoryApiClient;
    try {
      const result = await publishAiClientCapabilities(
        apiClient,
        {
          KOED_HOME: root,
          KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath,
          KOED_SERVER_CLI_PATH: serverCliPath,
          REFRESH_TRACE_PATH: refreshTracePath
        }
      );
      expect(result).toMatchObject([
        {
          instanceId: "codex.default",
          published: true,
          hostedPublication: "published"
        }
      ]);
    } finally {
      if (original) aiClientDriverRegistry.set("codex", original);
      else aiClientDriverRegistry.delete("codex");
    }

    expect(fs.readFileSync(refreshTracePath, "utf8")).toBe("refresh\n");
    expect(events).toEqual(["publish-after-refresh", "publish-after-refresh"]);
  });

  it("keeps hosted publication failed when the supported upstream refresh fails", async () => {
    const original = aiClientDriverRegistry.get("codex");
    const seen: Array<{ instanceId: string; executablePath?: string }> = [];
    aiClientDriverRegistry.set("codex", driver("codex", seen));
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-publisher-stale-upstream-failure-")
    );
    roots.push(root);
    const registryPath = path.join(root, "instances.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "codex.default",
            driverId: "codex",
            displayName: "Codex",
            executablePath: executable(root, "codex")
          }
        ]
      })
    );
    storeLocalEdgeClientCredential(root, {
      backendId: "hosted",
      secret: "local-edge-secret",
      operationFamilies: ["ai_client_capability_publish"]
    });
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config", "upstream-backends.json"),
      JSON.stringify({
        schemaVersion: 2,
        activeBackendId: "hosted",
        backends: [
          {
            id: "hosted",
            baseUrl: "https://hosted.example.test",
            routePolicy: { managedExecution: "enabled" },
            capabilities: { state: "stale" }
          }
        ]
      })
    );
    const refresh = vi.fn(async () => false);
    const apiClient = {
      upsertAiClientInstance: vi.fn(async () => ({})),
      recordAiClientCapabilitySnapshot: vi.fn(async () => ({})),
      publishAiClientUpstreamOperation: vi.fn(async () => ({}))
    } as unknown as MemoryApiClient;
    try {
      await expect(
        publishAiClientCapabilities(
          apiClient,
          { KOED_HOME: root, KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath },
          { refreshUpstreamCapabilities: refresh }
        )
      ).resolves.toMatchObject([
        {
          instanceId: "codex.default",
          published: true,
          hostedPublication: "failed"
        }
      ]);
    } finally {
      if (original) aiClientDriverRegistry.set("codex", original);
      else aiClientDriverRegistry.delete("codex");
    }

    expect(refresh).toHaveBeenCalledOnce();
    expect(apiClient.publishAiClientUpstreamOperation).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "discovers clients concurrently and respects stop (%s)",
    async (stop) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-publisher-parallel-")
      );
      roots.push(root);
      const registryPath = path.join(root, "instances.json");
      const ids = ["codex", "claude", "pi"] as const;
      fs.writeFileSync(
        registryPath,
        JSON.stringify({
          version: 1,
          instances: ids.map((id) => ({
            instanceId: `${id}.default`,
            driverId: id,
            displayName: id,
            executablePath: executable(root, id)
          }))
        })
      );
      const originals = new Map(aiClientDriverRegistry);
      const seen: Array<{ instanceId: string; executablePath?: string }> = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let active = true;
      const apiClient = {
        upsertAiClientInstance: vi.fn(),
        recordAiClientCapabilitySnapshot: vi.fn()
      } as unknown as MemoryApiClient;
      try {
        for (const id of ids) {
          const base = driver(id, seen);
          aiClientDriverRegistry.set(id, {
            ...base,
            discover: async (input) => {
              const discovery = await base.discover(input);
              await gate;
              return discovery;
            }
          });
        }
        const pending = publishAiClientCapabilities(
          apiClient,
          { KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath },
          { isActive: () => active }
        );
        await Promise.resolve();
        try {
          expect(seen.map((item) => item.instanceId)).toEqual(
            ids.map((id) => `${id}.default`)
          );
        } finally {
          active = !stop;
          release();
          await pending;
        }
        expect(
          apiClient.recordAiClientCapabilitySnapshot
        ).toHaveBeenCalledTimes(stop ? 0 : 3);
      } finally {
        for (const [id, original] of originals)
          aiClientDriverRegistry.set(id, original);
      }
    }
  );

  it("publishes only explicitly configured instances", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-publisher-"));
    roots.push(root);
    const configuredExecutable = executable(root, "codex-work");
    const registryPath = path.join(root, "instances.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "codex.default",
            driverId: "codex",
            displayName: "Work Codex",
            executablePath: configuredExecutable
          }
        ]
      })
    );
    const seen: Array<{ instanceId: string; executablePath?: string }> = [];
    const originals = new Map(aiClientDriverRegistry);
    for (const id of ["codex", "claude", "pi"] as const) {
      aiClientDriverRegistry.set(id, driver(id, seen));
    }
    const upserts: string[] = [];
    const snapshots: string[] = [];
    const apiClient = {
      upsertAiClientInstance: vi.fn(async (instanceId: string) => {
        upserts.push(instanceId);
        return {};
      }),
      recordAiClientCapabilitySnapshot: vi.fn(async (instanceId: string) => {
        snapshots.push(instanceId);
        return {};
      })
    } as unknown as MemoryApiClient;

    try {
      const result = await publishAiClientCapabilities(apiClient, {
        KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath
      });

      expect(result).toHaveLength(1);
      expect(upserts).toEqual(["codex.default"]);
      expect(snapshots).toEqual(upserts);
      const upsertMock = apiClient.upsertAiClientInstance as unknown as {
        mock: { calls: unknown[][] };
      };
      const upsertCall = upsertMock.mock.calls[0] as
        | [string, { config_identity_hash?: unknown }]
        | undefined;
      expect(upsertCall?.[0]).toBe("codex.default");
      expect(upsertCall?.[1].config_identity_hash).toEqual(
        expect.stringMatching(/^[0-9a-f]{64}$/)
      );
      const snapshotMock =
        apiClient.recordAiClientCapabilitySnapshot as unknown as {
          mock: { calls: unknown[][] };
        };
      const snapshotCall = snapshotMock.mock.calls[0] as
        | [string, { installation_identity_hash?: unknown }]
        | undefined;
      expect(snapshotCall?.[1].installation_identity_hash).toBe(
        upsertCall?.[1].config_identity_hash
      );
      expect(snapshotCall?.[1].installation_identity_hash).not.toBe(
        "a".repeat(64)
      );
      expect(seen).toContainEqual({
        instanceId: "codex.default",
        executablePath: configuredExecutable
      });
    } finally {
      for (const [id, original] of originals) {
        aiClientDriverRegistry.set(id, original);
      }
    }
  });

  it("publishes unavailable snapshot for a missing executable", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-publisher-missing-")
    );
    roots.push(root);
    const registryPath = path.join(root, "instances.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "codex.missing",
            driverId: "codex",
            displayName: "Missing Codex",
            executablePath: path.join(root, "missing")
          }
        ]
      })
    );
    const apiClient = {
      upsertAiClientInstance: vi.fn(async () => ({})),
      recordAiClientCapabilitySnapshot: vi.fn(async () => ({}))
    } as unknown as MemoryApiClient;
    const result = await publishAiClientCapabilities(apiClient, {
      KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath
    });
    expect(result).toEqual([
      expect.objectContaining({ instanceId: "codex.missing", published: true })
    ]);
    expect(apiClient.recordAiClientCapabilitySnapshot).toHaveBeenCalledWith(
      "codex.missing",
      expect.objectContaining({ health_state: "unavailable" })
    );
  });

  it("publishes a useful snapshot for a registered signed-out Claude instance", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-publisher-claude-signed-out-")
    );
    roots.push(root);
    const executablePath = executable(root, "claude");
    const registryPath = path.join(root, "instances.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "claude.default",
            driverId: "claude",
            displayName: "Claude Code",
            executablePath
          }
        ]
      })
    );
    const original = aiClientDriverRegistry.get("claude")!;
    aiClientDriverRegistry.set("claude", {
      ...original,
      discover: vi.fn(async () => ({
        installationIdentityHash: "a".repeat(64),
        clientVersion: "2.1.227",
        authenticationState: "unauthenticated" as const,
        healthState: "unavailable" as const,
        models: [],
        capabilities: [
          {
            id: "automatic_capture" as const,
            support: "supported" as const,
            readiness: "unknown" as const,
            diagnostics: []
          },
          {
            id: "local_synthesis" as const,
            support: "supported" as const,
            readiness: "unauthenticated" as const,
            diagnostics: []
          }
        ],
        diagnostics: []
      }))
    });
    const apiClient = {
      upsertAiClientInstance: vi.fn(async () => ({})),
      recordAiClientCapabilitySnapshot: vi.fn(async () => ({}))
    } as unknown as MemoryApiClient;

    try {
      await expect(
        publishAiClientCapabilities(apiClient, {
          KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath
        })
      ).resolves.toEqual([
        expect.objectContaining({
          instanceId: "claude.default",
          published: true,
          error: null
        })
      ]);
      const snapshotMock =
        apiClient.recordAiClientCapabilitySnapshot as unknown as {
          mock: { calls: unknown[][] };
        };
      const snapshotCall = snapshotMock.mock.calls[0] as
        | [
            string,
            {
              client_version: string;
              authentication_state: string;
              health_state: string;
              models: unknown[];
              capabilities: {
                descriptors: Record<string, { readiness?: string }>;
                diagnostics: unknown[];
              };
            }
          ]
        | undefined;
      expect(snapshotCall?.[0]).toBe("claude.default");
      expect(snapshotCall?.[1].client_version).toBe("2.1.227");
      expect(snapshotCall?.[1].authentication_state).toBe("unauthenticated");
      expect(snapshotCall?.[1].health_state).toBe("unavailable");
      expect(snapshotCall?.[1].models).toEqual([]);
      expect(
        snapshotCall?.[1].capabilities.descriptors.automatic_capture?.readiness
      ).toBe("unknown");
      expect(
        snapshotCall?.[1].capabilities.descriptors.local_synthesis?.readiness
      ).toBe("unauthenticated");
    } finally {
      aiClientDriverRegistry.set("claude", original);
    }
  });

  it("isolates malformed configured entries from healthy instances", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-publisher-malformed-")
    );
    roots.push(root);
    const healthyExecutable = executable(root, "healthy");
    const registryPath = path.join(root, "instances.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "codex.malformed",
            driverId: "codex",
            displayName: "Malformed Codex",
            executablePath: path.join(root, "missing"),
            unexpected: true
          },
          {
            instanceId: "codex.healthy",
            driverId: "codex",
            displayName: "Healthy Codex",
            executablePath: healthyExecutable
          }
        ]
      })
    );
    const originals = new Map(aiClientDriverRegistry);
    const seen: string[] = [];
    aiClientDriverRegistry.set("codex", driver("codex", []));
    const apiClient = {
      upsertAiClientInstance: vi.fn(async (instanceId: string) => {
        seen.push(`instance:${instanceId}`);
        return {};
      }),
      recordAiClientCapabilitySnapshot: vi.fn(async (instanceId: string) => {
        seen.push(`snapshot:${instanceId}`);
        return {};
      })
    } as unknown as MemoryApiClient;
    try {
      const result = await publishAiClientCapabilities(apiClient, {
        KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        instanceId: "codex.malformed",
        published: true
      });
      expect(result[0]?.error).toContain("unknown or missing fields");
      expect(result[1]).toMatchObject({
        instanceId: "codex.healthy",
        published: true,
        error: null
      });
      expect(seen).toEqual([
        "instance:codex.malformed",
        "snapshot:codex.malformed",
        "instance:codex.healthy",
        "snapshot:codex.healthy"
      ]);
    } finally {
      for (const [id, original] of originals) {
        aiClientDriverRegistry.set(id, original);
      }
    }
  });

  it("publishes per-instance discovery failures without dropping healthy instances", async () => {
    const originals = new Map(aiClientDriverRegistry);
    const seen: Array<{ instanceId: string; executablePath?: string }> = [];
    const healthy = driver("codex", seen);
    const failing = {
      ...driver("claude", seen),
      discover: vi.fn(async () => {
        throw new Error("auth probe failed");
      })
    } satisfies AiClientDriver;
    aiClientDriverRegistry.set("codex", healthy);
    aiClientDriverRegistry.set("claude", failing);
    aiClientDriverRegistry.set("pi", driver("pi", seen));
    const published: string[] = [];
    const apiClient = {
      upsertAiClientInstance: vi.fn(async (instanceId: string) => {
        published.push(instanceId);
        return {};
      }),
      recordAiClientCapabilitySnapshot: vi.fn(async (instanceId: string) => {
        published.push(`snapshot:${instanceId}`);
        return {};
      })
    } as unknown as MemoryApiClient;

    try {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-publisher-failures-")
      );
      roots.push(root);
      const executablePath = executable(root, "client");
      const registryPath = path.join(root, "instances.json");
      fs.writeFileSync(
        registryPath,
        JSON.stringify({
          version: 1,
          instances: [
            {
              instanceId: "codex.default",
              driverId: "codex",
              displayName: "Codex",
              executablePath
            },
            {
              instanceId: "claude.default",
              driverId: "claude",
              displayName: "Claude",
              executablePath
            },
            {
              instanceId: "pi.default",
              driverId: "pi",
              displayName: "Pi",
              executablePath
            }
          ]
        })
      );
      const result = await publishAiClientCapabilities(apiClient, {
        KOED_AI_CLIENT_INSTANCE_REGISTRY: registryPath
      });

      expect(result).toEqual([
        expect.objectContaining({
          instanceId: "codex.default",
          published: true
        }),
        expect.objectContaining({
          instanceId: "claude.default",
          published: true
        }),
        expect.objectContaining({ instanceId: "pi.default", published: true })
      ]);
      expect(published).toContain("snapshot:claude.default");
    } finally {
      for (const [id, original] of originals) {
        aiClientDriverRegistry.set(id, original);
      }
    }
  });
});

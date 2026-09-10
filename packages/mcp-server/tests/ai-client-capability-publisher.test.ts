import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiClientCapabilityDescriptor,
  AiClientModelCapability
} from "@koed/shared";
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
          provenance: "reported" as const
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

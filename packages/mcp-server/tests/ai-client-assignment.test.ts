import { describe, expect, it, vi } from "vitest";
import { resolveLocalMemoryAgentConfig } from "../src/ai-client-assignment.js";

const identityHash = "f".repeat(64);

const setting = (
  provider: "codex" | "claude" | "pi",
  flowKey:
    | "mcp_memory_answer"
    | "lcm_summary"
    | "session_title"
    | "curated_memory_review" = "mcp_memory_answer"
) => ({
  ownerUserId: "user",
  flowKey,
  provider,
  aiClientInstanceId: `${provider}.work`,
  model: "provider/model",
  reasoningEffort: "high",
  timeoutMs: 10_000,
  maxAttempts: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
});

const clientFor = (
  provider: "codex" | "claude" | "pi",
  effort = true,
  flowKey:
    | "mcp_memory_answer"
    | "lcm_summary"
    | "session_title"
    | "curated_memory_review" = "mcp_memory_answer"
) => ({
  listLocalMemoryAgentSettings: vi.fn(async () => ({
    settings: [setting(provider, flowKey)]
  })),
  listAiClientInstances: vi.fn(async () => ({
    instances: [
      {
        instanceId: `${provider}.work`,
        driverId: provider,
        enabled: true,
        configIdentityHash: identityHash
      }
    ],
    capabilitySnapshots: [
      {
        instanceId: `${provider}.work`,
        installationIdentityHash: identityHash,
        healthState: "healthy",
        authenticationState: "authenticated",
        stale: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        models: [
          {
            fullId: "provider/model",
            supportedReasoningEfforts: effort ? ["high"] : undefined
          }
        ] as Array<Record<string, unknown>>,
        capabilities: {
          descriptors: {
            local_synthesis: {
              support: "supported",
              readiness: "ready"
            }
          }
        }
      }
    ]
  }))
});

describe("AI Client assignment revalidation", () => {
  it("validates a native Codex model ID when the capability also has a qualified full ID", async () => {
    const client = clientFor("codex");
    const settings = await client.listLocalMemoryAgentSettings();
    settings.settings[0]!.model = "gpt-5.6-luna";
    client.listLocalMemoryAgentSettings.mockResolvedValue(settings);
    const current = await client.listAiClientInstances();
    current.capabilitySnapshots[0]!.models = [
      {
        id: "gpt-5.6-luna",
        fullId: "openai/gpt-5.6-luna",
        supportedReasoningEfforts: ["high"]
      }
    ];
    client.listAiClientInstances.mockResolvedValue(current);

    await expect(
      resolveLocalMemoryAgentConfig({
        client,
        flowKey: "mcp_memory_answer",
        fallback: () => "env-default",
        fromSetting: () => "assigned"
      })
    ).resolves.toBe("assigned");

    settings.settings[0]!.model = "openai/gpt-5.6-luna";
    client.listLocalMemoryAgentSettings.mockResolvedValue(settings);
    await expect(
      resolveLocalMemoryAgentConfig({
        client,
        flowKey: "mcp_memory_answer",
        fallback: () => "env-default",
        fromSetting: () => "assigned"
      })
    ).resolves.toBe("assigned");
  });

  it.each([
    ["codex", "mcp_memory_answer"],
    ["claude", "lcm_summary"],
    ["pi", "session_title"],
    ["codex", "curated_memory_review"]
  ] as const)(
    "revalidates %s assignment for %s before execution",
    async (provider, flowKey) => {
      const client = clientFor(provider, true, flowKey);
      await expect(
        resolveLocalMemoryAgentConfig({
          client,
          flowKey,
          fallback: () => "env-default",
          fromSetting: () => "assigned"
        })
      ).resolves.toBe("assigned");
      expect(client.listAiClientInstances).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    "mcp_memory_answer",
    "lcm_summary",
    "session_title",
    "curated_memory_review"
  ] as const)(
    "checks local synthesis readiness for %s assignment",
    async (flowKey) => {
      const client = clientFor("codex", true, flowKey);
      const result = await client.listAiClientInstances();
      const descriptor = result.capabilitySnapshots[0]!.capabilities
        .descriptors!.local_synthesis as Record<string, unknown>;
      descriptor.readiness = "not_ready";
      client.listAiClientInstances.mockResolvedValue(result);

      await expect(
        resolveLocalMemoryAgentConfig({
          client,
          flowKey,
          fallback: () => "env-default",
          fromSetting: () => "assigned"
        })
      ).rejects.toThrow(new RegExp(`local synthesis.*${flowKey}`));
    }
  );

  it("uses env default only when assignment is absent", async () => {
    const client = {
      listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
      listAiClientInstances: vi.fn()
    };
    await expect(
      resolveLocalMemoryAgentConfig({
        client,
        flowKey: "mcp_memory_answer",
        fallback: () => "env-default",
        fromSetting: () => "assigned"
      })
    ).resolves.toBe("env-default");
  });

  it("does not fall back when settings API fails", async () => {
    const client = {
      listLocalMemoryAgentSettings: vi.fn(async () => {
        throw new Error("backend unavailable");
      }),
      listAiClientInstances: vi.fn()
    };
    await expect(
      resolveLocalMemoryAgentConfig({
        client,
        flowKey: "mcp_memory_answer",
        fallback: () => "env-default",
        fromSetting: () => "assigned"
      })
    ).rejects.toThrow("settings API failed");
  });

  it("fails closed when assigned settings cannot revalidate capabilities", async () => {
    const client = {
      listLocalMemoryAgentSettings: vi.fn(async () => ({
        settings: [setting("codex")]
      }))
    };
    await expect(
      resolveLocalMemoryAgentConfig({
        client: client as never,
        flowKey: "mcp_memory_answer",
        fallback: () => "env-default",
        fromSetting: () => "assigned"
      })
    ).rejects.toThrow("capability API");
  });

  it.each([
    ["codex", "mcp_memory_answer"],
    ["claude", "lcm_summary"],
    ["pi", "session_title"],
    ["codex", "curated_memory_review"]
  ] as const)(
    "fails closed for %s %s when effort metadata is absent",
    async (provider, flowKey) => {
      const client = clientFor(provider, false, flowKey);
      await expect(
        resolveLocalMemoryAgentConfig({
          client,
          flowKey,
          fallback: () => "env-default",
          fromSetting: () => "assigned"
        })
      ).rejects.toThrow(/reasoning effort/i);
    }
  );
});

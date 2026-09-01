import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateState,
  healthy,
  inspectAiClientReadiness
} from "../../koed-server/src/status.js";
import { migrateKoedOwnedCodexRegistration } from "../../koed-server/src/ai-client-registry.js";
import { resolveLocalMemoryAgentConfig } from "../src/ai-client-assignment.js";
import { ManagedConversationRuntimeRegistry } from "../../../apps/worker/src/managed-conversation-provider-runtime.js";
import { assertManagedConversationExecutionOwner } from "../../../apps/worker/src/managed-conversation-service.js";
import type {
  LocalMemoryAgentSettingRecord,
  MemoryApiClient
} from "../src/index.js";

const now = "2026-01-01T00:00:00.000Z";
const identityHash = "f".repeat(64);
type Provider = "codex" | "claude" | "pi";
type ReadinessInput = Parameters<typeof inspectAiClientReadiness>[0];
type CapabilityReadModel = NonNullable<ReadinessInput["capabilityReadModel"]>;
type Flow =
  | "mcp_memory_answer"
  | "lcm_summary"
  | "session_title"
  | "curated_memory_review";

const allProviders: Provider[] = ["codex", "claude", "pi"];
const allFlows: Flow[] = [
  "mcp_memory_answer",
  "lcm_summary",
  "session_title",
  "curated_memory_review"
];
const temporaryHomes: string[] = [];

const profile = (state: "healthy" | "not_configured" = "healthy") => ({
  state,
  message: `${state} profile`
});

const snapshot = (
  provider: Provider,
  overrides: Record<string, unknown> = {}
): CapabilityReadModel["capabilitySnapshots"][number] => ({
  instanceId: `${provider}.default`,
  clientVersion: "test",
  authenticationState: "authenticated",
  healthState: "healthy",
  models: [
    {
      fullId: `${provider}/model`,
      supportedReasoningEfforts: ["high"]
    }
  ],
  capabilities: {
    descriptors: {
      local_synthesis: {
        id: "local_synthesis",
        support: "supported",
        readiness: "ready",
        diagnostics: []
      }
    }
  },
  observedAt: now,
  expiresAt: "2026-01-01T00:10:00.000Z",
  stale: false,
  ...overrides
});

const readModel = (
  providers: Provider[],
  overrides: Record<string, unknown> = {}
): CapabilityReadModel => ({
  instances: providers.map((provider) => ({
    instanceId: `${provider}.default`,
    driverId: provider,
    displayName: provider,
    enabled: true
  })),
  capabilitySnapshots: providers.map((provider) =>
    snapshot(provider, overrides)
  )
});

const readinessInput = (
  providers: Provider[],
  capabilityReadModel?: ReadinessInput["capabilityReadModel"]
): ReadinessInput => ({
  codex: {
    ...profile(providers.includes("codex") ? "healthy" : "not_configured"),
    configured: providers.includes("codex")
  },
  claudeCode: {
    ...profile(providers.includes("claude") ? "healthy" : "not_configured"),
    configured: providers.includes("claude"),
    detected: providers.includes("claude")
  },
  pi: {
    ...profile(providers.includes("pi") ? "healthy" : "not_configured"),
    configured: providers.includes("pi"),
    detected: providers.includes("pi")
  },
  codexTranscriptWatcher: profile(
    providers.includes("codex") ? "healthy" : "not_configured"
  ),
  claudeTranscriptWatcher: profile(
    providers.includes("claude") ? "healthy" : "not_configured"
  ),
  mcpServer: healthy(),
  localAiRuntime: healthy(),
  capabilityReadModel,
  now
});

const setting = (
  provider: Provider,
  flowKey: Flow
): LocalMemoryAgentSettingRecord => ({
  ownerUserId: "user",
  flowKey,
  provider,
  aiClientInstanceId: `${provider}.work`,
  model: `${provider}/model`,
  reasoningEffort: "high",
  timeoutMs: 10_000,
  maxAttempts: 1,
  createdAt: now,
  updatedAt: now
});

const assignmentClient = (
  settings: ReturnType<typeof setting>[],
  providers: Provider[],
  overrides: Record<string, unknown> = {},
  providerOverrides: Partial<Record<Provider, Record<string, unknown>>> = {}
): Pick<
  MemoryApiClient,
  "listLocalMemoryAgentSettings" | "listAiClientInstances"
> => ({
  listLocalMemoryAgentSettings: vi.fn(async () => ({ settings })),
  listAiClientInstances: vi.fn(
    async (): Promise<
      Awaited<ReturnType<MemoryApiClient["listAiClientInstances"]>>
    > => ({
      instances: providers.map((provider) => ({
        instanceId: `${provider}.work`,
        driverId: provider,
        enabled: true,
        configIdentityHash: identityHash
      })),
      capabilitySnapshots: providers.map((provider) => ({
        ...snapshot(provider, {
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ...overrides,
          ...providerOverrides[provider]
        }),
        instanceId: `${provider}.work`,
        installationIdentityHash:
          typeof overrides.installationIdentityHash === "string"
            ? overrides.installationIdentityHash
            : identityHash,
        stale: overrides.stale === true,
        models: Array.isArray(providerOverrides[provider]?.models)
          ? (providerOverrides[provider].models as Array<
              Record<string, unknown>
            >)
          : [
              {
                fullId: `${provider}/model`,
                supportedReasoningEfforts: ["high"]
              }
            ]
      }))
    })
  )
});

describe("AI Client independent readiness acceptance matrix", () => {
  afterEach(() => {
    for (const home of temporaryHomes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  const readinessCases: Array<[string, Provider[], Provider[]]> = [
    ["zero clients", [], []],
    ["Codex-only", ["codex"], ["codex"]],
    ["Claude-only", ["claude"], ["claude"]],
    ["Pi-only", ["pi"], ["pi"]],
    ["healthy multi-client", allProviders, allProviders]
  ];

  it.each(readinessCases)(
    "keeps core and client states independent for %s",
    (_name, providers, current) => {
      const clients = inspectAiClientReadiness(
        readinessInput(providers, readModel(current))
      );
      const core = aggregateState([
        healthy(),
        healthy(),
        healthy(),
        healthy(),
        healthy(),
        healthy()
      ]);

      expect(core).toBe("healthy");
      for (const provider of allProviders) {
        expect(clients[provider]!.snapshotState).toBe(
          providers.includes(provider) ? "current" : "unknown"
        );
        expect(
          clients[provider]!.capabilities.find(
            (capability) => capability.id === "local_synthesis"
          )?.readiness
        ).toBe(providers.includes(provider) ? "ready" : "unknown");
      }
    }
  );

  it("isolates broken selected client from healthy alternate", () => {
    const capabilityReadModel = readModel(allProviders);
    Object.assign(capabilityReadModel.capabilitySnapshots[0]!, {
      healthState: "unavailable"
    });
    const clients = inspectAiClientReadiness(
      readinessInput(allProviders, capabilityReadModel)
    );
    expect(
      clients.codex!.capabilities.find(
        (capability) => capability.id === "local_synthesis"
      )
    ).toMatchObject({ readiness: "unavailable" });
    expect(
      clients.claude!.capabilities.find(
        (capability) => capability.id === "local_synthesis"
      )
    ).toMatchObject({ readiness: "ready" });
  });

  it("marks stale snapshots non-runnable while preserving healthy profile diagnostics", () => {
    const clients = inspectAiClientReadiness(
      readinessInput(["codex", "claude"], {
        instances: [
          {
            instanceId: "codex.default",
            driverId: "codex",
            displayName: "Codex"
          },
          {
            instanceId: "claude.default",
            driverId: "claude",
            displayName: "Claude"
          }
        ],
        capabilitySnapshots: [
          snapshot("codex", { stale: true }),
          snapshot("claude")
        ]
      })
    );
    expect(clients.codex!.snapshotState).toBe("stale");
    expect(
      clients.codex!.capabilities.find(
        (capability) => capability.id === "local_synthesis"
      )
    ).toMatchObject({ readiness: "stale" });
    expect(clients.claude!.snapshotState).toBe("current");
    expect(
      clients.claude!.capabilities.find(
        (capability) => capability.id === "local_synthesis"
      )
    ).toMatchObject({ readiness: "ready" });
  });

  it("assigns every flow to its selected provider and instance", async () => {
    const providers: Provider[] = ["codex", "claude", "pi"];
    const assignments = allFlows.map((flowKey, index) =>
      setting(providers[index % providers.length]!, flowKey)
    );
    const client = assignmentClient(assignments, providers);
    const fallback = vi.fn(() => "environment-default");

    for (const assignment of assignments) {
      await expect(
        resolveLocalMemoryAgentConfig({
          client,
          flowKey: assignment.flowKey,
          fallback,
          fromSetting: (selected) => selected.aiClientInstanceId
        })
      ).resolves.toBe(assignment.aiClientInstanceId);
    }
    expect(fallback).not.toHaveBeenCalled();
  });

  it("rejects unavailable explicit assignment without cross-client fallback", async () => {
    const client = assignmentClient(
      [setting("codex", "mcp_memory_answer")],
      ["codex", "claude"],
      {},
      {
        codex: {
          healthState: "unavailable",
          authenticationState: "unauthenticated"
        }
      }
    );
    const fallback = vi.fn(() => "environment-default");
    const fromSetting = vi.fn(() => "assigned");

    await expect(
      resolveLocalMemoryAgentConfig({
        client,
        flowKey: "mcp_memory_answer",
        fallback,
        fromSetting
      })
    ).rejects.toThrow(/not healthy|stale|unavailable/i);
    expect(fallback).not.toHaveBeenCalled();
    expect(fromSetting).not.toHaveBeenCalled();
  });

  it("rejects a missing selected model without using a healthy alternate client", async () => {
    const client = assignmentClient(
      [setting("codex", "mcp_memory_answer")],
      ["codex", "claude"],
      {},
      {
        codex: {
          models: [
            {
              fullId: "codex/other-model",
              supportedReasoningEfforts: ["high"]
            }
          ]
        }
      }
    );
    const fallback = vi.fn(() => "environment-default");
    const fromSetting = vi.fn(() => "assigned");

    await expect(
      resolveLocalMemoryAgentConfig({
        client,
        flowKey: "mcp_memory_answer",
        fallback,
        fromSetting
      })
    ).rejects.toThrow(/model.*not reported/i);
    expect(fallback).not.toHaveBeenCalled();
    expect(fromSetting).not.toHaveBeenCalled();
  });

  it.each([
    ["stale flag", { stale: true }],
    ["expired timestamp", { expiresAt: "2025-12-31T23:59:59.000Z" }],
    ["identity mismatch", { installationIdentityHash: "a".repeat(64) }]
  ] as const)(
    "rejects %s assigned snapshot without fallback",
    async (_name, overrides) => {
      const client = assignmentClient(
        [setting("codex", "mcp_memory_answer")],
        ["codex", "claude"],
        overrides
      );
      const fallback = vi.fn(() => "environment-default");
      await expect(
        resolveLocalMemoryAgentConfig({
          client,
          flowKey: "mcp_memory_answer",
          fallback,
          fromSetting: () => "assigned"
        })
      ).rejects.toThrow(/stale or unavailable/i);
      expect(fallback).not.toHaveBeenCalled();
    }
  );

  it("keeps Managed Conversation execution on the exact persisted owner", () => {
    const registry = new ManagedConversationRuntimeRegistry();
    const codexSession = { closeAndWait: vi.fn(async () => undefined) };
    assertManagedConversationExecutionOwner({
      provider: "codex",
      aiClientInstanceId: "codex.work"
    });
    registry.set("codex", "execution-1", {
      executionGeneration: 1,
      aiClientInstanceId: "codex.work",
      configIdentityHash: identityHash,
      session: codexSession as never
    });

    expect(
      registry.get("codex", "execution-1", {
        aiClientInstanceId: "codex.work",
        configIdentityHash: identityHash
      })?.session
    ).toBe(codexSession);
    expect(registry.get("claude", "execution-1")).toBeUndefined();
    expect(() =>
      assertManagedConversationExecutionOwner({
        provider: "pi",
        aiClientInstanceId: "pi.default"
      })
    ).toThrow("ManagedConversationUnsupportedAiClientError");
  });

  it("migrates existing Codex-only ownership without selecting another client", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-ai-client-matrix-")
    );
    temporaryHomes.push(home);
    const codexHome = path.join(home, "codex");
    const registryPath = path.join(home, "config", "ai-client-instances.json");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      "# >>> koed\n# <<< koed\n"
    );

    expect(
      migrateKoedOwnedCodexRegistration({
        environment: {
          KOED_HOME: home,
          CODEX_HOME: codexHome,
          MEMORY_CODEX_APP_SERVER_BINARY: "/bin/sh",
          PATH: "/bin"
        }
      })
    ).toBe(true);
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      instances: Array<{ instanceId: string; driverId: string }>;
    };
    expect(registry.instances).toEqual([
      {
        instanceId: "codex.default",
        driverId: "codex",
        displayName: "Codex",
        executablePath: "/bin/sh",
        configHome: codexHome
      }
    ]);
    expect(
      registry.instances.every((entry) => entry.driverId === "codex")
    ).toBe(true);
  });
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type PathLike
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateState,
  collectKoedServerDoctor,
  collectKoedServerStartupStatus,
  collectKoedServerStatus,
  healthy,
  inspectAiClientFlowReadiness,
  inspectAiClientInstanceReadiness,
  inspectAiClientReadiness,
  inspectClaudeCode,
  inspectPi,
  needsAttention,
  notConfigured,
  statusFromApiReady
} from "./status.js";
import { resolveKoedServerPaths } from "./paths.js";
const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-server-status-"));
  temps.push(path);
  return path;
};

const response = (ok: boolean, status: number, body: unknown): Response =>
  ({
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body
  }) as Response;

const spawnResult = (stdout: string, status = 0) =>
  ({ stdout, stderr: "", status, signal: null, pid: 1, output: [] }) as never;

const codexIntegrationConfig = (
  repoRoot: string,
  koedHome = repoRoot,
  codexHome = resolve(repoRoot, ".codex")
) => {
  const guidance = "# Koed Memory\n\nConsult Koed before substantive work.";
  mkdirSync(resolve(repoRoot, "packages/mcp-server/dist/prompts"), {
    recursive: true
  });
  writeFileSync(
    resolve(
      repoRoot,
      "packages/mcp-server/dist/prompts/codex-global-agent-guidance.md"
    ),
    `${guidance}\n`
  );
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    resolve(codexHome, "AGENTS.md"),
    `<!-- >>> koed-memory-guidance -->\n${guidance}\n<!-- <<< koed-memory-guidance -->\n`
  );
  return `# >>> koed
[mcp_servers.koed]
command = "node"
args = ["${resolve(repoRoot, "packages/mcp-server/dist/cli.js")}"]

[mcp_servers.koed.env]
KOED_HOME = "${koedHome}"

${[
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SubagentStart",
  "SubagentStop"
]
  .map(
    (eventName) => `[[hooks.${eventName}]]
[[hooks.${eventName}.hooks]]
type = "command"
command = "node /opt/koed/capture-hook.js"
timeout = 10`
  )
  .join("\n\n")}
# <<< koed
`;
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("startup status", () => {
  it("uses individual readiness checks and live process health without deep diagnostics", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({
        pid: 42,
        startedAt: "2026-01-01T00:00:00.000Z",
        repoRoot: root,
        apiUrl: "http://127.0.0.1:43300",
        runtimeMode: "developer",
        dependencyMode: "bundled-local",
        automaticPorts: true,
        services: ["api", "worker", "local-ai-runtime"],
        processes: { api: 45, worker: 43, localAiRuntime: 44 }
      })
    );
    const fetchedUrls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.endsWith("/ready")) {
        return response(false, 503, {
          status: "error",
          checks: [
            { service: "api", status: "ok" },
            { service: "postgres", status: "ok" },
            { service: "postgres-version", status: "ok" },
            { service: "migrations", status: "ok" },
            { service: "pgvector", status: "ok" },
            { service: "work-queue", status: "ok" },
            { service: "embedding-service", status: "degraded" },
            { service: "embedding-model", status: "degraded" }
          ]
        });
      }
      if (url.endsWith("/health")) {
        return response(true, 200, { status: "ok" });
      }
      return response(true, 200, {});
    });

    const status = await collectKoedServerStartupStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_AUTO_PORTS: "1",
        KOED_DEPENDENCY_MODE: "bundled-local",
        KOED_RUNTIME_MODE: "developer",
        KOED_TEAM_COLLABORATION_ENABLED: "true",
        WORK_QUEUE_BACKEND: "local",
        MEMORY_API_TOKEN: "test-token",
        PRIVACY_RUNTIME_CONTROL_TOKEN: "privacy-control-token"
      },
      {
        existsSync: () => true,
        fetch: fetcher,
        checkPid: (pid) => [42, 43, 44].includes(pid),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status).toMatchObject({
      ok: false,
      state: "needs_attention",
      generatedAt: "2026-01-01T00:00:00.000Z",
      api: { state: "healthy", url: "http://127.0.0.1:43300" },
      database: { state: "healthy" },
      redis: { state: "healthy" },
      workerQueues: { state: "healthy" },
      embeddingService: { state: "needs_attention" },
      privacyService: { state: "healthy" },
      localAiRuntime: { state: "healthy" },
      apiToken: { state: "healthy", configured: true }
    });
    expect(fetchedUrls).toContain("http://127.0.0.1:43300/ready");
    expect(fetchedUrls.some((url) => url.endsWith(":8092/health"))).toBe(true);
    expect(fetchedUrls.every((url) => !url.includes("models/status"))).toBe(
      true
    );
  });

  it("does not trust health responses when Desktop runtime ownership is stale", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({
        pid: 42,
        startedAt: "2026-01-01T00:00:00.000Z",
        repoRoot: root,
        apiUrl: "http://127.0.0.1:43300",
        runtimeMode: "local-personal",
        dependencyMode: "bundled-local",
        automaticPorts: true,
        services: ["api"],
        processes: { api: 43 }
      })
    );
    const fetcher = vi.fn<typeof fetch>(async () =>
      response(true, 200, {
        checks: [{ service: "api", status: "ok" }]
      })
    );

    const status = await collectKoedServerStartupStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_AUTO_PORTS: "1",
        KOED_DEPENDENCY_MODE: "bundled-local"
      },
      {
        fetch: fetcher,
        checkPid: () => false,
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.api.state).toBe("needs_attention");
    expect(status.localAiRuntime.state).toBe("needs_attention");
    expect(
      fetcher.mock.calls.some(([url]) => String(url).endsWith("/ready"))
    ).toBe(false);
  });
});

describe("status state aggregation", () => {
  it("reports client-neutral capability readiness without treating core as client setup", () => {
    const component = (
      state: "healthy" | "needs_attention" | "not_configured"
    ) => ({
      state,
      message: `${state} check`
    });
    const clients = inspectAiClientReadiness({
      codex: { ...component("healthy"), configured: true },
      claudeCode: {
        ...component("needs_attention"),
        configured: false,
        detected: true
      },
      pi: {
        ...component("healthy"),
        configured: true,
        detected: true,
        details: { version: "0.84.2", authenticated: true }
      },
      codexTranscriptWatcher: component("healthy"),
      claudeTranscriptWatcher: component("healthy"),
      mcpServer: component("healthy"),
      localAiRuntime: component("healthy"),
      now: "2026-01-01T00:00:00.000Z"
    });

    expect(clients.codex!.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "automatic_capture",
          readiness: "ready"
        }),
        expect.objectContaining({ id: "mcp_recall", readiness: "ready" })
      ])
    );
    expect(clients.claude!.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "automatic_capture",
          readiness: "not_ready"
        })
      ])
    );
    expect(clients.pi!.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "managed_conversation_start",
          support: "unsupported"
        })
      ])
    );
    expect(clients.claude!.profile.state).toBe("needs_attention");
    expect(clients.codex!.profile.state).toBe("healthy");
  });
  it("reports independent flow assignment readiness from defaults and settings", () => {
    const readModel = {
      instances: [
        {
          instanceId: "codex.default",
          driverId: "codex" as const,
          displayName: "Codex",
          configIdentityHash: "hash"
        }
      ],
      settings: [
        {
          flowKey: "lcm_summary" as const,
          provider: "codex" as const,
          aiClientInstanceId: "codex.default",
          model: "missing/model",
          reasoningEffort: "low",
          timeoutMs: 120_000,
          maxAttempts: 2
        }
      ],
      defaults: {},
      capabilitySnapshots: [
        {
          instanceId: "codex.default",
          installationIdentityHash: "hash",
          clientVersion: "1.0.0",
          authenticationState: "authenticated" as const,
          healthState: "healthy" as const,
          models: [{ id: "gpt-5.6-luna", supportedReasoningEfforts: ["low"] }],
          capabilities: {
            descriptors: {
              local_synthesis: {
                id: "local_synthesis",
                support: "supported" as const,
                readiness: "ready" as const,
                diagnostics: []
              }
            }
          },
          observedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T00:10:00.000Z"
        }
      ]
    };
    const readiness = inspectAiClientFlowReadiness({
      environment: {},
      capabilityReadModel: readModel,
      now: "2026-01-01T00:01:00.000Z"
    });
    expect(readiness.lcm_summary.state).toBe("needs_attention");
    expect(readiness.mcp_memory_answer.state).toBe("healthy");
    expect(readiness.session_title.state).toBe("healthy");
    expect(readiness.curated_memory_review.state).toBe("healthy");
  });

  it("reports explicit unavailable defaults as nonblocking attention", () => {
    const readiness = inspectAiClientFlowReadiness({
      environment: { MEMORY_ANSWER_PROVIDER: "pi" },
      capabilityReadModel: {
        instances: [],
        capabilitySnapshots: [],
        defaults: {
          mcp_memory_answer: {
            source: "code",
            available: false,
            assignment: null,
            reason: "Operator selected no default."
          }
        }
      },
      now: "2026-01-01T00:00:00.000Z"
    });
    expect(readiness.mcp_memory_answer).toMatchObject({
      state: "needs_attention",
      source: "unavailable",
      assignment: null
    });
  });

  it("reports every AI Client instance without removing provider readiness", () => {
    const baseInput: Parameters<typeof inspectAiClientReadiness>[0] = {
      codex: { ...healthy(), configured: true },
      claudeCode: {
        ...notConfigured("Claude Code is not configured."),
        configured: false,
        detected: false
      },
      pi: {
        ...notConfigured("Pi is not configured."),
        configured: false,
        detected: false
      },
      codexTranscriptWatcher: healthy(),
      claudeTranscriptWatcher: notConfigured(
        "Claude Transcript Watcher is not configured."
      ),
      mcpServer: healthy(),
      localAiRuntime: healthy(),
      capabilityReadModel: {
        instances: [
          {
            instanceId: "codex.default",
            driverId: "codex",
            displayName: "Codex"
          },
          {
            instanceId: "codex.work",
            driverId: "codex",
            displayName: "Codex Work"
          }
        ],
        capabilitySnapshots: ["codex.default", "codex.work"].map(
          (instanceId) => ({
            instanceId,
            clientVersion: "1.0.0",
            authenticationState: "authenticated" as const,
            healthState: "healthy" as const,
            models: [{ id: "model", supportedReasoningEfforts: ["high"] }],
            capabilities: {
              descriptors: {
                local_synthesis: {
                  id: "local_synthesis",
                  support: "supported" as const,
                  readiness: "ready" as const,
                  diagnostics: []
                }
              }
            },
            observedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T00:10:00.000Z"
          })
        )
      },
      now: "2026-01-01T00:00:00.000Z"
    };
    const aiClients = inspectAiClientReadiness(baseInput);
    const aiClientInstances = inspectAiClientInstanceReadiness(baseInput);

    expect(aiClients.codex?.instanceId).toBe("codex.default");
    expect(Object.keys(aiClientInstances)).toEqual([
      "codex.default",
      "codex.work"
    ]);
    expect(aiClientInstances["codex.default"]?.instanceId).toBe(
      "codex.default"
    );
    expect(aiClientInstances["codex.work"]).toMatchObject({
      instanceId: "codex.work",
      displayName: "Codex Work"
    });
  });

  it("isolates a broken client inspector from other clients and core status", async () => {
    const root = tempDir();
    const configPath = resolve(root, "config.toml");
    writeFileSync(configPath, "# malformed");
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        CODEX_HOME: root,
        CODEX_CONFIG_PATH: configPath,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () => response(true, 200, { checks: [] }),
        readFileSync: ((path: PathLike) => {
          if (String(path) === configPath)
            throw new Error("broken Codex config");
          return readFileSync(path, "utf8");
        }) as typeof readFileSync,
        spawnSync: () => spawnResult(""),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );
    expect(status.codex.state).toBe("needs_attention");
    expect(status.aiClients.claude).toBeDefined();
    expect(status.aiClients.pi).toBeDefined();
    expect(status.core.state).toBeDefined();
  });

  it.each([
    ["codex", "Codex"],
    ["claude", "Claude Code"],
    ["pi", "Pi"]
  ] as const)(
    "uses %s capability snapshot for readiness",
    (driverId, displayName) => {
      const descriptor = (
        id: string,
        support: "supported" | "unsupported" = "supported"
      ) => ({
        id,
        support,
        readiness: support === "unsupported" ? "unknown" : "ready",
        diagnostics: []
      });
      const clients = inspectAiClientReadiness({
        codex: { ...healthy(), configured: true },
        claudeCode: { ...healthy(), configured: true, detected: true },
        pi: { ...healthy(), configured: true, detected: true },
        codexTranscriptWatcher: healthy(),
        claudeTranscriptWatcher: healthy(),
        mcpServer: healthy(),
        localAiRuntime: needsAttention("runtime unavailable"),
        capabilityReadModel: {
          instances: [
            { instanceId: `${driverId}.default`, driverId, displayName }
          ],
          capabilitySnapshots: [
            {
              instanceId: `${driverId}.default`,
              clientVersion: "1.2.3",
              authenticationState: "authenticated",
              healthState: "healthy",
              models: [{ id: "model" }],
              capabilities: {
                descriptors: {
                  automatic_capture: descriptor("automatic_capture"),
                  mcp_recall: descriptor("mcp_recall"),
                  local_synthesis: descriptor("local_synthesis"),
                  managed_conversation_start: descriptor(
                    "managed_conversation_start",
                    driverId === "pi" ? "unsupported" : "supported"
                  )
                }
              },
              observedAt: "2026-01-01T00:00:00.000Z",
              expiresAt: "2026-01-02T00:00:00.000Z"
            }
          ]
        },
        now: "2026-01-01T00:00:00.000Z"
      });
      const readiness = clients[driverId];
      expect(readiness!.snapshotState).toBe("current");
      expect(readiness!.version).toBe("1.2.3");
      expect(readiness!.capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "local_synthesis",
            readiness: "ready"
          }),
          expect.objectContaining({
            id: "managed_conversation_start",
            support: driverId === "pi" ? "unsupported" : "supported",
            readiness: driverId === "pi" ? "unknown" : "ready"
          })
        ])
      );
    }
  );

  it("overlays current profile readiness only for unknown capture and recall descriptors", () => {
    const unknown = (id: string) => ({
      id,
      support: "supported" as const,
      readiness: "unknown" as const,
      diagnostics: []
    });
    const clients = inspectAiClientReadiness({
      codex: { ...healthy(), configured: true },
      claudeCode: { ...healthy(), configured: true, detected: true },
      pi: { ...healthy(), configured: true, detected: true },
      codexTranscriptWatcher: healthy(),
      claudeTranscriptWatcher: healthy(),
      mcpServer: healthy(),
      localAiRuntime: healthy(),
      capabilityReadModel: {
        instances: [
          {
            instanceId: "codex.default",
            driverId: "codex",
            displayName: "Codex"
          }
        ],
        capabilitySnapshots: [
          {
            instanceId: "codex.default",
            clientVersion: "1.2.3",
            authenticationState: "authenticated",
            healthState: "healthy",
            models: [{ id: "model" }],
            capabilities: {
              descriptors: {
                automatic_capture: unknown("automatic_capture"),
                mcp_recall: unknown("mcp_recall"),
                local_synthesis: unknown("local_synthesis"),
                managed_conversation_start: unknown(
                  "managed_conversation_start"
                )
              }
            },
            observedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-02T00:00:00.000Z"
          }
        ]
      },
      now: "2026-01-01T00:00:00.000Z"
    });

    expect(clients.codex!.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "automatic_capture",
          readiness: "ready"
        }),
        expect.objectContaining({ id: "mcp_recall", readiness: "ready" }),
        expect.objectContaining({
          id: "local_synthesis",
          readiness: "unknown"
        }),
        expect.objectContaining({
          id: "managed_conversation_start",
          readiness: "unknown"
        })
      ])
    );
  });

  it("keeps stale snapshots non-runnable and does not use runtime for synthesis", () => {
    const descriptor = (id: string) => ({
      id,
      support: "supported" as const,
      readiness: "ready" as const,
      diagnostics: []
    });
    const clients = inspectAiClientReadiness({
      codex: { ...healthy(), configured: true },
      claudeCode: { ...healthy(), configured: true, detected: true },
      pi: { ...healthy(), configured: true, detected: true },
      codexTranscriptWatcher: healthy(),
      claudeTranscriptWatcher: healthy(),
      mcpServer: healthy(),
      localAiRuntime: healthy(),
      capabilityReadModel: {
        instances: [
          {
            instanceId: "codex.default",
            driverId: "codex",
            displayName: "Codex"
          }
        ],
        capabilitySnapshots: [
          {
            instanceId: "codex.default",
            clientVersion: "1.2.3",
            authenticationState: "authenticated",
            healthState: "healthy",
            models: [{ id: "model" }],
            capabilities: {
              descriptors: {
                automatic_capture: descriptor("automatic_capture"),
                mcp_recall: descriptor("mcp_recall"),
                local_synthesis: descriptor("local_synthesis"),
                managed_conversation_start: descriptor(
                  "managed_conversation_start"
                )
              }
            },
            observedAt: "2025-12-01T00:00:00.000Z",
            expiresAt: "2025-12-02T00:00:00.000Z"
          }
        ]
      },
      now: "2026-01-01T00:00:00.000Z"
    });
    expect(clients.codex!.snapshotState).toBe("stale");
    expect(clients.codex!.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "automatic_capture",
          readiness: "stale"
        }),
        expect.objectContaining({ id: "mcp_recall", readiness: "stale" }),
        expect.objectContaining({ id: "local_synthesis", readiness: "stale" }),
        expect.objectContaining({
          id: "managed_conversation_start",
          readiness: "stale"
        })
      ])
    );
  });

  it("isolates broken client snapshot from healthy client snapshot", () => {
    const snapshot = (
      driverId: "codex" | "claude",
      healthState: "healthy" | "unavailable"
    ) => ({
      instanceId: `${driverId}.default`,
      clientVersion: healthState === "healthy" ? "1.2.3" : null,
      authenticationState:
        healthState === "healthy"
          ? ("authenticated" as const)
          : ("unknown" as const),
      healthState,
      models: healthState === "healthy" ? [{ id: "model" }] : [],
      capabilities: {
        descriptors: Object.fromEntries(
          [
            "automatic_capture",
            "mcp_recall",
            "local_synthesis",
            "managed_conversation_start"
          ].map((id) => [
            id,
            {
              id,
              support: "supported",
              readiness: healthState === "healthy" ? "ready" : "unavailable",
              diagnostics: []
            }
          ])
        )
      },
      observedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z"
    });
    const clients = inspectAiClientReadiness({
      codex: { ...healthy(), configured: true },
      claudeCode: { ...healthy(), configured: true, detected: true },
      pi: { ...healthy(), configured: true, detected: true },
      codexTranscriptWatcher: healthy(),
      claudeTranscriptWatcher: healthy(),
      mcpServer: healthy(),
      localAiRuntime: healthy(),
      capabilityReadModel: {
        instances: [
          {
            instanceId: "codex.default",
            driverId: "codex",
            displayName: "Codex"
          },
          {
            instanceId: "claude.default",
            driverId: "claude",
            displayName: "Claude Code"
          }
        ],
        capabilitySnapshots: [
          snapshot("codex", "unavailable"),
          snapshot("claude", "healthy")
        ]
      },
      now: "2026-01-01T00:00:00.000Z"
    });
    expect(clients.codex!.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "local_synthesis",
          readiness: "unknown"
        })
      ])
    );
    expect(clients.claude!.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "local_synthesis", readiness: "ready" })
      ])
    );
  });

  it("isolates capability API failure from core status", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        MEMORY_API_TOKEN: "local-token",
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async (url) => {
          if (String(url).endsWith("/v1/access/check"))
            return response(true, 200, {});
          if (String(url).endsWith("/v1/memory/local-agent-settings")) {
            throw new Error("capability API unavailable");
          }
          return response(true, 200, { checks: [] });
        },
        spawnSync: () => spawnResult(""),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );
    expect(status.core.state).toBeDefined();
    expect(status.aiClients.codex!.snapshotState).toBe("unknown");
    expect(
      status.aiClients.codex!.capabilities.find(
        (capability) => capability.id === "local_synthesis"
      )
    ).toMatchObject({ readiness: "unknown" });
    expect(JSON.stringify(status)).not.toContain("local-token");
  });

  it("loads persisted User flow assignments into status readiness", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_RUNTIME_MODE: "external",
        KOED_DEPENDENCY_MODE: "external",
        MEMORY_API_TOKEN: "local-token",
        MEMORY_ANSWER_PROVIDER: "claude"
      },
      {
        fetch: async (url) => {
          const pathname = new URL(String(url)).pathname;
          if (pathname === "/v1/access/check") return response(true, 200, {});
          if (pathname === "/v1/memory/local-agent-settings") {
            return response(true, 200, {
              instances: [
                {
                  instanceId: "codex.default",
                  driverId: "codex",
                  displayName: "Codex",
                  enabled: true,
                  configIdentityHash: "identity"
                }
              ],
              settings: [
                {
                  flowKey: "mcp_memory_answer",
                  provider: "codex",
                  aiClientInstanceId: "codex.default",
                  model: "openai/gpt-test",
                  reasoningEffort: "high",
                  timeoutMs: 30_000,
                  maxAttempts: 1
                }
              ],
              defaults: {},
              capabilitySnapshots: [
                {
                  instanceId: "codex.default",
                  installationIdentityHash: "identity",
                  clientVersion: "1.0.0",
                  authenticationState: "authenticated",
                  healthState: "healthy",
                  models: [
                    {
                      fullId: "openai/gpt-test",
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
                  observedAt: "2026-01-01T00:00:00.000Z",
                  expiresAt: "2026-01-01T00:10:00.000Z",
                  stale: false
                }
              ]
            });
          }
          return response(true, 200, { checks: [] });
        },
        spawnSync: () => spawnResult(""),
        now: () => new Date("2026-01-01T00:01:00.000Z")
      }
    );

    expect(status.aiClientFlowReadiness.mcp_memory_answer).toMatchObject({
      state: "healthy",
      source: "setting",
      assignment: {
        provider: "codex",
        model: "openai/gpt-test"
      }
    });
  });

  it.each([
    [200, "healthy", "Local API Token authenticated successfully."],
    [401, "needs_attention", "Run koed-server setup core --json"],
    [403, "needs_attention", "Run koed-server setup core --json"],
    [503, "needs_attention", "Check Koed API health and rerun diagnostics."]
  ])(
    "maps API Token HTTP %s to safe status action",
    async (httpStatus, state, action) => {
      const root = tempDir();
      const status = await collectKoedServerStatus(
        {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          KOED_DEPENDENCY_MODE: "external",
          MEMORY_API_TOKEN: "local-token"
        },
        {
          fetch: async (url) =>
            String(url).endsWith("/v1/access/check")
              ? response(httpStatus === 200, httpStatus, {})
              : response(true, 200, { checks: [] }),
          spawnSync: () => spawnResult(""),
          now: () => new Date("2026-01-01T00:00:00.000Z")
        }
      );

      expect(status.apiToken.state).toBe(state);
      if (httpStatus === 200) {
        expect(status.apiToken.message).toContain(action);
      } else {
        expect(status.apiToken.action).toContain(action);
      }
    }
  );

  it("keeps token unchanged and reports network action when validation fails to connect", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "external",
        MEMORY_API_TOKEN: "local-token"
      },
      {
        fetch: async (url) => {
          if (String(url).endsWith("/v1/access/check")) {
            throw new Error("connection refused");
          }
          return response(true, 200, { checks: [] });
        },
        spawnSync: () => spawnResult(""),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.apiToken.state).toBe("needs_attention");
    expect(status.apiToken.action).toContain("Token was not rotated");
  });

  it("prioritizes needs_attention, then not_configured, then starting", () => {
    expect(aggregateState([healthy(), notConfigured("missing")])).toBe(
      "not_configured"
    );
    expect(aggregateState([healthy(), { state: "starting" }])).toBe("starting");
    expect(
      aggregateState([{ state: "starting" }, notConfigured("missing")])
    ).toBe("not_configured");
    expect(
      aggregateState([{ state: "starting" }, needsAttention("broken")])
    ).toBe("needs_attention");
  });
});

describe("Pi integration status", () => {
  it("reports a registered Koed package in the active Pi profile", () => {
    const root = tempDir();
    const packagePath = resolve(root, "integrations/pi");
    mkdirSync(resolve(packagePath, "extensions"), { recursive: true });
    writeFileSync(resolve(packagePath, "extensions/koed.mjs"), "export {};\n");
    const environment = { KOED_HOME: root, KOED_PI_EXECUTABLE: "/opt/pi" };

    const status = inspectPi(environment, resolveKoedServerPaths(environment), {
      existsSync: (path: PathLike) =>
        path === resolve(packagePath, "extensions/koed.mjs"),
      resolvePiExecutable: () => "/opt/pi",
      spawnSync: (_command: string, args: string[]) =>
        args[0] === "--version"
          ? spawnResult("0.84.2\n")
          : args[0] === "--list-models"
            ? spawnResult("provider model\nopenai gpt-5.4\n")
            : spawnResult(`${packagePath}\n`)
    } as never);

    expect(status).toMatchObject({
      state: "healthy",
      configured: true,
      detected: true
    });
    expect(status.details).toMatchObject({
      executable: "/opt/pi",
      packagePath,
      version: "0.84.2",
      authenticated: true,
      modelCount: 1
    });
  });

  it("separates registered-package health from authenticated-model health", () => {
    const root = tempDir();
    const packagePath = resolve(root, "integrations/pi");

    const status = inspectPi(
      { KOED_HOME: root },
      resolveKoedServerPaths({ KOED_HOME: root }),
      {
        existsSync: (path: PathLike) =>
          path === resolve(packagePath, "extensions/koed.mjs"),
        resolvePiExecutable: () => "/opt/pi",
        spawnSync: (_command: string, args: string[]) =>
          args[0] === "--version"
            ? spawnResult("0.84.2\n")
            : args[0] === "--list-models"
              ? spawnResult("provider model\n")
              : spawnResult(`${packagePath}\n`)
      } as never
    );

    expect(status).toMatchObject({
      state: "needs_attention",
      configured: true
    });
    expect(status.details).toMatchObject({
      packageRegistered: true,
      authenticated: false,
      modelCount: 0
    });
  });

  it("keeps missing Pi optional but actionable", () => {
    const root = tempDir();
    const environment = { KOED_HOME: root };

    const status = inspectPi(environment, resolveKoedServerPaths(environment), {
      existsSync: () => false,
      resolvePiExecutable: () => {
        throw new Error("Pi was not found.");
      }
    } as never);

    expect(status).toMatchObject({
      state: "not_configured",
      configured: false,
      detected: false
    });
    expect(status.action).toContain("Install Pi");
  });

  it("detects Pi from its global profile when the executable is unavailable", () => {
    const root = tempDir();
    const profilePath = resolve(root, ".pi/agent");
    mkdirSync(profilePath, { recursive: true });
    writeFileSync(resolve(profilePath, "settings.json"), "{}");
    const environment = { HOME: root, KOED_HOME: root };

    const status = inspectPi(environment, resolveKoedServerPaths(environment), {
      existsSync,
      resolvePiExecutable: () => {
        throw new Error("Pi was not found.");
      }
    } as never);

    expect(status).toMatchObject({
      state: "not_configured",
      configured: false,
      detected: true
    });
  });
});

describe("Claude Code integration status", () => {
  it("reports configured MCP, hooks, and authentication", () => {
    const root = tempDir();
    const settingsPath = resolve(root, ".claude/settings.json");
    const captureHook = resolve(
      root,
      "packages/mcp-server/dist/capture-hook.js"
    );
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    mkdirSync(resolve(root, ".claude"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(captureHook, "");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: Object.fromEntries(
          [
            "SessionStart",
            "UserPromptSubmit",
            "PostToolUse",
            "PostToolUseFailure",
            "Stop",
            "StopFailure",
            "SubagentStart",
            "SubagentStop",
            "SessionEnd"
          ].map((eventName) => [
            eventName,
            [{ hooks: [{ command: `node ${captureHook}` }] }]
          ])
        )
      })
    );
    const settingsContent = readFileSync(settingsPath, "utf8");
    const environment = {
      HOME: root,
      KOED_HOME: resolve(root, "koed"),
      KOED_REPO_ROOT: root,
      CLAUDE_SETTINGS_PATH: settingsPath
    };

    const status = inspectClaudeCode(
      environment,
      resolveKoedServerPaths(environment),
      {
        existsSync,
        readFileSync: () => settingsContent,
        spawnSync: (_command: string, args: string[]) =>
          args[0] === "--version"
            ? spawnResult("2.1.227 (Claude Code)\n")
            : args[0] === "mcp" && args[1] === "get"
              ? spawnResult(
                  `koed:\n  Type: stdio\n  Command: node\n  Args: ${resolve(root, "packages/mcp-server/dist/cli.js")}\n  Environment:\n    KOED_HOME=${resolve(root, "koed")}\n`
                )
              : spawnResult("")
      } as never
    );

    expect(status).toMatchObject({
      state: "healthy",
      configured: true,
      detected: true
    });
    expect(status.details).toMatchObject({
      version: "2.1.227 (Claude Code)",
      settingsPath
    });
  });

  it("keeps missing Claude Code optional but actionable", () => {
    const root = tempDir();
    const environment = { HOME: root, KOED_HOME: root, KOED_REPO_ROOT: root };

    const status = inspectClaudeCode(
      environment,
      resolveKoedServerPaths(environment),
      { existsSync: () => false, spawnSync: () => spawnResult("", 1) } as never
    );

    expect(status).toMatchObject({
      state: "not_configured",
      configured: false,
      detected: false
    });
    expect(status.action).toContain("Install Claude Code");
  });

  it("detects Claude Code from its global settings when the executable is unavailable", () => {
    const root = tempDir();
    const settingsPath = resolve(root, ".claude/settings.json");
    mkdirSync(resolve(root, ".claude"), { recursive: true });
    writeFileSync(settingsPath, "{}");
    const environment = { HOME: root, KOED_HOME: root, KOED_REPO_ROOT: root };

    const status = inspectClaudeCode(
      environment,
      resolveKoedServerPaths(environment),
      { existsSync, spawnSync: () => spawnResult("", 1) } as never
    );

    expect(status).toMatchObject({
      state: "not_configured",
      configured: false,
      detected: true
    });
  });
});

describe("process status/probe mapping", () => {
  it("maps ready payload checks to healthy components", async () => {
    const result = await statusFromApiReady("http://localhost:3300", async () =>
      response(true, 200, {
        checks: [
          { service: "postgres", status: "ok" },
          { service: "postgres-version", status: "ok" },
          { service: "migrations", status: "ok" },
          { service: "pgvector", status: "ok" },
          { service: "redis", status: "ok" },
          { service: "work-queue", status: "ok" },
          { service: "embedding-service", status: "ok" },
          { service: "embedding-model", status: "ok" }
        ]
      })
    );

    expect(result.api.state).toBe("healthy");
    expect(result.database.state).toBe("healthy");
    expect(result.redis.state).toBe("healthy");
    expect(result.embeddingService.state).toBe("healthy");
    expect(result.workerQueues.state).toBe("healthy");
  });

  it("maps 503 readiness details to component actions", async () => {
    const result = await statusFromApiReady("http://localhost:3300", async () =>
      response(false, 503, {
        checks: [
          { service: "postgres", status: "ok" },
          { service: "postgres-version", status: "ok" },
          { service: "migrations", status: "error" },
          { service: "pgvector", status: "ok" },
          { service: "work-queue", status: "ok" },
          { service: "embedding-service", status: "ok" },
          { service: "embedding-model", status: "ok" }
        ]
      })
    );

    expect(result.api.state).toBe("starting");
    expect(result.database.state).toBe("needs_attention");
    expect(result.database.action).toContain("migrations");
  });

  it("maps unhealthy dependency checks to needs_attention", async () => {
    const result = await statusFromApiReady("http://localhost:3300", async () =>
      response(true, 200, {
        checks: [{ service: "postgres", status: "error" }]
      })
    );

    expect(result.database.state).toBe("needs_attention");
    expect(result.redis.state).toBe("starting");
  });
});

describe("status and doctor JSON contracts", () => {
  it("maps missing config to not_configured", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        REDIS_URL: "redis://operator:6379"
      },
      {
        fetch: async () => response(true, 200, { checks: [] }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.koedHome).toBe(root);
    expect(status.runtimeMode).toBe("developer");
    expect(status.dependencyMode).toBe("external");
    expect(status.codex.configured).toBe(false);
    expect(status.captureHook.state).toBe("not_configured");
    expect(status.state).toBe("not_configured");
  });

  it("treats external local work queue as Redis-free", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () => response(true, 200, { checks: [] }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.redis.state).toBe("healthy");
    expect(status.redis.message).toBe(
      "Postgres-backed local queue does not require Redis."
    );
    expect(status.redis.details).toMatchObject({
      backend: "local",
      required: false
    });
    expect(status.workerQueues.state).toBe("starting");
  });

  it("reports registered upstreams without degrading local Personal Memory health", async () => {
    const root = tempDir();
    const dependencies = {
      fetch: async () => response(true, 200, { checks: [] }),
      spawnSync: () => spawnResult("", 0),
      now: () => new Date("2026-01-01T00:00:00.000Z")
    };
    const environment = {
      KOED_HOME: root,
      KOED_REPO_ROOT: root,
      HOME: root,
      WORK_QUEUE_BACKEND: "local"
    };
    const baseline = await collectKoedServerStatus(environment, dependencies);
    const baselineDoctor = await collectKoedServerDoctor(
      environment,
      dependencies
    );
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config", "upstream-backends.json"),
      JSON.stringify({
        schemaVersion: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
        activeBackendId: "team-vps",
        backends: [
          {
            id: "team-vps",
            displayName: "Team VPS",
            baseUrl: "https://team.example.test",
            profile: "private_vps",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            routePolicy: {
              personalMemoryRead: "disabled",
              teamWorkspaceRead: "disabled",
              shareGrantManagement: "disabled",
              captureWrites: "disabled",
              sync: "disabled",
              admin: "disabled"
            },
            credential: { status: "not_configured" },
            capabilities: {
              state: "validated",
              checkedAt: "2025-12-31T22:00:00.000Z",
              expiresAt: "2025-12-31T23:00:00.000Z",
              schemaVersion: 3,
              profile: "private_vps",
              releaseVersion: "1.0.0"
            }
          }
        ]
      })
    );

    const status = await collectKoedServerStatus(environment, dependencies);
    const doctor = await collectKoedServerDoctor(environment, dependencies);

    expect(status.upstreamBackends).toMatchObject({
      state: "needs_attention",
      registered: 1,
      notChecked: 0,
      failed: 0,
      stale: 1
    });
    expect(status.state).toBe(baseline.state);
    expect(doctor.ok).toBe(baselineDoctor.ok);
    expect(doctor.summary).toBe(baselineDoctor.summary);
    expect(
      doctor.checks.find((check) => check.id === "upstreamBackends")
    ).toMatchObject({ state: "needs_attention" });
    expect(JSON.stringify(status.upstreamBackends)).not.toContain("token");
  });

  it("reports malformed upstream registry config as needing attention", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(resolve(root, "config", "upstream-backends.json"), "{nope");

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () => response(true, 200, { checks: [] }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.upstreamBackends).toMatchObject({
      state: "needs_attention",
      registered: 0,
      message: "Upstream backend registry is malformed."
    });
    expect(status.upstreamBackends.details).toMatchObject({
      error: "Upstream backend registry is malformed."
    });
  });

  it("treats bundled-local mode from .env as Redis-free by default", async () => {
    const root = tempDir();
    writeFileSync(
      resolve(root, ".env"),
      "KOED_DEPENDENCY_MODE=bundled-local\nWORK_QUEUE_BACKEND=bullmq\n"
    );
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root
      },
      {
        fetch: async () =>
          response(true, 200, {
            checks: [
              { service: "postgres", status: "ok" },
              { service: "postgres-version", status: "ok" },
              { service: "migrations", status: "ok" },
              { service: "pgvector", status: "ok" },
              { service: "work-queue", status: "ok" },
              { service: "embedding-service", status: "ok" },
              { service: "embedding-model", status: "ok" }
            ]
          }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.dependencyMode).toBe("bundled-local");
    expect(status.redis.state).toBe("healthy");
    expect(status.redis.message).toBe(
      "Postgres-backed local queue does not require Redis."
    );
    expect(status.workerQueues.state).toBe("starting");
  });

  it("does not trust a foreign API before the Desktop-managed runtime starts", async () => {
    const root = tempDir();
    const fetcher = vi.fn<typeof fetch>(async () =>
      response(true, 200, {
        checks: [
          { service: "postgres", status: "ok" },
          { service: "work-queue", status: "ok" },
          { service: "embedding-service", status: "ok" }
        ]
      })
    );

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        KOED_AUTO_PORTS: "1",
        KOED_DEPENDENCY_MODE: "bundled-local"
      },
      {
        fetch: fetcher,
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.api).toMatchObject({
      state: "starting",
      message: "Waiting for Koed Desktop to start its managed API."
    });
    expect(
      fetcher.mock.calls.some(([url]) => String(url).endsWith("/ready"))
    ).toBe(false);
  });

  it("uses native Postgres status before API readiness", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        KOED_DEPENDENCY_MODE: "bundled-local",
        KOED_BUNDLED_POSTGRES_MODE: "native",
        KOED_POSTGRES_BIN_DIR: resolve(root, "bin")
      },
      {
        existsSync: (filePath) =>
          String(filePath).includes("/bin/") ||
          String(filePath).endsWith("PG_VERSION"),
        fetch: async () => response(false, 503, {}),
        spawnSync: (command, args) =>
          command.endsWith("pg_ctl") && args.includes("status")
            ? spawnResult("", 0)
            : spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.database.state).toBe("healthy");
    expect(status.database.message).toContain("native Postgres");
    expect(status.database.details?.dataDir).toBe(
      resolve(root, "data", "postgres")
    );
  });

  it("uses native Embedding Service status before API readiness", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        KOED_DEPENDENCY_MODE: "bundled-local",
        KOED_BUNDLED_EMBEDDING_MODE: "native"
      },
      {
        existsSync: (filePath) =>
          String(filePath).endsWith("dist/index.js") ||
          String(filePath).endsWith("llama-server"),
        fetch: async (url) =>
          String(url).endsWith(":3800/health")
            ? response(true, 200, { status: "ok" })
            : response(false, 503, {}),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.embeddingService.state).toBe("healthy");
    expect(status.embeddingService.message).toContain(
      "native Embedding Service"
    );
    expect(status.embeddingService.details?.healthUrl).toBe(
      "http://127.0.0.1:3800/health"
    );
  });

  it("honors bundled-local BullMQ override from environment", async () => {
    const root = tempDir();
    writeFileSync(
      resolve(root, ".env"),
      "KOED_DEPENDENCY_MODE=bundled-local\nREDIS_URL=redis://operator:6379\n"
    );
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "bullmq"
      },
      {
        fetch: async () =>
          response(true, 200, {
            checks: [
              { service: "postgres", status: "ok" },
              { service: "postgres-version", status: "ok" },
              { service: "migrations", status: "ok" },
              { service: "pgvector", status: "ok" },
              { service: "redis", status: "ok" },
              { service: "work-queue", status: "ok" },
              { service: "embedding-service", status: "ok" },
              { service: "embedding-model", status: "ok" }
            ]
          }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.dependencyMode).toBe("bundled-local");
    expect(status.redis.state).toBe("healthy");
    expect(status.redis.message).not.toBe(
      "Postgres-backed local queue does not require Redis."
    );
  });

  it("preserves Redis errors in local queue mode when API reports Redis", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () =>
          response(true, 200, {
            checks: [{ service: "redis", status: "error" }]
          }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.redis.state).toBe("needs_attention");
    expect(status.workerQueues.state).toBe("starting");
  });

  it("includes packaged artifact source diagnostics in status and doctor", async () => {
    const root = tempDir();
    const environment = {
      KOED_HOME: root,
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root,
      KOED_DEPENDENCY_MODE: "bundled-local",
      HOME: root,
      MEMORY_API_TOKEN: "token"
    };
    const dependencies = {
      existsSync: (filePath: PathLike) =>
        String(filePath).startsWith(resolve(root, "koed-runtime")) ||
        String(filePath).endsWith("PG_VERSION"),
      fetch: async (url: string | URL | Request) =>
        String(url).endsWith(":3800/health")
          ? response(true, 200, { status: "ok" })
          : response(false, 503, {}),
      spawnSync: () => spawnResult("", 0),
      now: () => new Date("2026-01-01T00:00:00.000Z")
    };

    const status = await collectKoedServerStatus(environment, dependencies);
    const doctor = await collectKoedServerDoctor(environment, dependencies);

    expect(status.database.details?.artifactSource).toBe("packaged-resource");
    expect(status.embeddingService.details?.artifactSource).toBe(
      "packaged-resource"
    );
    expect(status.mcpServer.details?.artifactSource).toBe("packaged-resource");
    expect(
      doctor.checks.find((check) => check.id === "database")?.details
        ?.artifactSource
    ).toBe("packaged-resource");
  });

  it("formats doctor result with actionable checks", async () => {
    const root = tempDir();
    const doctor = await collectKoedServerDoctor(
      { KOED_HOME: root, KOED_REPO_ROOT: root, HOME: root },
      {
        fetch: async () => response(false, 503, {}),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(doctor.ok).toBe(false);
    expect(doctor.state).toBe("needs_attention");
    expect(doctor.summary).toContain("Operator-managed Redis URL");
    expect(doctor.checks.map((check) => check.id)).toContain("mcpServer");
    expect(doctor.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "aiClientFlow:mcp_memory_answer",
        "aiClientFlow:lcm_summary",
        "aiClientFlow:session_title",
        "aiClientFlow:curated_memory_review"
      ])
    );
  });

  it("keeps API Tokens out of MCP doctor checks", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    const doctorEnvironments: Array<NodeJS.ProcessEnv | undefined> = [];

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        MEMORY_API_TOKEN: "env_token"
      },
      {
        fetch: async () => response(false, 503, {}),
        spawnSync: (_command, args, options) => {
          if (args.includes("doctor")) {
            doctorEnvironments.push(options?.env);
            return spawnResult("", 0);
          }
          return spawnResult("", 0);
        },
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.apiToken.state).toBe("needs_attention");
    expect(status.apiToken.configured).toBe(true);
    expect(status.apiToken.action).not.toContain("setup core");
    expect(status.mcpServer.state).toBe("healthy");
    expect(doctorEnvironments[0]?.MEMORY_API_TOKEN).toBeUndefined();
    expect(doctorEnvironments[0]?.MEMORY_API_URL).toBeUndefined();
    expect(doctorEnvironments[0]?.KOED_HOME).toBe(root);
  });

  it("reports a Codex KOED_HOME mismatch while signal hooks remain configured", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, ".codex"), { recursive: true });
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(
      resolve(root, ".codex/config.toml"),
      codexIntegrationConfig(root, resolve(root, "stale-koed-home"))
    );

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        API_HOST_PORT: "43300",
        MEMORY_API_TOKEN: "token",
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () =>
          response(true, 200, {
            checks: [
              { service: "postgres", status: "ok" },
              { service: "postgres-version", status: "ok" },
              { service: "migrations", status: "ok" },
              { service: "pgvector", status: "ok" },
              { service: "work-queue", status: "ok" },
              { service: "embedding-service", status: "ok" },
              { service: "embedding-model", status: "ok" }
            ]
          }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.codex.state).toBe("needs_attention");
    expect(status.codex.message).toContain("different Local AI Runtime");
    expect(status.captureHook.state).toBe("healthy");
  });

  it("rejects retired API credentials in the Codex MCP environment", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, ".codex"), { recursive: true });
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(
      resolve(root, ".codex/config.toml"),
      codexIntegrationConfig(root).replace(
        `KOED_HOME = "${root}"`,
        `KOED_HOME = "${root}"\nMEMORY_API_URL = "http://localhost:3300"\nMEMORY_API_TOKEN = "retired-token"`
      )
    );

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () => response(false, 503, {}),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.codex.state).toBe("needs_attention");
    expect(status.codex.message).toContain("retired API credentials");
    expect(status.captureHook.state).toBe("healthy");
  });

  it("uses CODEX_HOME for isolated device diagnostics", async () => {
    const root = tempDir();
    const codexHome = resolve(root, "isolated-codex");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(
      resolve(codexHome, "config.toml"),
      codexIntegrationConfig(root, root, codexHome)
    );

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: resolve(root, "unrelated-home"),
        CODEX_HOME: codexHome,
        API_HOST_PORT: "43300",
        MEMORY_API_TOKEN: "token",
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () =>
          response(true, 200, {
            checks: [
              { service: "postgres", status: "ok" },
              { service: "postgres-version", status: "ok" },
              { service: "migrations", status: "ok" },
              { service: "pgvector", status: "ok" },
              { service: "work-queue", status: "ok" },
              { service: "embedding-service", status: "ok" },
              { service: "embedding-model", status: "ok" }
            ]
          }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.codex.state).toBe("healthy");
    expect(status.captureHook.state).toBe("healthy");
    expect(status.codex.details?.codexConfigPath).toBe(
      resolve(codexHome, "config.toml")
    );
    expect(status.codex.details?.codexInstructionsPath).toBe(
      resolve(codexHome, "AGENTS.md")
    );
  });

  it.each([
    ["missing", null],
    [
      "stale",
      "<!-- >>> koed-memory-guidance -->\nold\n<!-- <<< koed-memory-guidance -->\n"
    ],
    ["malformed", "<!-- >>> koed-memory-guidance -->\nbroken\n"]
  ])("reports %s Codex global memory guidance", async (expected, content) => {
    const root = tempDir();
    mkdirSync(resolve(root, ".codex"), { recursive: true });
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(
      resolve(root, ".codex/config.toml"),
      codexIntegrationConfig(root)
    );
    if (content === null) {
      rmSync(resolve(root, ".codex/AGENTS.md"));
    } else {
      writeFileSync(resolve(root, ".codex/AGENTS.md"), content);
    }

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () => response(false, 503, {}),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.codex.state).toBe("needs_attention");
    expect(status.codex.message).toContain(expected);
    expect(status.codex.action).toContain(
      expected === "malformed" ? "Repair or remove" : "Fix Codex integration"
    );
  });

  it("reports healthy Codex integration when global guidance is disabled", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, ".codex"), { recursive: true });
    mkdirSync(resolve(root, "config"), { recursive: true });
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(
      resolve(root, ".codex/config.toml"),
      codexIntegrationConfig(root)
    );
    rmSync(resolve(root, ".codex/AGENTS.md"));
    writeFileSync(
      resolve(root, "config/server.json"),
      JSON.stringify({ codexGlobalMemoryGuidanceEnabled: false })
    );

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () => response(false, 503, {}),
        spawnSync: () => spawnResult("", 0)
      }
    );

    expect(status.codex.state).toBe("healthy");
    expect(status.codex.message).toContain("guidance is disabled");
    expect(status.codex.details?.guidanceState).toBe("disabled");
  });

  it("honors the repo environment global guidance opt-out", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, ".codex"), { recursive: true });
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(
      resolve(root, ".codex/config.toml"),
      codexIntegrationConfig(root)
    );
    rmSync(resolve(root, ".codex/AGENTS.md"));
    writeFileSync(
      resolve(root, ".env"),
      "KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED=false\n"
    );

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () => response(false, 503, {}),
        spawnSync: () => spawnResult("", 0)
      }
    );

    expect(status.codex.state).toBe("healthy");
    expect(status.codex.details?.guidanceState).toBe("disabled");
  });

  it("fails core readiness when prepared local runtime supervisor is stopped", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, ".codex"), { recursive: true });
    mkdirSync(resolve(root, "hook"), { recursive: true });
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, ".env"), "MEMORY_API_TOKEN=token\n");
    writeFileSync(
      resolve(root, ".codex/config.toml"),
      codexIntegrationConfig(root)
    );
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/last-verification.json"),
      JSON.stringify({ ok: true, checkedAt: "2026-01-01T00:00:00.000Z" })
    );
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({ pid: 10, processes: { worker: 11 }, services: [] })
    );

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        REDIS_URL: "redis://operator:6379",
        PRIVACY_SERVICE_URL: "http://privacy.test:8092",
        PRIVACY_SERVICE_TOKEN: "privacy-token",
        PRIVACY_RUNTIME_CONTROL_TOKEN: "privacy-control-token",
        KOED_TEAM_COLLABORATION_ENABLED: "true"
      },
      {
        fetch: async (input) =>
          String(input).includes("privacy.test")
            ? response(true, 200, { status: "ok" })
            : response(true, 200, {
                checks: [
                  { service: "postgres", status: "ok" },
                  { service: "postgres-version", status: "ok" },
                  { service: "migrations", status: "ok" },
                  { service: "pgvector", status: "ok" },
                  { service: "redis", status: "ok" },
                  { service: "work-queue", status: "ok" },
                  { service: "embedding-service", status: "ok" },
                  { service: "embedding-model", status: "ok" }
                ]
              }),
        spawnSync: (_command, args) =>
          args.includes("doctor")
            ? spawnResult("", 0)
            : spawnResult(
                '{"Service":"redis","State":"running"}\n{"Service":"worker","State":"running"}\n',
                0
              ),
        checkPid: (pid) => pid === 11,
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.runtimeMode).toBe("developer");
    expect(status.dependencyMode).toBe("external");
    expect(status.state).toBe("needs_attention");
    expect(status.codexTranscriptWatcher.state).toBe("starting");
  });
  it("prefers running runtime state over plain-shell dependency defaults", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, ".env"),
      "KOED_DEPENDENCY_MODE=external\nWORK_QUEUE_BACKEND=bullmq\nMEMORY_API_TOKEN=repo-token\n"
    );
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "desktop-token" })
    );
    mkdirSync(resolve(root, ".codex"), { recursive: true });
    writeFileSync(
      resolve(root, ".codex/config.toml"),
      codexIntegrationConfig(root)
    );
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/package.json"), "{}");
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({
        pid: 42,
        startedAt: "2026-01-01T00:00:00.000Z",
        repoRoot: root,
        apiUrl: "http://localhost:43300",
        runtimeMode: "local-personal",
        dependencyMode: "bundled-local",
        automaticPorts: true,
        services: [
          "postgres-native",
          "embedding-service-native",
          "api",
          "worker",
          "local-ai-runtime"
        ],
        codexTranscriptWatcherEnabled: true,
        processes: {
          api: 43,
          worker: 44,
          localAiRuntime: 46
        }
      })
    );

    const fetchedUrls: string[] = [];
    const status = await collectKoedServerStatus(
      { KOED_HOME: root, KOED_REPO_ROOT: root, HOME: root },
      {
        fetch: async (url) => {
          fetchedUrls.push(String(url));
          return response(true, 200, {
            checks: [
              { service: "postgres", status: "ok" },
              { service: "postgres-version", status: "ok" },
              { service: "migrations", status: "ok" },
              { service: "pgvector", status: "ok" },
              { service: "work-queue", status: "ok" },
              { service: "embedding-service", status: "ok" },
              { service: "embedding-model", status: "ok" }
            ]
          });
        },
        spawnSync: () => spawnResult("", 0),
        checkPid: (pid) => [42, 44, 46].includes(pid),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(fetchedUrls).toContain("http://localhost:43300/ready");
    expect(status.runtimeMode).toBe("local-personal");
    expect(status.dependencyMode).toBe("bundled-local");
    expect(status.codexTranscriptWatcher.state).toBe("healthy");
    expect(status.claudeTranscriptWatcher.state).toBe("healthy");
    expect(status.codex.state).toBe("healthy");
    expect(status.mcpServer.state).toBe("healthy");
    expect(status.redis.message).toContain("local queue");
  });
});

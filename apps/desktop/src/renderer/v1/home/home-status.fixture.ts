import type { KoedServerStatus } from "../../../types.js";

const healthy = { state: "healthy" as const };

export function homeStatus(
  overrides: Partial<KoedServerStatus> = {},
  clients: Record<
    string,
    Partial<NonNullable<KoedServerStatus["aiClients"]>[string]>
  > = {}
): KoedServerStatus {
  return {
    ok: true,
    state: "healthy",
    generatedAt: "2026-11-03T12:00:00Z",
    lifecycle: { state: "running" },
    api: { ...healthy, url: "http://127.0.0.1:3300" },
    database: healthy,
    redis: healthy,
    workerQueues: healthy,
    embeddingService: healthy,
    apiToken: { ...healthy, configured: true },
    mcpServer: healthy,
    localAiRuntime: healthy,
    captureHook: healthy,
    codex: { ...healthy, configured: true },
    lcmSummaryService: healthy,
    lastVerification: { ...healthy, checkedAt: null },
    serverPackage: healthy,
    upstreamBackends: {
      ...healthy,
      registered: 0,
      validated: 0,
      stale: 0,
      failed: 0,
      notChecked: 0
    },
    aiClients: Object.fromEntries(
      Object.entries(clients).map(([id, client]) => [
        id,
        {
          driverId: id,
          instanceId: id,
          displayName: id,
          installed: healthy,
          version: "1.2.3",
          authentication: "authenticated",
          profile: healthy,
          capabilities: [],
          observedAt: "2026-11-03T12:00:00Z",
          snapshotState: "current",
          ...client
        }
      ])
    ),
    ...overrides
  } as unknown as KoedServerStatus;
}

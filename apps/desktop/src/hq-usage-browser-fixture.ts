import type { DesktopApi } from "./types.js";
import type {
  LocalAiClientResponse,
  LocalAiClientUsageChanged
} from "./ipc/local-ai-client-protocol.js";
import { localAiClientFlowKeys } from "./ipc/local-ai-client-protocol.js";
import {
  usageFixture,
  usageFixtureNow
} from "./renderer/hq/usage/hq-usage.fixture.js";
import type { UsageReading } from "./renderer/hq/usage/hq-usage-model.js";

type Variant =
  | "codexLow"
  | "claudeNear"
  | "allFine"
  | "passedReset"
  | "secondCodexBucket"
  | "codexRestriction"
  | "unknown"
  | "stale";
const instances = [
  {
    instanceId: "codex.fixture",
    driverId: "codex" as const,
    displayName: "Codex",
    enabled: true
  },
  {
    instanceId: "claude.fixture",
    driverId: "claude" as const,
    displayName: "Claude",
    enabled: true
  },
  {
    instanceId: "pi.fixture",
    driverId: "pi" as const,
    displayName: "Pi",
    enabled: true
  }
];
const defaults = Object.fromEntries(
  localAiClientFlowKeys.map((flowKey) => [
    flowKey,
    { source: "code", available: false, assignment: null, reason: null }
  ])
) as LocalAiClientResponse["readModel"]["defaults"];
const readModel: LocalAiClientResponse["readModel"] = {
  instances,
  capabilitySnapshots: [],
  settings: [],
  defaults
};

export function createHq521UsageFixture() {
  let variant: Variant = "codexLow";
  let outcome: "checked" | "failed" | "unsupported" = "checked";
  let owner = "owner-a";
  const listeners = new Set<(change: LocalAiClientUsageChanged) => void>();
  const trace = { reads: 0, refreshes: 0, subscriptions: 0, unsubscribes: 0 };
  const shifted = (value: string | null) =>
    value
      ? new Date(Date.parse(value) + Date.now() - usageFixtureNow).toISOString()
      : null;
  const readings = (): UsageReading[] => {
    const codex =
      variant === "codexLow"
        ? usageFixture.codexLow
        : variant === "claudeNear" || variant === "allFine"
          ? usageFixture.allFine
          : usageFixture[variant];
    const claude =
      variant === "claudeNear"
        ? usageFixture.claudeNear
        : usageFixture.claudeAllowed;
    return [...codex, ...claude].map((reading) => ({
      ...reading,
      instanceId:
        reading.source === "codex_app_server"
          ? "codex.fixture"
          : "claude.fixture",
      observedAt: shifted(reading.observedAt)!,
      resetsAt: shifted(reading.resetsAt)
    }));
  };
  const response = (usageOutcome?: typeof outcome): LocalAiClientResponse => ({
    operation: "usage",
    readModel,
    usage: readings(),
    usageOutcome
  });
  const api = {
    list: async () => ({ operation: "list" as const, readModel }),
    refresh: async () => ({ operation: "refresh" as const, readModel }),
    usage: async (instanceId?: string) => {
      if (instanceId) {
        trace.refreshes++;
        return response(outcome);
      }
      trace.reads++;
      return response();
    },
    onUsageChanged: (listener: (change: LocalAiClientUsageChanged) => void) => {
      trace.subscriptions++;
      listeners.add(listener);
      return () => {
        trace.unsubscribes++;
        listeners.delete(listener);
      };
    },
    set: async () => ({ operation: "set" as const, readModel }),
    reset: async () => ({ operation: "reset" as const, readModel })
  } as DesktopApi["localAiClients"];
  const control = {
    trace,
    setVariant(value: Variant) {
      variant = value;
    },
    setOutcome(value: typeof outcome) {
      outcome = value;
    },
    emit() {
      for (const listener of listeners)
        listener({
          kind: "completion",
          instanceId: "codex.fixture",
          completionId: `${owner}-${trace.reads}`,
          outcome: "checked",
          observedAt: new Date().toISOString()
        });
    },
    invalidate() {
      owner = owner === "owner-a" ? "owner-b" : "owner-a";
      for (const listener of listeners) listener({ kind: "invalidated" });
    },
    catchUp() {
      for (const listener of listeners) listener({ kind: "catch_up" });
    },
    activeSubscribers: () => listeners.size
  };
  return { api, control };
}

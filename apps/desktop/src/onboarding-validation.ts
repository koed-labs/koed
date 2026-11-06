import { homeStatus } from "./renderer/v1/home/home-status.fixture.js";
// Deterministic bridge used ONLY by the Vite validation entry, never the app entry.
import type { V1Profile } from "./ipc/v1-state-protocol.js";
import type {
  DesktopSetupSnapshot,
  DesktopSetupStageId,
  KoedServerStatus
} from "./types.js";
import {
  clients,
  stageIds,
  type ClientId
} from "./renderer/v1/onboarding/model.js";

export function installOnboardingValidation() {
  const query = new URLSearchParams(location.search);
  const scene = query.get("scene") ?? "ready";
  const outcome = query.get("outcome") ?? "partial";
  const listeners = new Set<(snapshot: DesktopSetupSnapshot) => void>();
  let preference =
    (query.get("full") === "1"
      ? localStorage.getItem("onboarding-theme")
      : null) ?? (query.get("theme") === "dark" ? "dark" : "light");
  let snapshot: DesktopSetupSnapshot = {
    activeStage: null,
    error: null,
    runId: "validation",
    sequence: 1,
    state: scene === "pending" ? "ready" : "complete",
    stages: stageIds.map((id) => ({
      id,
      state: scene === "pending" ? "pending" : "complete",
      message: "Ready",
      completedBytes: null,
      totalBytes: null
    }))
  };
  let resolveRun: ((snapshot: DesktopSetupSnapshot) => void) | undefined;
  let calls: { command: string; args?: Record<string, unknown> }[] = [];
  const status = {
    ...homeStatus(),
    generatedAt: new Date().toISOString(),
    api: { state: "healthy", url: "http://fixture.invalid" },
    lifecycle: { state: "running", message: "Running" },
    codex: { configured: false },
    claudeCode: { configured: false },
    pi: { configured: false },
    aiClients: Object.fromEntries(
      clients.map((c) => [
        c.id,
        {
          driverId: c.id,
          installed: { state: "healthy" },
          version:
            c.id === "codex"
              ? "0.163.0"
              : c.id === "claude"
                ? "2.1.267"
                : "1.1.0",
          profile: { state: "not_configured" },
          authentication: "unknown",
          capabilities: [],
          snapshotState: "current"
        }
      ])
    )
  } as unknown as KoedServerStatus;
  function publish() {
    snapshot = {
      ...snapshot,
      sequence: snapshot.sequence + 1,
      stages: snapshot.stages.map((s) => ({ ...s }))
    };
    for (const listener of listeners) listener(snapshot);
  }
  function stage(id: DesktopSetupStageId, fraction = 0) {
    const index = stageIds.indexOf(id);
    snapshot = {
      ...snapshot,
      state: "running",
      activeStage: id,
      error: null,
      stages: snapshot.stages.map((s, i) => ({
        ...s,
        state: i < index ? "complete" : i === index ? "running" : "pending",
        completedBytes: i === index ? fraction * 512 * 1_048_576 : null,
        totalBytes: i === index && fraction ? 512 * 1_048_576 : null
      }))
    };
    publish();
  }
  function fail(
    message = "Memory models couldn’t finish setting up. Let’s try that step again."
  ) {
    snapshot = {
      ...snapshot,
      state: "failed",
      error: message,
      stages: snapshot.stages.map((s) =>
        s.id === snapshot.activeStage ? { ...s, state: "failed" } : s
      )
    };
    publish();
    resolveRun?.(snapshot);
    resolveRun = undefined;
  }
  function completeSetup() {
    snapshot = {
      ...snapshot,
      state: "complete",
      activeStage: null,
      error: null,
      stages: snapshot.stages.map((s) => ({ ...s, state: "complete" }))
    };
    publish();
    resolveRun?.(snapshot);
    resolveRun = undefined;
  }
  if (scene === "running" || scene === "setup-error") {
    stage("model", 0.5);
    if (scene === "setup-error") fail();
  }
  const failed = new Set<string>();
  let profile: V1Profile =
    query.get("full") === "1"
      ? (JSON.parse(localStorage.getItem("onboarding-profile") ?? "null") ?? {
          onboarding: { completed: false, selections: {} }
        })
      : { onboarding: { completed: false, selections: {} } };
  const fixture = {
    calls: () => calls,
    stage,
    fail,
    completeSetup,
    setUnavailable: () => {
      status.lifecycle = { state: "stopped", message: "Stopped" };
    },
    setAuthentication: (
      id: ClientId,
      authentication: "authenticated" | "unknown" | "unauthenticated"
    ) => {
      status.aiClients![id]!.authentication = authentication;
    },
    complete: false,
    draft: undefined as unknown,
    savedAgent: undefined as unknown,
    ready: false,
    failCompletionWrites: 0,
    profile: () => profile
  };
  Object.assign(window, { onboardingValidation: fixture });
  Object.defineProperty(window, "koedDesktop", {
    configurable: true,
    value: {
      v1State: {
        readProfile: async () => structuredClone(profile),
        writeProfile: async (next: V1Profile) => {
          if (next.onboarding.completed && fixture.failCompletionWrites > 0) {
            fixture.failCompletionWrites--;
            throw new Error("Profile save failed. Try again.");
          }
          profile = structuredClone(next);
          localStorage.setItem("onboarding-profile", JSON.stringify(profile));
          return structuredClone(profile);
        },
        readIdentity: async () => ({
          ownerId: "validation-owner",
          scopeKey: "validation-personal"
        }),
        readProvenance: async () => ({
          schemaVersion: 1,
          conversations: {},
          projects: {}
        })
      },
      setup: {
        inspect: async () => snapshot,
        subscribe: (listener: (s: DesktopSetupSnapshot) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        run: () => {
          calls.push({ command: "setup_run" });
          stage("package");
          return new Promise<DesktopSetupSnapshot>((resolve) => {
            resolveRun = resolve;
          });
        }
      },
      theme: {
        get: async () => preference,
        set: async (value: string) => {
          preference = value;
          localStorage.setItem("onboarding-theme", value);
          return { preference, resolvedDark: value === "dark" };
        }
      },
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls = [...calls, { command, args }];
        if (command === "status") return structuredClone(status);
        const id = command.split("_")[1] as ClientId;
        if (!clients.some((c) => c.id === id))
          throw new Error(`Unexpected validation command ${command}`);
        if (
          outcome === "failure" ||
          ((outcome === "partial" ||
            outcome === "details" ||
            outcome === "long-details") &&
            id === "claude" &&
            !failed.has(id))
        ) {
          failed.add(id);
          return {
            ok: false,
            message:
              outcome === "details" || outcome === "long-details"
                ? "Could not update the Claude Code profile: the settings file is not writable. Check its permissions and try again. ".repeat(
                    outcome === "long-details" ? 40 : 1
                  )
                : "Couldn’t connect. Try again."
          };
        }
        Object.assign(status.aiClients![id]!, {
          profile: { state: "healthy" },
          authentication: "authenticated"
        });
        return { ok: true };
      }
    }
  });
  return { fixture, scene };
}

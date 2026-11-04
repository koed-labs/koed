import { describe, expect, it } from "vitest";
import type { KoedServerStatus } from "../../../types.js";
import { homeStatus } from "./home-status.fixture.js";
import {
  formatHomeAgo,
  holdHomeOrder,
  homeClients,
  homeHeat,
  rankHomeProjects,
  selectHomeView,
  type HomeProjectEntry
} from "./home-model.js";

const entry = (
  id: string,
  latestAt: string | null,
  name = id
): HomeProjectEntry => ({ id, name, eventCount: 1, latestAt });

describe("selectHomeView", () => {
  it("waits for status and for the first Project load", () => {
    expect(selectHomeView(null, [])).toEqual({ kind: "loading" });
    expect(selectHomeView(homeStatus(), null)).toEqual({ kind: "loading" });
  });

  it("chooses Projects or the quiet stage from loaded Projects", () => {
    expect(selectHomeView(homeStatus(), []).kind).toBe("empty");
    expect(selectHomeView(homeStatus(), [entry("a", null)]).kind).toBe(
      "projects"
    );
  });

  it("takes over the screen only when the API or database is down", () => {
    const view = selectHomeView(
      homeStatus({
        database: { state: "needs_attention", message: "Postgres stopped." }
      }),
      null
    );
    expect(view.kind).toBe("attention");
    if (view.kind !== "attention") return;
    expect(view.problems[0]).toMatchObject({
      id: "runtime",
      message: "Postgres stopped."
    });
    expect(view.primary?.action?.command).toBe("runtime_install");
  });

  it("explains a stopped Koed even when every component looks healthy", () => {
    const view = selectHomeView(
      homeStatus({
        lifecycle: { state: "stopped" }
      } as Partial<KoedServerStatus>),
      []
    );
    expect(view).toMatchObject({
      kind: "attention",
      primary: { action: { command: "start" } }
    });
  });

  it("shows one Start Koed row while Koed is stopped", () => {
    const view = selectHomeView(
      homeStatus({
        lifecycle: { state: "stopped" },
        api: { state: "needs_attention", message: "Koed is not running." },
        database: { state: "needs_attention", message: "Koed is not running." },
        captureHook: {
          state: "needs_attention",
          message: "Koed is not running."
        }
      } as Partial<KoedServerStatus>),
      null
    );
    expect(view).toMatchObject({
      kind: "attention",
      problems: [{ id: "services", action: { command: "start" } }]
    });
    expect(view.kind === "attention" && view.problems).toHaveLength(1);
  });

  it("words down services plainly, keeping the status message as detail", () => {
    const view = selectHomeView(
      homeStatus({
        api: {
          state: "needs_attention",
          message: "API is not responding on 127.0.0.1:43300."
        }
      } as Partial<KoedServerStatus>),
      null
    );
    expect(view).toMatchObject({
      kind: "attention",
      problems: [
        {
          id: "services",
          title: "Koed services",
          detail: "API is not responding on 127.0.0.1:43300.",
          action: { command: "start", label: "Start Koed" }
        }
      ]
    });
  });

  it("leaves a stale diagnostics result out of Home", () => {
    expect(
      selectHomeView(
        homeStatus({
          lastVerification: {
            state: "needs_attention",
            message: "API is not ready",
            checkedAt: null
          }
        }),
        []
      )
    ).toEqual({ kind: "empty", warnings: [] });
  });

  it("shows other problems as warnings above Projects", () => {
    const view = selectHomeView(
      homeStatus({
        captureHook: { state: "needs_attention", message: "Hook is quiet." }
      }),
      [entry("a", null)]
    );
    expect(view).toEqual({
      kind: "projects",
      warnings: [
        {
          id: "capture-hook",
          title: "Capture Hook",
          message: "Hook is quiet.",
          action: null
        }
      ]
    });
  });
});

describe("ingestion", () => {
  const progress = (
    lifecycle: string,
    selected: number | null,
    completed = 0,
    skipped = 0
  ) => ({
    lifecycle,
    selected,
    completed,
    skipped,
    updatedAt: null,
    lastErrorCode: null,
    failingSince: null as string | null
  });

  it("shows the hatching screen only while a run is running or retrying", () => {
    const running = homeStatus({
      claudeCode: { state: "healthy", configured: true, detected: true },
      historicalIngestion: {
        codex: progress("running", 10, 3, 1),
        claude: progress("completed", 5, 5),
        pi: progress("unknown", null)
      }
    } as Partial<KoedServerStatus>);
    expect(selectHomeView(running, null)).toMatchObject({
      kind: "ingesting",
      ingestion: {
        active: true,
        finished: 9,
        selected: 15,
        clients: [{ id: "codex" }, { id: "claude" }]
      }
    });
    const idle = homeStatus({
      historicalIngestion: { codex: progress("idle", 10, 3) }
    } as Partial<KoedServerStatus>);
    expect(selectHomeView(idle, []).kind).toBe("empty");
  });

  it("ignores history progress from an AI Client that isn't connected", () => {
    // Koed reads only connected clients; this is left from before.
    const disconnected = homeStatus({
      pi: { state: "not_configured", configured: false, detected: true },
      historicalIngestion: { pi: progress("running", 31, 11) }
    } as Partial<KoedServerStatus>);
    expect(selectHomeView(disconnected, []).kind).toBe("empty");
  });

  it("warns once a failing run has made no progress for a while", () => {
    const failing = (minutesAgo: number) =>
      homeStatus({
        historicalIngestion: {
          codex: {
            ...progress("failed", 50, 1),
            lastErrorCode: "historical_ingestion_pass_failed",
            failingSince: new Date(
              Date.now() - minutesAgo * 60_000
            ).toISOString()
          }
        }
      } as Partial<KoedServerStatus>);
    expect(selectHomeView(failing(2), null)).toMatchObject({
      kind: "ingesting",
      warnings: [],
      ingestion: { clients: [{ stuck: false }] }
    });
    expect(selectHomeView(failing(15), null)).toMatchObject({
      kind: "ingesting",
      // The chip reads "Check Codex history".
      warnings: [{ id: "ingestion-codex", title: "Codex history" }],
      ingestion: { clients: [{ stuck: true }] }
    });
  });

  it("leaves the total unknown until every selection is known", () => {
    const status = homeStatus({
      historicalIngestion: {
        codex: progress("running", null),
        claude: progress("running", 4)
      }
    } as Partial<KoedServerStatus>);
    const view = selectHomeView(status, null);
    expect(view.kind === "ingesting" && view.ingestion.selected).toBeNull();
  });
});

describe("homeClients", () => {
  it("lists detected or configured AI Clients only", () => {
    const status = homeStatus(
      {},
      {
        codex: {},
        claude: {
          authentication: "unknown",
          profile: { state: "not_configured" }
        },
        pi: {
          installed: { state: "not_configured" },
          profile: { state: "not_configured" }
        }
      }
    );
    expect(homeClients(status)).toEqual([
      expect.objectContaining({
        id: "codex",
        state: "connected",
        version: null
      }),
      expect.objectContaining({
        id: "claude",
        state: "detected",
        version: "1.2.3",
        label: "Detected · not connected"
      })
    ]);
  });

  it("keeps a configured client whose detection is stale", () => {
    const status = homeStatus(
      {
        codex: { state: "not_configured", configured: false },
        pi: { state: "healthy", configured: true }
      } as Partial<KoedServerStatus>,
      {
        pi: {
          installed: { state: "not_configured" },
          snapshotState: "stale"
        }
      }
    );
    expect(homeClients(status)).toEqual([
      expect.objectContaining({ id: "pi", state: "unsure" })
    ]);
  });

  it("flags a connected client whose automatic capture isn’t ready", () => {
    const status = homeStatus(
      {
        codex: { state: "not_configured", configured: false },
        claudeCode: { state: "healthy", configured: true }
      } as Partial<KoedServerStatus>,
      {
        claude: {
          capabilities: [
            {
              id: "automatic_capture",
              support: "supported",
              readiness: "not_ready",
              diagnostics: [
                {
                  code: "watcher_stopped",
                  message: "The transcript watcher stopped.",
                  severity: "error"
                }
              ]
            }
          ]
        }
      }
    );
    expect(homeClients(status)).toEqual([
      expect.objectContaining({
        id: "claude",
        state: "attention",
        label: "The transcript watcher stopped."
      })
    ]);
    expect(selectHomeView(status, [])).toMatchObject({
      kind: "empty",
      warnings: [
        {
          id: "client-claude",
          action: { command: "repair_claude", requiresConsent: true }
        }
      ]
    });
  });
});

describe("Project ranking", () => {
  it("orders by latest activity, then name, then id", () => {
    expect(
      rankHomeProjects([
        entry("old", "2026-11-01T00:00:00Z"),
        entry("none", null),
        entry("b", "2026-11-03T00:00:00Z", "same"),
        entry("a", "2026-11-03T00:00:00Z", "same"),
        entry("new", "2026-11-03T10:00:00Z")
      ])
    ).toEqual(["new", "a", "b", "old", "none"]);
  });

  it("holds the shown order, dropping removed and appending new Projects", () => {
    expect(holdHomeOrder(["a", "b", "c"], ["d", "c", "a"])).toEqual([
      "a",
      "c",
      "d"
    ]);
  });

  it("describes activity age and heat", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    expect(formatHomeAgo("2026-11-03T11:59:40Z", now)).toBe("just now");
    expect(formatHomeAgo("2026-11-03T11:30:00Z", now)).toBe("30m ago");
    expect(formatHomeAgo(null, now)).toBe("no activity yet");
    expect(homeHeat("2026-11-03T11:58:00Z", now)).toBe(3);
    expect(homeHeat("2026-10-01T00:00:00Z", now)).toBe(0);
  });
});

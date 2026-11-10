// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homeStatus } from "./home-status.fixture.js";
import type { KoedServerStatus } from "../../../types.js";
import type { HomeProjectEntry } from "./home-model.js";
import { HOME_STARTUP_GRACE_MS, useHomeStartup } from "./use-home-startup.js";

const stopped = () =>
  homeStatus({ lifecycle: { state: "stopped", message: "Stopped" } });
const projects: HomeProjectEntry[] = [
  { id: "a", name: "A", eventCount: 1, latestAt: null }
];

describe("Home launch grace", () => {
  let root: Root;
  let container: HTMLDivElement;
  let result: ReturnType<typeof useHomeStartup>;
  function Harness({
    status,
    entries,
    enabled,
    starting
  }: {
    status: KoedServerStatus | null;
    entries: readonly HomeProjectEntry[] | null;
    enabled: boolean;
    starting: boolean;
  }) {
    result = useHomeStartup(status, entries, { enabled, starting });
    return <span>{result.view.kind}</span>;
  }
  const render = async (
    status: KoedServerStatus | null,
    entries: readonly HomeProjectEntry[] | null = projects,
    enabled = true,
    starting = false
  ) => {
    await act(async () =>
      root.render(
        <Harness
          status={status}
          entries={entries}
          enabled={enabled}
          starting={starting}
        />
      )
    );
  };
  const advance = async (ms: number) =>
    act(async () => vi.advanceTimersByTime(ms));
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  it("holds initial stopped services for thirty seconds, then offers recovery", async () => {
    await render(stopped());
    expect(result!.startupPending).toBe(true);
    await advance(10_000);
    expect(result!.view.kind).toBe("loading");
    await advance(HOME_STARTUP_GRACE_MS - 10_000 - 1);
    expect(result!.view.kind).toBe("loading");
    await advance(1);
    expect(result!.view).toMatchObject({
      kind: "attention",
      primary: { action: { command: "start" } }
    });
    expect(result!.startupPending).toBe(false);
  });
  it("shows ready Projects immediately and never grants later failures another grace", async () => {
    await render(stopped());
    await advance(3_000);
    await render(homeStatus());
    expect(result!.view.kind).toBe("projects");
    await render(stopped());
    expect(result!.view.kind).toBe("attention");
  });
  it("skips the grace when already ready and still waits for Project inventory", async () => {
    await render(homeStatus(), null);
    expect(result!.startupPending).toBe(false);
    expect(result!.view.kind).toBe("loading");
    await advance(HOME_STARTUP_GRACE_MS);
    expect(result!.view.kind).toBe("loading");
    await render(homeStatus(), []);
    expect(result!.view.kind).toBe("empty");
  });
  it("does not reset the deadline when startup status changes", async () => {
    await render(null);
    await advance(7_000);
    await render(
      homeStatus({
        api: {
          state: "needs_attention",
          url: "http://localhost",
          message: "Starting"
        }
      })
    );
    await advance(HOME_STARTUP_GRACE_MS - 7_000);
    expect(result!.view.kind).toBe("attention");
  });
  it("offers recovery even when the first status request has never settled", async () => {
    await render(null);
    await advance(HOME_STARTUP_GRACE_MS);
    expect(result!.view).toMatchObject({
      kind: "attention",
      primary: { action: { command: "start" } }
    });
    await render(homeStatus());
    expect(result!.view.kind).toBe("projects");
  });
  it("offers recovery after the deadline even if services keep reporting starting", async () => {
    await render(
      homeStatus({ api: { state: "starting", url: "http://localhost" } })
    );
    await advance(HOME_STARTUP_GRACE_MS);
    expect(result!.view).toMatchObject({
      kind: "attention",
      primary: { action: { command: "start" } }
    });
  });
  it("starts the grace only after onboarding is complete", async () => {
    await render(null, null, false);
    await advance(60_000);
    await render(stopped(), null);
    expect(result!.startupPending).toBe(true);
    await advance(HOME_STARTUP_GRACE_MS);
    expect(result!.view.kind).toBe("attention");
  });
  it("shows loading during an explicit restart, then restores recovery on failure", async () => {
    await render(homeStatus());
    await render(stopped(), projects, true, true);
    expect(result!.view.kind).toBe("loading");
    await render(stopped());
    expect(result!.view.kind).toBe("attention");
  });
  it("cleans up the deadline on unmount", async () => {
    await render(null);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});

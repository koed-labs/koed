// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingStateSnapshot } from "@koed/shared";
import type { KoedServerStatus } from "../../types.js";
import {
  SettingsServicePage,
  SettingsServicesOverview
} from "./settings-services.js";
const embedding = (): EmbeddingStateSnapshot => ({
  generatedAt: "2026-11-03T10:00:00Z",
  activity: "working",
  service: {
    healthy: true,
    compatible: true,
    model: "qwen3-0.6b",
    dimensions: 1024,
    expectedModel: "qwen3-0.6b",
    expectedDimensions: 1024
  },
  calibration: null,
  backlog: {
    pendingMemoryEvents: 12,
    pendingMemoryNodes: 3,
    pendingEstimatedTokens: 1000
  },
  throughput: {
    windowMinutes: 15,
    measuredTokensPerSecond: 180,
    eventsPerMinute: 40,
    retries: 2,
    failures: 1
  },
  drainEstimate: { lowerSeconds: 60, upperSeconds: 120, confidence: "medium" },
  queues: {
    memory: { waiting: 2, active: 1, delayed: 1, failed: 4 },
    lcm: null
  },
  projection: {
    liveRows: 2,
    waitingForAgentTurnRows: 1,
    historicalRows: 5,
    historicalBytes: 2048
  },
  historicalAdmission: { admitted: false, reason: "live_projection_pressure" }
});
const status = (state?: EmbeddingStateSnapshot | null) =>
  ({
    generatedAt: "2026-11-03T10:00:00Z",
    api: { state: "healthy" },
    database: { state: "starting", message: "Waiting for startup" },
    ...(state !== undefined ? { embeddingState: state } : {})
  }) as KoedServerStatus;
describe("settings service pages", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = async (node: ReactNode) => act(async () => root.render(node));
  it("counts offered services and opens a page instead of expanding inline", async () => {
    const onOpen = vi.fn();
    await render(
      <SettingsServicesOverview status={status(embedding())} onOpen={onOpen} />
    );
    expect(container.textContent).toContain("1 / 2");
    expect(container.textContent).toContain("1 service needs attention");
    expect(container.textContent).toContain("Embedding 15 items");
    expect(container.querySelector("details")).toBeNull();
    await act(async () =>
      (
        container.querySelector(
          '[data-settings-page="embedding"]'
        ) as HTMLButtonElement
      ).click()
    );
    expect(onOpen).toHaveBeenCalledWith("embedding");
  });
  it("does not call an empty snapshot healthy or offer absent embedding capabilities", async () => {
    await render(<SettingsServicesOverview status={null} onOpen={vi.fn()} />);
    expect(container.textContent).toContain("Service status unavailable");
    expect(container.textContent).not.toContain("All services are healthy");
    expect(
      container.querySelector('[data-settings-page="embedding"]')
    ).toBeNull();
    await render(
      <SettingsServicesOverview status={status()} onOpen={vi.fn()} />
    );
    expect(container.textContent).not.toContain("Pending embeddings");
  });
  it("keeps supported but unreadable embedding telemetry distinct from absence", async () => {
    await render(
      <SettingsServicesOverview status={status(null)} onOpen={vi.fn()} />
    );
    expect(
      container.querySelector('[data-settings-page="embedding"]')
    ).not.toBeNull();
    expect(container.textContent).toContain("Embedding state unavailable");
    expect(container.textContent).not.toContain("Up to date");
  });
  it("does not convert a missing backlog or throughput into zero or up-to-date", async () => {
    const state = {
      ...embedding(),
      activity: "idle" as const,
      backlog: null,
      throughput: null,
      drainEstimate: null
    };
    await render(
      <SettingsServicesOverview status={status(state)} onOpen={vi.fn()} />
    );
    expect(container.textContent).toContain("Embedding progress unknown");
    expect(container.textContent).not.toContain("Up to date");
    expect(
      [...container.querySelectorAll(".metrics strong")].map(
        (e) => e.textContent
      )
    ).toEqual(["1 / 2", "—", "—"]);
  });
  it("renders full telemetry without a disclosure and preserves error counts and pause reasons", async () => {
    await render(
      <SettingsServicePage
        page="embedding"
        status={status(embedding())}
        onBack={vi.fn()}
      />
    );
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("summary")).toBeNull();
    for (const text of [
      "Processing",
      "15",
      "12 memory events · 3 summaries",
      "1 min – 2 min",
      "2 retries",
      "1 failure",
      "3 waiting · 1 active · 4 failed",
      "Paused: live capture has priority",
      "5 rows · 2.0 KB pending"
    ])
      expect(container.textContent).toContain(text);
  });
  it("keeps service health errors visible and returns to Services", async () => {
    const back = vi.fn();
    await render(
      <SettingsServicePage page="health" status={status()} onBack={back} />
    );
    expect(container.textContent).toContain("Waiting for startup");
    expect(container.querySelector("details")).toBeNull();
    await act(async () =>
      (
        container.querySelector(".page-heading .back") as HTMLButtonElement
      ).click()
    );
    expect(back).toHaveBeenCalledOnce();
  });
  it.each([
    ["no_historical_backlog", "No pending history"],
    ["api_degraded", "API is not ready"],
    ["queue_degraded", "work queue is unavailable"],
    ["embedding_service_degraded", "Embedding Service is not ready"],
    ["capacity_profile_unavailable", "calibration pending"],
    ["live_projection_pressure", "live capture has priority"],
    ["concurrency_cap", "Waiting for the current batch"]
  ] as const)(
    "shows the backend historical-admission reason %s",
    async (reason, label) => {
      const state = {
        ...embedding(),
        historicalAdmission: { admitted: false, reason }
      };
      await render(
        <SettingsServicePage
          page="embedding"
          status={status(state)}
          onBack={vi.fn()}
        />
      );
      expect(container.textContent).toContain(label);
    }
  );
  it("distinguishes unsupported, unreadable, and incompatible embedding service states", async () => {
    await render(
      <SettingsServicePage
        page="embedding"
        status={status()}
        onBack={vi.fn()}
      />
    );
    expect(container.textContent).toContain("not offered");
    await render(
      <SettingsServicePage
        page="embedding"
        status={status(null)}
        onBack={vi.fn()}
      />
    );
    expect(container.textContent).toContain("could not read embedding state");
    const state = embedding();
    state.service.compatible = false;
    state.service.expectedModel = "expected-model";
    await render(
      <SettingsServicePage
        page="embedding"
        status={status(state)}
        onBack={vi.fn()}
      />
    );
    expect(container.textContent).toContain("Expected expected-model");
  });
});

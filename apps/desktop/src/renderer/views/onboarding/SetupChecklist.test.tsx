// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopApi,
  DesktopSetupSnapshot,
  KoedServerStatus
} from "../../../types.js";
import { DesktopStatusStore } from "../../services/desktop-commands.js";
import {
  compactHealthSummary,
  setupIsReady,
  setupStepsFromStatus
} from "./setup-model.js";
import { SetupChecklist } from "./SetupChecklist.js";

const component = (
  state: "not_configured" | "starting" | "healthy" | "needs_attention",
  message = state
) => ({ state, message });

const statusFixture = (
  state:
    | "not_configured"
    | "starting"
    | "healthy"
    | "needs_attention" = "healthy"
): KoedServerStatus => ({
  ok: state === "healthy",
  state,
  koedHome: "/tmp/koed-home",
  generatedAt: "2026-07-23T00:00:00.000Z",
  runtimeMode: "local-personal",
  dependencyMode: "bundled-local",
  api: { ...component(state), url: "http://127.0.0.1:3300" },
  database: component(state),
  redis: component(state),
  workerQueues: component(state),
  embeddingService: component(state),
  apiToken: { ...component(state), configured: state === "healthy" },
  mcpServer: component(state),
  captureHook: component(state),
  codex: { ...component(state), configured: state === "healthy" },
  lcmSummaryService: component(state),
  upstreamBackends: {
    ...component("healthy"),
    registered: 0,
    validated: 0,
    stale: 0,
    failed: 0,
    notChecked: 0
  },
  explorer: { ...component(state), url: "http://127.0.0.1:3300/explorer" },
  lastVerification: {
    ...component(state),
    checkedAt: state === "healthy" ? "2026-07-23T00:00:00.000Z" : null
  },
  serverPackage: component(state)
});

const setupFixture = (
  state: DesktopSetupSnapshot["state"] = "ready"
): DesktopSetupSnapshot => ({
  activeStage: state === "running" ? "model" : null,
  error: state === "failed" ? "Download failed" : null,
  runId: "setup-run",
  sequence: 1,
  state,
  stages: [
    "package",
    "runtime",
    "model",
    "services",
    "integration",
    "verification"
  ].map((id, index) => ({
    completedBytes: id === "model" && state === "running" ? 25 : null,
    id: id as DesktopSetupSnapshot["stages"][number]["id"],
    message:
      id === "model" && state === "running"
        ? "Downloading embedding model…"
        : state === "failed" && id === "model"
          ? "Download failed"
          : index < 2
            ? "Already complete"
            : "Needs setup",
    state:
      index < 2
        ? "complete"
        : id === "model" && state === "running"
          ? "running"
          : id === "model" && state === "failed"
            ? "failed"
            : "pending",
    totalBytes: id === "model" && state === "running" ? 100 : null
  }))
});

describe("SetupChecklist", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete window.koedDesktop;
  });

  it("models the required first-run sequence and collapses healthy detail", () => {
    const status = statusFixture("healthy");
    const steps = setupStepsFromStatus(status);

    expect(steps.map(({ id }) => id)).toEqual([
      "package",
      "runtime",
      "model",
      "services",
      "integration",
      "health"
    ]);
    expect(steps.every(({ action }) => action === null)).toBe(true);
    expect(setupIsReady(status)).toBe(true);
    expect(compactHealthSummary(status)).toEqual({
      label: "Koed is ready",
      state: "healthy"
    });
  });

  it("inspects existing state and requires consent before setup", async () => {
    const status = statusFixture("needs_attention");
    const inspect = vi.fn(async () => setupFixture());
    const run = vi.fn(async () => setupFixture("complete"));
    const subscribe = vi.fn(() => () => undefined);
    const invokeMock = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        void args;
        return command === "status" ? status : { ok: true };
      }
    );
    const invoke: DesktopApi["invoke"] = async <T = unknown,>(
      command: string,
      args?: Record<string, unknown>
    ): Promise<T> => (await invokeMock(command, args)) as T;
    window.koedDesktop = { invoke, setup: { inspect, run, subscribe } };

    await act(async () => {
      root.render(
        <SetupChecklist
          onComplete={vi.fn()}
          showTrustGuide={false}
          statusStore={new DesktopStatusStore()}
        />
      );
    });
    await act(async () => Promise.resolve());

    expect(inspect).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Koed package");
    expect(container.textContent).toContain("Complete");
    expect(container.querySelectorAll('[data-state="pending"]')).toHaveLength(
      4
    );

    const setup = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Set up Koed"
    )!;
    await act(async () => setup.click());

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Set up Koed on this computer?");
    expect(run).not.toHaveBeenCalled();
    const confirm = [...dialog!.querySelectorAll("button")].find(
      (button) => button.textContent === "Set up Koed"
    )!;
    await act(async () => confirm.click());
    expect(run).toHaveBeenCalledOnce();
  });

  it("renders event-driven byte progress without marking future stages active", async () => {
    let emit: ((snapshot: DesktopSetupSnapshot) => void) | undefined;
    window.koedDesktop = {
      invoke: async <T = unknown,>(): Promise<T> =>
        statusFixture("needs_attention") as T,
      setup: {
        inspect: async () => setupFixture(),
        run: async () => setupFixture("complete"),
        subscribe: (listener) => {
          emit = listener;
          return () => undefined;
        }
      }
    };
    await act(async () => {
      root.render(
        <SetupChecklist
          onComplete={vi.fn()}
          showTrustGuide={false}
          statusStore={new DesktopStatusStore()}
        />
      );
    });
    await act(async () => Promise.resolve());
    await act(async () => emit?.(setupFixture("running")));

    expect(container.textContent).toContain("25 B of 100 B");
    expect(container.textContent).toContain("25%");
    expect(container.querySelectorAll('[data-state="running"]')).toHaveLength(
      1
    );
    expect(container.querySelectorAll('[data-state="pending"]')).toHaveLength(
      3
    );
  });

  it("refreshes shared readiness when inspection finds setup complete", async () => {
    const complete = {
      ...setupFixture("complete"),
      stages: setupFixture().stages.map((stage) => ({
        ...stage,
        state: "complete" as const
      }))
    };
    const statusStore = new DesktopStatusStore();
    const refresh = vi
      .spyOn(statusStore, "refresh")
      .mockResolvedValue(statusFixture("healthy"));
    window.koedDesktop = {
      invoke: async <T = unknown,>(): Promise<T> =>
        statusFixture("healthy") as T,
      setup: {
        inspect: async () => complete,
        run: async () => complete,
        subscribe: () => () => undefined
      }
    };

    await act(async () => {
      root.render(
        <SetupChecklist
          onComplete={vi.fn()}
          showTrustGuide={false}
          statusStore={statusStore}
        />
      );
    });
    await act(async () => Promise.resolve());

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("teaches synthesis and sharing boundaries after setup", async () => {
    const status = statusFixture("healthy");
    window.koedDesktop = {
      invoke: async <T = unknown,>(): Promise<T> => status as T,
      setup: {
        inspect: async () => ({
          ...setupFixture("complete"),
          stages: setupFixture().stages.map((stage) => ({
            ...stage,
            state: "complete"
          }))
        }),
        run: async () => setupFixture("complete"),
        subscribe: () => () => undefined
      }
    };

    await act(async () => {
      root.render(
        <SetupChecklist
          onComplete={vi.fn()}
          statusStore={new DesktopStatusStore()}
        />
      );
    });
    await act(async () => Promise.resolve());
    const continueButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue"
    );
    await act(async () => continueButton!.click());

    expect(container.textContent).toContain("Personal and Team are separate");
    for (let index = 0; index < 2; index += 1) {
      const next = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Next")
      );
      await act(async () => next!.click());
    }
    expect(container.textContent).toContain(
      "Your AI Client performs synthesis"
    );
  });
});

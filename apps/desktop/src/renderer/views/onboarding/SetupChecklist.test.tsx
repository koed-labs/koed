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
  localAiRuntime: component(state),
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
  lastVerification: {
    ...component(state),
    checkedAt: state === "healthy" ? "2026-07-23T00:00:00.000Z" : null
  },
  serverPackage: component(state)
});

const clientReadiness = (
  driverId: "codex" | "claude" | "pi",
  profileState: "not_configured" | "healthy" | "needs_attention"
) => ({
  driverId,
  instanceId: `${driverId}.default`,
  displayName:
    driverId === "claude"
      ? "Claude Code"
      : driverId[0]!.toUpperCase() + driverId.slice(1),
  installed: component("healthy"),
  version: "1.0.0",
  authentication: "authenticated" as const,
  profile: component(profileState),
  capabilities: [
    {
      id: "automatic_capture" as const,
      support: "supported" as const,
      readiness: "unknown" as const,
      diagnostics: []
    }
  ],
  observedAt: "2026-07-23T00:00:00.000Z",
  snapshotState: "unknown" as const
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
    ...(id === "integration"
      ? { detectedAiClients: ["Codex", "Claude Code", "Pi"] }
      : {}),
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

const completeSetupFixture = (): DesktopSetupSnapshot => ({
  ...setupFixture("complete"),
  stages: setupFixture().stages.map((stage) => ({
    ...stage,
    state: "complete" as const
  }))
});

type ClientId = "codex" | "claude" | "pi";
type ClientProfileState = "not_configured" | "healthy";

const statusWithClientProfiles = (
  profiles: Record<ClientId, ClientProfileState>
): KoedServerStatus => ({
  ...statusFixture("healthy"),
  aiClients: {
    codex: clientReadiness("codex", profiles.codex),
    claude: clientReadiness("claude", profiles.claude),
    pi: clientReadiness("pi", profiles.pi)
  }
});

const singleClientCases = [
  { id: "codex", label: "Codex", command: "setup_codex" },
  { id: "claude", label: "Claude Code", command: "setup_claude" },
  { id: "pi", label: "Pi", command: "setup_pi" }
] as const;

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

  it("allows onboarding completion when detected AI Client setup is deferred", () => {
    const status = {
      ...statusFixture("healthy"),
      claudeCode: {
        ...component("not_configured"),
        configured: false,
        detected: true
      },
      pi: {
        ...component("healthy"),
        configured: true,
        detected: true
      }
    };

    const integration = setupStepsFromStatus(status).find(
      ({ id }) => id === "integration"
    );
    expect(integration?.components.map(({ label }) => label)).toEqual([
      "API Token",
      "MCP Server",
      "Local AI Runtime"
    ]);
    expect(integration?.action).toBeNull();
    expect(setupIsReady(status)).toBe(true);
  });

  it("reserves the compact error state for confirmed attention", () => {
    expect(compactHealthSummary(statusFixture("not_configured"))).toEqual({
      label: "Koed is starting",
      state: "starting"
    });
    expect(compactHealthSummary(statusFixture("needs_attention")).state).toBe(
      "fault"
    );
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
    expect(container.textContent).toContain("Claude Code detected");
    expect(container.textContent).toContain("Pi detected");
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

  it.each(singleClientCases)(
    "completes single-client onboarding for $label",
    async ({ id, label, command }) => {
      const configured = new Set<ClientId>();
      const status = () =>
        statusWithClientProfiles({
          codex: configured.has("codex") ? "healthy" : "not_configured",
          claude: configured.has("claude") ? "healthy" : "not_configured",
          pi: configured.has("pi") ? "healthy" : "not_configured"
        });
      const onComplete = vi.fn();
      const invoke = vi.fn(
        async (receivedCommand: string, args?: Record<string, unknown>) => {
          void args;
          if (receivedCommand === "status") return status();
          if (receivedCommand === command) {
            configured.add(id);
            return { ok: true };
          }
          throw new Error(`Unexpected command: ${receivedCommand}`);
        }
      );
      window.koedDesktop = {
        invoke: async <T = unknown,>(
          receivedCommand: string,
          args?: Record<string, unknown>
        ): Promise<T> => (await invoke(receivedCommand, args)) as T,
        setup: {
          inspect: async () => completeSetupFixture(),
          run: async () => completeSetupFixture(),
          subscribe: () => () => undefined
        }
      };

      await act(async () => {
        root.render(
          <SetupChecklist
            onComplete={onComplete}
            showTrustGuide={false}
            statusStore={new DesktopStatusStore()}
          />
        );
      });
      await vi.waitFor(() =>
        expect(
          [...container.querySelectorAll("button")].find(
            (button) => button.textContent === "Continue"
          )
        ).toBeTruthy()
      );
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Continue")!
          .click()
      );
      const checkbox = [
        ...container.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]'
        )
      ][["codex", "claude", "pi"].indexOf(id)];
      await act(async () => checkbox!.click());
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Continue")!
          .click()
      );
      await vi.waitFor(() =>
        expect(
          document.body.querySelector(
            '[role="dialog"] [data-slot="dialog-title"]'
          )?.textContent
        ).toBe(`Set up ${label}?`)
      );
      await act(async () =>
        [
          ...document.body.querySelectorAll<HTMLButtonElement>(
            '[role="dialog"] button'
          )
        ]
          .find((button) => button.textContent === "Allow and set up")!
          .click()
      );
      await vi.waitFor(() =>
        expect(container.textContent).toContain(`${label}: configured`)
      );
      expect(invoke).toHaveBeenCalledWith(command, {
        operatorConsented: true
      });
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Finish")!
          .click()
      );
      expect(onComplete).toHaveBeenCalledOnce();
    }
  );

  it("completes successful multi-client onboarding in queue order", async () => {
    const configured = new Set<ClientId>();
    const status = () =>
      statusWithClientProfiles({
        codex: configured.has("codex") ? "healthy" : "not_configured",
        claude: configured.has("claude") ? "healthy" : "not_configured",
        pi: configured.has("pi") ? "healthy" : "not_configured"
      });
    const onComplete = vi.fn();
    const invoke = vi.fn(
      async (receivedCommand: string, args?: Record<string, unknown>) => {
        void args;
        if (receivedCommand === "status") return status();
        const client = singleClientCases.find(
          ({ command }) => command === receivedCommand
        );
        if (client) {
          configured.add(client.id);
          return { ok: true };
        }
        throw new Error(`Unexpected command: ${receivedCommand}`);
      }
    );
    window.koedDesktop = {
      invoke: async <T = unknown,>(
        receivedCommand: string,
        args?: Record<string, unknown>
      ): Promise<T> => (await invoke(receivedCommand, args)) as T,
      setup: {
        inspect: async () => completeSetupFixture(),
        run: async () => completeSetupFixture(),
        subscribe: () => () => undefined
      }
    };

    await act(async () => {
      root.render(
        <SetupChecklist
          onComplete={onComplete}
          showTrustGuide={false}
          statusStore={new DesktopStatusStore()}
        />
      );
    });
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Continue"
        )
      ).toBeTruthy()
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );
    await act(async () => {
      for (const checkbox of container.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]'
      )) {
        checkbox.click();
      }
    });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );

    for (const { label } of singleClientCases) {
      await vi.waitFor(() =>
        expect(
          document.body.querySelector(
            '[role="dialog"] [data-slot="dialog-title"]'
          )?.textContent
        ).toBe(`Set up ${label}?`)
      );
      await act(async () =>
        [
          ...document.body.querySelectorAll<HTMLButtonElement>(
            '[role="dialog"] button'
          )
        ]
          .find((button) => button.textContent === "Allow and set up")!
          .click()
      );
    }
    await vi.waitFor(() => {
      for (const { label } of singleClientCases) {
        expect(container.textContent).toContain(`${label}: configured`);
      }
    });
    expect(
      invoke.mock.calls
        .filter(([receivedCommand]) => receivedCommand.startsWith("setup_"))
        .map(([receivedCommand, args]) => [receivedCommand, args])
    ).toEqual(
      singleClientCases.map(({ command }) => [
        command,
        { operatorConsented: true }
      ])
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Finish")!
        .click()
    );
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("preserves prior success when next client consent is cancelled", async () => {
    const configured = new Set<ClientId>();
    const status = () =>
      statusWithClientProfiles({
        codex: configured.has("codex") ? "healthy" : "not_configured",
        claude: configured.has("claude") ? "healthy" : "not_configured",
        pi: "not_configured"
      });
    const onComplete = vi.fn();
    const invoke = vi.fn(
      async (receivedCommand: string, args?: Record<string, unknown>) => {
        void args;
        if (receivedCommand === "status") return status();
        if (receivedCommand === "setup_codex") {
          configured.add("codex");
          return { ok: true };
        }
        throw new Error(`Unexpected command: ${receivedCommand}`);
      }
    );
    window.koedDesktop = {
      invoke: async <T = unknown,>(
        receivedCommand: string,
        args?: Record<string, unknown>
      ): Promise<T> => (await invoke(receivedCommand, args)) as T,
      setup: {
        inspect: async () => completeSetupFixture(),
        run: async () => completeSetupFixture(),
        subscribe: () => () => undefined
      }
    };

    await act(async () => {
      root.render(
        <SetupChecklist
          onComplete={onComplete}
          showTrustGuide={false}
          statusStore={new DesktopStatusStore()}
        />
      );
    });
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Continue"
        )
      ).toBeTruthy()
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );
    const checkboxes = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    ];
    await act(async () => {
      checkboxes[0]!.click();
      checkboxes[1]!.click();
    });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(
          '[role="dialog"] [data-slot="dialog-title"]'
        )?.textContent
      ).toBe("Set up Codex?")
    );
    await act(async () =>
      [
        ...document.body.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button'
        )
      ]
        .find((button) => button.textContent === "Allow and set up")!
        .click()
    );
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(
          '[role="dialog"] [data-slot="dialog-title"]'
        )?.textContent
      ).toBe("Set up Claude Code?")
    );
    await act(async () =>
      [
        ...document.body.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button'
        )
      ]
        .find((button) => button.textContent === "Cancel")!
        .click()
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Codex: configured");
      expect(container.textContent).toContain("Claude Code: skipped");
    });
    expect(
      invoke.mock.calls.map(([receivedCommand]) => receivedCommand)
    ).not.toContain("setup_claude");
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Finish")!
        .click()
    );
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("offers client-neutral choices without auto-selecting and supports defer", async () => {
    const status = {
      ...statusFixture("healthy"),
      codex: { ...component("not_configured"), configured: false },
      claudeCode: {
        ...component("not_configured"),
        configured: false,
        detected: true
      },
      pi: { ...component("not_configured"), configured: false, detected: true }
    };
    const onComplete = vi.fn();
    const invoke = vi.fn(async (command: string) => {
      if (command === "status") return status;
      return { ok: true };
    });
    window.koedDesktop = {
      invoke: async <T = unknown,>(command: string): Promise<T> =>
        (await invoke(command)) as T,
      setup: {
        inspect: async () => ({
          ...setupFixture("complete"),
          stages: setupFixture().stages.map((stage) => ({
            ...stage,
            state: "complete" as const
          }))
        }),
        run: async () => setupFixture("complete"),
        subscribe: () => () => undefined
      }
    };
    const statusStore = new DesktopStatusStore();
    await act(async () => {
      root.render(
        <SetupChecklist
          onComplete={onComplete}
          showTrustGuide={false}
          statusStore={statusStore}
        />
      );
    });
    await act(async () => Promise.resolve());
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );
    expect(container.textContent).toContain("Connect AI Clients");
    expect(container.querySelectorAll("input[type=checkbox]")).toHaveLength(3);
    expect(
      container.querySelectorAll("input[type=checkbox]:checked")
    ).toHaveLength(0);
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Set up later")!
        .click()
    );
    expect(onComplete).toHaveBeenCalledOnce();
    expect(invoke.mock.calls.some(([command]) => command !== "status")).toBe(
      false
    );
  });

  it("requires separate consent for selected clients and keeps one failure isolated", async () => {
    const status = {
      ...statusFixture("healthy"),
      codex: { ...component("not_configured"), configured: false },
      claudeCode: {
        ...component("not_configured"),
        configured: false,
        detected: true
      },
      pi: { ...component("healthy"), configured: true, detected: true }
    };
    const onComplete = vi.fn();
    const invoke = vi.fn(async (command: string) => {
      if (command === "status") return status;
      if (command === "setup_codex") throw new Error("Codex unavailable");
      return { ok: true };
    });
    window.koedDesktop = {
      invoke: async <T = unknown,>(command: string): Promise<T> =>
        (await invoke(command)) as T,
      setup: {
        inspect: async () => setupFixture("complete"),
        run: async () => setupFixture("complete"),
        subscribe: () => () => undefined
      }
    };
    const statusStore = new DesktopStatusStore();
    await act(async () => {
      root.render(
        <SetupChecklist
          onComplete={onComplete}
          showTrustGuide={false}
          statusStore={statusStore}
        />
      );
    });
    await act(async () => Promise.resolve());
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );
    const checkboxes = [
      ...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")
    ];
    await act(async () => {
      checkboxes[0]!.click();
      checkboxes[1]!.click();
    });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Set up later"
      )?.disabled
    ).toBe(true);
    expect(
      invoke.mock.calls.some(([command]) => command === "setup_codex")
    ).toBe(false);
    await act(async () =>
      document.body
        .querySelector('[role="dialog"] button:last-child')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(
      invoke.mock.calls.some(([command]) => command === "setup_codex")
    ).toBe(true);
    const cancel = document.body.querySelector('[role="dialog"] button');
    await act(async () =>
      cancel?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(onComplete).not.toHaveBeenCalled();
    expect(
      invoke.mock.calls.some(([command]) => command === "setup_claude")
    ).toBe(false);
    const summary = container.querySelector<HTMLUListElement>(
      '[aria-label="AI Client setup results"]'
    );
    expect(summary?.getAttribute("aria-live")).toBe("polite");
    expect(document.activeElement).toBe(summary);
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Finish")!
        .click()
    );
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("records setup as configured without requiring capability check refresh", async () => {
    let configured = false;
    const status = {
      ...statusFixture("healthy"),
      aiClients: {
        codex: clientReadiness("codex", "not_configured")
      }
    };
    const refreshed = {
      ...status,
      aiClients: { codex: clientReadiness("codex", "healthy") }
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === "status") return configured ? refreshed : status;
      if (command === "setup_codex") {
        configured = true;
        return { ok: true };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    window.koedDesktop = {
      invoke: async <T = unknown,>(command: string): Promise<T> =>
        (await invoke(command)) as T,
      setup: {
        inspect: async () => ({
          ...setupFixture("complete"),
          stages: setupFixture().stages.map((stage) => ({
            ...stage,
            state: "complete" as const
          }))
        }),
        run: async () => setupFixture("complete"),
        subscribe: () => () => undefined
      }
    };
    const statusStore = new DesktopStatusStore();
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
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );
    await act(async () =>
      container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click()
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!
        .click()
    );

    expect(invoke.mock.calls.map(([command]) => command)).not.toContain(
      "check_codex"
    );
    expect(container.textContent).toContain("Codex: configured");
    expect(container.textContent).toContain("Automatic capture: Unknown");
  });

  it("keeps healthy client selection strict and records ready", async () => {
    const status = {
      ...statusFixture("healthy"),
      aiClients: { codex: clientReadiness("codex", "healthy") }
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === "status") return status;
      if (command === "check_codex") return { ok: true };
      throw new Error(`Unexpected command: ${command}`);
    });
    window.koedDesktop = {
      invoke: async <T = unknown,>(command: string): Promise<T> =>
        (await invoke(command)) as T,
      setup: {
        inspect: async () => ({
          ...setupFixture("complete"),
          stages: setupFixture().stages.map((stage) => ({
            ...stage,
            state: "complete" as const
          }))
        }),
        run: async () => setupFixture("complete"),
        subscribe: () => () => undefined
      }
    };
    const statusStore = new DesktopStatusStore();
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
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );
    await act(async () =>
      container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click()
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );
    expect(document.body.textContent).toContain("Check integration");
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!
        .click()
    );

    expect(invoke.mock.calls.map(([command]) => command)).toContain(
      "check_codex"
    );
    expect(container.textContent).toContain("Codex: ready");
  });

  it("does not infer configured state when refreshed profile is not healthy", async () => {
    const status = {
      ...statusFixture("healthy"),
      aiClients: { codex: clientReadiness("codex", "not_configured") }
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === "status") return status;
      if (command === "setup_codex") return { ok: true };
      throw new Error(`Unexpected command: ${command}`);
    });
    window.koedDesktop = {
      invoke: async <T = unknown,>(command: string): Promise<T> =>
        (await invoke(command)) as T,
      setup: {
        inspect: async () => ({
          ...setupFixture("complete"),
          stages: setupFixture().stages.map((stage) => ({
            ...stage,
            state: "complete" as const
          }))
        }),
        run: async () => setupFixture("complete"),
        subscribe: () => () => undefined
      }
    };
    const statusStore = new DesktopStatusStore();
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
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );
    await act(async () =>
      container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click()
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!
        .click()
    );

    expect(container.textContent).toContain("Codex: failed");
    expect(container.textContent).toContain(
      "profile was not confirmed healthy"
    );
    expect(invoke.mock.calls.map(([command]) => command)).not.toContain(
      "check_codex"
    );
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
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Set up later")!
        .click()
    );

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

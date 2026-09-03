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
    expect(steps.find(({ id }) => id === "integration")?.description).toBe(
      "Prepare local credential and MCP artifacts."
    );
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

  it("prioritizes starting services before confirmed attention", () => {
    expect(compactHealthSummary(statusFixture("not_configured"))).toEqual({
      label: "Koed is not ready yet",
      state: "waiting"
    });
    const mixed = statusFixture("healthy");
    mixed.database = component("starting");
    mixed.redis = component("needs_attention");
    mixed.workerQueues = component("needs_attention");
    expect(compactHealthSummary(mixed)).toEqual({
      label: "Koed is starting",
      state: "starting"
    });
  });

  it("shows an error only when multiple services need attention", () => {
    const status = statusFixture("healthy");
    status.database = component("needs_attention");
    expect(compactHealthSummary(status)).toEqual({
      label: "1 service needs attention",
      state: "waiting"
    });
    status.redis = component("needs_attention");
    expect(compactHealthSummary(status)).toEqual({
      label: "2 services need attention",
      state: "fault"
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
    expect(container.textContent).toContain("Local models");
    expect(container.querySelector(".koed-setup-clients")).toBeNull();
    expect(
      [...container.querySelectorAll(".koed-setup-step")].find((row) =>
        row.textContent?.includes("Koed core integration")
      )?.textContent
    ).not.toContain("AI Client setup is optional");
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

  it("does not display verification as complete when setup stages are pending", async () => {
    const inconsistent = {
      ...setupFixture(),
      stages: setupFixture().stages.map((stage) =>
        stage.id === "verification"
          ? { ...stage, state: "complete" as const }
          : stage
      )
    };
    window.koedDesktop = {
      invoke: async <T = unknown,>(): Promise<T> =>
        statusFixture("needs_attention") as T,
      setup: {
        inspect: async () => inconsistent,
        run: async () => inconsistent,
        subscribe: () => () => undefined
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

    expect(container.querySelectorAll('[data-state="complete"]')).toHaveLength(
      2
    );
    expect(container.querySelectorAll('[data-state="pending"]')).toHaveLength(
      4
    );
    expect(container.textContent).toContain(
      "Complete the preceding setup steps before final verification."
    );
    expect(container.textContent).toContain("Ready to set up");
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

  it("shows only a spinner without resizing the primary action during AI Client setup", async () => {
    let configured = false;
    let resolveSetup!: () => void;
    const setupPending = new Promise<void>((resolve) => {
      resolveSetup = resolve;
    });
    const invoke = vi.fn(async (command: string) => {
      if (command === "status") {
        return statusWithClientProfiles({
          codex: configured ? "healthy" : "not_configured",
          claude: "not_configured",
          pi: "not_configured"
        });
      }
      if (command === "setup_codex") {
        await setupPending;
        configured = true;
        return { ok: true };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    window.koedDesktop = {
      invoke: async <T = unknown,>(command: string): Promise<T> =>
        (await invoke(command)) as T,
      setup: {
        inspect: async () => completeSetupFixture(),
        run: async () => completeSetupFixture(),
        subscribe: () => () => undefined
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
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Continue"
        )
      ).toBeTruthy()
    );
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click();
    });
    await act(async () => {
      container
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".koed-client-primary-action")!
        .click();
    });

    await vi.waitFor(() => {
      const action = container.querySelector<HTMLButtonElement>(
        '.koed-client-primary-action[aria-label="Setting up AI Client"]'
      );
      expect(action?.textContent?.trim()).toBe("");
      expect(action?.querySelector("svg")).toBeTruthy();
      expect(action?.classList.contains("koed-client-primary-action")).toBe(
        true
      );
    });

    resolveSetup();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Codex: configured")
    );
  });

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
    expect(container.textContent).toContain(
      "Continue allows Koed to change only its own integration block and package for Codex, Claude Code, and Pi. Existing profile settings, credentials, and other AI Clients remain untouched."
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );

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
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Continue"
      )?.disabled
    ).toBe(true);
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

  it("shows static capability support before client setup", async () => {
    const status = statusWithClientProfiles({
      codex: "not_configured",
      claude: "not_configured",
      pi: "not_configured"
    });
    const codex = status.aiClients!.codex!;
    codex.capabilities = [
      "automatic_capture",
      "managed_conversation_start",
      "mcp_recall",
      "local_synthesis",
      "automatic_capture",
      "mcp_recall",
      "local_synthesis"
    ].map((id) => ({
      id: id as (typeof codex.capabilities)[number]["id"],
      support: "supported" as const,
      readiness: "unknown" as const,
      diagnostics: []
    }));
    const onComplete = vi.fn();
    window.koedDesktop = {
      invoke: async <T = unknown,>(command: string): Promise<T> =>
        (command === "status" ? status : { ok: true }) as T,
      setup: {
        inspect: async () => completeSetupFixture(),
        run: async () => completeSetupFixture(),
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
    const codexCard = container.querySelectorAll(".koed-client-card")[0]!;
    expect(codexCard.textContent).not.toContain("Managed Conversation");
    expect(codexCard.querySelectorAll(".koed-client-cap")).toHaveLength(3);
    expect(
      codexCard
        .querySelector('[aria-label="Auto-capture"]')
        ?.getAttribute("title")
    ).toBe("Auto-capture");
    expect(codexCard.querySelectorAll(".koed-client-cap-dot")).toHaveLength(0);
    expect(
      container.querySelector('[aria-label="Capability status legend"]')
    ).toBeNull();
  });

  it("shows capability readiness after a client is configured", async () => {
    const status = statusWithClientProfiles({
      codex: "healthy",
      claude: "not_configured",
      pi: "not_configured"
    });
    status.aiClients!.codex!.capabilities = [
      {
        id: "automatic_capture",
        support: "supported",
        readiness: "unknown",
        diagnostics: []
      },
      {
        id: "mcp_recall",
        support: "unsupported",
        readiness: "unknown",
        diagnostics: []
      }
    ];
    window.koedDesktop = {
      invoke: async <T = unknown,>(command: string): Promise<T> =>
        (command === "status" ? status : { ok: true }) as T,
      setup: {
        inspect: async () => completeSetupFixture(),
        run: async () => completeSetupFixture(),
        subscribe: () => () => undefined
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
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue")!
        .click()
    );

    const codexCard = container.querySelectorAll(".koed-client-card")[0]!;
    expect(
      codexCard.querySelector(
        '[aria-label="Auto-capture: Unknown"] .is-unknown'
      )
    ).toBeTruthy();
    expect(
      codexCard.querySelector(
        '[aria-label="MCP Recall: Unsupported"] .is-unsupported'
      )
    ).toBeTruthy();
    expect(
      container.querySelector('[aria-label="Capability status legend"]')
        ?.textContent
    ).toBe("ReadyNeeds attentionUnknownUnsupported");
  });

  it("keeps one client's failure isolated from the rest of the queue", async () => {
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
        inspect: async () => completeSetupFixture(),
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
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Codex:");
      expect(container.textContent).toContain("Claude Code:");
    });
    expect(
      invoke.mock.calls.some(([command]) => command === "setup_codex")
    ).toBe(true);
    expect(
      invoke.mock.calls.some(([command]) => command === "setup_claude")
    ).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();
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
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Codex: configured")
    );

    expect(invoke.mock.calls.map(([command]) => command)).not.toContain(
      "check_codex"
    );
    expect(container.textContent).toContain("Auto-capture");
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
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Codex: ready")
    );

    expect(invoke.mock.calls.map(([command]) => command)).toContain(
      "check_codex"
    );
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
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Codex: failed")
    );
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

// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSetupSnapshot, KoedServerStatus } from "../../types.js";
import { DesktopStatusStore } from "../services/desktop-commands.js";
import { V1Onboarding } from "./onboarding.js";
import { DEFAULT_AGENT_LOOK } from "./visual.js";
import { stageIds } from "./onboarding/model.js";

vi.mock("./onboarding/LoadingKin.js", () => ({
  LoadingKin: (props: { sad: boolean }) => (
    <span data-testid="kin" data-sad={props.sad} />
  )
}));
vi.mock("./onboarding/OnboardingConfetti.js", () => ({
  OnboardingConfetti: () => <span data-testid="confetti" />
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function setupSnapshot(
  state: DesktopSetupSnapshot["state"] = "complete",
  runId = "inspect"
): DesktopSetupSnapshot {
  return {
    state,
    runId,
    sequence: 1,
    activeStage: null,
    error: null,
    stages: stageIds.map((id) => ({
      id,
      state: state === "complete" ? "complete" : "pending",
      message: "Needs setup",
      completedBytes: null,
      totalBytes: null
    }))
  };
}
function serverStatus(
  installed = ["codex", "claude", "pi"],
  ready: string[] = []
): KoedServerStatus {
  return {
    ok: true,
    generatedAt: "2026-11-02T12:00:00Z",
    api: { state: "healthy", url: "http://local" },
    lifecycle: { state: "running", message: "Running" },
    codex: { configured: ready.includes("codex") },
    claudeCode: { configured: ready.includes("claude") },
    pi: { configured: ready.includes("pi") },
    aiClients: Object.fromEntries(
      ["codex", "claude", "pi"].map((id) => [
        id,
        {
          installed: {
            state: installed.includes(id) ? "healthy" : "not_configured"
          },
          version: installed.includes(id) ? "1.2.3" : null,
          profile: { state: ready.includes(id) ? "healthy" : "not_configured" },
          authentication: ready.includes(id) ? "authenticated" : "unknown",
          capabilities: [],
          snapshotState: "current"
        }
      ])
    )
  } as unknown as KoedServerStatus;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("prototype onboarding", () => {
  let container: HTMLDivElement;
  let root: Root;
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  async function render(
    options: {
      snapshot?: DesktopSetupSnapshot;
      status?: KoedServerStatus;
      draft?: unknown;
      savedName?: string;
      strict?: boolean;
      inspect?: () => Promise<DesktopSetupSnapshot>;
    } = {}
  ) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let currentStatus = options.status ?? serverStatus();
    const listeners = new Set<(s: DesktopSetupSnapshot) => void>();
    const setup = {
      inspect: vi.fn(
        options.inspect ?? (async () => options.snapshot ?? setupSnapshot())
      ),
      run: vi.fn(async () => {
        const done = { ...setupSnapshot("complete", "run"), sequence: 10 };
        for (const listener of listeners) listener(done);
        return done;
      }),
      subscribe: vi.fn((listener: (s: DesktopSetupSnapshot) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      })
    };
    const invoke = vi.fn(async (command: string): Promise<unknown> => {
      if (command === "status") return currentStatus;
      const id = command.split("_")[1]!;
      currentStatus = {
        ...currentStatus,
        aiClients: {
          ...currentStatus.aiClients,
          [id]: {
            ...currentStatus.aiClients![id]!,
            profile: { state: "healthy" },
            authentication: "authenticated"
          }
        }
      };
      return { ok: true };
    });
    const themeSet = vi.fn(async (preference: string) => ({
      resolvedDark: preference === "dark"
    }));
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: {
        setup,
        invoke,
        theme: { get: async () => "light", set: themeSet }
      }
    });
    const statusStore = new DesktopStatusStore();
    const saveAgent = vi.fn(async () => {});
    const saveDraft = vi.fn(async () => {});
    const complete = vi.fn(async () => {});
    const view = (
      <V1Onboarding
        statusStore={statusStore}
        savedAgent={{ name: options.savedName ?? "", look: DEFAULT_AGENT_LOOK }}
        savedDraft={options.draft}
        onSaveAgent={saveAgent}
        onSaveDraft={saveDraft}
        onComplete={complete}
      />
    );
    await act(async () =>
      root.render(options.strict ? <StrictMode>{view}</StrictMode> : view)
    );
    const click = async (text: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (b) =>
          b.textContent?.trim() === text ||
          b.getAttribute("aria-label") === text
      );
      expect(button, text).toBeTruthy();
      await act(async () => button!.click());
    };
    const emit = async (snapshot: DesktopSetupSnapshot) => {
      await act(async () => {
        for (const listener of listeners) listener(snapshot);
      });
    };
    return {
      setup,
      invoke,
      statusStore,
      click,
      emit,
      saveAgent,
      saveDraft,
      complete,
      themeSet,
      listeners,
      setStatus: (next: KoedServerStatus) => {
        currentStatus = next;
      }
    };
  }
  const text = () => container.textContent ?? "";
  const progress = () =>
    container
      .querySelector('[role="progressbar"]')
      ?.getAttribute("aria-valuenow");

  it("starts directly at live setup without the maker or chat and requires consent", async () => {
    const { click, setup, invoke } = await render({
      snapshot: setupSnapshot("ready"),
      strict: true
    });
    expect(text()).toBe("Get Started");
    expect(container.querySelector("h1, [role=progressbar]")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(setup.run).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    await click("Get Started");
    expect(setup.run).toHaveBeenCalledOnce();
    expect(text()).toContain("Your Koed is ready.");
    expect(progress()).toBe("100");
  });
  it("shows already prepared setup without reinstalling", async () => {
    const { setup } = await render();
    expect(text()).toContain("Your Koed is ready.");
    expect(setup.run).not.toHaveBeenCalled();
  });
  it("uses byte progress and ignores out-of-order and retired run events", async () => {
    const { emit } = await render({ snapshot: setupSnapshot("ready") });
    const running = setupSnapshot("running", "active");
    running.sequence = 5;
    running.activeStage = "model";
    running.stages[0]!.state = "complete";
    running.stages[1]!.state = "complete";
    Object.assign(running.stages[2]!, {
      state: "running",
      completedBytes: 50 * 1_048_576,
      totalBytes: 100 * 1_048_576
    });
    await emit(running);
    expect(progress()).toBe("41");
    const transform = container.querySelector<HTMLElement>(
      "[role=progressbar] i"
    )!.style.transform;
    expect(Number(transform.slice(7, -1))).toBeCloseTo(2.5 / 6, 6);
    expect(text()).toContain("50 MB of 100 MB");
    await emit({ ...running, sequence: 4, stages: [] });
    expect(progress()).toBe("41");
    await emit(setupSnapshot());
    expect(progress()).toBe("41");
  });
  it("does not count stale verification as readiness or full progress", async () => {
    const snapshot = setupSnapshot();
    snapshot.stages[2]!.state = "pending";
    await render({ snapshot });
    expect(progress()).not.toBe("100");
    expect(text()).not.toContain("Your Koed is ready.");
  });
  it("does not let a late inspection overwrite live run progress", async () => {
    const inspection = deferred<DesktopSetupSnapshot>();
    const { emit } = await render({ inspect: () => inspection.promise });
    const running = setupSnapshot("running", "new-run");
    running.sequence = 3;
    await emit(running);
    await act(async () => inspection.resolve(setupSnapshot()));
    expect(progress()).toBe("0");
    expect(text()).not.toContain("Your Koed is ready.");
  });
  it.each(["complete", "ready", "failed"] as const)(
    "observes a reopened setup until it becomes %s without progress events",
    async (state) => {
      vi.useFakeTimers();
      const running = setupSnapshot("running", "existing-run");
      running.activeStage = "model";
      const { setup } = await render({ snapshot: running });
      const terminal = {
        ...setupSnapshot(state),
        error: state === "failed" ? "Setup was interrupted." : null
      };
      setup.inspect
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(terminal);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(setup.inspect).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(text()).toContain(
        state === "complete"
          ? "Your Koed is ready."
          : state === "failed"
            ? "Retry step"
            : "Get Started"
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(setup.inspect).toHaveBeenCalledTimes(3);
      expect(setup.run).not.toHaveBeenCalled();
    }
  );
  it("stops observing a reopened setup after an inspection failure or unmount", async () => {
    vi.useFakeTimers();
    const { setup, click } = await render({
      snapshot: setupSnapshot("running")
    });
    setup.inspect.mockRejectedValueOnce(new Error("Inspection disconnected"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(text()).toContain("Check again");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(setup.inspect).toHaveBeenCalledTimes(2);
    setup.inspect.mockResolvedValueOnce(setupSnapshot("running", "resumed"));
    await click("Check again");
    expect(setup.inspect).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
    root = undefined as unknown as Root;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(setup.inspect).toHaveBeenCalledTimes(3);
  });
  it("recovers inspection failure without treating clients as absent", async () => {
    const { setup, click } = await render({
      inspect: async () => {
        throw new Error("Transient inspection failure");
      }
    });
    expect(text()).toContain("Transient inspection failure");
    setup.inspect.mockResolvedValueOnce(setupSnapshot());
    await click("Check again");
    expect(text()).toContain("Your Koed is ready.");
  });
  it("shows real setup failure and suppresses it while retry is pending", async () => {
    const failed = setupSnapshot("failed");
    failed.error = "Checksum failed";
    failed.activeStage = "model";
    const { setup, click, emit } = await render({ snapshot: failed });
    expect(text()).toContain("Checksum failed");
    expect(container.querySelector('[data-sad="true"]')).toBeTruthy();
    const retry = deferred<DesktopSetupSnapshot>();
    setup.run.mockImplementationOnce(() => retry.promise);
    await click("Retry step");
    expect(text()).not.toContain("Checksum failed");
    await emit({ ...setupSnapshot("complete", "retry"), sequence: 10 });
    await act(async () =>
      retry.resolve({ ...setupSnapshot("complete", "retry"), sequence: 10 })
    );
    expect(progress()).toBe("100");
  });
  it("cleans subscriptions on unmount including Strict Mode", async () => {
    const { listeners } = await render({ strict: true });
    expect(listeners.size).toBe(1);
    await act(async () => root.unmount());
    root = undefined as unknown as Root;
    expect(listeners.size).toBe(0);
  });
  it("detects actual clients, versions and configures only the selected client", async () => {
    const { click, invoke } = await render({ status: serverStatus(["codex"]) });
    await click("Next");
    expect(text()).toContain("v1.2.3");
    expect(text()).toContain("Not found on this device");
    expect(
      (
        container.querySelector(
          '[aria-label="Enable Codex"]'
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["status"]);
    await click("Connect");
    expect(
      invoke.mock.calls.filter(([command]) => command !== "status")
    ).toEqual([["setup_codex", { operatorConsented: true }]]);
    expect(text()).toContain("Continue");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "status",
      "setup_codex",
      "status"
    ]);
  });
  it("preserves an explicit deselection on rescan", async () => {
    const { click } = await render();
    await click("Next");
    await act(async () =>
      (
        container.querySelector(
          '[aria-label="Enable Claude Code"]'
        ) as HTMLInputElement
      ).click()
    );
    await click("Scan again");
    expect(
      (
        container.querySelector(
          '[aria-label="Enable Claude Code"]'
        ) as HTMLInputElement
      ).checked
    ).toBe(false);
  });
  it("lets a freshly detected install connect before capability discovery", async () => {
    const status = serverStatus(["claude"]);
    status.aiClients!.claude!.snapshotState = "unknown";
    const { click, invoke } = await render({ status });
    await click("Next");
    const checkbox = container.querySelector(
      '[aria-label="Enable Claude Code"]'
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(true);
    await click("Connect");
    expect(invoke.mock.calls.map(([command]) => command)).toContain(
      "setup_claude"
    );
    // Installation evidence must not make unknown capabilities ready.
    expect(text()).not.toContain("Continue");
  });
  it("uses the status returned by a client check without another scan", async () => {
    const ready = serverStatus(["codex"], ["codex"]);
    const { click, invoke } = await render({ status: ready });
    await click("Next");
    invoke.mockResolvedValueOnce({ ok: true, status: ready });
    await click("Connect");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "status",
      "check_codex"
    ]);
    expect(text()).toContain("Continue");
  });
  it("does not continue on cached readiness when the operation status refresh fails", async () => {
    const { click, invoke } = await render({
      status: serverStatus(["codex"], ["codex"])
    });
    await click("Next");
    invoke
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("Status unavailable"));
    await click("Connect");
    expect(text()).not.toContain("Continue");
    expect(text()).toContain("Status unavailable");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "status",
      "check_codex",
      "status"
    ]);
  });
  it("provides recovery when no clients are installed", async () => {
    const { click } = await render({ status: serverStatus([]) });
    await click("Next");
    expect(text()).toContain("No AI Clients found.");
    expect(
      (container.querySelector(".lp-connect-button") as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
  it("does not present a failed scan as no clients installed", async () => {
    const { invoke, click } = await render();
    invoke.mockRejectedValueOnce(new Error("Scan unavailable"));
    await click("Next");
    expect(text()).toContain("Scan unavailable");
    expect(text()).toContain("Availability unknown");
    expect(text()).not.toContain("No AI Clients found.");
  });
  it("does not invent absence when a successful scan lacks observations", async () => {
    const status = serverStatus();
    delete status.aiClients;
    const { click } = await render({ status });
    await click("Next");
    expect(text()).toContain("Availability unknown");
    expect(text()).not.toContain("No AI Clients found.");
  });
  it("runs selected clients in order, permits partial success, and retries only failures", async () => {
    const { invoke, click } = await render();
    const original = invoke.getMockImplementation()!;
    let failClaude = true;
    invoke.mockImplementation(async (command) => {
      if (command === "setup_claude" && failClaude) {
        failClaude = false;
        throw new Error("Claude connection failed");
      }
      return original(command);
    });
    await click("Next");
    await click("Connect");
    expect(
      invoke.mock.calls
        .filter(([cmd]) => cmd.startsWith("setup_"))
        .map(([cmd]) => cmd)
    ).toEqual(["setup_codex", "setup_claude", "setup_pi"]);
    expect(text()).toContain("Some introductions need another try.");
    expect(text()).toContain("Claude connection failed");
    const failedCard = container.querySelector('[data-provider="claude"]')!;
    expect(failedCard.querySelector("small")?.textContent).toBe(
      "Couldn’t connect. Try again."
    );
    const details = failedCard.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Details");
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    expect(details.querySelector("p")?.textContent).toBe(
      "Claude connection failed"
    );
    await click("Retry failed");
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "setup_codex")
    ).toHaveLength(1);
    expect(text()).toContain("Everyone’s connected.");
  });
  it("blocks full failure and preserves an actionable command error", async () => {
    const { invoke, click } = await render();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command) =>
      command === "status"
        ? original(command)
        : { ok: false, message: "Integration rejected" }
    );
    await click("Next");
    await click("Connect");
    expect(text()).toContain("Integration rejected");
    expect(text()).not.toContain("Continue");
    expect(text()).toContain("Retry connections");
  });
  it("shows sign-in guidance when authentication makes the profile need attention", async () => {
    const status = serverStatus(["claude"], ["claude"]);
    status.aiClients!.claude!.authentication = "unauthenticated";
    status.aiClients!.claude!.profile.state = "needs_attention";
    const { invoke, click } = await render({ status });
    invoke.mockImplementation(async (command) =>
      command === "status" ? status : { ok: true }
    );
    await click("Next");
    await click("Connect");
    expect(text()).toContain("claude auth login");
    expect(text()).not.toContain("The Koed profile is not confirmed ready");
    expect(text()).not.toContain("Continue");
  });
  it.each(["unauthenticated", "unknown"] as const)(
    "does not call a configured client ready when authentication is %s",
    async (authentication) => {
      const status = serverStatus(["claude"], ["claude"]);
      status.aiClients!.claude!.authentication = authentication;
      const { invoke, click, setStatus } = await render({ status });
      const original = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (command) =>
        command === "status" ? original(command) : { ok: true }
      );
      await click("Next");
      await click("Connect");
      expect(text()).toContain(
        authentication === "unauthenticated"
          ? "claude auth login"
          : "claude auth status"
      );
      expect(text()).not.toContain("Continue");
      setStatus(serverStatus(["claude"], ["claude"]));
      await click("Retry connections");
      expect(text()).toContain("Continue");
      expect(
        invoke.mock.calls
          .filter(([cmd]) => cmd !== "status")
          .map(([cmd]) => cmd)
      ).toEqual(["check_claude", "check_claude"]);
    }
  );
  it("blocks stale or stopped runtime readiness", async () => {
    const { click, setStatus, statusStore } = await render({
      status: serverStatus(["codex"])
    });
    await click("Next");
    await click("Connect");
    const stopped = serverStatus(["codex"], ["codex"]);
    stopped.lifecycle = { state: "stopped", message: "Stopped" };
    setStatus(stopped);
    await act(async () => {
      await statusStore.refresh();
    });
    expect(text()).not.toContain("Continue");
    expect(text()).toContain("Retry connections");
  });
  it("migrates legacy drafts without replaying chat and preserves saved identity", async () => {
    const { click, saveAgent, saveDraft, complete } = await render({
      savedName: "Mika",
      draft: {
        step: "memory",
        agent: { name: "Old", look: DEFAULT_AGENT_LOOK },
        composerText: "old chat"
      }
    });
    expect(text()).not.toContain("old chat");
    await click("Next");
    await click("Connect");
    await click("Continue");
    await click("Let’s go");
    expect(saveAgent).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(saveDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: 2, step: "complete" })
    );
  });
  it("saves a valid default agent and retries failed completion", async () => {
    const { click, saveAgent, complete } = await render();
    await click("Next");
    await click("Connect");
    await click("Continue");
    complete.mockRejectedValueOnce(new Error("Completion could not be saved"));
    await click("Let’s go");
    expect(text()).toContain("Completion could not be saved");
    await click("Let’s go");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(saveAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Koed" })
    );
  });
  it("starts final setup and client checks together", async () => {
    const { click, setup, invoke, complete } = await render();
    await click("Next");
    await click("Connect");
    await click("Continue");
    const inspection = deferred<DesktopSetupSnapshot>();
    setup.inspect.mockImplementationOnce(() => inspection.promise);
    invoke.mockClear();
    await click("Let’s go");
    expect(invoke).toHaveBeenCalledWith("status", undefined);
    expect(complete).not.toHaveBeenCalled();
    await act(async () => inspection.resolve(setupSnapshot()));
    expect(complete).toHaveBeenCalledOnce();
  });
  it("revalidates setup and clients at the Let’s go boundary", async () => {
    const { click, setStatus, complete } = await render();
    await click("Next");
    await click("Connect");
    await click("Continue");
    setStatus(serverStatus());
    await click("Let’s go");
    expect(complete).not.toHaveBeenCalled();
    expect(text()).toContain("Connect at least one ready, signed-in AI Client");
  });
  it("resumes a new draft with selection but fresh client checks", async () => {
    const { click } = await render({
      draft: {
        version: 2,
        step: "complete",
        selected: ["pi"],
        selectionInitialized: true
      }
    });
    expect(text()).toContain("Connect your AI Clients.");
    expect(text()).not.toContain("You’re all set.");
    expect(
      (
        container.querySelector(
          '[aria-label="Enable Codex"]'
        ) as HTMLInputElement
      ).checked
    ).toBe(false);
    await click("Connect");
    expect(text()).toContain("Continue");
  });
  it("leaves theme preferences unchanged and offers no onboarding toggle", async () => {
    const { themeSet } = await render();
    expect(container.querySelector('[aria-label="Color theme"]')).toBeNull();
    expect(themeSet).not.toHaveBeenCalled();
  });
  it("retries saving the completion draft before permitting Let’s go", async () => {
    const { click, saveDraft, complete } = await render();
    await click("Next");
    await click("Connect");
    saveDraft.mockRejectedValueOnce(new Error("Disk temporarily unavailable"));
    await click("Continue");
    expect(text()).toContain("Disk temporarily unavailable");
    await click("Let’s go");
    expect(complete).not.toHaveBeenCalled();
    await click("Retry saving progress");
    await click("Let’s go");
    expect(complete).toHaveBeenCalledOnce();
  });
  it("retains legacy draft customization in the new resumable draft", async () => {
    const { saveDraft } = await render({
      draft: {
        step: "maker",
        agent: { name: "Mika", look: DEFAULT_AGENT_LOOK }
      }
    });
    expect(saveDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({
        version: 2,
        agent: expect.objectContaining({ name: "Mika" })
      })
    );
  });
  it("blocks Let’s go when local setup changed after connection", async () => {
    const { click, setup, complete } = await render();
    await click("Next");
    await click("Connect");
    await click("Continue");
    setup.inspect.mockResolvedValueOnce(setupSnapshot("ready", "changed"));
    await click("Let’s go");
    expect(complete).not.toHaveBeenCalled();
    expect(text()).toContain("Local setup needs another check");
    expect(text()).toContain("Get Started");
  });
  it("does not allow double connection or completion while an operation is pending", async () => {
    const { click, invoke, complete } = await render({
      status: serverStatus(["codex"])
    });
    await click("Next");
    const original = invoke.getMockImplementation()!;
    const pending = deferred<{ ok: boolean }>();
    invoke.mockImplementationOnce(() => pending.promise);
    await click("Connect");
    expect(text()).not.toContain("Continue");
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "setup_codex")
    ).toHaveLength(1);
    await act(async () => {
      await original("setup_codex");
      pending.resolve({ ok: true });
    });
    await click("Continue");
    const finishing = deferred<void>();
    complete.mockImplementationOnce(() => finishing.promise);
    await click("Let’s go");
    expect(text()).toContain("Opening Koed…");
    expect(complete).toHaveBeenCalledOnce();
    await act(async () => finishing.resolve());
  });
  it("allows a starting runtime with a healthy API and fresh authenticated profile", async () => {
    const status = serverStatus(["codex"], ["codex"]);
    status.lifecycle = { state: "starting", message: "Starting" };
    const { click } = await render({ status });
    await click("Next");
    await click("Connect");
    expect(text()).toContain("Continue");
  });
  it("recovers a rejected setup run instead of remaining stuck in progress", async () => {
    const { click, setup, emit } = await render({
      snapshot: setupSnapshot("ready")
    });
    const run = deferred<DesktopSetupSnapshot>();
    setup.run.mockImplementationOnce(() => run.promise);
    await click("Get Started");
    await emit({ ...setupSnapshot("running", "run"), sequence: 2 });
    await act(async () => run.reject(new Error("Setup bridge disconnected")));
    expect(text()).toContain("Setup bridge disconnected");
    expect(text()).toContain("Check again");
    setup.inspect.mockResolvedValueOnce(setupSnapshot("ready", "recovered"));
    await click("Check again");
    expect(text()).toContain("Get Started");
  });
  it("does not let an inspection error preserve an old ready screen", async () => {
    const { click, setup, complete } = await render();
    await click("Next");
    await click("Connect");
    await click("Continue");
    setup.inspect.mockRejectedValueOnce(new Error("Inspection unavailable"));
    await click("Let’s go");
    expect(complete).not.toHaveBeenCalled();
    expect(text()).toContain("Check again");
    expect(text()).not.toContain("Your Koed is ready.");
  });
});

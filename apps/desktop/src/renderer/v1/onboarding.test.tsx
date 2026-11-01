// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSetupSnapshot } from "../../types.js";
import type { DesktopStatusStore } from "../services/desktop-commands.js";
import { V1Onboarding, type OnboardingDraft } from "./onboarding.js";
import { DEFAULT_AGENT_LOOK } from "./visual.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const completeStages: DesktopSetupSnapshot["stages"] = [
  "package",
  "runtime",
  "model",
  "services",
  "integration",
  "verification"
].map((id) => ({
  id: id as DesktopSetupSnapshot["stages"][number]["id"],
  state: "complete",
  message: "Done",
  completedBytes: null,
  totalBytes: null
}));
const readySetup: DesktopSetupSnapshot = {
  activeStage: null,
  error: null,
  runId: "r1",
  sequence: 1,
  stages: completeStages,
  state: "complete"
};

describe("V1Onboarding", () => {
  let container: HTMLDivElement;
  let root: Root;
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });
  async function render(
    onSaveAgent = vi.fn(),
    onComplete = vi.fn(),
    setupSnapshot: DesktopSetupSnapshot | Error = readySetup,
    initialStatus: unknown = null,
    savedDraft: OnboardingDraft | null = null,
    onMemoryDemo?: (
      text: string
    ) => Promise<{ message: string; evidence?: string }>
  ) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const setup = {
      inspect: vi.fn(async () => {
        if (setupSnapshot instanceof Error) throw setupSnapshot;
        return setupSnapshot;
      }),
      run: vi.fn(async () => readySetup),
      subscribe: vi.fn(() => () => {})
    };
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: { setup }
    });
    const snapshot = {
      status: initialStatus,
      busyCommand: null,
      error: null,
      revision: 0
    };
    const statusStore = {
      current: () => snapshot,
      subscribe: () => () => {},
      refresh: vi.fn(async () => null),
      run: vi.fn(async () => ({ ok: true }))
    } as unknown as DesktopStatusStore;
    await act(async () =>
      root.render(
        <V1Onboarding
          onSaveAgent={onSaveAgent}
          onComplete={onComplete}
          statusStore={statusStore}
          savedDraft={savedDraft}
          onMemoryDemo={onMemoryDemo}
        />
      )
    );
    const click = async (text: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === text
      );
      expect(button, text).toBeTruthy();
      await act(async () => button!.click());
    };
    const send = async (text: string) => {
      const textarea = container.querySelector(
        ".v1-ob-dock textarea"
      ) as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      await act(async () => {
        setter?.call(textarea, text);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const button = container.querySelector(
        ".v1-ob-dock button[aria-label='Send']"
      ) as HTMLButtonElement;
      await act(async () => button.click());
    };
    return { click, send, setup, statusStore };
  }
  it("saves the agent before revealing setup and retains the completed card", async () => {
    const save = vi.fn(async () => {});
    const { click } = await render(save);
    await click("Mika");
    await click("That’s me");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Mika" })
    );
    expect(container.textContent).toContain(
      "Change my name or look any time in Settings."
    );
    expect(container.textContent).toContain("Koed is ready on this Mac");
  });
  it("requires explicit consent before running local setup", async () => {
    const pending: DesktopSetupSnapshot = {
      ...readySetup,
      state: "ready",
      stages: readySetup.stages.map((s) => ({ ...s, state: "pending" }))
    };
    const { click, setup } = await render(vi.fn(), vi.fn(), pending);
    await click("Juno");
    await click("That’s me");
    expect(setup.run).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".v1-ob-stage")).toHaveLength(0);
    await click("Set up Koed");
    expect(setup.run).not.toHaveBeenCalled();
    const confirm = container.querySelector(
      "[role='dialog'] button.v1-ob-primary"
    ) as HTMLButtonElement;
    expect(confirm).toBeTruthy();
    await act(async () => confirm.click());
    expect(setup.run).toHaveBeenCalledOnce();
  });
  it("keeps AI choices and the memory comparison in the transcript", async () => {
    const { click } = await render();
    await click("Pip");
    await click("That’s me");
    expect(container.textContent).toContain("I’ll call you Pip.");
    await click("Let’s go");
    expect(container.textContent).toContain("I’ll add them myself");
    await click("I’ll add them myself");
    expect(container.querySelectorAll(".v1-ob-client")).toHaveLength(3);
    await click("Next: memory");
    expect(container.querySelectorAll(".v1-ob-client")).toHaveLength(3);
    expect(container.querySelectorAll(".v1-ob-compare")).toHaveLength(1);
    expect(container.textContent).toContain("Keep answers short");
    expect(container.textContent).toContain("I build in Rust and Next.js");
  });
  it("requires consent for the chosen AI Client and leaves other clients untouched", async () => {
    const { click, statusStore } = await render();
    await click("Atlas");
    await click("That’s me");
    await click("Let’s go");
    await click("I’ll add them myself");
    const connect = container.querySelector(
      ".v1-ob-client button"
    ) as HTMLButtonElement;
    await act(async () => connect.click());
    expect(statusStore.run).not.toHaveBeenCalled();
    expect(container.querySelector("[role='dialog']")?.textContent).toContain(
      "Claude Code"
    );
    const confirm = container.querySelector(
      "[role='dialog'] button.v1-ob-primary"
    ) as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(statusStore.run).toHaveBeenCalledWith("setup_claude", {
      operatorConsented: true
    });
    expect(statusStore.run).toHaveBeenCalledTimes(1);
  });
  it("retries setup inspection after a transient failure", async () => {
    const { click, setup } = await render(
      vi.fn(),
      vi.fn(),
      new Error("Local status unavailable")
    );
    await click("Juno");
    await click("That’s me");
    expect(container.textContent).toContain("Local status unavailable");
    setup.inspect.mockResolvedValueOnce(readySetup);
    await click("Check again");
    expect(setup.inspect).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Koed is ready on this Mac");
  });
  it("shows provider-specific sign-in guidance and offers a check", async () => {
    const status = {
      aiClients: {
        claude: {
          installed: { state: "healthy" },
          profile: { state: "healthy" },
          authentication: "unauthenticated",
          capabilities: [],
          version: "1"
        }
      }
    };
    const { click } = await render(vi.fn(), vi.fn(), readySetup, status);
    await click("Pip");
    await click("That’s me");
    await click("Let’s go");
    await click("I’ll add them myself");
    expect(container.textContent).toContain("claude auth login");
    expect(container.textContent).toContain(
      "Claude Desktop sign-in does not authenticate Claude Code"
    );
    expect(container.querySelector(".v1-ob-client button")?.textContent).toBe(
      "Check again"
    );
  });
  it("refuses Skip setup until a ready authenticated AI Client exists", async () => {
    const { click } = await render();
    await click("Atlas");
    await click("That’s me");
    await click("Skip setup");
    expect(container.textContent).toContain(
      "I need at least one ready AI Client"
    );
    expect(container.textContent).not.toContain("You’re set.");
  });
  it("restores completed user actions and Koed explanation from a draft", async () => {
    const draft: OnboardingDraft = {
      agent: { name: "Pip", look: DEFAULT_AGENT_LOOK },
      step: "memory",
      introWhat: true,
      whatQuestion: "What is Koed?",
      aiMode: "manual",
      aiActions: ["Look for them", "I’ll add them myself"],
      skippedFrom: null,
      composerText: "A saved draft",
      submittedNote: "Keep answers short",
      guidanceTurns: [],
      scanned: true,
      clientResults: {},
      note: "",
      demoResult: null
    };
    await render(vi.fn(), vi.fn(), readySetup, null, draft);
    expect(container.textContent).toContain("I’ll call you Pip.");
    expect(container.textContent).toContain("What is Koed?");
    expect(container.textContent).toContain(
      "Koed is where you work with your agent"
    );
    expect(container.querySelectorAll(".v1-ob-user")).toHaveLength(5);
    expect(
      (container.querySelector(".v1-ob-dock textarea") as HTMLTextAreaElement)
        .value
    ).toBe("A saved draft");
  });
  it("allows Skip after a ready AI without claiming unfinished local setup is ready", async () => {
    const pending: DesktopSetupSnapshot = {
      ...readySetup,
      state: "ready",
      stages: readySetup.stages.map((stage) => ({ ...stage, state: "pending" }))
    };
    const status = {
      aiClients: {
        claude: {
          profile: { state: "healthy" },
          authentication: "authenticated"
        }
      }
    };
    const { click } = await render(vi.fn(), vi.fn(), pending, status);
    await click("Juno");
    await click("That’s me");
    await click("Skip setup");
    expect(container.textContent).toContain("You’re set.");
    expect(container.textContent).toContain("Setup is not complete");
    expect(
      container.querySelector(".v1-ob-summary")?.textContent
    ).not.toContain("This MacReady");
  });
  it("routes composer name and What is Koed without AI execution", async () => {
    const save = vi.fn(async () => {});
    const { send, statusStore } = await render(save);
    await send("Call yourself Mika");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Mika" })
    );
    await send("What is Koed?");
    expect(container.textContent).toContain(
      "Koed is where you work with your agent"
    );
    expect(statusStore.run).not.toHaveBeenCalled();
  });
  it("routes memory free text to the real callback and keeps its user bubble", async () => {
    const demo = vi.fn(async (text: string) => ({
      message: "Your note is saved.",
      evidence: text
    }));
    const draft: OnboardingDraft = {
      agent: { name: "Pip", look: DEFAULT_AGENT_LOOK },
      step: "memory",
      introWhat: false,
      whatQuestion: null,
      aiMode: "manual",
      aiActions: [],
      skippedFrom: null,
      composerText: "",
      submittedNote: null,
      guidanceTurns: [],
      scanned: false,
      clientResults: {},
      note: "",
      demoResult: null
    };
    const { send } = await render(
      vi.fn(),
      vi.fn(),
      readySetup,
      null,
      draft,
      demo
    );
    await send("Keep answers short");
    expect(demo).toHaveBeenCalledWith("Keep answers short");
    expect(container.textContent).toContain("Saved note: Keep answers short");
    expect(container.querySelector(".v1-ob-user")?.textContent).toBe(
      "I’ll call you Pip."
    );
  });
  it("does not treat typed yes as consent to change an AI Client", async () => {
    const { click, send, statusStore } = await render();
    await click("Juno");
    await click("That’s me");
    await send("yes");
    await send("yes");
    expect(statusStore.run).not.toHaveBeenCalled();
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });
});

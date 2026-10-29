// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../types.js";
import type { HqOnboardingStatus } from "../../../ipc/hq-onboarding-protocol.js";
import { HqOnboarding } from "./HqOnboarding.js";
import {
  initialHqOnboarding,
  readHqOnboarding,
  writeHqOnboarding
} from "./onboarding-preference.js";

vi.mock("../agents/Pixelkin.js", () => ({
  Pixelkin: () => <div>Pixelkin preview</div>
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const profileKey = "local-profile-1";
const ownerId = "owner-hq506";
type OnboardingInvoke = (
  command: string,
  args?: Record<string, unknown>
) => Promise<HqOnboardingStatus>;
const base = (): HqOnboardingStatus => ({
  profileKey,
  ownerId: null,
  memoryState: "not_started",
  error: null,
  clients: [
    {
      driver: "codex",
      name: "Codex",
      installed: false,
      authenticated: "unknown",
      selected: false,
      configured: false,
      memoryConnected: false,
      error: null
    }
  ]
});
const ready = (): HqOnboardingStatus => ({
  ...base(),
  ownerId,
  memoryState: "ready",
  clients: [
    {
      ...base().clients[0]!,
      installed: true,
      authenticated: "yes",
      selected: true,
      configured: true,
      memoryConnected: true
    }
  ]
});

describe("HQ v56 conversation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let status: HqOnboardingStatus;
  let invoke: ReturnType<typeof vi.fn<OnboardingInvoke>>;
  let original: PropertyDescriptor | undefined;
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === label && !item.disabled
    );
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  };
  const messages = () =>
    [
      ...container.querySelectorAll(
        ".hq-onboarding__message, .hq-onboarding__user-message"
      )
    ].map((element) => element.textContent ?? "");
  beforeEach(() => {
    localStorage.clear();
    status = base();
    original = Object.getOwnPropertyDescriptor(window, "koedDesktop");
    invoke = vi.fn<OnboardingInvoke>(async (command: string) => {
      if (command === "hq_onboarding_discover")
        status = {
          ...status,
          clients: [
            {
              ...status.clients[0]!,
              installed: true,
              authenticated: "yes"
            }
          ]
        };
      if (command === "hq_onboarding_connect")
        status = {
          ...status,
          clients: [
            {
              ...status.clients[0]!,
              selected: true,
              configured: status.memoryState === "ready",
              memoryConnected: status.memoryState === "ready"
            }
          ]
        };
      if (command === "hq_onboarding_prepare_memory")
        status = { ...status, memoryState: "preparing" };
      return status;
    });
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: { invoke } as unknown as DesktopApi
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (original) Object.defineProperty(window, "koedDesktop", original);
    else delete window.koedDesktop;
  });

  it("asks how Koed will be used first and starts Koed's own setup on the answer", async () => {
    await act(async () => root.render(<HqOnboarding onComplete={vi.fn()} />));
    expect(messages()[0]).toContain("Hi, welcome to Koed.");
    expect(messages()[1]).toContain("First, how will you use Koed?");
    expect(container.querySelector(".hq-onboarding__maker")).toBeFalsy();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "hq_onboarding_status"
    ]);
    await click("Just me, on this Mac");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "hq_onboarding_status",
      "hq_onboarding_prepare_core"
    ]);
    expect(invoke).toHaveBeenLastCalledWith("hq_onboarding_prepare_core", {
      operatorConsented: true
    });
    expect(container.textContent).toContain(
      "I'm setting Koed up on this Mac in the background"
    );
    expect(container.querySelector(".hq-onboarding__maker")).toBeTruthy();
  });

  it("retains the exact welcome, accepted maker, user reply and three-things exchange before AI", async () => {
    await act(async () => root.render(<HqOnboarding onComplete={vi.fn()} />));
    await click("Just me, on this Mac");
    expect(messages()[0]).toContain("Hi, welcome to Koed.");
    expect(messages()[4]).toContain(
      "I'm your new agent. I'll be your chief of staff: I run your other agents, remember your work, and bring people in when you want them."
    );
    expect(container.querySelector(".hq-onboarding__maker")).toBeTruthy();
    expect(container.textContent).not.toContain(
      "What will you mostly use Koed for?"
    );
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "hq_onboarding_status",
      "hq_onboarding_prepare_core"
    ]);
    expect(
      container.querySelectorAll(".hq-onboarding__colors button")
    ).toHaveLength(8);
    expect(container.querySelectorAll(".hq-onboarding__shapes").length).toBe(2);
    await click("Juno");
    await click("That’s me");
    expect(container.querySelector(".hq-onboarding__maker-done")).toBeTruthy();
    expect(messages().slice(6, 9).join(" ")).toContain("I'll call you Juno.");
    expect(messages().slice(6, 9).join(" ")).toContain(
      "Juno it is. Nice to meet you."
    );
    expect(messages().slice(6, 9).join(" ")).toContain(
      "Let's set you up. Three quick things:"
    );
    expect(container.textContent).toContain(
      "What Koed remembers for you, and why that beats your AI on its own."
    );
    expect(container.textContent).not.toContain(
      "Can I look for them on this Mac?"
    );
    await click("What is Koed?");
    expect(container.textContent).toContain(
      "Koed is where you and your agents work."
    );
    await click("Let's go");
    expect(container.textContent).toContain("Can I look for them on this Mac?");
    expect(messages()[0]).toContain("Hi, welcome to Koed.");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "hq_onboarding_status",
      "hq_onboarding_prepare_core"
    ]);
  });

  it("routes a typed name through the same accepted exchange without starting AI Client setup", async () => {
    await act(async () => root.render(<HqOnboarding onComplete={vi.fn()} />));
    await click("Just me, on this Mac");
    const composer = container.querySelector<HTMLTextAreaElement>(
      ".hq-onboarding__composer textarea"
    )!;
    expect(composer.placeholder).toBe("Type a name, or pick one above");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(composer, "Call yourself Cooper");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Send setup message"]'
        )!
        .click()
    );
    expect(container.textContent).toContain("I'll call you Cooper.");
    expect(container.textContent).toContain("Cooper it is. Nice to meet you.");
    expect(container.textContent).toContain(
      "Let's set you up. Three quick things:"
    );
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "hq_onboarding_status",
      "hq_onboarding_prepare_core"
    ]);
  });

  it("explains what connecting does, then starts Memory once when the person connects", async () => {
    await act(async () => root.render(<HqOnboarding onComplete={vi.fn()} />));
    await click("Just me, on this Mac");
    await click("Atlas");
    await click("That’s me");
    await click("Let's go");
    await click("Look for them");
    expect(container.textContent).toContain("Found one:");
    expect(invoke.mock.calls.map(([command]) => command)).not.toContain(
      "hq_onboarding_prepare_memory"
    );
    expect(container.textContent).toContain("What connecting does");
    expect(container.textContent).toContain(
      "your sessions with it, in any folder, are saved to your memory on this Mac"
    );
    await click("Connect and remember");
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "hq_onboarding_prepare_memory"
      )
    ).toHaveLength(1);
    expect(container.textContent).toContain("How I’ll use them");
    expect(container.textContent).toContain(
      "Next, the part that makes Koed worth it."
    );
    await click("Next: memory");
    expect(container.textContent).toContain(
      "Now the part your AI subscription can't do on its own."
    );
    expect(container.textContent).toContain(
      "Let me show you. Tell me one thing about how you work."
    );
    expect(container.textContent).toContain("Preparing local memory");
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "hq_onboarding_prepare_memory"
      )
    ).toHaveLength(1);
    expect(messages()[0]).toContain("Hi, welcome to Koed.");
  });

  it("shows real stage progress and retries failure without losing selections", async () => {
    const originalInvoke = invoke.getMockImplementation()!;
    let attempts = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === "hq_onboarding_prepare_memory") {
        attempts += 1;
        status = {
          ...status,
          memoryState: attempts === 1 ? "failed" : "preparing",
          error: attempts === 1 ? "Local startup failed." : null,
          progress: {
            message: "Starting local Memory…",
            completedSteps: 3,
            totalSteps: 8,
            startedAt: Date.now()
          }
        };
        return status;
      }
      return originalInvoke(command);
    });
    await act(async () => root.render(<HqOnboarding onComplete={vi.fn()} />));
    await click("Just me, on this Mac");
    await click("Atlas");
    await click("That’s me");
    await click("Let's go");
    await click("Look for them");
    await click("Connect and remember");
    await click("Next: memory");
    expect(container.textContent).toContain("Your selections are saved.");
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    await click("Retry");
    expect(attempts).toBe(2);
    expect(container.textContent).toContain("Starting local Memory…");
    expect(container.textContent).toContain("3 of 8 setup steps complete.");
    const progress = container.querySelector("progress");
    expect(progress?.value).toBe(3);
    expect(progress?.max).toBe(8);
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(container.textContent).toContain("I'll call you Atlas.");
    expect(status.clients[0]?.selected).toBe(true);
    expect(container.textContent).not.toContain("Local startup failed.");
  });

  it("uses the real Memory demo result and finishes with verified AI instance binding", async () => {
    status = ready();
    status = {
      ...status,
      clients: [
        {
          ...status.clients[0]!,
          selected: false,
          configured: false,
          memoryConnected: false
        }
      ]
    };
    const chief = {
      id: "chief-1",
      ownerUserId: ownerId,
      isChiefOfStaff: true,
      aiClientInstanceId: null
    };
    const ensureChief = vi.fn().mockResolvedValue(chief);
    const patch = vi.fn().mockResolvedValue(chief);
    const list = vi.fn().mockResolvedValue([]);
    const create = vi.fn().mockImplementation(async (agent) => ({
      ...agent,
      id: "helper-1",
      ownerUserId: ownerId
    }));
    const listClients = vi.fn().mockResolvedValue({
      readModel: {
        defaults: {
          conversations: {
            available: true,
            assignment: {
              ai_client_instance_id: "codex.default",
              provider: "codex"
            }
          }
        },
        instances: [
          { instanceId: "codex.default", driverId: "codex", enabled: true }
        ]
      }
    });
    const run = vi.fn().mockResolvedValue({
      noteId: "note-1",
      status: "answered",
      answer: "A short setting name from retrieved memory."
    });
    const onComplete = vi.fn();
    await act(async () =>
      root.render(
        <HqOnboarding
          ownerId={ownerId}
          profileKey="live-profile"
          agentsApi={
            {
              ensureChief,
              patch,
              list,
              create
            } as unknown as DesktopApi["agents"]
          }
          localAiClients={
            {
              list: listClients,
              refresh: vi.fn(() => {
                throw new Error(
                  "Discovery must not run during Hire or completion."
                );
              })
            } as unknown as DesktopApi["localAiClients"]
          }
          memoryDemoApi={{ run }}
          onComplete={onComplete}
        />
      )
    );
    await click("Just me, on this Mac");
    await click("Mika");
    await click("That’s me");
    await click("Let's go");
    await click("Look for them");
    await click("Connect and remember");
    await click("Next: memory");
    expect(run).not.toHaveBeenCalled();
    await click("Keep answers short");
    expect(run).toHaveBeenCalledWith("Keep answers short", expect.any(String));
    expect(container.textContent).toContain(
      "A short setting name from retrieved memory."
    );
    await click("Next: working together");
    expect(container.textContent).toContain("Solo, with agents");
    expect(container.textContent).toContain("With your co-workers");
    expect(container.textContent).toContain("Work item");
    expect(container.textContent).toContain("Retry failed webhooks");
    expect(container.textContent).toContain("Koed team");
    expect(container.textContent).toContain("Invite");
    await click("Solo: hire an agent");
    await click("Hire an agent to write tests for this Project");
    expect(
      container.querySelector(".hq-onboarding__hire-card input")
    ).toBeTruthy();
    await click("New look");
    let finishHire!: (value: object) => void;
    create.mockImplementationOnce(
      () =>
        new Promise<object>((resolve) => {
          finishHire = resolve;
        })
    );
    const hireButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Hire"
    )!;
    await act(async () => {
      hireButton.click();
      hireButton.click();
    });
    expect(container.textContent).toContain("Hiring Quinn…");
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () =>
      finishHire({
        ...create.mock.calls[0]![0],
        id: "helper-1",
        ownerUserId: ownerId
      })
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Quinn",
        aiClientInstanceId: "codex.default",
        defaultPermissionMode: "supervised"
      })
    );
    expect(container.textContent).toContain("Hired");
    await click("Now show me inviting people");
    await click("Invite Mark to this Project");
    expect(
      container.querySelector(".hq-onboarding__invite-card input[type=email]")
    ).toBeTruthy();
    expect(container.textContent).toContain("Team invites are unavailable");
    await click("Finish setup");
    expect(container.textContent).toContain("You're set.");
    expect(container.textContent).toContain("Solo, with Quinn (Tests)");
    expect(
      container.querySelectorAll(".hq-onboarding__summary-row")
    ).toHaveLength(4);
    let finishPatch!: (value: typeof chief) => void;
    patch.mockImplementationOnce(
      () =>
        new Promise<typeof chief>((resolve) => {
          finishPatch = resolve;
        })
    );
    await click("Start using Koed");
    expect(container.textContent).toContain("Opening Koed…");
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => finishPatch(chief));
    expect(listClients).toHaveBeenCalledTimes(2);
    expect(ensureChief).toHaveBeenCalledOnce();
    expect(patch).toHaveBeenCalledWith(
      "chief-1",
      expect.objectContaining({
        name: "Mika",
        aiClientInstanceId: "codex.default",
        look: expect.objectContaining({ pixelkin: expect.any(Object) })
      })
    );
    expect(onComplete).toHaveBeenCalledOnce();
    expect(readHqOnboarding(ownerId, profileKey).completed).toBe(true);
    expect(readHqOnboarding(ownerId, "live-profile").completed).toBe(false);
  });

  it("says what it is doing while the memory example runs", async () => {
    status = ready();
    status = {
      ...status,
      clients: [
        {
          ...status.clients[0]!,
          selected: false,
          configured: false,
          memoryConnected: false
        }
      ]
    };
    let finish!: (value: object) => void;
    const run = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          finish = resolve;
        })
    );
    await act(async () =>
      root.render(
        <HqOnboarding
          ownerId={ownerId}
          memoryDemoApi={{ run } as never}
          onComplete={vi.fn()}
        />
      )
    );
    await click("Just me, on this Mac");
    await click("Mika");
    await click("That’s me");
    await click("Let's go");
    await click("Look for them");
    await click("Connect and remember");
    await click("Next: memory");
    await click("Keep answers short");
    expect(container.textContent).toContain(
      "Saving that to your memory, then asking Codex what it knows about you."
    );
    await act(async () =>
      finish({ noteId: "note-1", status: "answered", answer: "Short." })
    );
    expect(container.textContent).not.toContain("Saving that to your memory");
    expect(container.textContent).toContain(
      "I asked: What do you know about how I like to work?"
    );
  });

  it("rehydrates the accepted exchange from an older stage-two draft", async () => {
    status = ready();
    const oldRecord = {
      ...initialHqOnboarding,
      chiefName: "Cooper",
      lookColor: "#ff8268",
      roleAnswered: true,
      stage: 2 as const
    };
    Reflect.deleteProperty(oldRecord, "lookTop");
    localStorage.setItem(
      `koed.hq.onboarding.v56.draft:${encodeURIComponent(profileKey)}`,
      JSON.stringify({ schemaVersion: 1, ownerId, record: oldRecord })
    );
    await act(async () =>
      root.render(<HqOnboarding ownerId={ownerId} onComplete={vi.fn()} />)
    );
    expect(container.querySelector(".hq-onboarding__maker-done")).toBeTruthy();
    expect(container.textContent).toContain("I'll call you Cooper.");
    expect(container.textContent).toContain(
      "Let's set you up. Three quick things:"
    );
    expect(container.textContent).toContain("What is Koed?");
    expect(readHqOnboarding(ownerId, profileKey).lookColor).toBe("#ff8268");
    expect(readHqOnboarding(ownerId, profileKey).lookTop).toBe("none");
    expect(container.textContent).not.toContain(
      "Can I look for them on this Mac?"
    );
    await click("Let's go");
    expect(container.textContent).toContain("Can I look for them on this Mac?");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "hq_onboarding_status"
    ]);
  });

  it("preserves same-owner completion and never copies to a different owner", async () => {
    status = ready();
    writeHqOnboarding(ownerId, profileKey, {
      ...initialHqOnboarding,
      chiefName: "Juno",
      completed: true,
      stage: 5
    });
    const onComplete = vi.fn();
    await act(async () =>
      root.render(
        <HqOnboarding
          ownerId={ownerId}
          profileKey="live-profile"
          onComplete={onComplete}
        />
      )
    );
    expect(onComplete).toHaveBeenCalledOnce();
    expect(readHqOnboarding(ownerId, profileKey).completed).toBe(true);
    expect(readHqOnboarding(ownerId, "live-profile").completed).toBe(false);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(
        <HqOnboarding
          ownerId="different-owner"
          profileKey="different-live"
          onComplete={onComplete}
        />
      )
    );
    expect(onComplete).toHaveBeenCalledOnce();
    expect(
      readHqOnboarding("different-owner", "different-live").completed
    ).toBe(false);
  });

  it("rejects corrupted or foreign-owner story drafts", async () => {
    const key = `koed.hq.onboarding.v56.draft:${encodeURIComponent(profileKey)}`;
    localStorage.setItem(
      key,
      JSON.stringify({
        schemaVersion: 1,
        ownerId: "another-owner",
        record: { ...initialHqOnboarding, chiefName: "Leaked", stage: 2 },
        story: [{ key: "user", value: "Secret" }]
      })
    );
    status = { ...base(), ownerId };
    await act(async () =>
      root.render(<HqOnboarding ownerId={ownerId} onComplete={vi.fn()} />)
    );
    expect(container.textContent).not.toContain("Leaked");
    expect(container.textContent).not.toContain("Secret");
    await click("Just me, on this Mac");
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Chief of Staff name"]'
      )?.value
    ).toBe("");
  });

  it("keeps Solo to Solo: Team waits, and there is no Working together step", async () => {
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: {
        invoke,
        featureFlags: {
          hqEnabled: true,
          teamCollaborationEnabled: false,
          edition: "solo",
          phoneEnabled: false
        }
      } as unknown as DesktopApi
    });
    await act(async () => root.render(<HqOnboarding onComplete={vi.fn()} />));
    const team = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("With my team")
    );
    expect(team?.textContent).toContain("coming later");
    expect(team?.disabled).toBe(true);
    await click("Just me, on this Mac");
    expect(container.textContent).not.toContain("Working together");
    expect(container.textContent).toContain(
      "I'm setting Koed up on this Mac in the background"
    );
    await click("Atlas");
    await click("That’s me");
    expect(container.textContent).toContain(
      "Let's set you up. Two quick things:"
    );
    expect(container.textContent).not.toContain("co-workers");
  });
});

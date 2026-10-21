// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../types.js";
import { HqOnboarding } from "./HqOnboarding.js";
import { readHqOnboarding } from "./onboarding-preference.js";

vi.mock("../agents/Pixelkin.js", () => ({
  Pixelkin: () => <div>Pixelkin preview</div>
}));
vi.mock("../settings/HqSettingsAgents.js", () => ({
  HqSettingsAgents: () => <div>AI Client connection controls</div>
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("HQ first run", () => {
  let container: HTMLDivElement;
  let root: Root;
  const ownerId = "owner-hq506";
  const profileKey = "owner-hq506|epoch-1|local";

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes(label)
    );
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  };

  it("treats skip as Something else and retains a Chief draft until a real AI Client is enabled", async () => {
    const onComplete = vi.fn();
    const refresh = vi.fn().mockResolvedValue({
      readModel: {
        defaults: { conversations: { available: false, assignment: null } },
        instances: []
      }
    });
    const ensureChief = vi.fn();
    await act(async () =>
      root.render(
        <HqOnboarding
          ownerId={ownerId}
          profileKey={profileKey}
          localAiClients={
            { refresh } as unknown as DesktopApi["localAiClients"]
          }
          agentsApi={{ ensureChief } as unknown as DesktopApi["agents"]}
          onComplete={onComplete}
        />
      )
    );
    expect(container.textContent).toContain(
      "What will you mostly use Koed for?"
    );
    await click("Skip · Something else");
    expect(readHqOnboarding(ownerId, profileKey)).toMatchObject({
      role: "other",
      roleAnswered: true,
      completed: false
    });
    expect(container.textContent).toContain("I’ll be your Chief of Staff");
    expect(
      container.querySelectorAll(".hq-onboarding__suggestions button")
    ).toHaveLength(5);
    expect(container.textContent).toContain("AI Client connection controls");
    expect(
      [...container.querySelectorAll("button")].find((item) =>
        item.textContent?.includes("Continue to Koed")
      )?.disabled
    ).toBe(true);
    expect(ensureChief).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("patches the existing Chief with chosen name and Pixelkin only after enabled default Client", async () => {
    const onComplete = vi.fn();
    const refresh = vi.fn().mockResolvedValue({
      readModel: {
        defaults: {
          conversations: {
            available: true,
            assignment: {
              ai_client_instance_id: "instance-1",
              provider: "codex"
            }
          }
        },
        instances: [
          { instanceId: "instance-1", driverId: "codex", enabled: true }
        ]
      }
    });
    const chief = {
      id: "chief-1",
      ownerUserId: ownerId,
      isChiefOfStaff: true,
      aiClientInstanceId: null
    };
    const ensureChief = vi.fn().mockResolvedValue(chief);
    const patch = vi
      .fn()
      .mockResolvedValue({ ...chief, aiClientInstanceId: "instance-1" });
    await act(async () =>
      root.render(
        <HqOnboarding
          ownerId={ownerId}
          profileKey={profileKey}
          localAiClients={
            { refresh } as unknown as DesktopApi["localAiClients"]
          }
          agentsApi={{ ensureChief, patch } as unknown as DesktopApi["agents"]}
          onComplete={onComplete}
        />
      )
    );
    await click("Building software");
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Chief of Staff name"]'
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "Nova");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Continue to Koed");
    expect(ensureChief).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(
      "chief-1",
      expect.objectContaining({
        name: "Nova",
        aiClientInstanceId: "instance-1",
        look: expect.objectContaining({ pixelkin: expect.any(Object) })
      })
    );
    expect(onComplete).toHaveBeenCalledOnce();
    expect(readHqOnboarding(ownerId, profileKey)).toMatchObject({
      role: "software",
      chiefName: "Nova",
      completed: true,
      remember: false
    });
  });

  it("locks Remember and maker choices while saving so consent cannot change mid-request", async () => {
    let releaseChief!: (value: object) => void;
    const ensureChief = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseChief = resolve;
        })
    );
    const patch = vi.fn().mockResolvedValue({
      id: "chief-1",
      ownerUserId: ownerId,
      isChiefOfStaff: true
    });
    const onComplete = vi.fn();
    await act(async () =>
      root.render(
        <HqOnboarding
          ownerId={ownerId}
          profileKey={profileKey}
          localAiClients={
            {
              refresh: vi.fn().mockResolvedValue({
                readModel: {
                  defaults: {
                    conversations: {
                      available: true,
                      assignment: {
                        ai_client_instance_id: "instance-1",
                        provider: "codex"
                      }
                    }
                  },
                  instances: [
                    {
                      instanceId: "instance-1",
                      driverId: "codex",
                      enabled: true
                    }
                  ]
                }
              })
            } as unknown as DesktopApi["localAiClients"]
          }
          agentsApi={{ ensureChief, patch } as unknown as DesktopApi["agents"]}
          onComplete={onComplete}
        />
      )
    );
    await click("Building software");
    await click("Juno");
    await act(async () => {
      container
        .querySelector<HTMLInputElement>(".hq-onboarding__remember input")!
        .click();
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((item) => item.textContent?.includes("Continue to Koed"))!
        .click();
    });
    expect(
      container.querySelector<HTMLInputElement>(
        ".hq-onboarding__remember input"
      )!.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Chief of Staff name"]'
      )!.disabled
    ).toBe(true);
    expect(
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".hq-onboarding__suggestions button"
        )
      ].every((item) => item.disabled)
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        ".hq-onboarding__footer button"
      )!.disabled
    ).toBe(true);
    await act(async () =>
      releaseChief({
        id: "chief-1",
        ownerUserId: ownerId,
        isChiefOfStaff: true,
        aiClientInstanceId: "instance-1"
      })
    );
    expect(onComplete).not.toHaveBeenCalled();
  });
});

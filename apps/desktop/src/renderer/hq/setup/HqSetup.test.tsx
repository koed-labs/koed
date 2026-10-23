// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSetupApi,
  DesktopSetupSnapshot,
  DesktopSetupStageId
} from "../../../types.js";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { HqSetup } from "./HqSetup.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const stageIds: DesktopSetupStageId[] = [
  "package",
  "runtime",
  "model",
  "services",
  "integration",
  "verification"
];
const snapshot = (
  state: DesktopSetupSnapshot["state"],
  completed = state === "complete"
): DesktopSetupSnapshot => ({
  activeStage: state === "running" ? "model" : null,
  error: null,
  runId: "run-1",
  sequence: 1,
  state,
  stages: stageIds.map((id) => ({
    id,
    state: completed
      ? "complete"
      : id === "model" && state === "running"
        ? "running"
        : "pending",
    message: id === "model" ? "Downloading model" : "Waiting",
    completedBytes: id === "model" && state === "running" ? 512 : null,
    totalBytes: id === "model" && state === "running" ? 1024 : null
  }))
});

describe("HQ local setup", () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: DesktopSetupSnapshot;
  let notify: ((value: DesktopSetupSnapshot) => void) | null;
  let inspect = vi.fn(async (): Promise<DesktopSetupSnapshot> => current);
  let run = vi.fn(async (): Promise<DesktopSetupSnapshot> => current);
  let unsubscribe = vi.fn(() => undefined);
  let refresh = vi.fn(async () => undefined);
  let onComplete = vi.fn(async () => undefined);

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    current = snapshot("ready");
    notify = null;
    inspect = vi.fn(async (): Promise<DesktopSetupSnapshot> => current);
    run = vi.fn(async (): Promise<DesktopSetupSnapshot> => current);
    unsubscribe = vi.fn(() => undefined);
    refresh = vi.fn(async () => undefined);
    onComplete = vi.fn(async () => undefined);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    expect(unsubscribe).toHaveBeenCalled();
  });

  const render = async () => {
    const setupApi: DesktopSetupApi = {
      inspect,
      run,
      subscribe: (listener) => {
        notify = listener;
        return unsubscribe;
      }
    };
    await act(async () =>
      root.render(
        <HqSetup
          setupApi={setupApi}
          statusStore={{ refresh } as unknown as DesktopStatusStore}
          onComplete={onComplete}
        />
      )
    );
  };
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .reverse()
      .find((item) => item.textContent?.trim() === name);
  const click = async (name: string) => {
    expect(button(name), name).toBeDefined();
    await act(async () => button(name)!.click());
  };

  it("requires explicit review before running and shows authoritative progress", async () => {
    await render();
    expect(
      container.querySelector('[data-hq-setup][data-state="ready"]')
    ).toBeTruthy();
    expect(run).not.toHaveBeenCalled();

    await click("Set up Koed");
    expect(
      document.querySelector('[role="dialog"][aria-modal="true"]')
    ).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    await click("Cancel");
    expect(run).not.toHaveBeenCalled();

    await click("Set up Koed");
    current = snapshot("running");
    await click("Set up Koed");
    expect(run).toHaveBeenCalledOnce();
    await act(async () => notify?.(current));
    expect(container.textContent).toContain("512 B of 1.0 KB");
    expect(container.querySelector('[data-state="running"]')).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("rechecks complete stages before continuing and refreshes status", async () => {
    current = snapshot("complete");
    await render();
    expect(
      container.querySelector('[data-hq-setup][data-state="complete"]')
    ).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();

    current = snapshot("complete", false);
    await click("Continue to Koed");
    expect(onComplete).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Complete all local setup steps");

    current = snapshot("complete");
    await click("Set up Koed");
    await click("Cancel");
    await act(async () => notify?.(current));
    await click("Continue to Koed");
    expect(onComplete).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("ignores a prior setup authority's pending completion after replacement", async () => {
    current = snapshot("complete");
    await render();
    const oldNotify = notify;
    let resolveOld!: (value: DesktopSetupSnapshot) => void;
    inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    await act(async () => button("Continue to Koed")!.click());

    const nextApi: DesktopSetupApi = {
      inspect: vi.fn(async () => snapshot("ready")),
      run: vi.fn(async () => snapshot("ready")),
      subscribe: () => () => undefined
    };
    await act(async () =>
      root.render(
        <HqSetup
          setupApi={nextApi}
          statusStore={{ refresh } as unknown as DesktopStatusStore}
          onComplete={onComplete}
        />
      )
    );
    await act(async () => {
      oldNotify?.(snapshot("complete"));
      resolveOld(snapshot("complete"));
    });
    expect(
      container.querySelector('[data-hq-setup][data-state="ready"]')
    ).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();

    await click("Set up Koed");
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    await act(async () =>
      root.render(
        <HqSetup
          setupApi={{
            ...nextApi,
            inspect: vi.fn(async () => snapshot("ready"))
          }}
          statusStore={{ refresh } as unknown as DesktopStatusStore}
          onComplete={onComplete}
        />
      )
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

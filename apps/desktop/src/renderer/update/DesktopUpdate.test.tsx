// @vitest-environment happy-dom

import type { DesktopUpdateState } from "@koed/shared";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesktopUpdateIndicator,
  DesktopUpdateSurface
} from "./DesktopUpdate.js";
import { useDesktopUpdate } from "./use-desktop-update.js";
import type { DesktopUpdateApi } from "../../types.js";

const release = {
  channel: "stable" as const,
  releaseName: "Quiet improvements",
  releaseNotes: "A calmer update flow.",
  version: "0.5.0"
};

const stateFor = (status: DesktopUpdateState["status"]): DesktopUpdateState => {
  switch (status) {
    case "disabled":
      return { reason: "unsupported", status };
    case "idle":
      return { status };
    case "checking":
      return { status };
    case "available":
      return { release, status };
    case "downloading":
      return { progress: 42, release, status };
    case "ready":
      return { release, status };
    case "installing":
      return { release, status };
    case "error":
      return { message: "safe", release, status };
  }
};

const controllerFor = (
  state: DesktopUpdateState,
  overrides: Partial<
    ComponentProps<typeof DesktopUpdateSurface>["controller"]
  > = {}
) => ({
  api: null,
  busy: null,
  check: vi.fn(),
  closeSurface: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  manualError: null,
  notice: null,
  open: false,
  openSurface: vi.fn(),
  state,
  version: "0.4.4",
  ...overrides
});

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

const createApi = (initial: DesktopUpdateState = { status: "idle" }) => {
  let listener: ((state: DesktopUpdateState) => void) | null = null;
  const api: DesktopUpdateApi = {
    check: vi.fn(async () => initial),
    download: vi.fn(async () => initial),
    getState: vi.fn(async () => initial),
    getVersion: vi.fn(async () => "0.4.4"),
    install: vi.fn(async () => initial),
    subscribe: vi.fn((next) => {
      listener = next;
      return () => {
        listener = null;
      };
    })
  };
  return {
    api,
    push: (state: DesktopUpdateState) => listener?.(state)
  };
};

function HookHarness({ api }: { api: DesktopUpdateApi }) {
  const controller = useDesktopUpdate(api, "0.4.4");
  return (
    <>
      <DesktopUpdateIndicator controller={controller} />
      <output data-state={controller.state.status}>{controller.notice}</output>
    </>
  );
}

describe("Desktop update renderer", () => {
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
  });

  it("renders every contract state without changing the trigger dimensions", async () => {
    for (const status of [
      "disabled",
      "idle",
      "checking",
      "available",
      "downloading",
      "ready",
      "installing",
      "error"
    ] as const) {
      const controller = controllerFor(stateFor(status));
      await act(async () =>
        root.render(<DesktopUpdateSurface controller={controller} />)
      );
      expect(
        container
          .querySelector(".desktop-update-surface")
          ?.getAttribute("data-state")
      ).toBe(status);
      expect(container.textContent).toContain("Current version 0.4.4");
    }
    expect(container.querySelector(".desktop-update-surface")).toBeTruthy();
  });

  it("offers explicit download and suppresses duplicate actions while busy", async () => {
    const deferred = new Deferred<DesktopUpdateState>();
    const fixture = createApi({ release, status: "available" });
    fixture.api.download = vi.fn(() => deferred.promise);
    await act(async () => root.render(<HookHarness api={fixture.api} />));
    const trigger = container.querySelector<HTMLButtonElement>(
      ".desktop-update-trigger"
    )!;
    await act(async () => trigger.click());
    const action = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Download update")
    )!;
    await act(async () => {
      action.click();
      action.click();
    });
    expect(fixture.api.download).toHaveBeenCalledOnce();
  });

  it("shows deterministic progress, restart warning, and accessible controls", async () => {
    const controller = controllerFor(stateFor("downloading"));
    await act(async () =>
      root.render(<DesktopUpdateSurface controller={controller} />)
    );
    expect(container.querySelector("progress")?.getAttribute("value")).toBe(
      "42"
    );
    expect(
      container.querySelector('[aria-label="Download progress 42%"]')
    ).toBeTruthy();

    const ready = controllerFor(stateFor("ready"));
    await act(async () =>
      root.render(<DesktopUpdateSurface controller={ready} />)
    );
    expect(container.textContent).toContain("Restarting will close Koed");
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Restart and update")
      )
    ).toBe(true);
  });

  it("reports manual no-update success and hides raw command errors", async () => {
    const fixture = createApi({ status: "idle" });
    await act(async () => root.render(<HookHarness api={fixture.api} />));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".desktop-update-trigger")!
        .click();
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Check for updates"))
        ?.click();
    });
    expect(container.textContent).toContain("Koed is up to date.");

    fixture.api.check = vi.fn(async () => {
      throw new Error("token=https://private.example/secret");
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Check for updates"))
        ?.click();
    });
    expect(container.textContent).toContain("Koed could not check for updates");
    expect(container.textContent).not.toContain("private.example");
  });

  it("does not let stale command completion overwrite a pushed state and cleans up", async () => {
    const check = new Deferred<DesktopUpdateState>();
    const fixture = createApi({ status: "idle" });
    fixture.api.check = vi.fn(() => check.promise);
    await act(async () => root.render(<HookHarness api={fixture.api} />));
    const trigger = container.querySelector<HTMLButtonElement>(
      ".desktop-update-trigger"
    )!;
    await act(async () => trigger.click());
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Check for updates"))
        ?.click();
      fixture.push({ release, status: "available" });
    });
    check.resolve({ status: "idle" });
    await act(async () => check.promise);
    expect(container.querySelector('[data-state="available"]')).toBeTruthy();

    await act(async () => root.unmount());
    expect(fixture.api.subscribe).toHaveBeenCalledOnce();
  });

  it("keeps update labels and focusable close controls in the popover", async () => {
    const controller = controllerFor(stateFor("available"), { open: true });
    await act(async () =>
      root.render(<DesktopUpdateIndicator controller={controller} />)
    );
    expect(
      container
        .querySelector(".desktop-update-trigger")
        ?.getAttribute("aria-label")
    ).toBe("Update available");
    expect(
      container.querySelector('[aria-label="Close update details"]')
    ).toBeTruthy();
    expect(
      container
        .querySelector(".desktop-update-control")
        ?.classList.contains("desktop-update-control")
    ).toBe(true);
  });
});

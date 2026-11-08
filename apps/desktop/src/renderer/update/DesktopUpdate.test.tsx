// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopUpdateNotice, DesktopUpdatePanel } from "./DesktopUpdate.js";
import {
  useDesktopUpdate,
  type DesktopUpdateController
} from "./use-desktop-update.js";
import type {
  DesktopUpdateApi,
  DesktopUpdateState
} from "@koed/shared/desktop-update-contract";

const currentState: DesktopUpdateState = {
  installedVersion: "0.10.0",
  status: "current",
  release: null,
  checkedAt: "2026-11-06T00:00:00.000Z"
};

const update = (
  state: DesktopUpdateController["state"]
): DesktopUpdateController => ({
  state,
  error: null,
  busy: false,
  check: async () => undefined,
  open: async () => undefined
});

describe("Desktop update notice", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(async () => act(async () => root.unmount()));

  it("accepts a fresher snapshot instead of rejecting it after an event", async () => {
    let resolveSnapshot!: (state: DesktopUpdateState) => void;
    let publish!: (state: DesktopUpdateState) => void;
    const api: DesktopUpdateApi = {
      getState: () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
      checkForUpdates: async () => current,
      openReleasePage: async () => current,
      subscribe: (listener) => {
        publish = listener;
        return () => undefined;
      }
    };
    let controller!: DesktopUpdateController;
    function Probe() {
      controller = useDesktopUpdate(api);
      return null;
    }
    await act(async () => root.render(<Probe />));
    const current: DesktopUpdateState = {
      installedVersion: "0.10.0",
      status: "current",
      release: null,
      checkedAt: "2026-11-06T00:00:00.000Z"
    };
    const available: DesktopUpdateState = {
      installedVersion: "0.10.0",
      status: "available",
      release: { version: "0.11.0", summary: "New" },
      checkedAt: "2026-11-05T00:00:00.000Z"
    };
    await act(async () => {
      publish(available);
      resolveSnapshot(current);
    });
    expect(controller.state).toEqual(current);
  });
  it("does not let a stale snapshot overwrite a newer event", async () => {
    let resolveSnapshot!: (state: DesktopUpdateState) => void;
    let publish!: (state: DesktopUpdateState) => void;
    const api: DesktopUpdateApi = {
      getState: () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
      checkForUpdates: async () => currentState,
      openReleasePage: async () => currentState,
      subscribe: (listener) => {
        publish = listener;
        return () => undefined;
      }
    };
    let controller!: DesktopUpdateController;
    function Probe() {
      controller = useDesktopUpdate(api);
      return null;
    }
    await act(async () => root.render(<Probe />));
    const newer: DesktopUpdateState = {
      installedVersion: "0.10.0",
      status: "available",
      release: { version: "0.11.0", summary: "New" },
      checkedAt: "2026-11-06T00:00:00.000Z"
    };
    const older: DesktopUpdateState = {
      ...currentState,
      checkedAt: "2026-11-05T00:00:00.000Z"
    };
    await act(async () => {
      publish(newer);
      resolveSnapshot(older);
    });
    expect(controller.state).toEqual(newer);
  });

  it("does not show a stale snapshot failure after a live event", async () => {
    let rejectSnapshot!: (error: Error) => void;
    let publish!: (state: DesktopUpdateState) => void;
    const api: DesktopUpdateApi = {
      getState: () =>
        new Promise((_resolve, reject) => {
          rejectSnapshot = reject;
        }),
      checkForUpdates: async () => currentState,
      openReleasePage: async () => currentState,
      subscribe: (listener) => {
        publish = listener;
        return () => undefined;
      }
    };
    let controller!: DesktopUpdateController;
    function Probe() {
      controller = useDesktopUpdate(api);
      return null;
    }
    await act(async () => root.render(<Probe />));
    await act(async () => publish(currentState));
    await act(async () => rejectSnapshot(new Error("stale failure")));
    expect(controller.error).toBeNull();
    expect(controller.state).toEqual(currentState);
  });

  it("clears a superseded snapshot error when a live update arrives", async () => {
    let rejectSnapshot!: (error: Error) => void;
    let publish!: (state: DesktopUpdateState) => void;
    const api: DesktopUpdateApi = {
      getState: () =>
        new Promise((_resolve, reject) => {
          rejectSnapshot = reject;
        }),
      checkForUpdates: async () => currentState,
      openReleasePage: async () => currentState,
      subscribe: (listener) => {
        publish = listener;
        return () => undefined;
      }
    };
    let controller!: DesktopUpdateController;
    function Probe() {
      controller = useDesktopUpdate(api);
      return null;
    }
    await act(async () => root.render(<Probe />));
    await act(async () => rejectSnapshot(new Error("stale failure")));
    expect(controller.error).toBe("Update status could not be read.");
    await act(async () => publish(currentState));
    expect(controller.error).toBeNull();
  });

  it("shows a sanitized Download failure once and clears it on recovery", async () => {
    const available: DesktopUpdateState = {
      installedVersion: "0.10.0",
      status: "available",
      release: { version: "0.11.0", summary: "New release" },
      checkedAt: "2026-11-06T00:00:00.000Z"
    };
    let rejectOpen!: (error: Error) => void;
    let resolveOpen!: (state: DesktopUpdateState) => void;
    let openCount = 0;
    const api: DesktopUpdateApi = {
      getState: async () => available,
      checkForUpdates: async () => available,
      openReleasePage: () => {
        openCount += 1;
        return new Promise((resolve, reject) => {
          if (openCount === 1) rejectOpen = reject;
          else resolveOpen = resolve;
        });
      },
      subscribe: () => () => undefined
    };
    function PanelProbe() {
      return <DesktopUpdatePanel update={useDesktopUpdate(api)} />;
    }
    await act(async () => root.render(<PanelProbe />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });
    await act(async () => rejectOpen(new Error("secret token in failure")));

    expect(container.textContent).toContain("Koed 0.11.0 is available");
    expect(container.textContent).toContain(
      "The download could not be opened."
    );
    expect(container.textContent).not.toContain("secret token");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });
    await act(async () => resolveOpen(available));
    expect(container.textContent).not.toContain(
      "The download could not be opened."
    );
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container.textContent).toContain("Koed 0.11.0 is available");
  });

  it("shows the available version without release notes or install actions", () => {
    const html = renderToStaticMarkup(
      <DesktopUpdatePanel
        update={update({
          installedVersion: "0.10.0",
          status: "available",
          release: {
            version: "0.11.0",
            summary: "Safer setup\nMore reliable."
          },
          checkedAt: null
        })}
      />
    );
    expect(html).toContain("0.10.0");
    expect(html).toContain("0.11.0");
    expect(html).not.toContain("Safer setup");
    expect(html).toContain("Download 0.11.0");
    expect(html).not.toContain("koed stop");
    expect(html).not.toContain("How to update");
    expect((html.match(/role="alert"/g) ?? []).length).toBe(0);
    expect(html).not.toMatch(/<button[^>]*>[^<]*(install|restart)/i);
  });

  it("sanitizes errors and exposes no automatic recovery action", () => {
    const html = renderToStaticMarkup(
      <DesktopUpdatePanel
        update={{
          ...update({
            installedVersion: "0.10.0",
            status: "error",
            release: null,
            checkedAt: null
          }),
          error: "Update status could not be checked."
        }}
      />
    );
    expect(html).toContain("Update status could not be checked.");
    expect(html).not.toContain("secret token");
    expect((html.match(/role="alert"/g) ?? []).length).toBe(1);
  });

  it("shows manual check action for current state", () => {
    const html = renderToStaticMarkup(
      <DesktopUpdatePanel
        update={update({
          installedVersion: "0.10.0",
          status: "current",
          release: null,
          checkedAt: null
        })}
      />
    );
    expect(html).toContain("Up to date");
  });

  it("shows a dismissible app-wide notice that stays dismissed for that version", async () => {
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value)
      }
    });
    const available = (version: string) =>
      update({
        installedVersion: "0.10.0",
        status: "available",
        release: { version, summary: "Notes" },
        checkedAt: null
      });
    let opened = 0;
    await act(async () =>
      root.render(
        <DesktopUpdateNotice
          update={{
            ...available("0.11.0"),
            open: async () => {
              opened += 1;
            }
          }}
        />
      )
    );
    expect(container.textContent).toContain("Koed 0.11.0 is ready");
    expect(container.textContent).not.toContain("Notes");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Download")
        ?.click()
    );
    expect(opened).toBe(1);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".desktop-update-notice-close")
        ?.click()
    );
    expect(container.textContent).toBe("");
    expect(store.get("koed.desktop.update.dismissedVersion")).toBe("0.11.0");

    await act(async () =>
      root.render(<DesktopUpdateNotice update={available("0.12.0")} />)
    );
    expect(container.textContent).toContain("Koed 0.12.0 is ready");
  });

  it("shows no notice when Koed is up to date", () => {
    const html = renderToStaticMarkup(
      <DesktopUpdateNotice update={update(currentState)} />
    );
    expect(html).toBe("");
  });
});

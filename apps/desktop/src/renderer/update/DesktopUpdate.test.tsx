// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopUpdatePanel } from "./DesktopUpdate.js";
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

  it("shows available version and plain notes without install actions", () => {
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
    expect(html).toContain("Safer setup\nMore reliable.");
    expect(html).toContain("koed stop --json");
    expect(html).toContain("lifecycle.state: stopped");
    expect((html.match(/role="alert"/g) ?? []).length).toBe(0);
    expect(html).not.toMatch(/<button[^>]*>[^<]*(download|install|restart)/i);
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
    expect(html).toContain("up to date");
  });
});

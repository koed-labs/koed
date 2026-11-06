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

  it("does not let an initial snapshot overwrite a newer event", async () => {
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
      checkedAt: null
    };
    const available: DesktopUpdateState = {
      installedVersion: "0.10.0",
      status: "available",
      release: { version: "0.11.0", summary: "New" },
      checkedAt: null
    };
    await act(async () => {
      publish(available);
      resolveSnapshot(current);
    });
    expect(controller.state).toEqual(available);
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

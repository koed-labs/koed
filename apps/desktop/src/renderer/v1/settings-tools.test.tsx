// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { CliInstallApi } from "../../cli-install/protocol.js";
import { SettingsTools } from "./settings-tools.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("SettingsTools", () => {
  it.each(["privacy", "cli"] as const)(
    "shows current inspection status instead of cached readiness for %s",
    async (tool) => {
      const inspect = vi.fn(async () => {});
      const api: CliInstallApi = {
        getStatus: async () => {
          if (tool === "privacy") await inspect();
          return { available: true, state: "ready", message: "Ready" };
        },
        launcher: async () => {
          if (tool === "cli") await inspect();
          return {
            ownership: "koed",
            target: "valid",
            template: "current",
            helper: "supported",
            version: null,
            pathVisible: true,
            fingerprint: null
          };
        },
        installPrivacy: vi.fn(),
        updatePath: vi.fn(),
        cancel: vi.fn(),
        selectOffline: vi.fn(),
        subscribe: () => () => {}
      };
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const open = () =>
        act(async () => {
          root.render(<SettingsTools api={api} onOpen={vi.fn()} />);
        });
      const close = () => act(async () => root.render(null));
      const card = () =>
        container.querySelector(`[data-settings-page="${tool}"]`)!;
      const badge = () => card().querySelector("small")?.textContent;
      const otherBadge = () =>
        container.querySelector(
          `[data-settings-page="${tool === "privacy" ? "cli" : "privacy"}"] small`
        )?.textContent;
      try {
        await open();
        expect(badge()).toBe("Installed");

        await close();
        const failedCheck = deferred();
        inspect.mockImplementationOnce(() => failedCheck.promise);
        await open();
        expect(badge()).toBe("Checking…");
        expect(card().textContent).not.toContain("Installed");

        await act(async () =>
          failedCheck.reject(new Error("Inspection failed"))
        );
        expect(badge()).toBe("Unavailable");
        expect(card().textContent).toContain("Review setup");
        expect(card().textContent).not.toContain("Installed");
        expect(otherBadge()).toBe("Installed");

        await close();
        const recoveryCheck = deferred();
        inspect.mockImplementationOnce(() => recoveryCheck.promise);
        await open();
        expect(badge()).toBe("Checking…");
        expect(card().textContent).not.toContain("Installed");

        await act(async () => recoveryCheck.resolve());
        expect(badge()).toBe("Installed");
        expect(card().textContent).toContain("Manage");
        expect(inspect).toHaveBeenCalledTimes(3);
        expect(api.installPrivacy).not.toHaveBeenCalled();
        expect(api.updatePath).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    }
  );
});

// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultHqLayoutPreferences } from "../../ipc/hq-layout-preferences-protocol.js";
import type { DesktopApi } from "../../types.js";
import { HqShell, type HqShellActions } from "./HqShell.js";

const actEnvironment = globalThis as {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("HQ shell layout", () => {
  let container: HTMLDivElement;
  let root: Root;
  let isNarrow = false;
  let matchMediaDescriptor: PropertyDescriptor | undefined;
  let innerWidthDescriptor: PropertyDescriptor | undefined;
  let desktopDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    isNarrow = false;
    matchMediaDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "matchMedia"
    );
    innerWidthDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "innerWidth"
    );
    desktopDescriptor = Object.getOwnPropertyDescriptor(window, "koedDesktop");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
      writable: true
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: isNarrow,
        removeEventListener: vi.fn()
      }))
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (matchMediaDescriptor) {
      Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
    } else {
      delete (window as Partial<Window>).matchMedia;
    }
    if (innerWidthDescriptor) {
      Object.defineProperty(window, "innerWidth", innerWidthDescriptor);
    }
    if (desktopDescriptor) {
      Object.defineProperty(window, "koedDesktop", desktopDescriptor);
    } else {
      delete window.koedDesktop;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  const render = async (props: Parameters<typeof HqShell>[0] = {}) => {
    await act(async () => root.render(<HqShell {...props} />));
  };

  it("mounts the shell landmarks and supports keyboard and reset resizing", async () => {
    await render();

    const shell = container.querySelector("[data-hq-shell]");
    expect(shell).not.toBeNull();
    expect(
      shell?.querySelector('aside[aria-label="Project navigation"]')
    ).not.toBeNull();
    expect(
      shell?.querySelector('main[aria-label="HQ workspace"]')
    ).not.toBeNull();
    expect(
      shell?.querySelector('section[aria-label="Project context"]')
    ).not.toBeNull();

    const sidebarHandle = container.querySelector<HTMLElement>(
      '[data-hq-sidebar-handle][role="separator"]'
    );
    const contextHandle = container.querySelector<HTMLElement>(
      '[data-hq-context-handle][role="separator"]'
    );
    expect(sidebarHandle?.getAttribute("aria-valuenow")).toBe("268");
    expect(contextHandle).not.toBeNull();

    await act(async () => {
      sidebarHandle?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
      );
    });
    expect(sidebarHandle?.getAttribute("aria-valuenow")).toBe("276");

    await act(async () => {
      sidebarHandle?.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true })
      );
    });
    expect(sidebarHandle?.getAttribute("aria-valuenow")).toBe("268");

    const originalContextWidth = Number(
      contextHandle?.getAttribute("aria-valuenow")
    );
    await act(async () => {
      contextHandle?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
      );
    });
    expect(Number(contextHandle?.getAttribute("aria-valuenow"))).toBe(
      originalContextWidth + 8
    );
    await act(async () => {
      contextHandle?.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true })
      );
    });
    expect(Number(contextHandle?.getAttribute("aria-valuenow"))).toBe(
      originalContextWidth
    );
  });

  it("uses a trapped modal on narrow screens and restores focus on Escape", async () => {
    isNarrow = true;
    await render();

    const opener = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show project context"]'
    );
    expect(opener).not.toBeNull();
    expect(opener?.hasAttribute("aria-controls")).toBe(false);
    await act(async () => opener?.click());

    const dialog = container.querySelector<HTMLElement>(
      '[role="dialog"][aria-modal="true"]'
    );
    const close = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close project context"]'
    );
    expect(opener?.title).toBe("Hide context");
    expect(dialog?.getAttribute("aria-labelledby")).toBe(
      "hq-context-dialog-title"
    );
    expect(opener?.getAttribute("aria-controls")).toBe("hq-context-dialog");
    expect(
      container.querySelector(".hq-shell__layout")?.hasAttribute("inert")
    ).toBe(true);
    expect(document.activeElement).toBe(close);

    await act(async () => {
      close?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Tab" })
      );
    });
    expect(document.activeElement).toBe(close);

    await act(async () => {
      dialog?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      );
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(
      container.querySelector(".hq-shell__layout")?.hasAttribute("inert")
    ).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(opener?.title).toBe("Show context");
    expect(opener?.hasAttribute("aria-controls")).toBe(false);
  });

  it("opens one persistent project-navigation instance in a trapped narrow drawer", async () => {
    isNarrow = true;
    const sidebar = (
      <aside aria-label="Project navigation" id="hq-project-navigation">
        <button data-hq-project-link="project-a" type="button">
          Project A
        </button>
        <button data-hq-sidebar-group="just-me" type="button">
          Just me
        </button>
        <ul hidden>
          <li>
            <button data-hq-chat-row="folded-chat" type="button">
              Folded Conversation
            </button>
          </li>
        </ul>
        <div data-hq-sidebar-scroll="">
          <span>Scrollable navigation</span>
        </div>
      </aside>
    );
    await render({ sidebar });

    const opener = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show project navigation"]'
    );
    const aside = container.querySelector("#hq-project-navigation");
    expect(opener).not.toBeNull();
    expect(aside).not.toBeNull();
    expect(container.querySelectorAll("#hq-project-navigation")).toHaveLength(
      1
    );
    expect(
      container.querySelector("[data-hq-sidebar-dialog]")?.getAttribute("role")
    ).toBeFalsy();

    await act(async () => opener?.click());
    const dialog = container.querySelector<HTMLElement>(
      '[data-hq-sidebar-dialog][role="dialog"][aria-modal="true"]'
    );
    const close = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close project navigation"]'
    );
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(close);
    expect(opener?.getAttribute("aria-controls")).toBe("hq-sidebar-dialog");
    expect(
      container.querySelector(".hq-shell__workspace")?.hasAttribute("inert")
    ).toBe(true);
    expect(container.querySelector("#hq-project-navigation")).toBe(aside);
    expect(container.querySelectorAll("#hq-project-navigation")).toHaveLength(
      1
    );

    await act(async () => {
      dialog?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Tab",
          shiftKey: true
        })
      );
    });
    expect(document.activeElement).toBe(
      container.querySelector('button[data-hq-sidebar-group="just-me"]')
    );
    await act(async () => {
      dialog?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Tab" })
      );
    });
    expect(document.activeElement).toBe(close);
    expect(
      container.querySelector('button[data-hq-chat-row="folded-chat"]')
    ).not.toBe(document.activeElement);

    await act(async () => {
      dialog?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      );
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(opener?.hasAttribute("aria-controls")).toBe(false);
    expect(
      container.querySelector(".hq-shell__workspace")?.hasAttribute("inert")
    ).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(container.querySelector("#hq-project-navigation")).toBe(aside);

    await act(async () => opener?.click());
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[data-hq-project-link="project-a"]'
        )
        ?.click();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("#hq-project-navigation")).toBe(aside);
  });

  it("moves focus into replacement phone overlays without returning to an inert opener", async () => {
    isNarrow = true;
    const actionsRef = createRef<HqShellActions>();
    await render({ actionsRef });
    await act(async () => actionsRef.current?.toggleSidebar());
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Close project navigation"
    );
    await act(async () => actionsRef.current?.toggleContext());
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Close project context"
    );
    expect(document.activeElement?.closest("[inert]")).toBeNull();
    await act(async () => actionsRef.current?.toggleSidebar());
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Close project navigation"
    );
    expect(document.activeElement?.closest("[inert]")).toBeNull();
  });

  it("does not reopen stale mobile context after hiding it on desktop", async () => {
    isNarrow = true;
    await render();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Show project context"]'
        )
        ?.click();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1280
      });
      isNarrow = false;
      window.dispatchEvent(new Event("resize"));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Hide project context"]'
        )
        ?.click();
    });

    await act(async () => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 390
      });
      isNarrow = true;
      window.dispatchEvent(new Event("resize"));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const show = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show project context"]'
    );
    expect(show?.hasAttribute("aria-controls")).toBe(false);

    await act(async () => show?.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("recalculates the responsive context width when the desktop viewport changes", async () => {
    await render();
    const initialHandle = container.querySelector<HTMLElement>(
      "[data-hq-context-handle]"
    );
    expect(initialHandle?.getAttribute("aria-valuenow")).toBe("397");

    await act(async () => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1600
      });
      window.dispatchEvent(new Event("resize"));
    });
    expect(
      container
        .querySelector("[data-hq-context-handle]")
        ?.getAttribute("aria-valuenow")
    ).toBe("440");
  });

  it("recalculates responsive defaults and retains saved width across narrow clamping", async () => {
    const hqLayout = {
      get: vi.fn(async () => ({
        ...defaultHqLayoutPreferences,
        rightColumnWidth: 560
      })),
      set: vi.fn(async (preferences) => preferences)
    };
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: { hqLayout } as unknown as DesktopApi
    });
    await render();

    const handle = container.querySelector<HTMLElement>(
      '[data-hq-context-handle][role="separator"]'
    );
    expect(handle?.getAttribute("aria-valuenow")).toBe("560");

    await act(async () => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 390
      });
      isNarrow = true;
      window.dispatchEvent(new Event("resize"));
    });
    expect(handle?.isConnected).toBe(false);

    await act(async () => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1280
      });
      isNarrow = false;
      window.dispatchEvent(new Event("resize"));
    });
    expect(
      container
        .querySelector("[data-hq-context-handle]")
        ?.getAttribute("aria-valuenow")
    ).toBe("560");
  });

  it("keeps the center column usable when both desktop panes reach their caps", async () => {
    const hqLayout = {
      get: vi.fn(async () => ({
        ...defaultHqLayoutPreferences,
        sidebarCollapsed: false,
        sidebarWidth: 440,
        rightColumnWidth: 16_384
      })),
      set: vi.fn(async (preferences) => preferences)
    };
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: { hqLayout } as unknown as DesktopApi
    });
    await render();

    const sidebarHandle = container.querySelector<HTMLElement>(
      "[data-hq-sidebar-handle]"
    );
    const contextHandle = container.querySelector<HTMLElement>(
      "[data-hq-context-handle]"
    );
    expect(sidebarHandle?.getAttribute("aria-valuemax")).toBe("440");
    expect(contextHandle?.getAttribute("aria-valuemax")).toBe("598");
    expect(sidebarHandle?.getAttribute("aria-valuenow")).toBe("440");
    expect(contextHandle?.getAttribute("aria-valuenow")).toBe("598");

    await act(async () => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 761
      });
      window.dispatchEvent(new Event("resize"));
    });
    expect(sidebarHandle?.getAttribute("aria-valuemax")).toBe("219");
    expect(contextHandle?.getAttribute("aria-valuemax")).toBe("300");
    expect(sidebarHandle?.getAttribute("aria-valuenow")).toBe("219");
    expect(contextHandle?.getAttribute("aria-valuenow")).toBe("300");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Hide project context"]'
        )
        ?.click();
    });
    expect(sidebarHandle?.getAttribute("aria-valuemax")).toBe("440");
    expect(sidebarHandle?.getAttribute("aria-valuenow")).toBe("440");
    expect(contextHandle?.isConnected).toBe(false);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Show project context"]'
        )
        ?.click();
    });
    expect(sidebarHandle?.getAttribute("aria-valuemax")).toBe("219");
    expect(sidebarHandle?.getAttribute("aria-valuenow")).toBe("219");
    expect(
      container
        .querySelector<HTMLElement>("[data-hq-context-handle]")
        ?.getAttribute("aria-valuemax")
    ).toBe("300");
    expect(hqLayout.set).toHaveBeenCalled();
    expect(hqLayout.set.mock.calls.at(-1)?.[0]).toMatchObject({
      sidebarCollapsed: false,
      sidebarWidth: 440,
      rightColumnWidth: 16_384,
      rightColumnHidden: false
    });
  });

  it("persists the requested right-column visibility and width through the Desktop API", async () => {
    const set = vi.fn(async (preferences) => preferences);
    const hqLayout = {
      get: vi.fn(async () => defaultHqLayoutPreferences),
      set
    };
    const api = { hqLayout } as unknown as DesktopApi;
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: api
    });
    await render();

    const handle = container.querySelector<HTMLElement>(
      '[data-hq-context-handle][role="separator"]'
    );
    const original = Number(handle?.getAttribute("aria-valuenow"));
    vi.useFakeTimers();
    await act(async () => {
      handle?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
      );
      handle?.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, key: "ArrowRight" })
      );
    });
    expect(set).toHaveBeenCalledOnce();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Hide project context"]'
        )
        ?.click();
    });

    expect(set).toHaveBeenCalledTimes(2);
    const saved = set.mock.calls.at(-1)?.[0];
    expect(saved?.rightColumnWidth).toBe(original - 8);
    expect(saved?.rightColumnHidden).toBe(true);
    expect(
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Show project context"]'
        )
        ?.hasAttribute("aria-controls")
    ).toBe(false);
  });

  it("persists compact mode immediately and restores the saved expanded width", async () => {
    const set = vi.fn(async (preferences) => preferences);
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: {
        hqLayout: {
          get: vi.fn(async () => defaultHqLayoutPreferences),
          set
        }
      } as unknown as DesktopApi
    });
    await render();
    vi.useFakeTimers();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Collapse sidebar"]'
        )
        ?.click();
    });

    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({
      ...defaultHqLayoutPreferences,
      sidebarCollapsed: true
    });
    expect(
      container
        .querySelector("[data-hq-shell]")
        ?.hasAttribute("data-hq-compact")
    ).toBe(true);
    expect(
      container
        .querySelector("[data-hq-sidebar-handle]")
        ?.hasAttribute("hidden")
    ).toBe(true);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Expand sidebar"]')
        ?.click()
    );
    expect(
      container
        .querySelector("[data-hq-sidebar-handle]")
        ?.getAttribute("aria-valuenow")
    ).toBe("268");
    expect(set).toHaveBeenLastCalledWith(defaultHqLayoutPreferences);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a safe status when saving layout preferences fails", async () => {
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: {
        hqLayout: {
          get: vi.fn(async () => defaultHqLayoutPreferences),
          set: vi.fn(async () => {
            throw new Error("/private/path/hq-layout-preferences.json");
          })
        }
      } as unknown as DesktopApi
    });
    await render();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Hide project context"]'
        )
        ?.click();
    });

    const status = await vi.waitFor(() => {
      const element = container.querySelector('[role="status"]');
      expect(element?.textContent).toContain(
        "Layout preferences are unavailable."
      );
      return element;
    });
    expect(status?.textContent).toContain(
      "Changes may reset when you reopen Koed."
    );
    expect(status?.textContent).not.toContain("/private/path");
  });
});

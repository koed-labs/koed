// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Storage } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationShell } from "./NavigationShell.js";

let container: HTMLDivElement;
let root: Root;

function renderShell() {
  return act(async () => {
    root.render(
      <NavigationShell
        projects={[]}
        route={{ kind: "home" }}
        scopeKey="owner"
        onSelect={() => {}}
        onHome={() => {}}
        onSettings={() => {}}
        onBack={() => {}}
        onForward={() => {}}
        canGoBack={false}
        canGoForward={false}
        onRetry={() => {}}
      >
        Home
      </NavigationShell>
    );
  });
}

const resizeHandle = () =>
  container.querySelector<HTMLDivElement>('[role="separator"][aria-valuenow]');

const layoutWidth = () =>
  container
    .querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')!
    .style.getPropertyValue("--sidebar-width");

const setWindowWidth = (width: number) => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width
  });
  window.dispatchEvent(new Event("resize"));
};

const press = (element: HTMLElement, key: string) =>
  act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

const pointer = (element: HTMLElement, type: string, clientX: number) =>
  act(async () => {
    element.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        clientX,
        isPrimary: true,
        pointerId: 1,
        pointerType: "mouse"
      })
    );
  });

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new Storage()
  });
  setWindowWidth(1320);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("Projects and Anchors sidebar resizing", () => {
  it("captures the pointer, previews the width and restores the finished width after collapse and remount", async () => {
    await renderShell();
    const handle = resizeHandle()!;
    expect(document.getElementById(handle.getAttribute("aria-controls")!)).toBe(
      container.querySelector('[aria-label="Projects and Anchors"]')
    );
    expect(layoutWidth()).toBe("280px");
    handle.setPointerCapture = vi.fn();
    await pointer(handle, "pointerdown", 340);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    await pointer(handle, "pointermove", 460);
    expect(layoutWidth()).toBe("400px");
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    await pointer(handle, "pointerup", 460);

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle navigation"]'
    )!;
    await act(async () => toggle.click());
    expect(resizeHandle()).toBeNull();
    await act(async () => toggle.click());
    expect(resizeHandle()?.getAttribute("aria-valuenow")).toBe("400");

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderShell();
    expect(layoutWidth()).toBe("400px");
  });

  it("uses the keyboard and clamps to the available space without losing the preference", async () => {
    await renderShell();
    const handle = resizeHandle()!;
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    await press(handle, "ArrowRight");
    expect(layoutWidth()).toBe("296px");
    await press(handle, "ArrowLeft");
    expect(layoutWidth()).toBe("280px");
    await press(handle, "Home");
    expect(handle.getAttribute("aria-valuenow")).toBe("220");
    await press(handle, "End");
    expect(layoutWidth()).toBe("520px");

    await act(async () => setWindowWidth(960));
    expect(handle.getAttribute("aria-valuemax")).toBe("420");
    expect(layoutWidth()).toBe("420px");
    await press(handle, "ArrowRight");
    await act(async () => setWindowWidth(1320));
    expect(layoutWidth()).toBe("520px");
  });

  it("discards a drag canceled before release", async () => {
    window.localStorage.setItem("koed:sidebar-width", "350");
    await renderShell();
    const handle = resizeHandle()!;
    handle.setPointerCapture = vi.fn();
    await pointer(handle, "pointerdown", 410);
    await pointer(handle, "pointermove", 300);
    expect(layoutWidth()).toBe("240px");
    await pointer(handle, "pointercancel", 300);
    expect(layoutWidth()).toBe("350px");
    expect(window.localStorage.getItem("koed:sidebar-width")).toBe("350");
  });

  it("keeps the narrow sidebar Sheet free of resize controls", async () => {
    setWindowWidth(900);
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      const result = matchMedia(query);
      if (query === "(max-width: 959px)") {
        Object.defineProperty(result, "matches", { value: true });
      }
      return result;
    });
    await renderShell();
    const open = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open navigation"]'
    )!;
    await act(async () => open.click());
    expect(document.querySelector('[data-mobile="true"]')).not.toBeNull();
    expect(
      document.querySelector('[role="separator"][aria-valuenow]')
    ).toBeNull();
  });
});

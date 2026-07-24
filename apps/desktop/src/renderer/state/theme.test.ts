// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../types.js";
import { ThemeStore } from "./theme.js";

afterEach(() => {
  delete window.koedDesktop;
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("ThemeStore", () => {
  it("loads and applies the main-process persisted theme", async () => {
    window.koedDesktop = {
      invoke: vi.fn(),
      theme: {
        get: vi.fn(async () => "dark"),
        set: vi.fn()
      }
    } as DesktopApi;
    const store = new ThemeStore();
    await store.load();
    expect(store.current()).toMatchObject({
      loading: false,
      preference: "dark",
      resolved: "dark"
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    store.dispose();
  });

  it("persists changes through narrow theme IPC", async () => {
    const set = vi.fn(async (preference: "light" | "dark" | "system") => ({
      preference,
      resolvedDark: false
    }));
    window.koedDesktop = {
      invoke: vi.fn(),
      theme: { get: vi.fn(async () => "system"), set }
    } as DesktopApi;
    const store = new ThemeStore();
    await store.set("light");
    expect(set).toHaveBeenCalledWith("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    store.dispose();
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RailKin } from "./FloatingKin.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("glances to the Koed logo when quiet and back to the live Kin on hover", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  const kin = () => mount.querySelector<HTMLElement>(".fk-rail-kin")!;
  const pixelkin = () => kin().querySelector(".v1-pixelkin");
  try {
    await act(async () => root.render(<RailKin active />));
    expect(kin().dataset.phase).toBe("live");
    expect(pixelkin()?.getAttribute("data-expression")).toBe("happy");

    await act(async () => root.render(<RailKin active={false} />));
    expect(kin().dataset.phase).toBe("leaving");
    expect(pixelkin()?.getAttribute("data-expression")).toBe("joy");
    // A 0.7s glance, then a 0.45s fade.
    await act(async () => vi.advanceTimersByTime(1_100));
    expect(kin().dataset.phase).toBe("leaving");
    await act(async () => vi.advanceTimersByTime(50));
    expect(kin().dataset.phase).toBe("logo");
    expect(pixelkin()).toBeNull();
    expect(kin().querySelector(".fk-rail-logo")).not.toBeNull();

    await act(async () =>
      kin().dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    );
    expect(kin().dataset.phase).toBe("arriving");
    expect(pixelkin()?.getAttribute("data-expression")).toBe("joy");
    await act(async () => vi.advanceTimersByTime(1_400));
    expect(kin().dataset.phase).toBe("live");
    expect(pixelkin()?.getAttribute("data-expression")).toBe("happy");
    await act(async () =>
      kin().dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))
    );
    await act(async () => vi.advanceTimersByTime(4_000));
    expect(kin().dataset.phase).toBe("live");
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(kin().dataset.phase).toBe("leaving");
    await act(async () => vi.advanceTimersByTime(1_400));
    expect(kin().dataset.phase).toBe("logo");
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});

it("starts as the logo when nothing is recent", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    await act(async () => root.render(<RailKin active={false} />));
    expect(
      mount.querySelector<HTMLElement>(".fk-rail-kin")!.dataset.phase
    ).toBe("logo");
    expect(mount.querySelector(".v1-pixelkin")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@koed/shared/agent-contract";
import { Pixelkin } from "./Pixelkin.js";
import { pixelkinSpec, renderPixelkin } from "./pixelkin-renderer.js";

const agent = {
  id: "00000000-0000-4000-8000-000000000502",
  name: "Pip",
  look: {}
} as Agent;
const signature = (pixels: Uint8ClampedArray) => {
  let h = 2166136261;
  for (const byte of pixels) h = Math.imul(h ^ byte, 16777619);
  return (h >>> 0).toString(16);
};

describe("Pixelkin Lab HQ avatar", () => {
  it("persists distinct optional top accessories while preserving existing unadorned looks", () => {
    const renderTop = (top: string) => {
      const spec = pixelkinSpec({
        ...agent,
        look: { pixelkin: { seed: agent.id, top } }
      });
      return signature(renderPixelkin(spec));
    };
    expect(renderTop("none")).toBe(
      signature(renderPixelkin(pixelkinSpec(agent)))
    );
    expect(renderTop("unknown")).toBe(renderTop("none"));
    expect(
      new Set(["none", "antenna", "sprout", "ears"].map(renderTop)).size
    ).toBe(4);
    const adorned = pixelkinSpec({
      ...agent,
      look: { pixelkin: { top: "sprout" } }
    });
    expect(adorned.top).toBe("sprout");
    expect(signature(renderPixelkin(adorned, 0, 0, 1))).not.toBe(
      signature(renderPixelkin(adorned))
    );
  });
  it("renders a stable seeded real body and separate moving/blinking face", () => {
    const spec = pixelkinSpec(agent);
    const neutral = renderPixelkin(spec);
    expect(neutral.length).toBe(64 * 64 * 4);
    expect(
      neutral.some((value, index) => index % 4 === 3 && value === 255)
    ).toBe(true);
    expect(signature(neutral)).toMatchInlineSnapshot(`"b914843b"`);
    expect(signature(renderPixelkin(spec, 1, 0, 0))).not.toBe(
      signature(neutral)
    );
    expect(signature(renderPixelkin(spec, 0, 0, 1))).not.toBe(
      signature(neutral)
    );
    expect(signature(renderPixelkin(pixelkinSpec(agent)))).toBe(
      signature(neutral)
    );
  });

  it("uses persisted look fields and keeps distinct Agent identity stable", () => {
    const custom = pixelkinSpec({
      ...agent,
      look: {
        pixelkin: {
          seed: 12,
          body: { shape: "capsule" },
          palette: { base: "#ef5f89" }
        }
      }
    });
    expect(custom.body.shape).toBe("capsule");
    expect(custom.palette.base).toBe("#ef5f89");
    expect(signature(renderPixelkin(custom))).not.toBe(
      signature(renderPixelkin(pixelkinSpec(agent)))
    );
    expect(
      signature(
        renderPixelkin(
          pixelkinSpec({ ...agent, id: "00000000-0000-4000-8000-000000000503" })
        )
      )
    ).not.toBe(signature(renderPixelkin(pixelkinSpec(agent))));
  });
});

describe("Pixelkin motion bounds", () => {
  let host: HTMLDivElement;
  let root: Root;
  let observer: {
    callback: IntersectionObserverCallback;
    disconnect: () => void;
  };
  let reduced = false;
  let drawCount = 0;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    reduced = false;
    drawCount = 0;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          observer = { callback, disconnect: vi.fn() };
        }
        observe() {}
        disconnect() {
          observer.disconnect();
        }
      }
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 1)
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      window.clearTimeout(id)
    );
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return reduced;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4) }),
      putImageData: () => {
        drawCount++;
      }
    } as unknown as CanvasRenderingContext2D);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("stops updates offscreen and when hidden, and resumes on visibility", async () => {
    await act(async () => root.render(<Pixelkin agent={agent} />));
    await act(async () =>
      observer.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    );
    await act(async () => vi.advanceTimersByTime(2));
    const first = drawCount;
    expect(first).toBeGreaterThan(0);
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 1000, clientY: 0 })
    );
    await act(async () => vi.advanceTimersByTime(2));
    expect(drawCount).toBeGreaterThan(first);
    await act(async () =>
      observer.callback(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    );
    const stopped = drawCount;
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(drawCount).toBe(stopped);
    await act(async () =>
      observer.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    );
    await act(async () => vi.advanceTimersByTime(2));
    const beforeHide = drawCount;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 1000, clientY: 0 })
    );
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(drawCount).toBe(beforeHide);
  });
  it("holds a neutral still face under reduced motion", async () => {
    reduced = true;
    await act(async () => root.render(<Pixelkin agent={agent} />));
    await act(async () =>
      observer.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    );
    await act(async () => vi.advanceTimersByTime(2));
    const first = drawCount;
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 1000, clientY: 0 })
    );
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(drawCount).toBe(first);
  });
});

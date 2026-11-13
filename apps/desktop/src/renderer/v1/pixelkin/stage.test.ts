// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { KIN_DEFAULTS } from "./vendor/index.js";
import { KinSpin } from "../onboarding/kin-spin.js";
import { addPixelkin, createPixelkinActor } from "./stage.js";
import { kinStageSurface } from "./presentation.js";

const engine = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("./vendor/index.js", async (original) => ({
  ...(await original<object>()),
  CrowdGLRenderer: class {
    available = true;
    canvas = document.createElement("canvas");
    render = engine.render;
  }
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  engine.render.mockClear();
});

describe("Kin stage rendering", () => {
  it.each([false, true])(
    "ignores hidden spins for painting and scheduling (reduced motion: %s)",
    (reduced) => {
      let frame: FrameRequestCallback | undefined;
      let intersection: IntersectionObserverCallback = () => {};
      vi.stubGlobal("WebGL2RenderingContext", class {});
      vi.stubGlobal(
        "requestAnimationFrame",
        (callback: FrameRequestCallback) => {
          frame = callback;
          return 1;
        }
      );
      vi.stubGlobal("cancelAnimationFrame", () => {
        frame = undefined;
      });
      vi.stubGlobal("matchMedia", () => ({
        matches: reduced,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }));
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          constructor(callback: IntersectionObserverCallback) {
            intersection = callback;
          }
          observe() {}
          unobserve() {}
          disconnect() {}
        }
      );
      const makeActor = () => {
        const canvas = document.createElement("canvas");
        vi.spyOn(canvas, "getContext").mockReturnValue({
          clearRect: vi.fn(),
          drawImage: vi.fn()
        } as unknown as CanvasRenderingContext2D);
        return createPixelkinActor(canvas, KIN_DEFAULTS, 100);
      };
      const spinner = makeActor();
      const idle = makeActor();
      spinner.spin = new KinSpin();
      spinner.spin.begin(0, 0, 400, -0.14);
      const removeSpinner = addPixelkin(spinner);
      const removeIdle = addPixelkin(idle);
      const runFrame = (time: number) => {
        const callback = frame;
        frame = undefined;
        callback?.(time);
      };
      const setVisible = (visible: boolean) =>
        intersection(
          [
            {
              target: spinner.canvas,
              isIntersecting: visible,
              boundingClientRect: new DOMRect(),
              intersectionRect: new DOMRect(),
              intersectionRatio: visible ? 1 : 0,
              rootBounds: null,
              time: 0
            }
          ],
          {} as IntersectionObserver
        );
      try {
        runFrame(100);
        setVisible(false);
        engine.render.mockClear();
        for (let i = 1; i <= 60; i++) runFrame(100 + i * (1000 / 60));
        if (reduced) {
          expect(frame).toBeUndefined();
          expect(engine.render.mock.calls.length).toBeLessThanOrEqual(1);
        } else {
          expect(engine.render.mock.calls.length).toBeGreaterThanOrEqual(29);
          expect(engine.render.mock.calls.length).toBeLessThanOrEqual(31);
        }
        expect(spinner.spin.active).toBe(true);
        setVisible(true);
        expect(frame).toBeDefined();
        engine.render.mockClear();
        runFrame(1200);
        expect(engine.render).toHaveBeenCalledTimes(2);
        expect(frame).toBeDefined();
        runFrame(1216);
        expect(engine.render).toHaveBeenCalledTimes(4);
      } finally {
        removeSpinner();
        removeIdle();
      }
    }
  );

  it.each([1, 2, 3, 4])(
    "retains onboarding detail on a %ix display",
    (ratio) => {
      let paint: FrameRequestCallback = () => {};
      vi.stubGlobal("WebGL2RenderingContext", class {});
      vi.stubGlobal("devicePixelRatio", ratio);
      vi.stubGlobal(
        "requestAnimationFrame",
        (callback: FrameRequestCallback) => {
          paint = callback;
          return 1;
        }
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      vi.stubGlobal("matchMedia", () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }));
      const canvas = document.createElement("canvas");
      const drawImage = vi.fn();
      vi.spyOn(canvas, "getContext").mockReturnValue({
        clearRect: vi.fn(),
        drawImage
      } as unknown as CanvasRenderingContext2D);
      const actor = createPixelkinActor(canvas, KIN_DEFAULTS, 200, "stage");
      const remove = addPixelkin(actor);
      try {
        paint(100);
        const pixels = 200 * Math.max(2, Math.min(ratio, 3));
        expect(engine.render).toHaveBeenCalledWith(
          expect.objectContaining({
            ...kinStageSurface(-1.25),
            width: pixels,
            height: pixels,
            outlineViewport: { width: 200, height: 200 },
            paletteMode: undefined
          })
        );
        expect(canvas.width).toBe(pixels);
        expect(drawImage).toHaveBeenLastCalledWith(
          expect.any(HTMLCanvasElement),
          0,
          0,
          pixels,
          pixels,
          0,
          0,
          pixels,
          pixels
        );
      } finally {
        remove();
      }
    }
  );
});

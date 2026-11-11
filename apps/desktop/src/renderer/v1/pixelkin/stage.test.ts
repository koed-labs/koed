// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { KIN_DEFAULTS } from "./vendor/index.js";
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

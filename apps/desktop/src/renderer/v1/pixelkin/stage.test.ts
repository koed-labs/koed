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
  describe("idle rendering", () => {
    const setup = (focused: boolean) => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("WebGL2RenderingContext", class {});
      vi.stubGlobal(
        "requestAnimationFrame",
        (callback: FrameRequestCallback) => {
          frames.push(callback);
          return frames.length;
        }
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      vi.stubGlobal("matchMedia", () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }));
      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(focused);
      const canvas = document.createElement("canvas");
      vi.spyOn(canvas, "getContext").mockReturnValue({
        clearRect: vi.fn(),
        drawImage: vi.fn()
      } as unknown as CanvasRenderingContext2D);
      const actor = createPixelkinActor(canvas, KIN_DEFAULTS, 64, "avatar");
      const remove = addPixelkin(actor);
      return { frames, hasFocus, actor, remove };
    };

    it("paints once and stops while another app has focus", () => {
      const { frames, remove } = setup(false);
      try {
        expect(frames).toHaveLength(1);
        frames[0]!(100);
        expect(engine.render).toHaveBeenCalledTimes(1);
        // No further frames are scheduled until the window has focus.
        expect(frames).toHaveLength(1);
      } finally {
        remove();
      }
    });

    it("resumes when the window regains focus", () => {
      const { frames, hasFocus, remove } = setup(false);
      try {
        frames[0]!(100);
        hasFocus.mockReturnValue(true);
        window.dispatchEvent(new Event("focus"));
        expect(frames).toHaveLength(2);
        frames[1]!(200);
        expect(frames).toHaveLength(3);
      } finally {
        remove();
      }
    });

    it("stops scheduling frames while no Kin is on screen", () => {
      const { frames, actor, remove } = setup(true);
      try {
        actor.visible = false;
        frames[0]!(100);
        expect(engine.render).not.toHaveBeenCalled();
        expect(frames).toHaveLength(1);
      } finally {
        remove();
      }
    });
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { KIN_DEFAULTS } from "@koed-labs/kin-engine";
import { KinSpin } from "../onboarding/kin-spin.js";
import {
  addPixelkin,
  createPixelkinActor,
  pixelkinLookTarget,
  setPixelkinKin,
  type PixelkinActor,
  type PixelkinCuriosity
} from "./stage.js";
import { kinStageSize, kinStageSurface } from "./presentation.js";

const engine = vi.hoisted(() => ({
  ready: Promise.resolve(),
  render: vi.fn()
}));
vi.mock("@koed-labs/kin-engine", async (original) => ({
  ...(await original<object>()),
  CrowdGLRenderer: class {
    available = true;
    canvas = document.createElement("canvas");
    get ready() {
      return engine.ready;
    }
    render = engine.render;
  }
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  engine.render.mockClear();
});

describe("Kin stage rendering", () => {
  it("caps lower-resolution stages without stretching them or enlarging small stages", () => {
    vi.stubGlobal("devicePixelRatio", 1);
    expect(kinStageSize(320, 240, "classic")).toEqual({
      width: 96,
      height: 72
    });
    expect(kinStageSize(320, 240, "balanced")).toEqual({
      width: 160,
      height: 120
    });
    expect(kinStageSize(320, 240, "max")).toEqual({ width: 640, height: 480 });
    expect(kinStageSize(30, 26, "classic")).toEqual({ width: 60, height: 52 });
  });
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
  describe("idle rendering", () => {
    const setup = (
      focused: boolean,
      options?: Parameters<typeof addPixelkin>[1]
    ) => {
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
      const remove = addPixelkin(actor, options);
      return { frames, hasFocus, actor, remove };
    };

    it("passes a custom gradient endpoint with the existing canvas palette", () => {
      const { frames, actor, remove } = setup(false);
      setPixelkinKin(actor, {
        ...KIN_DEFAULTS,
        palette: { base: "#3083ff", grayscale: false, gradient: true }
      });
      actor.gradientTop = "#e8d31a";
      try {
        frames[0]!(100);
        expect(engine.render).toHaveBeenCalledWith(
          expect.objectContaining({
            paletteMode: "canvas",
            objects: [
              expect.objectContaining({
                member: expect.objectContaining({
                  palette: "#3083ff",
                  gradient: true,
                  gradientComplement: "#e8d31a"
                })
              })
            ]
          })
        );
      } finally {
        remove();
      }
    });

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

    it("repaints a still Kin once when accessory artwork finishes loading", async () => {
      const { frames, remove } = setup(true, { still: true });
      let finishLoad!: () => void;
      const ready = new Promise<void>((resolve) => {
        finishLoad = resolve;
      });
      engine.render.mockImplementationOnce(() => {
        engine.ready = ready;
      });
      try {
        frames[0]!(100);
        expect(frames).toHaveLength(1);
        finishLoad();
        await ready;
        expect(frames).toHaveLength(2);
        frames[1]!(150);
        await ready;
        expect(engine.render).toHaveBeenCalledTimes(2);
        expect(frames).toHaveLength(2);
      } finally {
        remove();
      }
    });

    it("keeps a visible opt-in Kin animated after blur, without painting other Kin", () => {
      const { frames, hasFocus, actor, remove } = setup(true, {
        animateUnfocused: true
      });
      const removeOther = addPixelkin(
        createPixelkinActor(actor.canvas, KIN_DEFAULTS, 40)
      );
      try {
        frames.at(-1)!(100);
        engine.render.mockClear();
        hasFocus.mockReturnValue(false);
        window.dispatchEvent(new Event("blur"));
        frames.at(-1)!(140);
        expect(engine.render).toHaveBeenCalledTimes(1);
        frames.at(-1)!(180);
        expect(engine.render).toHaveBeenCalledTimes(2);
        actor.visible = false;
        const count = frames.length;
        frames.at(-1)!(220);
        expect(frames).toHaveLength(count);
      } finally {
        removeOther();
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

describe("Kin curiosity", () => {
  const pointer = { x: 500, y: 500 };
  const curious = (curiosity: PixelkinCuriosity | null) =>
    ({ canvas: document.createElement("canvas"), curiosity }) as PixelkinActor;
  // A fixed sequence stands in for Math.random.
  const sequence = (...values: number[]) => {
    let next = 0;
    return () => values[next++ % values.length]!;
  };

  it("follows the pointer unless curious", () => {
    expect(pixelkinLookTarget(curious(null), 100, pointer)).toBe(pointer);
  });

  it("watches a lure over the pointer and anything it is glancing at", () => {
    const coin = { x: 10, y: 20 };
    let lure: typeof coin | null = coin;
    const actor = curious({
      lure: () => lure,
      interests: () => [{ x: 0, y: 0 }]
    });
    expect(pixelkinLookTarget(actor, 0, pointer, () => 0)).toBe(coin);
    lure = null;
    expect(pixelkinLookTarget(actor, 0, pointer, () => 0)).toEqual({
      x: 0,
      y: 0
    });
  });

  it("glances at a few nearby things in turn, then looks back", () => {
    const far = { x: 900, y: 0 };
    const start = { x: 0, y: 0 };
    const near = { x: 20, y: 0 };
    const nearer = { x: 10, y: 0 };
    const actor = curious({
      lure: () => null,
      interests: () => [start, far, near, nearer]
    });
    actor.glance = { stops: [], next: 1 };
    // A 2s glance starting at `start`, with three stops, each the nearest
    // left to the one before; the next glance comes 8s after it ends.
    const random = sequence(1 / 3, 0, 0.99, 0, 0, 0);
    const at = (now: number) => pixelkinLookTarget(actor, now, pointer, random);
    expect(at(0.5)).toBe(pointer);
    expect(at(1)).toBe(start);
    expect(at(1.7)).toBe(nearer);
    expect(at(2.4)).toBe(near);
    expect(at(3.1)).toBe(pointer);
    expect(actor.glance.next).toBe(11);
  });
});

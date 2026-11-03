// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingKin } from "./LoadingKin.js";
const engine = vi.hoisted(() => ({ render: vi.fn(), lose: vi.fn() }));
vi.mock("../pixelkin/vendor/index.js", async (original) => ({
  ...(await original<object>()),
  CrowdGLRenderer: class {
    available = true;
    canvas = document.createElement("canvas");
    gl = { getExtension: () => ({ loseContext: engine.lose }) };
    render = engine.render;
  }
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("onboarding Kin lifecycle", () => {
  let root: Root;
  let host: HTMLDivElement;
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    host?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    engine.render.mockClear();
    engine.lose.mockClear();
  });
  async function render(reduced = false, initialized = true, available = true) {
    let id = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const motion = new Set<() => void>();
    const media = {
      matches: reduced,
      addEventListener: (_event: string, listener: () => void) =>
        motion.add(listener),
      removeEventListener: (_event: string, listener: () => void) =>
        motion.delete(listener)
    };
    vi.stubGlobal("WebGL2RenderingContext", available ? class {} : undefined);
    vi.stubGlobal("matchMedia", () => media);
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      frames.set(++id, fn);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect = disconnect;
      }
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <LoadingKin
          initialized={initialized}
          complete={false}
          stage={0}
          midpointReached={false}
        />
      )
    );
    const paint = async (time: number) => {
      const pending = [...frames.values()];
      frames.clear();
      await act(async () => pending.forEach((fn) => fn(time)));
    };
    return { frames, motion, media, disconnect, paint };
  }
  it("uses a static expression under reduced motion and releases the renderer on unmount", async () => {
    const { paint, frames, motion, disconnect } = await render(true);
    await paint(100);
    expect(engine.render).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    await act(async () =>
      root.render(<LoadingKin complete stage={1} midpointReached={false} />)
    );
    await paint(140);
    const scene = engine.render.mock.calls.at(-1)![0];
    expect(scene.objects[0].member.expressionFrom).toBe("joy");
    await act(async () => root.unmount());
    root = undefined as unknown as Root;
    expect(motion.size).toBe(0);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(engine.lose).toHaveBeenCalledOnce();
    expect(host.querySelector("canvas")).toBeNull();
  });
  it("stops painting in the background and cannot restart after context loss", async () => {
    const { paint, frames } = await render();
    await paint(100);
    expect(frames.size).toBe(1);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    expect(frames.size).toBe(0);
    hidden.mockReturnValue(false);
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    await paint(160);
    await act(async () =>
      host.querySelector("canvas")!.dispatchEvent(new Event("webglcontextlost"))
    );
    expect(host.querySelector('[data-kin-state="fallback"]')).toBeTruthy();
    expect(frames.size).toBe(0);
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    expect(frames.size).toBe(0);
  });
  it("treats first inspection as a baseline without celebrating existing stages", async () => {
    const { paint } = await render(true, false);
    await paint(100);
    const initialSkin = host
      .querySelector(".lp-kin-scene")
      ?.getAttribute("data-kin-skin");
    await act(async () =>
      root.render(
        <LoadingKin initialized complete stage={5} midpointReached={false} />
      )
    );
    await paint(140);
    expect(
      host.querySelector(".lp-kin-scene")?.getAttribute("data-kin-skin")
    ).toBe(initialSkin);
    expect(
      host.querySelector(".lp-kin-scene")?.getAttribute("data-kin-animating")
    ).toBe("false");
  });
  it("shows the CSS fallback when WebGL2 is unavailable", async () => {
    const { frames } = await render(false, true, false);
    expect(
      host.querySelector('[data-kin-state="fallback"] .lp-kin-fallback')
    ).toBeTruthy();
    expect(engine.render).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
});

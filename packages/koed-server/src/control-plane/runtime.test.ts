import { describe, expect, it, vi } from "vitest";
import { startKoedServer } from "../start.js";
import { startControlPlaneRuntime } from "./runtime.js";

vi.mock("../start.js", () => ({ startKoedServer: vi.fn() }));

const input = () => ({
  admission: {} as never,
  environment: {},
  capability: {} as never,
  onReady: vi.fn(),
  persistGenerationBeforeEffects: vi.fn()
});

describe("control plane runtime session", () => {
  it("routes stop through the abort signal and reports confirmed cleanup", async () => {
    let observedSignal: AbortSignal | undefined;
    vi.mocked(startKoedServer).mockImplementationOnce(async (options) => {
      observedSignal = options?.signal;
      await new Promise<void>((resolve) =>
        observedSignal!.addEventListener("abort", () => resolve(), {
          once: true
        })
      );
      options?.onCleanupOutcome?.({ clean: true });
    });
    const session = startControlPlaneRuntime(input());
    await Promise.resolve();
    expect(observedSignal?.aborted).toBe(false);
    session.stop();
    expect(await session.done).toEqual({ clean: true });
  });

  it("does not infer clean shutdown when no outcome was reported", async () => {
    vi.mocked(startKoedServer).mockResolvedValueOnce();
    expect(await startControlPlaneRuntime(input()).done).toEqual({
      clean: false
    });
  });

  it("reports failed startup without inventing a clean outcome", async () => {
    vi.mocked(startKoedServer).mockRejectedValueOnce(
      new Error("startup failed")
    );
    expect(await startControlPlaneRuntime(input()).done).toEqual({
      clean: false,
      error: "startup failed"
    });
  });
});

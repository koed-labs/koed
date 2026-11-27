import { describe, expect, it, vi } from "vitest";
import { StartupCancellationError, startKoedServer } from "../start.js";
import { createControlPlaneHostCore } from "./host-core.js";
import { startControlPlaneRuntime } from "./runtime.js";
import type { ControlIntent } from "./state.js";

vi.mock("../start.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../start.js")>()),
  startKoedServer: vi.fn()
}));

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

  it.each(["before dispatch", "in flight"])(
    "allows explicit Start after Stop %s",
    async (when) => {
      let intent: ControlIntent = {
        schemaVersion: 1,
        revision: 0,
        stopIntent: false,
        backgroundEnabled: false,
        persistentCli: false,
        runtimeClean: true,
        protectedGenerationId: null
      };
      let session: ReturnType<typeof startControlPlaneRuntime> | undefined;
      const startRuntime: Parameters<
        typeof createControlPlaneHostCore
      >[0]["startRuntime"] = (callbacks) =>
        (session = startControlPlaneRuntime({ ...input(), ...callbacks }));
      const core = createControlPlaneHostCore({
        instanceId: "test",
        store: {
          read: () => intent,
          initialize: vi.fn(),
          write: (next) => {
            intent = next;
          }
        },
        startRuntime
      });
      const start = vi.mocked(startKoedServer);
      start.mockClear();
      if (when === "in flight") {
        start.mockImplementationOnce(async (options) => {
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true
            })
          );
          options?.onCleanupOutcome?.({ clean: true });
          throw new StartupCancellationError(
            "authenticated runtime selection failed: stopped"
          );
        });
      }
      start.mockImplementation(async (options) => {
        if (options?.signal?.aborted) throw new StartupCancellationError();
        options?.onReady?.({});
        options?.onCleanupOutcome?.({ clean: true });
      });
      try {
        expect(core.start(true).state).toBe("starting");
        if (when === "in flight") await Promise.resolve();
        expect(core.stop(true).state).toBe("stopping");
        await session?.done;
        expect(core.status()).toMatchObject({
          state: "stopped",
          stopIntent: true
        });
        expect(core.status().error).toBeUndefined();
        expect(intent.runtimeClean).toBe(true);
        const firstCalls = when === "in flight" ? 1 : 0;
        expect(start).toHaveBeenCalledTimes(firstCalls);
        expect(() => core.start(false)).toThrow(
          "Explicit Stop prevents automatic start"
        );
        expect(core.start(true).state).toBe("starting");
        await session?.done;
        expect(core.status()).toMatchObject({
          state: "stopped",
          stopIntent: false
        });
        expect(start).toHaveBeenCalledTimes(firstCalls + 1);
      } finally {
        start.mockReset();
      }
    }
  );

  it.each([
    { clean: false, error: new StartupCancellationError() },
    {
      clean: true,
      error: new Error("Koed startup was stopped before readiness.")
    }
  ])(
    "preserves $error.name with cleanup clean=$clean",
    async ({ clean, error }) => {
      vi.mocked(startKoedServer).mockImplementationOnce(async (options) => {
        if (clean) options?.onCleanupOutcome?.({ clean });
        throw error;
      });
      expect(await startControlPlaneRuntime(input()).done).toEqual({
        clean,
        error: error.message
      });
    }
  );

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

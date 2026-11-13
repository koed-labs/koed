import { describe, expect, it, vi } from "vitest";
import type { BackgroundAgentXpcClient } from "./xpc-transport.js";
import { createBackgroundAgentRuntimeLifecycle } from "./runtime-lifecycle.js";

const createClient = () =>
  ({
    close: vi.fn(),
    status: vi.fn(async () => ({ ok: true, state: "ready" as const })),
    start: vi.fn(async (_explicit?: boolean) => ({
      ok: true,
      state: "starting" as const
    })),
    stop: vi.fn(async (_explicit?: boolean) => ({
      ok: true,
      state: "stopped" as const
    }))
  }) as unknown as BackgroundAgentXpcClient;

describe("background-agent runtime lifecycle adapter", () => {
  it("remains inactive until explicitly connected and then forwards intent", async () => {
    const lifecycle = createBackgroundAgentRuntimeLifecycle();
    expect(lifecycle.isActive()).toBe(false);
    const client = createClient();
    lifecycle.activate(client);

    expect(lifecycle.isActive()).toBe(true);
    await lifecycle.start({ explicit: false });
    await lifecycle.stop({ explicit: true });
    await lifecycle.status();
    expect(client.start).toHaveBeenCalledWith(false);
    expect(client.stop).toHaveBeenCalledWith(true);
    expect(client.status).toHaveBeenCalledOnce();
  });

  it("closes and deactivates the client without allowing local fallback", async () => {
    const lifecycle = createBackgroundAgentRuntimeLifecycle();
    const client = createClient();
    lifecycle.activate(client);
    lifecycle.deactivate();

    expect(client.close).toHaveBeenCalledOnce();
    expect(lifecycle.isActive()).toBe(false);
    expect(() => lifecycle.start({ explicit: true })).toThrow(
      "Background Agent XPC client is not connected."
    );
  });
});

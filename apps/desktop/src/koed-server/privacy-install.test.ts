import { describe, expect, it, vi } from "vitest";
import { createPrivacyInstallBridge } from "./privacy-install.js";
const fixture = (startFails = false, rollbackFails = false) => {
  const events: string[] = [];
  const start = vi.fn(async () => {
    events.push("start");
    return { ok: !startFails || start.mock.calls.length > 1 };
  });
  const bridge = createPrivacyInstallBridge({
    productVersion: "0.8.1",
    requestPrivacyRpc: async <T>(action: string) =>
      (action === "status"
        ? { activeGeneration: "old", required: ["privacy"] }
        : { state: "staged", generationId: "new" }) as T,
    stop: async () => {
      events.push("stop");
      return { ok: true };
    },
    requestDaemonStart: start,
    pollUntilReady: async () => {
      events.push("ready");
    },
    activatePrivacyGeneration: async (id) => {
      events.push(`activate:${id}`);
      if (id === "old" && rollbackFails) throw new Error("rollback failed");
    }
  });
  return { bridge, events, start };
};
describe("Privacy installation transaction", () => {
  it("stops, activates and restarts before reporting readiness", async () => {
    const { bridge, events } = fixture();
    await expect(
      bridge.installPrivacy({ consent: true, onProgress: vi.fn() })
    ).resolves.toMatchObject({ state: "ready" });
    expect(events).toEqual(["stop", "activate:new", "start", "ready"]);
  });
  it("restores the previous generation after restart failure and reports the original failure", async () => {
    const { bridge, events } = fixture(true);
    await expect(
      bridge.installPrivacy({ consent: true, onProgress: vi.fn() })
    ).rejects.toThrow("could not restart");
    expect(events).toEqual([
      "stop",
      "activate:new",
      "start",
      "stop",
      "activate:old",
      "start",
      "ready"
    ]);
  });
  it("keeps services stopped when rollback cannot restore the previous generation", async () => {
    const { bridge, events, start } = fixture(true, true);
    await expect(
      bridge.installPrivacy({ consent: true, onProgress: vi.fn() })
    ).rejects.toThrow("remains stopped");
    expect(events.at(-1)).toBe("activate:old");
    expect(start).toHaveBeenCalledOnce();
  });
});

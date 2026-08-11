import { describe, expect, it } from "vitest";
import { resolveDesktopUpdateE2eDebugPort } from "./e2e-debug-port.js";

describe("desktop updater E2E debug port", () => {
  it("is disabled by default", () => {
    expect(resolveDesktopUpdateE2eDebugPort({})).toBeNull();
  });

  it("accepts only an explicit gated loopback test port", () => {
    expect(
      resolveDesktopUpdateE2eDebugPort({
        KOED_DESKTOP_UPDATE_E2E: "1",
        KOED_DESKTOP_UPDATE_E2E_DEBUG_PORT: "49123"
      })
    ).toBe(49123);
  });

  it("fails closed for missing or invalid gated ports", () => {
    expect(() =>
      resolveDesktopUpdateE2eDebugPort({ KOED_DESKTOP_UPDATE_E2E: "1" })
    ).toThrow(/explicit TCP port/);
    expect(() =>
      resolveDesktopUpdateE2eDebugPort({
        KOED_DESKTOP_UPDATE_E2E: "1",
        KOED_DESKTOP_UPDATE_E2E_DEBUG_PORT: "80"
      })
    ).toThrow(/between 1024 and 65535/);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  loadBackgroundAgentNativeBridge,
  type NativeAgentAddon
} from "./native-bridge.js";

const nativeAddon: NativeAgentAddon = {
  teamId: "ABCDE12345",
  connect: vi.fn(() => ({ close: vi.fn(), request: vi.fn() })),
  listen: vi.fn(() => ({ close: vi.fn() }))
};

const loadPackagedBridge = (loadAddon: () => unknown = () => nativeAddon) =>
  loadBackgroundAgentNativeBridge({
    platform: "darwin",
    isPackaged: true,
    loadAddon
  });

describe("background-agent native bridge loader", () => {
  it("does not load native code on unsupported platforms", () => {
    const loadAddon = vi.fn(() => nativeAddon);

    expect(
      loadBackgroundAgentNativeBridge({
        platform: "linux",
        isPackaged: true,
        loadAddon
      })
    ).toEqual({ available: false, reason: "unsupported-platform" });
    expect(loadAddon).not.toHaveBeenCalled();
  });

  it("fails closed for development or missing signing identity", () => {
    expect(
      loadBackgroundAgentNativeBridge({
        platform: "darwin",
        isPackaged: false,
        loadAddon: () => nativeAddon
      })
    ).toEqual({ available: false, reason: "unpackaged-app" });
    expect(
      loadBackgroundAgentNativeBridge({
        platform: "darwin",
        isPackaged: true,
        loadAddon: () => ({ ...nativeAddon, teamId: "" })
      })
    ).toEqual({ available: false, reason: "missing-team-id" });
  });

  it("loads only an addon with the typed listen/connect contract", () => {
    expect(loadPackagedBridge()).toMatchObject({
      available: true,
      bridge: nativeAddon,
      teamId: "ABCDE12345"
    });
    expect(loadPackagedBridge(() => ({}))).toEqual({
      available: false,
      reason: "invalid-native-bridge"
    });
  });

  it("reports a missing or unloadable native module without enabling the Agent", () => {
    const loadAddon = vi.fn(() => {
      throw new Error("module not found");
    });

    expect(loadPackagedBridge(loadAddon)).toEqual({
      available: false,
      reason: "native-addon-load-failed"
    });
  });
});

import type { LoginItemSettings } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_AGENT_LAUNCH_ARGUMENT,
  BACKGROUND_AGENT_SERVICE_NAME,
  createBackgroundAgentLaunchService,
  isBackgroundAgentLaunch
} from "./launch-service.js";

const loginSettings = (
  overrides: Partial<LoginItemSettings> = {}
): LoginItemSettings =>
  ({
    executableWillLaunchAtLogin: false,
    launchItems: [],
    openAsHidden: false,
    openAtLogin: false,
    restoreState: false,
    status: "not-registered",
    wasOpenedAsHidden: false,
    wasOpenedAtLogin: false,
    ...overrides
  }) as LoginItemSettings;

const supportedInput = (overrides: Record<string, unknown> = {}) => ({
  appIsPackaged: true,
  nativeBridgeAvailable: true,
  agentPlistPresent: true,
  teamId: "ABCDE12345",
  platform: "darwin" as NodeJS.Platform,
  ...overrides
});

describe("background-agent launch service", () => {
  it("does not offer registration until packaged, signed, and native-ready", async () => {
    const setLoginItemSettings = vi.fn();
    const controller = createBackgroundAgentLaunchService({
      ...supportedInput({ teamId: undefined }),
      getLoginItemSettings: vi.fn(() => loginSettings()),
      setLoginItemSettings
    });

    await expect(controller.get()).resolves.toMatchObject({
      enabled: false,
      status: "unsupported",
      supported: false
    });
    await expect(controller.set(true)).resolves.toMatchObject({
      supported: false
    });
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("registers the embedded agent plist with the matching service name", async () => {
    const getLoginItemSettings = vi.fn(() =>
      loginSettings({ openAtLogin: true, status: "enabled" })
    );
    const setLoginItemSettings = vi.fn();
    const controller = createBackgroundAgentLaunchService({
      ...supportedInput(),
      getLoginItemSettings,
      setLoginItemSettings
    });

    await expect(controller.set(true)).resolves.toMatchObject({
      enabled: true,
      status: "enabled",
      supported: true
    });
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      type: "agentService",
      serviceName: BACKGROUND_AGENT_SERVICE_NAME,
      args: [BACKGROUND_AGENT_LAUNCH_ARGUMENT]
    });
    expect(getLoginItemSettings).toHaveBeenCalledWith({
      type: "agentService",
      serviceName: BACKGROUND_AGENT_SERVICE_NAME
    });
  });

  it("surfaces approval requirements for this service without using the app login item", async () => {
    const getLoginItemSettings = vi.fn(() =>
      loginSettings({
        openAtLogin: true,
        status: "requires-approval",
        wasOpenedAtLogin: true
      })
    );
    const controller = createBackgroundAgentLaunchService({
      ...supportedInput(),
      getLoginItemSettings,
      setLoginItemSettings: vi.fn()
    });

    await expect(controller.get()).resolves.toMatchObject({
      enabled: true,
      status: "requires-approval",
      supported: true
    });
    expect(controller.wasOpenedAtLogin()).toBe(true);
    expect(getLoginItemSettings).toHaveBeenCalledWith({
      type: "agentService",
      serviceName: BACKGROUND_AGENT_SERVICE_NAME
    });
  });

  it("recognizes only the dedicated agent argument", () => {
    expect(isBackgroundAgentLaunch([BACKGROUND_AGENT_LAUNCH_ARGUMENT])).toBe(
      true
    );
    expect(isBackgroundAgentLaunch(["--background"])).toBe(false);
    expect(isBackgroundAgentLaunch([])).toBe(false);
  });
});

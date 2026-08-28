import type { LoginItemSettings } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  backgroundLaunchArgument,
  createLaunchAtStartupController,
  isBackgroundLaunch,
  linuxAutostartEntry,
  linuxAutostartFilename
} from "./launch-at-startup.js";

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

const missingFile = (): Error & { code: string } =>
  Object.assign(new Error("missing"), { code: "ENOENT" });

const memoryFileSystem = (initial: Record<string, string> = {}) => {
  const files = new Map(Object.entries(initial));
  const api = {
    chmod: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async (path: string) => {
      const value = files.get(String(path));
      if (value === undefined) throw missingFile();
      return value;
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(String(from));
      if (value === undefined) throw missingFile();
      files.set(String(to), value);
      files.delete(String(from));
    }),
    unlink: vi.fn(async (path: string) => {
      if (!files.delete(String(path))) throw missingFile();
    }),
    writeFile: vi.fn(async (path: string, value: string) => {
      files.set(String(path), value);
    })
  };
  return { api, files };
};

describe("launch at startup", () => {
  it("disables the preference outside packaged supported builds", async () => {
    const controller = createLaunchAtStartupController({
      appDataPath: "/config",
      appIsPackaged: false,
      execPath: "/Applications/Koed.app/Contents/MacOS/Koed",
      platform: "darwin"
    });

    await expect(controller.get()).resolves.toEqual({
      enabled: false,
      status: "unsupported",
      supported: false
    });
    await expect(controller.set(true)).resolves.toEqual({
      enabled: false,
      status: "unsupported",
      supported: false
    });
  });

  it("maps macOS login item state and approval requirements", async () => {
    let current = loginSettings({
      openAtLogin: true,
      status: "requires-approval",
      wasOpenedAtLogin: true
    });
    const setLoginItemSettings = vi.fn(
      (settings: { openAtLogin?: boolean }) => {
        current = loginSettings({
          openAtLogin: settings.openAtLogin,
          status: settings.openAtLogin ? "enabled" : "not-registered"
        });
      }
    );
    const controller = createLaunchAtStartupController({
      appDataPath: "/config",
      appIsPackaged: true,
      execPath: "/Applications/Koed.app/Contents/MacOS/Koed",
      getLoginItemSettings: () => current,
      platform: "darwin",
      setLoginItemSettings
    });

    await expect(controller.get()).resolves.toEqual({
      enabled: true,
      status: "requires-approval",
      supported: true
    });
    expect(controller.wasOpenedAtLogin()).toBe(true);

    await expect(controller.set(false)).resolves.toEqual({
      enabled: false,
      status: "disabled",
      supported: true
    });
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
  });

  it("uses the legacy macOS login-item state when status is unavailable", async () => {
    const legacySettings = loginSettings({ openAtLogin: true });
    delete (legacySettings as Partial<LoginItemSettings>).status;
    const controller = createLaunchAtStartupController({
      appDataPath: "/config",
      appIsPackaged: true,
      execPath: "/Applications/Koed.app/Contents/MacOS/Koed",
      getLoginItemSettings: () => legacySettings,
      platform: "darwin",
      setLoginItemSettings: vi.fn()
    });

    await expect(controller.get()).resolves.toEqual({
      enabled: true,
      status: "enabled",
      supported: true
    });
  });

  it("uses an exact executable and background argument on Windows", async () => {
    const getLoginItemSettings = vi.fn(() =>
      loginSettings({
        executableWillLaunchAtLogin: true,
        openAtLogin: true
      })
    );
    const setLoginItemSettings = vi.fn();
    const controller = createLaunchAtStartupController({
      appDataPath: "C:\\Users\\User\\AppData\\Roaming",
      appIsPackaged: true,
      execPath: "C:\\Program Files\\Koed\\Koed.exe",
      getLoginItemSettings,
      platform: "win32",
      setLoginItemSettings
    });

    await expect(controller.get()).resolves.toEqual({
      enabled: true,
      status: "enabled",
      supported: true
    });
    expect(getLoginItemSettings).toHaveBeenCalledWith({
      args: [backgroundLaunchArgument],
      path: "C:\\Program Files\\Koed\\Koed.exe"
    });

    await controller.set(true);
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      args: [backgroundLaunchArgument],
      enabled: true,
      name: "Koed",
      openAtLogin: true,
      path: "C:\\Program Files\\Koed\\Koed.exe"
    });
  });

  it("writes and removes only a Koed-owned XDG autostart entry", async () => {
    const path = `/config/autostart/${linuxAutostartFilename}`;
    const { api, files } = memoryFileSystem();
    const controller = createLaunchAtStartupController({
      appDataPath: "/config",
      appIsPackaged: true,
      execPath: '/opt/Koed $Preview/koed%"desktop',
      fileSystem: api as never,
      platform: "linux",
      temporarySuffix: () => "ticket"
    });

    await expect(controller.set(true)).resolves.toEqual({
      enabled: true,
      status: "enabled",
      supported: true
    });
    expect(api.mkdir).toHaveBeenCalledWith("/config/autostart", {
      mode: 0o700,
      recursive: true
    });
    expect(api.chmod).toHaveBeenCalledWith("/config/autostart", 0o700);
    expect(api.writeFile).toHaveBeenCalledWith(
      `${path}.ticket.tmp`,
      linuxAutostartEntry('/opt/Koed $Preview/koed%"desktop'),
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    expect(files.get(path)).toContain(
      'Exec="/opt/Koed \\$Preview/koed%%\\"desktop" --background'
    );

    await expect(controller.set(false)).resolves.toEqual({
      enabled: false,
      status: "disabled",
      supported: true
    });
    expect(files.has(path)).toBe(false);
  });

  it("reports an external Linux entry as off and never deletes it", async () => {
    const path = `/config/autostart/${linuxAutostartFilename}`;
    const { api, files } = memoryFileSystem({
      [path]: "[Desktop Entry]\nName=Another app\n"
    });
    const controller = createLaunchAtStartupController({
      appDataPath: "/config",
      appIsPackaged: true,
      execPath: "/opt/koed",
      fileSystem: api as never,
      platform: "linux"
    });

    await expect(controller.get()).resolves.toEqual({
      enabled: false,
      status: "disabled",
      supported: true
    });
    await expect(controller.set(false)).resolves.toEqual({
      enabled: false,
      status: "disabled",
      supported: true
    });
    expect(files.get(path)).toContain("Another app");
    await expect(controller.set(true)).rejects.toThrow("not owned by Koed");
  });

  it("detects only platform-appropriate background launches", () => {
    expect(
      isBackgroundLaunch({
        argv: ["Koed"],
        platform: "darwin",
        wasOpenedAtLogin: true
      })
    ).toBe(true);
    expect(
      isBackgroundLaunch({
        argv: ["Koed", backgroundLaunchArgument],
        platform: "linux",
        wasOpenedAtLogin: false
      })
    ).toBe(true);
    expect(
      isBackgroundLaunch({
        argv: ["Koed"],
        platform: "win32",
        wasOpenedAtLogin: false
      })
    ).toBe(false);
  });
});

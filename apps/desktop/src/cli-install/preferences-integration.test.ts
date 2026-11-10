import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopCliInstallManager } from "./manager.js";
import { registerCliInstallIpc } from "./ipc.js";
import { readCliInstallSettings, writeCliInstallSettings } from "./settings.js";
import { InstallSetupStore } from "../renderer/views/preferences/install-setup-store.js";
import type { CliInstallApi } from "./protocol.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  vi.stubEnv("SHELL", "/bin/zsh");
  const root = mkdtempSync(join(tmpdir(), "koed prefs "));
  roots.push(root);
  const cliPath = join(root, "cli.js"),
    settingsFile = join(root, "settings.json"),
    destination = join(root, "custom", "koed");
  writeFileSync(cliPath, "// entry\n");
  const manager = (app: string, fail = false, onPath?: () => void) => {
    let writes = 0;
    return createDesktopCliInstallManager({
      appPath: app,
      helperPath: join(app, "Koed"),
      cliPath,
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: join(root, "custom"),
      homePath: root,
      platform: "darwin",
      probeHelper: async () => true,
      settings: readCliInstallSettings(settingsFile),
      saveSettings: (settings) => {
        if (fail && ++writes === 2) throw new Error("final save failed");
        writeCliInstallSettings(settingsFile, settings);
        if (settings.pathDirectory) onPath?.();
      }
    });
  };
  const bridge = (
    instance: ReturnType<typeof manager>,
    select: (path: string) => Promise<string | null>
  ) => {
    let handler!: (event: never, value: unknown) => Promise<unknown>;
    registerCliInstallIpc({
      ipcMain: {
        handle: (_channel: string, callback: typeof handler) => {
          handler = callback;
        }
      } as never,
      allowedRendererOrigins: new Set(["https://koed.test"]),
      manager: instance,
      selectLauncherDestination: select
    });
    const mainFrame = { url: "https://koed.test/index.html" },
      event = { sender: { mainFrame }, senderFrame: mainFrame };
    const invoke = (value: unknown) => handler(event as never, value);
    const api: CliInstallApi = {
      getStatus: () =>
        invoke({ operation: "status" }) as ReturnType<
          CliInstallApi["getStatus"]
        >,
      installPrivacy: (consent, offlineSource) =>
        invoke({ operation: "install", consent, offlineSource }) as ReturnType<
          CliInstallApi["installPrivacy"]
        >,
      cancel: () => invoke({ operation: "cancel" }) as Promise<void>,
      selectOffline: () =>
        invoke({ operation: "select-offline" }) as ReturnType<
          CliInstallApi["selectOffline"]
        >,
      launcher: (operation, options) =>
        invoke({
          operation: `launcher-${operation}`,
          ...options
        }) as ReturnType<CliInstallApi["launcher"]>,
      updatePath: (operationKind, consent) =>
        invoke({
          operation: "path-update",
          operationKind,
          consent
        }) as Promise<void>,
      subscribe: () => () => {}
    };
    return new InstallSetupStore(api);
  };
  return { root, destination, settingsFile, manager, bridge };
}

describe("Preferences launcher through IPC", () => {
  it("exposes pending matching launcher after restart and finalizes it on retry", async () => {
    const f = fixture(),
      app = join(f.root, "app");
    await expect(
      f
        .manager(app, true)
        .launcher("install", { consent: true, destination: f.destination })
    ).rejects.toThrow("final save failed");
    const select = vi.fn(async (path: string) => path);
    const store = f.bridge(f.manager(app), select);
    await store.refresh();
    expect(store.snapshot().cli.stage).not.toBe("ready");
    expect(store.snapshot().launcher).toMatchObject({
      pendingInstallation: true,
      pathVisible: true
    });
    expect(store.snapshot().cli.message).toMatch(/incomplete/i);
    await store.installCli();
    expect(select).toHaveBeenCalledWith(f.destination);
    expect(
      readCliInstallSettings(f.settingsFile).pendingDestination
    ).toBeUndefined();
    expect(store.snapshot().cli.stage).toBe("ready");
  });
  it("does not update PATH or claim ready when recovery picker is cancelled", async () => {
    const f = fixture();
    await f
      .manager(join(f.root, "old"))
      .launcher("install", { consent: true, destination: f.destination });
    const before = readFileSync(f.destination, "utf8"),
      select = vi.fn(async (_path: string) => null);
    const store = f.bridge(f.manager(join(f.root, "new")), select);
    await store.refresh();
    await store.installCli();
    expect(select).toHaveBeenCalledWith(f.destination);
    expect(store.snapshot().cli.stage).not.toBe("ready");
    expect(existsSync(join(f.root, ".zshrc"))).toBe(false);
    expect(readFileSync(f.destination, "utf8")).toBe(before);
    expect(
      readCliInstallSettings(f.settingsFile).pathDirectory
    ).toBeUndefined();
  });
  it("does not declare ready if the CLI target disappears during PATH setup", async () => {
    const f = fixture(),
      app = join(f.root, "app");
    const store = f.bridge(
      f.manager(app, false, () => rmSync(join(f.root, "cli.js"))),
      async () => f.destination
    );
    await store.refresh();
    await store.installCli();
    expect(store.snapshot().cli.stage).toBe("failed");
    expect(store.snapshot().launcher?.target).toBe("missing");
  });
  it("guides recovery before changing destination after Desktop moves", async () => {
    const f = fixture(),
      oldApp = join(f.root, "old"),
      newApp = join(f.root, "new"),
      next = join(f.root, "other", "koed");
    await f
      .manager(oldApp)
      .launcher("install", { consent: true, destination: f.destination });
    const original = readFileSync(f.destination, "utf8");
    const choices = [next, f.destination, next];
    const select = vi.fn(async (_path: string) => choices.shift() ?? null);
    const store = f.bridge(f.manager(newApp), select);
    await store.refresh();
    await store.installCli();
    expect(store.snapshot().cli.stage).toBe("failed");
    expect(store.snapshot().cli.message).toMatch(
      /recover.*existing.*location.*remove/i
    );
    expect(readFileSync(f.destination, "utf8")).toBe(original);
    expect(existsSync(next)).toBe(false);
    await store.installCli();
    expect(store.snapshot().cli.stage).toBe("ready");
    expect(readFileSync(f.destination, "utf8")).toContain(join(newApp, "Koed"));
    await store.removeCli();
    expect(store.snapshot().cli.stage).toBe("idle");
    expect(existsSync(f.destination)).toBe(false);
    await store.installCli();
    expect(store.snapshot().cli.stage).toBe("ready");
    expect(existsSync(next)).toBe(true);
    expect(
      readCliInstallSettings(f.settingsFile).installedLauncher?.destination
    ).toBe(next);
  });

  it("preserves an edited relocated launcher during recovery-first workflow", async () => {
    const f = fixture(),
      next = join(f.root, "other", "koed");
    await f
      .manager(join(f.root, "old"))
      .launcher("install", { consent: true, destination: f.destination });
    const edited = `${readFileSync(f.destination, "utf8")}# user edit\n`;
    writeFileSync(f.destination, edited);
    const choices = [next, f.destination];
    const store = f.bridge(
      f.manager(join(f.root, "new")),
      async () => choices.shift() ?? null
    );
    await store.refresh();
    await store.installCli();
    await store.installCli();
    expect(store.snapshot().cli.stage).toBe("failed");
    expect(store.snapshot().cli.message).toMatch(/conflict/i);
    expect(readFileSync(f.destination, "utf8")).toBe(edited);
    expect(existsSync(next)).toBe(false);
    expect(
      readCliInstallSettings(f.settingsFile).installedLauncher?.destination
    ).toBe(f.destination);
  });

  it("defaults relocation picker to recorded custom destination and recovers it", async () => {
    const f = fixture();
    await f
      .manager(join(f.root, "old"))
      .launcher("install", { consent: true, destination: f.destination });
    const select = vi.fn(async (path: string) => path),
      store = f.bridge(f.manager(join(f.root, "new")), select);
    await store.refresh();
    await store.installCli();
    expect(select).toHaveBeenCalledWith(f.destination);
    expect(store.snapshot().cli.stage).toBe("ready");
    expect(readFileSync(f.destination, "utf8")).toContain(
      join(f.root, "new", "Koed")
    );
  });
});

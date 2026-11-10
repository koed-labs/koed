import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopCliInstallManager,
  shellPathRemovalFiles,
  shellStartupFiles,
  unavailablePrivacyStatus
} from "./manager.js";
import type { PrivacyInstallBridge } from "./protocol.js";
import { inspectLauncher } from "./launcher.js";
import { hasManagedPathBlock } from "./shell-path.js";
import {
  loadCliInstallSettingsForDesktop,
  readCliInstallSettings,
  writeCliInstallSettings
} from "./settings.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "koed manager "));
  roots.push(root);
  return root;
};
const create = (root: string, bridge?: PrivacyInstallBridge) =>
  createDesktopCliInstallManager({
    ...(bridge ? { bridge } : {}),
    appPath: root,
    helperPath: join(root, "Koed"),
    cliPath: join(root, "cli.js"),
    koedHome: join(root, "home"),
    expectedVersion: "0.8.1",
    currentPath: "/usr/bin",
    homePath: root,
    platform: "darwin",
    probeHelper: async () => true
  });

describe("desktop CLI install adapter", () => {
  it("does not strand a successfully installed launcher when another install is queued", async () => {
    const root = fixture(),
      settingsFile = join(root, "settings.json");
    const first = join(root, "first", "koed"),
      second = join(root, "second", "koed");
    writeFileSync(join(root, "cli.js"), "// entry\n");
    let release!: () => void,
      entered!: () => void,
      probes = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const createManager = () =>
      createDesktopCliInstallManager({
        appPath: root,
        helperPath: join(root, "Koed"),
        cliPath: join(root, "cli.js"),
        koedHome: join(root, "home"),
        expectedVersion: "0.9.0",
        currentPath: "",
        homePath: root,
        platform: "darwin",
        settings: readCliInstallSettings(settingsFile),
        probeHelper: async () => {
          if (++probes === 1) {
            entered();
            await gate;
          }
          return true;
        },
        saveSettings: (settings) =>
          writeCliInstallSettings(settingsFile, settings)
      });
    const manager = createManager();
    const install = manager.launcher("install", {
      consent: true,
      destination: first
    });
    await started;
    const other = manager.launcher("install", {
      consent: true,
      destination: second
    });
    const outcome = other.then(
      () => null,
      (error: Error) => error
    );
    release();
    await install;
    expect((await outcome)?.message).toMatch(/remove|destination/i);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(false);
    expect(
      readCliInstallSettings(settingsFile).installedLauncher?.destination
    ).toBe(first);
    const restarted = createManager();
    await expect(
      restarted.launcher("install", {
        consent: true,
        destination: second
      })
    ).rejects.toThrow(/remove|destination/i);
    await restarted.launcher("remove");
    await restarted.launcher("install", { consent: true, destination: second });
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    expect(
      readCliInstallSettings(settingsFile).installedLauncher?.destination
    ).toBe(second);
  });

  it("serializes overlapping installs and preserves pending intent after failure", async () => {
    const root = fixture(),
      settingsFile = join(root, "settings.json");
    writeFileSync(join(root, "cli.js"), "// entry\n");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let probes = 0,
      writes = 0;
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "",
      homePath: root,
      platform: "darwin",
      probeHelper: async () => {
        if (++probes === 1) {
          entered();
          await gate;
        }
        return true;
      },
      saveSettings: (settings) => {
        if (++writes === 2) throw new Error("final save failed");
        writeCliInstallSettings(settingsFile, settings);
      }
    });
    const firstDestination = join(root, "first", "koed"),
      secondDestination = join(root, "second", "koed");
    const first = manager.launcher("install", {
      consent: true,
      destination: firstDestination
    });
    const firstResult = expect(first).rejects.toThrow("final save failed");
    await started;
    const second = manager.launcher("install", {
      consent: true,
      destination: secondDestination
    });
    const secondResult = expect(second).rejects.toThrow(/pending/i);
    await Promise.resolve();
    expect(probes).toBe(1);
    release();
    await firstResult;
    await secondResult;
    expect(readCliInstallSettings(settingsFile).pendingDestination).toBe(
      firstDestination
    );
    expect(existsSync(firstDestination)).toBe(true);
    expect(existsSync(secondDestination)).toBe(false);
  });

  it.each(["remove", "path", "cancel-pending", "inspect"] as const)(
    "queues %s behind an in-flight install",
    async (operation) => {
      vi.stubEnv("SHELL", "/bin/zsh");
      const root = fixture(),
        destination = join(root, "custom", "koed"),
        settingsFile = join(root, "settings.json");
      writeFileSync(join(root, "cli.js"), "// entry\n");
      let release!: () => void,
        entered!: () => void,
        probes = 0;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const manager = createDesktopCliInstallManager({
        appPath: root,
        helperPath: join(root, "Koed"),
        cliPath: join(root, "cli.js"),
        koedHome: join(root, "home"),
        expectedVersion: "0.9.0",
        currentPath: "",
        homePath: root,
        platform: "darwin",
        probeHelper: async () => {
          if (++probes === 1) {
            entered();
            await gate;
          }
          return true;
        },
        saveSettings: (settings) =>
          writeCliInstallSettings(settingsFile, settings)
      });
      const install = manager.launcher("install", {
        consent: true,
        destination
      });
      await started;
      const request =
        operation === "path"
          ? manager.updatePath("add", true)
          : manager.launcher(operation);
      let settled = false;
      const result = request.then(
        () => {
          settled = true;
          return null;
        },
        (error: Error) => {
          settled = true;
          return error;
        }
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await install;
      const error = await result;
      if (operation === "cancel-pending")
        expect(error?.message).toMatch(/no pending/i);
      else expect(error).toBeNull();
      if (operation === "remove") expect(existsSync(destination)).toBe(false);
      if (operation === "path")
        expect(readCliInstallSettings(settingsFile).pathDirectory).toBe(
          join(root, "custom")
        );
    }
  );

  it("waits for pending cancellation before checking a new destination", async () => {
    const root = fixture(),
      pendingDestination = join(root, "pending", "koed"),
      destination = join(root, "new", "koed");
    writeFileSync(join(root, "cli.js"), "// entry\n");
    let release!: () => void,
      entered!: () => void,
      probes = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "",
      homePath: root,
      platform: "darwin",
      settings: { pendingDestination },
      probeHelper: async () => {
        if (++probes === 1) {
          entered();
          await gate;
        }
        return true;
      }
    });
    const cancel = manager.launcher("cancel-pending");
    await started;
    const install = manager.launcher("install", { consent: true, destination });
    release();
    await cancel;
    await install;
    expect(existsSync(destination)).toBe(true);
  });

  it("refuses launcher installation from an AppImage without creating a file", async () => {
    const root = fixture();
    const destination = join(root, "koed");
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "",
      homePath: root,
      platform: "linux",
      probeHelper: async () => true
    });
    await expect(
      manager.launcher("install", { consent: true, destination })
    ).rejects.toThrow(/AppImage/);
    expect(existsSync(destination)).toBe(false);
  });

  it("fails closed on Linux when AppImage environment is unavailable", async () => {
    const root = fixture();
    const destination = join(root, "koed");
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "",
      homePath: root,
      platform: "linux",
      probeHelper: async () => true
    });
    await expect(
      manager.launcher("install", { consent: true, destination })
    ).rejects.toThrow(/Linux/);
    expect(existsSync(destination)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "does not block on FIFO launcher, CLI target, rc, or settings files",
    async () => {
      const fifo = process.env.KOED_FIFO_TEST;
      if (fifo) {
        const input = {
          destination: fifo,
          cliPath: fifo,
          appPath: "/",
          helperPath: "/helper",
          koedHome: "/home",
          expectedVersion: "1.0.0",
          currentPath: "",
          probeHelper: async () => true
        };
        await expect(inspectLauncher(input)).resolves.toMatchObject({
          ownership: "changed",
          target: "invalid"
        });
        expect(() => hasManagedPathBlock(fifo, "/bin")).toThrow();
        expect(() => readCliInstallSettings(fifo)).toThrow();
        return;
      }
      const root = fixture();
      const path = join(root, "fifo");
      execFileSync("mkfifo", [path]);
      const result = spawnSync(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "src/cli-install/manager.test.ts",
          "-t",
          "does not block on FIFO"
        ],
        {
          env: { ...process.env, KOED_FIFO_TEST: path },
          encoding: "utf8",
          timeout: 10000
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr + result.stdout).toBe(0);
    }
  );

  it("rejects oversized launcher and shell files without reading them into memory", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    const root = fixture();
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    const manager = create(root);
    const destination = join(root, "koed");
    writeFileSync(destination, "x".repeat(2 * 1024 * 1024));
    await expect(
      manager.launcher("inspect", { destination })
    ).resolves.toMatchObject({ ownership: "changed" });
    writeFileSync(join(root, ".zshrc"), "x".repeat(2 * 1024 * 1024));
    await expect(manager.updatePath("add", true)).rejects.toThrow(/large/i);
  });

  it("cleans old Bash blocks after switching to zsh and moving the launcher", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    const root = fixture();
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    const manager = create(root);
    await manager.launcher("install", {
      consent: true,
      destination: join(root, "old", "koed")
    });
    await manager.updatePath("add", true);
    vi.stubEnv("SHELL", "/bin/zsh");
    await manager.launcher("remove");
    await manager.launcher("install", {
      consent: true,
      destination: join(root, "new", "koed")
    });
    await manager.updatePath("add", true);
    for (const name of [".bashrc", ".bash_profile"])
      expect(readFileSync(join(root, name), "utf8")).not.toContain(
        "koed managed PATH"
      );
    await manager.updatePath("remove", true);
    expect(readFileSync(join(root, ".zshrc"), "utf8")).not.toContain(
      "koed managed PATH"
    );
  });

  it("retains old PATH directory for retry after a cross-shell cleanup conflict", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    const root = fixture();
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    const manager = create(root);
    await manager.launcher("install", {
      consent: true,
      destination: join(root, "old", "koed")
    });
    await manager.updatePath("add", true);
    const profile = join(root, ".bash_profile");
    const original = readFileSync(profile, "utf8");
    writeFileSync(
      profile,
      original.replace("export PATH", "# edited\nexport PATH")
    );
    vi.stubEnv("SHELL", "/bin/zsh");
    await manager.launcher("remove");
    await manager.launcher("install", {
      consent: true,
      destination: join(root, "new", "koed")
    });
    await expect(manager.updatePath("add", true)).rejects.toThrow(/edited/);
    writeFileSync(profile, original);
    await manager.updatePath("add", true);
    expect(readFileSync(profile, "utf8")).not.toContain("koed managed PATH");
    expect(readFileSync(join(root, ".zshrc"), "utf8")).toContain(
      join(root, "new")
    );
  });

  it("moves a managed PATH block after changing launcher directory", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    const root = fixture();
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    const manager = create(root);
    await manager.launcher("install", {
      consent: true,
      destination: join(root, "old", "koed")
    });
    await manager.updatePath("add", true);
    await manager.launcher("remove");
    await manager.launcher("install", {
      consent: true,
      destination: join(root, "new", "koed")
    });
    await manager.updatePath("add", true);
    const rc = readFileSync(join(root, ".zshrc"), "utf8");
    expect(rc).toContain(join(root, "new"));
    expect(rc).not.toContain(join(root, "old"));
    await manager.updatePath("remove", true);
    expect(readFileSync(join(root, ".zshrc"), "utf8")).not.toContain(
      "koed managed PATH"
    );
  });
  it.each(["corrupt", "symlink", "unreadable"])(
    "keeps Privacy installation available but blocks CLI mutations with %s settings",
    async (kind) => {
      const root = fixture();
      const settingsFile = join(root, "settings.json");
      const target = join(root, "target.json");
      writeFileSync(target, "{}\n");
      if (kind === "symlink") symlinkSync(target, settingsFile);
      else writeFileSync(settingsFile, kind === "corrupt" ? "{bad json" : "{}");
      if (kind === "unreadable") chmodSync(settingsFile, 0);
      const reportError = vi.fn();
      const loaded = loadCliInstallSettingsForDesktop(
        settingsFile,
        reportError
      );
      const ready = {
        available: true,
        state: "ready" as const,
        message: "Ready"
      };
      const bridge: PrivacyInstallBridge = {
        getStatus: async () => ready,
        installPrivacy: async () => ready,
        cancel: async () => {},
        selectOffline: async () => null
      };
      const saveSettings = vi.fn();
      const probeHelper = vi.fn(async () => true);
      const destination = join(root, "koed");
      writeFileSync(destination, "unrelated launcher\n");
      const rcPath = join(
        root,
        process.env.SHELL?.endsWith("zsh") ? ".zshrc" : ".bashrc"
      );
      writeFileSync(rcPath, "# unchanged shell\n");
      const manager = createDesktopCliInstallManager({
        ...loaded,
        bridge,
        appPath: root,
        helperPath: join(root, "Koed"),
        cliPath: join(root, "cli.js"),
        koedHome: join(root, "home"),
        expectedVersion: "0.8.1",
        currentPath: "",
        homePath: root,
        platform: "darwin",
        probeHelper,
        saveSettings
      });
      expect(reportError).toHaveBeenCalledWith(expect.any(Error));
      expect(loaded.settingsError?.message).toContain(settingsFile);
      expect(loaded.settingsError?.message).toMatch(/repair.*restart/i);
      for (const operation of ["inspect", "install", "remove"] as const)
        await expect(
          manager.launcher(operation, { consent: true, destination })
        ).rejects.toThrow("disabled");
      for (const operation of ["add", "remove"] as const)
        await expect(manager.updatePath(operation, true)).rejects.toThrow(
          "disabled"
        );
      await expect(manager.getStatus()).resolves.toEqual(ready);
      await expect(manager.selectOffline()).resolves.toBeNull();
      await expect(manager.installPrivacy(true)).resolves.toEqual(ready);
      await expect(manager.cancel()).resolves.toBeUndefined();
      expect(readFileSync(destination, "utf8")).toBe("unrelated launcher\n");
      expect(readFileSync(rcPath, "utf8")).toBe("# unchanged shell\n");
      expect(readFileSync(target, "utf8")).toBe("{}\n");
      expect(existsSync(join(root, ".local", "bin", "koed"))).toBe(false);
      expect(probeHelper).not.toHaveBeenCalled();
      expect(saveSettings).not.toHaveBeenCalled();
      if (kind === "unreadable") chmodSync(settingsFile, 0o600);
      expect(readFileSync(settingsFile, "utf8")).toBe(
        kind === "corrupt"
          ? "{bad json"
          : "{}" + (kind === "symlink" ? "\n" : "")
      );
    }
  );

  it("retries failed offline installation without reselection and consumes selection only on success", async () => {
    const source = {
      archivePath: "/tmp/privacy.tar.gz",
      manifestPath: "/tmp/privacy.manifest.json"
    };
    let attempts = 0;
    const ready = {
      available: true,
      state: "ready" as const,
      message: "Ready"
    };
    const manager = create(fixture(), {
      getStatus: async () => ready,
      selectOffline: async () => source,
      cancel: async () => {},
      installPrivacy: async ({ offlineSource }) => {
        expect(offlineSource).toEqual(source);
        if (++attempts === 1) throw new Error("Transient import failure");
        return ready;
      }
    });
    const selected = await manager.selectOffline();
    await expect(manager.installPrivacy(true, selected!)).rejects.toThrow(
      "Transient import failure"
    );
    await expect(manager.installPrivacy(true, selected!)).resolves.toEqual(
      ready
    );
    await expect(manager.installPrivacy(true, selected!)).rejects.toThrow(
      "Choose offline component files"
    );
    expect(attempts).toBe(2);
  });

  it("retains offline selection when installer returns failed status", async () => {
    const source = {
      archivePath: "/tmp/privacy.tar.gz",
      manifestPath: "/tmp/privacy.json"
    };
    let attempts = 0;
    const manager = create(fixture(), {
      getStatus: async () => unavailablePrivacyStatus,
      selectOffline: async () => source,
      cancel: async () => {},
      installPrivacy: async ({ offlineSource }) => {
        expect(offlineSource).toEqual(source);
        return ++attempts === 1
          ? { available: true, state: "failed", message: "Import failed" }
          : { available: true, state: "ready", message: "Ready" };
      }
    });
    await manager.selectOffline();
    await expect(manager.installPrivacy(true, source)).resolves.toMatchObject({
      state: "failed"
    });
    await expect(manager.installPrivacy(true, source)).resolves.toMatchObject({
      state: "ready"
    });
  });

  it("revokes previous offline selection on cancellation or explicit new selection", async () => {
    const first = {
      archivePath: "/tmp/first.tar.gz",
      manifestPath: "/tmp/first.json"
    };
    const second = {
      archivePath: "/tmp/second.tar.gz",
      manifestPath: "/tmp/second.json"
    };
    let selection: typeof first | null = first;
    const ready = {
      available: true,
      state: "ready" as const,
      message: "Ready"
    };
    const manager = create(fixture(), {
      getStatus: async () => ready,
      selectOffline: async () => selection,
      cancel: async () => {},
      installPrivacy: async () => {
        throw new Error("Transient import failure");
      }
    });
    await manager.selectOffline();
    await manager.cancel();
    await expect(manager.installPrivacy(true, first)).rejects.toThrow(
      "Choose offline component files"
    );
    await manager.selectOffline();
    selection = second;
    await manager.selectOffline();
    await expect(manager.installPrivacy(true, first)).rejects.toThrow(
      "Choose offline component files"
    );
    await expect(manager.installPrivacy(true, second)).rejects.toThrow(
      "Transient import failure"
    );
    selection = null;
    await manager.selectOffline();
    await expect(manager.installPrivacy(true, second)).rejects.toThrow(
      "Choose offline component files"
    );
  });

  it.each(["cancel", "replace"])(
    "discards pending offline picker result after %s",
    async (operation) => {
      const oldSource = {
        archivePath: "/tmp/old.tar.gz",
        manifestPath: "/tmp/old.json"
      };
      const newSource = {
        archivePath: "/tmp/new.tar.gz",
        manifestPath: "/tmp/new.json"
      };
      let resolvePicker!: (source: typeof oldSource | null) => void;
      const pending = new Promise<typeof oldSource | null>((resolve) => {
        resolvePicker = resolve;
      });
      let selections = 0;
      const manager = create(fixture(), {
        getStatus: async () => unavailablePrivacyStatus,
        selectOffline: () =>
          ++selections === 1 ? pending : Promise.resolve(newSource),
        cancel: async () => {},
        installPrivacy: async ({ offlineSource }) => {
          expect(offlineSource).toEqual(newSource);
          return { available: true, state: "ready", message: "Ready" };
        }
      });
      const oldPicker = manager.selectOffline();
      if (operation === "cancel") await manager.cancel();
      else await manager.selectOffline();
      resolvePicker(oldSource);
      await expect(oldPicker).resolves.toBeNull();
      await expect(manager.installPrivacy(true, oldSource)).rejects.toThrow(
        "Choose offline component files"
      );
      if (operation === "replace")
        await expect(
          manager.installPrivacy(true, newSource)
        ).resolves.toMatchObject({ state: "ready" });
    }
  );

  it("persists custom destination and independently removes PATH after launcher removal and restart", async () => {
    const root = fixture();
    const settingsFile = join(root, "settings.json");
    const destination = join(root, "custom", "koed");
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    const restart = () =>
      createDesktopCliInstallManager({
        appPath: root,
        helperPath: join(root, "Koed"),
        cliPath: join(root, "cli.js"),
        koedHome: join(root, "home"),
        expectedVersion: "0.9.0",
        currentPath: "/usr/bin",
        homePath: root,
        platform: "darwin",
        probeHelper: async () => true,
        settings: readCliInstallSettings(settingsFile),
        saveSettings: (settings) =>
          writeCliInstallSettings(settingsFile, settings)
      });
    let manager = restart();
    await manager.launcher("install", { consent: true, destination });
    manager = restart();
    await expect(manager.launcher("inspect")).resolves.toMatchObject({
      ownership: "koed"
    });
    await manager.updatePath("add", true);
    await manager.launcher("remove");
    expect(readCliInstallSettings(settingsFile)).toEqual({
      destination,
      pathDirectory: join(root, "custom")
    });
    manager = restart();
    await expect(manager.launcher("inspect")).resolves.toMatchObject({
      ownership: "absent"
    });
    await manager.launcher("install", {
      consent: true,
      destination: join(root, "different", "koed")
    });
    manager = restart();
    await manager.updatePath("remove", true);
    const rc = join(
      root,
      process.env.SHELL?.endsWith("zsh") ? ".zshrc" : ".bashrc"
    );
    expect(readFileSync(rc, "utf8")).not.toContain("koed managed PATH");
    expect(readCliInstallSettings(settingsFile)).toMatchObject({
      destination: join(root, "different", "koed"),
      installedLauncher: { destination: join(root, "different", "koed") }
    });
  });

  it("adds PATH to the Bash login startup file so new login shells find the launcher", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    const root = fixture();
    const destination = join(root, "bin dir", "koed");
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "/usr/bin",
      homePath: root,
      platform: "darwin",
      probeHelper: async () => true
    });
    await manager.launcher("install", { consent: true, destination });
    // A .bashrc-only block is not enough for login shells.
    writeFileSync(
      join(root, ".bashrc"),
      `# >>> koed managed PATH >>>\nexport PATH="$PATH:${join(root, "bin dir")}"\n# <<< koed managed PATH <<<\n`
    );
    await expect(manager.launcher("inspect")).resolves.toMatchObject({
      pathConfigured: false
    });
    await manager.updatePath("add", true);
    expect(readFileSync(join(root, ".bash_profile"), "utf8")).toContain(
      "koed managed PATH"
    );
    await expect(manager.launcher("inspect")).resolves.toMatchObject({
      pathConfigured: true
    });
    if (process.platform !== "win32") {
      // Follow Bash's documented login-shell lookup without the host's
      // system profile, which CI runner images customize.
      const loginPath = execFileSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          'for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do if [ -r "$f" ]; then . "$f"; break; fi; done; printf %s "$PATH"'
        ],
        { env: { HOME: root, PATH: "/usr/bin:/bin" }, encoding: "utf8" }
      );
      expect(loginPath.split(":")).toContain(join(root, "bin dir"));
    }
    await manager.updatePath("remove", true);
    for (const name of [".bashrc", ".bash_profile"])
      expect(readFileSync(join(root, name), "utf8")).not.toContain(
        "koed managed PATH"
      );
  });

  it("removes the PATH block from a login file that is no longer preferred", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    const root = fixture();
    const destination = join(root, "bin", "koed");
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    writeFileSync(join(root, ".profile"), "export KEEP=1\n");
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "/usr/bin",
      homePath: root,
      platform: "darwin",
      probeHelper: async () => true
    });
    await manager.launcher("install", { consent: true, destination });
    await manager.updatePath("add", true);
    expect(readFileSync(join(root, ".profile"), "utf8")).toContain(
      "koed managed PATH"
    );
    // The User creates .bash_profile after setup; Bash now prefers it.
    writeFileSync(join(root, ".bash_profile"), "export OTHER=1\n");
    await manager.updatePath("remove", true);
    expect(readFileSync(join(root, ".profile"), "utf8")).toBe(
      "export KEEP=1\n"
    );
    expect(readFileSync(join(root, ".bash_profile"), "utf8")).toBe(
      "export OTHER=1\n"
    );
    expect(shellPathRemovalFiles(root, "/bin/bash")).toEqual([
      join(root, ".bashrc"),
      join(root, ".bash_profile"),
      join(root, ".bash_login"),
      join(root, ".profile")
    ]);
  });

  it("retains tracked PATH when a managed Bash profile is replaced by a symlink", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    const root = fixture(),
      settingsFile = join(root, "settings.json"),
      profile = join(root, ".bash_profile");
    writeFileSync(join(root, "cli.js"), "// entry\n");
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "",
      homePath: root,
      platform: "darwin",
      probeHelper: async () => true,
      saveSettings: (settings) =>
        writeCliInstallSettings(settingsFile, settings)
    });
    await manager.launcher("install", {
      consent: true,
      destination: join(root, "old", "koed")
    });
    await manager.updatePath("add", true);
    const target = join(root, "moved-profile"),
      original = readFileSync(profile, "utf8");
    renameSync(profile, target);
    symlinkSync(target, profile);
    await expect(manager.updatePath("remove", true)).rejects.toThrow(
      /symlink|regular/i
    );
    expect(readCliInstallSettings(settingsFile).pathDirectory).toBe(
      join(root, "old")
    );
    expect(readFileSync(target, "utf8")).toBe(original);
    rmSync(profile);
    renameSync(target, profile);
    await manager.updatePath("remove", true);
    expect(readCliInstallSettings(settingsFile).pathDirectory).toBeUndefined();
  });

  it.each(["symlink", "dangling", "directory", "fifo"])(
    "refuses Bash cleanup when a login path is %s and keeps tracking",
    async (kind) => {
      vi.stubEnv("SHELL", "/bin/zsh");
      const root = fixture(),
        rc = join(root, ".bash_login"),
        target = join(root, "target");
      const oldDirectory = join(root, "old"),
        settingsFile = join(root, "settings.json");
      writeFileSync(target, "unrelated\n");
      if (kind === "symlink") symlinkSync(target, rc);
      if (kind === "dangling") symlinkSync(join(root, "missing"), rc);
      if (kind === "directory") mkdirSync(rc);
      if (kind === "fifo") execFileSync("mkfifo", [rc]);
      writeCliInstallSettings(settingsFile, {
        destination: join(root, "new", "koed"),
        pathDirectory: oldDirectory
      });
      const manager = createDesktopCliInstallManager({
        appPath: root,
        helperPath: join(root, "Koed"),
        cliPath: join(root, "cli.js"),
        koedHome: join(root, "home"),
        expectedVersion: "0.9.0",
        currentPath: "",
        homePath: root,
        platform: "darwin",
        probeHelper: async () => true,
        settings: {
          destination: join(root, "new", "koed"),
          pathDirectory: oldDirectory
        },
        saveSettings: (settings) =>
          writeCliInstallSettings(settingsFile, settings)
      });
      await expect(manager.updatePath("add", true)).rejects.toThrow();
      expect(readFileSync(target, "utf8")).toBe("unrelated\n");
      expect(readCliInstallSettings(settingsFile).pathDirectory).toBe(
        oldDirectory
      );
      rmSync(rc, { recursive: true, force: true });
      await manager.updatePath("add", true);
      expect(readCliInstallSettings(settingsFile).pathDirectory).toBe(
        join(root, "new")
      );
    }
  );

  it("includes symlinked and absent login files in removal inspection", () => {
    const root = fixture();
    writeFileSync(join(root, "dotfiles-profile"), "# managed elsewhere\n");
    symlinkSync(join(root, "dotfiles-profile"), join(root, ".profile"));
    expect(shellPathRemovalFiles(root, "/bin/bash")).toEqual([
      join(root, ".bashrc"),
      join(root, ".bash_profile"),
      join(root, ".bash_login"),
      join(root, ".profile")
    ]);
    expect(shellPathRemovalFiles(root, "/bin/zsh")).toEqual([
      join(root, ".zshrc")
    ]);
  });

  it("selects the Bash login file that bash actually reads", () => {
    const root = fixture();
    expect(shellStartupFiles(root, "/bin/zsh")).toEqual([join(root, ".zshrc")]);
    expect(shellStartupFiles(root, "/bin/bash")).toEqual([
      join(root, ".bashrc"),
      join(root, ".bash_profile")
    ]);
    writeFileSync(join(root, ".profile"), "# existing\n");
    expect(shellStartupFiles(root, "/bin/bash")[1]).toBe(
      join(root, ".profile")
    );
    writeFileSync(join(root, ".bash_login"), "# existing\n");
    expect(shellStartupFiles(root, "/bin/bash")[1]).toBe(
      join(root, ".bash_login")
    );
    writeFileSync(join(root, ".bash_profile"), "# existing\n");
    expect(shellStartupFiles(root, undefined)[1]).toBe(
      join(root, ".bash_profile")
    );
  });

  it("does not record an invalid destination as pending", async () => {
    const root = fixture();
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    const saveSettings = vi.fn();
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "",
      homePath: root,
      platform: "darwin",
      probeHelper: async () => true,
      saveSettings
    });
    await expect(
      manager.launcher("install", {
        consent: true,
        destination: "relative-koed"
      })
    ).rejects.toThrow(/absolute/);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it.each(["helper", "target"])(
    "does not record intent when %s validation fails",
    async (failure) => {
      const root = fixture();
      if (failure !== "target")
        writeFileSync(join(root, "cli.js"), "// CLI entry\n");
      const saveSettings = vi.fn();
      const manager = createDesktopCliInstallManager({
        appPath: root,
        helperPath: join(root, "Ko Koed"),
        cliPath: join(root, "cli.js"),
        koedHome: join(root, "home"),
        expectedVersion: "0.9.0",
        currentPath: "",
        homePath: root,
        platform: "darwin",
        probeHelper: async () => failure !== "helper",
        saveSettings
      });
      await expect(
        manager.launcher("install", {
          consent: true,
          destination: join(root, "koed")
        })
      ).rejects.toThrow();
      expect(saveSettings).not.toHaveBeenCalled();
    }
  );

  it("recovers a recorded exact launcher after moving Desktop only with consent", async () => {
    const root = fixture();
    const oldApp = join(root, "Old App");
    const newApp = join(root, "New App");
    const destination = join(root, "bin", "koed");
    const settingsFile = join(root, "settings.json");
    mkdirSync(oldApp);
    writeFileSync(join(oldApp, "cli.js"), "// CLI entry\n");
    const managerFor = (appPath: string) =>
      createDesktopCliInstallManager({
        appPath,
        helperPath: join(appPath, "Koed"),
        cliPath: join(appPath, "cli.js"),
        koedHome: join(root, "home"),
        expectedVersion: "0.9.0",
        currentPath: "",
        homePath: root,
        platform: "darwin",
        probeHelper: async () => true,
        settings: readCliInstallSettings(settingsFile),
        saveSettings: (settings) =>
          writeCliInstallSettings(settingsFile, settings)
      });
    await managerFor(oldApp).launcher("install", {
      consent: true,
      destination
    });
    const oldContents = readFileSync(destination, "utf8");
    renameSync(oldApp, newApp);
    const manager = managerFor(newApp);
    await expect(
      manager.launcher("install", { consent: false })
    ).rejects.toThrow(/consent/i);
    expect(readFileSync(destination, "utf8")).toBe(oldContents);
    await manager.launcher("install", { consent: true });
    expect(readFileSync(destination, "utf8")).toContain(join(newApp, "Koed"));
    await expect(manager.launcher("inspect")).resolves.toMatchObject({
      ownership: "koed",
      target: "valid"
    });
  });

  it.each(["edited", "version", "unrecorded", "home", "symlink"])(
    "refuses relocation recovery for %s launcher",
    async (kind) => {
      const root = fixture();
      const oldApp = join(root, "old-app"),
        newApp = join(root, "new-app");
      const destination = join(root, "koed"),
        settingsFile = join(root, "settings.json");
      mkdirSync(oldApp);
      writeFileSync(join(oldApp, "cli.js"), "// entry\n");
      const managerFor = (appPath: string, home: string) =>
        createDesktopCliInstallManager({
          appPath,
          helperPath: join(appPath, "Koed"),
          cliPath: join(appPath, "cli.js"),
          koedHome: home,
          expectedVersion: "0.9.0",
          currentPath: "",
          homePath: root,
          platform: "darwin",
          probeHelper: async () => true,
          settings: readCliInstallSettings(settingsFile),
          saveSettings: (settings) =>
            writeCliInstallSettings(settingsFile, settings)
        });
      await managerFor(oldApp, join(root, "home")).launcher("install", {
        consent: true,
        destination
      });
      renameSync(oldApp, newApp);
      let original = readFileSync(destination, "utf8");
      if (kind === "edited") original += "# edited\n";
      if (kind === "version") original = original.replace("0.9.0", "0.9.1");
      writeFileSync(destination, original);
      if (kind === "unrecorded")
        writeCliInstallSettings(settingsFile, { destination });
      if (kind === "symlink") {
        renameSync(destination, join(root, "target"));
        symlinkSync(join(root, "target"), destination);
      }
      const manager = managerFor(
        newApp,
        join(root, kind === "home" ? "other-home" : "home")
      );
      await expect(
        manager.launcher("install", { consent: true })
      ).rejects.toThrow(/conflict/i);
      expect(readFileSync(destination, "utf8")).toBe(original);
    }
  );

  it("rejects non-UTF-8 bytes even when lossy decoding resembles a recorded template", async () => {
    const root = fixture(),
      oldApp = join(root, "old-�"),
      newApp = join(root, "new");
    const destination = join(root, "koed"),
      settingsFile = join(root, "settings.json");
    mkdirSync(oldApp);
    writeFileSync(join(oldApp, "cli.js"), "// entry\n");
    const managerFor = (appPath: string) =>
      createDesktopCliInstallManager({
        appPath,
        helperPath: join(appPath, "Koed"),
        cliPath: join(appPath, "cli.js"),
        koedHome: join(root, "home"),
        expectedVersion: "0.9.0",
        currentPath: "",
        homePath: root,
        platform: "darwin",
        probeHelper: async () => true,
        settings: readCliInstallSettings(settingsFile),
        saveSettings: (settings) =>
          writeCliInstallSettings(settingsFile, settings)
      });
    await managerFor(oldApp).launcher("install", {
      consent: true,
      destination
    });
    const bytes = readFileSync(destination);
    const marker = Buffer.from("�");
    const index = bytes.indexOf(marker);
    expect(index).toBeGreaterThan(-1);
    const invalid = Buffer.concat([
      bytes.subarray(0, index),
      Buffer.from([0xff]),
      bytes.subarray(index + marker.length)
    ]);
    writeFileSync(destination, invalid);
    renameSync(oldApp, newApp);
    await expect(
      managerFor(newApp).launcher("install", { consent: true })
    ).rejects.toThrow(/conflict/i);
    expect(readFileSync(destination)).toEqual(invalid);
  });

  it("recovers an interrupted install after Desktop moves", async () => {
    const root = fixture(),
      oldApp = join(root, "old"),
      newApp = join(root, "new");
    const destination = join(root, "koed"),
      settingsFile = join(root, "settings.json");
    mkdirSync(oldApp);
    writeFileSync(join(oldApp, "cli.js"), "// entry\n");
    let writes = 0;
    const managerFor = (appPath: string, fail: boolean) =>
      createDesktopCliInstallManager({
        appPath,
        helperPath: join(appPath, "Koed"),
        cliPath: join(appPath, "cli.js"),
        koedHome: join(root, "home"),
        expectedVersion: "0.9.0",
        currentPath: "",
        homePath: root,
        platform: "darwin",
        probeHelper: async () => true,
        settings: readCliInstallSettings(settingsFile),
        saveSettings: (settings) => {
          if (fail && ++writes === 2) throw new Error("settings failure");
          writeCliInstallSettings(settingsFile, settings);
        }
      });
    await expect(
      managerFor(oldApp, true).launcher("install", {
        consent: true,
        destination
      })
    ).rejects.toThrow("settings failure");
    renameSync(oldApp, newApp);
    await managerFor(newApp, false).launcher("install", { consent: true });
    expect(readFileSync(destination, "utf8")).toContain(join(newApp, "Koed"));
  });

  it("retains the previous pending template if relocation retry stops before replacement", async () => {
    const root = fixture(),
      oldApp = join(root, "old"),
      newApp = join(root, "new");
    const destination = join(root, "koed"),
      settingsFile = join(root, "settings.json");
    mkdirSync(oldApp);
    writeFileSync(join(oldApp, "cli.js"), "// entry\n");
    let writes = 0,
      probes = 0;
    const managerFor = (appPath: string, fail: "final" | "probe" | "none") =>
      createDesktopCliInstallManager({
        appPath,
        helperPath: join(appPath, "Koed"),
        cliPath: join(appPath, "cli.js"),
        koedHome: join(root, "home"),
        expectedVersion: "0.9.0",
        currentPath: "",
        homePath: root,
        platform: "darwin",
        probeHelper: async () => fail !== "probe" || ++probes === 1,
        settings: readCliInstallSettings(settingsFile),
        saveSettings: (settings) => {
          if (fail === "final" && ++writes === 2)
            throw new Error("settings failure");
          writeCliInstallSettings(settingsFile, settings);
        }
      });
    await expect(
      managerFor(oldApp, "final").launcher("install", {
        consent: true,
        destination
      })
    ).rejects.toThrow("settings failure");
    renameSync(oldApp, newApp);
    await expect(
      managerFor(newApp, "probe").launcher("install", { consent: true })
    ).rejects.toThrow(/unsupported/i);
    await managerFor(newApp, "none").launcher("install", { consent: true });
    expect(readFileSync(destination, "utf8")).toContain(join(newApp, "Koed"));
  });

  it("clears an interrupted absent pending destination without changing files", async () => {
    const root = fixture();
    const settingsFile = join(root, "settings.json");
    const destination = join(root, "pending", "koed");
    writeCliInstallSettings(settingsFile, { pendingDestination: destination });
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "",
      homePath: root,
      platform: "darwin",
      probeHelper: async () => true,
      settings: readCliInstallSettings(settingsFile),
      saveSettings: (settings) =>
        writeCliInstallSettings(settingsFile, settings)
    });
    await expect(manager.launcher("inspect")).resolves.toMatchObject({
      pendingCancellationAvailable: true
    });
    await manager.launcher("cancel-pending");
    expect(readCliInstallSettings(settingsFile)).toEqual({});
    expect(existsSync(destination)).toBe(false);
  });

  it("cancels absent intent after creation fails and retains it if cancellation persistence fails", async () => {
    const root = fixture(),
      destination = join(root, "koed"),
      settingsFile = join(root, "settings.json");
    writeFileSync(join(root, "cli.js"), "// entry\n");
    let probes = 0,
      failCancel = false;
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "",
      homePath: root,
      platform: "darwin",
      probeHelper: async () => ++probes !== 2,
      saveSettings: (settings) => {
        if (failCancel) throw new Error("cancel save failed");
        writeCliInstallSettings(settingsFile, settings);
      }
    });
    await expect(
      manager.launcher("install", { consent: true, destination })
    ).rejects.toThrow(/unsupported/i);
    expect(existsSync(destination)).toBe(false);
    failCancel = true;
    await expect(manager.launcher("cancel-pending")).rejects.toThrow(
      "cancel save failed"
    );
    expect(readCliInstallSettings(settingsFile).pendingDestination).toBe(
      destination
    );
    failCancel = false;
    await manager.launcher("cancel-pending");
    expect(
      readCliInstallSettings(settingsFile).pendingDestination
    ).toBeUndefined();
    await manager.launcher("install", {
      consent: true,
      destination: join(root, "other", "koed")
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps pending intent after unlink failure until the file is manually removed",
    async () => {
      const root = fixture(),
        directory = join(root, "bin"),
        destination = join(directory, "koed"),
        settingsFile = join(root, "settings.json");
      writeFileSync(join(root, "cli.js"), "// entry\n");
      let saves = 0;
      const manager = createDesktopCliInstallManager({
        appPath: root,
        helperPath: join(root, "Koed"),
        cliPath: join(root, "cli.js"),
        koedHome: join(root, "home"),
        expectedVersion: "0.9.0",
        currentPath: "",
        homePath: root,
        platform: "darwin",
        probeHelper: async () => true,
        saveSettings: (settings) => {
          if (++saves === 2) throw new Error("final save failed");
          writeCliInstallSettings(settingsFile, settings);
        }
      });
      await expect(
        manager.launcher("install", { consent: true, destination })
      ).rejects.toThrow("final save failed");
      chmodSync(directory, 0o555);
      try {
        await expect(manager.launcher("remove")).rejects.toThrow();
        await expect(manager.launcher("cancel-pending")).rejects.toThrow();
        expect(existsSync(destination)).toBe(true);
        expect(readCliInstallSettings(settingsFile).pendingDestination).toBe(
          destination
        );
      } finally {
        chmodSync(directory, 0o755);
      }
      rmSync(destination);
      await manager.launcher("cancel-pending");
      expect(
        readCliInstallSettings(settingsFile).pendingDestination
      ).toBeUndefined();
    }
  );

  it("cancels absent intent after unlink succeeds but settings persistence fails", async () => {
    const root = fixture(),
      destination = join(root, "koed"),
      settingsFile = join(root, "settings.json");
    writeFileSync(join(root, "cli.js"), "// entry\n");
    let fail = false;
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "",
      homePath: root,
      platform: "darwin",
      probeHelper: async () => true,
      saveSettings: (settings) => {
        if (fail) throw new Error("save failed");
        writeCliInstallSettings(settingsFile, settings);
      }
    });
    await manager.launcher("install", { consent: true, destination });
    const current = readCliInstallSettings(settingsFile);
    const pending = { ...current, pendingDestination: destination };
    writeCliInstallSettings(settingsFile, pending);
    const resumed = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "",
      homePath: root,
      platform: "darwin",
      probeHelper: async () => true,
      settings: pending,
      saveSettings: (settings) => {
        if (fail) throw new Error("save failed");
        writeCliInstallSettings(settingsFile, settings);
      }
    });
    fail = true;
    await expect(resumed.launcher("remove")).rejects.toThrow("save failed");
    expect(existsSync(destination)).toBe(false);
    expect(readCliInstallSettings(settingsFile).pendingDestination).toBe(
      destination
    );
    fail = false;
    await resumed.launcher("cancel-pending");
    expect(
      readCliInstallSettings(settingsFile).pendingDestination
    ).toBeUndefined();
  });

  it("never cancels pending intent when a destination file exists", async () => {
    const root = fixture(),
      settingsFile = join(root, "settings.json"),
      destination = join(root, "koed");
    writeCliInstallSettings(settingsFile, { pendingDestination: destination });
    writeFileSync(destination, "preserve me");
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "",
      homePath: root,
      platform: "darwin",
      probeHelper: async () => true,
      settings: readCliInstallSettings(settingsFile),
      saveSettings: (settings) =>
        writeCliInstallSettings(settingsFile, settings)
    });
    await expect(manager.launcher("cancel-pending")).rejects.toThrow(/exists/i);
    expect(readFileSync(destination, "utf8")).toBe("preserve me");
    expect(readCliInstallSettings(settingsFile).pendingDestination).toBe(
      destination
    );
  });

  it("does not create a launcher if recording installation intent fails", async () => {
    const root = fixture();
    const destination = join(root, "custom", "koed");
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: "",
      homePath: root,
      platform: "darwin",
      probeHelper: async () => true,
      saveSettings: () => {
        throw new Error("settings write failed");
      }
    });
    await expect(
      manager.launcher("install", { consent: true, destination })
    ).rejects.toThrow("settings write failed");
    expect(existsSync(destination)).toBe(false);
  });

  it("recovers a custom launcher after final settings persistence fails and Desktop restarts", async () => {
    const root = fixture();
    const settingsFile = join(root, "settings.json");
    const destination = join(root, "custom", "koed");
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    let writes = 0;
    const restart = (failFinal = false) =>
      createDesktopCliInstallManager({
        appPath: root,
        helperPath: join(root, "Koed"),
        cliPath: join(root, "cli.js"),
        koedHome: join(root, "home"),
        expectedVersion: "0.9.0",
        currentPath: "",
        homePath: root,
        platform: "darwin",
        probeHelper: async () => true,
        settings: readCliInstallSettings(settingsFile),
        saveSettings: (settings) => {
          if (failFinal && ++writes === 2)
            throw new Error("settings write failed");
          writeCliInstallSettings(settingsFile, settings);
        }
      });
    await expect(
      restart(true).launcher("install", { consent: true, destination })
    ).rejects.toThrow("settings write failed");
    const restarted = restart();
    await expect(restarted.launcher("inspect")).resolves.toMatchObject({
      ownership: "koed"
    });
    await expect(
      restarted.launcher("install", {
        consent: true,
        destination: join(root, "other", "koed")
      })
    ).rejects.toThrow(/pending/i);
    await restarted.launcher("remove");
    expect(existsSync(destination)).toBe(false);
  });

  it("does not persist failed installs or infer arbitrary file ownership from settings", async () => {
    const root = fixture();
    const destination = join(root, "unrelated");
    writeFileSync(destination, "unrelated launcher\n");
    writeFileSync(join(root, "cli.js"), "// CLI entry\n");
    const saveSettings = vi.fn();
    const manager = createDesktopCliInstallManager({
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.8.1",
      currentPath: "",
      homePath: root,
      platform: "darwin",
      probeHelper: async () => true,
      settings: { destination },
      saveSettings
    });
    await expect(manager.launcher("inspect")).resolves.toMatchObject({
      ownership: "unrelated"
    });
    await expect(manager.launcher("remove")).rejects.toThrow(
      "unchanged Koed-owned"
    );
    await expect(
      manager.launcher("install", { consent: true })
    ).rejects.toThrow("conflict");
    expect(saveSettings).not.toHaveBeenCalled();
    expect(readFileSync(destination, "utf8")).toBe("unrelated launcher\n");
  });
  it("reports unavailable status and fails closed when runtime bridge is absent", async () => {
    const manager = create(fixture());
    await expect(manager.getStatus()).resolves.toEqual(
      unavailablePrivacyStatus
    );
    await expect(manager.installPrivacy(true)).rejects.toThrow(
      "installer is unavailable"
    );
    await expect(manager.cancel()).rejects.toThrow("installer is unavailable");
  });

  it("requires explicit consent and forwards accepted install progress and offline path", async () => {
    const root = fixture();
    const installPrivacy = vi.fn(
      async (
        options: Parameters<PrivacyInstallBridge["installPrivacy"]>[0]
      ) => {
        options.onProgress({
          requestId: "request-1",
          stage: "download",
          message: "Downloading",
          completedBytes: 2,
          totalBytes: 4
        });
        return { available: true, state: "ready" as const, message: "Ready" };
      }
    );
    const bridge = {
      getStatus: vi.fn(),
      installPrivacy,
      cancel: vi.fn(),
      selectOffline: vi.fn(async () => ({
        archivePath: "/tmp/privacy.tar.gz",
        manifestPath: "/tmp/privacy.manifest.json"
      }))
    };
    const manager = create(root, bridge);
    const listener = vi.fn();
    manager.setProgressListener(listener);
    await expect(manager.installPrivacy(false)).rejects.toThrow(
      "Explicit consent"
    );
    await manager.selectOffline();
    await expect(
      manager.installPrivacy(true, {
        archivePath: "/tmp/privacy.tar.gz",
        manifestPath: "/tmp/privacy.manifest.json"
      })
    ).resolves.toMatchObject({ state: "ready" });
    expect(installPrivacy).toHaveBeenCalledWith(
      expect.objectContaining({
        consent: true,
        offlineSource: {
          archivePath: "/tmp/privacy.tar.gz",
          manifestPath: "/tmp/privacy.manifest.json"
        }
      })
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "download" })
    );
  });
});

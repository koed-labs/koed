import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopCliInstallManager,
  unavailablePrivacyStatus
} from "./manager.js";
import type { PrivacyInstallBridge } from "./protocol.js";
import {
  loadCliInstallSettingsForDesktop,
  readCliInstallSettings,
  writeCliInstallSettings
} from "./settings.js";

const roots: string[] = [];
afterEach(() => {
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
    expectedVersion: "0.8.1",
    currentPath: "/usr/bin",
    homePath: root,
    platform: "darwin",
    probeHelper: async () => true
  });

describe("desktop CLI install adapter", () => {
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
      manifestPath: "/tmp/privacy.manifest.json",
      signaturePath: "/tmp/privacy.signature.json"
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
      manifestPath: "/tmp/privacy.json",
      signaturePath: "/tmp/privacy.sig.json"
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
      manifestPath: "/tmp/first.json",
      signaturePath: "/tmp/first.sig.json"
    };
    const second = {
      archivePath: "/tmp/second.tar.gz",
      manifestPath: "/tmp/second.json",
      signaturePath: "/tmp/second.sig.json"
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
        manifestPath: "/tmp/old.json",
        signaturePath: "/tmp/old.sig.json"
      };
      const newSource = {
        archivePath: "/tmp/new.tar.gz",
        manifestPath: "/tmp/new.json",
        signaturePath: "/tmp/new.sig.json"
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
    expect(readCliInstallSettings(settingsFile)).toEqual({
      destination: join(root, "different", "koed")
    });
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
        manifestPath: "/tmp/privacy.manifest.json",
        signaturePath: "/tmp/privacy.signature.json"
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
        manifestPath: "/tmp/privacy.manifest.json",
        signaturePath: "/tmp/privacy.signature.json"
      })
    ).resolves.toMatchObject({ state: "ready" });
    expect(installPrivacy).toHaveBeenCalledWith(
      expect.objectContaining({
        consent: true,
        offlineSource: {
          archivePath: "/tmp/privacy.tar.gz",
          manifestPath: "/tmp/privacy.manifest.json",
          signaturePath: "/tmp/privacy.signature.json"
        }
      })
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "download" })
    );
  });
});

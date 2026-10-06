import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopCliInstallManager,
  unavailablePrivacyStatus
} from "./manager.js";
import type { PrivacyInstallBridge } from "./protocol.js";

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
      selectOffline: vi.fn(async () => "/tmp/model.onnx")
    };
    const manager = create(root, bridge);
    const listener = vi.fn();
    manager.setProgressListener(listener);
    await expect(manager.installPrivacy(false)).rejects.toThrow(
      "Explicit consent"
    );
    await manager.selectOffline();
    await expect(
      manager.installPrivacy(true, "/tmp/model.onnx")
    ).resolves.toMatchObject({ state: "ready" });
    expect(installPrivacy).toHaveBeenCalledWith(
      expect.objectContaining({ consent: true, offlinePath: "/tmp/model.onnx" })
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "download" })
    );
  });
});

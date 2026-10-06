import { describe, expect, it, vi } from "vitest";
import { registerCliInstallIpc } from "./ipc.js";
import { cliInstallCommandChannel } from "./protocol.js";

const setup = () => {
  let handler: ((event: never, value: unknown) => Promise<unknown>) | undefined;
  const ipcMain = {
    handle: vi.fn((channel: string, callback: typeof handler) => {
      expect(channel).toBe(cliInstallCommandChannel);
      handler = callback;
    })
  };
  const manager = {
    installPrivacy: vi.fn(async () => ({
      ok: true
    })),
    getStatus: vi.fn(async () => ({ available: true })),
    cancel: vi.fn(async () => undefined),
    selectOffline: vi.fn(async () => null),
    launcher: vi.fn(),
    updatePath: vi.fn()
  };
  registerCliInstallIpc({
    ipcMain: ipcMain as never,
    allowedRendererOrigins: new Set(["https://koed.test"]),
    manager: manager as never,
    selectLauncherDestination: async () => null
  });
  const mainFrame = { url: "https://koed.test/index.html" };
  const event = { sender: { mainFrame }, senderFrame: mainFrame };
  return {
    event,
    handler: (value: unknown) => handler!(event as never, value),
    manager
  };
};

const invoke = async (event: never, value: unknown) => {
  let handler: ((event: never, value: unknown) => Promise<unknown>) | undefined;
  registerCliInstallIpc({
    ipcMain: {
      handle: (_channel: string, callback: typeof handler) => {
        handler = callback;
      }
    } as never,
    allowedRendererOrigins: new Set(["https://koed.test"]),
    manager: { getStatus: async () => ({ available: true }) } as never,
    selectLauncherDestination: async () => null
  });
  return handler!(event, value);
};

describe("CLI install IPC", () => {
  it("accepts only main-frame actor and forwards validated offline triplet", async () => {
    const { event, handler, manager } = setup();
    const source = {
      archivePath: "/tmp/privacy.tar.gz",
      manifestPath: "/tmp/privacy.manifest.json",
      signaturePath: "/tmp/privacy.signature.json"
    };
    await handler({
      operation: "install",
      consent: true,
      offlineSource: source
    });
    expect(manager.installPrivacy).toHaveBeenCalledWith(true, source);
    const subframe = {
      sender: event.sender,
      senderFrame: { url: "https://koed.test/iframe.html" }
    };
    await expect(
      invoke(subframe as never, { operation: "status" })
    ).rejects.toThrow("Untrusted Desktop IPC sender.");
  });

  it("rejects incomplete or extra offline source keys", async () => {
    const { handler, manager } = setup();
    await expect(
      handler({
        operation: "install",
        consent: true,
        offlineSource: {
          archivePath: "/tmp/archive",
          manifestPath: "/tmp/manifest",
          signaturePath: ""
        }
      })
    ).rejects.toThrow("Invalid Privacy Filter install request.");
    expect(manager.installPrivacy).not.toHaveBeenCalled();
  });
});

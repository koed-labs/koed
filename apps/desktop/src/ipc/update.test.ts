import { describe, expect, it, vi } from "vitest";
import { desktopUpdateCommandChannel } from "@koed/shared/desktop-update-contract";
import { registerDesktopUpdateIpc } from "./update.js";

const state = {
  installedVersion: "0.10.0",
  status: "idle" as const,
  release: null,
  checkedAt: null
};
const createHarness = () => {
  const mainFrame = { url: "koed://app/" };
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      mainFrame,
      isDestroyed: vi.fn(() => false),
      send: vi.fn()
    }
  };
  let handler: ((event: any, request: unknown) => Promise<unknown>) | undefined;
  const ipcMain = {
    handle: vi.fn((channel: string, callback: typeof handler) => {
      if (channel === desktopUpdateCommandChannel) handler = callback;
    }),
    removeHandler: vi.fn()
  };
  const unsubscribe = vi.fn();
  const discovery = {
    current: vi.fn(() => state),
    subscribe: vi.fn((callback: (value: typeof state) => void) => {
      callback(state);
      return unsubscribe;
    }),
    check: vi.fn(async () => state),
    start: vi.fn(),
    dispose: vi.fn()
  };
  const openRelease = vi.fn(async () => undefined);
  const dispose = registerDesktopUpdateIpc({
    ipcMain,
    getMainWindow: () => window as never,
    allowedRendererOrigins: new Set(["koed://app"]),
    discovery,
    openRelease
  });
  const event = {
    sender: window.webContents,
    senderFrame: mainFrame
  };
  return {
    dispose,
    discovery,
    event,
    getHandler: () => handler,
    ipcMain,
    openRelease,
    window
  };
};

describe("Desktop update IPC", () => {
  it("registers only fixed commands and rejects malformed requests", async () => {
    const h = createHarness();
    expect(h.ipcMain.handle).toHaveBeenCalledExactlyOnceWith(
      desktopUpdateCommandChannel,
      expect.any(Function)
    );
    await expect(
      h.getHandler()!(h.event, { operation: "check", url: "x" })
    ).rejects.toThrow();
    await expect(
      h.getHandler()!(h.event, { operation: "download" })
    ).rejects.toThrow();
  });

  it("allows state/check/open operations only from active trusted main frame", async () => {
    const h = createHarness();
    await expect(
      h.getHandler()!(h.event, { operation: "get_state" })
    ).resolves.toEqual(state);
    await h.getHandler()!(h.event, { operation: "check" });
    expect(h.discovery.check).toHaveBeenCalledOnce();
    await h.getHandler()!(h.event, { operation: "open_release" });
    expect(h.openRelease).toHaveBeenCalledOnce();
    const reject = async (event: any) =>
      expect(
        h.getHandler()!(event, { operation: "get_state" })
      ).rejects.toThrow();
    await reject({ ...h.event, sender: {} });
    await reject({ ...h.event, senderFrame: { url: "koed://app/child" } });
    h.discovery.current.mockClear();
    h.discovery.check.mockClear();
    h.openRelease.mockClear();
    h.event.senderFrame.url = "https://foreign.example/";
    await reject(h.event);
    expect(h.discovery.current).not.toHaveBeenCalled();
    expect(h.discovery.check).not.toHaveBeenCalled();
    expect(h.openRelease).not.toHaveBeenCalled();
    h.window.isDestroyed.mockReturnValue(true);
    await reject(h.event);
  });

  it("does not broadcast updates when the active main frame has an untrusted origin", () => {
    const h = createHarness();
    const sendCount = h.window.webContents.send.mock.calls.length;
    h.event.senderFrame.url = "https://foreign.example/";
    const publish = h.discovery.subscribe.mock.calls[0]?.[0];
    publish?.(state);
    expect(h.window.webContents.send).toHaveBeenCalledTimes(sendCount);
  });

  it("sanitizes opener failures and disposes only its subscription and handler once", async () => {
    const h = createHarness();
    h.openRelease.mockRejectedValue(new Error("sensitive local path"));
    await expect(
      h.getHandler()!(h.event, { operation: "open_release" })
    ).rejects.toThrow("Unable to open release page.");
    h.dispose();
    h.dispose();
    expect(h.ipcMain.removeHandler).toHaveBeenCalledExactlyOnceWith(
      desktopUpdateCommandChannel
    );
    expect(h.discovery.subscribe.mock.results[0]?.value).toHaveBeenCalledOnce();
  });
});

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { desktopUpdateCommandChannel, desktopUpdateEventChannel } from "@koed/shared/desktop-update-contract";
import { createUpdateDiscovery } from "../main/update-discovery.js";
import { registerDesktopUpdateIpc } from "./update.js";

const setup = () => {
  let handler: ((event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) | undefined;
  const frame = { url: "koed://app/index.html" };
  const webContents = { mainFrame: frame, send: vi.fn(), isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const ipcMain = { handle: vi.fn((_name, value) => { handler = value; }), removeHandler: vi.fn() } as Pick<IpcMain, "handle" | "removeHandler">;
  const discovery = createUpdateDiscovery({ installedVersion: "0.8.1", eligible: false });
  const openExternal = vi.fn(async (_url: string) => {});
  const dispose = registerDesktopUpdateIpc({ ipcMain, discovery,
    getMainWindow: () => window as unknown as BrowserWindow,
    allowedRendererOrigins: new Set(["koed://app"]), openExternal });
  return { event, webContents, window, ipcMain, discovery, dispose, openExternal,
    invoke: (...args: unknown[]) => handler!(event, ...args),
    foreign: (input: unknown) => handler!(input as IpcMainInvokeEvent, { operation: "get_state" }) };
};

describe("Desktop update notice IPC", () => {
  it("registers only fixed commands and validates every input", async () => {
    const f = setup();
    expect(f.ipcMain.handle).toHaveBeenCalledWith(desktopUpdateCommandChannel, expect.any(Function));
    expect(await f.invoke({ operation: "get_state" })).toEqual(f.discovery.current());
    for (const input of [{ operation: "download" }, { operation: "install" }, { operation: "check", url: "https://evil.test" }]) {
      await expect(f.invoke(input)).rejects.toThrow();
    }
    await expect(f.invoke({ operation: "check" }, "extra")).rejects.toThrow();
    await expect(f.invoke({ operation: "open_release" })).rejects.toThrow("No supported update release");
    expect(f.openExternal).not.toHaveBeenCalled();
    f.dispose(); f.discovery.dispose();
  });

  it("rejects subframes, same-origin foreign windows, bad origins and destroyed windows", async () => {
    const f = setup();
    const foreignWindow = { ...f.event, sender: { ...f.webContents } };
    const subframe = { ...f.event, senderFrame: { url: "koed://app/index.html" } };
    for (const event of [foreignWindow, subframe, { ...f.event, senderFrame: null }]) {
      await expect(f.foreign(event)).rejects.toThrow("Untrusted Desktop update sender");
    }
    f.webContents.mainFrame.url = "https://evil.test/";
    await expect(f.invoke({ operation: "get_state" })).rejects.toThrow();
    f.webContents.mainFrame.url = "not a URL";
    await expect(f.invoke({ operation: "get_state" })).rejects.toThrow();
    f.webContents.mainFrame.url = "koed://app/index.html";
    f.window.isDestroyed = () => true;
    await expect(f.invoke({ operation: "get_state" })).rejects.toThrow();
    f.dispose(); f.discovery.dispose();
  });

  it("sanitizes opener failures and removes only owned handler/subscription", async () => {
    const f = setup();
    const current = { ...f.discovery.current(), status: "available" as const,
      release: { version: "0.9.0", summary: "notes" } };
    vi.spyOn(f.discovery, "current").mockReturnValue(current);
    f.openExternal.mockRejectedValueOnce(new Error("private path/token"));
    await expect(f.invoke({ operation: "open_release" })).rejects.toThrow("Could not open official release page");
    await f.invoke({ operation: "open_release" });
    expect(f.openExternal).toHaveBeenCalledWith("https://github.com/koed-labs/koed/releases/tag/v0.9.0");
    f.dispose(); f.dispose();
    expect(f.ipcMain.removeHandler).toHaveBeenCalledExactlyOnceWith(desktopUpdateCommandChannel);
    expect(f.webContents.send).not.toHaveBeenCalledWith(desktopUpdateEventChannel, expect.anything());
    f.discovery.dispose();
  });
});

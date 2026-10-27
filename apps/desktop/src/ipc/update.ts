import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  desktopUpdateCommandChannel, desktopUpdateEventChannel,
  desktopUpdateRequestSchema, desktopUpdateStateSchema
} from "@koed/shared/desktop-update-contract";
import { officialReleasePage, type DesktopUpdateDiscovery } from "../main/update-discovery.js";
import { desktopRendererOrigin } from "./protocol.js";

interface UpdateIpcOptions {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  discovery: DesktopUpdateDiscovery;
  getMainWindow(): BrowserWindow | null;
  allowedRendererOrigins: ReadonlySet<string>;
  openExternal(url: string): Promise<void>;
}

const trustedWindow = (options: UpdateIpcOptions): BrowserWindow | null => {
  const window = options.getMainWindow();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null;
  try {
    return options.allowedRendererOrigins.has(desktopRendererOrigin(window.webContents.mainFrame.url)) ? window : null;
  } catch { return null; }
};

const assertSender = (event: IpcMainInvokeEvent, options: UpdateIpcOptions): void => {
  const window = trustedWindow(options);
  if (!window || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error("Untrusted Desktop update sender.");
  }
};

const openRelease = async (options: UpdateIpcOptions): Promise<void> => {
  const release = options.discovery.current().release;
  if (!release) throw new Error("No supported update release is available.");
  const url = officialReleasePage(release.version);
  try { await options.openExternal(url); }
  catch { throw new Error("Could not open official release page."); }
};

export const registerDesktopUpdateIpc = (options: UpdateIpcOptions): (() => void) => {
  const { ipcMain, discovery } = options;
  ipcMain.handle(desktopUpdateCommandChannel, async (event, ...args: unknown[]) => {
    assertSender(event, options);
    if (args.length !== 1) throw new Error("Invalid Desktop update request.");
    const request = desktopUpdateRequestSchema.parse(args[0]);
    if (request.operation === "check") await discovery.check();
    if (request.operation === "open_release") await openRelease(options);
    return desktopUpdateStateSchema.parse(discovery.current());
  });
  const unsubscribe = discovery.subscribe((state) => {
    trustedWindow(options)?.webContents.send(desktopUpdateEventChannel, desktopUpdateStateSchema.parse(state));
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    ipcMain.removeHandler(desktopUpdateCommandChannel);
  };
};

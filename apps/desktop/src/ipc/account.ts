import {
  accountCommandChannel,
  accountCommandSchema,
  accountStateChannel,
  accountStateSchema
} from "@koed-labs/shared/account";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { AccountController } from "../account/controller.js";
import { desktopRendererOrigin } from "./protocol.js";
export function registerAccountIpc(input: {
  ipcMain: IpcMain;
  getMainWindow(): BrowserWindow | null;
  allowedRendererOrigins: ReadonlySet<string>;
  controller: AccountController;
}) {
  const trusted = () => {
    const window = input.getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed())
      return null;
    try {
      return input.allowedRendererOrigins.has(
        desktopRendererOrigin(window.webContents.mainFrame.url)
      )
        ? window
        : null;
    } catch {
      return null;
    }
  };
  input.ipcMain.handle(
    accountCommandChannel,
    async (event: IpcMainInvokeEvent, value: unknown) => {
      const window = trusted();
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Unauthorized account request");
      return accountStateSchema.parse(
        await input.controller.command(accountCommandSchema.parse(value))
      );
    }
  );
  const unsubscribe = input.controller.subscribe((state) =>
    trusted()?.webContents.send(
      accountStateChannel,
      accountStateSchema.parse(state)
    )
  );
  return () => {
    unsubscribe();
    input.ipcMain.removeHandler(accountCommandChannel);
  };
}

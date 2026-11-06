import {
  desktopUpdateCommandChannel,
  desktopUpdateEventChannel,
  desktopUpdateRequestSchema,
  desktopUpdateStateSchema
} from "@koed/shared/desktop-update-contract";
import type { DesktopUpdateDiscovery } from "../main/update-discovery.js";
import { desktopRendererOrigin } from "./protocol.js";

interface UpdateIpcOptions {
  ipcMain: {
    handle(
      channel: string,
      handler: (event: any, request: unknown) => Promise<unknown>
    ): void;
    removeHandler(channel: string): void;
  };
  getMainWindow(): {
    isDestroyed(): boolean;
    webContents: {
      mainFrame: unknown;
      isDestroyed(): boolean;
      send(channel: string, value: unknown): void;
    };
  } | null;
  allowedRendererOrigins: ReadonlySet<string>;
  discovery: DesktopUpdateDiscovery;
  openRelease(): Promise<void>;
}

export const registerDesktopUpdateIpc = (
  options: UpdateIpcOptions
): (() => void) => {
  let active = true;
  const isAuthorized = (event: any): boolean => {
    const window = options.getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed())
      return false;
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      return false;
    try {
      return options.allowedRendererOrigins.has(
        desktopRendererOrigin(event.senderFrame.url)
      );
    } catch {
      return false;
    }
  };
  const unsubscribe = options.discovery.subscribe((state) => {
    const parsed = desktopUpdateStateSchema.safeParse(state);
    const window = options.getMainWindow();
    if (
      active &&
      parsed.success &&
      window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed()
    ) {
      window.webContents.send(desktopUpdateEventChannel, parsed.data);
    }
  });
  options.ipcMain.handle(desktopUpdateCommandChannel, async (event, value) => {
    if (!active || !isAuthorized(event))
      throw new Error("Unauthorized Desktop update request.");
    const request = desktopUpdateRequestSchema.parse(value);
    if (request.operation === "get_state")
      return desktopUpdateStateSchema.parse(options.discovery.current());
    if (request.operation === "check")
      return desktopUpdateStateSchema.parse(await options.discovery.check());
    try {
      await options.openRelease();
    } catch {
      throw new Error("Unable to open release page.");
    }
    return desktopUpdateStateSchema.parse(options.discovery.current());
  });
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    options.ipcMain.removeHandler(desktopUpdateCommandChannel);
  };
};

export type { UpdateIpcOptions };

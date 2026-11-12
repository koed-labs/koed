import {
  desktopUpdateCommandChannel,
  desktopUpdateEventChannel,
  desktopUpdateRequestSchema,
  desktopUpdateStateSchema
} from "@koed-labs/shared/desktop-update-contract";
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
      mainFrame: { url: string };
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
  const isTrustedMainWindow = (
    window: NonNullable<ReturnType<UpdateIpcOptions["getMainWindow"]>>
  ): boolean => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
    try {
      return options.allowedRendererOrigins.has(
        desktopRendererOrigin(window.webContents.mainFrame.url)
      );
    } catch {
      return false;
    }
  };
  const isAuthorized = (event: any): boolean => {
    const window = options.getMainWindow();
    if (!window || !isTrustedMainWindow(window)) return false;
    return (
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame
    );
  };
  const unsubscribe = options.discovery.subscribe((state) => {
    const parsed = desktopUpdateStateSchema.safeParse(state);
    const window = options.getMainWindow();
    if (active && parsed.success && window && isTrustedMainWindow(window)) {
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

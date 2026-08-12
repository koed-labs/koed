import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  desktopUpdateCommandSchema,
  desktopUpdateStateSchema,
  desktopUpdateVersionSchema,
  type DesktopUpdateState
} from "@koed/shared";
import type { DesktopUpdateCoordinator } from "../main/update-coordinator.js";
import {
  desktopRendererOrigin,
  desktopUpdateCommandChannel,
  desktopUpdateGetStateChannel,
  desktopUpdateSubscribeChannel,
  desktopUpdateVersionChannel
} from "./protocol.js";

export const isTrustedDesktopUpdateSender = (
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  allowedRendererOrigins: ReadonlySet<string>
): boolean => {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    return false;
  }
  try {
    return allowedRendererOrigins.has(
      desktopRendererOrigin(event.senderFrame.url)
    );
  } catch {
    return false;
  }
};

const parseState = (state: unknown): DesktopUpdateState =>
  desktopUpdateStateSchema.parse(state);

const assertNoInput = (value: unknown, label: string): void => {
  if (value !== undefined) throw new Error(`Unexpected ${label} input.`);
};

export interface DesktopUpdateIpcOptions {
  readonly allowedRendererOrigins: ReadonlySet<string>;
  readonly broadcastState: (state: DesktopUpdateState) => void;
  readonly getAppVersion: () => string;
}

export type DesktopUpdateIpcCoordinator = Pick<
  DesktopUpdateCoordinator,
  "getState" | "subscribe" | "check" | "download" | "install"
>;

/**
 * Registers the fixed, main-owned update channels and returns their lifecycle
 * disposer. No renderer-provided value is forwarded to the updater.
 */
export const registerDesktopUpdateIpc = (
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">,
  coordinator: DesktopUpdateIpcCoordinator,
  options: DesktopUpdateIpcOptions
): (() => void) => {
  let disposed = false;
  const trusted = (event: IpcMainInvokeEvent): void => {
    if (!isTrustedDesktopUpdateSender(event, options.allowedRendererOrigins)) {
      throw new Error("Untrusted Desktop IPC sender.");
    }
  };
  const currentState = (): DesktopUpdateState =>
    parseState(coordinator.getState());
  const unsubscribeCoordinator = coordinator.subscribe((state) => {
    if (!disposed) options.broadcastState(parseState(state));
  });

  ipcMain.handle(desktopUpdateGetStateChannel, async (event, value) => {
    trusted(event);
    assertNoInput(value, "update state");
    return currentState();
  });

  ipcMain.handle(desktopUpdateSubscribeChannel, async (event, value) => {
    trusted(event);
    assertNoInput(value, "update subscription");
    // The preload invokes this only after installing its wrapped listener and
    // delivers this validated snapshot to that one subscription. State-change
    // events remain broadcast, so duplicate subscriptions do not cross-deliver
    // duplicate initial snapshots to one another.
    return currentState();
  });

  ipcMain.handle(desktopUpdateVersionChannel, async (event, value) => {
    trusted(event);
    assertNoInput(value, "application version");
    return desktopUpdateVersionSchema.parse(options.getAppVersion());
  });

  ipcMain.handle(desktopUpdateCommandChannel, async (event, value) => {
    trusted(event);
    const command = desktopUpdateCommandSchema.parse(value);
    try {
      let state: DesktopUpdateState;
      switch (command) {
        case "check":
          state = await coordinator.check();
          break;
        case "download":
          state = await coordinator.download();
          break;
        case "install":
          state = await coordinator.install();
          break;
      }
      return parseState(state);
    } catch {
      throw new Error("Koed update command failed.");
    }
  });

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribeCoordinator();
    ipcMain.removeHandler(desktopUpdateGetStateChannel);
    ipcMain.removeHandler(desktopUpdateSubscribeChannel);
    ipcMain.removeHandler(desktopUpdateVersionChannel);
    ipcMain.removeHandler(desktopUpdateCommandChannel);
  };
};

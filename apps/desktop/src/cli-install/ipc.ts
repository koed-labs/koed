import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { DesktopCliInstallManager } from "./manager.js";
import {
  cliInstallCommandChannel,
  cliInstallProgressChannel,
  type CliInstallCommand
} from "./protocol.js";

const trusted = (
  event: IpcMainInvokeEvent,
  origins: ReadonlySet<string>
): boolean => {
  try {
    if (!event.senderFrame) return false;
    return origins.has(new URL(event.senderFrame.url).origin);
  } catch {
    return false;
  }
};

const parseCommand = (value: unknown): CliInstallCommand => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid CLI install command.");
  const command = value as Record<string, unknown>;
  switch (command.operation) {
    case "status":
    case "cancel":
    case "select-offline":
    case "launcher-inspect":
    case "launcher-remove":
      return { operation: command.operation } as CliInstallCommand;
    case "install":
      if (
        typeof command.consent !== "boolean" ||
        (command.offlinePath !== undefined &&
          typeof command.offlinePath !== "string")
      )
        throw new Error("Invalid Privacy Filter install request.");
      return {
        operation: "install",
        consent: command.consent,
        ...(typeof command.offlinePath === "string"
          ? { offlinePath: command.offlinePath }
          : {})
      };
    case "launcher-install":
      if (
        typeof command.consent !== "boolean" ||
        command.destination !== undefined
      )
        throw new Error("Launcher destination must be chosen in Desktop.");
      return { operation: "launcher-install", consent: command.consent };
    case "path-update":
      if (
        (command.operationKind !== "add" &&
          command.operationKind !== "remove") ||
        typeof command.consent !== "boolean"
      )
        throw new Error("Invalid PATH update request.");
      return {
        operation: "path-update",
        operationKind: command.operationKind,
        consent: command.consent
      };
    default:
      throw new Error("Unsupported CLI install operation.");
  }
};

export const registerCliInstallIpc = (input: {
  ipcMain: Pick<IpcMain, "handle">;
  allowedRendererOrigins: ReadonlySet<string>;
  manager: DesktopCliInstallManager;
  selectLauncherDestination(): Promise<string | null>;
}): void => {
  input.ipcMain.handle(
    cliInstallCommandChannel,
    async (event, value: unknown) => {
      if (!trusted(event, input.allowedRendererOrigins))
        throw new Error("Untrusted Desktop IPC sender.");
      const command = parseCommand(value);
      switch (command.operation) {
        case "status":
          return input.manager.getStatus();
        case "install":
          return input.manager.installPrivacy(
            command.consent,
            command.offlinePath
          );
        case "cancel":
          return input.manager.cancel();
        case "select-offline":
          return input.manager.selectOffline();
        case "launcher-inspect":
          return input.manager.launcher("inspect");
        case "launcher-install": {
          const destination = await input.selectLauncherDestination();
          if (!destination) return input.manager.launcher("inspect");
          return input.manager.launcher("install", {
            consent: command.consent,
            destination
          });
        }
        case "launcher-remove":
          return input.manager.launcher("remove");
        case "path-update":
          return input.manager.updatePath(
            command.operationKind,
            command.consent
          );
      }
    }
  );
};

export const sendCliInstallProgress = (
  manager: DesktopCliInstallManager,
  send: (channel: string, value: unknown) => void
): void => {
  manager.setProgressListener((progress) =>
    send(cliInstallProgressChannel, progress)
  );
};

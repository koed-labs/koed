import type { IpcMain } from "electron";
import type { DesktopCommandHandler } from "../koed-server/manager.js";

export const invokeChannel = "koed:invoke";

export const registerDesktopCommandHandlers = (
  ipcMain: Pick<IpcMain, "handle">,
  handlers: Record<string, DesktopCommandHandler>
): void => {
  ipcMain.handle(
    invokeChannel,
    async (_event, command: string, args?: Record<string, unknown>) => {
      const handler = handlers[command];
      if (!handler) {
        throw new Error(`Unknown desktop command: ${command}`);
      }
      return await handler(args);
    }
  );
};

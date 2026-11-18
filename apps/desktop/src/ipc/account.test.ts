import { describe, expect, it, vi } from "vitest";
import { registerAccountIpc } from "./account.js";
import {
  accountCommandChannel,
  accountStateChannel
} from "@koed-labs/shared/account";
import type { AccountController } from "../account/controller.js";
import type { BrowserWindow, IpcMain } from "electron";
const state = {
  status: "signed_out",
  profile: null,
  stale: false,
  busy: false,
  message: null,
  revision: 1
};
describe("account IPC authority", () => {
  it("accepts only the trusted main window/frame and rejects arbitrary network commands", async () => {
    let handler!: (event: unknown, input: unknown) => Promise<unknown>;
    let publish!: (state: unknown) => void;
    const send = vi.fn();
    const frame = { url: "https://desktop.example.test/" };
    const webContents = { mainFrame: frame, isDestroyed: () => false, send };
    const window = { isDestroyed: () => false, webContents };
    const command = vi.fn(async () => state);
    const dispose = registerAccountIpc({
      ipcMain: {
        handle: vi.fn((_channel, fn) => {
          handler = fn;
        }),
        removeHandler: vi.fn()
      } as unknown as IpcMain,
      getMainWindow: () => window as unknown as BrowserWindow,
      allowedRendererOrigins: new Set(["https://desktop.example.test"]),
      controller: {
        command,
        subscribe: (fn: typeof publish) => {
          publish = fn;
          return () => undefined;
        }
      } as unknown as AccountController
    });
    expect(accountCommandChannel).toBe("koed:account:command");
    const event = { sender: webContents, senderFrame: frame };
    expect(await handler(event, { operation: "getState" })).toEqual(state);
    await expect(
      handler({ ...event, senderFrame: {} }, { operation: "getState" })
    ).rejects.toThrow("Unauthorized");
    await expect(
      handler({ ...event, sender: {} }, { operation: "getState" })
    ).rejects.toThrow("Unauthorized");
    await expect(
      handler(event, { operation: "fetch", url: "https://attacker.test" })
    ).rejects.toThrow();
    frame.url = "https://attacker.test/";
    publish(state);
    expect(send).not.toHaveBeenCalled();
    frame.url = "https://desktop.example.test/";
    publish(state);
    expect(send).toHaveBeenCalledWith(accountStateChannel, state);
    expect(command).toHaveBeenCalledTimes(1);
    dispose();
  });
});

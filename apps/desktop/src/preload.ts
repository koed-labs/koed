import { contextBridge, ipcRenderer } from "electron";
import { invokeChannel } from "./ipc/commands.js";

contextBridge.exposeInMainWorld("koedDesktop", {
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke(invokeChannel, command, args)
});

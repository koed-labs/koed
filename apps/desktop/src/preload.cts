import { contextBridge, ipcRenderer } from "electron";

const invokeChannel = "koed:invoke";

contextBridge.exposeInMainWorld("koedDesktop", {
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke(invokeChannel, command, args)
});

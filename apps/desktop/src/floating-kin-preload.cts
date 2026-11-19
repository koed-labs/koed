import { contextBridge, ipcRenderer } from "electron";
import {
  floatingKinChannels as channels,
  type FloatingKinBridge
} from "./ipc/floating-kin-protocol.js";

const bridge: FloatingKinBridge = {
  activity: () => ipcRenderer.invoke(channels.activity),
  summarize: (input) => ipcRenderer.invoke(channels.summarize, input),
  cancel: () => ipcRenderer.invoke(channels.cancel),
  setInteractive: (interactive) =>
    ipcRenderer.send(channels.setInteractive, interactive),
  setSize: (size) => ipcRenderer.send(channels.setSize, size)
};

contextBridge.exposeInMainWorld("floatingKin", Object.freeze(bridge));

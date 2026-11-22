import { contextBridge, ipcRenderer } from "electron";
import { createKinSurfacePreloadApi } from "./ipc/desktop-kin-preload.js";
import { subscribeToMainWindowFocus } from "./ipc/floating-kin-focus.js";
import {
  floatingKinChannels as channels,
  type FloatingKinBridge
} from "./ipc/floating-kin-protocol.js";

const bridge: FloatingKinBridge = {
  ...createKinSurfacePreloadApi(ipcRenderer),
  completeExit: (revision) => ipcRenderer.send(channels.completeExit, revision),
  setInteractive: (interactive) =>
    ipcRenderer.send(channels.setInteractive, interactive),
  setSize: (size) => ipcRenderer.send(channels.setSize, size),
  drag: (input) => ipcRenderer.send(channels.drag, input),
  onMainWindowFocus: (listener) =>
    subscribeToMainWindowFocus(
      listener,
      () => ipcRenderer.invoke(channels.mainWindowFocused),
      (receive) => {
        const change = (_event: unknown, focused: unknown) => receive(focused);
        ipcRenderer.on(channels.mainWindowFocusChanged, change);
        return () =>
          ipcRenderer.removeListener(channels.mainWindowFocusChanged, change);
      }
    )
};

contextBridge.exposeInMainWorld("floatingKin", Object.freeze(bridge));

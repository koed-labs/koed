import { contextBridge, ipcRenderer } from "electron";
import { createProjectsPreloadApi } from "../../src/ipc/projects-preload.js";
contextBridge.exposeInMainWorld("hq713", {
  profile: () => ipcRenderer.invoke("hq713:profile"),
  collaboration: {
    command: (command: unknown) =>
      ipcRenderer.invoke("hq713:collaboration", command),
    subscribe: (listener: (event: unknown) => void) => {
      const forward = (_event: Electron.IpcRendererEvent, payload: unknown) =>
        listener(payload);
      ipcRenderer.on("hq713:collaboration-event", forward);
      return () =>
        ipcRenderer.removeListener("hq713:collaboration-event", forward);
    }
  },
  projects: createProjectsPreloadApi((channel, request) =>
    ipcRenderer.invoke(channel, request)
  )
});

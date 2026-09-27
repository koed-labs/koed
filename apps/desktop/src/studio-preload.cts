import { contextBridge, ipcRenderer } from "electron";
import { createStudioChatRecoveryPreloadApi } from "./ipc/studio-chat-recovery-preload.js";

contextBridge.exposeInMainWorld(
  "koedStudioChatRecovery",
  createStudioChatRecoveryPreloadApi((channel, value) =>
    ipcRenderer.invoke(channel, value)
  )
);

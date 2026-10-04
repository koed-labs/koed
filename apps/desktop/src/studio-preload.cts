import { contextBridge, ipcRenderer } from "electron";
import { createStudioChatRecoveryPreloadApi } from "./ipc/studio-chat-recovery-preload.js";
import { createStudioPersonalCatalogCachePreloadApi } from "./ipc/studio-personal-catalog-cache-preload.js";
import { createLocalAiClientPreloadApi } from "./ipc/local-ai-client-preload.js";
import { createPersonalDevicePairingPreloadApi } from "./ipc/personal-device-pairing-preload.js";
import { createStudioNotificationsPreloadApi } from "./ipc/studio-notifications-preload.js";
import {
  isDesktopCommandName,
  isStudioDesktopCommandName,
  setupCommandChannel,
  setupProgressEventChannel,
  clipboardWriteChannel
} from "./ipc/protocol.js";

const invoke = (command: string, args?: Record<string, unknown>) => {
  if (!isStudioDesktopCommandName(command) || !isDesktopCommandName(command)) {
    throw new Error("Unsupported Studio Desktop command.");
  }
  return ipcRenderer.invoke("koed:invoke", command, args);
};

contextBridge.exposeInMainWorld("koedDesktop", {
  invoke,
  localAiClients: createLocalAiClientPreloadApi((channel, value) =>
    ipcRenderer.invoke(channel, value)
  ),
  devices: createPersonalDevicePairingPreloadApi(
    (channel, value) => ipcRenderer.invoke(channel, value),
    {
      on: (channel, listener) => ipcRenderer.on(channel, listener),
      removeListener: (channel, listener) =>
        ipcRenderer.removeListener(channel, listener)
    }
  ),
  clipboard: Object.freeze({
    writeText: (value: string): Promise<void> =>
      ipcRenderer.invoke(clipboardWriteChannel, value)
  }),
  notifications: createStudioNotificationsPreloadApi(
    (channel, value) => ipcRenderer.invoke(channel, value),
    {
      on: (channel, listener) => ipcRenderer.on(channel, listener),
      removeListener: (channel, listener) =>
        ipcRenderer.removeListener(channel, listener)
    }
  ),
  setup: Object.freeze({
    inspect: () => ipcRenderer.invoke(setupCommandChannel, "inspect"),
    run: () => ipcRenderer.invoke(setupCommandChannel, "run"),
    subscribe: (listener: (snapshot: unknown) => void) => {
      if (typeof listener !== "function") {
        throw new TypeError("Setup progress listener is required.");
      }
      let active = true;
      const wrapped = (_event: unknown, snapshot: unknown) => {
        if (active) listener(snapshot);
      };
      ipcRenderer.on(setupProgressEventChannel, wrapped);
      return () => {
        active = false;
        ipcRenderer.removeListener(setupProgressEventChannel, wrapped);
      };
    }
  })
});

contextBridge.exposeInMainWorld(
  "koedStudioChatRecovery",
  createStudioChatRecoveryPreloadApi((channel, value) =>
    ipcRenderer.invoke(channel, value)
  )
);
contextBridge.exposeInMainWorld(
  "koedStudioPersonalCatalogCache",
  createStudioPersonalCatalogCachePreloadApi((channel, value) =>
    ipcRenderer.invoke(channel, value)
  )
);

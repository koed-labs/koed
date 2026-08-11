import { contextBridge, ipcRenderer } from "electron";
import type {
  CollaborationCommandResult,
  CollaborationRendererCommand,
  CollaborationRendererEvent
} from "@koed/shared/collaboration";
import {
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  collaborationRendererEventSchema
} from "@koed/shared/collaboration";
import {
  desktopUpdateStateSchema,
  desktopUpdateVersionSchema
} from "@koed/shared";
import { createPersonalMemoryPreloadApi } from "./ipc/personal-memory-preload.js";
import { createManagedConversationPreloadApi } from "./ipc/managed-conversation-preload.js";
import { createPersonalDevicePairingPreloadApi } from "./ipc/personal-device-pairing-preload.js";
import {
  clipboardWriteChannel,
  desktopCommandNames,
  setupCommandChannel,
  setupProgressEventChannel,
  desktopUpdateCommandChannel,
  desktopUpdateGetStateChannel,
  desktopUpdateStateEventChannel,
  desktopUpdateSubscribeChannel,
  desktopUpdateVersionChannel,
  themePreferenceGetChannel,
  themePreferenceSetChannel
} from "./ipc/protocol.js";

const invokeChannel = "koed:invoke";
const collaborationCommandChannel = "koed:collaboration:command";
const collaborationEventChannel = "koed:collaboration:event";
const allowedDesktopCommandNames = new Set<string>(desktopCommandNames);
contextBridge.exposeInMainWorld("koedDesktop", {
  invoke: (command: string, args?: Record<string, unknown>) => {
    if (!allowedDesktopCommandNames.has(command)) {
      throw new Error("Unsupported Desktop command.");
    }
    return ipcRenderer.invoke(invokeChannel, command, args);
  },
  personalMemory: createPersonalMemoryPreloadApi(
    (channel, value) => ipcRenderer.invoke(channel, value),
    {
      on: (channel, listener) => ipcRenderer.on(channel, listener),
      removeListener: (channel, listener) =>
        ipcRenderer.removeListener(channel, listener)
    }
  ),
  managedConversations: createManagedConversationPreloadApi((channel, value) =>
    ipcRenderer.invoke(channel, value)
  ),
  clipboard: Object.freeze({
    writeText: (value: string): Promise<void> =>
      ipcRenderer.invoke(clipboardWriteChannel, value)
  }),
  devices: createPersonalDevicePairingPreloadApi(
    (channel, value) => ipcRenderer.invoke(channel, value),
    {
      on: (channel, listener) => ipcRenderer.on(channel, listener),
      removeListener: (channel, listener) =>
        ipcRenderer.removeListener(channel, listener)
    }
  ),
  theme: Object.freeze({
    get: () => ipcRenderer.invoke(themePreferenceGetChannel),
    set: (preference: "light" | "dark" | "system") =>
      ipcRenderer.invoke(themePreferenceSetChannel, preference)
  }),
  setup: Object.freeze({
    inspect: () => ipcRenderer.invoke(setupCommandChannel, "inspect"),
    run: () => ipcRenderer.invoke(setupCommandChannel, "run"),
    subscribe: (listener: (snapshot: unknown) => void) => {
      if (typeof listener !== "function") {
        throw new TypeError("Setup progress listener is required.");
      }
      let active = true;
      const wrapped = (_ipcEvent: unknown, snapshot: unknown) => {
        if (active) listener(snapshot);
      };
      ipcRenderer.on(setupProgressEventChannel, wrapped);
      return () => {
        active = false;
        ipcRenderer.removeListener(setupProgressEventChannel, wrapped);
      };
    }
  }),
  update: Object.freeze({
    getState: async () =>
      desktopUpdateStateSchema.parse(
        await ipcRenderer.invoke(desktopUpdateGetStateChannel)
      ),
    check: async () =>
      desktopUpdateStateSchema.parse(
        await ipcRenderer.invoke(desktopUpdateCommandChannel, "check")
      ),
    download: async () =>
      desktopUpdateStateSchema.parse(
        await ipcRenderer.invoke(desktopUpdateCommandChannel, "download")
      ),
    install: async () =>
      desktopUpdateStateSchema.parse(
        await ipcRenderer.invoke(desktopUpdateCommandChannel, "install")
      ),
    subscribe: (listener: (state: unknown) => void) => {
      if (typeof listener !== "function") {
        throw new TypeError("Update state listener is required.");
      }
      let active = true;
      let receivedEvent = false;
      const wrapped = (_ipcEvent: unknown, value: unknown) => {
        if (!active) return;
        const parsed = desktopUpdateStateSchema.safeParse(value);
        if (parsed.success) listener(parsed.data);
        if (parsed.success) receivedEvent = true;
      };
      ipcRenderer.on(desktopUpdateStateEventChannel, wrapped);
      void ipcRenderer
        .invoke(desktopUpdateSubscribeChannel)
        .then((value: unknown) => {
          if (!active || receivedEvent) return;
          const parsed = desktopUpdateStateSchema.safeParse(value);
          if (parsed.success) listener(parsed.data);
        })
        .catch(() => {
          // A disposed main process cannot leave a renderer listener active.
          if (!active) return;
          active = false;
          ipcRenderer.removeListener(desktopUpdateStateEventChannel, wrapped);
        });
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener(desktopUpdateStateEventChannel, wrapped);
      };
    },
    getVersion: async () =>
      desktopUpdateVersionSchema.parse(
        await ipcRenderer.invoke(desktopUpdateVersionChannel)
      )
  }),
  collaboration: Object.freeze({
    command: async (
      value: CollaborationRendererCommand
    ): Promise<CollaborationCommandResult> => {
      const command = collaborationRendererCommandSchema.parse(value);
      const result: unknown = await ipcRenderer.invoke(
        collaborationCommandChannel,
        command
      );
      const parsed = collaborationCommandResultSchema.parse(result);
      if (
        parsed.requestId !== command.requestId ||
        parsed.command !== command.command
      ) {
        throw new Error("Invalid collaboration command correlation.");
      }
      return parsed;
    },
    subscribe: (listener: (event: CollaborationRendererEvent) => void) => {
      if (typeof listener !== "function") {
        throw new TypeError("Collaboration event listener is required.");
      }
      let active = true;
      const wrapped = (_ipcEvent: unknown, value: unknown) => {
        if (!active) return;
        const event = collaborationRendererEventSchema.safeParse(value);
        if (!event.success) return;
        listener(event.data);
      };
      ipcRenderer.on(collaborationEventChannel, wrapped);
      return () => {
        active = false;
        ipcRenderer.removeListener(collaborationEventChannel, wrapped);
      };
    }
  })
});

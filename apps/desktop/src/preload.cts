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
import { createPersonalMemoryPreloadApi } from "./ipc/personal-memory-preload.js";
import {
  clipboardWriteChannel,
  setupCommandChannel,
  setupProgressEventChannel,
  themePreferenceGetChannel,
  themePreferenceSetChannel
} from "./ipc/protocol.js";

const invokeChannel = "koed:invoke";
const collaborationCommandChannel = "koed:collaboration:command";
const collaborationEventChannel = "koed:collaboration:event";
const desktopCommandNames = new Set([
  "status",
  "doctor",
  "stop",
  "setup_codex",
  "repair_codex",
  "runtime_status",
  "runtime_install",
  "models_status",
  "models_install",
  "package_status",
  "package_install",
  "project_list",
  "upstream_connect",
  "start",
  "start_daemon",
  "open_external",
  "open_logs"
]);
contextBridge.exposeInMainWorld("koedDesktop", {
  invoke: (command: string, args?: Record<string, unknown>) => {
    if (!desktopCommandNames.has(command)) {
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
  clipboard: Object.freeze({
    writeText: (value: string): Promise<void> =>
      ipcRenderer.invoke(clipboardWriteChannel, value)
  }),
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

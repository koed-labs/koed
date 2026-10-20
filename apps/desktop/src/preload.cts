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
import { createProjectsPreloadApi } from "./ipc/projects-preload.js";
import { createManagedMemoryActionPreloadApi } from "./ipc/managed-memory-action-preload.js";
import { createCuratedMemoryPreloadApi } from "./ipc/curated-memory-preload.js";
import { createAgentsPreloadApi } from "./ipc/agents-preload.js";
import { createManagedConversationPreloadApi } from "./ipc/managed-conversation-preload.js";
import { createProjectHqConversationPreloadApi } from "./ipc/project-hq-conversation-preload.js";
import { createLocalAiClientPreloadApi } from "./ipc/local-ai-client-preload.js";
import { createManagedProjectPreloadApi } from "./ipc/managed-project-preload.js";
import { createPersonalDevicePairingPreloadApi } from "./ipc/personal-device-pairing-preload.js";
import { createHqLayoutPreferencesPreloadApi } from "./ipc/hq-layout-preferences-preload.js";
import { createHqSidebarPreferencesPreloadApi } from "./ipc/hq-sidebar-preferences-preload.js";
import { desktopFeatureFlagsFromEnvironment } from "./ipc/desktop-feature-flags.js";
import {
  clipboardWriteChannel,
  desktopCommandNames,
  hardwareAccelerationGetChannel,
  hardwareAccelerationSetChannel,
  launchAtStartupGetChannel,
  launchAtStartupSetChannel,
  desktopStatusChangedChannel,
  setupCommandChannel,
  setupProgressEventChannel,
  themePreferenceGetChannel,
  themePreferenceSetChannel
} from "./ipc/protocol.js";

const invokeChannel = "koed:invoke";
const collaborationCommandChannel = "koed:collaboration:command";
const collaborationEventChannel = "koed:collaboration:event";
const allowedDesktopCommandNames = new Set<string>(desktopCommandNames);
contextBridge.exposeInMainWorld("koedDesktop", {
  featureFlags: desktopFeatureFlagsFromEnvironment(process.env),
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
  projects: createProjectsPreloadApi((channel, request) =>
    ipcRenderer.invoke(channel, request)
  ),
  managedMemoryActions: createManagedMemoryActionPreloadApi(
    (channel, request) => ipcRenderer.invoke(channel, request)
  ),
  curatedMemory: createCuratedMemoryPreloadApi((channel, request) =>
    ipcRenderer.invoke(channel, request)
  ),
  agents: createAgentsPreloadApi((channel, request) =>
    ipcRenderer.invoke(channel, request)
  ),
  managedConversations: createManagedConversationPreloadApi((channel, value) =>
    ipcRenderer.invoke(channel, value)
  ),
  projectHqConversation: createProjectHqConversationPreloadApi(
    (channel, value) => ipcRenderer.invoke(channel, value)
  ),
  localAiClients: createLocalAiClientPreloadApi((channel, value) =>
    ipcRenderer.invoke(channel, value)
  ),
  managedProject: createManagedProjectPreloadApi(
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
  devices: createPersonalDevicePairingPreloadApi(
    (channel, value) => ipcRenderer.invoke(channel, value),
    {
      on: (channel, listener) => ipcRenderer.on(channel, listener),
      removeListener: (channel, listener) =>
        ipcRenderer.removeListener(channel, listener)
    }
  ),
  hqLayout: createHqLayoutPreferencesPreloadApi((channel, ...args) =>
    ipcRenderer.invoke(channel, ...args)
  ),
  hqSidebar: createHqSidebarPreferencesPreloadApi((channel, ...args) =>
    ipcRenderer.invoke(channel, ...args)
  ),
  theme: Object.freeze({
    get: () => ipcRenderer.invoke(themePreferenceGetChannel),
    set: (preference: "light" | "dark" | "system") =>
      ipcRenderer.invoke(themePreferenceSetChannel, preference)
  }),
  hardwareAcceleration: Object.freeze({
    get: () => ipcRenderer.invoke(hardwareAccelerationGetChannel),
    set: (enabled: boolean) =>
      ipcRenderer.invoke(hardwareAccelerationSetChannel, enabled)
  }),
  launchAtStartup: Object.freeze({
    get: () => ipcRenderer.invoke(launchAtStartupGetChannel),
    set: (enabled: boolean) =>
      ipcRenderer.invoke(launchAtStartupSetChannel, enabled)
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
  status: Object.freeze({
    subscribe: (listener: () => void) => {
      if (typeof listener !== "function") {
        throw new TypeError("Desktop status listener is required.");
      }
      let active = true;
      const wrapped = () => {
        if (active) listener();
      };
      ipcRenderer.on(desktopStatusChangedChannel, wrapped);
      return () => {
        active = false;
        ipcRenderer.removeListener(desktopStatusChangedChannel, wrapped);
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

import type { BrowserWindowConstructorOptions } from "electron";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  collaborationSnapshotSchema,
  type CollaborationSnapshot
} from "@koed/shared";
import type { DesktopCommandContext } from "../koed-server/manager.js";
import { desktopRendererOrigin } from "../ipc/protocol.js";

export interface StudioCollaborationSnapshot {
  connection: CollaborationSnapshot["connection"];
  teams: Array<{
    id: string;
    name: string;
    role: CollaborationSnapshot["navigation"]["teams"][number]["role"];
    unreadCount: number;
    people: Array<{ id: string; displayName: string }>;
    workspaces: Array<{ id: string; name: string }>;
  }>;
  error?: string;
}

export interface StudioLocalAccess {
  apiOrigin: string;
  apiToken: string;
}

export interface StudioWindowLike {
  webContents: {
    setWindowOpenHandler(
      handler: (details: { url: string }) => { action: "allow" | "deny" }
    ): void;
    on(
      event: "will-navigate",
      listener: (event: { preventDefault(): void }, url: string) => void
    ): void;
  };
  once(event: "closed", listener: () => void): this;
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
}

export interface StudioGateway {
  url: string;
  close(): Promise<void>;
}

export interface StudioGatewayOptions {
  host: "127.0.0.1";
  port: 0;
  apiBase: string;
  staticDir: string;
  resolveToken: () => Promise<string>;
  resolveAccess?: () => Promise<StudioLocalAccess>;
  listLocalSources: (input: Record<string, unknown>) => Promise<unknown>;
  listProjects: () => Promise<unknown>;
  chooseProjectDirectory: () => Promise<string | null>;
  registerProject: (input: { path: string; name: string }) => Promise<unknown>;
  loadCollaborationSnapshot?: () => Promise<StudioCollaborationSnapshot>;
  connectCollaborationBackend?: (
    remoteUrl: string
  ) => Promise<StudioCollaborationSnapshot>;
  reconnectCollaborationBackend?: () => Promise<StudioCollaborationSnapshot>;
  disconnectCollaborationBackend?: () => Promise<StudioCollaborationSnapshot>;
}

export const resolveStudioPaths = (input: {
  appIsPackaged: boolean;
  repoRoot: string;
  resourcesPath: string;
}): { gatewayPath: string; staticDir: string } => {
  const studioRoot = input.appIsPackaged
    ? resolve(input.resourcesPath, "studio")
    : resolve(input.repoRoot, "apps/studio");
  return {
    gatewayPath: resolve(studioRoot, "server/index.mjs"),
    staticDir: resolve(studioRoot, "out")
  };
};

export const studioWindowOptions: BrowserWindowConstructorOptions = {
  title: "Koed Studio",
  width: 1440,
  height: 960,
  minWidth: 1000,
  minHeight: 700,
  show: false,
  titleBarStyle: "hiddenInset",
  backgroundColor: "#000000",
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true
  }
};

export const createStudioWindowController = (input: {
  allowedRendererOrigins: Set<string>;
  studioRendererOrigins?: Set<string>;
  createWindow: () => StudioWindowLike;
  getAccess: () => Promise<StudioLocalAccess>;
  defaultApiOrigin: string;
  getPaths: () => { gatewayPath: string; staticDir: string };
  startGateway: (options: StudioGatewayOptions) => Promise<StudioGateway>;
  listLocalSources: (input: Record<string, unknown>) => Promise<unknown>;
  listProjects: () => Promise<unknown>;
  chooseProjectDirectory: () => Promise<string | null>;
  registerProject: (input: { path: string; name: string }) => Promise<unknown>;
  collaboration: (
    args: Record<string, unknown>,
    context: DesktopCommandContext
  ) => unknown;
  openExternal: (url: string) => Promise<unknown>;
}): { open: () => Promise<void>; close: () => Promise<void> } => {
  let window: StudioWindowLike | null = null;
  let gateway: StudioGateway | null = null;
  let opening: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let studioOrigin: string | null = null;
  let collaborationLifecycle: AbortController | null = null;
  let collaborationOwnerId: string | null = null;

  const runCollaborationCommand = async (
    commandName:
      | "collaboration.connect_backend"
      | "collaboration.reconnect_backend"
      | "collaboration.disconnect_backend",
    commandInput: Record<string, unknown>
  ): Promise<StudioCollaborationSnapshot> => {
    const lifecycle = collaborationLifecycle;
    const ownerId = collaborationOwnerId;
    if (!lifecycle || lifecycle.signal.aborted || !ownerId) {
      throw new Error("Studio collaboration is unavailable.");
    }
    const command = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: commandName,
      input: commandInput
    });
    const context: DesktopCommandContext = {
      ownerId,
      signal: lifecycle.signal,
      emitCollaborationEvent: () => undefined
    };
    const result = collaborationCommandResultSchema.parse(
      await input.collaboration(command, context)
    );
    if (
      result.requestId !== command.requestId ||
      result.command !== command.command
    ) {
      throw new Error(
        "Studio collaboration response did not match its request."
      );
    }
    if (!result.ok) {
      const fallback: StudioCollaborationSnapshot = {
        connection: {
          state:
            result.error.code === "access_revoked"
              ? "access_revoked"
              : "unavailable",
          backendId: null,
          connectedAt: null,
          retryAt: null,
          reconnectAttempt: 0,
          protocolVersion: COLLABORATION_CONTRACT_VERSION
        },
        teams: []
      };
      const current = await loadCollaborationSnapshot().catch(() => fallback);
      return {
        ...current,
        error: result.error.userMessage
      };
    }
    if (
      result.command !== "collaboration.connect_backend" &&
      result.command !== "collaboration.reconnect_backend" &&
      result.command !== "collaboration.disconnect_backend"
    ) {
      throw new Error("Studio collaboration response was invalid.");
    }
    const snapshot = collaborationSnapshotSchema.parse(result.data.snapshot);
    return {
      connection: snapshot.connection,
      teams:
        snapshot.connection.state === "live"
          ? snapshot.navigation.teams.map((team) => ({
              id: team.id,
              name: team.name,
              role: team.role,
              unreadCount: team.unreadCount,
              people: team.people.map(({ id, displayName }) => ({
                id,
                displayName
              })),
              workspaces: team.workspaces.map(({ id, name }) => ({
                id,
                name
              }))
            }))
          : []
    };
  };

  const loadCollaborationSnapshot =
    async (): Promise<StudioCollaborationSnapshot> => {
      const unavailable = (): StudioCollaborationSnapshot => ({
        connection: {
          state: "unavailable",
          backendId: null,
          connectedAt: null,
          retryAt: null,
          reconnectAttempt: 0,
          protocolVersion: COLLABORATION_CONTRACT_VERSION
        },
        teams: []
      });
      const lifecycle = collaborationLifecycle;
      const ownerId = collaborationOwnerId;
      if (!lifecycle || lifecycle.signal.aborted || !ownerId) {
        return unavailable();
      }
      const command = collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.load",
        input: { forceRemoteNavigation: true }
      });
      const context: DesktopCommandContext = {
        ownerId,
        signal: lifecycle.signal,
        emitCollaborationEvent: () => undefined
      };
      let result: ReturnType<typeof collaborationCommandResultSchema.parse>;
      try {
        result = collaborationCommandResultSchema.parse(
          await input.collaboration(command, context)
        );
      } catch {
        return unavailable();
      }
      if (
        result.requestId !== command.requestId ||
        result.command !== command.command
      ) {
        throw new Error(
          "Studio collaboration response did not match its request."
        );
      }
      if (!result.ok) {
        if (result.error.code === "access_revoked") {
          return {
            connection: {
              state: "access_revoked",
              backendId: null,
              connectedAt: null,
              retryAt: null,
              reconnectAttempt: 0,
              protocolVersion: COLLABORATION_CONTRACT_VERSION
            },
            teams: []
          };
        }
        return unavailable();
      }
      if (result.command !== "collaboration.load") {
        throw new Error("Studio collaboration response was invalid.");
      }
      const snapshot = collaborationSnapshotSchema.parse(result.data.snapshot);
      return {
        connection: snapshot.connection,
        teams:
          snapshot.connection.state === "live"
            ? snapshot.navigation.teams.map((team) => ({
                id: team.id,
                name: team.name,
                role: team.role,
                unreadCount: team.unreadCount,
                people: team.people.map(({ id, displayName }) => ({
                  id,
                  displayName
                })),
                workspaces: team.workspaces.map(({ id, name }) => ({
                  id,
                  name
                }))
              }))
            : []
      };
    };

  const disposeGateway = async () => {
    collaborationLifecycle?.abort();
    collaborationLifecycle = null;
    collaborationOwnerId = null;
    const currentGateway = gateway;
    gateway = null;
    if (studioOrigin) input.allowedRendererOrigins.delete(studioOrigin);
    if (studioOrigin) input.studioRendererOrigins?.delete(studioOrigin);
    studioOrigin = null;
    await currentGateway?.close();
  };

  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      await opening?.catch(() => undefined);
      const currentWindow = window;
      window = null;
      if (currentWindow && !currentWindow.isDestroyed()) currentWindow.close();
      await disposeGateway();
    })().finally(() => {
      closing = null;
    });
    return closing;
  };

  const open = async () => {
    if (closing) await closing;
    if (opening) return opening;
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      return;
    }
    if (window || gateway) await close();
    opening = (async () => {
      collaborationLifecycle = new AbortController();
      collaborationOwnerId = `studio-window:${randomUUID()}`;
      let access: StudioLocalAccess | null = null;
      try {
        access = await input.getAccess();
      } catch {
        // Studio remains useful while Koed services start or recover.
      }
      const paths = input.getPaths();
      const started = await input.startGateway({
        host: "127.0.0.1",
        port: 0,
        apiBase: access?.apiOrigin ?? input.defaultApiOrigin,
        staticDir: paths.staticDir,
        resolveToken: async () => (await input.getAccess()).apiToken,
        resolveAccess: input.getAccess,
        listLocalSources: input.listLocalSources,
        listProjects: input.listProjects,
        chooseProjectDirectory: async () => {
          if (!window || window.isDestroyed()) return null;
          return input.chooseProjectDirectory();
        },
        registerProject: input.registerProject,
        loadCollaborationSnapshot,
        connectCollaborationBackend: (remoteUrl) =>
          runCollaborationCommand("collaboration.connect_backend", {
            remoteUrl
          }),
        reconnectCollaborationBackend: () =>
          runCollaborationCommand("collaboration.reconnect_backend", {}),
        disconnectCollaborationBackend: () =>
          runCollaborationCommand("collaboration.disconnect_backend", {})
      });
      gateway = started;
      try {
        const origin = desktopRendererOrigin(started.url);
        studioOrigin = origin;
        input.allowedRendererOrigins.add(origin);
        input.studioRendererOrigins?.add(origin);
        const createdWindow = input.createWindow();
        window = createdWindow;
        createdWindow.webContents.setWindowOpenHandler(({ url }) => {
          if (url.startsWith("https://") || url.startsWith("http://")) {
            void input.openExternal(url);
          }
          return { action: "deny" };
        });
        createdWindow.webContents.on("will-navigate", (event, url) => {
          try {
            if (desktopRendererOrigin(url) !== origin) event.preventDefault();
          } catch {
            event.preventDefault();
          }
        });
        createdWindow.once("closed", () => {
          if (window === createdWindow) window = null;
          void disposeGateway();
        });
        await createdWindow.loadURL(started.url);
        if (!createdWindow.isDestroyed()) createdWindow.show();
      } catch (error) {
        const failedWindow = window;
        window = null;
        if (failedWindow && !failedWindow.isDestroyed()) failedWindow.close();
        await disposeGateway();
        throw error;
      }
    })()
      .catch((error) => {
        collaborationLifecycle?.abort();
        collaborationLifecycle = null;
        collaborationOwnerId = null;
        throw error;
      })
      .finally(() => {
        opening = null;
      });
    return opening;
  };

  return { open, close };
};

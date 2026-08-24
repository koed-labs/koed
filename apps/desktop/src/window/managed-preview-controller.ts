import {
  BrowserWindow,
  type Rectangle,
  type WebContents,
  WebContentsView
} from "electron";

import {
  managedDevelopmentPreviewAccessSchema,
  type ManagedDevelopmentPreviewAccess
} from "@koed/shared";

import type { ManagedWorkspaceEvent } from "../ipc/managed-workspace-protocol.js";

type PreviewSurface = {
  sender: WebContents;
  view: WebContentsView;
  previewId: string;
  lifecycleGeneration: number;
  targetOrigin: string;
  emit(event: ManagedWorkspaceEvent): void;
};

export interface ManagedPreviewController {
  attach(
    sender: WebContents,
    input: {
      surfaceId: string;
      access: ManagedDevelopmentPreviewAccess;
      bounds: Rectangle;
    },
    emit: (event: ManagedWorkspaceEvent) => void
  ): Promise<void>;
  setBounds(sender: WebContents, surfaceId: string, bounds: Rectangle): void;
  reload(sender: WebContents, surfaceId: string): void;
  detach(sender: WebContents, surfaceId: string): Promise<void>;
  detachSender(sender: WebContents): Promise<void>;
  close(): Promise<void>;
}

const previewSurfaceKey = (sender: WebContents, surfaceId: string) =>
  `${sender.id}:${surfaceId}`;

const previewTarget = (rawUrl: string): URL => {
  const url = new URL(rawUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("Invalid managed preview target.");
  }
  return url;
};

export const isAllowedManagedPreviewRequest = (
  targetOrigin: string,
  rawUrl: string,
  resourceType: string
): boolean => {
  try {
    const target = new URL(targetOrigin);
    const candidate = new URL(rawUrl);
    if (candidate.protocol === "data:" || candidate.protocol === "blob:") {
      return resourceType !== "mainFrame";
    }
    const expectedProtocols =
      target.protocol === "https:" ? ["https:", "wss:"] : ["http:", "ws:"];
    return (
      expectedProtocols.includes(candidate.protocol) &&
      candidate.hostname === target.hostname &&
      candidate.port === target.port
    );
  } catch {
    return false;
  }
};

const isAllowedTopLevelNavigation = (targetOrigin: string, rawUrl: string) => {
  try {
    return new URL(rawUrl).origin === targetOrigin;
  } catch {
    return false;
  }
};

export const createManagedPreviewController = (): ManagedPreviewController => {
  const surfaces = new Map<string, PreviewSurface>();
  const observedSenders = new WeakSet<WebContents>();

  const detachByKey = async (key: string) => {
    const surface = surfaces.get(key);
    if (!surface) return;
    surfaces.delete(key);
    const parent = BrowserWindow.fromWebContents(surface.sender);
    parent?.contentView.removeChildView(surface.view);
    surface.view.setVisible(false);
    const previewSession = surface.view.webContents.session;
    if (!surface.view.webContents.isDestroyed()) {
      surface.view.webContents.closeDevTools();
      surface.view.webContents.close();
    }
    await Promise.allSettled([
      previewSession.clearStorageData(),
      previewSession.clearCache()
    ]);
    surface.emit({
      kind: "preview",
      surfaceId: key.slice(key.indexOf(":") + 1),
      previewId: surface.previewId,
      lifecycleGeneration: surface.lifecycleGeneration,
      state: "closed"
    });
  };

  return {
    async attach(sender, rawInput, emit) {
      const input = {
        ...rawInput,
        access: managedDevelopmentPreviewAccessSchema.parse(rawInput.access)
      };
      const parent = BrowserWindow.fromWebContents(sender);
      if (!parent || parent.isDestroyed()) {
        throw new Error("Managed preview window is unavailable.");
      }
      const target = previewTarget(input.access.navigationUrl);
      if (!observedSenders.has(sender)) {
        observedSenders.add(sender);
        sender.once("destroyed", () => {
          void Promise.all(
            [...surfaces.entries()]
              .filter(([, surface]) => surface.sender === sender)
              .map(([surfaceKey]) => detachByKey(surfaceKey))
          );
        });
      }
      const key = previewSurfaceKey(sender, input.surfaceId);
      await detachByKey(key);
      for (const [existingKey, existing] of surfaces) {
        if (existing.sender === sender) await detachByKey(existingKey);
      }

      const view = new WebContentsView({
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          webSecurity: true,
          devTools: false,
          spellcheck: false,
          safeDialogs: true,
          partition: `koed-preview-${input.surfaceId}`
        }
      });
      const targetOrigin = target.origin;
      const surface: PreviewSurface = {
        sender,
        view,
        previewId: input.access.preview.id,
        lifecycleGeneration: input.access.preview.lifecycleGeneration,
        targetOrigin,
        emit
      };
      surfaces.set(key, surface);
      const previewSession = view.webContents.session;
      previewSession.setPermissionCheckHandler(() => false);
      previewSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false)
      );
      previewSession.webRequest.onBeforeRequest((details, callback) => {
        callback({
          cancel: !isAllowedManagedPreviewRequest(
            targetOrigin,
            details.url,
            details.resourceType
          )
        });
      });
      previewSession.on("will-download", (event) => event.preventDefault());
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      view.webContents.on("will-navigate", (event, url) => {
        if (!isAllowedTopLevelNavigation(targetOrigin, url))
          event.preventDefault();
      });
      view.webContents.on("will-redirect", (event, url) => {
        if (!isAllowedTopLevelNavigation(targetOrigin, url))
          event.preventDefault();
      });
      view.webContents.on("devtools-opened", () =>
        view.webContents.closeDevTools()
      );
      view.webContents.on("did-start-loading", () =>
        emit({
          kind: "preview",
          surfaceId: input.surfaceId,
          previewId: surface.previewId,
          lifecycleGeneration: surface.lifecycleGeneration,
          state: "loading"
        })
      );
      view.webContents.on("did-finish-load", () =>
        emit({
          kind: "preview",
          surfaceId: input.surfaceId,
          previewId: surface.previewId,
          lifecycleGeneration: surface.lifecycleGeneration,
          state: "ready"
        })
      );
      view.webContents.on(
        "did-fail-load",
        (_event, _errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
          if (isMainFrame) {
            emit({
              kind: "preview",
              surfaceId: input.surfaceId,
              previewId: surface.previewId,
              lifecycleGeneration: surface.lifecycleGeneration,
              state: "failed",
              code: "navigation_failed"
            });
          }
        }
      );
      view.webContents.on("render-process-gone", () =>
        emit({
          kind: "preview",
          surfaceId: input.surfaceId,
          previewId: surface.previewId,
          lifecycleGeneration: surface.lifecycleGeneration,
          state: "failed",
          code: "renderer_gone"
        })
      );
      view.setBounds(input.bounds);
      view.setVisible(true);
      parent.contentView.addChildView(view);
      emit({
        kind: "preview",
        surfaceId: input.surfaceId,
        previewId: surface.previewId,
        lifecycleGeneration: surface.lifecycleGeneration,
        state: "loading"
      });
      await view.webContents.loadURL(target.toString());
    },

    setBounds(sender, surfaceId, bounds) {
      const surface = surfaces.get(previewSurfaceKey(sender, surfaceId));
      if (!surface) throw new Error("Managed preview surface is unavailable.");
      surface.view.setBounds(bounds);
    },

    reload(sender, surfaceId) {
      const surface = surfaces.get(previewSurfaceKey(sender, surfaceId));
      if (!surface || surface.view.webContents.isDestroyed()) {
        throw new Error("Managed preview surface is unavailable.");
      }
      surface.view.webContents.reloadIgnoringCache();
    },

    async detach(sender, surfaceId) {
      await detachByKey(previewSurfaceKey(sender, surfaceId));
    },

    async detachSender(sender) {
      await Promise.all(
        [...surfaces.entries()]
          .filter(([, surface]) => surface.sender === sender)
          .map(([key]) => detachByKey(key))
      );
    },

    async close() {
      await Promise.all([...surfaces.keys()].map(detachByKey));
    }
  };
};

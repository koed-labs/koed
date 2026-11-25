import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
  floatingKinPreviewRequestSchema,
  floatingKinSummaryRequestSchema,
  floatingKinSummaryTargetSchema,
  type FloatingKinPreview,
  type FloatingKinPreviewRequest,
  type FloatingKinSummary,
  type FloatingKinSummaryRequest
} from "@koed-labs/shared";
import {
  floatingKinChannels as channels,
  type FloatingKinActivityState,
  type FloatingKinDrag,
  type FloatingKinSize,
  type KinLatestSummary,
  type KinPresentation,
  type KinReopenedSummary,
  type KinSummaryTarget
} from "./floating-kin-protocol.js";

type FloatingKinRuntime = {
  activity: (signal: AbortSignal) => Promise<FloatingKinActivityState>;
  preview: (
    input: FloatingKinPreviewRequest,
    signal: AbortSignal
  ) => Promise<FloatingKinPreview>;
  summarize: (
    input: FloatingKinSummaryRequest,
    signal: AbortSignal
  ) => Promise<FloatingKinSummary>;
  latest: (
    target: KinSummaryTarget,
    signal: AbortSignal
  ) => Promise<KinLatestSummary>;
  reopen: (
    target: KinSummaryTarget,
    signal: AbortSignal
  ) => Promise<KinReopenedSummary>;
};

// A captured session id; anything longer is not one.
const maxSessionIdLength = 512;

const sizeFrom = (value: unknown): FloatingKinSize | null => {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => key !== "width" && key !== "height") ||
    !("width" in value) ||
    typeof value.width !== "number" ||
    !("height" in value) ||
    typeof value.height !== "number" ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    value.width <= 0 ||
    value.height <= 0
  )
    return null;
  return { width: value.width, height: value.height };
};

const dragFrom = (value: unknown): FloatingKinDrag | null => {
  if (!value || typeof value !== "object" || !("phase" in value)) return null;
  if (value.phase === "end" && Object.keys(value).length === 1)
    return { phase: "end" };
  if (
    (value.phase !== "start" && value.phase !== "move") ||
    Object.keys(value).length !== 3 ||
    !("x" in value) ||
    !("y" in value) ||
    typeof value.x !== "number" ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    Math.abs(value.x) > 32768 ||
    Math.abs(value.y) > 32768
  )
    return null;
  return { phase: value.phase, x: value.x, y: value.y };
};

const summaryRequests = (runtime: FloatingKinRuntime) => {
  let pending: AbortController | null = null;
  const run = <T>(read: (signal: AbortSignal) => Promise<T>, fallback: T) => {
    const request = new AbortController();
    pending = request;
    return read(request.signal)
      .then((result) => (request.signal.aborted ? fallback : result))
      .finally(() => {
        if (pending === request) pending = null;
      });
  };
  return {
    cancel: () => pending?.abort(),
    run(value: unknown): FloatingKinSummary | Promise<FloatingKinSummary> {
      const input = floatingKinSummaryRequestSchema.safeParse(value);
      if (!input.success) return { status: "unavailable" };
      if (pending) return { status: "busy" };
      return run<FloatingKinSummary>(
        (signal) => runtime.summarize(input.data, signal),
        { status: "cancelled" }
      );
    },
    reopen(value: unknown) {
      const input = floatingKinSummaryTargetSchema.safeParse(value);
      if (!input.success || pending) return null;
      return run<KinReopenedSummary>(
        (signal) => runtime.reopen(input.data, signal),
        null
      );
    }
  };
};

const activityRequests = (runtime: FloatingKinRuntime) => {
  let pending: {
    controller: AbortController;
    result: Promise<FloatingKinActivityState>;
  } | null = null;
  return {
    cancel() {
      pending?.controller.abort();
      pending = null;
    },
    run() {
      if (pending) return pending.result;
      const controller = new AbortController();
      const result = runtime
        .activity(controller.signal)
        .then<FloatingKinActivityState>((value) =>
          controller.signal.aborted ? { state: "unavailable" } : value
        )
        .finally(() => {
          if (pending?.controller === controller) pending = null;
        });
      pending = { controller, result };
      return result;
    }
  };
};

function previewRequests(runtime: FloatingKinRuntime) {
  let pending: AbortController | undefined;
  return {
    cancel: () => pending?.abort(),
    async run(value: unknown) {
      const input = floatingKinPreviewRequestSchema.safeParse(value);
      if (!input.success) return null;
      pending?.abort();
      const request = new AbortController();
      pending = request;
      try {
        const result = await runtime.preview(input.data, request.signal);
        return request.signal.aborted ? null : result;
      } finally {
        if (pending === request) pending = undefined;
      }
    }
  };
}

export const registerFloatingKinIpc = ({
  ipcMain,
  getWebContents,
  url,
  runtime,
  mainWindowFocused,
  overlayVisible,
  presentation,
  completeExit,
  openDesktop,
  openAiModels,
  openConversation,
  interactive,
  resize,
  drag,
  desktop
}: {
  ipcMain: Pick<IpcMain, "handle" | "on">;
  getWebContents: () => WebContents | null;
  url: string;
  runtime: FloatingKinRuntime;
  mainWindowFocused: () => boolean;
  overlayVisible: () => boolean;
  presentation: () => KinPresentation;
  completeExit: (revision: number) => void;
  openDesktop: () => void;
  openAiModels: () => void;
  openConversation: (sessionId: string) => void;
  interactive: (value: boolean) => void;
  resize: (size: FloatingKinSize) => void;
  drag: (input: FloatingKinDrag) => void;
  desktop?: {
    getWebContents: () => WebContents | null;
    url: string;
    isShellVisible: () => boolean;
    setShellVisible: (visible: boolean) => void;
    confirmPresentation: (revision: number) => void;
  };
}): ((surface?: "overlay" | "desktop" | "all") => void) => {
  const trusted = (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) =>
    event.sender === getWebContents() &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame?.url === url;
  const assertTrusted = (event: IpcMainInvokeEvent) => {
    if (!trusted(event)) throw new Error("Untrusted Floating Kin IPC sender.");
  };

  const desktopTrusted = (
    event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">
  ) =>
    !!desktop &&
    event.sender === desktop.getWebContents() &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame?.url === desktop.url;
  const createRequests = () => ({
    activity: activityRequests(runtime),
    summaries: summaryRequests(runtime),
    preview: previewRequests(runtime)
  });
  const overlayRequests = createRequests();
  const desktopRequests = createRequests();
  const requestsFor = (event: IpcMainInvokeEvent, revision: unknown) => {
    const inApp = desktopTrusted(event);
    if (!inApp) assertTrusted(event);
    const state = presentation();
    if (
      state.revision !== revision ||
      inApp === (state.placement === "desktop")
    )
      return null;
    return inApp ? desktopRequests : overlayRequests;
  };
  ipcMain.handle(channels.mainWindowFocused, (event) => {
    assertTrusted(event);
    return mainWindowFocused();
  });
  // Desktop keeps its rail chips while the Kin floats, so it may read
  // activity at either placement. The overlay reads only while it owns the Kin.
  const activityRequestsFor = (event: IpcMainInvokeEvent, revision: unknown) =>
    desktopTrusted(event)
      ? presentation().revision === revision
        ? desktopRequests
        : null
      : requestsFor(event, revision);
  ipcMain.handle(
    channels.activity,
    (event, revision: unknown) =>
      activityRequestsFor(event, revision)?.activity.run() ?? {
        state: "unavailable"
      }
  );
  ipcMain.handle(
    channels.preview,
    (event, value: unknown, revision: unknown) => {
      const requests = requestsFor(event, revision);
      if (!requests) return null;
      const visible = () => {
        const state = presentation();
        if (state.revision !== revision) return false;
        return requests === desktopRequests
          ? state.placement === "sidebar" &&
              !state.sidebarPending &&
              desktop?.isShellVisible()
          : state.placement === "desktop" && overlayVisible();
      };
      if (!visible()) return null;
      return requests.preview
        .run(value)
        .then((result) => (visible() ? result : null));
    }
  );
  ipcMain.handle(
    channels.summarize,
    (event, value: unknown, revision: unknown) =>
      requestsFor(event, revision)?.summaries.run(value) ?? {
        status: "unavailable"
      }
  );
  ipcMain.handle(
    channels.latest,
    (event, value: unknown, revision: unknown) => {
      const requests = requestsFor(event, revision);
      const target = floatingKinSummaryTargetSchema.safeParse(value);
      return requests && target.success
        ? runtime.latest(target.data, AbortSignal.timeout(6000))
        : { action: null };
    }
  );
  ipcMain.handle(
    channels.reopen,
    (event, value: unknown, revision: unknown) =>
      requestsFor(event, revision)?.summaries.reopen(value) ?? null
  );
  ipcMain.handle(channels.cancel, (event, revision: unknown) =>
    requestsFor(event, revision)?.summaries.cancel()
  );
  ipcMain.handle(channels.presentation, (event) => {
    if (!desktopTrusted(event)) assertTrusted(event);
    return presentation();
  });
  ipcMain.on(channels.setShellVisible, (event, value: unknown) => {
    if (desktopTrusted(event) && typeof value === "boolean") {
      if (!value) desktopRequests.preview.cancel();
      desktop?.setShellVisible(value);
    }
  });
  ipcMain.on(channels.confirmPresentation, (event, value: unknown) => {
    if (desktopTrusted(event) && value === presentation().revision)
      desktop?.confirmPresentation(value);
  });
  ipcMain.on(channels.completeExit, (event, value: unknown) => {
    if (!trusted(event)) return;
    const { placement, sidebarPending, revision } = presentation();
    if (placement === "sidebar" && sidebarPending && value === revision)
      completeExit(revision);
  });
  ipcMain.on(channels.openDesktop, (event, value: unknown) => {
    if (!trusted(event)) return;
    const { placement, revision } = presentation();
    if (placement === "desktop" && value === revision) openDesktop();
  });
  ipcMain.on(channels.openAiModels, (event, value: unknown) => {
    if (!trusted(event)) return;
    const { placement, revision } = presentation();
    if (placement === "desktop" && value === revision) openAiModels();
  });
  ipcMain.on(
    channels.openConversation,
    (event, value: unknown, sessionId: unknown) => {
      if (!trusted(event)) return;
      const { placement, revision } = presentation();
      if (
        placement === "desktop" &&
        value === revision &&
        typeof sessionId === "string" &&
        sessionId.length > 0 &&
        sessionId.length <= maxSessionIdLength
      )
        openConversation(sessionId);
    }
  );
  ipcMain.on(channels.setInteractive, (event, value: unknown) => {
    if (trusted(event) && typeof value === "boolean") interactive(value);
  });
  ipcMain.on(channels.setSize, (event, value: unknown) => {
    if (!trusted(event)) return;
    const size = sizeFrom(value);
    if (size) resize(size);
  });
  ipcMain.on(channels.drag, (event, value: unknown) => {
    if (!trusted(event)) return;
    const input = dragFrom(value);
    if (input) drag(input);
  });
  return (surface = "overlay") => {
    if (surface !== "desktop") {
      overlayRequests.activity.cancel();
      overlayRequests.summaries.cancel();
      overlayRequests.preview.cancel();
    }
    if (surface !== "overlay") {
      desktopRequests.activity.cancel();
      desktopRequests.summaries.cancel();
      desktopRequests.preview.cancel();
    }
  };
};

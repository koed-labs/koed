import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
  floatingKinSummaryRequestSchema,
  type FloatingKinSummary,
  type FloatingKinSummaryRequest
} from "@koed-labs/shared";
import {
  floatingKinChannels as channels,
  type FloatingKinActivityState,
  type FloatingKinDrag,
  type FloatingKinSize
} from "./floating-kin-protocol.js";

type FloatingKinRuntime = {
  activity: (signal: AbortSignal) => Promise<FloatingKinActivityState>;
  summarize: (
    input: FloatingKinSummaryRequest,
    signal: AbortSignal
  ) => Promise<FloatingKinSummary>;
};

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
  return {
    cancel: () => pending?.abort(),
    run(value: unknown): FloatingKinSummary | Promise<FloatingKinSummary> {
      const input = floatingKinSummaryRequestSchema.safeParse(value);
      if (!input.success) return { status: "unavailable" };
      if (pending) return { status: "busy" };
      const request = new AbortController();
      pending = request;
      return runtime
        .summarize(input.data, request.signal)
        .then<FloatingKinSummary>((result) =>
          request.signal.aborted ? { status: "cancelled" } : result
        )
        .finally(() => {
          pending = null;
        });
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

export const registerFloatingKinIpc = ({
  ipcMain,
  getWebContents,
  url,
  runtime,
  interactive,
  resize,
  drag
}: {
  ipcMain: Pick<IpcMain, "handle" | "on">;
  getWebContents: () => WebContents | null;
  url: string;
  runtime: FloatingKinRuntime;
  interactive: (value: boolean) => void;
  resize: (size: FloatingKinSize) => void;
  drag: (input: FloatingKinDrag) => void;
}): (() => void) => {
  const trusted = (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) =>
    event.sender === getWebContents() &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame?.url === url;
  const assertTrusted = (event: IpcMainInvokeEvent) => {
    if (!trusted(event)) throw new Error("Untrusted Floating Kin IPC sender.");
  };

  const summaries = summaryRequests(runtime);
  const activity = activityRequests(runtime);
  ipcMain.handle(channels.activity, (event) => {
    assertTrusted(event);
    return activity.run();
  });
  ipcMain.handle(channels.summarize, (event, value: unknown) => {
    assertTrusted(event);
    return summaries.run(value);
  });
  ipcMain.handle(channels.cancel, (event) => {
    assertTrusted(event);
    summaries.cancel();
  });
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
  return () => {
    activity.cancel();
    summaries.cancel();
  };
};

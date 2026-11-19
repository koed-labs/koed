import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { registerFloatingKinIpc } from "./floating-kin.js";
import {
  floatingKinChannels as channels,
  type FloatingKinActivityState
} from "./floating-kin-protocol.js";

function setup() {
  const url = "koed://app/#floating-kin";
  const frame = { url };
  const contents = { mainFrame: frame } as WebContents;
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent;
  const invokes = new Map<
    string,
    (event: IpcMainInvokeEvent, value?: unknown) => unknown
  >();
  const sends = new Map<
    string,
    (event: IpcMainEvent, value: unknown) => void
  >();
  const activity = vi.fn(async (): Promise<FloatingKinActivityState> => ({
    state: "stopped"
  }));
  const summarize = vi.fn(
    (_: unknown, signal: AbortSignal) =>
      new Promise<{ status: "cancelled" }>((resolve) => {
        signal.addEventListener(
          "abort",
          () => resolve({ status: "cancelled" }),
          { once: true }
        );
      })
  );
  const interactive = vi.fn();
  const resize = vi.fn();
  const dismiss = registerFloatingKinIpc({
    ipcMain: {
      handle: (channel, handler) => {
        invokes.set(channel, handler);
      },
      on: (channel, handler) => {
        sends.set(channel, handler);
        return null as never;
      }
    },
    getWebContents: () => contents,
    url,
    runtime: { activity, summarize },
    interactive,
    resize
  });
  return {
    event,
    frame,
    invokes,
    sends,
    activity,
    summarize,
    interactive,
    resize,
    dismiss
  };
}

it("rejects all overlay channels from another window, a subframe, or a different document", () => {
  const {
    event,
    frame,
    invokes,
    sends,
    activity,
    summarize,
    interactive,
    resize
  } = setup();
  const foreign = {
    ...event,
    sender: { mainFrame: event.senderFrame } as WebContents
  };
  const subframe = {
    ...event,
    senderFrame: { url: event.senderFrame!.url } as IpcMainEvent["senderFrame"]
  };
  for (const untrusted of [foreign, subframe, event]) {
    if (untrusted === event) frame.url = "koed://app/#settings";
    for (const handler of invokes.values())
      expect(() => handler(untrusted)).toThrow("Untrusted");
    sends.get(channels.setInteractive)!(untrusted as IpcMainEvent, true);
    sends.get(channels.setSize)!(untrusted as IpcMainEvent, {
      width: 440,
      height: 200
    });
  }
  expect(activity).not.toHaveBeenCalled();
  expect(summarize).not.toHaveBeenCalled();
  expect(interactive).not.toHaveBeenCalled();
  expect(resize).not.toHaveBeenCalled();
});

it("allows only fixed summary inputs and cancels in-flight work on request or dismissal", async () => {
  const { event, invokes, summarize, dismiss } = setup();
  const input = {
    sessionId: "803c2792-c18b-4484-a699-b33c7d8a7576",
    action: "conversation"
  };
  const run = invokes.get(channels.summarize)!;
  expect(run(event, { ...input, prompt: "free text" })).toEqual({
    status: "unavailable"
  });
  expect(summarize).not.toHaveBeenCalled();
  const pending = run(event, input);
  expect(run(event, input)).toEqual({ status: "busy" });
  await invokes.get(channels.cancel)!(event);
  expect(await pending).toEqual({ status: "cancelled" });
  const next = run(event, input);
  dismiss();
  expect(await next).toEqual({ status: "cancelled" });
});

it("invalidates a coalesced activity read on dismissal or authority change", async () => {
  const { event, invokes, activity, dismiss } = setup();
  let finish!: (value: FloatingKinActivityState) => void;
  activity.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const read = invokes.get(channels.activity)!;
  const first = read(event);
  expect(read(event)).toBe(first);
  dismiss();
  const latest = read(event);
  expect(latest).not.toBe(first);
  expect(await latest).toEqual({ state: "stopped" });
  finish({ state: "running", conversations: [], overflowCount: 0 });
  expect(await first).toEqual({ state: "unavailable" });
});

it("ignores malformed geometry and non-boolean interactivity", () => {
  const { event, sends, resize, interactive } = setup();
  const send = event as IpcMainEvent;
  sends.get(channels.setSize)!(send, { width: Infinity, height: 200 });
  sends.get(channels.setSize)!(send, { width: 440, height: 200, x: 40 });
  sends.get(channels.setSize)!(send, { width: 440, height: 200 });
  expect(resize.mock.calls).toEqual([[{ width: 440, height: 200 }]]);
  sends.get(channels.setInteractive)!(send, "true");
  sends.get(channels.setInteractive)!(send, true);
  expect(interactive.mock.calls).toEqual([[true]]);
});

import { describe, expect, it, vi } from "vitest";
import type { ControlClient } from "./client.js";
import { ControlOwnerGoneError } from "./connect-or-launch.js";
import { serveDesktopStatus } from "./desktop-status.js";

const snapshot = {
  instanceId: "host",
  revision: 1,
  state: "ready",
  stopIntent: false
} as const;

function makeClient() {
  let notifyClose: ((error: Error) => void) | undefined;
  const client = {
    request: vi.fn<ControlClient["request"]>().mockResolvedValue({
      requestId: "host-request",
      ok: true,
      snapshot
    }),
    close: vi.fn(),
    onClose(listener: (error: Error) => void) {
      notifyClose = listener;
      return () => {
        notifyClose = undefined;
      };
    }
  };
  return {
    client,
    drop: () => notifyClose?.(new Error("disconnected"))
  };
}

function makeChannel() {
  const listeners = {
    message: undefined as ((value: unknown) => void) | undefined,
    disconnect: undefined as (() => void) | undefined,
    reply: undefined as ((value: unknown) => void) | undefined
  };
  const replies: unknown[] = [];
  const channel = {
    connected: true,
    send(reply: unknown) {
      replies.push(reply);
      listeners.reply?.(reply);
    },
    onMessage(listener: (value: unknown) => void) {
      listeners.message = listener;
      return () => {
        listeners.message = undefined;
      };
    },
    onDisconnect(listener: () => void) {
      listeners.disconnect = listener;
      return () => {
        listeners.disconnect = undefined;
      };
    }
  };
  return {
    channel,
    replies,
    listeners,
    send: (value: unknown) => listeners.message?.(value),
    probe(requestId: number) {
      return new Promise((resolve) => {
        listeners.reply = resolve;
        listeners.message?.({ type: "status", requestId });
      });
    },
    disconnect() {
      channel.connected = false;
      listeners.disconnect?.();
    }
  };
}

describe("Desktop status helper", () => {
  it("only sends a fixed read-only command and reuses the authenticated client", async () => {
    const parent = makeChannel();
    const { client } = makeClient();
    const openExistingClient = vi.fn().mockResolvedValue(client);
    const serving = serveDesktopStatus(openExistingClient, parent.channel);

    parent.send({ type: "stop", requestId: 1 });
    parent.send({ type: "status", requestId: 1, command: { action: "stop" } });
    parent.send({ type: "status", requestId: "1" });
    expect(openExistingClient).not.toHaveBeenCalled();
    expect(parent.replies).toEqual([{ type: "status-ready" }]);
    for (const requestId of [1, 2]) {
      expect(await parent.probe(requestId)).toEqual({
        type: "status-result",
        requestId,
        ok: true,
        snapshot
      });
    }
    expect(openExistingClient).toHaveBeenCalledOnce();
    expect(client.request.mock.calls).toEqual([
      [{ action: "status" }, 0],
      [{ action: "status" }, 0]
    ]);

    parent.disconnect();
    await expect(serving).resolves.toBe(0);
    expect(client.close).toHaveBeenCalledOnce();
    expect(parent.listeners.message).toBeUndefined();
    expect(parent.listeners.disconnect).toBeUndefined();
  });

  it("reports unavailable without a host and reconnects on a later probe", async () => {
    const parent = makeChannel();
    const first = makeClient();
    const second = makeClient();
    const openExistingClient = vi
      .fn()
      .mockRejectedValueOnce(new ControlOwnerGoneError())
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const serving = serveDesktopStatus(openExistingClient, parent.channel);

    expect(await parent.probe(1)).toEqual({
      type: "status-result",
      requestId: 1,
      ok: false
    });
    await expect(parent.probe(2)).resolves.toMatchObject({ ok: true });
    first.drop();
    expect(second.client.request).not.toHaveBeenCalled();
    await expect(parent.probe(3)).resolves.toMatchObject({ ok: true });
    expect(second.client.request).toHaveBeenCalledOnce();

    parent.disconnect();
    await serving;
  });

  it("closes a client that opens after parent disconnect without requesting status", async () => {
    const parent = makeChannel();
    const { client } = makeClient();
    const opening = Promise.resolve(client);
    const serving = serveDesktopStatus(() => opening, parent.channel);

    parent.send({ type: "status", requestId: 1 });
    parent.disconnect();
    await serving;
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.request).not.toHaveBeenCalled();
    expect(parent.replies).toEqual([{ type: "status-ready" }]);
  });
});

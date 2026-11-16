import { describe, expect, it, vi } from "vitest";
import { serveDesktopSession } from "./desktop-session.js";
import type { ControlClient } from "./client.js";

function fixture() {
  let onMessage: (value: unknown) => void = () => {};
  let onDisconnect: () => void = () => {};
  let onClientClose: (error: Error) => void = () => {};
  const snapshot = {
    instanceId: "i",
    revision: 1,
    state: "ready" as const,
    stopIntent: false
  };
  const request = vi.fn(async () => ({
    requestId: "r",
    ok: true as const,
    snapshot
  }));
  const client: ControlClient = {
    request,
    close: vi.fn(),
    onClose: (listener) => {
      onClientClose = listener;
      return () => {};
    }
  };
  const channel = {
    connected: true,
    send: vi.fn(),
    onMessage: (listener: (value: unknown) => void) => {
      onMessage = listener;
      return () => {};
    },
    onDisconnect: (listener: () => void) => {
      onDisconnect = listener;
      return () => {};
    }
  };
  return {
    client,
    channel,
    request,
    message: (value: unknown) => onMessage(value),
    disconnect: () => onDisconnect(),
    closeClient: () => onClientClose(new Error("lost host"))
  };
}

describe("Desktop control session", () => {
  it("attaches after status and detaches intentionally on request", async () => {
    const f = fixture();
    const done = serveDesktopSession(f.client, f.channel);
    await vi.waitFor(() =>
      expect(f.channel.send).toHaveBeenCalledWith({ type: "ready" })
    );
    expect(f.request).toHaveBeenCalledWith(
      { action: "attach", reason: "desktop-session" },
      1
    );
    f.message({ type: "detach" });
    expect(await done).toBe(0);
    expect(f.request).toHaveBeenCalledWith(
      { action: "detach", reason: "desktop-session", intentional: true },
      1
    );
    expect(f.client.close).toHaveBeenCalledOnce();
    expect(f.channel.send).toHaveBeenCalledWith({ type: "detached", ok: true });
  });
  it("exits if its authenticated control connection closes", async () => {
    const f = fixture();
    const done = serveDesktopSession(f.client, f.channel);
    await vi.waitFor(() =>
      expect(f.channel.send).toHaveBeenCalledWith({ type: "ready" })
    );
    f.closeClient();
    expect(await done).toBe(1);
  });
  it("closes without intentional detach on parent disconnect", async () => {
    const f = fixture();
    const done = serveDesktopSession(f.client, f.channel);
    await vi.waitFor(() =>
      expect(f.channel.send).toHaveBeenCalledWith({ type: "ready" })
    );
    f.disconnect();
    expect(await done).toBe(0);
    expect(f.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "detach" }),
      expect.anything()
    );
    expect(f.client.close).toHaveBeenCalledOnce();
  });
});

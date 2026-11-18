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
  const request = vi.fn<ControlClient["request"]>(async () => ({
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
    snapshot,
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
  it("retries a stale attach with the returned revision and original session ID", async () => {
    const f = fixture();
    const desktopSessionId = "cb64b350-203a-4aa2-944e-e84d1d9aef39";
    const attach = {
      action: "attach",
      reason: "desktop-session",
      desktopSessionId
    };
    f.request
      .mockResolvedValueOnce({
        requestId: "status",
        ok: true,
        snapshot: f.snapshot
      })
      .mockResolvedValueOnce({
        requestId: "stale",
        ok: false,
        code: "stale_revision",
        snapshot: { ...f.snapshot, revision: 4 }
      });

    const done = serveDesktopSession(f.client, f.channel, desktopSessionId);
    await vi.waitFor(() =>
      expect(f.channel.send).toHaveBeenCalledExactlyOnceWith({ type: "ready" })
    );
    expect(f.request.mock.calls).toEqual([
      [{ action: "status" }, 0],
      [attach, 1],
      [attach, 4]
    ]);
    expect(f.client.close).not.toHaveBeenCalled();
    f.disconnect();
    expect(await done).toBe(0);
  });

  it("fails after three stale attach retries", async () => {
    const f = fixture();
    f.request.mockImplementation(async (command, revision) =>
      command.action === "status"
        ? { requestId: "status", ok: true, snapshot: f.snapshot }
        : {
            requestId: "stale",
            ok: false,
            code: "stale_revision",
            snapshot: { ...f.snapshot, revision: revision + 1 }
          }
    );

    expect(await serveDesktopSession(f.client, f.channel)).toBe(1);
    expect(f.request.mock.calls.map(([, revision]) => revision)).toEqual([
      0, 1, 2, 3, 4
    ]);
    expect(f.channel.send).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      error: "Desktop attach failed: stale_revision"
    });
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it.each(["transport error", "blocked"] as const)(
    "does not retry attach after %s",
    async (failure) => {
      const f = fixture();
      f.request.mockResolvedValueOnce({
        requestId: "status",
        ok: true,
        snapshot: f.snapshot
      });
      if (failure === "transport error") {
        f.request.mockRejectedValueOnce(new Error("Control request timed out"));
      } else {
        f.request.mockResolvedValueOnce({
          requestId: "blocked",
          ok: false,
          code: failure,
          snapshot: { ...f.snapshot, revision: 2 }
        });
      }

      expect(await serveDesktopSession(f.client, f.channel)).toBe(1);
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(f.channel.send).toHaveBeenCalledExactlyOnceWith({
        type: "error",
        error:
          failure === "transport error"
            ? "Control request timed out"
            : "Desktop attach failed: blocked"
      });
    }
  );

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

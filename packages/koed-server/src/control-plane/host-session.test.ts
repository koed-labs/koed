import { describe, expect, it, vi } from "vitest";
import { serveControlConnection } from "./host-session.js";
import type { HostCore } from "./host-core.js";
import type { ControlConnection } from "./transport.js";

function fixture() {
  let onMessage = (_message: string) => {};
  let onClose = () => {};
  let onEnd = () => {};
  const sent: string[] = [];
  const connection: ControlConnection = {
    peer: { pid: 123, uid: 501 },
    send: vi.fn(async (message: string) => {
      sent.push(message);
    }),
    onMessage(listener) {
      onMessage = listener;
      return () => {};
    },
    onClose(listener) {
      onClose = listener;
      return () => {};
    },
    onEnd(listener) {
      onEnd = listener;
      return () => {};
    },
    close: vi.fn(() => onClose())
  };
  const snapshot = {
    instanceId: "instance",
    revision: 1,
    state: "stopped" as const,
    stopIntent: false
  };
  const core = {
    status: () => snapshot,
    start: vi.fn(() => snapshot),
    stop: vi.fn(() => snapshot)
  } as unknown as HostCore;
  const validateHello = vi.fn((value: unknown): unknown => {
    if (value !== "valid") throw new Error("bad hello");
    return { hello: "server" };
  });
  serveControlConnection({
    connection,
    core,
    validateHello
  });
  return {
    connection,
    core,
    sent,
    validateHello,
    end: () => onEnd(),
    message: (value: unknown) => onMessage(JSON.stringify(value))
  };
}

async function settle() {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}

describe("control host connection", () => {
  it("validates the first hello before dispatching requests", async () => {
    const f = fixture();
    f.message("valid");
    f.message({
      requestId: "r",
      instanceId: "instance",
      expectedRevision: 1,
      command: { action: "status" }
    });
    await settle();
    expect(f.validateHello).toHaveBeenCalledWith("valid", f.connection.peer);
    expect(f.sent.map((value): unknown => JSON.parse(value))).toEqual([
      { hello: "server" },
      expect.objectContaining({ requestId: "r", ok: true })
    ]);
    expect(f.connection.close).not.toHaveBeenCalled();
  });

  it("closes idle unauthenticated sessions at the hello deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.connection.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("awaits rejected asynchronous validation before dispatch", async () => {
    const f = fixture();
    f.validateHello.mockImplementation(async () => {
      throw new Error("denied");
    });
    f.message("valid");
    f.message({
      requestId: "r",
      instanceId: "instance",
      expectedRevision: 1,
      command: { action: "start", explicit: true }
    });
    await settle();
    expect(f.connection.close).toHaveBeenCalledOnce();
    expect(f.core.start).not.toHaveBeenCalled();
  });

  it("processes frames before closing after input EOF", async () => {
    const f = fixture();
    f.message("valid");
    f.message({
      requestId: "r",
      instanceId: "instance",
      expectedRevision: 1,
      command: { action: "status" }
    });
    f.end();
    await settle();
    expect(f.sent).toHaveLength(2);
    expect(f.connection.close).toHaveBeenCalledOnce();
  });

  it("bounds pending work before it reaches the host", async () => {
    const f = fixture();
    for (let i = 0; i < 65; i++) f.message("valid");
    await settle();
    expect(f.connection.close).toHaveBeenCalledOnce();
    expect(f.validateHello).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  });

  it("closes on invalid hello without dispatch", async () => {
    const f = fixture();
    f.message("invalid");
    f.message({
      requestId: "r",
      instanceId: "instance",
      expectedRevision: 1,
      command: { action: "start", explicit: true }
    });
    await settle();
    expect(f.connection.close).toHaveBeenCalledOnce();
    expect(f.core.start).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  });
});

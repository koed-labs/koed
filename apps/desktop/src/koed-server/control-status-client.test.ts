import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createControlStatusClient } from "./control-status-client.js";

const snapshot = {
  instanceId: "host",
  revision: 1,
  state: "ready",
  stopIntent: false
};

class FakeChild extends EventEmitter {
  connected = true;
  send = vi.fn();
  kill = vi.fn();

  get request() {
    return this.send.mock.lastCall?.[0];
  }
}

function fixture() {
  const child = new FakeChild();
  const next = new FakeChild();
  const spawn = vi
    .fn<() => ChildProcess>()
    .mockReturnValueOnce(child as unknown as ChildProcess)
    .mockReturnValueOnce(next as unknown as ChildProcess);
  return { child, next, spawn, status: createControlStatusClient(spawn) };
}

function reply(child: FakeChild, result: object) {
  child.emit("message", {
    type: "status-result",
    requestId: child.request.requestId,
    ...result
  });
}

describe("Desktop control status client", () => {
  it("spawns lazily and reuses the helper for later probes, including unavailable results", async () => {
    const { child, spawn, status } = fixture();
    expect(spawn).not.toHaveBeenCalled();

    const first = status.probe(1_000);
    expect(child.request).toBeUndefined();
    child.emit("message", { type: "status-ready" });
    expect(child.request).toEqual({ type: "status", requestId: 1 });
    reply(child, { ok: false });
    await expect(first).resolves.toEqual({ ok: false });

    const second = status.probe(1_000);
    expect(child.request).toEqual({ type: "status", requestId: 2 });
    reply(child, { ok: true, snapshot });
    await expect(second).resolves.toEqual({ ok: true, snapshot });
    expect(spawn).toHaveBeenCalledOnce();
    status.close();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it.each([
    { requestId: 55, ok: true, snapshot },
    { ok: true, snapshot: { state: "stopped" } },
    { ok: "true", snapshot }
  ])("rejects a malformed or uncorrelated reply: %j", async (result) => {
    const { child, status } = fixture();
    const probe = status.probe(1_000);
    child.emit("message", { type: "status-ready" });
    reply(child, result);
    await expect(probe).rejects.toThrow(/reply/i);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("times out a stuck helper then spawns a fresh one on the next probe", async () => {
    const { child, next, spawn, status } = fixture();
    await expect(status.probe(10)).rejects.toThrow(/timed out/i);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.listenerCount("message")).toBe(0);

    const probe = status.probe(1_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    next.emit("message", { type: "status-ready" });
    reply(next, { ok: true, snapshot });
    await expect(probe).resolves.toEqual({ ok: true, snapshot });
    status.close();
  });

  it("rejects a pending probe and disposes the helper on disconnect", async () => {
    const { child, status } = fixture();
    const probe = status.probe(1_000);
    child.connected = false;
    child.emit("disconnect");
    await expect(probe).rejects.toThrow(/disconnect/i);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("rejects a pending probe when explicitly closed", async () => {
    const { child, status } = fixture();
    const probe = status.probe(1_000);
    status.close();
    await expect(probe).rejects.toThrow(/closed/i);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

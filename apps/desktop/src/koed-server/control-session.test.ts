import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openDesktopControlSession } from "./control-session.js";

class FakeChild extends EventEmitter {
  connected = true;
  send = vi.fn();
  kill = vi.fn();
}
describe("Desktop control session process", () => {
  it("waits for an authenticated attachment and asks for an intentional detach", async () => {
    const child = new FakeChild();
    const opening = openDesktopControlSession(() => child as never);
    child.emit("message", { type: "ready" });
    const session = await opening;
    const closing = session.detach();
    expect(child.send).toHaveBeenCalledWith(
      { type: "detach" },
      expect.any(Function)
    );
    child.emit("message", { type: "detached", ok: true });
    expect(await closing).toEqual({ ok: true });
  });
  it("notifies the manager if the attached helper disconnects", async () => {
    const child = new FakeChild();
    const opening = openDesktopControlSession(() => child as never);
    child.emit("message", { type: "ready" });
    const session = await opening;
    const closed = vi.fn();
    session.onClose?.(closed);
    child.connected = false;
    child.emit("disconnect");
    expect(closed).toHaveBeenCalledOnce();
    expect(session.isConnected()).toBe(false);
  });
  it("rejects if the helper exits before attaching", async () => {
    const child = new FakeChild();
    const opening = openDesktopControlSession(() => child as never);
    child.emit("exit", 1);
    await expect(opening).rejects.toThrow("before attaching");
  });
});

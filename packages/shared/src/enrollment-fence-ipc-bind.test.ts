import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startEnrollmentFenceIpcDispatcher } from "./enrollment-fence-ipc-dispatcher.js";

const instanceId = "123e4567-e89b-42d3-a456-426614174000";
const request = (seq: number, op: string) =>
  JSON.stringify({ v: 1, type: "request", seq, op, args: {} });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
class Endpoint extends EventEmitter {
  connected = true;
  sent: string[] = [];
  callbacks: ((error: Error | null) => void)[] = [];
  send(wire: string, callback: (error: Error | null) => void) {
    this.sent.push(wire);
    this.callbacks.push(callback);
    return true;
  }
  disconnect() {
    this.connected = false;
    this.emit("disconnect");
  }
  ack() {
    this.callbacks.shift()!(null);
  }
}
function adapter() {
  return {
    instanceId,
    createEpoch: vi.fn(
      () => "123e4567e89b42d3a456426614174001-0000000000000001"
    ),
    register: vi.fn(() => instanceId),
    fenceEpoch: vi.fn(() => "drained" as const),
    fenceOperation: vi.fn(() => "drained" as const),
    closeAdmission: vi.fn(async () => {})
  };
}
describe("deferred bind", () => {
  it("advertises transport readiness and rejects pre-bind operations", () => {
    const endpoint = new Endpoint();
    const bind = vi.fn(async () => adapter());
    const dispatcher = startEnrollmentFenceIpcDispatcher(endpoint, {
      instanceId,
      bind
    });
    endpoint.ack();
    endpoint.emit("message", request(1, "create"));
    expect(dispatcher.state()).toBe("poisoned");
    expect(bind).not.toHaveBeenCalled();
  });
  it("reserves binding and rejects pipelining before send acknowledgement", async () => {
    const endpoint = new Endpoint();
    const bound = adapter();
    const dispatcher = startEnrollmentFenceIpcDispatcher(endpoint, {
      instanceId,
      bind: async () => bound
    });
    endpoint.ack();
    endpoint.emit("message", request(1, "bind"));
    await tick();
    endpoint.emit("message", request(2, "create"));
    expect(dispatcher.state()).toBe("poisoned");
    expect(bound.createEpoch).not.toHaveBeenCalled();
    expect(bound.closeAdmission).toHaveBeenCalled();
  });
  it("retains delayed factory and closes late adapter after cancellation", async () => {
    const endpoint = new Endpoint();
    let release!: (a: ReturnType<typeof adapter>) => void;
    let signal!: AbortSignal;
    const dispatcher = startEnrollmentFenceIpcDispatcher(endpoint, {
      instanceId,
      bind: (s) => {
        signal = s;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    });
    endpoint.ack();
    endpoint.emit("message", request(1, "bind"));
    dispatcher.close();
    expect(signal.aborted).toBe(true);
    let settled = false;
    const waiting = dispatcher.settled().then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    const bound = adapter();
    release(bound);
    await waiting;
    expect(bound.closeAdmission).toHaveBeenCalled();
    expect(endpoint.sent).toHaveLength(1);
  });
});

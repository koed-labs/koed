import { EventEmitter, once } from "node:events";
import { fork } from "node:child_process";
import { Server } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { decodeEnrollmentFenceMessage } from "./enrollment-fence-ipc-codec.js";
import { startEnrollmentFenceIpcDispatcher } from "./enrollment-fence-ipc-dispatcher.js";

const instanceId = "123e4567-e89b-42d3-a456-426614174000";
const epochId = "123e4567e89b42d3a456426614174001-0000000000000001";
const operationId = "123e4567-e89b-42d3-a456-426614174002";
const request = (seq: number, op = "create", args: object = {}) =>
  JSON.stringify({
    v: 1,
    type: "request",
    seq: op === "bind" || op === "bindAck" || seq === 0 ? seq : seq + 2,
    op,
    args
  });

class Endpoint extends EventEmitter {
  connected = true;
  sent: string[] = [];
  callbacks: ((error: Error | null) => void)[] = [];
  backpressure = false;
  send(message: string, callback: (error: Error | null) => void): boolean {
    this.sent.push(message);
    this.callbacks.push(callback);
    return !this.backpressure;
  }
  disconnect() {
    this.connected = false;
    this.emit("disconnect");
  }
  ack(error: Error | null = null) {
    this.callbacks.shift()!(error);
  }
}

async function setup() {
  const endpoint = new Endpoint();
  const adapter = {
    instanceId,
    closeAdmission: vi.fn(async () => {}),
    createEpoch: vi.fn(() => epochId),
    register: vi.fn(() => operationId),
    fenceEpoch: vi.fn(() => "drained" as const),
    fenceOperation: vi.fn(() => "pending" as const)
  };
  const options = { instanceId, bind: vi.fn(async () => adapter) };
  const dispatcher = startEnrollmentFenceIpcDispatcher(endpoint, options);
  endpoint.ack();
  endpoint.emit("message", request(1, "bind"));
  await tick();
  const response = decodeEnrollmentFenceMessage(endpoint.sent[1]);
  if (
    response.type !== "response" ||
    response.op !== "bind" ||
    response.result.kind !== "ok"
  )
    throw new Error("Invalid bind response");
  endpoint.ack();
  endpoint.emit(
    "message",
    request(2, "bindAck", { challenge: response.result.challenge })
  );
  await tick();
  endpoint.ack();
  endpoint.sent.splice(0, 3, endpoint.sent[0]!);
  return { endpoint, adapter, dispatcher, options };
}
function unready() {
  const endpoint = new Endpoint();
  const adapter = {
    instanceId,
    closeAdmission: vi.fn(async () => {}),
    createEpoch: vi.fn(() => epochId),
    register: vi.fn(() => operationId),
    fenceEpoch: vi.fn(() => "drained" as const),
    fenceOperation: vi.fn(() => "pending" as const)
  };
  const options = { instanceId, bind: vi.fn(async () => adapter) };
  const dispatcher = startEnrollmentFenceIpcDispatcher(endpoint, options);
  return { endpoint, adapter, options, dispatcher };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("enrollment fence IPC dispatcher", () => {
  it("is not quiescent until the terminal disconnect event", async () => {
    const { endpoint, dispatcher } = await setup();
    endpoint.disconnect = () => {
      endpoint.connected = false;
    };
    endpoint.emit("message", request(1, "finish"));
    await tick();
    endpoint.ack();
    expect(dispatcher.state()).toBe("disconnecting");
    expect(dispatcher.quiescent()).toBe(false);
    endpoint.emit("disconnect");
    expect(dispatcher.quiescent()).toBe(true);
  });

  it("is not quiescent while a poisoned response send callback is pending", async () => {
    const { endpoint, dispatcher } = await setup();
    endpoint.emit("message", request(1));
    await tick();
    dispatcher.close();
    await dispatcher.settled();
    expect(dispatcher.quiescent()).toBe(false);
    endpoint.ack();
    expect(dispatcher.quiescent()).toBe(true);
  });
  it.each([
    ["poison", "create"],
    ["disconnect", "create"],
    ["close", "create"],
    ["poison", "register"],
    ["disconnect", "register"],
    ["close", "register"]
  ])(
    "retains pending adapter work after %s during %s",
    async (cause, operation) => {
      const { endpoint, adapter, dispatcher } = await setup();
      let resolve!: (id: string) => void;
      let effected = false;
      const method =
        operation === "create" ? adapter.createEpoch : adapter.register;
      method.mockImplementation(
        () =>
          new Promise<string>((r) => {
            resolve = r;
          }).then((id) => {
            effected = true;
            return id;
          }) as never
      );
      endpoint.emit(
        "message",
        operation === "create"
          ? request(1)
          : request(1, "register", { instanceId, epochId })
      );
      const tracked = dispatcher.settled();
      let settled = false;
      void tracked.then(() => {
        settled = true;
      });
      if (cause === "poison") endpoint.emit("message", "bad");
      else if (cause === "disconnect") endpoint.emit("disconnect");
      else dispatcher.close();
      expect(dispatcher.uncertain()).toBe(true);
      expect(dispatcher.quiescent()).toBe(false);
      await tick();
      expect(settled).toBe(false);
      resolve(epochId);
      await tracked;
      expect(effected).toBe(true);
      expect(dispatcher.quiescent()).toBe(true);
      expect(dispatcher.uncertain()).toBe(true);
    }
  );

  it("permanently claims dispatcher endpoint", async () => {
    const { endpoint, adapter, dispatcher } = await setup();
    expect(() =>
      startEnrollmentFenceIpcDispatcher(endpoint, {
        instanceId,
        bind: async () => adapter
      })
    ).toThrow();
    dispatcher.close();
    expect(() =>
      startEnrollmentFenceIpcDispatcher(endpoint, {
        instanceId,
        bind: async () => adapter
      })
    ).toThrow();
  });

  it("rejects post-finish input without adapter effects until disconnect", async () => {
    const { endpoint, dispatcher, adapter } = await setup();
    endpoint.disconnect = () => {};
    endpoint.emit("message", request(1, "finish"));
    await tick();
    endpoint.ack();
    endpoint.emit("message", request(2));
    expect(dispatcher.state()).toBe("poisoned");
    expect(dispatcher.uncertain()).toBe(true);
    expect(adapter.createEpoch).not.toHaveBeenCalled();
  });
  it("waits for prior send callbacks, then acknowledges finish before disconnect", async () => {
    const { endpoint, dispatcher } = await setup();
    endpoint.emit("message", request(1));
    endpoint.emit("message", request(2, "finish"));
    await tick();
    expect(endpoint.sent).toHaveLength(2);
    endpoint.ack();
    await tick();
    expect(decodeEnrollmentFenceMessage(endpoint.sent[2])).toEqual({
      v: 1,
      type: "response",
      seq: 4,
      op: "finish",
      result: { kind: "ok" }
    });
    expect(endpoint.connected).toBe(true);
    endpoint.ack();
    expect(dispatcher.state()).toBe("closed");
    expect(endpoint.connected).toBe(false);
  });

  it("poisons if a request follows queued finish", async () => {
    const { endpoint, dispatcher } = await setup();
    endpoint.emit("message", request(1, "finish"));
    endpoint.emit("message", request(2));
    expect(dispatcher.state()).toBe("poisoned");
  });
  it("executes and responds in order, including send backpressure", async () => {
    const { endpoint, adapter } = await setup();
    endpoint.emit("message", request(1));
    endpoint.emit("message", request(3, "register", { instanceId, epochId }));
    await tick();
    expect(adapter.createEpoch).toHaveBeenCalledTimes(1);
    expect(adapter.register).not.toHaveBeenCalled();
    expect(decodeEnrollmentFenceMessage(endpoint.sent[1])).toEqual({
      v: 1,
      type: "response",
      seq: 3,
      op: "create",
      result: { kind: "ok", instanceId, epochId }
    });
    endpoint.ack();
    await tick();
    expect(adapter.register).toHaveBeenCalledWith({ instanceId, epochId });
    expect(decodeEnrollmentFenceMessage(endpoint.sent[2])).toEqual({
      v: 1,
      type: "response",
      seq: 5,
      op: "register",
      result: { kind: "ok", instanceId, epochId, operationId }
    });
    endpoint.ack();
  });

  it("poisons immediately on duplicate while an effect is pending", async () => {
    const { endpoint, adapter, dispatcher } = await setup();
    let resolve!: (id: string) => void;
    adapter.createEpoch.mockImplementation(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }) as never
    );
    endpoint.emit("message", request(1));
    endpoint.emit("message", request(2, "register", { instanceId, epochId }));
    endpoint.emit("message", request(1));
    resolve(epochId);
    await tick();
    expect(dispatcher.state()).toBe("poisoned");
    expect(endpoint.connected).toBe(false);
    expect(adapter.register).not.toHaveBeenCalled();
    expect(endpoint.sent).toHaveLength(1);
  });

  it.each([request(1, "unknown"), request(0), "{}", "x".repeat(4097)])(
    "rejects malformed input",
    async (wire) => {
      const { endpoint, adapter, dispatcher } = await setup();
      endpoint.emit("message", wire);
      expect(dispatcher.state()).toBe("poisoned");
      expect(adapter.createEpoch).not.toHaveBeenCalled();
    }
  );

  it("poisons on unexpected handle, failed send, and uncertain adapter exception", async () => {
    const first = await setup();
    first.endpoint.emit("message", request(1), {});
    expect(first.dispatcher.state()).toBe("poisoned");
    const second = await setup();
    second.endpoint.emit("message", request(1));
    await tick();
    second.endpoint.ack(new Error("secret"));
    expect(second.dispatcher.state()).toBe("poisoned");
    const third = await setup();
    third.adapter.createEpoch.mockImplementation(() => {
      throw new Error("secret");
    });
    third.endpoint.emit("message", request(1));
    await tick();
    expect(third.dispatcher.state()).toBe("poisoned");
    expect(third.endpoint.sent).toHaveLength(1);
  });

  it("correlates both drain responses with requested identities", async () => {
    const { endpoint, adapter } = await setup();
    endpoint.emit("message", request(1, "fenceEpoch", { instanceId, epochId }));
    endpoint.emit(
      "message",
      request(2, "fenceOperation", { instanceId, epochId, operationId })
    );
    await tick();
    expect(decodeEnrollmentFenceMessage(endpoint.sent[1])).toEqual({
      v: 1,
      type: "response",
      seq: 3,
      op: "fenceEpoch",
      result: { kind: "ok", instanceId, epochId, status: "drained" }
    });
    endpoint.ack();
    await tick();
    expect(adapter.fenceOperation).toHaveBeenCalledWith({
      instanceId,
      epochId,
      operationId
    });
    expect(decodeEnrollmentFenceMessage(endpoint.sent[2])).toEqual({
      v: 1,
      type: "response",
      seq: 4,
      op: "fenceOperation",
      result: {
        kind: "ok",
        instanceId,
        epochId,
        operationId,
        status: "pending"
      }
    });
    endpoint.ack();
  });

  it("poisons on send throw or instance mismatch before dispatch", async () => {
    const first = await setup();
    first.endpoint.send = () => {
      throw new Error("secret");
    };
    first.endpoint.emit("message", request(1));
    await tick();
    expect(first.dispatcher.state()).toBe("poisoned");
    const second = await setup();
    second.endpoint.emit(
      "message",
      request(1, "register", {
        instanceId: "123e4567-e89b-42d3-a456-426614174999",
        epochId
      })
    );
    expect(second.dispatcher.state()).toBe("poisoned");
    expect(second.adapter.register).not.toHaveBeenCalled();
  });

  it("holds bind until ready callback succeeds; failed ready drops queued bind", async () => {
    const first = unready();
    first.endpoint.emit("message", request(1, "bind"));
    expect(first.options.bind).not.toHaveBeenCalled();
    first.endpoint.ack();
    await tick();
    expect(first.options.bind).toHaveBeenCalledTimes(1);
    first.endpoint.ack();
    const second = unready();
    second.endpoint.emit("message", request(1, "bind"));
    second.endpoint.ack(new Error("secret"));
    await tick();
    expect(second.dispatcher.state()).toBe("poisoned");
    expect(second.options.bind).not.toHaveBeenCalled();
  });

  it("rejects operations pipelined behind bind before ready", () => {
    const { endpoint, adapter, dispatcher } = unready();
    endpoint.emit("message", request(1, "bind"));
    endpoint.emit("message", request(1));
    expect(dispatcher.state()).toBe("poisoned");
    endpoint.ack();
    expect(adapter.createEpoch).not.toHaveBeenCalled();
  });

  it("does not send late in-flight results or execute queued work after close", async () => {
    const { endpoint, adapter, dispatcher } = await setup();
    let resolve!: (id: string) => void;
    adapter.createEpoch.mockImplementation(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }) as never
    );
    endpoint.emit("message", request(1));
    endpoint.emit("message", request(2));
    dispatcher.close();
    resolve(epochId);
    await tick();
    expect(dispatcher.state()).toBe("closed");
    expect(adapter.createEpoch).toHaveBeenCalledTimes(1);
    expect(endpoint.sent).toHaveLength(1);
  });

  it.each([false, true])(
    "handles false send return and callback error=%s",
    async (failed) => {
      const { endpoint, adapter, dispatcher } = await setup();
      endpoint.backpressure = true;
      endpoint.emit("message", request(1));
      endpoint.emit("message", request(2));
      await tick();
      expect(adapter.createEpoch).toHaveBeenCalledTimes(1);
      endpoint.ack(failed ? new Error("secret") : null);
      await tick();
      expect(adapter.createEpoch).toHaveBeenCalledTimes(failed ? 1 : 2);
      expect(dispatcher.state()).toBe(failed ? "poisoned" : "ready");
    }
  );

  it.each(["close", "disconnect", "error", "decreasing", "response"])(
    "stops queued work and ignores late callbacks on %s",
    async (event) => {
      const { endpoint, adapter, dispatcher } = await setup();
      const unrelated = vi.fn();
      endpoint.on("message", unrelated);
      endpoint.emit("message", request(2));
      endpoint.emit("message", request(3));
      await tick();
      if (event === "close") dispatcher.close();
      else if (event === "decreasing") endpoint.emit("message", request(1));
      else if (event === "response")
        endpoint.emit(
          "message",
          JSON.stringify({
            v: 1,
            type: "response",
            seq: 4,
            op: "create",
            result: { kind: "ok", instanceId, epochId }
          })
        );
      else endpoint.emit(event);
      expect(dispatcher.state()).toBe(
        event === "close" ? "closed" : "poisoned"
      );
      expect(endpoint.listenerCount("message")).toBe(1);
      expect(endpoint.listenerCount("disconnect")).toBe(0);
      expect(endpoint.listenerCount("error")).toBe(0);
      endpoint.ack();
      await tick();
      expect(adapter.createEpoch).toHaveBeenCalledTimes(1);
      expect(endpoint.sent).toHaveLength(2);
    }
  );

  it("closes a real transferable server handle rejected over inherited IPC", async () => {
    const child = fork(
      "-e",
      [
        `const net = require('node:net'); process.on('message', () => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => process.send('unexpected', server)); });`
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] }
    );
    const handlePromise = new Promise<Server>((resolve) =>
      child.prependOnceListener("message", (_message, handle) =>
        resolve(handle as Server)
      )
    );
    const adapter = {
      instanceId,
      closeAdmission: vi.fn(async () => {}),
      createEpoch: vi.fn(() => epochId),
      register: vi.fn(() => operationId),
      fenceEpoch: vi.fn(() => "drained" as const),
      fenceOperation: vi.fn(() => "pending" as const)
    };
    const dispatcher = startEnrollmentFenceIpcDispatcher(child, {
      instanceId,
      bind: async () => adapter
    });
    try {
      const handle = await handlePromise;
      expect(handle).toBeInstanceOf(Server);
      if (handle.listening) await once(handle, "close");
      expect(handle.listening).toBe(false);
      expect(dispatcher.state()).toBe("poisoned");
      expect(adapter.createEpoch).not.toHaveBeenCalled();
    } finally {
      child.kill();
    }
  });

  it("bounds active plus queued requests and discards queued work on poison", async () => {
    const { endpoint, adapter, dispatcher } = await setup();
    for (let seq = 1; seq <= 33; seq++) endpoint.emit("message", request(seq));
    expect(dispatcher.state()).toBe("poisoned");
    expect(adapter.createEpoch).toHaveBeenCalledTimes(1);
  });
});

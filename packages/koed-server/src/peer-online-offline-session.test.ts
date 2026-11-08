import { Buffer } from "node:buffer";
import process from "node:process";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { createPeerOnlineCheckpointReceiver } from "../../db/src/peer-online-receiver.js";
import type { MemberSession } from "./peer-online-member-listener.js";
import {
  startOfflineSession,
  type OfflineSessionOptions
} from "./peer-online-offline-session.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const frames: (Buffer | null)[] = [];
  const waiting = deferred<Buffer | null>();
  const sent: Uint8Array[] = [];
  const errors: unknown[] = [];
  const checkpoint = {
    bindingJson: '{"origin":"other"}',
    envelope: "envelope",
    payload: new Uint8Array([1])
  };
  const ack = {
    sessionKey: "receiver-key",
    sequence: "42",
    hash: "receiver-hash"
  };
  const channel = {
    receive: vi.fn(async () =>
      frames.length ? frames.shift()! : waiting.promise
    ),
    send: vi.fn(async (bytes: Uint8Array) => {
      sent.push(bytes);
    }),
    close: vi.fn(() => waiting.resolve(null))
  };
  const options: OfflineSessionOptions = {
    session: { peerDeviceId: "peer", membershipRevision: "rev" },
    channel,
    receiver: {
      receive: vi.fn(async () => ({ status: "accepted" as const, ack }))
    },
    codec: {
      decode: vi.fn(() => checkpoint),
      encodeAck: vi.fn(() => new Uint8Array([9]))
    },
    maxFrameBytes: 10,
    onError: (error) => errors.push(error)
  };
  return { frames, sent, errors, checkpoint, ack, channel, options };
}

// Test-only contract example, not a production wire schema.
function testCodec(): OfflineSessionOptions["codec"] {
  return {
    decode(frame) {
      const value: unknown = JSON.parse(Buffer.from(frame).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid frame");
      const record = value as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(",") !==
          "bindingJson,envelope,payload,type" ||
        record.type !== "checkpoint" ||
        typeof record.bindingJson !== "string" ||
        typeof record.envelope !== "string" ||
        !Array.isArray(record.payload) ||
        !record.payload.every(
          (byte: unknown) =>
            Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255
        )
      )
        throw new Error("invalid frame");
      return {
        bindingJson: record.bindingJson,
        envelope: record.envelope,
        payload: Uint8Array.from(record.payload)
      };
    },
    encodeAck: () => new Uint8Array([9])
  };
}

describe("offline peer session", () => {
  it("is structurally compatible with the existing session and receiver types", () => {
    expectTypeOf<MemberSession>().toMatchTypeOf<
      OfflineSessionOptions["session"]
    >();
    expectTypeOf<ReturnType<MemberSession["openChannel"]>>().toMatchTypeOf<
      OfflineSessionOptions["channel"]
    >();
    expectTypeOf<
      ReturnType<typeof createPeerOnlineCheckpointReceiver>
    >().toMatchTypeOf<OfflineSessionOptions["receiver"]>();
    expectTypeOf<
      Parameters<OfflineSessionOptions["receiver"]["receive"]>
    >().toMatchTypeOf<
      Parameters<
        ReturnType<typeof createPeerOnlineCheckpointReceiver>["receive"]
      >
    >();
  });
  it.each([
    '{"type":"checkpoint","bindingJson":"b","envelope":"e","payload":[1],"session":{"peerDeviceId":"forged"}}',
    '{"type":"checkpoint","bindingJson":"b","envelope":"e","payload":[1],"extra":true}',
    '{"type":"other","bindingJson":"b","envelope":"e","payload":[1]}',
    "{bad json"
  ])("rejects invalid encoded wire frame %s", async (wire) => {
    const f = fixture();
    f.options.codec = testCodec();
    f.options.maxFrameBytes = 1024;
    f.frames.push(Buffer.from(wire), Buffer.from(wire));
    await startOfflineSession(f.options).done;
    expect(f.options.receiver.receive).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
    expect(f.errors).toHaveLength(1);
    expect(f.channel.receive).toHaveBeenCalledTimes(1);
  });

  it("passes valid encoded wire frame to receiver with trusted context", async () => {
    const f = fixture();
    f.options.codec = testCodec();
    f.options.maxFrameBytes = 1024;
    f.frames.push(
      Buffer.from(
        '{"type":"checkpoint","bindingJson":"b","envelope":"e","payload":[1]}'
      ),
      null
    );
    await startOfflineSession(f.options).done;
    expect(f.options.receiver.receive).toHaveBeenCalledWith(
      { bindingJson: "b", envelope: "e", payload: new Uint8Array([1]) },
      { peerDeviceId: "peer", membershipRevision: "rev" }
    );
    expect(f.sent).toEqual([new Uint8Array([9])]);
    expect(f.errors).toEqual([]);
  });
  it("snapshots trusted context and preserves checkpoint origin", async () => {
    const f = fixture();
    f.frames.push(Buffer.from([1]), null);
    const session = startOfflineSession(f.options);
    (f.options.session as { peerDeviceId: string }).peerDeviceId = "changed";
    await session.done;
    expect(f.options.receiver.receive).toHaveBeenCalledWith(f.checkpoint, {
      peerDeviceId: "peer",
      membershipRevision: "rev"
    });
    expect(f.options.codec.encodeAck).toHaveBeenCalledWith(f.ack);
    expect(f.sent).toEqual([new Uint8Array([9])]);
  });

  it("serializes receivers and drains in-flight receiver on close without ACK", async () => {
    const f = fixture();
    const pending = deferred<{ status: "accepted"; ack: typeof f.ack }>();
    f.frames.push(Buffer.from([1]), Buffer.from([2]));
    f.options.receiver.receive = vi.fn(() => pending.promise);
    const session = startOfflineSession(f.options);
    await vi.waitFor(() =>
      expect(f.options.receiver.receive).toHaveBeenCalledTimes(1)
    );
    const closing = session.close();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.channel.close).toHaveBeenCalled();
    pending.resolve({ status: "accepted", ack: f.ack });
    await closing;
    expect(f.sent).toEqual([]);
    expect(f.options.receiver.receive).toHaveBeenCalledTimes(1);
    expect(session.close()).toBe(session.done);
  });

  it("reports receiver rejection even after close", async () => {
    const f = fixture();
    const pending = deferred<never>();
    f.frames.push(Buffer.from([1]));
    f.options.receiver.receive = vi.fn(() => pending.promise);
    const session = startOfflineSession(f.options);
    await vi.waitFor(() =>
      expect(f.options.receiver.receive).toHaveBeenCalledTimes(1)
    );
    const close = session.close();
    const error = new Error("uncertain commit");
    pending.reject(error);
    await close;
    expect(f.errors).toEqual([error]);
    expect(f.sent).toEqual([]);
  });

  it("reports receiver rejection even if it equals channel cancellation identity", async () => {
    const f = fixture();
    const pending = deferred<never>();
    const cancellation = new Error("local cancellation");
    f.options.channel = { ...f.channel, localCloseError: cancellation };
    f.frames.push(Buffer.from([1]));
    f.options.receiver.receive = vi.fn(() => pending.promise);
    const session = startOfflineSession(f.options);
    await vi.waitFor(() =>
      expect(f.options.receiver.receive).toHaveBeenCalledTimes(1)
    );
    const closing = session.close();
    pending.reject(cancellation);
    await closing;
    expect(f.errors).toEqual([cancellation]);
  });

  it.each([
    "pending",
    "deleted",
    "invalid",
    "quota_exceeded",
    "fenced",
    "unexpected"
  ])("never ACKs %s result", async (status) => {
    const f = fixture();
    f.frames.push(Buffer.from([1]), Buffer.from([2]));
    f.options.receiver.receive = vi.fn(async () => ({ status }) as never);
    const outcome = await startOfflineSession(f.options).done;
    if (status !== "unexpected") expect(outcome).toEqual({ status });
    expect(f.sent).toEqual([]);
    expect(f.options.receiver.receive).toHaveBeenCalledTimes(1);
  });

  it.each([Buffer.alloc(0), Buffer.alloc(11)])(
    "rejects out-of-bounds frame",
    async (frame) => {
      const f = fixture();
      f.frames.push(frame);
      await startOfflineSession(f.options).done;
      expect(f.options.receiver.receive).not.toHaveBeenCalled();
      expect(f.sent).toEqual([]);
      expect(f.errors).toHaveLength(1);
    }
  );

  it.each([
    null,
    {},
    { bindingJson: "x", envelope: "e", payload: [], session: {} },
    { bindingJson: "x", envelope: "e", payload: new Uint8Array(), extra: true }
  ])("rejects malformed decoded checkpoint", async (decoded) => {
    const f = fixture();
    f.frames.push(Buffer.from([1]));
    f.options.codec.decode = vi.fn(() => decoded as never);
    await startOfflineSession(f.options).done;
    expect(f.options.receiver.receive).not.toHaveBeenCalled();
    expect(f.errors).toHaveLength(1);
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid frame limit",
    (limit) => {
      const f = fixture();
      f.options.maxFrameBytes = limit;
      expect(() => startOfflineSession(f.options)).toThrow();
      expect(f.channel.receive).not.toHaveBeenCalled();
    }
  );

  it("waits for first receiver before processing duplicate and uses its ACK", async () => {
    const f = fixture();
    const pending = deferred<{ status: "accepted"; ack: typeof f.ack }>();
    f.frames.push(Buffer.from([1]), Buffer.from([2]), null);
    f.options.receiver.receive = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        status: "duplicate",
        ack: { sessionKey: "duplicate", sequence: "3", hash: "hash" }
      });
    const session = startOfflineSession(f.options);
    await vi.waitFor(() =>
      expect(f.options.receiver.receive).toHaveBeenCalledTimes(1)
    );
    expect(f.channel.receive).toHaveBeenCalledTimes(1);
    pending.resolve({ status: "accepted", ack: f.ack });
    await session.done;
    expect(f.options.codec.encodeAck).toHaveBeenLastCalledWith({
      sessionKey: "duplicate",
      sequence: "3",
      hash: "hash"
    });
    expect(f.sent).toHaveLength(2);
  });

  it("awaits pending send during close and starts no later work", async () => {
    const f = fixture();
    const pending = deferred<void>();
    f.frames.push(Buffer.from([1]), Buffer.from([2]));
    f.channel.send.mockImplementation(() => pending.promise);
    const session = startOfflineSession(f.options);
    await vi.waitFor(() => expect(f.channel.send).toHaveBeenCalledTimes(1));
    let settled = false;
    const closing = session.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve();
    await closing;
    expect(f.channel.receive).toHaveBeenCalledTimes(1);
  });

  it.each(["receive", "send"] as const)(
    "suppresses identified local close cancellation of pending %s",
    async (operation) => {
      const f = fixture();
      const pending = deferred<never>();
      const cancellation = new Error("local cancellation");
      const channel = { ...f.channel, localCloseError: cancellation };
      channel.close.mockImplementation(() => pending.reject(cancellation));
      if (operation === "receive")
        channel.receive.mockImplementation(() => pending.promise);
      else {
        f.frames.push(Buffer.from([1]), Buffer.from([2]));
        channel.send.mockImplementation(() => pending.promise);
      }
      f.options.channel = channel;
      const session = startOfflineSession(f.options);
      await vi.waitFor(() => expect(channel[operation]).toHaveBeenCalled());
      await session.close();
      expect(f.errors).toEqual([]);
      expect(channel.receive).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["receive", "send"] as const)(
    "reports genuine %s failure after close",
    async (operation) => {
      const f = fixture();
      const pending = deferred<never>();
      const failure = new Error("transport failure");
      const channel = {
        ...f.channel,
        localCloseError: new Error("local cancellation")
      };
      channel.close.mockImplementation(() => pending.reject(failure));
      if (operation === "receive")
        channel.receive.mockImplementation(() => pending.promise);
      else {
        f.frames.push(Buffer.from([1]), Buffer.from([2]));
        channel.send.mockImplementation(() => pending.promise);
      }
      f.options.channel = channel;
      const session = startOfflineSession(f.options);
      await vi.waitFor(() => expect(channel[operation]).toHaveBeenCalled());
      await session.close();
      expect(f.errors).toEqual([failure]);
      expect(channel.receive).toHaveBeenCalledTimes(1);
    }
  );

  it("reports receive rejection and stops", async () => {
    const f = fixture();
    const failure = new Error("receive failure");
    f.channel.receive.mockRejectedValue(failure);
    await startOfflineSession(f.options).done;
    expect(f.errors).toEqual([failure]);
    expect(f.options.receiver.receive).not.toHaveBeenCalled();
    expect(f.channel.close).toHaveBeenCalledTimes(1);
  });

  it("reports close failure after pending receive settles", async () => {
    const f = fixture();
    const failure = new Error("close failure");
    f.channel.close.mockImplementation(() => {
      throw failure;
    });
    f.frames.push(null);
    await startOfflineSession(f.options).done;
    expect(f.errors).toEqual([failure]);
    expect(f.channel.close).toHaveBeenCalledTimes(1);
  });

  it("retries after failed delivery with a duplicate ACK in a fresh session", async () => {
    const f = fixture();
    let committed = false;
    f.options.receiver.receive = vi.fn(async () => {
      if (committed) return { status: "duplicate" as const, ack: f.ack };
      committed = true;
      return { status: "accepted" as const, ack: f.ack };
    });
    const failure = new Error("delivery failed");
    f.frames.push(Buffer.from([1]), Buffer.from([2]));
    f.channel.send.mockRejectedValueOnce(failure);
    await startOfflineSession(f.options).done;
    expect(committed).toBe(true);
    expect(f.errors).toEqual([failure]);
    expect(f.options.receiver.receive).toHaveBeenCalledTimes(1);
    const retry = fixture();
    retry.options.receiver = f.options.receiver;
    retry.frames.push(Buffer.from([1]), null);
    await startOfflineSession(retry.options).done;
    expect(retry.options.codec.encodeAck).toHaveBeenCalledWith(f.ack);
    expect(retry.sent).toEqual([new Uint8Array([9])]);
    expect(retry.errors).toEqual([]);
  });

  it("reports callback errors without preventing cleanup", async () => {
    const f = fixture();
    f.frames.push(Buffer.alloc(0));
    f.options.onError = () => {
      throw new Error("callback");
    };
    const warning = vi
      .spyOn(process, "emitWarning")
      .mockImplementation(() => {});
    try {
      await startOfflineSession(f.options).done;
      expect(warning).toHaveBeenCalled();
      expect(f.channel.close).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("reports unknown receiver result instead of silently terminating", async () => {
    const f = fixture();
    f.frames.push(Buffer.from([1]));
    f.options.receiver.receive = vi.fn(
      async () => ({ status: "unknown" }) as never
    );
    await startOfflineSession(f.options).done;
    expect(f.errors).toHaveLength(1);
    expect(f.sent).toEqual([]);
  });

  it("rejects malformed accepted ACK rather than sending it", async () => {
    const f = fixture();
    f.frames.push(Buffer.from([1]));
    f.options.receiver.receive = vi.fn(
      async () => ({ status: "accepted", ack: {} }) as never
    );
    await startOfflineSession(f.options).done;
    expect(f.sent).toEqual([]);
    expect(f.errors).toHaveLength(1);
  });

  it.each(["decode", "encode", "send"])(
    "reports %s failure without continuing",
    async (where) => {
      const f = fixture();
      f.frames.push(Buffer.from([1]), Buffer.from([2]));
      const error = new Error(where);
      if (where === "decode")
        f.options.codec.decode = () => {
          throw error;
        };
      if (where === "encode")
        f.options.codec.encodeAck = () => {
          throw error;
        };
      if (where === "send") f.channel.send.mockRejectedValue(error);
      await startOfflineSession(f.options).done;
      expect(f.errors).toEqual([error]);
      expect(f.channel.receive).toHaveBeenCalledTimes(1);
    }
  );
});

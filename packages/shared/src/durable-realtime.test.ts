import { describe, expect, it, vi } from "vitest";
import {
  connectWithRealtimeTransportFallback,
  encodeDurableRealtimeStreamFrame,
  negotiateDurableRealtimeTransport,
  readFirstBoundedDurableRealtimeFrame,
  readBoundedDurableRealtimeStream,
  readBoundedSse,
  runDurableRealtimeStreamAttempt,
  runDurableRealtime,
  RealtimeTransportFailure
} from "./durable-realtime.js";

const streamFrom = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  });

describe("negotiateDurableRealtimeTransport", () => {
  it("selects the first server preference supported by the client", () => {
    expect(
      negotiateDurableRealtimeTransport(
        ["webtransport", "websocket", "sse"],
        ["sse", "websocket"]
      )
    ).toBe("websocket");
  });

  it("fails closed when no offered transport is supported", () => {
    expect(
      negotiateDurableRealtimeTransport(["webtransport"], ["sse"])
    ).toBeNull();
  });
});

describe("connectWithRealtimeTransportFallback", () => {
  it("falls back only for path-level transport failures", async () => {
    const attempted: string[] = [];
    const fallbacks: string[] = [];
    const connected = await connectWithRealtimeTransportFallback({
      offered: ["webtransport", "websocket", "sse"],
      supported: ["webtransport", "sse"],
      attempt: async (transportId) => {
        attempted.push(transportId);
        if (transportId === "webtransport") {
          throw new RealtimeTransportFailure("network_path", "UDP blocked");
        }
        return "connected";
      },
      onFallback: ({ failedTransportId, nextTransportId }) =>
        fallbacks.push(`${failedTransportId}:${nextTransportId}`)
    });

    expect(connected).toEqual({ transportId: "sse", result: "connected" });
    expect(attempted).toEqual(["webtransport", "sse"]);
    expect(fallbacks).toEqual(["webtransport:sse"]);
  });

  it.each([
    "authentication",
    "authorization",
    "revocation",
    "schema",
    "protocol_integrity"
  ] as const)("fails closed for %s errors", async (kind) => {
    const attempt = vi.fn(async (transportId: string) => {
      throw new RealtimeTransportFailure(kind, transportId);
    });
    await expect(
      connectWithRealtimeTransportFallback({
        offered: ["webtransport", "sse"],
        supported: ["webtransport", "sse"],
        attempt
      })
    ).rejects.toMatchObject({ kind });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe("readFirstBoundedDurableRealtimeFrame", () => {
  it("preserves bytes after the first frame for an interactive stream", async () => {
    const first = await readFirstBoundedDurableRealtimeFrame({
      body: streamFrom(
        '{"event":"attach","data":"{}","id":null}\nhello',
        " world"
      ),
      signal: new AbortController().signal,
      maxFrameBytes: 1024
    });
    const reader = first.remainder.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    expect(first.frame).toEqual({ event: "attach", data: "{}", id: null });
    expect(
      new TextDecoder().decode(
        new Uint8Array(chunks.flatMap((chunk) => [...chunk]))
      )
    ).toBe("hello world");
  });

  it("bounds bytes coalesced behind the attach frame", async () => {
    await expect(
      readFirstBoundedDurableRealtimeFrame({
        body: streamFrom(
          `${JSON.stringify({ event: "attach", data: "{}", id: null })}\n${"x".repeat(33)}`
        ),
        signal: new AbortController().signal,
        maxFrameBytes: 1024,
        maxInitialRemainderBytes: 32
      })
    ).rejects.toThrow(/initial remainder exceeded/);
  });
});

describe("readBoundedSse", () => {
  it("parses split, commented, and multi-line SSE frames", async () => {
    const frames: Array<{ event: string; data: string }> = [];
    const outcome = await readBoundedSse({
      body: streamFrom(
        ": heartbeat\n\nevent: update\nda",
        "ta: first\ndata: second\n\ndata: final\n\n"
      ),
      signal: new AbortController().signal,
      maxFrameBytes: 1024,
      onFrame: (frame) => {
        frames.push(frame);
        return "continue";
      }
    });

    expect(outcome).toBe("ended");
    expect(frames).toEqual([
      { event: "update", data: "first\nsecond" },
      { event: "message", data: "final" }
    ]);
  });

  it("fails closed when a pending frame exceeds its byte limit", async () => {
    await expect(
      readBoundedSse({
        body: streamFrom("data: too-large"),
        signal: new AbortController().signal,
        maxFrameBytes: 8,
        onFrame: () => "continue"
      })
    ).rejects.toThrow("SSE frame exceeded its byte limit");
  });
});

describe("bounded durable realtime stream frames", () => {
  it("preserves ordered SSE-equivalent event semantics across split chunks", async () => {
    const first = encodeDurableRealtimeStreamFrame(
      { event: "ready", data: '{"cursor":"one"}', id: null },
      1024
    );
    const second = encodeDurableRealtimeStreamFrame(
      {
        event: "collaboration_event",
        data: '{"message":"line one\\nline two"}',
        id: "cursor-two"
      },
      1024
    );
    const bytes = new Uint8Array(first.byteLength + second.byteLength);
    bytes.set(first);
    bytes.set(second, first.byteLength);
    const frames: Array<{ event: string; data: string; id: string | null }> =
      [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 11));
        controller.enqueue(bytes.slice(11, 47));
        controller.enqueue(bytes.slice(47));
        controller.close();
      }
    });

    await expect(
      readBoundedDurableRealtimeStream({
        body,
        signal: new AbortController().signal,
        maxFrameBytes: 1024,
        onFrame: (frame) => {
          frames.push(frame);
          return "continue";
        }
      })
    ).resolves.toBe("ended");
    expect(frames).toEqual([
      { event: "ready", data: '{"cursor":"one"}', id: null },
      {
        event: "collaboration_event",
        data: '{"message":"line one\\nline two"}',
        id: "cursor-two"
      }
    ]);
  });

  it("fails closed for oversized, malformed, and extra-field frames", async () => {
    expect(() =>
      encodeDurableRealtimeStreamFrame(
        { event: "ready", data: "too large", id: null },
        8
      )
    ).toThrow("Durable realtime frame exceeded its byte limit");

    for (const frame of [
      '{"event":"ready","data":"{}","id":null,"authority":"admin"}\n',
      '{"event":"ready","data":',
      `{"event":"ready","data":"${"x".repeat(80)}","id":null}`
    ]) {
      await expect(
        readBoundedDurableRealtimeStream({
          body: streamFrom(frame),
          signal: new AbortController().signal,
          maxFrameBytes: 64,
          onFrame: () => "continue"
        })
      ).rejects.toThrow(/Durable realtime frame/);
    }
  });

  it("writes one attach frame then reads ordered server frames", async () => {
    const inbound = new TransformStream<Uint8Array, Uint8Array>();
    const outbound = new TransformStream<Uint8Array, Uint8Array>();
    const receivedAttach: Array<{
      event: string;
      data: string;
      id: string | null;
    }> = [];
    const receivedEvents: Array<{
      event: string;
      data: string;
      id: string | null;
    }> = [];
    const server = (async () => {
      await readBoundedDurableRealtimeStream({
        body: inbound.readable,
        signal: new AbortController().signal,
        maxFrameBytes: 1_024,
        onFrame(frame) {
          receivedAttach.push(frame);
          return "continue";
        }
      });
      const writer = outbound.writable.getWriter();
      await writer.write(
        encodeDurableRealtimeStreamFrame(
          { event: "ready", data: "{}", id: null },
          1_024
        )
      );
      await writer.write(
        encodeDurableRealtimeStreamFrame(
          { event: "collaboration_event", data: '{"sequence":1}', id: "1" },
          1_024
        )
      );
      await writer.close();
    })();

    const outcome = await runDurableRealtimeStreamAttempt({
      stream: { readable: outbound.readable, writable: inbound.writable },
      attach: { event: "attach", data: '{"ticket":"opaque"}', id: null },
      signal: new AbortController().signal,
      maxFrameBytes: 1_024,
      onFrame(frame) {
        receivedEvents.push(frame);
        return "continue";
      }
    });
    await server;

    expect(outcome).toBe("ended");
    expect(receivedAttach).toEqual([
      { event: "attach", data: '{"ticket":"opaque"}', id: null }
    ]);
    expect(receivedEvents).toEqual([
      { event: "ready", data: "{}", id: null },
      {
        event: "collaboration_event",
        data: '{"sequence":1}',
        id: "1"
      }
    ]);
  });
});

describe("runDurableRealtime", () => {
  it("owns reconnect lifecycle while delegating each transport attempt", async () => {
    let now = 1_000;
    const states: string[] = [];
    const reconnectFlags: boolean[] = [];
    const sleep = vi.fn(async (delayMs: number) => {
      now += delayMs;
    });
    let attempt = 0;

    await runDurableRealtime({
      signal: new AbortController().signal,
      retry: {
        maxAttempts: 3,
        attemptWindowMs: 10_000,
        unavailableCooldownMs: 30_000,
        delayForAttempt: (value) => value * 100
      },
      now: () => now,
      sleep,
      onState: (state) => states.push(state.state),
      connect: async ({ reconnecting, markLive }) => {
        reconnectFlags.push(reconnecting);
        markLive();
        markLive();
        attempt += 1;
        return attempt === 1 ? "ended" : "terminal";
      }
    });

    expect(reconnectFlags).toEqual([false, true]);
    expect(states).toEqual(["connecting", "live", "reconnecting", "live"]);
    expect(sleep).toHaveBeenCalledWith(100, expect.any(AbortSignal));
  });

  it("enters a bounded cooldown and stops cleanly when aborted", async () => {
    const controller = new AbortController();
    const states: string[] = [];
    let now = 5_000;
    const sleep = vi.fn(async (delayMs: number) => {
      now += delayMs;
      if (delayMs === 2_000) controller.abort();
    });

    await runDurableRealtime({
      signal: controller.signal,
      retry: {
        maxAttempts: 1,
        attemptWindowMs: 60_000,
        unavailableCooldownMs: 2_000,
        delayForAttempt: () => 100
      },
      now: () => now,
      sleep,
      onState: (state) => states.push(state.state),
      connect: async () => "ended"
    });

    expect(states).toEqual(["connecting", "reconnecting", "unavailable"]);
    expect(sleep).toHaveBeenNthCalledWith(1, 100, controller.signal);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000, controller.signal);
  });

  it("suppresses stale lifecycle work before a connection attempt starts", async () => {
    const connect = vi.fn(async () => "terminal" as const);
    const onState = vi.fn();

    await runDurableRealtime({
      signal: new AbortController().signal,
      isCurrent: () => false,
      retry: {
        maxAttempts: 1,
        attemptWindowMs: 1_000,
        unavailableCooldownMs: 1_000,
        delayForAttempt: () => 0
      },
      onState,
      connect
    });

    expect(onState).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});

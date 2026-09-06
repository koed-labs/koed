import { randomUUID } from "node:crypto";

import {
  encodeDurableRealtimeStreamFrame,
  readBoundedDurableRealtimeStream,
  type DurableRealtimeStreamFrame
} from "@koed/shared/durable-realtime";
import { describe, expect, it, vi } from "vitest";

import type { WebTransportReliableStream } from "../realtime-transport/webtransport-durable-adapter.js";
import type { ManagedTerminalRuntime } from "./terminal-runtime.js";
import { createManagedTerminalWebTransportHandler } from "./terminal-webtransport.js";

const streamPair = () => {
  const inbound = new TransformStream<Uint8Array, Uint8Array>();
  const outbound = new TransformStream<Uint8Array, Uint8Array>();
  return {
    server: {
      readable: inbound.readable,
      writable: outbound.writable
    } satisfies WebTransportReliableStream,
    client: {
      readable: outbound.readable,
      writable: inbound.writable
    }
  };
};

const readFrames = async (
  readable: ReadableStream<Uint8Array>,
  expectedCount: number
) => {
  const frames: DurableRealtimeStreamFrame[] = [];
  await readBoundedDurableRealtimeStream({
    body: readable,
    signal: new AbortController().signal,
    maxFrameBytes: 64 * 1024,
    onFrame(frame) {
      frames.push(frame);
      return frames.length === expectedCount ? "terminal" : "continue";
    }
  });
  return frames;
};

const fixture = () => {
  const ownerUserId = randomUUID();
  const executionId = randomUUID();
  const terminalId = randomUUID();
  const inputEpoch = randomUUID();
  const close = vi.fn(async () => undefined);
  let listener: ((frame: unknown) => void) | null = null;
  let markSubscribed!: () => void;
  const subscribed = new Promise<void>((resolveSubscribed) => {
    markSubscribed = resolveSubscribed;
  });
  const handle = vi.fn(async () => [
    {
      protocolVersion: 1 as const,
      terminalId,
      lifecycleGeneration: 1,
      type: "terminal.input_ack" as const,
      inputEpoch,
      sequence: 1
    }
  ]);
  const runtime = {
    attach: vi.fn(async () => ({
      initialFrames: [
        {
          protocolVersion: 1 as const,
          terminalId,
          lifecycleGeneration: 1,
          type: "terminal.ready" as const,
          requestedAfterOutputSequence: 0,
          earliestOutputSequence: 1,
          latestOutputSequence: 0,
          inputEpoch
        }
      ],
      handle,
      subscribe: (next: (frame: unknown) => void) => {
        listener = next;
        markSubscribed();
        return () => {
          listener = null;
        };
      },
      close
    }))
  } as unknown as ManagedTerminalRuntime;
  const principal = {
    user: {
      id: ownerUserId,
      email: "terminal-owner@example.invalid",
      displayName: "Terminal Owner"
    },
    deviceCredentialId: null,
    operationFamilies: new Set(["managed_terminal"])
  };
  const attach = {
    frameVersion: 1 as const,
    type: "interactive.attach" as const,
    channel: "managed_terminal" as const,
    operationFamily: "managed_terminal" as const,
    resourceId: terminalId,
    executionId,
    lifecycleGeneration: 1,
    afterOutputSequence: 0
  };
  return {
    ownerUserId,
    executionId,
    terminalId,
    inputEpoch,
    close,
    handle,
    runtime,
    subscribed,
    emit: (frame: unknown) => listener?.(frame),
    principal,
    attach
  };
};

describe("managed terminal WebTransport", () => {
  it("carries bounded terminal frames and reauthenticates every client frame", async () => {
    const values = fixture();
    const pair = streamPair();
    const reauthenticate = vi.fn(async () => values.principal);
    const framesPromise = readFrames(pair.client.readable, 2);
    const handled = createManagedTerminalWebTransportHandler(values.runtime)({
      attach: values.attach,
      stream: pair.server,
      admission: {} as never,
      principal: values.principal,
      reauthenticate,
      signal: new AbortController().signal
    });
    const writer = pair.client.writable.getWriter();
    await writer.write(
      encodeDurableRealtimeStreamFrame(
        {
          event: "terminal_frame",
          id: null,
          data: JSON.stringify({
            protocolVersion: 1,
            terminalId: values.terminalId,
            lifecycleGeneration: 1,
            type: "terminal.input",
            inputEpoch: values.inputEpoch,
            sequence: 1,
            dataBase64: Buffer.from("printf test\\n").toString("base64")
          })
        },
        64 * 1024
      )
    );
    await writer.close();
    const frames = await framesPromise;
    await handled;

    expect(
      frames.map((frame) => JSON.parse(frame.data) as { type: string })
    ).toMatchObject([
      { type: "terminal.ready" },
      { type: "terminal.input_ack" }
    ]);
    expect(values.handle).toHaveBeenCalledOnce();
    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(values.close).toHaveBeenCalledOnce();
  });

  it("terminates an idle attachment when terminal authority is revoked", async () => {
    const values = fixture();
    const pair = streamPair();
    const framesPromise = readFrames(pair.client.readable, 1);
    const handled = createManagedTerminalWebTransportHandler(values.runtime, {
      reauthorizationIntervalMs: 5
    })({
      attach: values.attach,
      stream: pair.server,
      admission: {} as never,
      principal: values.principal,
      reauthenticate: async () => ({
        ...values.principal,
        operationFamilies: new Set<string>()
      }),
      signal: new AbortController().signal
    });
    await framesPromise;
    await values.subscribed;

    await expect(handled).rejects.toThrow("revoked");
    expect(values.handle).not.toHaveBeenCalled();
    expect(values.close).toHaveBeenCalledOnce();
  });

  it("detaches a slow client before terminal output can queue without bound", async () => {
    const values = fixture();
    const pair = streamPair();
    const framesPromise = readFrames(pair.client.readable, 1);
    const handled = createManagedTerminalWebTransportHandler(values.runtime, {
      maximumPendingWriteBytes: 64 * 1024
    })({
      attach: values.attach,
      stream: pair.server,
      admission: {} as never,
      principal: values.principal,
      reauthenticate: async () => values.principal,
      signal: new AbortController().signal
    });
    await framesPromise;
    await values.subscribed;
    const output = {
      protocolVersion: 1 as const,
      terminalId: values.terminalId,
      lifecycleGeneration: 1,
      type: "terminal.output" as const,
      sequence: 1,
      dataBase64: Buffer.alloc(40 * 1024, 1).toString("base64")
    };
    values.emit(output);
    values.emit({ ...output, sequence: 2 });

    await expect(handled).rejects.toThrow("queue is full");
    expect(values.close).toHaveBeenCalledOnce();
  });
});

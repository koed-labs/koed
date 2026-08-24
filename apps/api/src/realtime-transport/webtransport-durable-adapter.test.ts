import { randomUUID } from "node:crypto";
import {
  COLLABORATION_CONTRACT_VERSION,
  type WebTransportDurableAttach
} from "@koed/shared";
import {
  readBoundedDurableRealtimeStream,
  type DurableRealtimeStreamFrame
} from "@koed/shared/durable-realtime";
import { describe, expect, it, vi } from "vitest";
import type {
  CollaborationRealtimeEventSink,
  PreparedCollaborationRealtimeStream
} from "../collaboration/index.js";
import type { RealtimeTransportAdmissionService } from "./service.js";
import {
  createWebTransportDurableEventAdapter,
  type WebTransportReliableStream
} from "./webtransport-durable-adapter.js";

const userId = randomUUID();
const sessionId = randomUUID();
const ticketId = randomUUID();
const teamId = randomUUID();
const clientInstanceId = `lcb1.${"a".repeat(43)}`;
const subscriptionKey = `subscription.${"b".repeat(32)}`;
const cursor = `crt1.${"c".repeat(64)}`;
const admissionRecord = (
  operationFamilies: Array<
    "personal_collaboration_read" | "team_workspace_read" | "team_chat_read"
  > = ["team_workspace_read"]
) => ({
  ticketId,
  ownerUserId: userId,
  authKind: "session" as const,
  userSessionId: sessionId,
  deviceCredentialId: null,
  transport: "webtransport" as const,
  protocolVersion: COLLABORATION_CONTRACT_VERSION,
  operationFamilies,
  consumedAt: new Date().toISOString()
});
const attach = (
  overrides: Partial<WebTransportDurableAttach> = {}
): WebTransportDurableAttach => ({
  frameVersion: 1,
  type: "durable_events.attach",
  subscriptionKey,
  cursor,
  scope: "team",
  teamId,
  ...overrides
});

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

const admissionService = (
  operationFamilies: Array<
    "personal_collaboration_read" | "team_workspace_read" | "team_chat_read"
  > = ["team_workspace_read"]
) =>
  ({
    adapters: vi.fn(() => []),
    registerAdapter: vi.fn(),
    issueTicket: vi.fn(),
    consumeTicket: vi.fn(async () => admissionRecord(operationFamilies)),
    reauthenticate: vi.fn(async () => ({
      user: {
        id: userId,
        email: "user@example.test",
        displayName: "User"
      },
      operationFamilies
    }))
  }) satisfies RealtimeTransportAdmissionService;

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

describe("WebTransport durable event adapter", () => {
  it("binds admission and emits the existing durable event semantics in order", async () => {
    const pair = streamPair();
    const admission = admissionService();
    const prepareDurableStream = vi.fn(
      async (input): Promise<PreparedCollaborationRealtimeStream> => ({
        subscriptionId: randomUUID(),
        async activate(sink) {
          await sink.send("ready", JSON.stringify({ cursor: input.cursor }));
          await sink.send(
            "collaboration_event",
            JSON.stringify({ sequence: 1 }),
            input.cursor
          );
        }
      })
    );
    const adapter = createWebTransportDurableEventAdapter({
      endpoint: "https://api.example.test/v1/realtime/webtransport",
      admissionService: admission,
      prepareDurableStream
    });
    const signal = new AbortController();
    const framesPromise = readFrames(pair.client.readable, 2);
    const accepted = adapter.accept({
      stream: pair.server,
      attach: attach(),
      admission: admissionRecord(),
      clientInstanceId,
      signal: signal.signal
    });
    const session = await accepted;
    const frames = await framesPromise;

    expect(adapter.descriptor).toEqual({
      transport: "webtransport",
      protocolVersions: [COLLABORATION_CONTRACT_VERSION],
      endpoint: "https://api.example.test/v1/realtime/webtransport"
    });
    expect(prepareDurableStream).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { scope: "team", teamId },
        clientInstanceId,
        subscriptionKey,
        cursor
      })
    );
    expect(frames).toEqual([
      { event: "ready", data: JSON.stringify({ cursor }), id: null },
      {
        event: "collaboration_event",
        data: JSON.stringify({ sequence: 1 }),
        id: cursor
      }
    ]);
    await session.closed;
  });

  it("fails closed when the admitted session lacks the operation family for its scope", async () => {
    const pair = streamPair();
    const admission = admissionService(["team_chat_read"]);
    const prepareDurableStream = vi.fn();
    const adapter = createWebTransportDurableEventAdapter({
      endpoint: "https://api.example.test/v1/realtime/webtransport",
      admissionService: admission,
      prepareDurableStream
    });
    const accepted = adapter.accept({
      stream: pair.server,
      attach: attach(),
      admission: admissionRecord(["team_chat_read"]),
      clientInstanceId,
      signal: new AbortController().signal
    });

    await expect(accepted).rejects.toMatchObject({ statusCode: 401 });
    expect(admission.reauthenticate).not.toHaveBeenCalled();
    expect(prepareDurableStream).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS adapter endpoints", () => {
    expect(() =>
      createWebTransportDurableEventAdapter({
        endpoint: "http://api.example.test/v1/realtime/webtransport",
        admissionService: admissionService(),
        prepareDurableStream: vi.fn()
      })
    ).toThrow(/HTTPS/);
  });

  it("passes a fresh principal resolver into the shared stream engine", async () => {
    const pair = streamPair();
    const admission = admissionService();
    let preparedSink: CollaborationRealtimeEventSink | null = null;
    const prepareDurableStream = vi.fn(
      async (input): Promise<PreparedCollaborationRealtimeStream> => {
        await input.reauthenticate();
        return {
          subscriptionId: randomUUID(),
          async activate(sink) {
            preparedSink = sink;
          }
        };
      }
    );
    const adapter = createWebTransportDurableEventAdapter({
      endpoint: "https://api.example.test/v1/realtime/webtransport",
      admissionService: admission,
      prepareDurableStream
    });
    const accepted = adapter.accept({
      stream: pair.server,
      attach: attach(),
      admission: admissionRecord(),
      clientInstanceId,
      signal: new AbortController().signal
    });
    await accepted;

    expect(admission.reauthenticate).toHaveBeenCalledTimes(2);
    await preparedSink!.close();
  });

  it("closes the durable stream when its admitted session is aborted", async () => {
    const pair = streamPair();
    const admission = admissionService();
    const controller = new AbortController();
    const adapter = createWebTransportDurableEventAdapter({
      endpoint: "https://api.example.test/v1/realtime/webtransport",
      admissionService: admission,
      prepareDurableStream: async () => ({
        subscriptionId: randomUUID(),
        activate: async () => undefined
      })
    });
    const accepted = await adapter.accept({
      stream: pair.server,
      attach: attach(),
      admission: admissionRecord(),
      clientInstanceId,
      signal: controller.signal
    });
    controller.abort(new Error("session closed"));
    await expect(accepted.closed).resolves.toBeUndefined();
  });
});

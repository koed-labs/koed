import { randomUUID } from "node:crypto";
import { Duplex, Readable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  COLLABORATION_CONTRACT_VERSION,
  type WebTransportSessionAdmission
} from "@koed/shared";
import {
  encodeDurableRealtimeStreamFrame,
  readFirstBoundedDurableRealtimeFrame
} from "@koed/shared/durable-realtime";
import { describe, expect, it, vi } from "vitest";
import type { RealtimeTransportAdmissionService } from "./service.js";
import type { WebTransportDurableEventAdapter } from "./webtransport-durable-adapter.js";
import { startWebTransportGateway } from "./webtransport-gateway.js";

const userId = randomUUID();
const sessionId = randomUUID();
const ticketId = randomUUID();
const connectionId = randomUUID();
const teamId = randomUUID();
const clientInstanceId = `lcb1.${"a".repeat(43)}`;
const ticket = `rtt1_${ticketId}.${"b".repeat(43)}`;
const cursor = `crt1.${"c".repeat(64)}`;

const duplexPair = () => {
  class PeerDuplex extends Duplex {
    peer: PeerDuplex | null = null;
    override _read() {}
    override _write(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void
    ) {
      this.peer?.push(Buffer.from(chunk));
      callback();
    }
    override _final(callback: (error?: Error | null) => void) {
      this.peer?.push(null);
      callback();
    }
  }
  const server = new PeerDuplex();
  const client = new PeerDuplex();
  server.peer = client;
  client.peer = server;
  return {
    server,
    client,
    closeSending: () => client.end()
  };
};

const writeFrame = async (stream: Duplex, payload: unknown, end = false) => {
  await new Promise<void>((resolve, reject) => {
    stream.write(
      encodeDurableRealtimeStreamFrame(
        { event: "attach", id: null, data: JSON.stringify(payload) },
        16 * 1024
      ),
      (error) => (error ? reject(error) : resolve())
    );
  });
  if (end) stream.end();
};

const admissionRecord = {
  ticketId,
  ownerUserId: userId,
  authKind: "session" as const,
  userSessionId: sessionId,
  deviceCredentialId: null,
  transport: "webtransport" as const,
  protocolVersion: COLLABORATION_CONTRACT_VERSION,
  operationFamilies: [
    "team_workspace_read" as const,
    "managed_execution" as const
  ],
  consumedAt: new Date().toISOString()
};

const admissionService = () =>
  ({
    adapters: vi.fn(() => []),
    registerAdapter: vi.fn(() => vi.fn()),
    issueTicket: vi.fn(),
    consumeTicket: vi.fn(async () => admissionRecord),
    reauthenticate: vi.fn(async () => ({
      user: { id: userId, email: "user@example.test", displayName: "User" },
      operationFamilies: admissionRecord.operationFamilies
    }))
  }) satisfies RealtimeTransportAdmissionService;

const sessionAttach = (): WebTransportSessionAdmission => ({
  frameVersion: 1,
  type: "session.admit",
  ticket,
  connectionId,
  clientInstanceId,
  clientKind: "browser",
  nativeDeviceInstanceId: null
});

describe("WebTransport HTTP/3 gateway", () => {
  it("admits one session and multiplexes an independently bounded durable stream", async () => {
    let requestHandler:
      | ((
          request: EventEmitter & {
            url: string;
            headers: Record<string, string>;
          },
          response: {
            writeHead: ReturnType<typeof vi.fn>;
            end: ReturnType<typeof vi.fn>;
          }
        ) => void)
      | null = null;
    const close = vi.fn((callback?: () => void) => callback?.());
    const loadProvider = vi.fn(async () => ({
      createServer: vi.fn((_options, handler) => {
        requestHandler = handler as typeof requestHandler;
        return {
          listen: (_port: number, _host: string, callback: () => void) =>
            callback(),
          close,
          on: vi.fn()
        };
      })
    }));
    const admission = admissionService();
    const runtimeErrors: unknown[] = [];
    let closeDurable: () => void = () => undefined;
    const durableAdapter = {
      descriptor: {
        transport: "webtransport" as const,
        protocolVersions: [COLLABORATION_CONTRACT_VERSION] as const,
        endpoint: "https://api.example.test:3443/v1/realtime/webtransport"
      },
      accept: vi.fn(async () => ({
        subscriptionId: randomUUID(),
        closed: new Promise<void>((resolve) => {
          closeDurable = () => resolve();
        })
      }))
    } satisfies WebTransportDurableEventAdapter;
    const interactiveHandler = vi.fn(async ({ stream }) => {
      const reader = stream.readable.getReader();
      const received = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(received.value)).toBe(
        "interactive-input"
      );
      const writer = stream.writable.getWriter();
      await writer.write(new TextEncoder().encode("interactive-output"));
      await writer.close();
      writer.releaseLock();
    });
    const gateway = await startWebTransportGateway({
      endpoint: durableAdapter.descriptor.endpoint,
      listenHost: "127.0.0.1",
      listenPort: 3443,
      tlsCertificate: "certificate",
      tlsKey: "key",
      admissionService: admission,
      durableAdapter,
      interactiveHandlers: new Map([["managed_execution", interactiveHandler]]),
      maxSessions: 2,
      maxStreamsPerSession: 3,
      maxDatagramBytes: 900,
      onError: (error) => runtimeErrors.push(error),
      loadProvider
    });
    const request = Object.assign(new EventEmitter(), {
      url: "/v1/realtime/webtransport",
      headers: {
        ":protocol": "webtransport",
        origin: "https://app.example.test"
      }
    });
    const response = { writeHead: vi.fn(), end: vi.fn() };
    requestHandler!(request, response);
    expect(response.writeHead).toHaveBeenCalledWith(200, {
      "cache-control": "no-store"
    });

    const control = duplexPair();
    request.emit("stream", control.server);
    request.emit("datagram", Buffer.from("pre-admission"));
    const premature = duplexPair();
    request.emit("stream", premature.server);
    await writeFrame(control.client, sessionAttach());
    const controlReadable = Readable.toWeb(
      control.client
    ) as ReadableStream<Uint8Array>;
    const ready = await readFirstBoundedDurableRealtimeFrame({
      body: controlReadable,
      signal: new AbortController().signal,
      maxFrameBytes: 16 * 1024
    });
    expect(ready.frame.event).toBe("session_ready");
    expect(admission.consumeTicket).toHaveBeenCalledWith({
      ticket,
      transport: "webtransport",
      protocolVersion: COLLABORATION_CONTRACT_VERSION,
      clientInstanceId,
      clientKind: "browser",
      origin: "https://app.example.test",
      nativeDeviceInstanceId: null,
      connectionId
    });
    request.emit("datagram", Buffer.alloc(901));
    request.emit("datagram", Buffer.from("{"));
    request.emit(
      "datagram",
      Buffer.from(
        JSON.stringify({
          frameVersion: 1,
          type: "disposable_hint",
          channel: "typing",
          sequence: 1,
          resourceId: randomUUID(),
          payload: "active"
        })
      )
    );
    expect(gateway.inspect()).toMatchObject({
      streamsRejected: 1,
      datagramsDroppedUnauthenticated: 1,
      datagramsDroppedOversized: 1,
      datagramsDroppedInvalid: 1,
      datagramsDroppedUnsupported: 1
    });

    const durable = duplexPair();
    request.emit("stream", durable.server);
    await writeFrame(
      durable.client,
      {
        frameVersion: 1,
        type: "durable_events.attach",
        subscriptionKey: `subscription.${"d".repeat(32)}`,
        cursor,
        scope: "team",
        teamId
      },
      false
    );
    durable.closeSending();
    await vi.waitFor(() => {
      if (runtimeErrors.length > 0) throw runtimeErrors[0];
      expect(durableAdapter.accept).toHaveBeenCalledOnce();
    });
    expect(gateway.inspect()).toMatchObject({
      sessionsAccepted: 1,
      sessionsActive: 1,
      streamsAccepted: 1,
      durableStreamsAccepted: 1,
      streamsActive: 1
    });

    const interactive = duplexPair();
    request.emit("stream", interactive.server);
    await writeFrame(interactive.client, {
      frameVersion: 1,
      type: "interactive.attach",
      channel: "managed_execution",
      operationFamily: "managed_execution",
      resourceId: randomUUID()
    });
    interactive.client.write("interactive-input");
    interactive.closeSending();
    await vi.waitFor(() => expect(interactiveHandler).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(gateway.inspect()).toMatchObject({
        interactiveStreamsAccepted: 1,
        streamsAccepted: 2
      })
    );
    closeDurable();
    await gateway.close();
    expect(gateway.inspect().sessionsActive).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not advertise or accept malformed paths through the provider adapter", async () => {
    let requestHandler: ((request: unknown, response: unknown) => void) | null =
      null;
    const gateway = await startWebTransportGateway({
      endpoint: "https://api.example.test:3443/v1/realtime/webtransport",
      listenHost: "127.0.0.1",
      listenPort: 3443,
      tlsCertificate: "certificate",
      tlsKey: "key",
      admissionService: admissionService(),
      durableAdapter: {
        descriptor: {
          transport: "webtransport",
          protocolVersions: [COLLABORATION_CONTRACT_VERSION],
          endpoint: "https://api.example.test:3443/v1/realtime/webtransport"
        },
        accept: vi.fn()
      },
      maxSessions: 1,
      maxStreamsPerSession: 1,
      maxDatagramBytes: 900,
      loadProvider: async () => ({
        createServer: (_options, handler) => {
          requestHandler = handler as typeof requestHandler;
          return {
            listen: (_port, _host, callback) => callback(),
            close: (callback) => callback?.(),
            on: vi.fn()
          };
        }
      })
    });
    const response = { writeHead: vi.fn(), end: vi.fn() };
    requestHandler!(
      Object.assign(new EventEmitter(), {
        url: "/wrong",
        headers: { ":protocol": "webtransport" }
      }),
      response
    );
    expect(response.writeHead).toHaveBeenCalledWith(404);
    expect(response.end).toHaveBeenCalledOnce();
    expect(gateway.inspect().sessionsAccepted).toBe(0);
    await gateway.close();
  });

  it("bounds pending sessions and releases their capacity after failed admission", async () => {
    let requestHandler:
      | ((
          request: EventEmitter & {
            url: string;
            headers: Record<string, string>;
          },
          response: {
            writeHead: ReturnType<typeof vi.fn>;
            end: ReturnType<typeof vi.fn>;
          }
        ) => void)
      | null = null;
    const admission = admissionService();
    const gateway = await startWebTransportGateway({
      endpoint: "https://api.example.test:3443/v1/realtime/webtransport",
      listenHost: "127.0.0.1",
      listenPort: 3443,
      tlsCertificate: "certificate",
      tlsKey: "key",
      admissionService: admission,
      durableAdapter: {
        descriptor: {
          transport: "webtransport",
          protocolVersions: [COLLABORATION_CONTRACT_VERSION],
          endpoint: "https://api.example.test:3443/v1/realtime/webtransport"
        },
        accept: vi.fn()
      },
      maxSessions: 1,
      maxStreamsPerSession: 1,
      maxDatagramBytes: 900,
      attachTimeoutMs: 100,
      loadProvider: async () => ({
        createServer: (_options, handler) => {
          requestHandler = handler as typeof requestHandler;
          return {
            listen: (_port, _host, callback) => callback(),
            close: (callback) => callback?.(),
            on: vi.fn()
          };
        }
      })
    });
    const request = () =>
      Object.assign(new EventEmitter(), {
        url: "/v1/realtime/webtransport",
        headers: { ":protocol": "webtransport" }
      });
    const response = () => ({ writeHead: vi.fn(), end: vi.fn() });

    const malformedRequest = request();
    const malformedResponse = response();
    requestHandler!(malformedRequest, malformedResponse);

    const capacityResponse = response();
    requestHandler!(request(), capacityResponse);
    expect(capacityResponse.writeHead).toHaveBeenCalledWith(503);

    const malformedControl = duplexPair();
    malformedRequest.emit("stream", malformedControl.server);
    await writeFrame(malformedControl.client, {
      ...sessionAttach(),
      unexpected: true
    });
    await vi.waitFor(() => expect(malformedResponse.end).toHaveBeenCalled());
    expect(admission.consumeTicket).not.toHaveBeenCalled();

    const idleResponse = response();
    requestHandler!(request(), idleResponse);
    expect(idleResponse.writeHead).toHaveBeenCalledWith(200, {
      "cache-control": "no-store"
    });
    await vi.waitFor(() => expect(idleResponse.end).toHaveBeenCalled());

    expect(gateway.inspect()).toMatchObject({
      sessionsAccepted: 0,
      sessionsRejected: 3,
      sessionsActive: 0
    });
    await gateway.close();
  });

  it("closes the provider when its UDP listener cannot start", async () => {
    const close = vi.fn((callback?: () => void) => callback?.());
    const bindError = new Error("UDP bind failed");
    let onError: ((error: Error) => void) | null = null;

    await expect(
      startWebTransportGateway({
        endpoint: "https://api.example.test:3443/v1/realtime/webtransport",
        listenHost: "127.0.0.1",
        listenPort: 3443,
        tlsCertificate: "certificate",
        tlsKey: "key",
        admissionService: admissionService(),
        durableAdapter: {
          descriptor: {
            transport: "webtransport",
            protocolVersions: [COLLABORATION_CONTRACT_VERSION],
            endpoint: "https://api.example.test:3443/v1/realtime/webtransport"
          },
          accept: vi.fn()
        },
        maxSessions: 1,
        maxStreamsPerSession: 1,
        maxDatagramBytes: 900,
        loadProvider: async () => ({
          createServer: () => ({
            listen: () => onError?.(bindError),
            close,
            on: (_event, listener) => {
              onError = listener;
            }
          })
        })
      })
    ).rejects.toBe(bindError);
    expect(close).toHaveBeenCalledOnce();
  });
});

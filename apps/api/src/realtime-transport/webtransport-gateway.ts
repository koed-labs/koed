import type { Duplex } from "node:stream";
import { Readable, Writable } from "node:stream";
import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_RENDERER_MAX_PENDING_BYTES,
  webTransportDisposableDatagramSchema,
  webTransportDurableAttachSchema,
  webTransportInteractiveAttachSchema,
  webTransportSessionAdmissionSchema,
  type WebTransportInteractiveAttach
} from "@koed/shared";
import {
  encodeDurableRealtimeStreamFrame,
  readFirstBoundedDurableRealtimeFrame
} from "@koed/shared/durable-realtime";
import type { RealtimeTransportAdmissionRecord } from "@koed/db";
import type { CollaborationRealtimeTransportPrincipal } from "../collaboration/index.js";
import type { RealtimeTransportAdmissionService } from "./service.js";
import type {
  WebTransportDurableEventAdapter,
  WebTransportReliableStream
} from "./webtransport-durable-adapter.js";

const attachFrameMaxBytes = 16 * 1024;
const defaultAttachTimeoutMs = 5_000;

interface QuicoRequest {
  url: string | null;
  headers: Record<string, string | string[] | undefined>;
  on(event: "stream", listener: (stream: Duplex) => void): void;
  on(event: "datagram", listener: (data: Buffer) => void): void;
}

interface QuicoResponse {
  writeHead(statusCode: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

interface QuicoServer {
  listen(port: number, host: string, callback: () => void): void;
  close(callback?: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface WebTransportGatewayMetrics {
  sessionsAccepted: number;
  sessionsRejected: number;
  sessionsActive: number;
  streamsAccepted: number;
  streamsRejected: number;
  streamsActive: number;
  durableStreamsAccepted: number;
  interactiveStreamsAccepted: number;
  datagramsDroppedUnauthenticated: number;
  datagramsDroppedOversized: number;
  datagramsDroppedUnsupported: number;
  datagramsDroppedInvalid: number;
}

export interface WebTransportInteractiveStreamHandlerInput {
  attach: WebTransportInteractiveAttach;
  stream: WebTransportReliableStream;
  admission: RealtimeTransportAdmissionRecord;
  principal: CollaborationRealtimeTransportPrincipal;
  reauthenticate: () => Promise<CollaborationRealtimeTransportPrincipal>;
  signal: AbortSignal;
}

export type WebTransportInteractiveStreamHandler = (
  input: WebTransportInteractiveStreamHandlerInput
) => Promise<void>;

export interface WebTransportGateway {
  descriptor: WebTransportDurableEventAdapter["descriptor"];
  inspect(): WebTransportGatewayMetrics;
  close(): Promise<void>;
}

export interface WebTransportGatewayOptions {
  endpoint: string;
  listenHost: string;
  listenPort: number;
  tlsKey: string | Buffer;
  tlsCertificate: string | Buffer;
  admissionService: RealtimeTransportAdmissionService;
  durableAdapter: WebTransportDurableEventAdapter;
  interactiveHandlers?: ReadonlyMap<
    WebTransportInteractiveAttach["channel"],
    WebTransportInteractiveStreamHandler
  >;
  maxSessions: number;
  maxStreamsPerSession: number;
  maxDatagramBytes: number;
  attachTimeoutMs?: number;
  onError?: (
    error: unknown,
    context: "runtime_provider" | "session_admission" | "application_stream"
  ) => void;
  loadProvider?: () => Promise<{
    createServer(
      options: {
        key: string | Buffer;
        cert: string | Buffer;
        maxConnections: number;
      },
      handler: (request: QuicoRequest, response: QuicoResponse) => void
    ): QuicoServer;
  }>;
}

const streamPair = (stream: Duplex): WebTransportReliableStream => ({
  readable: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
  writable: Writable.toWeb(stream) as WritableStream<Uint8Array>
});

const parseAttachFrame = async (
  readable: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  timeoutMs: number
) => {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("WebTransport attach timed out")),
    timeoutMs
  );
  timer.unref?.();
  try {
    const first = await readFirstBoundedDurableRealtimeFrame({
      body: readable,
      signal: controller.signal,
      maxFrameBytes: attachFrameMaxBytes,
      maxInitialRemainderBytes: attachFrameMaxBytes
    });
    if (first.frame.event !== "attach" || first.frame.id !== null) {
      throw new Error("WebTransport attach is invalid");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(first.frame.data);
    } catch {
      throw new Error("WebTransport attach is invalid");
    }
    return { payload, remainder: first.remainder };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
};

const requireEnded = async (readable: ReadableStream<Uint8Array>) => {
  const reader = readable.getReader();
  let ended = false;
  try {
    const next = await reader.read();
    if (!next.done) throw new Error("WebTransport attach stream is invalid");
    ended = true;
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

const principalFor = async (
  admissionService: RealtimeTransportAdmissionService,
  admission: RealtimeTransportAdmissionRecord
): Promise<CollaborationRealtimeTransportPrincipal> => {
  const state = await admissionService.reauthenticate(admission);
  return {
    user: state.user,
    deviceCredentialId: admission.deviceCredentialId,
    operationFamilies:
      state.operationFamilies === null ? null : new Set(state.operationFamilies)
  };
};

const closeServer = (server: QuicoServer) =>
  new Promise<void>((resolve) => server.close(resolve));

const validatePositiveBound = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
};

export const startWebTransportGateway = async (
  options: WebTransportGatewayOptions
): Promise<WebTransportGateway> => {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  ) {
    throw new TypeError("WebTransport endpoint must be a canonical HTTPS URL");
  }
  const maxSessions = validatePositiveBound(options.maxSessions, "maxSessions");
  const maxStreamsPerSession = validatePositiveBound(
    options.maxStreamsPerSession,
    "maxStreamsPerSession"
  );
  const maxDatagramBytes = Math.min(
    validatePositiveBound(options.maxDatagramBytes, "maxDatagramBytes"),
    1_200
  );
  const attachTimeoutMs = Math.min(
    validatePositiveBound(
      options.attachTimeoutMs ?? defaultAttachTimeoutMs,
      "attachTimeoutMs"
    ),
    defaultAttachTimeoutMs
  );
  const metrics: WebTransportGatewayMetrics = {
    sessionsAccepted: 0,
    sessionsRejected: 0,
    sessionsActive: 0,
    streamsAccepted: 0,
    streamsRejected: 0,
    streamsActive: 0,
    durableStreamsAccepted: 0,
    interactiveStreamsAccepted: 0,
    datagramsDroppedUnauthenticated: 0,
    datagramsDroppedOversized: 0,
    datagramsDroppedUnsupported: 0,
    datagramsDroppedInvalid: 0
  };
  const sessionControllers = new Set<AbortController>();
  const loadProvider =
    options.loadProvider ??
    (async () => {
      const provider = await import("quico");
      return provider.default;
    });
  const provider = await loadProvider();
  const server = provider.createServer(
    {
      key: options.tlsKey,
      cert: options.tlsCertificate,
      maxConnections: maxSessions
    },
    (request, response) => {
      if (
        request.headers[":protocol"] !== "webtransport" ||
        request.url !== endpoint.pathname
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (sessionControllers.size >= maxSessions) {
        metrics.sessionsRejected += 1;
        response.writeHead(503);
        response.end();
        return;
      }
      response.writeHead(200, { "cache-control": "no-store" });

      const sessionController = new AbortController();
      sessionControllers.add(sessionController);
      let admission: RealtimeTransportAdmissionRecord | null = null;
      let clientInstanceId: string | null = null;
      let controlAssigned = false;
      let activeStreams = 0;
      let sessionCounted = false;
      const admissionTimer = setTimeout(() => {
        if (admission) return;
        metrics.sessionsRejected += 1;
        finishSession();
      }, attachTimeoutMs);
      admissionTimer.unref?.();
      const originHeader = request.headers.origin;
      const origin =
        typeof originHeader === "string" && originHeader.trim()
          ? originHeader.trim()
          : null;

      const rejectStream = async (stream: WebTransportReliableStream) => {
        metrics.streamsRejected += 1;
        try {
          const writer = stream.writable.getWriter();
          await writer
            .abort(new Error("WebTransport stream rejected"))
            .catch(() => undefined);
          writer.releaseLock();
        } catch {
          // The stream owner already holds or closed the writer.
        }
      };

      const finishSession = () => {
        if (sessionController.signal.aborted) return;
        clearTimeout(admissionTimer);
        sessionController.abort(new Error("WebTransport session closed"));
        if (sessionCounted) {
          metrics.sessionsActive -= 1;
          sessionCounted = false;
        }
        sessionControllers.delete(sessionController);
        response.end();
      };

      const handleControlStream = async (
        stream: WebTransportReliableStream
      ) => {
        const parsed = await parseAttachFrame(
          stream.readable,
          sessionController.signal,
          attachTimeoutMs
        );
        const attach = webTransportSessionAdmissionSchema.parse(parsed.payload);
        const admitted = await options.admissionService.consumeTicket({
          ticket: attach.ticket,
          transport: "webtransport",
          protocolVersion: COLLABORATION_CONTRACT_VERSION,
          clientInstanceId: attach.clientInstanceId,
          clientKind: attach.clientKind,
          origin,
          nativeDeviceInstanceId: attach.nativeDeviceInstanceId,
          connectionId: attach.connectionId
        });
        await options.admissionService.reauthenticate(admitted);
        admission = admitted;
        clientInstanceId = attach.clientInstanceId;
        clearTimeout(admissionTimer);
        metrics.sessionsAccepted += 1;
        metrics.sessionsActive += 1;
        sessionCounted = true;

        const writer = stream.writable.getWriter();
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        try {
          await writer.write(
            encodeDurableRealtimeStreamFrame(
              {
                event: "session_ready",
                id: null,
                data: JSON.stringify({
                  protocolVersion: COLLABORATION_CONTRACT_VERSION,
                  operationFamilies: admitted.operationFamilies
                })
              },
              COLLABORATION_RENDERER_MAX_PENDING_BYTES
            )
          );
          reader = parsed.remainder.getReader();
          const next = await reader.read();
          if (!next.done)
            throw new Error("WebTransport control stream is invalid");
        } finally {
          await reader?.cancel().catch(() => undefined);
          reader?.releaseLock();
          await writer.close().catch(() => undefined);
          writer.releaseLock();
          finishSession();
        }
      };

      const handleApplicationStream = async (
        stream: WebTransportReliableStream,
        admitted: RealtimeTransportAdmissionRecord,
        admittedClientInstanceId: string
      ) => {
        if (activeStreams >= maxStreamsPerSession) {
          await rejectStream(stream);
          return;
        }
        activeStreams += 1;
        metrics.streamsActive += 1;
        try {
          const parsed = await parseAttachFrame(
            stream.readable,
            sessionController.signal,
            attachTimeoutMs
          );
          if (
            typeof parsed.payload === "object" &&
            parsed.payload !== null &&
            "type" in parsed.payload &&
            parsed.payload.type === "durable_events.attach"
          ) {
            const attach = webTransportDurableAttachSchema.parse(
              parsed.payload
            );
            const inputEnded = requireEnded(parsed.remainder);
            metrics.streamsAccepted += 1;
            metrics.durableStreamsAccepted += 1;
            const accepted = await options.durableAdapter.accept({
              stream,
              attach,
              admission: admitted,
              clientInstanceId: admittedClientInstanceId,
              signal: sessionController.signal
            });
            await inputEnded;
            await accepted.closed;
            return;
          }
          const attach = webTransportInteractiveAttachSchema.parse(
            parsed.payload
          );
          if (!admitted.operationFamilies.includes(attach.operationFamily)) {
            throw new Error("Transport admission failed");
          }
          const handler = options.interactiveHandlers?.get(attach.channel);
          if (!handler) throw new Error("Interactive stream is unavailable");
          const reauthenticate = () =>
            principalFor(options.admissionService, admitted);
          const principal = await reauthenticate();
          metrics.streamsAccepted += 1;
          metrics.interactiveStreamsAccepted += 1;
          await handler({
            attach,
            stream: { ...stream, readable: parsed.remainder },
            admission: admitted,
            principal,
            reauthenticate,
            signal: sessionController.signal
          });
        } catch (error) {
          await rejectStream(stream);
          throw error;
        } finally {
          activeStreams -= 1;
          metrics.streamsActive -= 1;
        }
      };

      request.on("stream", (nodeStream) => {
        const stream = streamPair(nodeStream);
        if (!controlAssigned) {
          controlAssigned = true;
          void handleControlStream(stream).catch((error) => {
            options.onError?.(error, "session_admission");
            if (!sessionController.signal.aborted) {
              metrics.sessionsRejected += 1;
            }
            finishSession();
          });
          return;
        }
        if (
          !admission ||
          !clientInstanceId ||
          sessionController.signal.aborted
        ) {
          void rejectStream(stream);
          return;
        }
        void handleApplicationStream(stream, admission, clientInstanceId).catch(
          (error) => options.onError?.(error, "application_stream")
        );
      });

      request.on("datagram", (data) => {
        if (!admission) {
          metrics.datagramsDroppedUnauthenticated += 1;
          return;
        }
        if (data.byteLength > maxDatagramBytes) {
          metrics.datagramsDroppedOversized += 1;
          return;
        }
        try {
          webTransportDisposableDatagramSchema.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data))
          );
          metrics.datagramsDroppedUnsupported += 1;
        } catch {
          metrics.datagramsDroppedInvalid += 1;
        }
      });
    }
  );

  try {
    await new Promise<void>((resolve, reject) => {
      let listening = false;
      const onError = (error: Error) => {
        if (!listening) reject(error);
        else options.onError?.(error, "runtime_provider");
      };
      server.on("error", onError);
      server.listen(options.listenPort, options.listenHost, () => {
        listening = true;
        resolve();
      });
    });
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    throw error;
  }

  return {
    descriptor: options.durableAdapter.descriptor,
    inspect: () => ({ ...metrics }),
    async close() {
      for (const controller of sessionControllers) {
        controller.abort(new Error("WebTransport gateway stopped"));
      }
      sessionControllers.clear();
      metrics.sessionsActive = 0;
      metrics.streamsActive = 0;
      await closeServer(server);
    }
  };
};

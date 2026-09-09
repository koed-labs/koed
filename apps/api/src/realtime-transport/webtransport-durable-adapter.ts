import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_RENDERER_MAX_PENDING_BYTES,
  webTransportDurableAttachSchema,
  type RealtimeTransportOperationFamily,
  type WebTransportDurableAttach
} from "@koed/shared";
import type { RealtimeTransportAdmissionRecord } from "@koed/db";
import { encodeDurableRealtimeStreamFrame } from "@koed/shared/durable-realtime";
import type {
  CollaborationRealtimeEventSink,
  CollaborationRealtimeTransportPrincipal,
  PreparedCollaborationRealtimeStream
} from "../collaboration/index.js";
import type { RealtimeTransportAdmissionService } from "./service.js";

export interface WebTransportReliableStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface WebTransportDurableStreamInput {
  stream: WebTransportReliableStream;
  attach: WebTransportDurableAttach;
  admission: RealtimeTransportAdmissionRecord;
  clientInstanceId: string;
  signal: AbortSignal;
}

export interface WebTransportDurableSession {
  subscriptionId: string;
  closed: Promise<void>;
}

export interface WebTransportDurableEventAdapter {
  descriptor: {
    transport: "webtransport";
    protocolVersions: readonly [typeof COLLABORATION_CONTRACT_VERSION];
    endpoint: string;
  };
  accept(
    input: WebTransportDurableStreamInput
  ): Promise<WebTransportDurableSession>;
}

type RealtimeStreamPreparer = (input: {
  principal: CollaborationRealtimeTransportPrincipal;
  scope: { scope: "personal" } | { scope: "team"; teamId: string };
  clientInstanceId: string;
  subscriptionKey: string;
  cursor: string;
  reauthenticate: () => Promise<CollaborationRealtimeTransportPrincipal>;
}) => Promise<PreparedCollaborationRealtimeStream>;

const requiredOperationFamily = (
  scope: "personal" | "team"
): RealtimeTransportOperationFamily =>
  scope === "personal" ? "personal_collaboration_read" : "team_workspace_read";

const createEventSink = (
  stream: WebTransportReliableStream,
  maxFrameBytes: number,
  signal: AbortSignal
): CollaborationRealtimeEventSink & { closed: Promise<void> } => {
  const writer = stream.writable.getWriter();
  const listeners = new Set<() => void>();
  let settled = false;
  let tail = Promise.resolve();
  const abort = () => {
    void writer.abort(signal.reason).catch(() => undefined);
  };
  const notifyClosed = () => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", abort);
    for (const listener of listeners) listener();
    listeners.clear();
  };
  const closed = writer.closed.then(notifyClosed, notifyClosed);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  return {
    closed,
    send(event, serializedPayload, id) {
      if (settled)
        return Promise.reject(new Error("WebTransport stream closed"));
      const encoded = encodeDurableRealtimeStreamFrame(
        { event, data: serializedPayload, id: id ?? null },
        maxFrameBytes
      );
      const pending = tail.then(() => writer.write(encoded));
      tail = pending.catch(() => undefined);
      return pending;
    },
    async close() {
      if (settled) return;
      const pending = tail.then(() => writer.close());
      tail = pending.catch(() => undefined);
      await pending.finally(notifyClosed);
    },
    onClose(listener) {
      if (settled) {
        listener();
        return;
      }
      listeners.add(listener);
    }
  };
};

export const createWebTransportDurableEventAdapter = (options: {
  endpoint: string;
  admissionService: RealtimeTransportAdmissionService;
  prepareDurableStream: RealtimeStreamPreparer;
  maxFrameBytes?: number;
}): WebTransportDurableEventAdapter => {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  ) {
    throw new TypeError("WebTransport endpoint must be an HTTPS URL");
  }
  const maxFrameBytes = Math.min(
    Math.max(
      Math.trunc(
        options.maxFrameBytes ?? COLLABORATION_RENDERER_MAX_PENDING_BYTES
      ),
      1
    ),
    COLLABORATION_RENDERER_MAX_PENDING_BYTES
  );
  return {
    descriptor: {
      transport: "webtransport",
      protocolVersions: [COLLABORATION_CONTRACT_VERSION],
      endpoint: endpoint.toString()
    },
    async accept(input) {
      if (input.signal.aborted) {
        throw Object.assign(new Error("Transport admission failed"), {
          statusCode: 401
        });
      }
      const attach = webTransportDurableAttachSchema.parse(input.attach);
      const operationFamily = requiredOperationFamily(attach.scope);
      if (!input.admission.operationFamilies.includes(operationFamily)) {
        throw Object.assign(new Error("Transport admission failed"), {
          statusCode: 401
        });
      }
      const reauthenticate =
        async (): Promise<CollaborationRealtimeTransportPrincipal> => {
          const state = await options.admissionService.reauthenticate(
            input.admission
          );
          return {
            user: state.user,
            deviceCredentialId: input.admission.deviceCredentialId,
            operationFamilies:
              state.operationFamilies === null
                ? null
                : new Set(state.operationFamilies)
          };
        };
      const principal = await reauthenticate();
      const prepared = await options.prepareDurableStream({
        principal,
        scope:
          attach.scope === "personal"
            ? { scope: "personal" }
            : { scope: "team", teamId: attach.teamId },
        clientInstanceId: input.clientInstanceId,
        subscriptionKey: attach.subscriptionKey,
        cursor: attach.cursor,
        reauthenticate
      });
      if (input.signal.aborted) {
        throw Object.assign(new Error("Transport admission failed"), {
          statusCode: 401
        });
      }
      const sink = createEventSink(input.stream, maxFrameBytes, input.signal);
      await prepared.activate(sink);
      return { subscriptionId: prepared.subscriptionId, closed: sink.closed };
    }
  };
};

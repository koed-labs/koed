import { randomUUID } from "node:crypto";
import {
  controlReplySchema,
  LOCAL_CONTROL_PROTOCOL_VERSION,
  type ControlCommand,
  type ControlReply
} from "@koed-labs/shared/local-control-protocol";
import { resolveProcessIdentity } from "../supervisor-lock.js";
import type { ControlDiscovery } from "./discovery.js";
import { validateControlHello } from "./handshake.js";
import type { ControlTransport } from "./transport.js";

const timeoutMs = 120_000;
const maxPending = 64;
export interface ControlClient {
  request(
    command: ControlCommand,
    expectedRevision: number
  ): Promise<ControlReply>;
  close(): void;
  onClose?(listener: (error: Error) => void): () => void;
}

export async function connectControlClient(input: {
  transport: ControlTransport;
  discovery: ControlDiscovery;
  localPid?: number;
  localProcessIdentity?: string;
  resolvePeerIdentity?: (pid: number) => string | null;
}): Promise<ControlClient> {
  const connection = await input.transport.connect(input.discovery.socketPath);
  const localPid = input.localPid ?? process.pid;
  const localIdentity =
    input.localProcessIdentity ?? resolveProcessIdentity(localPid);
  if (!localIdentity) {
    connection.close();
    throw new Error("Control client identity unavailable");
  }
  const nonce = randomUUID();
  const { discovery } = input;
  const pending = new Map<
    string,
    {
      resolve(value: ControlReply): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let authenticated = false;
  let closed = false;
  const closeListeners = new Set<(error: Error) => void>();
  let resolveHello!: () => void;
  let rejectHello!: (error: Error) => void;
  const helloPromise = new Promise<void>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  // A connection may close while the initial send is still pending.
  void helloPromise.catch(() => {});
  const close = (error = new Error("Control connection closed")) => {
    if (closed) return;
    closed = true;
    clearTimeout(helloTimeout);
    if (!authenticated) rejectHello(error);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    connection.close();
    for (const listener of closeListeners) listener(error);
    closeListeners.clear();
  };
  const helloTimeout = setTimeout(
    () => close(new Error("Control hello timed out")),
    timeoutMs
  );
  connection.onClose((error) =>
    close(new Error(error ?? "Control connection closed"))
  );
  connection.onEnd(() => close(new Error("Control connection ended")));
  connection.onMessage((message) => {
    try {
      const value: unknown = JSON.parse(message);
      if (!authenticated) {
        const identity = (input.resolvePeerIdentity ?? resolveProcessIdentity)(
          connection.peer.pid
        );
        if (!identity || identity !== discovery.processIdentity)
          throw new Error("Control server identity mismatch");
        validateControlHello(
          value,
          {
            home: discovery.home,
            installationId: discovery.installationId,
            productVersion: discovery.productVersion,
            instanceId: discovery.instanceId,
            pid: discovery.pid,
            processIdentity: identity,
            nonce
          },
          connection.peer
        );
        authenticated = true;
        clearTimeout(helloTimeout);
        resolveHello();
        return;
      }
      const reply = controlReplySchema.parse(value);
      if (reply.snapshot.instanceId !== discovery.instanceId)
        throw new Error("Control response instance mismatch");
      const item = pending.get(reply.requestId);
      if (!item) return;
      pending.delete(reply.requestId);
      clearTimeout(item.timer);
      item.resolve(reply);
    } catch (error) {
      close(error instanceof Error ? error : new Error(String(error)));
    }
  });
  try {
    await connection.send(
      JSON.stringify({
        protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
        home: discovery.home,
        installationId: discovery.installationId,
        productVersion: discovery.productVersion,
        instanceId: discovery.instanceId,
        pid: localPid,
        processIdentity: localIdentity,
        nonce
      })
    );
    await helloPromise;
    if (closed) throw new Error("Control connection closed during handshake");
  } catch (error) {
    close(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  return {
    request(command, expectedRevision) {
      if (closed) return Promise.reject(new Error("Control connection closed"));
      if (pending.size >= maxPending)
        return Promise.reject(new Error("Too many control requests"));
      const requestId = randomUUID();
      return new Promise<ControlReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(
            new Error(
              "Control request timed out; inspect status before retrying"
            )
          );
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        void connection
          .send(
            JSON.stringify({
              requestId,
              instanceId: discovery.instanceId,
              expectedRevision,
              command
            })
          )
          .catch((error: unknown) => {
            const item = pending.get(requestId);
            if (item) {
              pending.delete(requestId);
              clearTimeout(item.timer);
              item.reject(
                error instanceof Error ? error : new Error(String(error))
              );
            }
          });
      });
    },
    close: () => close(),
    onClose(listener) {
      if (closed) {
        listener(new Error("Control connection closed"));
        return () => {};
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    }
  };
}

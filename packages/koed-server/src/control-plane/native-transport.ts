import type { AuthenticatedControlPeer } from "./handshake.js";
import type {
  ControlConnection,
  ControlListener,
  ControlTransport
} from "./transport.js";

/** Low-level binding owns descriptors and authenticates peers before returning them. */
export interface NativeLocalControl {
  listen(path: string): unknown;
  accept(listener: unknown): unknown | null;
  connect(path: string): unknown;
  finishConnect(connection: unknown): AuthenticatedControlPeer | null;
  read(connection: unknown): {
    messages: string[];
    more: boolean;
    eof: boolean;
  };
  write(connection: unknown, message: string): void;
  flush(connection: unknown): boolean;
  close(handle: unknown): void;
}
const pollMs = 20;
const connectTimeoutMs = 10_000;
const writeTimeoutMs = 10_000;
const maxConnections = 16;
const maxPending = 64;

function connectionFromNative(
  native: NativeLocalControl,
  handle: unknown,
  peer: AuthenticatedControlPeer
): ControlConnection {
  let closed = false;
  let ended = false;
  const messageListeners = new Set<(message: string) => void>();
  const endListeners = new Set<() => void>();
  const closeListeners = new Set<(error?: string) => void>();
  const buffered: string[] = [];
  const sends: {
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  let endTimeout: ReturnType<typeof setTimeout> | undefined;
  const close = (reason?: string) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (endTimeout) clearTimeout(endTimeout);
    try {
      native.close(handle);
    } finally {
      const error = new Error(reason ?? "Local control connection closed");
      sends.splice(0).forEach((send) => {
        clearTimeout(send.timer);
        send.reject(error);
      });
      closeListeners.forEach((listener) => listener(reason));
    }
  };
  const flush = () => {
    if (sends.length && native.flush(handle))
      sends.splice(0).forEach((send) => {
        clearTimeout(send.timer);
        send.resolve();
      });
  };
  const poll = () => {
    if (closed) return;
    try {
      flush();
      if (ended) return;
      const result = native.read(handle);
      for (const message of result.messages) {
        if (messageListeners.size)
          messageListeners.forEach((listener) => listener(message));
        else if (buffered.length < maxPending) buffered.push(message);
        else throw new Error("Local control receive queue is full");
      }
      if (result.eof) {
        ended = true;
        if (endListeners.size) endListeners.forEach((listener) => listener());
        else
          endTimeout = setTimeout(
            () => close("Local control input ended"),
            writeTimeoutMs
          );
      }
    } catch (error) {
      close(error instanceof Error ? error.message : String(error));
    }
  };
  const timer = setInterval(poll, pollMs);
  return {
    peer,
    send(message) {
      if (closed)
        return Promise.reject(new Error("Local control connection closed"));
      if (sends.length >= maxPending)
        return Promise.reject(new Error("Local control send queue is full"));
      return new Promise<void>((resolve, reject) => {
        try {
          native.write(handle, message);
          const timer = setTimeout(
            () => close("Local control write timed out"),
            writeTimeoutMs
          );
          sends.push({ resolve, reject, timer });
          flush();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          close(error instanceof Error ? error.message : String(error));
        }
      });
    },
    onMessage(listener) {
      messageListeners.add(listener);
      buffered.splice(0).forEach(listener);
      return () => messageListeners.delete(listener);
    },
    onEnd(listener) {
      if (ended) {
        if (endTimeout) clearTimeout(endTimeout);
        queueMicrotask(listener);
      } else endListeners.add(listener);
      return () => endListeners.delete(listener);
    },
    onClose(listener) {
      if (closed) queueMicrotask(() => listener());
      else closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close: () => close()
  };
}

async function connect(
  native: NativeLocalControl,
  path: string
): Promise<ControlConnection> {
  const handle = native.connect(path);
  try {
    const deadline = Date.now() + connectTimeoutMs;
    while (true) {
      const peer = native.finishConnect(handle);
      if (peer) return connectionFromNative(native, handle, peer);
      if (Date.now() >= deadline)
        throw new Error("Local control connection timed out");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } catch (error) {
    native.close(handle);
    throw error;
  }
}

function listen(
  native: NativeLocalControl,
  path: string,
  accept: (connection: ControlConnection) => void
): Promise<ControlListener> {
  const handle = native.listen(path);
  const connections = new Set<ControlConnection>();
  const errorListeners = new Set<(error: Error) => void>();
  let closed = false;
  let terminalError: Error | undefined;
  let cleanupError: Error | undefined;
  const closeHandles = (unclaimed?: unknown) => {
    closed = true;
    clearInterval(timer);
    const errors: unknown[] = [];
    const attempt = (close: () => void) => {
      try {
        close();
      } catch (error) {
        errors.push(error);
      }
    };
    if (unclaimed) attempt(() => native.close(unclaimed));
    for (const connection of connections) attempt(() => connection.close());
    connections.clear();
    attempt(() => native.close(handle));
    if (errors.length)
      cleanupError = new AggregateError(
        errors,
        "Local control listener cleanup failed"
      );
  };
  const timer = setInterval(() => {
    if (closed) return;
    let accepted: unknown | null = null;
    try {
      accepted = native.accept(handle);
      if (!accepted) return;
      if (connections.size >= maxConnections) {
        native.close(accepted);
        return;
      }
      const peer = native.finishConnect(accepted);
      if (!peer) {
        native.close(accepted);
        return;
      }
      const connection = connectionFromNative(native, accepted, peer);
      accepted = null;
      connections.add(connection);
      connection.onClose(() => connections.delete(connection));
      try {
        accept(connection);
      } catch {
        connection.close();
      }
    } catch (error) {
      closeHandles(accepted);
      terminalError = error instanceof Error ? error : new Error(String(error));
      if (cleanupError)
        terminalError = new AggregateError(
          [terminalError, cleanupError],
          "Local control listener failed"
        );
      errorListeners.forEach((listener) => listener(terminalError!));
    }
  }, pollMs);
  return Promise.resolve({
    onError(listener: (error: Error) => void) {
      if (terminalError) queueMicrotask(() => listener(terminalError!));
      else errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    close() {
      if (!closed) closeHandles();
      return cleanupError ? Promise.reject(cleanupError) : Promise.resolve();
    }
  });
}

/** Call only with the addon loaded from a verified packaged installation. */
export function createNativeControlTransport(
  native: NativeLocalControl
): ControlTransport {
  return {
    connect: (path) => connect(native, path),
    listen: (path, accept) => listen(native, path, accept)
  };
}

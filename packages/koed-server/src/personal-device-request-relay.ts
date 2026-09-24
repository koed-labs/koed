import { createHash } from "node:crypto";
import WebSocket from "ws";
import { withPaseoRelayClientLock } from "@koed/shared";

const DEFAULT_ROUTE_CONTEXT = "koed/pds-device-request/v1";
const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;

export const normalizeDeviceRequestRelayUrl = (value: string): string => {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "wss:" && !(local && url.protocol === "ws:")) ||
    url.pathname !== "/ws" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("Pairing relay URL must be a secure Paseo /ws endpoint.");
  }
  return url.toString();
};

export const paseoRelayServerId = (
  routeContext: string,
  id: string,
  token: string
): string =>
  createHash("sha256")
    .update(`${routeContext}\0${id}\0${token}`)
    .digest("base64url");

export const deviceRequestRelayId = (id: string, token: string): string =>
  paseoRelayServerId(DEFAULT_ROUTE_CONTEXT, id, token);

const socketUrl = (input: {
  relayUrl: string;
  id: string;
  token: string;
  role: "server" | "client";
  routeContext: string;
}): string => {
  const url = new URL(normalizeDeviceRequestRelayUrl(input.relayUrl));
  url.searchParams.set(
    "serverId",
    paseoRelayServerId(input.routeContext, input.id, input.token)
  );
  url.searchParams.set("role", input.role);
  return url.toString();
};

const openSocket = async (input: {
  relayUrl: string;
  id: string;
  token: string;
  role: "server" | "client";
  routeContext: string;
  maxFrameBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<WebSocket> => {
  const socket = new WebSocket(socketUrl(input), {
    maxPayload: input.maxFrameBytes,
    perMessageDeflate: false
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => fail("Pairing relay connection timed out.", true),
      input.timeoutMs
    );
    const cleanup = () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      socket.off("open", opened);
      socket.off("error", failed);
    };
    const fail = (message: string, terminate = false) => {
      cleanup();
      if (terminate) {
        socket.once("error", () => undefined);
        socket.terminate();
      }
      reject(new Error(message));
    };
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = () => fail("Pairing relay is unavailable.");
    const abort = () => fail("Pairing relay request was cancelled.", true);
    socket.once("open", opened);
    socket.once("error", failed);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
  });
  return socket;
};

export const exchangeOverPaseoRelay = async (input: {
  relayUrl: string;
  id: string;
  token: string;
  frame: string;
  routeContext: string;
  maxFrameBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> => {
  const maxFrameBytes = input.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  if (Buffer.byteLength(input.frame) > maxFrameBytes)
    throw new Error("Device request is too large.");
  const serverId = paseoRelayServerId(
    input.routeContext,
    input.id,
    input.token
  );
  return await withPaseoRelayClientLock(serverId, async () => {
    const timeoutMs = input.timeoutMs ?? 10_000;
    const socket = await openSocket({
      relayUrl: input.relayUrl,
      id: input.id,
      token: input.token,
      role: "client",
      routeContext: input.routeContext,
      maxFrameBytes,
      timeoutMs,
      signal: input.signal
    });
    try {
      return await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => fail("Device request relay timed out."),
          timeoutMs
        );
        const cleanup = () => {
          clearTimeout(timeout);
          input.signal?.removeEventListener("abort", abort);
          socket.off("message", received);
          socket.off("error", failed);
          socket.off("close", closed);
        };
        const fail = (message: string) => {
          cleanup();
          reject(new Error(message));
        };
        const received = (data: WebSocket.RawData) => {
          const response = Buffer.isBuffer(data)
            ? data.toString("utf8")
            : data.toString();
          if (Buffer.byteLength(response) > maxFrameBytes) {
            fail("Invalid device request response.");
            return;
          }
          cleanup();
          resolve(response);
        };
        const failed = () => fail("Pairing relay is unavailable.");
        const closed = () => fail("Pairing relay disconnected.");
        const abort = () => fail("Pairing relay request was cancelled.");
        socket.once("message", received);
        socket.once("error", failed);
        socket.once("close", closed);
        input.signal?.addEventListener("abort", abort, { once: true });
        socket.send(input.frame, (error) => {
          if (error) fail("Could not send device request through relay.");
        });
      });
    } finally {
      socket.close();
    }
  });
};

export const exchangeOverDeviceRequestRelay = (
  relayUrl: string,
  id: string,
  token: string,
  frame: string
): Promise<string> =>
  exchangeOverPaseoRelay({
    relayUrl,
    id,
    token,
    frame,
    routeContext: DEFAULT_ROUTE_CONTEXT,
    maxFrameBytes: 32_768
  });

export const runPaseoRelayServer = async (input: {
  relayUrl: string;
  id: string;
  token: string;
  routeContext: string;
  signal: AbortSignal;
  maxFrameBytes?: number;
  onFrame: (frame: string, signal: AbortSignal) => Promise<string>;
  onConnected?: () => void;
}): Promise<void> => {
  let retryMs = 250;
  while (!input.signal.aborted) {
    try {
      const socket = await openSocket({
        relayUrl: input.relayUrl,
        id: input.id,
        token: input.token,
        role: "server",
        routeContext: input.routeContext,
        maxFrameBytes: input.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
        timeoutMs: 10_000,
        signal: input.signal
      });
      input.onConnected?.();
      retryMs = 250;
      await serveSocket(socket, input);
    } catch {
      if (input.signal.aborted) return;
    }
    if (input.signal.aborted) return;
    await sleep(retryMs, input.signal);
    retryMs = Math.min(retryMs * 2, 5_000);
  }
};

export const runDeviceRequestRelayServer = (input: {
  relayUrl: string;
  id: string;
  token: string;
  signal: AbortSignal;
  onFrame: (frame: string) => Promise<string>;
  onConnected?: () => void;
}): Promise<void> =>
  runPaseoRelayServer({
    ...input,
    routeContext: DEFAULT_ROUTE_CONTEXT,
    maxFrameBytes: 32_768,
    onFrame: (frame) => input.onFrame(frame)
  });

const serveSocket = (
  socket: WebSocket,
  input: {
    signal: AbortSignal;
    maxFrameBytes?: number;
    onFrame: (frame: string, signal: AbortSignal) => Promise<string>;
  }
): Promise<void> =>
  new Promise((resolve) => {
    const socketAbort = new AbortController();
    let pending = Promise.resolve();
    const finish = () => {
      socketAbort.abort();
      socket.off("message", receive);
      socket.off("close", finish);
      input.signal.removeEventListener("abort", stop);
      resolve();
    };
    const stop = () => {
      socket.close();
      finish();
    };
    const receive = (data: WebSocket.RawData) => {
      pending = pending.then(async () => {
        if (input.signal.aborted || socket.readyState !== WebSocket.OPEN)
          return;
        const frame = Buffer.isBuffer(data)
          ? data.toString("utf8")
          : data.toString();
        if (
          Buffer.byteLength(frame) >
          (input.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES)
        ) {
          socket.close(1009, "Request too large");
          return;
        }
        const response = await input.onFrame(frame, socketAbort.signal);
        if (socket.readyState === WebSocket.OPEN) socket.send(response);
      });
      void pending.catch(() => socket.close(1011, "Request failed"));
    };
    socket.on("message", receive);
    socket.once("close", finish);
    input.signal.addEventListener("abort", stop, { once: true });
    if (input.signal.aborted) stop();
  });

const sleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });

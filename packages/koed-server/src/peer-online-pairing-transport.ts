import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { isIP, type Socket } from "node:net";
import { connect, createServer, type TLSSocket } from "node:tls";

// This transport authenticates possession of an invitation only. It does not
// establish pairing, identity, provenance, or authorization for later sync.
// Invitations must be delivered through a trusted, confidential channel.
// Single-use and expiry require durable admission enforcement; this raw transport
// performs no admission. CGNAT address binding does not prove Tailscale use.
const MAX_BODY = 1024 * 1024;
const MAX_CONNECTIONS = 32;
// Per listener, permit a burst of 32 connections and refill over one second.
const CONNECTION_REFILL_MS = 1000;
const MAX_TIMEOUT = 60_000;
const ALPN = "koed-pairing/1";

type Material = string | Buffer;
interface Address {
  host: string;
  port: number;
  timeoutMs: number;
}
export interface PairingServerOptions extends Address {
  cert: Material;
  key: Material;
  capability: string;
  // Cancellation is cooperative: shutdown cannot forcibly terminate a handler.
  // Do not perform admission or side effects here; handlers may outlive shutdown.
  handle: (request: Buffer, signal: AbortSignal) => Promise<Buffer>;
  onError: (error: Error) => void;
}
export interface PairingClientOptions extends Address {
  pin: string;
  capability: string;
}

function decodeSecret(value: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new Error("Invalid invitation");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value)
    throw new Error("Invalid invitation");
  return bytes;
}

function isLanAddress(host: string): boolean {
  const family = isIP(host);
  if (family === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (family !== 6) return false;
  const unscoped = host.split("%")[0];
  const canonical = new URL(`http://[${unscoped}]/`).hostname.slice(1, -1);
  if (canonical === "::1") return true;
  const first = parseInt(canonical.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;
  if (canonical.startsWith("::ffff:")) {
    const parts = canonical.slice(7).split(":");
    if (parts.length !== 2) return false;
    const high = parseInt(parts[0]!, 16);
    const low = parseInt(parts[1]!, 16);
    return isLanAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}

function validateAddress(options: Address, server: boolean): void {
  if (
    !isIP(options.host) ||
    options.host === "0.0.0.0" ||
    options.host === "::" ||
    (server && !isLanAddress(options.host)) ||
    !Number.isInteger(options.port) ||
    options.port < (server ? 0 : 1) ||
    options.port > 65535 ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > MAX_TIMEOUT
  )
    throw new Error("Invalid pairing address or timeout");
}

function frame(body: Buffer, prefix: Buffer = Buffer.alloc(0)): Buffer {
  if (!Buffer.isBuffer(body) || body.length > MAX_BODY)
    throw new Error("Pairing message too large");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([prefix, size, body]);
}

function receive(
  socket: TLSSocket,
  prefixSize: number,
  complete: (body: Buffer) => void,
  authenticate: (prefix: Buffer) => boolean = () => true
): void {
  const prefix = Buffer.alloc(prefixSize);
  const header = Buffer.alloc(4);
  let prefixBytes = 0;
  let headerBytes = 0;
  let body: Buffer | undefined;
  let bodyBytes = 0;
  let authenticated = prefixSize === 0;
  let done = false;
  socket.on("data", (chunk: Buffer) => {
    if (done) return socket.destroy();
    let offset = 0;
    if (!authenticated) {
      const count = Math.min(prefixSize - prefixBytes, chunk.length);
      chunk.copy(prefix, prefixBytes, 0, count);
      prefixBytes += count;
      offset += count;
      if (prefixBytes < prefixSize) return;
      if (!authenticate(prefix)) return socket.destroy();
      authenticated = true;
    }
    if (headerBytes < 4) {
      const count = Math.min(4 - headerBytes, chunk.length - offset);
      chunk.copy(header, headerBytes, offset, offset + count);
      headerBytes += count;
      offset += count;
      if (headerBytes < 4) return;
      const size = header.readUInt32BE();
      if (size > MAX_BODY) return socket.destroy();
      body = Buffer.alloc(size);
    }
    if (!body || chunk.length - offset > body.length - bodyBytes)
      return socket.destroy();
    chunk.copy(body, bodyBytes, offset);
    bodyBytes += chunk.length - offset;
    if (bodyBytes === body.length) {
      done = true;
      complete(body);
    }
  });
}

export async function listenPairingTransport(
  options: PairingServerOptions
): Promise<{ port: number; close: () => Promise<void> }> {
  validateAddress(options, true);
  const capability = decodeSecret(options.capability);
  if (
    !options.cert ||
    !options.key ||
    typeof options.handle !== "function" ||
    typeof options.onError !== "function"
  )
    throw new Error("Invalid pairing server options");
  const reportError = (message: string) => {
    try {
      // Callback failures may contain secrets; never propagate or log them.
      void Promise.resolve(options.onError(new Error(message))).catch(() => {});
    } catch {
      // Keep callback failures out of event handlers and promise chains.
    }
  };
  const sockets = new Set<Socket>();
  const secureSockets = new Set<TLSSocket>();
  let closing = false;
  let handlers = 0;
  let connectionTokens = MAX_CONNECTIONS;
  let lastRefill = performance.now();
  const server = createServer({
    cert: options.cert,
    key: options.key,
    requestCert: false,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    ALPNProtocols: [ALPN],
    handshakeTimeout: options.timeoutMs
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.on("connection", (socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    const now = performance.now();
    connectionTokens = Math.min(
      MAX_CONNECTIONS,
      connectionTokens +
        (Math.max(0, now - lastRefill) * MAX_CONNECTIONS) / CONNECTION_REFILL_MS
    );
    lastRefill = now;
    if (connectionTokens < 1) {
      socket.destroy();
      return;
    }
    connectionTokens--;
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), options.timeoutMs);
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  server.on("secureConnection", (socket) => {
    secureSockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), options.timeoutMs);
    socket.once("close", () => {
      clearTimeout(timer);
      secureSockets.delete(socket);
    });
    socket.on("error", () => socket.destroy());
    if (closing || socket.alpnProtocol !== ALPN) {
      socket.destroy();
      return;
    }
    const controller = new AbortController();
    socket.once("close", () => controller.abort());
    receive(
      socket,
      32,
      (body) => {
        if (handlers >= MAX_CONNECTIONS) {
          socket.destroy();
          return;
        }
        handlers++;
        Promise.resolve()
          .then(() => options.handle(body, controller.signal))
          .then((response) => {
            if (!socket.destroyed && !closing) socket.end(frame(response));
          })
          .catch(() => {
            socket.destroy();
            reportError("Pairing handler failed");
          })
          .finally(() => {
            handlers--;
          });
      },
      (provided) => timingSafeEqual(provided, capability)
    );
  });
  await new Promise<void>((resolve, reject) => {
    const onListenError = () => reject(new Error("Pairing listener failed"));
    server.once("error", onListenError);
    server.listen(options.port, options.host, () => {
      server.off("error", onListenError);
      resolve();
    });
  });
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
    reportError("Pairing listener failed");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Invalid pairing listener");
  }
  let stopped: Promise<void> | undefined;
  return {
    port: address.port,
    close: () => {
      if (stopped) return stopped;
      closing = true;
      stopped = new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error ? reject(new Error("Pairing shutdown failed")) : resolve()
        )
      );
      for (const socket of sockets) socket.destroy();
      for (const socket of secureSockets) socket.destroy();
      return stopped;
    }
  };
}

export function requestPairingTransport(
  options: PairingClientOptions,
  body: Buffer
): Promise<Buffer> {
  validateAddress(options, false);
  const pin = decodeSecret(options.pin);
  const capability = decodeSecret(options.capability);
  const request = frame(body, capability);
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: options.host,
      port: options.port,
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ALPNProtocols: [ALPN]
    });
    let settled = false;
    const finish = (error?: Error, response?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const timer = setTimeout(
      () => finish(new Error("Pairing request timed out")),
      options.timeoutMs
    );
    socket.on("error", () => finish(new Error("Pairing connection failed")));
    socket.on("close", () => finish(new Error("Pairing connection closed")));
    socket.once("secureConnect", () => {
      try {
        const raw = socket.getPeerCertificate().raw;
        if (!raw || socket.alpnProtocol !== ALPN) throw new Error();
        const spki = new X509Certificate(raw).publicKey.export({
          type: "spki",
          format: "der"
        });
        const actual = createHash("sha256").update(spki).digest();
        if (!timingSafeEqual(actual, pin)) throw new Error();
        receive(socket, 0, (response) => finish(undefined, response));
        socket.write(request);
      } catch {
        finish(new Error("Pairing server pin rejected"));
      }
    });
  });
}

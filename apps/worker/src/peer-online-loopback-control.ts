import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";

/** Store protects integrity and confidentiality from other OS users. Same-user
 * processes are trusted. publish must atomically check its signal at commit:
 * it must never publish after cancellation. clear must atomically remove only
 * the supplied record, never a replacement. No store is implemented here. */
export type DiscoveryRecord = {
  host: "127.0.0.1";
  port: number;
  capability: string;
};
export type DiscoveryStore = {
  publish(record: DiscoveryRecord, signal: AbortSignal): Promise<void>;
  read(): Promise<DiscoveryRecord | undefined>;
  clear(record: DiscoveryRecord): Promise<void>;
};
type Options = {
  timeoutMs?: number;
  maxFrameBytes?: number;
  maxConcurrency?: number;
  signal?: AbortSignal;
};
// Cancellation is cooperative. Unsettled handlers retain their concurrency slot.
type Handler = (
  request: unknown,
  signal: AbortSignal
) => unknown | Promise<unknown>;

function settings(options: Options) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxFrameBytes = options.maxFrameBytes ?? 65536;
  const maxConcurrency = options.maxConcurrency ?? 16;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000 ||
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 256 ||
    maxFrameBytes > 1048576 ||
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > 256
  )
    throw new Error("Invalid control limits");
  return { timeoutMs, maxFrameBytes, maxConcurrency };
}

async function clearDiscovery(
  store: DiscoveryStore,
  record: DiscoveryRecord,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => store.clear(record)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Discovery cleanup timed out")),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function frame(value: unknown, max: number): Buffer {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Invalid control message");
  const body = Buffer.from(text);
  if (!body.length || body.length > max)
    throw new Error("Control frame too large");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function readFrame(socket: Socket, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4);
    let headerSize = 0;
    let body: Buffer | undefined;
    let bodySize = 0;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error: Error) => {
      socket.pause();
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error("Control connection closed"));
    const onData = (chunk: Buffer) => {
      let offset = 0;
      if (headerSize < 4) {
        const count = Math.min(4 - headerSize, chunk.length);
        chunk.copy(header, headerSize, 0, count);
        headerSize += count;
        offset += count;
        if (headerSize === 4) {
          const length = header.readUInt32BE();
          if (!length || length > max)
            return fail(new Error("Invalid control frame length"));
          body = Buffer.alloc(length);
        }
      }
      if (body) {
        const count = Math.min(body.length - bodySize, chunk.length - offset);
        chunk.copy(body, bodySize, offset, offset + count);
        bodySize += count;
        offset += count;
        if (bodySize === body.length) {
          if (offset !== chunk.length)
            return fail(new Error("Trailing control data"));
          try {
            const value: unknown = JSON.parse(body.toString("utf8"));
            socket.pause();
            cleanup();
            resolve(value);
          } catch {
            fail(new Error("Invalid control JSON"));
          }
        }
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

function field(value: unknown, name: string): string {
  if (!value || typeof value !== "object" || !(name in value))
    throw new Error("Invalid control message");
  const result = (value as Record<string, unknown>)[name];
  if (typeof result !== "string" || !/^[a-f0-9]{64}$/.test(result))
    throw new Error("Invalid control proof");
  return result;
}
function mac(
  secret: Buffer,
  label: string,
  client: string,
  server: string
): Buffer {
  return createHmac("sha256", secret)
    .update(`koed-loopback-${label}-v1\0`)
    .update(Buffer.from(client, "hex"))
    .update(Buffer.from(server, "hex"))
    .digest();
}
function check(
  value: unknown,
  secret: Buffer,
  label: string,
  client: string,
  server: string
) {
  const actual = Buffer.from(field(value, "proof"), "hex");
  if (!timingSafeEqual(actual, mac(secret, label, client, server)))
    throw new Error("Control authentication failed");
}
function seal(value: unknown, key: Buffer) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Invalid control message");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("hex"),
    data: data.toString("base64"),
    tag: cipher.getAuthTag().toString("hex")
  };
}
function open(value: unknown, key: Buffer): unknown {
  if (!value || typeof value !== "object")
    throw new Error("Invalid encrypted frame");
  const { iv, data, tag } = value as Record<string, unknown>;
  if (
    typeof iv !== "string" ||
    !/^[a-f0-9]{24}$/.test(iv) ||
    typeof tag !== "string" ||
    !/^[a-f0-9]{32}$/.test(tag) ||
    typeof data !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data
    )
  )
    throw new Error("Invalid encrypted frame");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(data, "base64")),
      decipher.final()
    ]).toString("utf8")
  ) as unknown;
}

async function serverExchange(
  socket: Socket,
  secret: Buffer,
  max: number,
  admit: () => boolean
): Promise<{ request: unknown; responseKey: Buffer }> {
  const client = field(await readFrame(socket, max), "nonce");
  const server = randomBytes(32).toString("hex");
  socket.write(
    frame(
      {
        nonce: server,
        proof: mac(secret, "server", client, server).toString("hex")
      },
      max
    )
  );
  check(await readFrame(socket, max), secret, "client", client, server);
  if (!admit()) throw new Error("Control busy");
  socket.write(
    frame(
      { proof: mac(secret, "confirm", client, server).toString("hex") },
      max
    )
  );
  const request = open(
    await readFrame(socket, max),
    mac(secret, "request-key", client, server)
  );
  return { request, responseKey: mac(secret, "response-key", client, server) };
}
async function clientExchange(
  socket: Socket,
  secret: Buffer,
  request: unknown,
  max: number
): Promise<unknown> {
  const client = randomBytes(32).toString("hex");
  socket.write(frame({ nonce: client }, max));
  const challenge = await readFrame(socket, max);
  const server = field(challenge, "nonce");
  check(challenge, secret, "server", client, server);
  socket.write(
    frame({ proof: mac(secret, "client", client, server).toString("hex") }, max)
  );
  check(await readFrame(socket, max), secret, "confirm", client, server);
  socket.write(
    frame(seal({ request }, mac(secret, "request-key", client, server)), max)
  );
  const value = open(
    await readFrame(socket, max),
    mac(secret, "response-key", client, server)
  );
  if (!value || typeof value !== "object" || !("result" in value))
    throw new Error("Invalid control response");
  return value.result;
}

export async function startLoopbackControl(
  store: DiscoveryStore,
  handler: Handler,
  options: Options = {}
): Promise<{ close(): Promise<void> }> {
  const { timeoutMs, maxFrameBytes, maxConcurrency } = settings(options);
  if (options.signal?.aborted) throw new Error("Control cancelled");
  const secret = randomBytes(32);
  const publicationAbort = new AbortController();
  const sockets = new Set<Socket>();
  const unauthenticated = new Set<Socket>();
  const controllers = new Set<AbortController>();
  let active = 0;
  let closing = false;
  const server = createServer((socket) => {
    if (closing || unauthenticated.size >= maxConcurrency * 2) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    unauthenticated.add(socket);
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => {
      controller.abort();
      socket.destroy();
    }, timeoutMs);
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timer);
      controller.abort();
      sockets.delete(socket);
      unauthenticated.delete(socket);
      controllers.delete(controller);
    });
    void (async () => {
      let admitted = false;
      try {
        const exchange = await serverExchange(
          socket,
          secret,
          maxFrameBytes,
          () => {
            unauthenticated.delete(socket);
            if (
              closing ||
              controller.signal.aborted ||
              active >= maxConcurrency
            )
              return false;
            active++;
            admitted = true;
            return true;
          }
        );
        if (closing || controller.signal.aborted) return;
        if (
          !exchange.request ||
          typeof exchange.request !== "object" ||
          !("request" in exchange.request)
        )
          throw new Error("Invalid control request");
        const result = await handler(
          exchange.request.request,
          controller.signal
        );
        if (!controller.signal.aborted && !closing)
          socket.end(
            frame(seal({ result }, exchange.responseKey), maxFrameBytes)
          );
      } catch {
        /* Reject malformed messages and handler failures without disclosure. */
      } finally {
        if (admitted) active--;
        socket.destroySoon();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Invalid listener address");
  }
  const record: DiscoveryRecord = {
    host: "127.0.0.1",
    port: address.port,
    capability: secret.toString("hex")
  };
  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= (async () => {
      closing = true;
      publicationAbort.abort();
      options.signal?.removeEventListener("abort", onAbort);
      for (const controller of controllers) controller.abort();
      for (const socket of sockets) socket.destroy();
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      const [cleanup, listener] = await Promise.allSettled([
        clearDiscovery(store, record, timeoutMs),
        stopped
      ]);
      if (cleanup.status === "rejected") throw cleanup.reason;
      if (listener.status === "rejected") throw listener.reason;
    })());
  let rejectCancelled!: (error: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  const onAbort = () => {
    rejectCancelled(new Error("Control cancelled"));
    void close().catch(() => console.error("Loopback control cleanup failed"));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, timeoutMs);
  const publication = Promise.resolve().then(() =>
    store.publish(record, publicationAbort.signal)
  );
  try {
    if (options.signal?.aborted) onAbort();
    await Promise.race([publication, cancelled]);
    if (closing) throw new Error("Control cancelled");
  } catch (error) {
    void publication
      .then(
        () => clearDiscovery(store, record, timeoutMs),
        () => undefined
      )
      .catch(() =>
        console.error("Loopback control late publication cleanup failed")
      );
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { close };
}

export async function requestLoopbackControl(
  store: DiscoveryStore,
  request: unknown,
  options: Options = {}
): Promise<unknown> {
  const { timeoutMs, maxFrameBytes } = settings(options);
  if (options.signal?.aborted) throw new Error("Control cancelled");
  let socket: Socket | undefined;
  let cancelled = false;
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = () => {
    cancelled = true;
    socket?.destroy();
    rejectCancellation(new Error("Control deadline or cancellation"));
  };
  const timer = setTimeout(cancel, timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const operation = (async () => {
      const record = await store.read();
      if (cancelled) throw new Error("Control cancelled");
      if (
        !record ||
        record.host !== "127.0.0.1" ||
        !Number.isInteger(record.port) ||
        record.port < 1 ||
        record.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(record.capability)
      )
        throw new Error("Invalid control discovery");
      socket = createConnection({ host: "127.0.0.1", port: record.port });
      socket.on("error", () => {});
      return clientExchange(
        socket,
        Buffer.from(record.capability, "hex"),
        request,
        maxFrameBytes
      );
    })();
    return await Promise.race([operation, cancellation]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    socket?.destroy();
  }
}

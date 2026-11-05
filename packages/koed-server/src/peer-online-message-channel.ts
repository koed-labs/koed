import type { TLSSocket } from "node:tls";

export interface PeerOnlineMessageChannelOptions {
  maxFrameBytes?: number;
  maxQueuedBytes?: number;
  maxQueuedMessages?: number;
  signal?: AbortSignal;
}

type Send = {
  frame: Buffer;
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * Owns a paused, already authenticated TLS socket. The caller must hand over
 * every unread byte (including bytes buffered during authentication), remove
 * other readers, and fence each durable transaction independently. This
 * transport does not authenticate peers or grant membership.
 *
 * Frames are a four-byte unsigned big-endian length followed by opaque bytes.
 * One receive may be pending; unread frames remain under stream backpressure.
 * Send completion means local write completion, not remote processing.
 */
export class PeerOnlineMessageChannel {
  private readonly maxFrameBytes: number;
  private readonly maxQueuedBytes: number;
  private readonly maxQueuedMessages: number;
  private readonly signal?: AbortSignal;
  private readonly sends: Send[] = [];
  private queuedBytes = 0;
  private sending = false;
  private failure?: Error;
  private ended = false;
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private body?: Buffer;
  private bodyUsed = 0;
  private pending?: {
    resolve: (value: Buffer | null) => void;
    reject: (error: Error) => void;
  };

  constructor(
    private readonly socket: TLSSocket,
    options: PeerOnlineMessageChannelOptions = {}
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 4 * 1024 * 1024;
    this.maxQueuedMessages = options.maxQueuedMessages ?? 64;
    this.signal = options.signal;
    for (const [name, value, max] of [
      ["maxFrameBytes", this.maxFrameBytes, 0xffffffff],
      ["maxQueuedBytes", this.maxQueuedBytes, Number.MAX_SAFE_INTEGER],
      ["maxQueuedMessages", this.maxQueuedMessages, Number.MAX_SAFE_INTEGER]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max)
        throw new RangeError(`Invalid ${name}`);
    }
    if (
      socket.destroyed ||
      socket.readableEnded ||
      socket.readableFlowing === true ||
      socket.readableEncoding !== null ||
      socket.listenerCount("readable") > 0 ||
      socket.listenerCount("data") > 0
    )
      throw new Error("Socket must be open and have no flowing readers");
    socket.on("readable", this.onReadable);
    socket.on("end", this.onEnd);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
    this.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (this.signal?.aborted) this.onAbort();
  }

  send(payload: Uint8Array): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.reject(new Error("Channel ended"));
    if (payload.byteLength > this.maxFrameBytes)
      return Promise.reject(new RangeError("Frame too large"));
    const size = payload.byteLength + 4;
    if (
      this.sends.length >= this.maxQueuedMessages ||
      this.queuedBytes + size > this.maxQueuedBytes
    )
      return Promise.reject(new Error("Send queue full"));
    const frame = Buffer.allocUnsafe(size);
    frame.writeUInt32BE(payload.byteLength, 0);
    frame.set(payload, 4);
    this.queuedBytes += size;
    const result = new Promise<void>((resolve, reject) =>
      this.sends.push({ frame, resolve, reject })
    );
    this.flush();
    return result;
  }

  receive(): Promise<Buffer | null> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending)
      return Promise.reject(new Error("Receive already pending"));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.pump();
    });
  }

  close(): void {
    this.fail(new Error("Channel closed"));
  }

  private readonly onReadable = () => this.pump();
  private readonly onEnd = () => {
    this.ended = true;
    this.pump();
  };
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onClose = () => {
    this.signal?.removeEventListener("abort", this.onAbort);
    if (!this.ended || this.sends.length) this.fail(new Error("Socket closed"));
  };
  private readonly onAbort = () => this.fail(new Error("Channel aborted"));

  private pump(): void {
    while (this.pending && !this.failure) {
      const target = this.body ?? this.header;
      const used = this.body ? this.bodyUsed : this.headerUsed;
      const amount = Math.min(target.length - used, this.socket.readableLength);
      if (amount > 0) {
        const chunk = this.socket.read(amount) as Buffer | null;
        if (!chunk) break;
        chunk.copy(target, used);
        if (this.body) this.bodyUsed += chunk.length;
        else this.headerUsed += chunk.length;
      }
      if (!this.body && this.headerUsed === 4) {
        const length = this.header.readUInt32BE(0);
        if (length > this.maxFrameBytes) {
          this.fail(new Error("Frame too large"));
          return;
        }
        this.body = Buffer.alloc(length);
        this.bodyUsed = 0;
        continue;
      }
      if (this.body && this.bodyUsed === this.body.length) {
        const result = this.body;
        this.body = undefined;
        this.headerUsed = 0;
        const pending = this.pending;
        this.pending = undefined;
        pending.resolve(result);
        return;
      }
      if (amount === 0) break;
    }
    if (this.ended && this.pending) {
      if (this.headerUsed || this.body) {
        this.fail(new Error("Truncated frame"));
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve(null);
    }
  }

  private flush(): void {
    if (this.sending || this.failure || !this.sends.length) return;
    this.sending = true;
    const send = this.sends[0]!;
    try {
      this.socket.write(send.frame, (error?: Error | null) => {
        if (this.failure) return;
        if (error) {
          this.fail(error);
          return;
        }
        this.sends.shift();
        this.queuedBytes -= send.frame.length;
        this.sending = false;
        send.resolve();
        this.flush();
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.pending?.reject(error);
    this.pending = undefined;
    for (const send of this.sends.splice(0)) send.reject(error);
    this.queuedBytes = 0;
    this.socket.destroy();
  }
}

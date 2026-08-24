export type DurableRealtimeAttemptOutcome = "ended" | "terminal";

export type RealtimeTransportFailureKind =
  | "unsupported"
  | "network_path"
  | "deployment_disabled"
  | "authentication"
  | "authorization"
  | "revocation"
  | "schema"
  | "protocol_integrity";

export class RealtimeTransportFailure extends Error {
  readonly kind: RealtimeTransportFailureKind;

  constructor(kind: RealtimeTransportFailureKind, message: string) {
    super(message);
    this.name = "RealtimeTransportFailure";
    this.kind = kind;
  }
}

export interface RealtimeTransportFallbackOptions<Result> {
  offered: readonly string[];
  supported: readonly string[];
  attempt: (transportId: string) => Promise<Result>;
  onFallback?: (input: {
    failedTransportId: string;
    nextTransportId: string;
    kind: Extract<
      RealtimeTransportFailureKind,
      "unsupported" | "network_path" | "deployment_disabled"
    >;
  }) => void;
}

export type DurableRealtimeLifecycleState =
  | {
      state: "connecting";
      reconnectAttempt: 0;
      retryAtMs: null;
      retryDelayMs: null;
    }
  | {
      state: "live";
      reconnectAttempt: 0;
      retryAtMs: null;
      retryDelayMs: null;
    }
  | {
      state: "reconnecting";
      reconnectAttempt: number;
      retryAtMs: number;
      retryDelayMs: number;
    }
  | {
      state: "unavailable";
      reconnectAttempt: number;
      retryAtMs: number;
      retryDelayMs: number;
    };

export interface DurableRealtimeAttemptContext {
  signal: AbortSignal;
  reconnecting: boolean;
  isCurrent: () => boolean;
  markLive: () => void;
}

export interface DurableRealtimeRetryPolicy {
  maxAttempts: number;
  attemptWindowMs: number;
  unavailableCooldownMs: number;
  delayForAttempt: (attempt: number) => number;
}

export interface DurableRealtimeRuntimeOptions {
  signal: AbortSignal;
  retry: DurableRealtimeRetryPolicy;
  connect: (
    context: DurableRealtimeAttemptContext
  ) => Promise<DurableRealtimeAttemptOutcome>;
  onState: (state: DurableRealtimeLifecycleState) => void;
  isCurrent?: () => boolean;
  now?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface BoundedSseFrame {
  event: string;
  data: string;
}

export interface ReadBoundedSseOptions {
  body: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  maxFrameBytes: number;
  onFrame: (
    frame: BoundedSseFrame
  ) => Promise<"continue" | "terminal"> | "continue" | "terminal";
}

export interface DurableRealtimeStreamFrame extends BoundedSseFrame {
  id: string | null;
}

export interface ReadBoundedDurableRealtimeStreamOptions {
  body: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  maxFrameBytes: number;
  onFrame: (
    frame: DurableRealtimeStreamFrame
  ) => Promise<"continue" | "terminal"> | "continue" | "terminal";
}

export interface DurableRealtimeReliableStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface RunDurableRealtimeStreamAttemptOptions {
  stream: DurableRealtimeReliableStream;
  attach: DurableRealtimeStreamFrame;
  signal: AbortSignal;
  maxFrameBytes: number;
  onFrame: ReadBoundedDurableRealtimeStreamOptions["onFrame"];
}

export interface ReadFirstBoundedDurableRealtimeFrameOptions {
  body: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  maxFrameBytes: number;
  maxInitialRemainderBytes?: number;
}

export interface FirstBoundedDurableRealtimeFrame {
  frame: DurableRealtimeStreamFrame;
  remainder: ReadableStream<Uint8Array>;
}

const durableEventNamePattern = /^[a-z][a-z0-9_]{0,63}$/;
const durableEventIdPattern = /^[\x21-\x7e]{1,4096}$/;

const assertDurableRealtimeFrame = (
  value: unknown
): DurableRealtimeStreamFrame => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Durable realtime frame is invalid");
  }
  const frame = value as Record<string, unknown>;
  if (
    Object.keys(frame).some(
      (key) => key !== "event" && key !== "data" && key !== "id"
    ) ||
    typeof frame.event !== "string" ||
    !durableEventNamePattern.test(frame.event) ||
    typeof frame.data !== "string" ||
    (frame.id !== null &&
      (typeof frame.id !== "string" || !durableEventIdPattern.test(frame.id)))
  ) {
    throw new Error("Durable realtime frame is invalid");
  }
  return { event: frame.event, data: frame.data, id: frame.id };
};

export const encodeDurableRealtimeStreamFrame = (
  frame: DurableRealtimeStreamFrame,
  maxFrameBytes: number
): Uint8Array => {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new TypeError("Durable realtime frame byte limit is invalid");
  }
  const normalized = assertDurableRealtimeFrame(frame);
  const encoded = new TextEncoder().encode(`${JSON.stringify(normalized)}\n`);
  if (encoded.byteLength > maxFrameBytes) {
    throw new Error("Durable realtime frame exceeded its byte limit");
  }
  return encoded;
};

export const readFirstBoundedDurableRealtimeFrame = async (
  options: ReadFirstBoundedDurableRealtimeFrameOptions
): Promise<FirstBoundedDurableRealtimeFrame> => {
  if (
    !Number.isSafeInteger(options.maxFrameBytes) ||
    options.maxFrameBytes < 1
  ) {
    throw new TypeError("Durable realtime frame byte limit is invalid");
  }
  const maxInitialRemainderBytes =
    options.maxInitialRemainderBytes ?? options.maxFrameBytes;
  if (
    !Number.isSafeInteger(maxInitialRemainderBytes) ||
    maxInitialRemainderBytes < 0
  ) {
    throw new TypeError("Durable realtime initial remainder limit is invalid");
  }
  const reader = options.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let trailing = new Uint8Array();
  const abortRead = () => {
    void reader.cancel(options.signal.reason).catch(() => undefined);
  };
  options.signal.addEventListener("abort", abortRead, { once: true });

  try {
    for (;;) {
      if (options.signal.aborted) {
        throw new Error("Durable realtime frame read was aborted");
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      const boundary = chunk.value.indexOf(0x0a);
      const framePart =
        boundary < 0 ? chunk.value : chunk.value.subarray(0, boundary);
      bytes += framePart.byteLength;
      if (bytes + 1 > options.maxFrameBytes) {
        throw new Error("Durable realtime frame exceeded its byte limit");
      }
      if (framePart.byteLength > 0) parts.push(framePart.slice());
      if (boundary >= 0) {
        trailing = chunk.value.subarray(boundary + 1).slice();
        if (trailing.byteLength > maxInitialRemainderBytes) {
          throw new Error(
            "Durable realtime initial remainder exceeded its byte limit"
          );
        }
        break;
      }
    }
    if (bytes === 0) throw new Error("Durable realtime frame is required");
    const encoded = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) {
      encoded.set(part, offset);
      offset += part.byteLength;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(encoded)
      );
    } catch {
      throw new Error("Durable realtime frame is invalid");
    }
    const frame = assertDurableRealtimeFrame(parsed);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      options.signal.removeEventListener("abort", abortRead);
      reader.releaseLock();
    };
    const remainder = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (trailing.byteLength > 0) {
          controller.enqueue(trailing);
          trailing = new Uint8Array();
          return;
        }
        if (options.signal.aborted) {
          controller.error(options.signal.reason);
          release();
          return;
        }
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            release();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(error);
          release();
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
        release();
      }
    });
    return { frame, remainder };
  } catch (error) {
    options.signal.removeEventListener("abort", abortRead);
    await reader.cancel(error).catch(() => undefined);
    reader.releaseLock();
    throw error;
  }
};

export const readBoundedDurableRealtimeStream = async (
  options: ReadBoundedDurableRealtimeStreamOptions
): Promise<DurableRealtimeAttemptOutcome> => {
  if (
    !Number.isSafeInteger(options.maxFrameBytes) ||
    options.maxFrameBytes < 1
  ) {
    throw new TypeError("Durable realtime frame byte limit is invalid");
  }
  const reader = options.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pendingParts: Uint8Array[] = [];
  let pendingBytes = 0;
  const abortRead = () => {
    void reader.cancel(options.signal.reason).catch(() => undefined);
  };
  options.signal.addEventListener("abort", abortRead, { once: true });

  const append = (bytes: Uint8Array, includesTerminator: boolean) => {
    const total = pendingBytes + bytes.byteLength;
    if (total + (includesTerminator ? 1 : 0) > options.maxFrameBytes) {
      throw new Error("Durable realtime frame exceeded its byte limit");
    }
    if (bytes.byteLength === 0) return;
    pendingParts.push(bytes.slice());
    pendingBytes = total;
  };

  const consume = async () => {
    if (pendingBytes === 0) return "continue" as const;
    const encoded = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const part of pendingParts) {
      encoded.set(part, offset);
      offset += part.byteLength;
    }
    pendingParts = [];
    pendingBytes = 0;
    let line: string;
    try {
      line = decoder.decode(encoded);
    } catch {
      throw new Error("Durable realtime frame is invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Durable realtime frame is invalid");
    }
    return options.onFrame(assertDurableRealtimeFrame(parsed));
  };

  try {
    for (;;) {
      if (options.signal.aborted) return "terminal";
      const chunk = await reader.read();
      if (chunk.done) break;
      let offset = 0;
      for (let index = 0; index < chunk.value.byteLength; index += 1) {
        if (chunk.value[index] !== 0x0a) continue;
        append(chunk.value.subarray(offset, index), true);
        if ((await consume()) === "terminal") return "terminal";
        offset = index + 1;
      }
      append(chunk.value.subarray(offset), true);
    }
    if (pendingBytes > 0 && (await consume()) === "terminal") {
      return "terminal";
    }
    return "ended";
  } finally {
    options.signal.removeEventListener("abort", abortRead);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

export const runDurableRealtimeStreamAttempt = async (
  options: RunDurableRealtimeStreamAttemptOptions
): Promise<DurableRealtimeAttemptOutcome> => {
  const writer = options.stream.writable.getWriter();
  const abortWrite = () => {
    void writer.abort(options.signal.reason).catch(() => undefined);
  };
  options.signal.addEventListener("abort", abortWrite, { once: true });
  try {
    if (options.signal.aborted) return "terminal";
    await writer.write(
      encodeDurableRealtimeStreamFrame(options.attach, options.maxFrameBytes)
    );
    await writer.close();
  } finally {
    options.signal.removeEventListener("abort", abortWrite);
    writer.releaseLock();
  }
  if (options.signal.aborted) return "terminal";
  return readBoundedDurableRealtimeStream({
    body: options.stream.readable,
    signal: options.signal,
    maxFrameBytes: options.maxFrameBytes,
    onFrame: options.onFrame
  });
};

export const negotiateDurableRealtimeTransport = (
  offered: readonly string[],
  supported: readonly string[]
): string | null => {
  const supportedSet = new Set(supported);
  return offered.find((transportId) => supportedSet.has(transportId)) ?? null;
};

export const connectWithRealtimeTransportFallback = async <Result>(
  options: RealtimeTransportFallbackOptions<Result>
): Promise<{ transportId: string; result: Result }> => {
  const supported = new Set(options.supported);
  const candidates = options.offered.filter(
    (transportId, index, offered) =>
      supported.has(transportId) && offered.indexOf(transportId) === index
  );
  if (candidates.length === 0) {
    throw new RealtimeTransportFailure(
      "unsupported",
      "No compatible realtime transport is available"
    );
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const transportId = candidates[index]!;
    try {
      return { transportId, result: await options.attempt(transportId) };
    } catch (error) {
      const fallbackKind =
        error instanceof RealtimeTransportFailure &&
        (error.kind === "unsupported" ||
          error.kind === "network_path" ||
          error.kind === "deployment_disabled")
          ? error.kind
          : null;
      const nextTransportId = candidates[index + 1];
      if (!fallbackKind || !nextTransportId) throw error;
      options.onFallback?.({
        failedTransportId: transportId,
        nextTransportId,
        kind: fallbackKind
      });
    }
  }
  throw new RealtimeTransportFailure(
    "unsupported",
    "No compatible realtime transport is available"
  );
};

const defaultSleep = (delayMs: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });

const assertRetryPolicy = (policy: DurableRealtimeRetryPolicy): void => {
  if (
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    !Number.isSafeInteger(policy.attemptWindowMs) ||
    policy.attemptWindowMs < 1 ||
    !Number.isSafeInteger(policy.unavailableCooldownMs) ||
    policy.unavailableCooldownMs < 1
  ) {
    throw new TypeError("Durable realtime retry policy is invalid");
  }
};

const retryDelay = (
  policy: DurableRealtimeRetryPolicy,
  attempt: number
): number => {
  const delay = policy.delayForAttempt(attempt);
  if (!Number.isFinite(delay) || delay < 0) {
    throw new TypeError("Durable realtime retry delay is invalid");
  }
  return Math.round(delay);
};

export const runDurableRealtime = async (
  options: DurableRealtimeRuntimeOptions
): Promise<void> => {
  assertRetryPolicy(options.retry);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const isCurrent = () =>
    !options.signal.aborted && (options.isCurrent?.() ?? true);
  const emitState = (state: DurableRealtimeLifecycleState): boolean => {
    if (!isCurrent()) return false;
    options.onState(state);
    return isCurrent();
  };
  const attempts: number[] = [];
  let reconnecting = false;

  if (
    !emitState({
      state: "connecting",
      reconnectAttempt: 0,
      retryAtMs: null,
      retryDelayMs: null
    })
  ) {
    return;
  }

  while (isCurrent()) {
    try {
      let live = false;
      const outcome = await options.connect({
        signal: options.signal,
        reconnecting,
        isCurrent,
        markLive: () => {
          if (live) return;
          live = true;
          emitState({
            state: "live",
            reconnectAttempt: 0,
            retryAtMs: null,
            retryDelayMs: null
          });
        }
      });
      if (!isCurrent() || outcome === "terminal") return;
    } catch {
      if (!isCurrent()) return;
    }
    reconnecting = true;

    const attemptNow = now();
    while (
      attempts.length > 0 &&
      attemptNow - attempts[0]! >= options.retry.attemptWindowMs
    ) {
      attempts.shift();
    }
    if (attempts.length >= options.retry.maxAttempts) {
      const delay = options.retry.unavailableCooldownMs;
      if (
        !emitState({
          state: "unavailable",
          reconnectAttempt: options.retry.maxAttempts,
          retryAtMs: attemptNow + delay,
          retryDelayMs: delay
        })
      ) {
        return;
      }
      await sleep(delay, options.signal);
      attempts.length = 0;
      continue;
    }

    attempts.push(attemptNow);
    const attempt = attempts.length;
    const delay = retryDelay(options.retry, attempt);
    if (
      !emitState({
        state: "reconnecting",
        reconnectAttempt: attempt,
        retryAtMs: attemptNow + delay,
        retryDelayMs: delay
      })
    ) {
      return;
    }
    await sleep(delay, options.signal);
  }
};

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export const readBoundedSse = async (
  options: ReadBoundedSseOptions
): Promise<DurableRealtimeAttemptOutcome> => {
  if (
    !Number.isSafeInteger(options.maxFrameBytes) ||
    options.maxFrameBytes < 1
  ) {
    throw new TypeError("SSE frame byte limit is invalid");
  }
  const reader = options.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";

  const consumeFrame = async (
    frame: string
  ): Promise<"continue" | "terminal"> => {
    if (utf8Bytes(frame) > options.maxFrameBytes) {
      throw new Error("SSE frame exceeded its byte limit");
    }
    const lines = frame.split("\n");
    if (lines.every((line) => line === "" || line.startsWith(":"))) {
      return "continue";
    }
    let event = "message";
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return options.onFrame({ event, data: data.join("\n") });
  };

  try {
    for (;;) {
      if (options.signal.aborted) return "terminal";
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder
        .decode(chunk.value, { stream: true })
        .replace(/\r\n/g, "\n");
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if ((await consumeFrame(frame)) === "terminal") return "terminal";
      }
      if (utf8Bytes(buffer) > options.maxFrameBytes) {
        throw new Error("SSE frame exceeded its byte limit");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && (await consumeFrame(buffer)) === "terminal") {
      return "terminal";
    }
    return "ended";
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

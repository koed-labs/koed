export class RemoteRequestTimeoutError extends Error {
  readonly transient = true;

  constructor() {
    super("Remote request timed out");
    this.name = "RemoteRequestTimeoutError";
  }
}

export class RemoteResponseLimitError extends Error {
  readonly transient = false;

  constructor() {
    super("Remote response exceeded the configured byte limit");
    this.name = "RemoteResponseLimitError";
  }
}

export const cancelReadable = (
  readable: { cancel: (reason?: unknown) => unknown },
  reason?: unknown
): void => {
  try {
    const cancellation = readable.cancel(reason);
    void Promise.resolve(cancellation).catch(() => undefined);
  } catch {
    // Cancellation is best effort; callers must still release locks/settle.
  }
};

const abortReason = (reason: unknown): unknown =>
  reason ?? new DOMException("The operation was aborted", "AbortError");

export const upstreamApiUrl = (baseUrl: string, path: string): URL => {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  base.search = "";
  base.hash = "";
  return base;
};

export const fetchWithTimeout = async (
  fetchFn: typeof fetch,
  input: URL | RequestInfo,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const controller = new AbortController();
  const callerSignal = init.signal;
  if (callerSignal?.aborted) {
    throw abortReason(callerSignal.reason);
  }
  let rejectCaller: ((reason: unknown) => void) | null = null;
  const callerAbort = new Promise<never>((_, reject) => {
    rejectCaller = reject;
  });
  const onAbort = () => {
    const reason = abortReason(callerSignal?.reason);
    controller.abort(reason);
    rejectCaller?.(reason);
  };
  callerSignal?.addEventListener("abort", onAbort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new RemoteRequestTimeoutError());
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    const request = fetchFn(input, { ...init, signal: controller.signal });
    void request.catch(() => undefined);
    return await Promise.race([request, timeoutPromise, callerAbort]);
  } finally {
    if (timeout) clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", onAbort);
  }
};

export const readBoundedJsonObject = async (
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  readerHandle?: {
    current: ReadableStreamDefaultReader<Uint8Array> | null;
  }
): Promise<Record<string, unknown>> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    if (response.body) cancelReadable(response.body);
    throw new RemoteResponseLimitError();
  }
  if (signal?.aborted) throw abortReason(signal.reason);
  if (!response.body) return {};

  const reader = response.body.getReader();
  if (readerHandle) readerHandle.current = reader;
  let rejectAbort: ((reason?: unknown) => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const cancelReader = (reason?: unknown) => {
    cancelReadable(reader, reason);
  };
  const onAbort = () => {
    const reason = abortReason(signal?.reason);
    cancelReader(reason);
    rejectAbort?.(reason);
  };
  if (signal?.aborted) {
    cancelReader(signal.reason);
    reader.releaseLock();
    throw abortReason(signal.reason);
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const nextRead = reader.read();
      void nextRead.catch(() => undefined);
      const next = await Promise.race([nextRead, abortPromise]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        cancelReader();
        throw new RemoteResponseLimitError();
      }
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (readerHandle?.current === reader) readerHandle.current = null;
    try {
      reader.releaseLock();
    } catch {
      // The reader may already have been released by the underlying stream.
    }
  }
  if (signal?.aborted) throw abortReason(signal.reason);
  if (bytes === 0) return {};
  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk))
  ).toString("utf8");
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("Remote response must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

export const fetchBoundedJsonObject = async (
  fetchFn: typeof fetch,
  input: URL | RequestInfo,
  init: RequestInit,
  options: {
    timeoutMs: number;
    maxBytes: number;
    readErrorBody?: boolean;
    signal?: AbortSignal;
  }
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const controller = new AbortController();
  const callerSignals = [options.signal, init.signal].filter(
    (signal, index, signals): signal is AbortSignal =>
      Boolean(signal) && signals.indexOf(signal) === index
  );
  const alreadyAborted = callerSignals.find((signal) => signal.aborted);
  if (alreadyAborted) {
    throw abortReason(alreadyAborted.reason);
  }
  const readerHandle: {
    current: ReadableStreamDefaultReader<Uint8Array> | null;
  } = { current: null };
  let rejectCaller: ((reason: unknown) => void) | null = null;
  const callerAbort = new Promise<never>((_, reject) => {
    rejectCaller = reject;
  });
  const onAbort = (event: Event) => {
    const signal = event.target as AbortSignal;
    const reason = abortReason(signal.reason);
    controller.abort(reason);
    rejectCaller?.(reason);
    if (readerHandle.current) cancelReadable(readerHandle.current, reason);
    if (response?.body) cancelReadable(response.body, signal.reason);
  };
  for (const signal of callerSignals) {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  let response: Response | undefined;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const reason = new RemoteRequestTimeoutError();
      controller.abort(reason);
      if (readerHandle.current) cancelReadable(readerHandle.current, reason);
      if (response?.body) cancelReadable(response.body);
      reject(reason);
    }, options.timeoutMs);
    timeout.unref?.();
  });
  const operation = (async () => {
    response = await fetchFn(input, { ...init, signal: controller.signal });
    if (controller.signal.aborted) throw abortReason(controller.signal.reason);
    if (!response.ok && !options.readErrorBody) {
      if (response.body) cancelReadable(response.body);
      if (controller.signal.aborted) {
        throw abortReason(controller.signal.reason);
      }
      return { response, payload: {} };
    }
    return {
      response,
      payload: await readBoundedJsonObject(
        response,
        options.maxBytes,
        controller.signal,
        readerHandle
      )
    };
  })();
  void operation.catch(() => undefined);
  try {
    return await Promise.race([operation, timeoutPromise, callerAbort]);
  } finally {
    if (timeout) clearTimeout(timeout);
    for (const signal of callerSignals) {
      signal.removeEventListener("abort", onAbort);
    }
  }
};

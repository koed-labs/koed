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
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new RemoteRequestTimeoutError());
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([
      fetchFn(input, { ...init, signal: controller.signal }),
      timeoutPromise
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const readBoundedJsonObject = async (
  response: Response,
  maxBytes: number
): Promise<Record<string, unknown>> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new RemoteResponseLimitError();
  }
  if (!response.body) return {};

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new RemoteResponseLimitError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
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
  options: { timeoutMs: number; maxBytes: number }
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const controller = new AbortController();
  let response: Response | undefined;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      void response?.body?.cancel().catch(() => undefined);
      reject(new RemoteRequestTimeoutError());
    }, options.timeoutMs);
    timeout.unref?.();
  });
  const operation = (async () => {
    response = await fetchFn(input, { ...init, signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { response, payload: {} };
    }
    return {
      response,
      payload: await readBoundedJsonObject(response, options.maxBytes)
    };
  })();
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

import {
  readLocalRuntimeRegistration,
  type LocalRuntimeCapabilities,
  type LocalRuntimeCallerContext,
  type LocalRuntimeToolName
} from "./local-runtime-protocol.js";

const responseJson = async (
  response: Response
): Promise<Record<string, unknown>> => {
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Koed local AI runtime request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Koed local AI runtime returned an invalid response");
  }
  return body as Record<string, unknown>;
};

const requestSignal = (
  callerSignal: AbortSignal | undefined,
  timeoutMs?: number
): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController();
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new Error("Koed local AI runtime request timed out")
            ),
          timeoutMs
        );
  timeout?.unref?.();
  const abort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    abort();
  } else {
    callerSignal?.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timeout) clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abort);
    }
  };
};

export class LocalAiRuntimeClient {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async request(
    pathname: string,
    init: RequestInit,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<Record<string, unknown>> {
    const registration = readLocalRuntimeRegistration(this.environment);
    const bounded = requestSignal(signal, timeoutMs);
    try {
      return await responseJson(
        await this.fetchImpl(new URL(pathname, registration.url), {
          ...init,
          headers: {
            "content-type": "application/json",
            ...(init.headers ?? {}),
            authorization: registration.authorization
          },
          signal: bounded.signal
        })
      );
    } catch (error) {
      if (bounded.signal.aborted) {
        throw new Error(
          signal?.aborted
            ? "Koed memory request was cancelled"
            : "Koed local AI runtime request timed out",
          { cause: error }
        );
      }
      throw error;
    } finally {
      bounded.dispose();
    }
  }

  async capabilities(): Promise<LocalRuntimeCapabilities> {
    return (await this.request(
      "/v1/capabilities",
      { method: "GET" },
      undefined,
      10_000
    )) as unknown as LocalRuntimeCapabilities;
  }

  async refreshCapabilities(
    signal?: AbortSignal,
    timeoutMs = 5_000
  ): Promise<Record<string, unknown>> {
    return this.request(
      "/v1/capabilities/refresh",
      { method: "POST" },
      signal,
      timeoutMs
    );
  }

  async callTool(
    name: LocalRuntimeToolName,
    input: Record<string, unknown>,
    caller: LocalRuntimeCallerContext,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return await this.request(
      `/v1/tools/${encodeURIComponent(name)}`,
      {
        method: "POST",
        body: JSON.stringify({ input, caller })
      },
      signal
    );
  }
}

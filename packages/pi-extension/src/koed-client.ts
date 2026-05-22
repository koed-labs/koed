export class KoedApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly payload?: unknown
  ) {
    super(message);
    this.name = "KoedApiError";
  }
}

export interface AccessCheckResult {
  ok: boolean;
  auth: "bearer_api_token";
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
  currentTeam: {
    id: string;
    name: string;
    inviteCode: string | null;
    role?: string;
  } | null;
  canWritePersonal: boolean;
  canWriteTeam: boolean;
  enabledProviderConfigs: number;
  memoryMode?: "codex_subscription" | "server_synthesis";
  providerConfigRequired?: boolean;
  embeddingRetrieval?: {
    enabled: boolean;
    healthy: boolean;
    model: string | null;
    dimensions: number | null;
    error?: string;
  };
}

export class KoedApiClient {
  constructor(
    readonly config: {
      apiUrl: string;
      apiToken?: string;
    }
  ) {}

  private url(path: string): string {
    return `${this.config.apiUrl.replace(/\/+$/, "")}${path}`;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    if (!this.config.apiToken) {
      throw new KoedApiError("Koed API token is not configured. Set KOED_API_TOKEN.", 401);
    }

    let response: Response;
    try {
      response = await fetch(this.url(path), {
        method,
        signal,
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new KoedApiError(
        `Could not reach Koed API at ${this.config.apiUrl}.`,
        undefined,
        error instanceof Error ? error.message : String(error)
      );
    }

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };

    if (!response.ok) {
      throw new KoedApiError(
        payload.error ?? `Koed API request failed with status ${response.status}.`,
        response.status,
        payload
      );
    }

    return payload as T;
  }

  accessCheck(signal?: AbortSignal): Promise<AccessCheckResult> {
    return this.request("GET", "/v1/access/check", undefined, signal);
  }

  createSession(
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ session?: { id: string }; skipped?: boolean; reason?: string }> {
    return this.request("POST", "/v1/sessions", input, signal);
  }

  capturePersonalEvent(
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/capture-personal-event", input, signal);
  }

  answer(
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/answer", input, signal);
  }

  search(
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/search", input, signal);
  }

  expand(nodeId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/v1/memory/nodes/${encodeURIComponent(nodeId)}/expand`,
      undefined,
      signal
    );
  }
}

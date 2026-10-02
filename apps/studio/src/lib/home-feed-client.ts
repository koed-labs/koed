import {
  homeAccessSchema,
  homeReminderMutationResultSchema,
  homeSnapshotSchema,
  type HomeItem,
  type HomeAccess,
  type HomeSnapshot,
  type HomeSource
} from "@koed/shared/home";

export type HomeFeedTransport = "studio" | "hosted";

export class HomeFeedError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "HomeFeedError";
  }
}

export class HomeFeedClient {
  private csrfToken: string | null = null;
  private readonly basePath: string;

  constructor(
    private readonly transport: HomeFeedTransport,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.basePath =
      transport === "hosted" ? "/v1/home" : "/studio-api/home-feed";
  }

  async get(
    input: { source?: HomeSource; cursor?: string; limit?: number } = {},
    signal?: AbortSignal
  ): Promise<HomeSnapshot> {
    const query = new URLSearchParams();
    if (input.source) query.set("source", input.source);
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const path = query.size ? `${this.basePath}?${query}` : this.basePath;
    const response = await this.fetcher(path, {
      method: "GET",
      credentials: this.transport === "hosted" ? "include" : "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw this.requestError(response.status);
    const parsed = homeSnapshotSchema.safeParse(payload);
    if (!parsed.success)
      throw new HomeFeedError("Home returned an invalid feed.", 502);
    return parsed.data;
  }

  async getAccess(signal?: AbortSignal): Promise<HomeAccess> {
    const response = await this.fetcher(`${this.basePath}/access`, {
      method: "GET",
      credentials: this.transport === "hosted" ? "include" : "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw this.requestError(response.status);
    const parsed = homeAccessSchema.safeParse(payload);
    if (!parsed.success)
      throw new HomeFeedError("Home access is unavailable.", 502);
    return parsed.data;
  }

  async setCleared(item: HomeItem, cleared: boolean, signal?: AbortSignal) {
    const path = `${this.basePath}/reminders/${encodeURIComponent(item.sourceEventId)}/${cleared ? "clear" : "restore"}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json"
    };
    if (this.transport === "studio")
      headers["x-studio-csrf"] = await this.getCsrfToken(signal);
    const response = await this.fetcher(path, {
      method: "POST",
      credentials: this.transport === "hosted" ? "include" : "same-origin",
      cache: "no-store",
      redirect: "error",
      headers,
      body: JSON.stringify({ sourceRevision: item.sourceRevision }),
      signal
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw this.requestError(response.status);
    const parsed = homeReminderMutationResultSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.sourceEventId !== item.sourceEventId ||
      parsed.data.sourceRevision !== item.sourceRevision ||
      parsed.data.cleared !== cleared
    ) {
      throw new HomeFeedError("Home returned an invalid reminder update.", 502);
    }
    return parsed.data;
  }

  private async getCsrfToken(signal?: AbortSignal): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    const response = await this.fetcher("/studio-api/github/session", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal
    });
    const payload: unknown = await response.json().catch(() => null);
    if (
      !response.ok ||
      !isRecord(payload) ||
      typeof payload.csrfToken !== "string"
    ) {
      throw this.requestError(response.status);
    }
    this.csrfToken = payload.csrfToken;
    return payload.csrfToken;
  }

  private requestError(status: number) {
    return new HomeFeedError(
      status === 409
        ? "This Home item changed elsewhere. Refresh to see the latest version."
        : status === 401 || status === 403
          ? "Home access changed. Refresh to check your access."
          : "Home is temporarily unavailable.",
      status
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

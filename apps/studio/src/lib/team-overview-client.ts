import {
  teamOverviewMutationResultSchema,
  teamOverviewSnapshotSchema,
  teamOverviewSourceMutationSchema,
  type TeamOverviewItem,
  type TeamOverviewSnapshot
} from "@koed/shared/team-overview";

export type TeamOverviewTransport = "hosted" | "studio";
export type TeamOverviewMutation = "clear" | "restore" | "seen";

export class TeamOverviewError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TeamOverviewError";
    this.status = status;
  }
}

/** Reads the authorized all-Teams overview through the shell's own auth path. */
export class TeamOverviewClient {
  private readonly transport: TeamOverviewTransport;
  private readonly fetcher: typeof fetch;
  private csrfToken: string | null = null;

  constructor(transport: TeamOverviewTransport, fetcher: typeof fetch = fetch) {
    this.transport = transport;
    this.fetcher = fetcher.bind(globalThis);
  }

  async getOverview(
    options: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal
  ): Promise<TeamOverviewSnapshot> {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const path = `${this.basePath}${query.size ? `?${query}` : ""}`;
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
    const parsed = teamOverviewSnapshotSchema.safeParse(payload);
    if (!parsed.success)
      throw new TeamOverviewError(
        "Team activity returned an invalid feed.",
        502
      );
    return parsed.data;
  }

  async mutate(
    item: TeamOverviewItem,
    mutation: TeamOverviewMutation,
    signal?: AbortSignal
  ) {
    const payload = teamOverviewSourceMutationSchema.safeParse({
      sourceRevision: item.sourceRevision
    });
    if (!payload.success)
      throw new TeamOverviewError("Team activity update is invalid.", 400);
    const path = `${this.mutationBasePath}/${encodeURIComponent(item.teamId)}/overview/${encodeURIComponent(item.sourceEventId)}/${mutation}`;
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
      body: JSON.stringify(payload.data),
      signal
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw this.requestError(response.status);
    const parsed = teamOverviewMutationResultSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.sourceEventId !== item.sourceEventId ||
      parsed.data.sourceRevision !== item.sourceRevision ||
      (mutation === "clear" && !parsed.data.cleared) ||
      (mutation === "restore" && parsed.data.cleared) ||
      (mutation === "seen" && !parsed.data.seen)
    ) {
      throw new TeamOverviewError(
        "Team activity returned an invalid update.",
        502
      );
    }
    return parsed.data;
  }

  private get basePath() {
    return this.transport === "hosted"
      ? "/v1/collaboration/teams/overview"
      : "/studio-api/collaboration/teams/overview";
  }

  private get mutationBasePath() {
    return this.transport === "hosted"
      ? "/v1/collaboration/teams"
      : "/studio-api/collaboration/teams";
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
    return new TeamOverviewError(
      status === 409
        ? "This Team activity changed elsewhere. Refresh to see the latest version."
        : status === 401 || status === 403
          ? "Team access changed. Refresh to check your access."
          : "Team activity is temporarily unavailable.",
      status
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

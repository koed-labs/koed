import {
  personalAgentTeamBriefDraftSchema,
  publicSquarePageSchema,
  publicSquarePublicationSchema,
  teamProjectMemberConnectionSchema,
  type PersonalAgentTeamBriefDraft,
  type PublicSquarePage,
  type PublicSquarePublication,
  type TeamProjectMemberConnection
} from "@koed/shared/public-square";

type Transport = "hosted" | "studio";
type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);

export class PublicSquareRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "PublicSquareRequestError";
  }
}

/** Small transport adapter for the common hosted and Desktop Public Square UI. */
export class PublicSquareClient {
  private readonly fetcher: typeof fetch;
  private readonly transport: Transport;
  private csrfToken: string | null = null;

  constructor(transport: Transport, fetcher: typeof fetch = fetch) {
    this.transport = transport;
    this.fetcher = fetcher.bind(globalThis);
  }

  async list(teamId: string, options: { limit?: number; cursor?: string | null } = {}): Promise<PublicSquarePage> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.cursor) query.set("cursor", options.cursor);
    const body = await this.request(`${this.teamPath(teamId)}?${query}`);
    const parsed = publicSquarePageSchema.safeParse(isRecord(body) ? body.page : null);
    if (!parsed.success || parsed.data.teamId !== teamId) throw this.invalid("Public Square history");
    return parsed.data;
  }

  async getConnection(teamId: string, teamProjectId: string): Promise<TeamProjectMemberConnection> {
    const body = await this.request(`${this.teamPath(teamId)}/projects/${encodeURIComponent(teamProjectId)}/connection`);
    const parsed = teamProjectMemberConnectionSchema.safeParse(isRecord(body) ? body.connection : null);
    if (!parsed.success || parsed.data.teamId !== teamId || parsed.data.teamProjectId !== teamProjectId) throw this.invalid("Project connection");
    return parsed.data;
  }

  async setConnection(input: {
    teamId: string;
    teamProjectId: string;
    localProjectId: string | null;
    expectedVersion: number;
  }): Promise<TeamProjectMemberConnection> {
    const body = await this.request(`${this.teamPath(input.teamId)}/projects/${encodeURIComponent(input.teamProjectId)}/connection`, {
      method: "PUT",
      body: { expectedVersion: input.expectedVersion, localProjectId: input.localProjectId }
    });
    const parsed = teamProjectMemberConnectionSchema.safeParse(isRecord(body) ? body.connection : null);
    if (!parsed.success || parsed.data.teamId !== input.teamId || parsed.data.teamProjectId !== input.teamProjectId || parsed.data.localProjectId !== input.localProjectId) throw this.invalid("Project connection update");
    return parsed.data;
  }

  async getBriefDraft(teamId: string, publicationId: string): Promise<PersonalAgentTeamBriefDraft> {
    const body = await this.request(`${this.teamPath(teamId)}/${encodeURIComponent(publicationId)}/brief-draft`);
    const parsed = personalAgentTeamBriefDraftSchema.safeParse(isRecord(body) ? body.draft : null);
    if (!parsed.success || parsed.data.publicationId !== publicationId) throw this.invalid("Private brief draft");
    return parsed.data;
  }

  async setBrief(input: {
    teamId: string;
    publicationId: string;
    brief: string | null;
    expectedVersion: number;
  }): Promise<PublicSquarePublication> {
    const body = await this.request(`${this.teamPath(input.teamId)}/${encodeURIComponent(input.publicationId)}/brief`, {
      method: "PUT",
      body: { expectedVersion: input.expectedVersion, brief: input.brief }
    });
    const parsed = publicSquarePublicationSchema.safeParse(isRecord(body) ? body.publication : null);
    if (!parsed.success || parsed.data.id !== input.publicationId || parsed.data.sharedBrief !== input.brief) throw this.invalid("Shared brief update");
    return parsed.data;
  }

  async unshareProject(teamId: string, teamProjectId: string): Promise<void> {
    const body = await this.request(`${this.teamPath(teamId)}/projects/${encodeURIComponent(teamProjectId)}/unshare`, {
      method: "POST",
      body: {}
    });
    if (!isRecord(body) || body.teamId !== teamId || body.teamProjectId !== teamProjectId || body.unshared !== true) throw this.invalid("Project unshare");
  }

  private teamPath(teamId: string): string {
    const team = `/teams/${encodeURIComponent(teamId)}`;
    return this.transport === "hosted"
      ? `/v1/collaboration${team}/public-square`
      : `/studio-api/public-square${team}`;
  }

  private invalid(label: string): PublicSquareRequestError {
    return new PublicSquareRequestError(`Koed returned invalid ${label}.`, 502);
  }

  private async request(path: string, init: { method?: "GET" | "PUT" | "POST"; body?: unknown } = {}): Promise<unknown> {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (this.transport === "studio" && method !== "GET") headers["x-studio-csrf"] = await this.getCsrfToken();
    const response = await this.fetcher(path, {
      method,
      credentials: this.transport === "hosted" ? "include" : "same-origin",
      cache: "no-store",
      redirect: "error",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const authFailure = response.status === 401 || response.status === 403;
      throw new PublicSquareRequestError(
        authFailure ? "Team access changed. Refresh to check your access." : response.status === 409
          ? "This Team item changed elsewhere. Refresh to see the latest version."
          : "Public Square is temporarily unavailable.",
        response.status,
        isRecord(body) && typeof body.error === "string" ? body.error : null
      );
    }
    return body;
  }

  private async getCsrfToken(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    const response = await this.fetcher("/studio-api/projects/session", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" }
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body) || typeof body.csrfToken !== "string") {
      throw new PublicSquareRequestError("Public Square is temporarily unavailable.", response.status || 502);
    }
    this.csrfToken = body.csrfToken;
    return this.csrfToken;
  }
}

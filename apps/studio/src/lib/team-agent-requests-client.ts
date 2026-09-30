import {
  createTeamAgentRequestInputSchema,
  decideTeamAgentRequestInputSchema,
  postTeamAgentRequestOutcomeInputSchema,
  teamAgentOfferResponseSchema,
  teamAgentOffersResponseSchema,
  teamAgentRequestInboxSchema,
  teamAgentRequestPageSchema,
  teamAgentRequestResponseSchema,
  teamAgentRequestReviewResponseSchema,
  updateTeamAgentOfferInputSchema,
  updateTeamAgentRequestReviewInputSchema,
  withdrawTeamAgentRequestInputSchema,
  type CreateTeamAgentRequestInput,
  type DecideTeamAgentRequestInput,
  type PostTeamAgentRequestOutcomeInput,
  type TeamAgentOffer,
  type TeamAgentRequest,
  type TeamAgentRequestPage,
  type TeamAgentRequestReview,
  type UpdateTeamAgentOfferInput,
  type UpdateTeamAgentRequestReviewInput
} from "@koed/shared/team-agent-requests";

type Transport = "hosted" | "studio";
type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class TeamAgentRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "TeamAgentRequestError";
  }
}

/** Owner-private and Team-authorized Agent request operations for both shells. */
export class TeamAgentRequestsClient {
  private readonly fetcher: typeof fetch;
  private readonly transport: Transport;
  private csrfToken: string | null = null;

  constructor(transport: Transport, fetcher: typeof fetch = fetch) {
    this.transport = transport;
    this.fetcher = fetcher.bind(globalThis);
  }

  async listOffers(teamId: string): Promise<TeamAgentOffer[]> {
    const body = await this.request(`${this.teamPath(teamId)}/agent-offers`);
    const parsed = teamAgentOffersResponseSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.teamId !== teamId ||
      parsed.data.offers.some((offer) => offer.teamId !== teamId)
    ) {
      throw this.invalid("Team Agent offers");
    }
    return parsed.data.offers;
  }

  async setOffer(
    input: { teamId: string; agentId: string } & UpdateTeamAgentOfferInput
  ): Promise<TeamAgentOffer> {
    const payload = updateTeamAgentOfferInputSchema.safeParse({
      expectedVersion: input.expectedVersion,
      enabled: input.enabled,
      description: input.description
    });
    if (!payload.success) throw this.invalid("Team Agent offer update");
    const body = await this.request(
      `${this.teamPath(input.teamId)}/agent-offers/${encodeURIComponent(input.agentId)}`,
      {
        method: "PUT",
        body: payload.data
      }
    );
    const parsed = teamAgentOfferResponseSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.offer.teamId !== input.teamId ||
      parsed.data.offer.agentId !== input.agentId
    ) {
      throw this.invalid("Team Agent offer update");
    }
    return parsed.data.offer;
  }

  async listRequests(
    teamId: string,
    options: {
      teamProjectId?: string;
      channelId?: string;
      status?: TeamAgentRequest["status"];
      limit?: number;
      cursor?: string;
    } = {}
  ): Promise<TeamAgentRequestPage> {
    const query = new URLSearchParams();
    for (const key of [
      "teamProjectId",
      "channelId",
      "status",
      "limit",
      "cursor"
    ] as const) {
      const value = options[key];
      if (value !== undefined) query.set(key, String(value));
    }
    const body = await this.request(
      `${this.teamPath(teamId)}/agent-requests${query.size ? `?${query}` : ""}`
    );
    const parsed = teamAgentRequestPageSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.teamId !== teamId ||
      parsed.data.requests.some((request) => request.teamId !== teamId)
    ) {
      throw this.invalid("Team Agent requests");
    }
    return parsed.data;
  }

  async listInbox(
    teamId: string,
    options: { limit?: number; cursor?: string } = {}
  ): Promise<TeamAgentRequestPage> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    const body = await this.request(
      `${this.teamPath(teamId)}/agent-requests/inbox${query.size ? `?${query}` : ""}`
    );
    const parsed = teamAgentRequestInboxSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.teamId !== teamId ||
      parsed.data.requests.some((request) => request.teamId !== teamId)
    ) {
      throw this.invalid("Team Agent request inbox");
    }
    return parsed.data;
  }

  async createRequest(
    teamId: string,
    input: CreateTeamAgentRequestInput
  ): Promise<TeamAgentRequest> {
    const payload = createTeamAgentRequestInputSchema.safeParse(input);
    if (!payload.success) throw this.invalid("Team Agent request");
    const body = await this.request(`${this.teamPath(teamId)}/agent-requests`, {
      method: "POST",
      body: payload.data
    });
    const parsed = teamAgentRequestResponseSchema.safeParse(body);
    const request = parsed.success ? parsed.data.request : null;
    if (
      !request ||
      request.teamId !== teamId ||
      request.teamProjectId !== input.teamProjectId ||
      request.channelId !== input.channelId ||
      request.agentId !== input.agentId
    ) {
      throw this.invalid("Team Agent request");
    }
    return request;
  }

  async getReview(
    teamId: string,
    requestId: string
  ): Promise<TeamAgentRequestReview> {
    const body = await this.request(
      `${this.teamPath(teamId)}/agent-requests/${encodeURIComponent(requestId)}/review`
    );
    const parsed = teamAgentRequestReviewResponseSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.review.teamId !== teamId ||
      parsed.data.review.requestId !== requestId
    ) {
      throw this.invalid("private request review");
    }
    return parsed.data.review;
  }

  async updateReview(
    input: {
      teamId: string;
      requestId: string;
    } & UpdateTeamAgentRequestReviewInput
  ): Promise<TeamAgentRequestReview> {
    const payload = updateTeamAgentRequestReviewInputSchema.safeParse({
      expectedVersion: input.expectedVersion,
      privateGoal: input.privateGoal,
      executionId: input.executionId
    });
    if (!payload.success) throw this.invalid("private request review");
    const body = await this.request(
      `${this.teamPath(input.teamId)}/agent-requests/${encodeURIComponent(input.requestId)}/review`,
      {
        method: "PUT",
        body: payload.data
      }
    );
    const parsed = teamAgentRequestReviewResponseSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.review.teamId !== input.teamId ||
      parsed.data.review.requestId !== input.requestId
    ) {
      throw this.invalid("private request review");
    }
    return parsed.data.review;
  }

  async decideRequest(
    input: { teamId: string; requestId: string } & DecideTeamAgentRequestInput
  ): Promise<TeamAgentRequest> {
    const payload = decideTeamAgentRequestInputSchema.safeParse({
      expectedVersion: input.expectedVersion,
      decision: input.decision
    });
    if (!payload.success) throw this.invalid("Team Agent request decision");
    return this.requestForRequest(
      input.teamId,
      input.requestId,
      "PUT",
      "/decision",
      payload.data
    );
  }

  async withdrawRequest(input: {
    teamId: string;
    requestId: string;
    expectedVersion: number;
  }): Promise<TeamAgentRequest> {
    const payload = withdrawTeamAgentRequestInputSchema.safeParse({
      expectedVersion: input.expectedVersion
    });
    if (!payload.success) throw this.invalid("Team Agent request withdrawal");
    return this.requestForRequest(
      input.teamId,
      input.requestId,
      "DELETE",
      "",
      payload.data
    );
  }

  async postOutcome(
    input: {
      teamId: string;
      requestId: string;
    } & PostTeamAgentRequestOutcomeInput
  ): Promise<TeamAgentRequest> {
    const payload = postTeamAgentRequestOutcomeInputSchema.safeParse({
      expectedVersion: input.expectedVersion,
      summary: input.summary
    });
    if (!payload.success) throw this.invalid("Team Agent outcome");
    return this.requestForRequest(
      input.teamId,
      input.requestId,
      "POST",
      "/outcome",
      payload.data
    );
  }

  private async requestForRequest(
    teamId: string,
    requestId: string,
    method: "PUT" | "POST" | "DELETE",
    suffix: string,
    body: unknown
  ): Promise<TeamAgentRequest> {
    const response = await this.request(
      `${this.teamPath(teamId)}/agent-requests/${encodeURIComponent(requestId)}${suffix}`,
      { method, body }
    );
    const parsed = teamAgentRequestResponseSchema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.request.teamId !== teamId ||
      parsed.data.request.id !== requestId
    ) {
      throw this.invalid("Team Agent request update");
    }
    return parsed.data.request;
  }

  private teamPath(teamId: string): string {
    const team = `/teams/${encodeURIComponent(teamId)}`;
    return this.transport === "hosted"
      ? `/v1/collaboration${team}`
      : `/studio-api/collaboration${team}`;
  }

  private invalid(label: string): TeamAgentRequestError {
    return new TeamAgentRequestError(`Koed returned invalid ${label}.`, 502);
  }

  private async request(
    path: string,
    init: { method?: "GET" | "PUT" | "POST" | "DELETE"; body?: unknown } = {}
  ): Promise<unknown> {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (this.transport === "studio" && method !== "GET")
      headers["x-studio-csrf"] = await this.getCsrfToken();
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
      throw new TeamAgentRequestError(
        authFailure
          ? "Team access changed. Refresh to check your access."
          : response.status === 409
            ? "This Team request changed elsewhere. Refresh to see the latest version."
            : "Team Agent requests are temporarily unavailable.",
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
      throw new TeamAgentRequestError(
        "Team Agent requests are temporarily unavailable.",
        response.status || 502
      );
    }
    this.csrfToken = body.csrfToken;
    return this.csrfToken;
  }
}

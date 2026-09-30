import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import {
  decryptAuthorizedEncryptedFieldPayloadWithClient,
  decryptTeamEncryptedFieldAfterAuthorizationWithClient,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import { sendCollaborationMessageWithClient } from "./collaboration-repository.js";
import type { ActorContext } from "./types.js";

const REQUEST_REVIEW_COLUMN = "owner_review";
const OFFER_DESCRIPTION_MARKER =
  "[koed encrypted Team Agent offer description]";
const REQUEST_MESSAGE_MAX_BYTES = 8_000;
const REQUEST_REVIEW_MAX_BYTES = 12_000;
const MAX_PAGE_SIZE = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TeamAgentRequestStatus =
  | "awaiting_owner"
  | "accepted"
  | "declined"
  | "withdrawn"
  | "unavailable";
export interface TeamAgentOffer {
  teamId: string;
  agentId: string;
  ownerId: string;
  ownerName: string;
  agentName: string;
  description: string;
  enabled: boolean;
  version: number;
  canManage: boolean;
}
export interface TeamAgentOfferPage {
  teamId: string;
  items: TeamAgentOffer[];
  nextCursor: string | null;
  serverTime: string;
}
export interface TeamAgentRequest {
  id: string;
  teamId: string;
  teamProjectId: string;
  channelId: string;
  requestMessageId: string;
  requesterId: string;
  requesterName: string;
  ownerId: string;
  ownerName: string;
  agentId: string;
  agentName: string;
  status: TeamAgentRequestStatus;
  jobId: string | null;
  jobStatus:
    | "queued"
    | "running"
    | "waiting"
    | "succeeded"
    | "failed"
    | "canceled"
    | "interrupted"
    | "offline"
    | null;
  outcomeMessageId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  canWithdraw: boolean;
  canReview: boolean;
}
export interface TeamAgentRequestPage {
  teamId: string;
  requests: TeamAgentRequest[];
  nextCursor: string | null;
  serverTime: string;
}
export interface TeamAgentRequestReview {
  teamId: string;
  requestId: string;
  executionId: string | null;
  privateGoal: string;
  version: number;
}
export interface PendingTeamAgentRequestExecutionBinding {
  requestId: string;
  teamId: string;
  teamProjectId: string;
  ownerUserId: string;
  agentId: string;
  agentVersion: number;
  localProjectId: string;
  privateGoal: string;
}
export interface TeamAgentRequestInvalidation {
  type: "team_agent_request_invalidated";
  teamId: string;
  requestId: string | null;
  channelId: string | null;
  ownerId: string | null;
  kind: "request" | "offers";
}

export class TeamAgentRequestVersionConflictError extends Error {
  readonly statusCode = 409;

  constructor(message = "Team Agent Request changed concurrently") {
    super(message);
    this.name = "TeamAgentRequestVersionConflictError";
  }
}

export class TeamAgentRequestUnavailableError extends Error {
  readonly statusCode = 404;

  constructor(message = "Team Agent Request is not available") {
    super(message);
    this.name = "TeamAgentRequestUnavailableError";
  }
}

export interface TeamAgentRequestJobContext {
  requestId: string;
  teamId: string;
  teamProjectId: string;
  ownerUserId: string;
  agentId: string;
  agentVersion: number;
  localProjectId: string;
  executionId: string;
  privateGoal: string;
  idempotencyKey: string;
}

export type CreateOwnerJobWithClient = (
  client: pg.PoolClient,
  input: TeamAgentRequestJobContext
) => Promise<{ jobId: string }>;

export interface TeamAgentRequestsRepository {
  listOffers(
    actor: ActorContext,
    input: { teamId: string; limit?: number; cursor?: string }
  ): Promise<TeamAgentOfferPage | null>;
  updateOffer(
    actor: ActorContext,
    input: {
      teamId: string;
      agentId: string;
      expectedVersion: number;
      enabled: boolean;
      description: string;
    }
  ): Promise<TeamAgentOffer | null>;
  createRequest(
    actor: ActorContext,
    input: {
      teamId: string;
      idempotencyKey: string;
      teamProjectId: string;
      channelId: string;
      agentId: string;
      requestText: string;
    }
  ): Promise<TeamAgentRequest | null>;
  listRequests(
    actor: ActorContext,
    input: {
      teamId: string;
      teamProjectId?: string;
      channelId?: string;
      status?: TeamAgentRequestStatus;
      limit?: number;
      cursor?: string;
      inbox?: boolean;
    }
  ): Promise<TeamAgentRequestPage | null>;
  getReview(
    actor: ActorContext,
    input: { teamId: string; requestId: string }
  ): Promise<TeamAgentRequestReview | null>;
  getAwaitingOwnerRequestForExecution(
    actor: ActorContext,
    input: { executionId: string }
  ): Promise<PendingTeamAgentRequestExecutionBinding | null>;
  getAcceptedRequestForExecution(
    actor: ActorContext,
    input: { teamId: string; requestId: string; executionId: string }
  ): Promise<TeamAgentRequest | null>;
  bindOwnerReviewExecutionWithClient(
    client: pg.PoolClient,
    actor: ActorContext,
    input: {
      teamId: string;
      requestId: string;
      expectedRequestVersion: number;
      expectedReviewVersion: number;
      executionId: string;
    }
  ): Promise<PendingTeamAgentRequestExecutionBinding | null>;
  updateReview(
    actor: ActorContext,
    input: {
      teamId: string;
      requestId: string;
      expectedVersion: number;
      privateGoal: string;
      executionId: string | null;
    }
  ): Promise<TeamAgentRequestReview | null>;
  decideRequest(
    actor: ActorContext,
    input: {
      teamId: string;
      requestId: string;
      expectedVersion: number;
      decision: "accept" | "decline";
    },
    createOwnerJob: CreateOwnerJobWithClient
  ): Promise<TeamAgentRequest | null>;
  withdrawRequest(
    actor: ActorContext,
    input: { teamId: string; requestId: string; expectedVersion: number }
  ): Promise<TeamAgentRequest | null>;
  postOutcome(
    actor: ActorContext,
    input: {
      teamId: string;
      requestId: string;
      expectedVersion: number;
      summary: string;
    }
  ): Promise<TeamAgentRequest | null>;
  materializeRealtimeInvalidation(
    actor: ActorContext,
    input: { teamId: string; resourceType: string; resourceId: string }
  ): Promise<TeamAgentRequestInvalidation | null>;
}

interface RequestRow {
  id: string;
  team_id: string;
  team_project_id: string;
  channel_id: string;
  request_message_id: string;
  requester_user_id: string;
  requester_name: string | null;
  owner_user_id: string;
  owner_name: string | null;
  agent_id: string;
  agent_version: number;
  agent_name: string;
  status: TeamAgentRequestStatus;
  job_id: string | null;
  job_status: string | null;
  job_shared: boolean;
  outcome_message_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  offer_enabled: boolean;
  project_active: boolean;
}

interface OfferRow {
  id: string;
  team_id: string;
  agent_id: string;
  owner_user_id: string;
  owner_name: string | null;
  agent_name: string;
  description_marker: string;
  enabled: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const digestRequest = (value: unknown): string => hash(JSON.stringify(value));

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const statusError = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

const boundedPage = (value: number | undefined): number => {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw statusError("Page limit is invalid", 400);
  }
  return value;
};

const encodeCursor = (createdAt: Date, id: string): string =>
  Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string | undefined): [Date, string] | null => {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [timestamp, id, ...extra] = decoded.split("|");
    const date = timestamp ? new Date(timestamp) : null;
    if (
      extra.length ||
      !date ||
      !Number.isFinite(date.getTime()) ||
      !id ||
      !UUID_PATTERN.test(id) ||
      Buffer.from(cursor, "base64url").toString("base64url") !== cursor
    ) {
      throw new Error("bad cursor");
    }
    return [date, id];
  } catch {
    throw statusError("Invalid Team Agent Request cursor", 400);
  }
};

const activeTeamMember = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  teamId: string,
  lock: boolean
): Promise<{ role: string } | null> => {
  const result = await client.query<{ role: string }>(
    `select tm.role
       from team_memberships tm
       join teams t on t.id = tm.team_id
       join users u on u.id = tm.user_id
      where tm.team_id = $1 and tm.user_id = $2
        and tm.status = 'enabled' and tm.disabled_at is null
        and t.lifecycle = 'active' and t.entitlement_status in ('active','grace')
        and u.disabled_at is null and u.deleted_at is null
      ${lock ? "for share of tm" : ""}`,
    [teamId, actor.userId]
  );
  return result.rows[0] ?? null;
};

const activeTeamMembers = async (
  client: pg.PoolClient,
  teamId: string,
  userIds: string[]
): Promise<boolean> => {
  const orderedIds = [...new Set(userIds)].sort();
  const result = await client.query<{ user_id: string }>(
    `select tm.user_id
       from team_memberships tm
       join teams t on t.id=tm.team_id
       join users u on u.id=tm.user_id
      where tm.team_id=$1 and tm.user_id=any($2::uuid[])
        and tm.status='enabled' and tm.disabled_at is null
        and t.lifecycle='active' and t.entitlement_status in ('active','grace')
        and u.disabled_at is null and u.deleted_at is null
      order by tm.user_id for share of tm`,
    [teamId, orderedIds]
  );
  return result.rows.length === orderedIds.length;
};

const requireCurrentProject = async (
  client: pg.PoolClient,
  input: { teamId: string; teamProjectId: string }
): Promise<boolean> => {
  const result = await client.query(
    `select id from collaboration_team_shared_projects
      where id=$1 and team_id=$2 and unshared_at is null
      for share`,
    [input.teamProjectId, input.teamId]
  );
  return result.rowCount === 1;
};

const requireRequestChannel = async (
  client: pg.PoolClient,
  input: { teamId: string; teamProjectId: string; channelId: string }
): Promise<boolean> => {
  const result = await client.query<{
    kind: string;
    team_project_id: string | null;
  }>(
    `select kind, team_project_id from collaboration_threads
      where id=$1 and team_id=$2 and scope='team' and lifecycle='active'
        and kind in ('team_channel','team_project_channel')
      for share`,
    [input.channelId, input.teamId]
  );
  const row = result.rows[0];
  if (!row) return false;
  if (row.kind === "team_channel") return true;
  return (
    row.team_project_id === input.teamProjectId &&
    (await requireCurrentProject(client, input))
  );
};

const teamProvider = (options: {
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  teamEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider;
}): EnvelopeEncryptionProvider => {
  const provider =
    options.teamEnvelopeEncryptionProvider ??
    options.envelopeEncryptionProvider;
  if (!provider) throw new Error("Team encryption provider is required");
  return provider;
};

const personalProvider = (options: {
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
}): EnvelopeEncryptionProvider => {
  if (!options.envelopeEncryptionProvider)
    throw new Error("Owner encryption provider is required");
  return options.envelopeEncryptionProvider;
};

const offerSelect = `
  select o.id,o.team_id,o.agent_id,o.owner_user_id,u.display_name as owner_name,
         i.name as agent_name,o.description_marker,o.enabled,o.version,o.created_at,o.updated_at
    from team_agent_offers o
    join personal_agent_identities i on i.id=o.agent_id and i.owner_user_id=o.owner_user_id
    join users u on u.id=o.owner_user_id
`;

const requestSelect = `
  select r.id,r.team_id,r.team_project_id,r.channel_id,r.request_message_id,
         r.requester_user_id,requester.display_name as requester_name,
         r.owner_user_id,owner.display_name as owner_name,r.agent_id,r.agent_version,r.agent_name,
         r.status,r.job_id,
         case when j.id is null then null
              when pub.state='frozen' then coalesce(pub.frozen_status,pub.last_known_status)
              when j.state in ('queued','running') and e.state='failed' then 'failed'
              when j.state in ('queued','running') and pub.state='active' and exists (
                select 1 from managed_conversation_runtime_items ri
                 where ri.execution_id=j.conversation_id and ri.owner_user_id=j.owner_user_id and ri.state='pending'
              ) then 'waiting'
              when j.state='running' and pub.state='active' and e.runner_lease_expires_at <= now() then 'offline'
              else j.state end as job_status,
         coalesce(pub.state in ('active','frozen'),false) as job_shared,
         r.outcome_message_id,r.version,r.created_at,r.updated_at,
         coalesce(o.enabled,false) as offer_enabled,
         (sp.unshared_at is null) as project_active
    from team_agent_requests r
    join users requester on requester.id=r.requester_user_id
    join users owner on owner.id=r.owner_user_id
    left join personal_agent_execution_jobs j on j.id=r.job_id and j.owner_user_id=r.owner_user_id
    left join personal_agent_team_job_publications pub on pub.job_id=j.id and pub.owner_user_id=j.owner_user_id and pub.team_id=r.team_id and pub.team_project_id=r.team_project_id and pub.state in ('active','frozen')
    left join managed_conversation_executions e on e.id=j.conversation_id and e.owner_user_id=j.owner_user_id
    left join team_agent_offers o on o.team_id=r.team_id and o.owner_user_id=r.owner_user_id and o.agent_id=r.agent_id
    join collaboration_team_shared_projects sp on sp.id=r.team_project_id and sp.team_id=r.team_id
`;

const mapRequest = (row: RequestRow, viewerId: string): TeamAgentRequest => ({
  id: row.id,
  teamId: row.team_id,
  teamProjectId: row.team_project_id,
  channelId: row.channel_id,
  requestMessageId: row.request_message_id,
  requesterId: row.requester_user_id,
  requesterName: row.requester_name?.trim() || "Team member",
  ownerId: row.owner_user_id,
  ownerName: row.owner_name?.trim() || "Team member",
  agentId: row.agent_id,
  agentName: row.agent_name,
  status: row.status,
  jobId: row.job_shared ? row.job_id : null,
  jobStatus: row.job_shared
    ? (row.job_status as TeamAgentRequest["jobStatus"])
    : null,
  outcomeMessageId: row.outcome_message_id,
  version: row.version,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  canWithdraw:
    viewerId === row.requester_user_id && row.status === "awaiting_owner",
  canReview:
    viewerId === row.owner_user_id &&
    row.status === "awaiting_owner" &&
    row.offer_enabled &&
    row.project_active
});

const mapOffer = async (
  client: pg.Pool | pg.PoolClient,
  options: {
    teamEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider;
    envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  },
  row: OfferRow,
  viewerId: string
): Promise<TeamAgentOffer> => {
  const description =
    await decryptTeamEncryptedFieldAfterAuthorizationWithClient(
      client,
      teamProvider(options),
      {
        sourceTable: "team_agent_offers",
        sourceId: row.id,
        sourceColumn: "description",
        teamId: row.team_id
      }
    );
  return {
    teamId: row.team_id,
    agentId: row.agent_id,
    ownerId: row.owner_user_id,
    ownerName: row.owner_name?.trim() || "Team member",
    agentName: row.agent_name,
    description: typeof description === "string" ? description : "",
    enabled: row.enabled,
    version: row.version,
    canManage: viewerId === row.owner_user_id
  };
};

const parsePrivateReview = (
  value: unknown,
  input: { teamId: string; requestId: string }
): { privateGoal: string; executionId: string | null; version: number } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { privateGoal: "", executionId: null, version: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    privateGoal:
      typeof record.privateGoal === "string" &&
      Buffer.byteLength(record.privateGoal, "utf8") <= REQUEST_REVIEW_MAX_BYTES
        ? record.privateGoal
        : "",
    executionId:
      typeof record.executionId === "string" &&
      UUID_PATTERN.test(record.executionId)
        ? record.executionId
        : null,
    version:
      Number.isSafeInteger(record.version) && Number(record.version) >= 0
        ? Number(record.version)
        : 0
  };
};

const readPrivateReview = async (
  client: pg.PoolClient,
  actor: ActorContext,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider },
  requestId: string,
  teamId: string
) => {
  const stored = await decryptAuthorizedEncryptedFieldPayloadWithClient(
    client,
    actor,
    personalProvider(options),
    {
      sourceTable: "team_agent_requests",
      sourceId: requestId,
      sourceColumn: REQUEST_REVIEW_COLUMN
    }
  );
  return parsePrivateReview(stored?.plaintext, { teamId, requestId });
};

const requestReviewDto = (
  input: { teamId: string; requestId: string },
  review: { privateGoal: string; executionId: string | null; version: number }
): TeamAgentRequestReview => ({ ...input, ...review });

const ensureReviewRequest = async (
  client: pg.PoolClient,
  actor: ActorContext,
  input: { teamId: string; requestId: string },
  lock: boolean,
  allowClosed = false
): Promise<RequestRow | null> => {
  const statusClause = allowClosed
    ? "r.status in ('awaiting_owner','accepted','declined','withdrawn','unavailable')"
    : "r.status='awaiting_owner'";
  const preflight = await client.query<RequestRow>(
    `${requestSelect}
      where r.id=$1 and r.team_id=$2 and r.owner_user_id=$3
        and ${statusClause}`,
    [input.requestId, input.teamId, actor.userId]
  );
  const request = preflight.rows[0];
  if (
    !request ||
    !(await activeTeamMember(client, actor, request.team_id, true))
  )
    return null;
  if (
    request.status === "awaiting_owner" &&
    (!(await activeTeamMembers(client, request.team_id, [
      actor.userId,
      request.requester_user_id
    ])) ||
      !(await requireCurrentProject(client, {
        teamId: request.team_id,
        teamProjectId: request.team_project_id
      })))
  )
    return null;
  const offer = await client.query(
    `select 1 from team_agent_offers o
      join personal_agent_identities i on i.id=o.agent_id and i.owner_user_id=o.owner_user_id
     where o.team_id=$1 and o.owner_user_id=$2 and o.agent_id=$3
       and o.enabled=true and i.lifecycle='active'
     for share of o,i`,
    [request.team_id, request.owner_user_id, request.agent_id]
  );
  if (
    request.status === "awaiting_owner" &&
    (!request.offer_enabled || offer.rowCount !== 1)
  )
    return null;
  const locked = await client.query<RequestRow>(
    `${requestSelect}
      where r.id=$1 and r.team_id=$2 and r.owner_user_id=$3
        and ${statusClause}
      ${lock ? "for update of r" : ""}`,
    [input.requestId, input.teamId, actor.userId]
  );
  const requestRow = locked.rows[0];
  if (!requestRow) return null;
  if (!(await requireRequestChannel(client, inputChannel(requestRow))))
    return null;
  return requestRow;
};

const inputChannel = (row: RequestRow) => ({
  teamId: row.team_id,
  teamProjectId: row.team_project_id,
  channelId: row.channel_id
});

export const createTeamAgentRequestsRepository = (
  pool: pg.Pool,
  options: {
    envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
    teamEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  }
): TeamAgentRequestsRepository => ({
  async listOffers(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read");
      if (!(await activeTeamMember(client, actor, input.teamId, true))) {
        await client.query("rollback");
        return null;
      }
      const limit = boundedPage(input.limit ?? 100);
      const cursor = decodeCursor(input.cursor);
      const result = await client.query<OfferRow>(
        `${offerSelect}
          where o.team_id=$1 and i.lifecycle='active'
            and (o.enabled or o.owner_user_id=$2)
            and ($3::timestamptz is null or (o.created_at,o.id)<($3,$4::uuid))
          order by o.created_at desc,o.id desc limit $5`,
        [
          input.teamId,
          actor.userId,
          cursor?.[0] ?? null,
          cursor?.[1] ?? null,
          limit + 1
        ]
      );
      const pageRows = result.rows.slice(0, limit);
      const items = await Promise.all(
        pageRows.map((row) => mapOffer(client, options, row, actor.userId))
      );
      const last = pageRows.at(-1);
      await client.query("commit");
      return {
        teamId: input.teamId,
        items,
        nextCursor:
          result.rows.length > limit && last
            ? encodeCursor(last.created_at, last.id)
            : null,
        serverTime: new Date().toISOString()
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async updateOffer(actor, input) {
    if (Buffer.byteLength(input.description, "utf8") > 500) {
      throw statusError("Agent offer description is too long", 400);
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      if (!(await activeTeamMember(client, actor, input.teamId, true))) {
        await client.query("rollback");
        return null;
      }
      const identity = await client.query<{
        name: string;
        lifecycle: string;
        current_version: number;
      }>(
        `select name,lifecycle,current_version from personal_agent_identities
          where id=$1 and owner_user_id=$2 for update`,
        [input.agentId, actor.userId]
      );
      const agent = identity.rows[0];
      if (!agent || agent.lifecycle !== "active") {
        throw new TeamAgentRequestUnavailableError("Agent is unavailable");
      }
      const existing = await client.query<{ id: string; version: number }>(
        `select id,version from team_agent_offers
          where team_id=$1 and owner_user_id=$2 and agent_id=$3 for update`,
        [input.teamId, actor.userId, input.agentId]
      );
      const current = existing.rows[0];
      if ((current?.version ?? 0) !== input.expectedVersion) {
        throw new TeamAgentRequestVersionConflictError(
          "Agent offer version changed"
        );
      }
      const offerId = current?.id ?? randomUUID();
      const nextVersion = input.expectedVersion + 1;
      if (current) {
        await client.query(
          `update team_agent_offers set enabled=$4,version=$5,updated_at=now()
            where id=$1 and team_id=$2 and owner_user_id=$3`,
          [offerId, input.teamId, actor.userId, input.enabled, nextVersion]
        );
      } else {
        await client.query(
          `insert into team_agent_offers (id,team_id,owner_user_id,agent_id,enabled,version)
            values ($1,$2,$3,$4,$5,$6)`,
          [
            offerId,
            input.teamId,
            actor.userId,
            input.agentId,
            input.enabled,
            nextVersion
          ]
        );
      }
      await upsertEncryptedFieldPayloadWithClient(
        client,
        actor,
        teamProvider(options),
        {
          sourceTable: "team_agent_offers",
          sourceId: offerId,
          sourceColumn: "description",
          plaintext: input.description,
          visibility: "team",
          teamId: input.teamId,
          scope: { teamId: input.teamId, objectClass: "team_agent_offer" },
          rowFamily: "team_agent_offer",
          aad: { teamId: input.teamId, offerId, agentId: input.agentId }
        }
      );
      const selected = await client.query<OfferRow>(
        `${offerSelect} where o.id=$1 and o.team_id=$2`,
        [offerId, input.teamId]
      );
      const result = selected.rows[0];
      if (!result) throw new Error("Team Agent offer was not saved");
      const offer = await mapOffer(client, options, result, actor.userId);
      await client.query("commit");
      return offer;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async createRequest(actor, input) {
    if (
      Buffer.byteLength(input.requestText, "utf8") >
        REQUEST_MESSAGE_MAX_BYTES ||
      !input.idempotencyKey.trim()
    ) {
      throw statusError("Agent request is invalid", 400);
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const keyHash = hash(
        `team-agent-request-idempotency:v1\n${input.teamId}\n${actor.userId}\n${input.idempotencyKey}`
      );
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended($1,0))`,
        [keyHash]
      );
      const duplicate = await client.query<{
        id: string;
        request_hash: string;
      }>(
        `select id,request_hash from team_agent_requests
          where team_id=$1 and requester_user_id=$2 and idempotency_key_hash=$3`,
        [input.teamId, actor.userId, keyHash]
      );
      const requestHash = digestRequest({
        teamProjectId: input.teamProjectId,
        channelId: input.channelId,
        agentId: input.agentId,
        requestText: input.requestText
      });
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].request_hash !== requestHash) {
          throw statusError("Request idempotency key was reused", 409);
        }
        const page = await client.query<RequestRow>(
          `${requestSelect} where r.id=$1 and r.team_id=$2`,
          [duplicate.rows[0].id, input.teamId]
        );
        if (!(await activeTeamMember(client, actor, input.teamId, true))) {
          await client.query("rollback");
          return null;
        }
        const duplicateRow = page.rows[0];
        if (
          !duplicateRow ||
          !(await requireRequestChannel(client, inputChannel(duplicateRow)))
        ) {
          await client.query("rollback");
          return null;
        }
        await client.query("commit");
        return mapRequest(duplicateRow, actor.userId);
      }
      const offerHint = await client.query<{ owner_user_id: string }>(
        `select owner_user_id from team_agent_offers
          where team_id=$1 and agent_id=$2`,
        [input.teamId, input.agentId]
      );
      const ownerUserId = offerHint.rows[0]?.owner_user_id;
      if (
        !ownerUserId ||
        ownerUserId === actor.userId ||
        !(await activeTeamMembers(client, input.teamId, [
          actor.userId,
          ownerUserId
        ]))
      ) {
        await client.query("rollback");
        return null;
      }
      if (!(await requireCurrentProject(client, input))) {
        throw new TeamAgentRequestUnavailableError(
          "Team Project is unavailable"
        );
      }
      const offer = await client.query<{
        id: string;
        owner_user_id: string;
        agent_name: string;
        agent_version: number;
      }>(
        `select o.id,o.owner_user_id,i.name as agent_name,i.current_version as agent_version
           from team_agent_offers o
           join personal_agent_identities i on i.id=o.agent_id and i.owner_user_id=o.owner_user_id
          where o.team_id=$1 and o.agent_id=$2 and o.enabled=true and i.lifecycle='active'
          for share of o,i`,
        [input.teamId, input.agentId]
      );
      const offered = offer.rows[0];
      if (!offered || offered.owner_user_id !== ownerUserId) {
        throw new TeamAgentRequestUnavailableError(
          "Offered Agent is unavailable"
        );
      }
      if (!(await requireRequestChannel(client, input))) {
        throw new TeamAgentRequestUnavailableError(
          "Team channel is unavailable"
        );
      }
      const requestId = randomUUID();
      const message = await sendCollaborationMessageWithClient(
        client,
        actor,
        teamProvider(options),
        {
          threadId: input.channelId,
          idempotencyKey: `team-agent-request:${input.teamId}:${actor.userId}:${input.idempotencyKey}`,
          bodyText: input.requestText,
          metadata: {
            kind: "team_agent_request",
            requestId,
            teamProjectId: input.teamProjectId,
            agentId: input.agentId
          },
          provenance: { kind: "team_agent_request", id: requestId }
        }
      );
      if (!message)
        throw new TeamAgentRequestUnavailableError(
          "Team channel is unavailable"
        );
      await client.query(
        `insert into team_agent_requests (
           id,team_id,team_project_id,channel_id,request_message_id,
           requester_user_id,owner_user_id,agent_id,agent_version,agent_name,
           status,idempotency_key_hash,request_hash,version
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'awaiting_owner',$11,$12,1)`,
        [
          requestId,
          input.teamId,
          input.teamProjectId,
          input.channelId,
          message.id,
          actor.userId,
          offered.owner_user_id,
          input.agentId,
          offered.agent_version,
          offered.agent_name,
          keyHash,
          requestHash
        ]
      );
      await upsertEncryptedFieldPayloadWithClient(
        client,
        { userId: offered.owner_user_id },
        personalProvider(options),
        {
          sourceTable: "team_agent_requests",
          sourceId: requestId,
          sourceColumn: REQUEST_REVIEW_COLUMN,
          plaintext: { privateGoal: "", executionId: null, version: 0 },
          visibility: "personal",
          scope: { objectClass: "team_agent_request_owner_review" },
          rowFamily: "team_agent_request_owner_review",
          aad: {
            teamId: input.teamId,
            requestId,
            ownerUserId: offered.owner_user_id
          }
        }
      );
      const row = await client.query<RequestRow>(
        `${requestSelect} where r.id=$1 and r.team_id=$2 and sp.unshared_at is null`,
        [requestId, input.teamId]
      );
      const created = row.rows[0];
      if (!created) throw new Error("Team Agent Request insert failed");
      await client.query("commit");
      return mapRequest(created, actor.userId);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async listRequests(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read");
      if (!(await activeTeamMember(client, actor, input.teamId, true))) {
        await client.query("rollback");
        return null;
      }
      const limit = boundedPage(input.limit);
      const cursor = decodeCursor(input.cursor);
      const filters: string[] = ["r.team_id=$1"];
      const values: unknown[] = [input.teamId];
      if (input.inbox) {
        values.push(actor.userId);
        filters.push(`r.owner_user_id=$${values.length}`);
      }
      if (input.teamProjectId) {
        values.push(input.teamProjectId);
        filters.push(`r.team_project_id=$${values.length}`);
      }
      if (input.channelId) {
        values.push(input.channelId);
        filters.push(`r.channel_id=$${values.length}`);
      }
      if (input.status) {
        values.push(input.status);
        filters.push(`r.status=$${values.length}`);
      }
      if (cursor) {
        values.push(cursor[0], cursor[1]);
        filters.push(
          `(r.created_at,r.id)<($${values.length - 1},$${values.length}::uuid)`
        );
      }
      values.push(limit + 1);
      const rows = await client.query<RequestRow>(
        `${requestSelect}
          join collaboration_threads ct on ct.id=r.channel_id and ct.team_id=r.team_id
         where ${filters.join(" and ")}
           and ct.lifecycle='active'
           and ct.kind in ('team_channel','team_project_channel')
           and (ct.kind='team_channel' or (ct.team_project_id=r.team_project_id and sp.unshared_at is null))
         order by r.created_at desc,r.id desc limit $${values.length}`,
        values
      );
      const pageRows = rows.rows.slice(0, limit);
      const last = pageRows.at(-1);
      await client.query("commit");
      return {
        teamId: input.teamId,
        requests: pageRows.map((row) => mapRequest(row, actor.userId)),
        nextCursor:
          rows.rows.length > limit && last
            ? encodeCursor(last.created_at, last.id)
            : null,
        serverTime: new Date().toISOString()
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getReview(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read");
      const row = await ensureReviewRequest(client, actor, input, true, true);
      if (!row) {
        await client.query("rollback");
        return null;
      }
      const review = await readPrivateReview(
        client,
        actor,
        options,
        row.id,
        row.team_id
      );
      await client.query("commit");
      return requestReviewDto(input, review);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getAwaitingOwnerRequestForExecution(actor, input) {
    if (!UUID_PATTERN.test(input.executionId)) return null;
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read");
      const pending = await client.query<{
        id: string;
        team_id: string;
        team_project_id: string;
        channel_id: string;
        requester_user_id: string;
        owner_user_id: string;
        agent_id: string;
        agent_version: number;
      }>(
        `select id,team_id,team_project_id,channel_id,requester_user_id,owner_user_id,agent_id,agent_version
           from team_agent_requests
          where owner_user_id=$1 and status='awaiting_owner'
          order by created_at asc,id asc`,
        [actor.userId]
      );
      for (const request of pending.rows) {
        if (
          !(await activeTeamMembers(client, request.team_id, [
            request.owner_user_id,
            request.requester_user_id
          ])) ||
          !(await requireCurrentProject(client, {
            teamId: request.team_id,
            teamProjectId: request.team_project_id
          })) ||
          !(await requireRequestChannel(client, {
            teamId: request.team_id,
            teamProjectId: request.team_project_id,
            channelId: request.channel_id
          }))
        )
          continue;
        const offer = await client.query<{ current_version: number }>(
          `select i.current_version from team_agent_offers o
             join personal_agent_identities i on i.id=o.agent_id and i.owner_user_id=o.owner_user_id
            where o.team_id=$1 and o.owner_user_id=$2 and o.agent_id=$3
              and o.enabled=true and i.lifecycle='active'
            for share of o,i`,
          [request.team_id, request.owner_user_id, request.agent_id]
        );
        const currentAgentVersion = offer.rows[0]?.current_version;
        if (!currentAgentVersion || !Number.isSafeInteger(currentAgentVersion))
          continue;
        const connection = await client.query<{ local_project_id: string }>(
          `select local_project_id from public_square_project_connections
            where actor_user_id=$1 and team_id=$2 and team_project_id=$3
              and local_project_id is not null for share`,
          [actor.userId, request.team_id, request.team_project_id]
        );
        const localProjectId = connection.rows[0]?.local_project_id;
        if (!localProjectId) continue;
        const review = await readPrivateReview(
          client,
          actor,
          options,
          request.id,
          request.team_id
        );
        if (review.executionId !== input.executionId) continue;
        await client.query("commit");
        return {
          requestId: request.id,
          teamId: request.team_id,
          teamProjectId: request.team_project_id,
          ownerUserId: request.owner_user_id,
          agentId: request.agent_id,
          agentVersion: currentAgentVersion,
          localProjectId,
          privateGoal: review.privateGoal
        };
      }
      await client.query("commit");
      return null;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getAcceptedRequestForExecution(actor, input) {
    if (
      !UUID_PATTERN.test(input.teamId) ||
      !UUID_PATTERN.test(input.requestId) ||
      !UUID_PATTERN.test(input.executionId)
    ) {
      return null;
    }
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read");
      const row = await ensureReviewRequest(
        client,
        actor,
        { teamId: input.teamId, requestId: input.requestId },
        true,
        true
      );
      if (
        !row ||
        row.status !== "accepted" ||
        !(await requireCurrentProject(client, {
          teamId: row.team_id,
          teamProjectId: row.team_project_id
        }))
      ) {
        await client.query("rollback");
        return null;
      }
      const review = await readPrivateReview(
        client,
        actor,
        options,
        row.id,
        row.team_id
      );
      if (review.executionId !== input.executionId) {
        await client.query("rollback");
        return null;
      }
      await client.query("commit");
      return mapRequest(row, actor.userId);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async bindOwnerReviewExecutionWithClient(client, actor, input) {
    if (
      !UUID_PATTERN.test(input.teamId) ||
      !UUID_PATTERN.test(input.requestId) ||
      !UUID_PATTERN.test(input.executionId) ||
      !Number.isSafeInteger(input.expectedRequestVersion) ||
      input.expectedRequestVersion < 0 ||
      !Number.isSafeInteger(input.expectedReviewVersion) ||
      input.expectedReviewVersion < 0
    ) {
      throw statusError("Owner review binding is invalid", 400);
    }
    const row = await ensureReviewRequest(
      client,
      actor,
      { teamId: input.teamId, requestId: input.requestId },
      true
    );
    if (!row) return null;
    if (row.version !== input.expectedRequestVersion) {
      throw new TeamAgentRequestVersionConflictError();
    }

    const identity = await client.query<{ current_version: number }>(
      `select i.current_version from team_agent_offers o
         join personal_agent_identities i on i.id=o.agent_id and i.owner_user_id=o.owner_user_id
        where o.team_id=$1 and o.owner_user_id=$2 and o.agent_id=$3
          and o.enabled=true and i.lifecycle='active'
        for share of o,i`,
      [row.team_id, row.owner_user_id, row.agent_id]
    );
    const currentAgentVersion = identity.rows[0]?.current_version;
    if (!currentAgentVersion || !Number.isSafeInteger(currentAgentVersion)) {
      throw statusError("Offered Agent changed; reload this request", 409);
    }

    const connection = await client.query<{
      local_project_id: string;
    }>(
      `select local_project_id
         from public_square_project_connections
        where actor_user_id=$1 and team_id=$2 and team_project_id=$3
          and local_project_id is not null
        for update`,
      [actor.userId, row.team_id, row.team_project_id]
    );
    const localProjectId = connection.rows[0]?.local_project_id;
    if (!localProjectId) {
      throw statusError("Owner must connect this Team Project first", 409);
    }

    const review = await readPrivateReview(
      client,
      actor,
      options,
      row.id,
      row.team_id
    );
    if (review.version !== input.expectedReviewVersion) {
      throw new TeamAgentRequestVersionConflictError(
        "Owner review changed concurrently"
      );
    }
    if (!review.privateGoal.trim()) {
      throw statusError("Owner must refine the private Agent goal first", 409);
    }
    const nextReview = {
      ...review,
      executionId: input.executionId,
      version: review.version + 1
    };
    await upsertEncryptedFieldPayloadWithClient(
      client,
      actor,
      personalProvider(options),
      {
        sourceTable: "team_agent_requests",
        sourceId: row.id,
        sourceColumn: REQUEST_REVIEW_COLUMN,
        plaintext: nextReview,
        visibility: "personal",
        scope: { objectClass: "team_agent_request_owner_review" },
        rowFamily: "team_agent_request_owner_review",
        aad: {
          teamId: row.team_id,
          requestId: row.id,
          ownerUserId: actor.userId
        }
      }
    );
    return {
      requestId: row.id,
      teamId: row.team_id,
      teamProjectId: row.team_project_id,
      ownerUserId: row.owner_user_id,
      agentId: row.agent_id,
      // The request keeps the version that was offered when it was created.
      // Review runs against the owner's currently selected profile version.
      agentVersion: currentAgentVersion,
      localProjectId,
      privateGoal: nextReview.privateGoal
    };
  },

  async updateReview(actor, input) {
    if (
      Buffer.byteLength(input.privateGoal, "utf8") > REQUEST_REVIEW_MAX_BYTES ||
      (input.executionId !== null && !UUID_PATTERN.test(input.executionId))
    ) {
      throw statusError("Private Agent review is invalid", 400);
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const row = await ensureReviewRequest(client, actor, input, true);
      if (!row) {
        await client.query("rollback");
        return null;
      }
      const current = await readPrivateReview(
        client,
        actor,
        options,
        row.id,
        row.team_id
      );
      if (current.version !== input.expectedVersion) {
        throw new TeamAgentRequestVersionConflictError(
          "Owner review changed concurrently"
        );
      }
      if (
        current.executionId !== null &&
        input.executionId !== current.executionId
      ) {
        throw new TeamAgentRequestVersionConflictError(
          "Owner review is bound to another Agent execution"
        );
      }
      const next = {
        privateGoal: input.privateGoal,
        executionId: input.executionId,
        version: current.version + 1
      };
      await upsertEncryptedFieldPayloadWithClient(
        client,
        actor,
        personalProvider(options),
        {
          sourceTable: "team_agent_requests",
          sourceId: row.id,
          sourceColumn: REQUEST_REVIEW_COLUMN,
          plaintext: next,
          visibility: "personal",
          scope: { objectClass: "team_agent_request_owner_review" },
          rowFamily: "team_agent_request_owner_review",
          aad: {
            teamId: row.team_id,
            requestId: row.id,
            ownerUserId: actor.userId
          }
        }
      );
      await client.query("commit");
      return requestReviewDto(input, next);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async decideRequest(actor, input, createOwnerJob) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const replay = await client.query<RequestRow>(
        `${requestSelect} where r.id=$1 and r.team_id=$2 and r.owner_user_id=$3`,
        [input.requestId, input.teamId, actor.userId]
      );
      const prior = replay.rows[0];
      if (
        prior &&
        (await activeTeamMember(client, actor, prior.team_id, true))
      ) {
        if (await requireRequestChannel(client, inputChannel(prior))) {
          const replayStatus =
            input.decision === "accept" ? "accepted" : "declined";
          if (
            prior.status === replayStatus &&
            prior.version === input.expectedVersion + 1
          ) {
            await client.query("commit");
            return mapRequest(prior, actor.userId);
          }
          if (prior.status !== "awaiting_owner") {
            throw new TeamAgentRequestVersionConflictError();
          }
        }
      }
      const row = await ensureReviewRequest(client, actor, input, true);
      if (!row) {
        await client.query("rollback");
        return null;
      }
      if (row.version !== input.expectedVersion) {
        throw new TeamAgentRequestVersionConflictError();
      }
      let jobId: string | null = null;
      if (input.decision === "accept") {
        const project = await client.query<{ local_project_id: string | null }>(
          `select local_project_id from public_square_project_connections
            where actor_user_id=$1 and team_id=$2 and team_project_id=$3
              and local_project_id is not null for share`,
          [actor.userId, row.team_id, row.team_project_id]
        );
        const localProjectId = project.rows[0]?.local_project_id;
        const review = await readPrivateReview(
          client,
          actor,
          options,
          row.id,
          row.team_id
        );
        if (
          !localProjectId ||
          !review.privateGoal.trim() ||
          !review.executionId
        ) {
          throw statusError(
            "Owner must connect a Project and review an Agent execution before accepting",
            409
          );
        }
        const created = await createOwnerJob(client, {
          requestId: row.id,
          teamId: row.team_id,
          teamProjectId: row.team_project_id,
          ownerUserId: row.owner_user_id,
          agentId: row.agent_id,
          agentVersion: row.agent_version,
          localProjectId,
          executionId: review.executionId,
          privateGoal: review.privateGoal,
          idempotencyKey: `team-agent-request:${row.id}:accept:v${input.expectedVersion}`
        });
        if (!UUID_PATTERN.test(created.jobId))
          throw new Error("Owner Job callback returned an invalid Job ID");
        jobId = created.jobId;
      }
      const status = input.decision === "accept" ? "accepted" : "declined";
      const updated = await client.query(
        `update team_agent_requests
            set status=$4,job_id=$5,version=version+1,updated_at=now()
          where id=$1 and team_id=$2 and version=$3 and status='awaiting_owner'
          returning id`,
        [row.id, row.team_id, input.expectedVersion, status, jobId]
      );
      if (updated.rowCount !== 1)
        throw new TeamAgentRequestVersionConflictError();
      const saved = await client.query<RequestRow>(
        `${requestSelect} where r.id=$1 and r.team_id=$2 and sp.unshared_at is null`,
        [row.id, row.team_id]
      );
      if (!saved.rows[0])
        throw new Error("Team Agent Request decision was not saved");
      await client.query("commit");
      return mapRequest(saved.rows[0], actor.userId);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async withdrawRequest(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      if (!(await activeTeamMember(client, actor, input.teamId, true))) {
        await client.query("rollback");
        return null;
      }
      const selected = await client.query<RequestRow>(
        `${requestSelect} where r.id=$1 and r.team_id=$2 and r.requester_user_id=$3 and sp.unshared_at is null for update of r`,
        [input.requestId, input.teamId, actor.userId]
      );
      const row = selected.rows[0];
      if (!row || !(await requireRequestChannel(client, inputChannel(row)))) {
        await client.query("rollback");
        return null;
      }
      if (
        row.status === "withdrawn" &&
        row.version === input.expectedVersion + 1
      ) {
        await client.query("commit");
        return mapRequest(row, actor.userId);
      }
      if (row.status !== "awaiting_owner") {
        throw statusError("Only awaiting Agent Requests can be withdrawn", 409);
      }
      if (row.version !== input.expectedVersion)
        throw new TeamAgentRequestVersionConflictError();
      await client.query(
        `update team_agent_requests set status='withdrawn',version=version+1,updated_at=now()
          where id=$1 and team_id=$2 and version=$3 and status='awaiting_owner'`,
        [row.id, row.team_id, input.expectedVersion]
      );
      const saved = await client.query<RequestRow>(
        `${requestSelect} where r.id=$1 and r.team_id=$2 and sp.unshared_at is null`,
        [row.id, row.team_id]
      );
      await client.query("commit");
      return saved.rows[0] ? mapRequest(saved.rows[0], actor.userId) : null;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async postOutcome(actor, input) {
    if (Buffer.byteLength(input.summary, "utf8") > 2_000) {
      throw statusError("Outcome summary is too long", 400);
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      if (!(await activeTeamMember(client, actor, input.teamId, true))) {
        await client.query("rollback");
        return null;
      }
      const selected = await client.query<RequestRow>(
        `${requestSelect} where r.id=$1 and r.team_id=$2 and r.owner_user_id=$3 and r.status='accepted' and sp.unshared_at is null for update of r`,
        [input.requestId, input.teamId, actor.userId]
      );
      const row = selected.rows[0];
      if (!row || !(await requireRequestChannel(client, inputChannel(row)))) {
        await client.query("rollback");
        return null;
      }
      if (row.outcome_message_id && row.version === input.expectedVersion + 1) {
        await client.query("commit");
        return mapRequest(row, actor.userId);
      }
      if (row.version !== input.expectedVersion)
        throw new TeamAgentRequestVersionConflictError();
      if (row.outcome_message_id)
        throw new TeamAgentRequestVersionConflictError();
      if (
        !row.job_status ||
        !["succeeded", "failed", "canceled", "interrupted"].includes(
          row.job_status
        )
      ) {
        throw statusError("Agent Job has not reached a terminal state", 409);
      }
      const message = await sendCollaborationMessageWithClient(
        client,
        actor,
        teamProvider(options),
        {
          threadId: row.channel_id,
          idempotencyKey: `team-agent-request:${row.id}:outcome`,
          bodyText: input.summary,
          metadata: { kind: "team_agent_request_outcome", requestId: row.id },
          provenance: { kind: "team_agent_request_outcome", id: row.id }
        }
      );
      if (!message)
        throw new TeamAgentRequestUnavailableError(
          "Team channel is unavailable"
        );
      await client.query(
        `update team_agent_requests set outcome_message_id=$3,version=version+1,updated_at=now()
          where id=$1 and team_id=$2 and version=$4 and outcome_message_id is null`,
        [row.id, row.team_id, message.id, input.expectedVersion]
      );
      const saved = await client.query<RequestRow>(
        `${requestSelect} where r.id=$1 and r.team_id=$2 and sp.unshared_at is null`,
        [row.id, row.team_id]
      );
      await client.query("commit");
      return saved.rows[0] ? mapRequest(saved.rows[0], actor.userId) : null;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async materializeRealtimeInvalidation(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read");
      if (!(await activeTeamMember(client, actor, input.teamId, true))) {
        await client.query("rollback");
        return null;
      }
      if (input.resourceType === "team_agent_request") {
        const row = await client.query<{
          id: string;
          team_id: string;
          team_project_id: string;
          channel_id: string;
          owner_user_id: string;
          request_message_id: string;
        }>(
          `select r.id,r.team_id,r.team_project_id,r.channel_id,r.owner_user_id,r.request_message_id
             from team_agent_requests r
             join collaboration_team_shared_projects sp on sp.id=r.team_project_id and sp.team_id=r.team_id
             join collaboration_threads ct on ct.id=r.channel_id and ct.team_id=r.team_id and ct.lifecycle='active'
            where r.id=$1 and r.team_id=$2 and ct.kind in ('team_channel','team_project_channel')
              and (ct.kind='team_channel' or (ct.team_project_id=r.team_project_id and sp.unshared_at is null))`,
          [input.resourceId, input.teamId]
        );
        const request = row.rows[0];
        if (!request) {
          await client.query("commit");
          return null;
        }
        await client.query("commit");
        return {
          type: "team_agent_request_invalidated",
          teamId: request.team_id,
          requestId: request.id,
          channelId: request.channel_id,
          ownerId: request.owner_user_id,
          kind: "request"
        };
      }
      if (input.resourceType === "team_agent_offer") {
        const row = await client.query<{
          team_id: string;
          owner_user_id: string;
        }>(
          `select team_id,owner_user_id from team_agent_offers where id=$1 and team_id=$2`,
          [input.resourceId, input.teamId]
        );
        const offer = row.rows[0];
        if (!offer) {
          await client.query("commit");
          return null;
        }
        await client.query("commit");
        return {
          type: "team_agent_request_invalidated",
          teamId: offer.team_id,
          requestId: null,
          channelId: null,
          ownerId: offer.owner_user_id,
          kind: "offers"
        };
      }
      await client.query("commit");
      return null;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
});

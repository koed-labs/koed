import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  decryptEnvelopeToUtf8,
  pullRequestAccountSchema,
  pullRequestFrozenReviewSchema,
  pullRequestOperationPayloadSchema,
  pullRequestOperationSchema,
  pullRequestRepositorySchema,
  pullRequestReviewDraftSchema,
  pullRequestReviewSchema,
  personalAgentExecutionContextSchema,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type PullRequestAccount,
  type PullRequestFrozenReview,
  type PullRequestOperationPayload,
  type PullRequestOperationRecord,
  type PullRequestOperationResult,
  type PullRequestReviewDraft,
  type PullRequestReviewRecord
} from "@koed/shared";
import type { ActorContext } from "./types.js";

type Envelope = EncryptedPayloadEnvelope;
type QueryClient = pg.Pool | pg.PoolClient;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const parsePageCursor = (value: string | null | undefined) => {
  if (value === null || value === undefined) return null;
  const delimiter = value.lastIndexOf(".");
  if (delimiter <= 0) throw invalid("Page cursor is invalid");
  const timestamp = value.slice(0, delimiter);
  const id = value.slice(delimiter + 1);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/u.test(timestamp) ||
    !UUID.test(id) ||
    !Number.isFinite(Date.parse(timestamp))
  )
    throw invalid("Page cursor is invalid");
  return { timestamp, id };
};
const exactTimestampSql = `to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digestLeaseToken = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const conflict = (message: string, code = "PULL_REQUEST_CONFLICT") =>
  Object.assign(new Error(message), { code, statusCode: 409 });
const invalid = (message: string) =>
  Object.assign(new Error(message), {
    code: "PULL_REQUEST_INVALID",
    statusCode: 400
  });
const encryptionUnavailable = () =>
  Object.assign(new Error("Pull request encryption is unavailable"), {
    code: "PULL_REQUEST_ENCRYPTION_UNAVAILABLE",
    statusCode: 503
  });

interface ReviewRow {
  id: string;
  owner_user_id: string;
  agent_id: string;
  agent_version: number;
  execution_id: string | null;
  project_id: string | null;
  target_device_id: string;
  account_id: string;
  repository_id: string;
  pull_request_number: number;
  target_deployment_id: string;
  expected_base_sha: string;
  expected_head_sha: string;
  connection_generation: number;
  status: PullRequestReviewRecord["status"];
  work_mode: "review" | "fix";
  reviewed_base_sha: string | null;
  reviewed_head_sha: string | null;
  reviewed_execution_generation: number | null;
  revision: number;
  draft_revision: number;
  encrypted_selection: Envelope;
  idempotency_key: string;
  request_digest: string;
  created_at: Date;
  updated_at: Date;
}
interface OperationRow {
  id: string;
  owner_user_id: string;
  review_id: string | null;
  target_device_id: string;
  target_deployment_id: string;
  request_id: string;
  request_digest: string;
  kind: PullRequestOperationPayload["kind"];
  inbox_account_id?: string | null;
  inbox_connection_generation?: number | null;
  is_global_inbox?: boolean | null;
  state: PullRequestOperationRecord["state"];
  encrypted_payload: Envelope;
  encrypted_result: Envelope | null;
  error_code: string | null;
  revision: number;
  attempt: number;
  lease_token: string | null;
  lease_expires_at: Date | null;
  write_dispatched: boolean;
  claimed_by_runner_id: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}
const encryptJson = (
  provider: EnvelopeEncryptionProvider,
  ownerUserId: string,
  table: string,
  sourceId: string,
  column: string,
  value: unknown
): Promise<Envelope> =>
  Promise.resolve(
    provider.encrypt({
      plaintext: JSON.stringify(value),
      scope: { objectClass: "pull_request_authority" },
      provenance: {
        rowFamily: "pull_request_authority",
        sourceTable: table,
        sourceColumn: column,
        sourceId
      },
      ciphertextLocation: table + "." + column,
      aad: { ownerUserId, sourceTable: table, sourceId, sourceColumn: column }
    })
  );
const decryptJson = async <T>(
  provider: EnvelopeEncryptionProvider,
  envelope: Envelope
): Promise<T> =>
  JSON.parse(await decryptEnvelopeToUtf8(provider, envelope)) as T;

export interface CreatePullRequestReviewInput {
  requestId: string;
  detailsOperationId: string;
  agentId: string;
  projectId?: string | null;
}
export interface PullRequestOperationClaim {
  operation: PullRequestOperationRecord;
  leaseToken: string;
  payload: PullRequestOperationPayload;
}
export interface PullRequestRepository {
  createPullRequestReview(
    actor: ActorContext,
    input: CreatePullRequestReviewInput
  ): Promise<PullRequestReviewRecord>;
  getPullRequestReview(
    actor: ActorContext,
    input: { reviewId: string }
  ): Promise<PullRequestReviewRecord | null>;
  listPullRequestReviews(
    actor: ActorContext,
    input?: {
      limit?: number;
      before?: string | null;
      repositoryId?: string;
      pullRequestNumber?: number;
      agentId?: string;
    }
  ): Promise<{ reviews: PullRequestReviewRecord[]; nextCursor: string | null }>;
  enablePullRequestFixes(
    actor: ActorContext,
    input: { reviewId: string; expectedRevision: number }
  ): Promise<PullRequestReviewRecord | null>;
  acceptPullRequestHeadRefresh(
    actor: ActorContext,
    input: {
      reviewId: string;
      expectedRevision: number;
      detailsOperationId: string;
    }
  ): Promise<PullRequestReviewRecord | null>;
  getPullRequestReviewDraft(
    actor: ActorContext,
    input: { reviewId: string }
  ): Promise<PullRequestReviewDraft | null>;
  savePullRequestReviewDraft(
    actor: ActorContext,
    input: {
      reviewId: string;
      expectedReviewRevision: number;
      expectedDraftRevision: number;
      executionGeneration: number | null;
      accountId: string;
      connectionGeneration: number;
      baseSha: string;
      headSha: string;
      event: PullRequestReviewDraft["event"];
      body: string;
      findings: PullRequestReviewDraft["findings"];
    }
  ): Promise<PullRequestReviewDraft>;
  freezePullRequestReviewDraft(
    actor: ActorContext,
    input: {
      reviewId: string;
      expectedReviewRevision: number;
      expectedDraftRevision: number;
      accountId: string;
      connectionGeneration: number;
      baseSha: string;
      headSha: string;
    }
  ): Promise<PullRequestFrozenReview>;
  bindPullRequestReviewExecutionWithClient(
    client: pg.PoolClient,
    actor: ActorContext,
    input: {
      reviewId: string;
      executionId: string;
      agentId: string;
      runnerDeploymentId: string;
      runnerDeviceId: string;
      projectId: string | null;
    }
  ): Promise<PullRequestReviewRecord | null>;
  getPullRequestReviewForExecution(
    actor: ActorContext,
    input: {
      executionId: string;
      ownerUserId: string;
      runnerDeploymentId: string;
      runnerDeviceId: string;
    }
  ): Promise<PullRequestReviewRecord | null>;
  getFrozenPullRequestReview(
    actor: ActorContext,
    input: { reviewId: string; frozenReviewId: string }
  ): Promise<PullRequestFrozenReview | null>;
  getLatestFrozenPullRequestReview(
    actor: ActorContext,
    input: { reviewId: string }
  ): Promise<PullRequestFrozenReview | null>;
  enqueuePullRequestOperation(
    actor: ActorContext,
    input: {
      requestId: string;
      targetDeviceId: string;
      targetDeploymentId: string;
      payload: PullRequestOperationPayload;
      reviewId?: string | null;
    }
  ): Promise<PullRequestOperationRecord>;
  getPullRequestOperation(
    actor: ActorContext,
    input: { operationId: string }
  ): Promise<PullRequestOperationRecord | null>;
  listPullRequestOperations(
    actor: ActorContext,
    input?: { limit?: number; before?: string | null }
  ): Promise<{
    operations: PullRequestOperationRecord[];
    nextCursor: string | null;
  }>;
  getPullRequestInboxSnapshot(
    actor: ActorContext,
    input: {
      targetDeviceId: string;
      targetDeploymentId: string;
      accountId: string;
      connectionGeneration: number;
    }
  ): Promise<{
    operation: PullRequestOperationRecord | null;
    pendingOperation: PullRequestOperationRecord | null;
  }>;
  cancelPullRequestOperation(
    actor: ActorContext,
    input: { operationId: string; expectedRevision: number }
  ): Promise<PullRequestOperationRecord | null>;
  claimPullRequestOperations(input: {
    ownerUserId: string;
    runnerDeploymentId: string;
    runnerDeviceId: string;
    runnerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<PullRequestOperationClaim[]>;
  heartbeatPullRequestOperation(input: {
    operationId: string;
    ownerUserId: string;
    runnerDeploymentId: string;
    runnerDeviceId: string;
    runnerId: string;
    leaseToken: string;
    leaseMs: number;
  }): Promise<PullRequestOperationRecord | null>;
  completePullRequestOperation(input: {
    operationId: string;
    ownerUserId: string;
    runnerDeploymentId: string;
    runnerDeviceId: string;
    runnerId: string;
    leaseToken: string;
    result: PullRequestOperationResult;
  }): Promise<PullRequestOperationRecord | null>;
  failPullRequestOperation(input: {
    operationId: string;
    ownerUserId: string;
    runnerDeploymentId: string;
    runnerDeviceId: string;
    runnerId: string;
    leaseToken: string;
    state: "failed" | "uncertain";
    errorCode: string;
  }): Promise<PullRequestOperationRecord | null>;
  markPullRequestReviewCompleted(input: {
    ownerUserId: string;
    runnerDeploymentId: string;
    runnerDeviceId: string;
    reviewId: string;
    executionId: string;
    executionGeneration: number;
    commandId: string;
    leaseToken: string;
    expectedReviewRevision: number;
    baseSha: string;
    headSha: string;
    result: {
      event: "COMMENT";
      body: string;
      findings: PullRequestReviewDraft["findings"];
    };
  }): Promise<PullRequestReviewDraft | null>;
}

const mapReview = async (
  row: ReviewRow,
  provider: EnvelopeEncryptionProvider,
  ownerUserId: string
): Promise<PullRequestReviewRecord> => {
  const selection = await decryptJson<{
    account: PullRequestAccount;
    repository: PullRequestReviewRecord["repository"];
    pullRequestNumber: number;
  }>(provider, row.encrypted_selection);
  return pullRequestReviewSchema.parse({
    id: row.id,
    ownerUserId: row.owner_user_id,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    executionId: row.execution_id,
    projectId: row.project_id,
    targetDeviceId: row.target_device_id,
    targetDeploymentId: row.target_deployment_id,
    account: selection.account,
    repository: selection.repository,
    pullRequestNumber: selection.pullRequestNumber,
    expectedBaseSha: row.expected_base_sha,
    expectedHeadSha: row.expected_head_sha,
    connectionGeneration: row.connection_generation,
    workMode: row.work_mode,
    reviewedBaseSha: row.reviewed_base_sha,
    reviewedHeadSha: row.reviewed_head_sha,
    reviewedExecutionGeneration: row.reviewed_execution_generation,
    status: row.status,
    revision: row.revision,
    draftRevision: row.draft_revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  });
};
const mapOperation = async (
  row: OperationRow,
  provider: EnvelopeEncryptionProvider
): Promise<PullRequestOperationRecord> =>
  pullRequestOperationSchema.parse({
    id: row.id,
    ownerUserId: row.owner_user_id,
    reviewId: row.review_id,
    targetDeviceId: row.target_device_id,
    targetDeploymentId: row.target_deployment_id,
    requestId: row.request_id,
    requestDigest: row.request_digest,
    payload: await decryptJson(provider, row.encrypted_payload),
    state: row.state,
    result: row.encrypted_result
      ? await decryptJson(provider, row.encrypted_result)
      : null,
    errorCode: row.error_code,
    revision: row.revision,
    attempt: row.attempt,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null
  });

const isGlobalInboxPayload = (
  payload: PullRequestOperationPayload
): payload is Extract<PullRequestOperationPayload, { kind: "inbox" }> =>
  payload.kind === "inbox" &&
  payload.repository === null &&
  payload.cursor === null;

const matchesGlobalInboxScope = async (
  row: Pick<
    OperationRow,
    | "target_device_id"
    | "target_deployment_id"
    | "kind"
    | "inbox_account_id"
    | "inbox_connection_generation"
    | "is_global_inbox"
    | "encrypted_payload"
  >,
  provider: EnvelopeEncryptionProvider,
  scope: {
    targetDeviceId: string;
    targetDeploymentId: string;
    accountId: string;
    connectionGeneration: number;
  }
): Promise<boolean> => {
  if (
    row.target_device_id !== scope.targetDeviceId ||
    row.target_deployment_id !== scope.targetDeploymentId ||
    row.kind !== "inbox"
  )
    return false;
  if (
    row.inbox_account_id != null &&
    (row.inbox_account_id !== scope.accountId ||
      row.inbox_connection_generation !== scope.connectionGeneration ||
      row.is_global_inbox !== true)
  )
    return false;
  const payload = pullRequestOperationPayloadSchema.safeParse(
    await decryptJson(provider, row.encrypted_payload)
  );
  return Boolean(
    payload.success &&
    isGlobalInboxPayload(payload.data) &&
    payload.data.account.id === scope.accountId &&
    payload.data.connectionGeneration === scope.connectionGeneration
  );
};

const findGlobalInboxOperation = async (
  client: QueryClient,
  ownerUserId: string,
  provider: EnvelopeEncryptionProvider,
  scope: {
    targetDeviceId: string;
    targetDeploymentId: string;
    accountId: string;
    connectionGeneration: number;
  },
  states: readonly string[]
): Promise<OperationRow | null> => {
  type Candidate = Pick<
    OperationRow,
    | "id"
    | "target_device_id"
    | "target_deployment_id"
    | "kind"
    | "inbox_account_id"
    | "inbox_connection_generation"
    | "is_global_inbox"
    | "encrypted_payload"
    | "updated_at"
  >;
  const exact = await client.query<Candidate>(
    `select id,target_device_id,target_deployment_id,kind,inbox_account_id,
            inbox_connection_generation,is_global_inbox,encrypted_payload,updated_at
       from pull_request_operations
      where owner_user_id=$1 and target_device_id=$2 and target_deployment_id=$3
        and kind='inbox' and state=any($6::text[])
        and inbox_account_id=$4 and inbox_connection_generation=$5
        and is_global_inbox=true
      order by updated_at desc,id desc limit 1`,
    [
      ownerUserId,
      scope.targetDeviceId,
      scope.targetDeploymentId,
      scope.accountId,
      scope.connectionGeneration,
      states
    ]
  );
  const legacy = await client.query<Candidate>(
    `select id,target_device_id,target_deployment_id,kind,inbox_account_id,
            inbox_connection_generation,is_global_inbox,encrypted_payload,updated_at
       from pull_request_operations
      where owner_user_id=$1 and target_device_id=$2 and target_deployment_id=$3
        and kind='inbox' and state=any($4::text[])
        and inbox_account_id is null and inbox_connection_generation is null
        and is_global_inbox is null
      order by updated_at desc,id desc limit 500`,
    [ownerUserId, scope.targetDeviceId, scope.targetDeploymentId, states]
  );
  const candidates = [...exact.rows, ...legacy.rows].sort((a, b) => {
    const updatedDifference = b.updated_at.getTime() - a.updated_at.getTime();
    return updatedDifference || b.id.localeCompare(a.id);
  });
  for (const candidate of candidates) {
    if (!(await matchesGlobalInboxScope(candidate, provider, scope))) continue;
    const selected = await client.query<OperationRow>(
      "select * from pull_request_operations where id=$1 and owner_user_id=$2",
      [candidate.id, ownerUserId]
    );
    if (selected.rows[0]) return selected.rows[0];
  }
  return null;
};

export const createPullRequestRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider }
): PullRequestRepository => {
  const provider = () => {
    if (!options.envelopeEncryptionProvider) throw encryptionUnavailable();
    return options.envelopeEncryptionProvider;
  };
  const readReview = async (
    actor: ActorContext,
    reviewId: string,
    db: QueryClient = pool
  ) => {
    const result = await db.query<ReviewRow>(
      "select * from pull_request_reviews where owner_user_id=$1 and id=$2",
      [actor.userId, reviewId]
    );
    return result.rows[0] ?? null;
  };
  const getDraft = async (
    actor: ActorContext,
    reviewId: string,
    db: QueryClient = pool
  ) => {
    const result = await db.query<{
      review_id: string;
      revision: number;
      origin: "agent" | "owner";
      execution_generation: number | null;
      account_id: string;
      base_sha: string;
      head_sha: string;
      encrypted_payload: Envelope;
      updated_at: Date;
    }>(
      "select d.review_id,d.revision,d.origin,d.execution_generation,d.account_id,d.base_sha,d.head_sha,d.encrypted_payload,d.updated_at from pull_request_review_drafts d join pull_request_reviews r on r.id=d.review_id and r.owner_user_id=d.owner_user_id where r.owner_user_id=$1 and r.id=$2 order by d.revision desc limit 1",
      [actor.userId, reviewId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const body = await decryptJson<{
      event: PullRequestReviewDraft["event"];
      body: string;
      findings: PullRequestReviewDraft["findings"];
    }>(provider(), row.encrypted_payload);
    return pullRequestReviewDraftSchema.parse({
      reviewId: row.review_id,
      revision: row.revision,
      origin: row.origin,
      executionGeneration: row.execution_generation,
      accountId: row.account_id,
      baseSha: row.base_sha,
      headSha: row.head_sha,
      ...body,
      updatedAt: row.updated_at.toISOString()
    });
  };

  return {
    async createPullRequestReview(actor, input) {
      if (!UUID.test(input.detailsOperationId))
        throw invalid("Details operation ID is invalid");
      if (!UUID.test(input.agentId)) throw invalid("Agent ID is invalid");
      if (
        !input.requestId.trim() ||
        input.requestId.length > 240 ||
        (input.projectId && input.projectId.length > 240)
      )
        throw invalid("Review request is invalid");
      const client = await pool.connect();
      try {
        await client.query("begin");
        const found = await client.query<OperationRow>(
          "select * from pull_request_operations where id=$1 and owner_user_id=$2 and kind='pull_request_details' and state='completed' for share",
          [input.detailsOperationId, actor.userId]
        );
        const op = found.rows[0];
        if (!op?.encrypted_result)
          throw conflict(
            "A completed, authorized pull request details operation is required"
          );
        const task = await decryptJson<PullRequestOperationPayload>(
          provider(),
          op.encrypted_payload
        );
        if (task.kind !== "pull_request_details")
          throw conflict("Details task has the wrong type");
        const details = await decryptJson<Record<string, unknown>>(
          provider(),
          op.encrypted_result
        );
        const account = pullRequestAccountSchema.parse(details.account);
        const repository = pullRequestRepositorySchema.parse(
          details.repository
        );
        const pullRequest =
          details.pullRequest && typeof details.pullRequest === "object"
            ? (details.pullRequest as Record<string, unknown>)
            : details;
        const number = Number(details.pullRequestNumber ?? pullRequest.number);
        const generation = Number(details.connectionGeneration);
        const baseSha = String(details.baseSha ?? pullRequest.baseSha ?? "");
        const headSha = String(details.headSha ?? pullRequest.headSha ?? "");
        if (
          account.id !== task.account.id ||
          generation !== task.connectionGeneration ||
          repository.id !== task.repository.id ||
          Number(details.pullRequestNumber ?? pullRequest.number) !==
            task.pullRequestNumber ||
          !Number.isSafeInteger(number) ||
          number < 1 ||
          !/^[0-9a-f]{40,64}$/iu.test(baseSha) ||
          !/^[0-9a-f]{40,64}$/iu.test(headSha)
        ) {
          throw conflict(
            "Details result does not match the selected account and operation"
          );
        }
        if (input.projectId !== null && input.projectId !== undefined) {
          const matchingProjects = Array.isArray(details.matchingProjects)
            ? (details.matchingProjects as Array<Record<string, unknown>>)
            : [];
          if (
            !matchingProjects.some(
              (project) => project && project.id === input.projectId
            )
          ) {
            throw conflict(
              "Selected project is not among the projects verified for this pull request"
            );
          }
        }
        const agent = await client.query<{ current_version: number }>(
          "select current_version from personal_agent_identities where id=$1 and owner_user_id=$2 and lifecycle='active' for share",
          [input.agentId, actor.userId]
        );
        const agentVersion = agent.rows[0]?.current_version;
        if (!agentVersion) throw conflict("Selected Agent is unavailable");
        const id = randomUUID();
        const encrypted = await encryptJson(
          provider(),
          actor.userId,
          "pull_request_reviews",
          id,
          "selection",
          { account, repository, pullRequestNumber: number }
        );
        const requestDigest = hash({
          detailsOperationId: input.detailsOperationId,
          agentId: input.agentId,
          projectId: input.projectId ?? null
        });
        const inserted = await client.query<ReviewRow>(
          "insert into pull_request_reviews (id,owner_user_id,agent_id,agent_version,project_id,target_device_id,target_deployment_id,account_id,repository_id,pull_request_number,expected_base_sha,expected_head_sha,connection_generation,status,idempotency_key,request_digest,encrypted_selection) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'starting',$14,$15,$16::jsonb) on conflict do nothing returning *",
          [
            id,
            actor.userId,
            input.agentId,
            agentVersion,
            input.projectId ?? null,
            op.target_device_id,
            op.target_deployment_id,
            account.id,
            repository.id,
            number,
            baseSha,
            headSha,
            generation,
            input.requestId,
            requestDigest,
            JSON.stringify(encrypted)
          ]
        );
        let row = inserted.rows[0];
        if (!row) {
          const old = await client.query<ReviewRow>(
            "select * from pull_request_reviews where owner_user_id=$1 and idempotency_key=$2",
            [actor.userId, input.requestId]
          );
          row = old.rows[0];
          if (row) {
            if (row.request_digest !== requestDigest)
              throw conflict(
                "Review request id was reused",
                "IDEMPOTENCY_CONFLICT"
              );
          } else {
            const existing = await client.query<ReviewRow>(
              "select * from pull_request_reviews where owner_user_id=$1 and agent_id=$2 and account_id=$3 and repository_id=$4 and pull_request_number=$5 for update",
              [actor.userId, input.agentId, account.id, repository.id, number]
            );
            row = existing.rows[0];
            if (!row) throw conflict("Review record could not be created");
            if (row.project_id !== (input.projectId ?? null))
              throw conflict(
                "Existing review is attached to a different project"
              );
          }
        }
        await client.query("commit");
        return mapReview(row, provider(), actor.userId);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async getPullRequestReview(actor, { reviewId }) {
      if (!UUID.test(reviewId)) return null;
      const row = await readReview(actor, reviewId);
      return row ? mapReview(row, provider(), actor.userId) : null;
    },
    async listPullRequestReviews(actor, input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
      const cursor = parsePageCursor(input.before);
      const repositoryId = input.repositoryId?.trim() || null;
      if (repositoryId && repositoryId.length > 120)
        throw invalid("Repository filter is invalid");
      if (
        input.pullRequestNumber !== undefined &&
        (!Number.isSafeInteger(input.pullRequestNumber) ||
          input.pullRequestNumber < 1)
      )
        throw invalid("Pull request number filter is invalid");
      if (input.agentId && !UUID.test(input.agentId))
        throw invalid("Agent filter is invalid");
      const filters = [
        actor.userId,
        repositoryId,
        input.pullRequestNumber ?? null,
        input.agentId ?? null
      ];
      let cursorTimestamp: string | null = null;
      if (cursor) {
        const ownedCursor = await pool.query<{ cursor_timestamp: string }>(
          `select ${exactTimestampSql} as cursor_timestamp from pull_request_reviews where id=$1 and owner_user_id=$2 and ($3::text is null or repository_id=$3) and ($4::integer is null or pull_request_number=$4) and ($5::uuid is null or agent_id=$5)`,
          [cursor.id, ...filters]
        );
        if (
          !ownedCursor.rows[0] ||
          ownedCursor.rows[0].cursor_timestamp !== cursor.timestamp
        )
          throw invalid("Page cursor is unavailable");
        cursorTimestamp = ownedCursor.rows[0].cursor_timestamp;
      }
      const result = await pool.query<ReviewRow & { cursor_timestamp: string }>(
        `select *, ${exactTimestampSql} as cursor_timestamp from pull_request_reviews where owner_user_id=$1 and ($2::text is null or repository_id=$2) and ($3::integer is null or pull_request_number=$3) and ($4::uuid is null or agent_id=$4) and ($5::timestamptz is null or (updated_at,id)<($5::timestamptz,$6::uuid)) order by updated_at desc,id desc limit $7`,
        [...filters, cursorTimestamp, cursor?.id ?? null, limit + 1]
      );
      const rows = result.rows.slice(0, limit);
      const reviews = await Promise.all(
        rows.map((row) => mapReview(row, provider(), actor.userId))
      );
      const last = rows.at(-1);
      return {
        reviews,
        nextCursor:
          result.rows.length > limit && last
            ? last.cursor_timestamp + "." + last.id
            : null
      };
    },
    async enablePullRequestFixes(actor, input) {
      const result = await pool.query<ReviewRow>(
        "update pull_request_reviews set work_mode='fix',reviewed_base_sha=null,reviewed_head_sha=null,reviewed_execution_generation=null,status='active',revision=revision+1,updated_at=now() where id=$1 and owner_user_id=$2 and revision=$3 returning *",
        [input.reviewId, actor.userId, input.expectedRevision]
      );
      if (result.rows[0])
        return mapReview(result.rows[0], provider(), actor.userId);
      if (!(await readReview(actor, input.reviewId))) return null;
      throw conflict(
        "Pull request review changed; reload before enabling fixes"
      );
    },
    async acceptPullRequestHeadRefresh(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const current = await client.query<ReviewRow>(
          "select * from pull_request_reviews where id=$1 and owner_user_id=$2 and revision=$3 for update",
          [input.reviewId, actor.userId, input.expectedRevision]
        );
        const review = current.rows[0];
        if (!review) {
          if (!(await readReview(actor, input.reviewId, client))) {
            await client.query("rollback");
            return null;
          }
          throw conflict(
            "Pull request review changed; reload before refreshing its head"
          );
        }
        const operation = await client.query<OperationRow>(
          "select * from pull_request_operations where id=$1 and owner_user_id=$2 and state='completed' and kind='pull_request_details' for share",
          [input.detailsOperationId, actor.userId]
        );
        const row = operation.rows[0];
        if (!row?.encrypted_result)
          throw conflict("Completed pull request details are required");
        const task = await decryptJson<PullRequestOperationPayload>(
          provider(),
          row.encrypted_payload
        );
        const result = await decryptJson<Record<string, unknown>>(
          provider(),
          row.encrypted_result
        );
        const selection = await decryptJson<{
          account: PullRequestAccount;
          repository: PullRequestReviewRecord["repository"];
          pullRequestNumber: number;
        }>(provider(), review.encrypted_selection);
        if (
          task.kind !== "pull_request_details" ||
          task.account.id !== selection.account.id ||
          task.repository.id !== selection.repository.id ||
          task.pullRequestNumber !== selection.pullRequestNumber ||
          Number(result.connectionGeneration) !== task.connectionGeneration ||
          (result.account as PullRequestAccount)?.id !== selection.account.id ||
          (result.repository as PullRequestReviewRecord["repository"])?.id !==
            selection.repository.id ||
          Number(result.pullRequestNumber) !== selection.pullRequestNumber ||
          !/^[0-9a-f]{40,64}$/iu.test(String(result.baseSha ?? "")) ||
          !/^[0-9a-f]{40,64}$/iu.test(String(result.headSha ?? ""))
        )
          throw conflict("Refreshed details do not match this review");
        const updated = await client.query<ReviewRow>(
          "update pull_request_reviews set expected_base_sha=$3,expected_head_sha=$4,connection_generation=$5,work_mode='review',reviewed_base_sha=null,reviewed_head_sha=null,reviewed_execution_generation=null,status='stale',revision=revision+1,updated_at=now() where id=$1 and owner_user_id=$2 returning *",
          [
            input.reviewId,
            actor.userId,
            result.baseSha,
            result.headSha,
            task.connectionGeneration
          ]
        );
        await client.query("commit");
        return updated.rows[0]
          ? mapReview(updated.rows[0], provider(), actor.userId)
          : null;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async savePullRequestReviewDraft(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const current = await client.query<ReviewRow>(
          "select * from pull_request_reviews where id=$1 and owner_user_id=$2 for update",
          [input.reviewId, actor.userId]
        );
        const review = current.rows[0];
        if (!review)
          throw Object.assign(new Error("Pull request review not found"), {
            statusCode: 404
          });
        if (
          review.revision !== input.expectedReviewRevision ||
          review.draft_revision !== input.expectedDraftRevision ||
          review.connection_generation !== input.connectionGeneration ||
          review.expected_base_sha.toLowerCase() !==
            input.baseSha.toLowerCase() ||
          review.expected_head_sha.toLowerCase() !== input.headSha.toLowerCase()
        )
          throw conflict("Review account or head changed");
        if (
          review.reviewed_base_sha?.toLowerCase() !==
            input.baseSha.toLowerCase() ||
          review.reviewed_head_sha?.toLowerCase() !==
            input.headSha.toLowerCase() ||
          review.reviewed_execution_generation === null
        )
          throw conflict(
            "An Agent review of this exact head is required before editing a draft"
          );
        const selection = await decryptJson<{ account: PullRequestAccount }>(
          provider(),
          review.encrypted_selection
        );
        if (selection.account.id !== input.accountId)
          throw conflict("Selected GitHub account changed");
        const revision = review.draft_revision + 1;
        const id = randomUUID();
        const encrypted = await encryptJson(
          provider(),
          actor.userId,
          "pull_request_review_drafts",
          id,
          "payload",
          { event: input.event, body: input.body, findings: input.findings }
        );
        const inserted = await client.query<{ updated_at: Date }>(
          "insert into pull_request_review_drafts(id,review_id,owner_user_id,revision,origin,execution_generation,account_id,base_sha,head_sha,encrypted_payload) values($1,$2,$3,$4,'owner',$5,$6,$7,$8,$9::jsonb) returning updated_at",
          [
            id,
            input.reviewId,
            actor.userId,
            revision,
            input.executionGeneration,
            input.accountId,
            input.baseSha,
            input.headSha,
            JSON.stringify(encrypted)
          ]
        );
        await client.query(
          "update pull_request_reviews set draft_revision=$3,status='draft',revision=revision+1,updated_at=now() where id=$1 and owner_user_id=$2",
          [input.reviewId, actor.userId, revision]
        );
        await client.query("commit");
        return pullRequestReviewDraftSchema.parse({
          reviewId: input.reviewId,
          revision,
          origin: "owner",
          executionGeneration: input.executionGeneration,
          accountId: input.accountId,
          baseSha: input.baseSha,
          headSha: input.headSha,
          event: input.event,
          body: input.body,
          findings: input.findings,
          updatedAt: inserted.rows[0]!.updated_at.toISOString()
        });
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async freezePullRequestReviewDraft(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const found = await client.query<ReviewRow>(
          "select * from pull_request_reviews where id=$1 and owner_user_id=$2 for update",
          [input.reviewId, actor.userId]
        );
        const review = found.rows[0];
        if (!review)
          throw Object.assign(new Error("Pull request review not found"), {
            statusCode: 404
          });
        if (
          review.revision !== input.expectedReviewRevision ||
          review.draft_revision !== input.expectedDraftRevision ||
          review.connection_generation !== input.connectionGeneration ||
          review.expected_base_sha.toLowerCase() !==
            input.baseSha.toLowerCase() ||
          review.expected_head_sha.toLowerCase() !== input.headSha.toLowerCase()
        )
          throw conflict(
            "Review changed; reload before confirming publication"
          );
        if (
          review.reviewed_base_sha?.toLowerCase() !==
            input.baseSha.toLowerCase() ||
          review.reviewed_head_sha?.toLowerCase() !==
            input.headSha.toLowerCase() ||
          review.reviewed_execution_generation === null
        )
          throw conflict(
            "An Agent review of this exact head is required before publication"
          );
        const selection = await decryptJson<{ account: PullRequestAccount }>(
          provider(),
          review.encrypted_selection
        );
        if (selection.account.id !== input.accountId)
          throw conflict("Selected GitHub account changed");
        const prior = await client.query<{ encrypted_payload: Envelope }>(
          "select encrypted_payload from pull_request_review_freezes where review_id=$1 and owner_user_id=$2 and draft_revision=$3",
          [input.reviewId, actor.userId, input.expectedDraftRevision]
        );
        if (prior.rows[0]) {
          const frozen = await decryptJson<PullRequestFrozenReview>(
            provider(),
            prior.rows[0].encrypted_payload
          );
          await client.query("commit");
          return frozen;
        }
        const got = await client.query<{
          account_id: string;
          base_sha: string;
          head_sha: string;
          encrypted_payload: Envelope;
        }>(
          "select account_id,base_sha,head_sha,encrypted_payload from pull_request_review_drafts where review_id=$1 and owner_user_id=$2 and revision=$3",
          [input.reviewId, actor.userId, input.expectedDraftRevision]
        );
        const draft = got.rows[0];
        if (
          !draft ||
          draft.account_id !== input.accountId ||
          draft.base_sha.toLowerCase() !== input.baseSha.toLowerCase() ||
          draft.head_sha.toLowerCase() !== input.headSha.toLowerCase()
        )
          throw conflict("Draft does not match the confirmed account and head");
        const content = await decryptJson<{
          event: PullRequestReviewDraft["event"];
          body: string;
          findings: PullRequestReviewDraft["findings"];
        }>(provider(), draft.encrypted_payload);
        if (!content.event)
          throw conflict(
            "Choose a review outcome before confirming publication"
          );
        const id = randomUUID();
        const exactBody =
          (content.body.trim() ? content.body.trim() + "\n\n" : "") +
          "<!-- koed-review:" +
          id +
          " -->";
        const base = {
          id,
          reviewId: input.reviewId,
          draftRevision: input.expectedDraftRevision,
          accountId: input.accountId,
          connectionGeneration: input.connectionGeneration,
          baseSha: input.baseSha,
          headSha: input.headSha,
          event: content.event,
          body: exactBody,
          findings: content.findings
        };
        const frozen = pullRequestFrozenReviewSchema.parse({
          ...base,
          digest: hash(base),
          createdAt: new Date().toISOString()
        });
        const encrypted = await encryptJson(
          provider(),
          actor.userId,
          "pull_request_review_freezes",
          id,
          "payload",
          frozen
        );
        await client.query(
          "insert into pull_request_review_freezes(id,review_id,owner_user_id,draft_revision,account_id,connection_generation,base_sha,head_sha,digest,encrypted_payload) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
          [
            id,
            input.reviewId,
            actor.userId,
            input.expectedDraftRevision,
            input.accountId,
            input.connectionGeneration,
            input.baseSha,
            input.headSha,
            frozen.digest,
            JSON.stringify(encrypted)
          ]
        );
        await client.query(
          "update pull_request_reviews set status='frozen',revision=revision+1,updated_at=now() where id=$1 and owner_user_id=$2",
          [input.reviewId, actor.userId]
        );
        await client.query("commit");
        return frozen;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async getPullRequestReviewDraft(actor, { reviewId }) {
      return getDraft(actor, reviewId);
    },
    async bindPullRequestReviewExecutionWithClient(client, actor, input) {
      const found = await client.query<ReviewRow>(
        "select review.* from pull_request_reviews review join managed_conversation_executions execution on execution.id=$2 and execution.owner_user_id=review.owner_user_id where review.id=$1 and review.owner_user_id=$3 and review.agent_id=$4 and review.target_deployment_id=$5 and review.target_device_id=$6 and review.project_id is not distinct from $7 and execution.runner_deployment_id=review.target_deployment_id and execution.runner_device_id=review.target_device_id and execution.project_id is not distinct from review.project_id for update of review",
        [
          input.reviewId,
          input.executionId,
          actor.userId,
          input.agentId,
          input.runnerDeploymentId,
          input.runnerDeviceId,
          input.projectId
        ]
      );
      const review = found.rows[0];
      if (!review) return null;
      const agent = await client.query<{ current_version: number }>(
        "select current_version from personal_agent_identities where id=$1 and owner_user_id=$2 and lifecycle='active' for share",
        [review.agent_id, actor.userId]
      );
      if (!agent.rows[0]?.current_version)
        throw conflict("Selected Agent is unavailable");
      if (review.execution_id && review.execution_id !== input.executionId)
        throw conflict("Review is already attached to another execution");
      const update = await client.query<ReviewRow>(
        "update pull_request_reviews set execution_id=$3,agent_version=$4,status='active',revision=revision+1,updated_at=now() where id=$1 and owner_user_id=$2 and (execution_id is null or execution_id=$3) returning *",
        [
          input.reviewId,
          actor.userId,
          input.executionId,
          agent.rows[0].current_version
        ]
      );
      return update.rows[0]
        ? mapReview(update.rows[0], provider(), actor.userId)
        : null;
    },
    async getPullRequestReviewForExecution(actor, input) {
      if (actor.userId !== input.ownerUserId) return null;
      const result = await pool.query<ReviewRow>(
        "select * from pull_request_reviews where owner_user_id=$1 and execution_id=$2 and target_deployment_id=$3 and target_device_id=$4",
        [
          input.ownerUserId,
          input.executionId,
          input.runnerDeploymentId,
          input.runnerDeviceId
        ]
      );
      return result.rows[0]
        ? mapReview(result.rows[0], provider(), actor.userId)
        : null;
    },
    async getFrozenPullRequestReview(actor, input) {
      const result = await pool.query<{ encrypted_payload: Envelope }>(
        "select encrypted_payload from pull_request_review_freezes where review_id=$1 and id=$2 and owner_user_id=$3",
        [input.reviewId, input.frozenReviewId, actor.userId]
      );
      const envelope = result.rows[0]?.encrypted_payload;
      return envelope
        ? pullRequestFrozenReviewSchema.parse(
            await decryptJson(provider(), envelope)
          )
        : null;
    },
    async getLatestFrozenPullRequestReview(actor, input) {
      const result = await pool.query<{ encrypted_payload: Envelope }>(
        "select encrypted_payload from pull_request_review_freezes where review_id=$1 and owner_user_id=$2 order by draft_revision desc, created_at desc, id desc limit 1",
        [input.reviewId, actor.userId]
      );
      const envelope = result.rows[0]?.encrypted_payload;
      return envelope
        ? pullRequestFrozenReviewSchema.parse(
            await decryptJson(provider(), envelope)
          )
        : null;
    },
    async enqueuePullRequestOperation(actor, input) {
      const payload = pullRequestOperationPayloadSchema.parse(input.payload);
      if (
        !input.requestId.trim() ||
        input.requestId.length > 240 ||
        !UUID.test(input.targetDeviceId) ||
        !UUID.test(input.targetDeploymentId)
      )
        throw invalid("Operation request is invalid");
      const implied = "reviewId" in payload ? payload.reviewId : null;
      const reviewId = input.reviewId ?? implied;
      if (implied && reviewId !== implied)
        throw conflict("Operation review binding does not match payload");
      if (reviewId) {
        const review = await readReview(actor, reviewId);
        if (
          !review ||
          review.target_device_id !== input.targetDeviceId ||
          review.target_deployment_id !== input.targetDeploymentId
        )
          throw conflict("Operation target is not authorized for this review");
        if (
          (payload.kind === "publish_review" || payload.kind === "push") &&
          review.revision !== payload.expectedReviewRevision
        )
          throw conflict("Review changed after confirmation");
      }
      if (payload.kind === "reconcile_review") {
        const found = await pool.query<OperationRow>(
          "select * from pull_request_operations where id=$1 and owner_user_id=$2 and kind='publish_review' and state='uncertain' and review_id=$3 and target_device_id=$4 and target_deployment_id=$5",
          [
            payload.uncertainOperationId,
            actor.userId,
            payload.reviewId,
            input.targetDeviceId,
            input.targetDeploymentId
          ]
        );
        const original = found.rows[0];
        if (!original)
          throw conflict(
            "Only the matching uncertain publication can be reconciled"
          );
        const originalPayload = await decryptJson<PullRequestOperationPayload>(
          provider(),
          original.encrypted_payload
        );
        if (
          originalPayload.kind !== "publish_review" ||
          originalPayload.frozenReviewId !== payload.frozenReviewId
        )
          throw conflict(
            "Reconciliation target does not match the uncertain publication"
          );
      }
      if (payload.kind === "reconcile_push") {
        const found = await pool.query<OperationRow>(
          "select * from pull_request_operations where id=$1 and owner_user_id=$2 and kind='push' and state='uncertain' and review_id=$3 and target_device_id=$4 and target_deployment_id=$5",
          [
            payload.uncertainOperationId,
            actor.userId,
            payload.reviewId,
            input.targetDeviceId,
            input.targetDeploymentId
          ]
        );
        const original = found.rows[0];
        if (!original)
          throw conflict("Only the matching uncertain push can be reconciled");
        const originalPayload = await decryptJson<PullRequestOperationPayload>(
          provider(),
          original.encrypted_payload
        );
        if (
          originalPayload.kind !== "push" ||
          originalPayload.pushProposalId !== payload.pushProposalId
        )
          throw conflict(
            "Reconciliation target does not match the uncertain push"
          );
      }
      const requestDigest = hash({
        targetDeviceId: input.targetDeviceId,
        targetDeploymentId: input.targetDeploymentId,
        reviewId,
        payload
      });
      const existing = await pool.query<OperationRow>(
        "select * from pull_request_operations where owner_user_id=$1 and request_id=$2",
        [actor.userId, input.requestId]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_digest !== requestDigest)
          throw conflict(
            "Operation request id was reused",
            "IDEMPOTENCY_CONFLICT"
          );
        return mapOperation(existing.rows[0], provider());
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const globalInbox = isGlobalInboxPayload(payload);
        const inboxScope =
          payload.kind === "inbox"
            ? {
                targetDeviceId: input.targetDeviceId,
                targetDeploymentId: input.targetDeploymentId,
                accountId: payload.account.id,
                connectionGeneration: payload.connectionGeneration
              }
            : null;
        if (globalInbox && inboxScope) {
          const advisoryKey = [
            actor.userId,
            inboxScope.targetDeviceId,
            inboxScope.targetDeploymentId,
            inboxScope.accountId,
            inboxScope.connectionGeneration
          ].join(":");
          await client.query(
            "select pg_advisory_xact_lock(hashtextextended($1,0))",
            [advisoryKey]
          );
          const active = await findGlobalInboxOperation(
            client,
            actor.userId,
            provider(),
            inboxScope,
            ["pending", "claimed"]
          );
          if (active) {
            await client.query("commit");
            return mapOperation(active, provider());
          }
        }
        if (payload.kind === "publish_review") {
          const frozen = await client.query<{ state: string; digest: string }>(
            "select state,digest from pull_request_review_freezes where id=$1 and review_id=$2 and owner_user_id=$3 for update",
            [payload.frozenReviewId, reviewId, actor.userId]
          );
          if (
            frozen.rows[0]?.state !== "frozen" ||
            frozen.rows[0].digest !== payload.confirmationDigest
          )
            throw conflict(
              "Frozen review confirmation is stale or already being dispatched"
            );
        }
        const id = randomUUID();
        const encrypted = await encryptJson(
          provider(),
          actor.userId,
          "pull_request_operations",
          id,
          "payload",
          payload
        );
        const inboxMetadata =
          payload.kind === "inbox"
            ? [payload.account.id, payload.connectionGeneration, globalInbox]
            : [null, null, null];
        const inserted = await client.query<OperationRow>(
          "insert into pull_request_operations(id,owner_user_id,review_id,target_device_id,target_deployment_id,request_id,request_digest,kind,inbox_account_id,inbox_connection_generation,is_global_inbox,encrypted_payload) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) on conflict do nothing returning *",
          [
            id,
            actor.userId,
            reviewId,
            input.targetDeviceId,
            input.targetDeploymentId,
            input.requestId,
            requestDigest,
            payload.kind,
            ...inboxMetadata,
            JSON.stringify(encrypted)
          ]
        );
        let row = inserted.rows[0];
        if (!row) {
          const old = await client.query<OperationRow>(
            "select * from pull_request_operations where owner_user_id=$1 and request_id=$2",
            [actor.userId, input.requestId]
          );
          row = old.rows[0];
          if (row && row.request_digest !== requestDigest)
            throw conflict(
              "Operation request id was reused",
              "IDEMPOTENCY_CONFLICT"
            );
          if (!row && globalInbox && inboxScope) {
            row =
              (await findGlobalInboxOperation(
                client,
                actor.userId,
                provider(),
                inboxScope,
                ["pending", "claimed"]
              )) ?? undefined;
          }
          if (!row) throw conflict("Unable to enqueue the inbox operation");
        }
        await client.query("commit");
        return mapOperation(row, provider());
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async getPullRequestOperation(actor, { operationId }) {
      if (!UUID.test(operationId)) return null;
      const result = await pool.query<OperationRow>(
        "select * from pull_request_operations where id=$1 and owner_user_id=$2",
        [operationId, actor.userId]
      );
      return result.rows[0] ? mapOperation(result.rows[0], provider()) : null;
    },
    async listPullRequestOperations(actor, input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
      const cursor = parsePageCursor(input.before);
      let cursorTimestamp: string | null = null;
      if (cursor) {
        const ownedCursor = await pool.query<{ cursor_timestamp: string }>(
          `select ${exactTimestampSql} as cursor_timestamp from pull_request_operations where id=$1 and owner_user_id=$2`,
          [cursor.id, actor.userId]
        );
        if (
          !ownedCursor.rows[0] ||
          ownedCursor.rows[0].cursor_timestamp !== cursor.timestamp
        )
          throw invalid("Page cursor is unavailable");
        cursorTimestamp = ownedCursor.rows[0].cursor_timestamp;
      }
      const result = await pool.query<
        OperationRow & { cursor_timestamp: string }
      >(
        `select *, ${exactTimestampSql} as cursor_timestamp from pull_request_operations where owner_user_id=$1 and ($2::timestamptz is null or (updated_at,id)<($2::timestamptz,$3::uuid)) order by updated_at desc,id desc limit $4`,
        [actor.userId, cursorTimestamp, cursor?.id ?? null, limit + 1]
      );
      const rows = result.rows.slice(0, limit);
      const operations = await Promise.all(
        rows.map((row) => mapOperation(row, provider()))
      );
      const last = rows.at(-1);
      return {
        operations,
        nextCursor:
          result.rows.length > limit && last
            ? last.cursor_timestamp + "." + last.id
            : null
      };
    },
    async getPullRequestInboxSnapshot(actor, input) {
      if (
        !UUID.test(input.targetDeviceId) ||
        !UUID.test(input.targetDeploymentId) ||
        !input.accountId.trim() ||
        input.accountId.length > 200 ||
        !Number.isSafeInteger(input.connectionGeneration) ||
        input.connectionGeneration < 1
      )
        throw invalid("Inbox snapshot scope is invalid");
      const scope = input;
      const [completed, pending] = await Promise.all([
        findGlobalInboxOperation(pool, actor.userId, provider(), scope, [
          "completed"
        ]),
        findGlobalInboxOperation(pool, actor.userId, provider(), scope, [
          "pending",
          "claimed"
        ])
      ]);
      const [operation, pendingOperation] = await Promise.all([
        completed ? mapOperation(completed, provider()) : null,
        pending ? mapOperation(pending, provider()) : null
      ]);
      return { operation, pendingOperation };
    },
    async cancelPullRequestOperation(actor, input) {
      const result = await pool.query<OperationRow>(
        "update pull_request_operations set state='cancelled',revision=revision+1,completed_at=now(),updated_at=now() where id=$1 and owner_user_id=$2 and state='pending' and revision=$3 returning *",
        [input.operationId, actor.userId, input.expectedRevision]
      );
      if (result.rows[0]) return mapOperation(result.rows[0], provider());
      const exists = await pool.query(
        "select 1 from pull_request_operations where id=$1 and owner_user_id=$2",
        [input.operationId, actor.userId]
      );
      if (!exists.rowCount) return null;
      throw conflict("Only an unclaimed operation can be cancelled");
    },
    async claimPullRequestOperations(input) {
      if (
        !UUID.test(input.ownerUserId) ||
        !UUID.test(input.runnerDeploymentId) ||
        !UUID.test(input.runnerDeviceId) ||
        input.limit < 1 ||
        input.limit > 32 ||
        input.leaseMs < 5000 ||
        input.leaseMs > 300000
      )
        throw invalid("Operation claim is invalid");
      const client = await pool.connect();
      try {
        await client.query("begin");
        const expired = await client.query<OperationRow>(
          "select * from pull_request_operations where owner_user_id=$1 and target_deployment_id=$2 and target_device_id=$3 and state='claimed' and lease_expires_at<=now() for update skip locked",
          [input.ownerUserId, input.runnerDeploymentId, input.runnerDeviceId]
        );
        for (const row of expired.rows) {
          const payload = await decryptJson<PullRequestOperationPayload>(
            provider(),
            row.encrypted_payload
          );
          const writes = ["publish_review", "push", "disconnect"].includes(
            payload.kind
          );
          await client.query(
            writes
              ? "update pull_request_operations set state='uncertain',lease_token=null,lease_expires_at=null,claimed_by_runner_id=null,error_code='lease_expired',revision=revision+1,completed_at=now(),updated_at=now() where id=$1"
              : "update pull_request_operations set state='pending',lease_token=null,lease_expires_at=null,claimed_by_runner_id=null,revision=revision+1,updated_at=now() where id=$1",
            [row.id]
          );
          if (payload.kind === "publish_review")
            await client.query(
              "update pull_request_review_freezes set state='uncertain' where id=$1 and owner_user_id=$2 and state='dispatching'",
              [payload.frozenReviewId, input.ownerUserId]
            );
          if (payload.kind === "publish_review")
            await client.query(
              "update pull_request_reviews set status='uncertain',revision=revision+1,updated_at=now() where id=$1 and owner_user_id=$2",
              [payload.reviewId, input.ownerUserId]
            );
        }
        const claimed = await client.query<OperationRow>(
          "with candidates as (select id from pull_request_operations where owner_user_id=$1 and target_deployment_id=$2 and target_device_id=$3 and state='pending' order by created_at,id for update skip locked limit $4) update pull_request_operations o set state='claimed',lease_token=gen_random_uuid(),lease_expires_at=now()+($5::int*interval '1 millisecond'),claimed_by_runner_id=$6,attempt=attempt+1,revision=revision+1,updated_at=now() from candidates where o.id=candidates.id returning o.*",
          [
            input.ownerUserId,
            input.runnerDeploymentId,
            input.runnerDeviceId,
            input.limit,
            input.leaseMs,
            input.runnerId
          ]
        );
        const claims: PullRequestOperationClaim[] = [];
        for (const row of claimed.rows) {
          const operation = await mapOperation(row, provider());
          let allowed = true;
          let currentReviewExecution: {
            revision: number;
            execution_id: string;
            execution_generation: number;
          } | null = null;
          if (
            operation.payload.kind === "publish_review" ||
            operation.payload.kind === "push"
          ) {
            const current = await client.query<{
              revision: number;
              execution_id: string;
              execution_generation: number;
            }>(
              "select review.revision,review.execution_id,execution.execution_generation from pull_request_reviews review join managed_conversation_executions execution on execution.id=review.execution_id and execution.owner_user_id=review.owner_user_id where review.id=$1 and review.owner_user_id=$2 and review.target_device_id=$3 and review.target_deployment_id=$4 and execution.runner_device_id=$3 and execution.runner_deployment_id=$4 for share of review,execution",
              [
                operation.payload.reviewId,
                input.ownerUserId,
                input.runnerDeviceId,
                input.runnerDeploymentId
              ]
            );
            currentReviewExecution = current.rows[0] ?? null;
            allowed =
              currentReviewExecution?.revision ===
              operation.payload.expectedReviewRevision;
          }
          if (operation.payload.kind === "publish_review") {
            if (allowed) {
              const frozen = await client.query<{ id: string }>(
                "update pull_request_review_freezes set state='dispatching' where id=$1 and review_id=$2 and owner_user_id=$3 and state='frozen' and digest=$4 returning id",
                [
                  operation.payload.frozenReviewId,
                  operation.payload.reviewId,
                  input.ownerUserId,
                  operation.payload.confirmationDigest
                ]
              );
              allowed = Boolean(frozen.rows[0]);
            }
          } else if (operation.payload.kind === "push") {
            const proposal = await client.query<OperationRow>(
              "select * from pull_request_operations where id=$1 and owner_user_id=$2 and kind='prepare_push' and state='completed' and write_dispatched=false for update",
              [operation.payload.pushProposalId, input.ownerUserId]
            );
            const prepared = proposal.rows[0];
            const preparedPayload = prepared
              ? await decryptJson<PullRequestOperationPayload>(
                  provider(),
                  prepared.encrypted_payload
                )
              : null;
            const preparedResult = prepared?.encrypted_result
              ? await decryptJson<PullRequestOperationResult>(
                  provider(),
                  prepared.encrypted_result
                )
              : null;
            allowed =
              allowed &&
              Boolean(
                prepared &&
                preparedPayload?.kind === "prepare_push" &&
                preparedPayload.reviewId === operation.payload.reviewId &&
                preparedResult &&
                preparedResult.executionId ===
                  currentReviewExecution?.execution_id &&
                Number.isSafeInteger(preparedResult.executionGeneration) &&
                preparedResult.executionGeneration ===
                  currentReviewExecution?.execution_generation &&
                preparedResult?.diffDigest ===
                  operation.payload.confirmationDigest
              );
            if (allowed)
              await client.query(
                "update pull_request_operations set write_dispatched=true where id=$1 and write_dispatched=false",
                [operation.payload.pushProposalId]
              );
          }
          if (!allowed) {
            await client.query(
              "update pull_request_operations set state='failed',lease_token=null,lease_expires_at=null,claimed_by_runner_id=null,error_code='write_confirmation_unavailable',revision=revision+1,completed_at=now(),updated_at=now() where id=$1",
              [row.id]
            );
            continue;
          }
          claims.push({
            operation,
            leaseToken: row.lease_token!,
            payload: operation.payload
          });
        }
        await client.query("commit");
        return claims;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async heartbeatPullRequestOperation(input) {
      const result = await pool.query<OperationRow>(
        "update pull_request_operations set lease_expires_at=now()+($7::int*interval '1 millisecond'),revision=revision+1,updated_at=now() where id=$1 and owner_user_id=$2 and target_deployment_id=$3 and target_device_id=$4 and claimed_by_runner_id=$5 and lease_token=$6 and state='claimed' and lease_expires_at>now() returning *",
        [
          input.operationId,
          input.ownerUserId,
          input.runnerDeploymentId,
          input.runnerDeviceId,
          input.runnerId,
          input.leaseToken,
          input.leaseMs
        ]
      );
      return result.rows[0] ? mapOperation(result.rows[0], provider()) : null;
    },
    async completePullRequestOperation(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const found = await client.query<OperationRow>(
          "select * from pull_request_operations where id=$1 and owner_user_id=$2 and target_deployment_id=$3 and target_device_id=$4 and claimed_by_runner_id=$5 and lease_token=$6 and state='claimed' and lease_expires_at>now() for update",
          [
            input.operationId,
            input.ownerUserId,
            input.runnerDeploymentId,
            input.runnerDeviceId,
            input.runnerId,
            input.leaseToken
          ]
        );
        const row = found.rows[0];
        if (!row) {
          await client.query("rollback");
          return null;
        }
        const payload = await decryptJson<PullRequestOperationPayload>(
          provider(),
          row.encrypted_payload
        );
        if (payload.kind === "prepare_push") {
          const current = await client.query<{
            execution_id: string;
            execution_generation: number;
          }>(
            "select review.execution_id,execution.execution_generation from pull_request_reviews review join managed_conversation_executions execution on execution.id=review.execution_id and execution.owner_user_id=review.owner_user_id where review.id=$1 and review.owner_user_id=$2 and review.target_device_id=$3 and review.target_deployment_id=$4 and execution.runner_device_id=$3 and execution.runner_deployment_id=$4 for share of review,execution",
            [
              payload.reviewId,
              input.ownerUserId,
              input.runnerDeviceId,
              input.runnerDeploymentId
            ]
          );
          if (
            !current.rows[0] ||
            input.result.executionId !== current.rows[0].execution_id ||
            !Number.isSafeInteger(input.result.executionGeneration) ||
            input.result.executionGeneration !==
              current.rows[0].execution_generation
          )
            throw conflict(
              "Push proposal is not bound to the current managed execution"
            );
        }
        const encrypted = await encryptJson(
          provider(),
          input.ownerUserId,
          "pull_request_operations",
          row.id,
          "result",
          input.result
        );
        const done = await client.query<OperationRow>(
          "update pull_request_operations set state='completed',encrypted_result=$7::jsonb,lease_token=null,lease_expires_at=null,claimed_by_runner_id=null,error_code=null,revision=revision+1,completed_at=now(),updated_at=now() where id=$1 and owner_user_id=$2 and target_deployment_id=$3 and target_device_id=$4 and claimed_by_runner_id=$5 and lease_token=$6 and state='claimed' returning *",
          [
            input.operationId,
            input.ownerUserId,
            input.runnerDeploymentId,
            input.runnerDeviceId,
            input.runnerId,
            input.leaseToken,
            JSON.stringify(encrypted)
          ]
        );
        if (done.rows[0] && payload.kind === "publish_review") {
          await client.query(
            "update pull_request_review_freezes set state='published' where id=$1 and owner_user_id=$2 and state='dispatching'",
            [payload.frozenReviewId, input.ownerUserId]
          );
          await client.query(
            "update pull_request_reviews set status='published',revision=revision+1,updated_at=now() where id=$1 and owner_user_id=$2",
            [payload.reviewId, input.ownerUserId]
          );
        }
        if (
          done.rows[0] &&
          payload.kind === "reconcile_review" &&
          input.result.confirmed === true
        ) {
          const uncertain = await client.query<OperationRow>(
            "select * from pull_request_operations where id=$1 and owner_user_id=$2 and kind='publish_review' and state='uncertain' and review_id=$3 for update",
            [payload.uncertainOperationId, input.ownerUserId, payload.reviewId]
          );
          const original = uncertain.rows[0];
          const originalPayload = original
            ? await decryptJson<PullRequestOperationPayload>(
                provider(),
                original.encrypted_payload
              )
            : null;
          const frozenRow = await client.query<{
            encrypted_payload: Envelope;
            state: string;
          }>(
            "select encrypted_payload,state from pull_request_review_freezes where id=$1 and owner_user_id=$2 and review_id=$3",
            [payload.frozenReviewId, input.ownerUserId, payload.reviewId]
          );
          const frozen = frozenRow.rows[0]
            ? await decryptJson<PullRequestFrozenReview>(
                provider(),
                frozenRow.rows[0].encrypted_payload
              )
            : null;
          const exact = Boolean(
            original &&
            originalPayload?.kind === "publish_review" &&
            originalPayload.frozenReviewId === payload.frozenReviewId &&
            input.result.uncertainOperationId ===
              payload.uncertainOperationId &&
            input.result.frozenReviewId === payload.frozenReviewId &&
            input.result.reviewId === payload.reviewId &&
            frozen &&
            frozen.digest === input.result.frozenDigest &&
            frozen.body === input.result.body &&
            frozen.headSha === input.result.headSha &&
            frozen.event === input.result.event &&
            hash(frozen.findings) === input.result.commentsDigest &&
            typeof input.result.githubReviewId === "string"
          );
          if (exact) {
            await client.query(
              "update pull_request_operations set state='completed',encrypted_result=$3::jsonb,error_code=null,revision=revision+1,completed_at=now(),updated_at=now() where id=$1 and owner_user_id=$2 and state='uncertain'",
              [
                payload.uncertainOperationId,
                input.ownerUserId,
                JSON.stringify(encrypted)
              ]
            );
            await client.query(
              "update pull_request_review_freezes set state='published' where id=$1 and owner_user_id=$2 and state='uncertain'",
              [payload.frozenReviewId, input.ownerUserId]
            );
            await client.query(
              "update pull_request_reviews set status='published',revision=revision+1,updated_at=now() where id=$1 and owner_user_id=$2 and expected_base_sha=$3 and expected_head_sha=$4",
              [
                payload.reviewId,
                input.ownerUserId,
                frozen!.baseSha,
                frozen!.headSha
              ]
            );
          }
        }
        if (
          done.rows[0] &&
          payload.kind === "reconcile_push" &&
          input.result.confirmed === true
        ) {
          const uncertain = await client.query<OperationRow>(
            "select * from pull_request_operations where id=$1 and owner_user_id=$2 and kind='push' and state='uncertain' and review_id=$3 for update",
            [payload.uncertainOperationId, input.ownerUserId, payload.reviewId]
          );
          const original = uncertain.rows[0];
          const originalPayload = original
            ? await decryptJson<PullRequestOperationPayload>(
                provider(),
                original.encrypted_payload
              )
            : null;
          const prepared = await client.query<OperationRow>(
            "select * from pull_request_operations where id=$1 and owner_user_id=$2 and kind='prepare_push' and state='completed' and review_id=$3",
            [payload.pushProposalId, input.ownerUserId, payload.reviewId]
          );
          const proposed = prepared.rows[0]?.encrypted_result
            ? await decryptJson<PullRequestOperationResult>(
                provider(),
                prepared.rows[0].encrypted_result
              )
            : null;
          const exact = Boolean(
            original &&
            originalPayload?.kind === "push" &&
            originalPayload.pushProposalId === payload.pushProposalId &&
            input.result.uncertainOperationId ===
              payload.uncertainOperationId &&
            input.result.pushProposalId === payload.pushProposalId &&
            input.result.reviewId === payload.reviewId &&
            proposed?.commitSha === input.result.proposedCommitSha &&
            proposed?.commitSha === input.result.remoteHeadSha &&
            proposed?.diffDigest === input.result.diffDigest
          );
          if (exact)
            await client.query(
              "update pull_request_operations set state='completed',encrypted_result=$3::jsonb,error_code=null,revision=revision+1,completed_at=now(),updated_at=now() where id=$1 and owner_user_id=$2 and state='uncertain'",
              [
                payload.uncertainOperationId,
                input.ownerUserId,
                JSON.stringify(encrypted)
              ]
            );
        }
        await client.query("commit");
        return done.rows[0] ? mapOperation(done.rows[0], provider()) : null;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async failPullRequestOperation(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const found = await client.query<OperationRow>(
          "select * from pull_request_operations where id=$1 and owner_user_id=$2 and target_deployment_id=$3 and target_device_id=$4 and claimed_by_runner_id=$5 and lease_token=$6 and state='claimed' and lease_expires_at>now() for update",
          [
            input.operationId,
            input.ownerUserId,
            input.runnerDeploymentId,
            input.runnerDeviceId,
            input.runnerId,
            input.leaseToken
          ]
        );
        const row = found.rows[0];
        if (!row) {
          await client.query("rollback");
          return null;
        }
        const payload = await decryptJson<PullRequestOperationPayload>(
          provider(),
          row.encrypted_payload
        );
        const done = await client.query<OperationRow>(
          "update pull_request_operations set state=$7,lease_token=null,lease_expires_at=null,claimed_by_runner_id=null,error_code=$8,revision=revision+1,completed_at=now(),updated_at=now() where id=$1 and owner_user_id=$2 and target_deployment_id=$3 and target_device_id=$4 and claimed_by_runner_id=$5 and lease_token=$6 and state='claimed' returning *",
          [
            input.operationId,
            input.ownerUserId,
            input.runnerDeploymentId,
            input.runnerDeviceId,
            input.runnerId,
            input.leaseToken,
            input.state,
            input.errorCode
          ]
        );
        if (done.rows[0] && payload.kind === "publish_review") {
          if (input.state === "uncertain") {
            await client.query(
              "update pull_request_review_freezes set state='uncertain' where id=$1 and owner_user_id=$2 and state='dispatching'",
              [payload.frozenReviewId, input.ownerUserId]
            );
            await client.query(
              "update pull_request_reviews set status='uncertain',revision=revision+1,updated_at=now() where id=$1 and owner_user_id=$2",
              [payload.reviewId, input.ownerUserId]
            );
          } else {
            await client.query(
              "update pull_request_review_freezes set state='frozen' where id=$1 and owner_user_id=$2 and state='dispatching'",
              [payload.frozenReviewId, input.ownerUserId]
            );
          }
        }
        await client.query("commit");
        return done.rows[0] ? mapOperation(done.rows[0], provider()) : null;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async markPullRequestReviewCompleted(input) {
      if (
        !Number.isSafeInteger(input.expectedReviewRevision) ||
        input.expectedReviewRevision < 1
      )
        return null;
      const client = await pool.connect();
      try {
        await client.query("begin");
        const normalizedResult = {
          event: input.result.event,
          body: input.result.body,
          findings: input.result.findings.map((finding) => ({
            path: finding.path,
            line: finding.line,
            side: finding.side,
            body: finding.body
          }))
        };
        pullRequestReviewDraftSchema.parse({
          reviewId: input.reviewId,
          revision: 1,
          origin: "agent",
          executionGeneration: input.executionGeneration,
          accountId: "validated-after-command-lookup",
          baseSha: input.baseSha,
          headSha: input.headSha,
          ...normalizedResult,
          updatedAt: new Date().toISOString()
        });
        const resultDigest = hash(normalizedResult);
        const proofResult = await client.query<
          ReviewRow & {
            current_review_revision: number;
            command_kind: string;
            command_state: string;
            command_lease_token: string | null;
            command_lease_expires_at: Date | null;
            command_encrypted_payload: Envelope | null;
            execution_state: string;
            execution_provider: string;
            execution_ai_client_instance_id: string;
            execution_model: string;
            execution_provider_cli_version: string | null;
          }
        >(
          `select review.*,review.revision as current_review_revision,
                  command.command_kind,command.state as command_state,
                  command.lease_token as command_lease_token,
                  command.lease_expires_at as command_lease_expires_at,
                  command.encrypted_payload as command_encrypted_payload,
                  execution.state as execution_state,
                  execution.provider as execution_provider,
                  execution.ai_client_instance_id as execution_ai_client_instance_id,
                  execution.model as execution_model,
                  execution.provider_cli_version as execution_provider_cli_version
             from pull_request_reviews review
             join managed_conversation_executions execution
               on execution.id=review.execution_id
              and execution.owner_user_id=review.owner_user_id
             join managed_conversation_commands command
               on command.id=$9
              and command.execution_id=execution.id
              and command.owner_user_id=execution.owner_user_id
            where review.id=$1 and review.owner_user_id=$2
              and review.execution_id=$3
              and review.target_deployment_id=$4
              and review.target_device_id=$5
              and review.expected_base_sha=$6
              and review.expected_head_sha=$7
              and review.work_mode='review'
              and execution.execution_generation=$8
              and execution.runner_deployment_id=$4
              and execution.runner_device_id=$5
              and command.execution_generation=$8
              and command.command_kind='prompt'
            for update of review,execution,command`,
          [
            input.reviewId,
            input.ownerUserId,
            input.executionId,
            input.runnerDeploymentId,
            input.runnerDeviceId,
            input.baseSha,
            input.headSha,
            input.executionGeneration,
            input.commandId
          ]
        );
        const proof = proofResult.rows[0];
        if (!proof?.command_encrypted_payload) {
          await client.query("rollback");
          return null;
        }
        const commandPayload = await decryptJson<Record<string, unknown>>(
          provider(),
          proof.command_encrypted_payload
        );
        const agentContext = personalAgentExecutionContextSchema.safeParse(
          commandPayload.personalAgentContext
        );
        const personalAgent = commandPayload.personalAgent;
        if (
          commandPayload.pullRequestReviewId !== input.reviewId ||
          commandPayload.pullRequestReviewRevision !==
            input.expectedReviewRevision ||
          !agentContext.success ||
          !personalAgent ||
          typeof personalAgent !== "object" ||
          Array.isArray(personalAgent) ||
          !(
            "agentId" in personalAgent &&
            "agentVersion" in personalAgent &&
            "identityVersionId" in personalAgent &&
            "jobId" in personalAgent
          ) ||
          personalAgent.jobId !== null ||
          personalAgent.agentId !== proof.agent_id ||
          personalAgent.agentVersion !== proof.agent_version ||
          personalAgent.agentVersion !== agentContext.data.identity.version ||
          personalAgent.identityVersionId !==
            agentContext.data.identity.identityVersionId ||
          agentContext.data.identity.agentId !== proof.agent_id
        ) {
          await client.query("rollback");
          return null;
        }
        const identityVersion = await client.query<{ id: string }>(
          `select id from personal_agent_identity_versions
            where owner_user_id=$1 and agent_id=$2 and version=$3 and id=$4`,
          [
            input.ownerUserId,
            proof.agent_id,
            agentContext.data.identity.version,
            agentContext.data.identity.identityVersionId
          ]
        );
        if (!identityVersion.rows[0]) {
          await client.query("rollback");
          return null;
        }

        const prior = await client.query<{
          review_id: string;
          revision: number;
          execution_generation: number | null;
          account_id: string;
          base_sha: string;
          head_sha: string;
          encrypted_payload: Envelope;
          updated_at: Date;
          source_execution_id: string;
          source_agent_version: number;
          source_provider: string;
          source_ai_client_instance_id: string;
          source_model: string;
          source_provider_cli_version: string | null;
          source_review_revision: number;
          source_lease_token_digest: string;
          source_result_digest: string;
        }>(
          `select d.review_id,d.revision,d.execution_generation,d.account_id,
                  d.base_sha,d.head_sha,d.encrypted_payload,d.updated_at,
                  d.source_execution_id,d.source_agent_version,d.source_provider,
                  d.source_ai_client_instance_id,d.source_model,
                  d.source_provider_cli_version,d.source_review_revision,
                  d.source_lease_token_digest,d.source_result_digest
             from pull_request_review_drafts d
            where d.review_id=$1 and d.owner_user_id=$2
              and d.source_command_id=$3`,
          [input.reviewId, input.ownerUserId, input.commandId]
        );
        if (prior.rows[0]) {
          const saved = prior.rows[0];
          const liveCommandLease =
            (proof.execution_state === "running" ||
              proof.execution_state === "reconciling") &&
            proof.command_state === "dispatching" &&
            proof.command_lease_token === input.leaseToken &&
            proof.command_lease_expires_at !== null &&
            proof.command_lease_expires_at.getTime() > Date.now();
          const acknowledgedTerminalReplay =
            proof.command_state === "completed" &&
            saved.source_lease_token_digest ===
              digestLeaseToken(input.leaseToken);
          if (
            (!liveCommandLease && !acknowledgedTerminalReplay) ||
            proof.current_review_revision !==
              input.expectedReviewRevision + 1 ||
            proof.draft_revision !== saved.revision ||
            proof.status !== "draft" ||
            proof.reviewed_base_sha !== input.baseSha ||
            proof.reviewed_head_sha !== input.headSha ||
            proof.reviewed_execution_generation !== input.executionGeneration ||
            saved.source_execution_id !== input.executionId ||
            saved.source_agent_version !== agentContext.data.identity.version ||
            saved.source_provider !== proof.execution_provider ||
            saved.source_ai_client_instance_id !==
              proof.execution_ai_client_instance_id ||
            saved.source_model !== proof.execution_model ||
            saved.source_provider_cli_version !==
              proof.execution_provider_cli_version ||
            saved.source_review_revision !== input.expectedReviewRevision ||
            saved.source_result_digest !== resultDigest
          ) {
            await client.query("rollback");
            return null;
          }
          const content = await decryptJson<{
            event: PullRequestReviewDraft["event"];
            body: string;
            findings: PullRequestReviewDraft["findings"];
          }>(provider(), saved.encrypted_payload);
          if (hash(content) !== resultDigest) {
            await client.query("rollback");
            return null;
          }
          await client.query("commit");
          return pullRequestReviewDraftSchema.parse({
            reviewId: saved.review_id,
            revision: saved.revision,
            origin: "agent",
            executionGeneration: saved.execution_generation,
            accountId: saved.account_id,
            baseSha: saved.base_sha,
            headSha: saved.head_sha,
            ...content,
            updatedAt: saved.updated_at.toISOString()
          });
        }
        if (
          proof.current_review_revision !== input.expectedReviewRevision ||
          (proof.execution_state !== "running" &&
            proof.execution_state !== "reconciling") ||
          proof.command_state !== "dispatching" ||
          proof.command_lease_token !== input.leaseToken ||
          !proof.command_lease_expires_at ||
          proof.command_lease_expires_at.getTime() <= Date.now()
        ) {
          await client.query("rollback");
          return null;
        }
        const selection = await decryptJson<{ account: PullRequestAccount }>(
          provider(),
          proof.encrypted_selection
        );
        const revision = proof.draft_revision + 1;
        const id = randomUUID();
        const encrypted = await encryptJson(
          provider(),
          input.ownerUserId,
          "pull_request_review_drafts",
          id,
          "payload",
          normalizedResult
        );
        const inserted = await client.query<{ updated_at: Date }>(
          `insert into pull_request_review_drafts(
             id,review_id,owner_user_id,revision,origin,execution_generation,
             source_execution_id,source_command_id,source_agent_version,
             source_provider,source_ai_client_instance_id,source_model,
             source_provider_cli_version,source_review_revision,
             source_lease_token_digest,source_result_digest,account_id,
             base_sha,head_sha,encrypted_payload
           ) values(
             $1,$2,$3,$4,'agent',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb
           ) returning updated_at`,
          [
            id,
            proof.id,
            input.ownerUserId,
            revision,
            input.executionGeneration,
            input.executionId,
            input.commandId,
            agentContext.data.identity.version,
            proof.execution_provider,
            proof.execution_ai_client_instance_id,
            proof.execution_model,
            proof.execution_provider_cli_version,
            input.expectedReviewRevision,
            digestLeaseToken(input.leaseToken),
            resultDigest,
            selection.account.id,
            input.baseSha,
            input.headSha,
            JSON.stringify(encrypted)
          ]
        );
        const completed = await client.query(
          `update pull_request_reviews review
              set agent_version=$7,draft_revision=$3,reviewed_base_sha=$4,
                  reviewed_head_sha=$5,reviewed_execution_generation=$6,
                  status='draft',revision=revision+1,updated_at=now()
            where review.id=$1 and review.owner_user_id=$2 and review.revision=$8`,
          [
            proof.id,
            input.ownerUserId,
            revision,
            input.baseSha,
            input.headSha,
            input.executionGeneration,
            agentContext.data.identity.version,
            input.expectedReviewRevision
          ]
        );
        if (!completed.rowCount) {
          await client.query("rollback");
          return null;
        }
        await client.query("commit");
        return pullRequestReviewDraftSchema.parse({
          reviewId: proof.id,
          revision,
          origin: "agent",
          executionGeneration: input.executionGeneration,
          accountId: selection.account.id,
          baseSha: input.baseSha,
          headSha: input.headSha,
          ...normalizedResult,
          updatedAt: inserted.rows[0]!.updated_at.toISOString()
        });
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  };
};

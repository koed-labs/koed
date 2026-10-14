import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import {
  buildMultiAgentPublicContext,
  decryptEnvelopeToUtf8,
  personalAgentChatConversationSchema,
  personalAgentChatConversationPageSchema,
  personalAgentChatSubmitResponseSchema,
  multiAgentContextCursorAfterDelivery,
  type EnvelopeEncryptionProvider,
  type EncryptedPayloadEnvelope,
  type PersonalAgentChatContextTransfer,
  type PersonalAgentChatConversation,
  type PersonalAgentChatConversationPage,
  type PersonalAgentChatConversationSummary,
  type PersonalAgentChatDelivery,
  type PersonalAgentChatLaunchSnapshot,
  type PersonalAgentChatMessage,
  type PersonalAgentChatReadResponse,
  type PersonalAgentChatSubmit
} from "@koed/shared";
import {
  decryptAuthorizedEncryptedFieldPayloadsWithClient,
  encryptedFieldReferenceKey,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import type { ActorContext } from "./types.js";

const MESSAGE_SOURCE = "personal_agent_chat_messages" as const;
const DELIVERY_SOURCE = "personal_agent_chat_deliveries" as const;
const MAX_PAGE_SIZE = 100;
const CONTEXT_MAX_EXCHANGES = 24;
const CONTEXT_MAX_BYTES = 24 * 1024;

type RootRow = {
  conversation_id: string;
  owner_user_id: string;
  project_id: string | null;
  context_kind: "project" | "independent";
  target_device_id: string;
  target_deployment_id: string;
  workspace_id: string;
  title: string | null;
  source_execution_ids: string[] | null;
  status: PersonalAgentChatConversation["status"];
  active_delivery_id: string | null;
  active_agent_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  owner_user_id: string;
  turn_id: string;
  request_id: string;
  sequence: number;
  kind: "user" | "agent_reply";
  author_agent_id: string | null;
  author_agent_version: number | null;
  author_name: string | null;
  provider: string | null;
  ai_client_instance_id: string | null;
  execution_id: string | null;
  source_execution_id: string | null;
  source_command_id: string | null;
  job_id: string | null;
  truncated: boolean;
  state: PersonalAgentChatMessage["state"];
  created_at: Date;
};

type DeliveryRow = {
  id: string;
  turn_id: string;
  message_id: string;
  recipient_kind: "agent" | "generic";
  agent_id: string | null;
  agent_version: number | null;
  agent_name: string | null;
  ordinal: number;
  launch_snapshot: PersonalAgentChatLaunchSnapshot;
  claim_token: string | null;
  execution_id: string | null;
  command_id: string | null;
  job_id: string | null;
  status: PersonalAgentChatDelivery["status"];
  error_code: string | null;
  progress: Record<string, unknown> | null;
  context_transfer: PersonalAgentChatContextTransfer | null;
  diff_available: boolean;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
};

export type PersonalAgentChatSubmitInput = PersonalAgentChatSubmit & {
  conversationId: string;
  /** Server-created, version-pinned context; never accepted from the browser. */
  preparedAgentContexts?: Record<string, unknown>;
  /** Verified deployment selected for the target Personal Device. */
  targetDeploymentId: string;
};

export type ClaimedPersonalAgentChatDelivery = {
  deliveryId: string;
  conversationId: string;
  ownerUserId: string;
  turnId: string;
  messageId: string;
  ordinal: number;
  claimToken: string;
  targetDeviceId: string;
  targetDeploymentId: string;
  launch: PersonalAgentChatLaunchSnapshot;
  prompt: string;
  personalAgentContext: unknown | null;
  conversationContextText: string | null;
  contextTransfer: PersonalAgentChatContextTransfer | null;
  executionId: string | null;
  commandId: string | null;
  /** True means the provider prompt is already linked; only read-only result
   * reconciliation and terminal checkpoint capture may run. */
  reconciliationOnly: boolean;
};

export type PersonalAgentChatRepository = {
  submitPersonalAgentChatMessage(
    actor: ActorContext,
    input: PersonalAgentChatSubmitInput
  ): Promise<{
    conversation: PersonalAgentChatConversation;
    message: PersonalAgentChatMessage;
    deliveries: PersonalAgentChatDelivery[];
  }>;
  getPersonalAgentChat(
    actor: ActorContext,
    conversationId: string,
    input?: { beforeSequence?: number; limit?: number }
  ): Promise<PersonalAgentChatReadResponse | null>;
  renamePersonalAgentChat(
    actor: ActorContext,
    input: { conversationId: string; requestId: string; title: string | null }
  ): Promise<PersonalAgentChatReadResponse | null>;
  listPersonalAgentChats(
    actor: ActorContext,
    input?: { limit?: number; before?: string }
  ): Promise<PersonalAgentChatConversationPage>;
  claimNextPersonalAgentChatDelivery(input: {
    ownerUserId?: string;
    targetDeviceId: string;
    deploymentId: string;
    runnerId: string;
    leaseMs: number;
  }): Promise<ClaimedPersonalAgentChatDelivery | null>;
  renewPersonalAgentChatDeliveryClaim(input: {
    ownerUserId: string;
    deliveryId: string;
    claimToken: string;
    leaseMs: number;
  }): Promise<boolean>;
  attachManagedConversationToPersonalAgentChatDelivery(input: {
    ownerUserId: string;
    deliveryId: string;
    claimToken: string;
    executionId: string;
    commandId: string;
  }): Promise<boolean>;
  completePersonalAgentChatDelivery(input: {
    ownerUserId: string;
    deliveryId: string;
    claimToken: string;
    executionId: string;
    commandId: string;
    jobId: string | null;
    reply: string;
    truncated: boolean;
    contextTransfer: PersonalAgentChatContextTransfer | null;
  }): Promise<boolean>;
  failPersonalAgentChatDelivery(input: {
    ownerUserId: string;
    deliveryId: string;
    claimToken: string;
    certainty: "confirmed_failure" | "indeterminate";
    errorCode: string;
  }): Promise<boolean>;
  cancelPersonalAgentChatBatch(
    actor: ActorContext,
    input: {
      conversationId: string;
      messageId: string;
      requestId: string;
      confirmedStopped?: boolean;
    }
  ): Promise<{
    conversation: PersonalAgentChatConversation;
    canceledDeliveryIds: string[];
  } | null>;
  continuePersonalAgentChatBatch(
    actor: ActorContext,
    input: {
      conversationId: string;
      requestId: string;
      skipFailedDeliveryId: string;
    }
  ): Promise<{
    conversation: PersonalAgentChatConversation;
    skippedDeliveryId: string;
    resumedDeliveryId: string | null;
  } | null>;
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const requestConflict = (): Error =>
  Object.assign(new Error("Personal chat request ID was reused"), {
    statusCode: 409,
    code: "IDEMPOTENCY_CONFLICT"
  });

const ownerNotFound = (): Error =>
  Object.assign(new Error("Personal conversation not found"), {
    statusCode: 404,
    code: "NOT_FOUND"
  });

const normalizeLimit = (limit: number | undefined): number => {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw Object.assign(new Error("Timeline page limit is invalid"), {
      statusCode: 400,
      code: "INVALID_PAGE_LIMIT"
    });
  }
  return limit;
};

const mapMessage = (
  row: MessageRow,
  text: string
): PersonalAgentChatMessage => ({
  id: row.id,
  sequence: row.sequence,
  turnId: row.turn_id,
  requestId: row.request_id,
  kind: row.kind,
  text,
  authorAgentId: row.author_agent_id,
  authorAgentVersion: row.author_agent_version,
  authorName: row.author_name,
  provider: row.provider,
  aiClientInstanceId: row.ai_client_instance_id,
  executionId: row.execution_id,
  sourceExecutionId: row.source_execution_id,
  sourceCommandId: row.source_command_id,
  jobId: row.job_id,
  truncated: row.truncated,
  state: row.state,
  createdAt: iso(row.created_at)
});

const mapDelivery = (row: DeliveryRow): PersonalAgentChatDelivery => {
  const progress = row.progress ?? {};
  return {
    id: row.id,
    turnId: row.turn_id,
    messageId: row.message_id,
    recipientKind: row.recipient_kind,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    agentName: row.agent_name,
    ordinal: row.ordinal,
    executionId: row.execution_id,
    commandId: row.command_id,
    jobId: row.job_id,
    provider: row.launch_snapshot.provider,
    aiClientInstanceId: row.launch_snapshot.aiClientInstanceId,
    model: row.launch_snapshot.model,
    status: row.status,
    errorCode: row.error_code,
    canContinue: row.status === "failed",
    progress: {
      stage: typeof progress.stage === "string" ? progress.stage : null,
      summary: typeof progress.summary === "string" ? progress.summary : null,
      observedAt:
        typeof progress.observedAt === "string" ? progress.observedAt : null
    },
    contextTransfer: row.context_transfer,
    diffAvailable: row.diff_available,
    startedAt: row.started_at ? iso(row.started_at) : null,
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    updatedAt: iso(row.updated_at)
  };
};

export const createPersonalAgentChatRepository = (
  pool: pg.Pool,
  options: {
    envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
    getPersonalAgentTurnOutput?: (
      actor: ActorContext,
      input: { jobId: string }
    ) => Promise<string | null>;
  } = {}
): PersonalAgentChatRepository => {
  const requireProvider = (): EnvelopeEncryptionProvider => {
    if (!options.envelopeEncryptionProvider) {
      throw new Error(
        "Envelope encryption provider is required for Personal chats"
      );
    }
    return options.envelopeEncryptionProvider;
  };

  const loadConversation = async (
    actor: ActorContext,
    conversationId: string,
    page: { beforeSequence?: number; limit?: number } = {},
    client: pg.Pool | pg.PoolClient = pool
  ): Promise<PersonalAgentChatReadResponse | null> => {
    const limit = normalizeLimit(page.limit);
    const rootResult = await client.query<RootRow>(
      `select r.*, c.active_agent_id
         from personal_agent_chat_roots r
         join personal_agent_conversations c
           on c.conversation_id = r.conversation_id and c.owner_user_id = r.owner_user_id
        where r.conversation_id = $1 and r.owner_user_id = $2`,
      [conversationId, actor.userId]
    );
    const root = rootResult.rows[0];
    if (!root) return null;

    const sequenceValues: unknown[] = [conversationId, actor.userId];
    let beforeClause = "";
    if (page.beforeSequence !== undefined) {
      if (
        !Number.isSafeInteger(page.beforeSequence) ||
        page.beforeSequence < 1
      ) {
        throw Object.assign(new Error("Timeline cursor is invalid"), {
          statusCode: 400,
          code: "INVALID_TIMELINE_CURSOR"
        });
      }
      sequenceValues.push(page.beforeSequence);
      beforeClause = `and m.sequence < $${sequenceValues.length}`;
    }
    sequenceValues.push(limit + 1);
    const rawMessages = await client.query<MessageRow>(
      `select m.*, t.request_id from personal_agent_chat_messages m
        join personal_agent_chat_turns t on t.id = m.turn_id and t.owner_user_id = m.owner_user_id
        where m.conversation_id = $1 and m.owner_user_id = $2 ${beforeClause}
        order by m.sequence desc limit $${sequenceValues.length}`,
      sequenceValues
    );
    const hasMore = rawMessages.rows.length > limit;
    const selectedRows = rawMessages.rows.slice(0, limit).reverse();
    const decrypted = await decryptAuthorizedEncryptedFieldPayloadsWithClient(
      client,
      actor,
      requireProvider(),
      selectedRows.map((row) => ({
        sourceTable: MESSAGE_SOURCE,
        sourceId: row.id,
        sourceColumn: "body"
      }))
    );
    const messages = selectedRows.map((row) => {
      const payload = decrypted.get(
        encryptedFieldReferenceKey({
          sourceTable: MESSAGE_SOURCE,
          sourceId: row.id,
          sourceColumn: "body"
        })
      )?.plaintext;
      const text = typeof payload === "string" ? payload : "";
      return mapMessage(row, text);
    });

    const messageIds = messages.map((message) => message.id);
    const deliveryResult = await client.query<DeliveryRow>(
      `select * from personal_agent_chat_deliveries
        where conversation_id = $1 and owner_user_id = $2
          and (message_id = any($3::uuid[]) or id = $4)
        order by created_at, ordinal`,
      [conversationId, actor.userId, messageIds, root.active_delivery_id]
    );
    const deliveries = deliveryResult.rows.map(mapDelivery);
    const participantResult = await client.query<{
      agent_id: string;
      agent_version: number;
      ordinal: number;
      launch_snapshot: PersonalAgentChatLaunchSnapshot;
      execution_id: string | null;
      last_context_cursor: number;
      status: PersonalAgentChatDelivery["status"];
      updated_at: Date;
      name: string;
      avatar_reference: string | null;
    }>(
      `select p.agent_id, p.agent_version, p.ordinal, p.launch_snapshot,
              p.execution_id, p.last_context_cursor, p.status, p.updated_at,
              i.name, i.avatar_reference
         from personal_agent_chat_participants p
         join personal_agent_identities i
           on i.id = p.agent_id and i.owner_user_id = p.owner_user_id
        where p.conversation_id = $1 and p.owner_user_id = $2
        order by p.ordinal limit 128`,
      [conversationId, actor.userId]
    );
    const participants = participantResult.rows.map((row) => ({
      agentId: row.agent_id,
      agentVersion: row.agent_version,
      name: row.name,
      avatarReference: row.avatar_reference,
      ordinal: row.ordinal,
      launch: row.launch_snapshot,
      executionId: row.execution_id,
      lastContextCursor: row.last_context_cursor,
      status: row.status,
      updatedAt: iso(row.updated_at)
    }));

    const sourceExecutionIds = Array.isArray(root.source_execution_ids)
      ? root.source_execution_ids
      : [];
    const allChildExecutions = await client.query<{ execution_id: string }>(
      `select distinct execution_id from personal_agent_chat_deliveries
        where conversation_id = $1 and owner_user_id = $2 and execution_id is not null`,
      [conversationId, actor.userId]
    );
    const childExecutionIds = allChildExecutions.rows.map(
      (row) => row.execution_id
    );
    const allExecutionIds = [
      ...new Set([...sourceExecutionIds, ...childExecutionIds])
    ];
    const capturedSessionIds = allExecutionIds.length
      ? (
          await client.query<{ logical_session_id: string }>(
            `select distinct logical_session_id
               from managed_conversation_executions
              where owner_user_id = $1 and id = any($2::uuid[])
                and logical_session_id is not null`,
            [actor.userId, allExecutionIds]
          )
        ).rows.map((row) => row.logical_session_id)
      : [];
    const activeDelivery = deliveries.find(
      (delivery) => delivery.id === root.active_delivery_id
    );
    const latestDelivery = deliveries.at(-1);
    const conversation = personalAgentChatConversationSchema.parse({
      contractVersion: 1,
      conversationId,
      title: root.title,
      projectId: root.project_id,
      contextKind: root.context_kind,
      status: root.status,
      activeAgentId: root.active_agent_id,
      activeExecutionId: activeDelivery?.executionId ?? null,
      activeProvider:
        activeDelivery?.provider ?? latestDelivery?.provider ?? null,
      sourceExecutionIds,
      childExecutionIds,
      capturedSessionIds,
      participants,
      messages,
      deliveries,
      createdAt: iso(root.created_at),
      updatedAt: iso(root.updated_at)
    });
    return {
      conversation,
      timelinePage: {
        hasMore,
        nextCursor: hasMore ? (messages[0]?.sequence ?? null) : null
      }
    };
  };

  return {
    async submitPersonalAgentChatMessage(actor, input) {
      const fingerprint = digest({
        conversationId: input.conversationId,
        requestId: input.requestId,
        text: input.text,
        sourceExecutionId: input.sourceExecutionId ?? null,
        context: input.context,
        recipients: input.recipients
      });
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `select pg_advisory_xact_lock(hashtextextended($1, 0)),
                  pg_advisory_xact_lock(hashtextextended($2, 0))`,
          [
            `personal-chat-root:${actor.userId}:${input.conversationId}`,
            `personal-chat-request:${actor.userId}:${input.requestId}`
          ]
        );
        const replay = await client.query<{
          id: string;
          request_digest: string;
          conversation_id: string;
        }>(
          `select id, request_digest, conversation_id from personal_agent_chat_turns
            where owner_user_id = $1 and request_id = $2 for update`,
          [actor.userId, input.requestId]
        );
        if (replay.rows[0]) {
          if (
            replay.rows[0].request_digest !== fingerprint ||
            replay.rows[0].conversation_id !== input.conversationId
          ) {
            throw requestConflict();
          }
          await client.query("commit");
          const response = await loadConversation(
            actor,
            input.conversationId,
            {},
            pool
          );
          if (!response) throw ownerNotFound();
          const replayMessage = await pool.query<MessageRow>(
            `select m.*, t.request_id from personal_agent_chat_messages m
              join personal_agent_chat_turns t on t.id = m.turn_id and t.owner_user_id = m.owner_user_id
             where m.turn_id = $1 and m.conversation_id = $2 and m.owner_user_id = $3 and m.kind = 'user'`,
            [replay.rows[0]!.id, input.conversationId, actor.userId]
          );
          const rawMessage = replayMessage.rows[0];
          if (!rawMessage)
            throw new Error("Personal chat idempotency state is inconsistent");
          const replayText =
            await decryptAuthorizedEncryptedFieldPayloadsWithClient(
              pool,
              actor,
              requireProvider(),
              [
                {
                  sourceTable: MESSAGE_SOURCE,
                  sourceId: rawMessage.id,
                  sourceColumn: "body"
                }
              ]
            );
          const plaintext = replayText.get(
            encryptedFieldReferenceKey({
              sourceTable: MESSAGE_SOURCE,
              sourceId: rawMessage.id,
              sourceColumn: "body"
            })
          )?.plaintext;
          if (typeof plaintext !== "string")
            throw new Error("Encrypted Personal chat prompt is missing");
          const message = mapMessage(rawMessage, plaintext);
          const replayDeliveries = await pool.query<DeliveryRow>(
            `select * from personal_agent_chat_deliveries where message_id = $1 and owner_user_id = $2 order by ordinal`,
            [message.id, actor.userId]
          );
          return {
            conversation: response.conversation,
            message,
            deliveries: replayDeliveries.rows.map(mapDelivery)
          };
        }

        let adoptedTitle: string | null = null;
        let adoptedSourceMetadata: {
          provider: string;
          aiClientInstanceId: string;
          workspaceId: string | null;
          model: string;
          reasoningEffort: string | null;
          permissionMode: PersonalAgentChatLaunchSnapshot["permissionMode"];
          agentId: string | null;
          agentVersion: number | null;
          agentName: string | null;
        } | null = null;
        if (input.sourceExecutionId) {
          const source = await client.query<{
            project_id: string | null;
            runner_device_id: string;
            runner_deployment_id: string;
            provider: string;
            ai_client_instance_id: string;
            model: string;
            reasoning_effort: string | null;
            permission_mode: PersonalAgentChatLaunchSnapshot["permissionMode"];
            source_workspace_id: string | null;
            source_agent_id: string | null;
            source_agent_version: number | null;
            source_agent_name: string | null;
            source_title: string | null;
            scope_bound: boolean;
            linked_personal_chat: boolean;
            pending_prompt: boolean;
          }>(
            `select execution.project_id, execution.runner_device_id, execution.runner_deployment_id,
                    execution.provider, execution.ai_client_instance_id, execution.model,
                    execution.reasoning_effort, execution.permission_mode,
                    execution.personal_agent_chat_workspace_id as source_workspace_id,
                    source_session.metadata ->> 'threadName' as source_title,
                    source_identity.name as source_agent_name,
                    exists (
                      select 1 from pull_request_reviews review
                       where review.owner_user_id = execution.owner_user_id
                         and review.execution_id = execution.id
                    ) or exists (
                      select 1 from personal_agent_execution_jobs job
                      join team_agent_requests team_request on team_request.job_id = job.id
                       where job.owner_user_id = execution.owner_user_id
                         and job.conversation_id = execution.id
                    ) as scope_bound,
                    exists (
                      select 1 from personal_agent_chat_deliveries delivery
                       where delivery.owner_user_id = execution.owner_user_id
                         and delivery.execution_id = execution.id
                    ) or exists (
                      select 1 from personal_agent_chat_source_claims claim
                       where claim.owner_user_id = execution.owner_user_id
                         and claim.source_execution_id = execution.id
                    ) as linked_personal_chat,
                    source_job.agent_id as source_agent_id,
                    source_job.agent_version as source_agent_version,
                    exists (
                      select 1 from managed_conversation_commands command
                       where command.owner_user_id = execution.owner_user_id
                         and command.execution_id = execution.id
                         and command.command_kind in ('start', 'prompt')
                         and (command.state = 'indeterminate' or
                              command.state in ('queued', 'dispatching', 'blocked'))
                    ) as pending_prompt
               from managed_conversation_executions execution
               left join sessions source_session
                 on source_session.logical_session_id = execution.logical_session_id
                and source_session.owner_user_id = execution.owner_user_id
                and source_session.personal_deleted_at is null
               left join lateral (
                 select job.agent_id, job.agent_version
                   from personal_agent_execution_jobs job
                  where job.owner_user_id = execution.owner_user_id
                    and job.conversation_id = execution.id
                    and job.agent_id is not null
                  order by job.created_at desc limit 1
               ) source_job on true
               left join personal_agent_identities source_identity
                 on source_identity.id = source_job.agent_id
                and source_identity.owner_user_id = execution.owner_user_id
              where execution.id = $1 and execution.owner_user_id = $2 for share of execution`,
            [input.sourceExecutionId, actor.userId]
          );
          const sourceRow = source.rows[0];
          if (
            !sourceRow ||
            sourceRow.scope_bound ||
            sourceRow.linked_personal_chat ||
            sourceRow.pending_prompt ||
            sourceRow.project_id !== input.context.projectId ||
            sourceRow.runner_device_id !== input.context.targetDeviceId ||
            sourceRow.runner_deployment_id !== input.targetDeploymentId
          ) {
            throw Object.assign(
              new Error(
                "Source conversation does not match this verified target"
              ),
              {
                statusCode: 409,
                code: "SOURCE_CONVERSATION_MISMATCH"
              }
            );
          }
          adoptedTitle = sourceRow.source_title?.trim() || null;
          adoptedSourceMetadata = {
            provider: sourceRow.provider,
            aiClientInstanceId: sourceRow.ai_client_instance_id,
            workspaceId: sourceRow.source_workspace_id,
            model: sourceRow.model,
            reasoningEffort: sourceRow.reasoning_effort,
            permissionMode: sourceRow.permission_mode,
            agentId: sourceRow.source_agent_id,
            agentVersion: sourceRow.source_agent_version,
            agentName: sourceRow.source_agent_name
          };
        }

        let createdNewRoot = false;
        const root = await client.query<RootRow>(
          `select * from personal_agent_chat_roots
            where conversation_id = $1 and owner_user_id = $2 for update`,
          [input.conversationId, actor.userId]
        );
        if (root.rows[0]) {
          if (
            root.rows[0].project_id !== input.context.projectId ||
            root.rows[0].context_kind !== input.context.contextKind ||
            root.rows[0].target_device_id !== input.context.targetDeviceId ||
            root.rows[0].target_deployment_id !== input.targetDeploymentId
          ) {
            throw Object.assign(
              new Error("Personal conversation context is immutable"),
              {
                statusCode: 409,
                code: "CONVERSATION_CONTEXT_CONFLICT"
              }
            );
          }
          if (
            root.rows[0].status === "uncertain" ||
            root.rows[0].status === "blocked" ||
            root.rows[0].status === "canceled"
          ) {
            throw Object.assign(
              new Error(
                "Personal conversation must be reconciled or continued before sending"
              ),
              {
                statusCode: 409,
                code: "CONVERSATION_BLOCKED"
              }
            );
          }
        } else {
          const firstAgent = input.recipients.find(
            (recipient) => recipient.kind === "agent"
          );
          await client.query(
            `insert into personal_agent_conversations (conversation_id, owner_user_id, active_agent_id)
             values ($1, $2, $3)
             on conflict (conversation_id) do nothing`,
            [
              input.conversationId,
              actor.userId,
              firstAgent?.kind === "agent" ? firstAgent.agentId : null
            ]
          );
          await client.query(
            `insert into personal_agent_chat_roots
             (conversation_id, owner_user_id, project_id, context_kind, target_device_id,
              target_deployment_id, workspace_id, title, source_execution_ids)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            [
              input.conversationId,
              actor.userId,
              input.context.projectId,
              input.context.contextKind,
              input.context.targetDeviceId,
              input.targetDeploymentId,
              adoptedSourceMetadata?.workspaceId ??
                input.sourceExecutionId ??
                input.conversationId,
              adoptedTitle?.slice(0, 120) ||
                input.text.replace(/\s+/gu, " ").trim().slice(0, 120) ||
                "Personal chat",
              JSON.stringify(
                input.sourceExecutionId ? [input.sourceExecutionId] : []
              )
            ]
          );
          createdNewRoot = true;
        }

        if (input.sourceExecutionId) {
          const claim = await client.query<{ conversation_id: string }>(
            `insert into personal_agent_chat_source_claims
             (owner_user_id, source_execution_id, conversation_id)
             values ($1, $2, $3)
             on conflict (owner_user_id, source_execution_id) do nothing
             returning conversation_id`,
            [actor.userId, input.sourceExecutionId, input.conversationId]
          );
          const existingClaim = claim.rows[0]
            ? claim.rows[0]
            : (
                await client.query<{ conversation_id: string }>(
                  `select conversation_id from personal_agent_chat_source_claims
                  where owner_user_id = $1 and source_execution_id = $2 for update`,
                  [actor.userId, input.sourceExecutionId]
                )
              ).rows[0];
          if (existingClaim?.conversation_id !== input.conversationId) {
            throw Object.assign(
              new Error(
                "Source conversation is already attached to another Personal conversation"
              ),
              {
                statusCode: 409,
                code: "SOURCE_CONVERSATION_ALREADY_ADOPTED"
              }
            );
          }
          await client.query(
            `update personal_agent_chat_roots
                set source_execution_ids = (
                  select coalesce(jsonb_agg(distinct item), '[]'::jsonb)
                    from jsonb_array_elements_text(source_execution_ids || $3::jsonb) item
                ), updated_at = now()
              where conversation_id = $1 and owner_user_id = $2`,
            [
              input.conversationId,
              actor.userId,
              JSON.stringify([input.sourceExecutionId])
            ]
          );
          if (createdNewRoot) {
            if (
              adoptedSourceMetadata?.agentId &&
              adoptedSourceMetadata.agentVersion
            ) {
              const sourceLaunch: PersonalAgentChatLaunchSnapshot = {
                kind: "agent",
                agentId: adoptedSourceMetadata.agentId,
                agentVersion: adoptedSourceMetadata.agentVersion,
                provider: adoptedSourceMetadata.provider,
                aiClientInstanceId: adoptedSourceMetadata.aiClientInstanceId,
                targetDeviceId: input.context.targetDeviceId,
                model: adoptedSourceMetadata.model,
                reasoningEffort: adoptedSourceMetadata.reasoningEffort,
                permissionMode: adoptedSourceMetadata.permissionMode,
                selectedResourceIds: []
              };
              await client.query(
                `insert into personal_agent_chat_participants
                 (conversation_id, owner_user_id, agent_id, agent_version,
                  ordinal, launch_snapshot, execution_id, status)
                 values ($1, $2, $3, $4, 0, $5::jsonb, $6, 'completed')
                 on conflict (conversation_id, agent_id) do nothing`,
                [
                  input.conversationId,
                  actor.userId,
                  adoptedSourceMetadata.agentId,
                  adoptedSourceMetadata.agentVersion,
                  JSON.stringify(sourceLaunch),
                  input.sourceExecutionId
                ]
              );
              await client.query(
                `insert into personal_agent_conversation_participants
                 (conversation_id, owner_user_id, agent_id, ordinal)
                 values ($1, $2, $3, 0)
                 on conflict (conversation_id, agent_id) do nothing`,
                [
                  input.conversationId,
                  actor.userId,
                  adoptedSourceMetadata.agentId
                ]
              );
            }
            const sourceCommands = await client.query<{
              id: string;
              encrypted_payload: Record<string, unknown> | null;
              state: string;
            }>(
              `select id, encrypted_payload, state from managed_conversation_commands
                where owner_user_id = $1 and execution_id = $2
                  and command_kind = 'prompt' and state = 'completed'
                order by sequence asc, created_at asc, id asc`,
              [actor.userId, input.sourceExecutionId]
            );
            let sequence = 1;
            let turnOrdinal = 1;
            for (const sourceCommand of sourceCommands.rows) {
              if (!sourceCommand.encrypted_payload) continue;
              const decoded = await decryptEnvelopeToUtf8(
                requireProvider(),
                sourceCommand.encrypted_payload as unknown as EncryptedPayloadEnvelope
              );
              const payload = JSON.parse(decoded) as Record<string, unknown>;
              if (typeof payload.prompt !== "string") continue;
              const turnId = randomUUID();
              const requestId = randomUUID();
              const requestDigest = digest({
                sourceExecutionId: input.sourceExecutionId,
                sourceCommandId: sourceCommand.id
              });
              const userMessageId = randomUUID();
              const assistantOutput = payload.assistantOutput;
              let assistantText =
                assistantOutput &&
                typeof assistantOutput === "object" &&
                !Array.isArray(assistantOutput) &&
                typeof (assistantOutput as Record<string, unknown>).text ===
                  "string"
                  ? ((assistantOutput as Record<string, unknown>)
                      .text as string)
                  : null;
              const assistantTruncated =
                assistantOutput &&
                typeof assistantOutput === "object" &&
                !Array.isArray(assistantOutput)
                  ? (assistantOutput as Record<string, unknown>).truncated ===
                    true
                  : false;
              if (
                assistantText === null &&
                options.getPersonalAgentTurnOutput
              ) {
                const job = await client.query<{ id: string; state: string }>(
                  `select id, state from personal_agent_execution_jobs
                    where owner_user_id = $1 and conversation_id = $2 and command_id = $3
                      and attribution_kind = 'agent'
                    limit 1`,
                  [actor.userId, input.sourceExecutionId, sourceCommand.id]
                );
                if (job.rows[0]?.state === "succeeded") {
                  assistantText = await options.getPersonalAgentTurnOutput(
                    actor,
                    { jobId: job.rows[0].id }
                  );
                }
              }
              await client.query(
                `insert into personal_agent_chat_turns
                 (id, conversation_id, owner_user_id, request_id, request_digest,
                  user_message_id, ordinal, status)
                 values ($1, $2, $3, $4, $5, $6, $7, 'completed')`,
                [
                  turnId,
                  input.conversationId,
                  actor.userId,
                  requestId,
                  requestDigest,
                  userMessageId,
                  turnOrdinal++
                ]
              );
              await client.query(
                `insert into personal_agent_chat_messages
                 (id, conversation_id, owner_user_id, turn_id, sequence, kind,
                  provider, ai_client_instance_id, execution_id, source_execution_id,
                  source_command_id, truncated, state)
                 values ($1, $2, $3, $4, $5, 'user', $6, $7, $8, $8, $9, false, 'completed')`,
                [
                  userMessageId,
                  input.conversationId,
                  actor.userId,
                  turnId,
                  sequence++,
                  adoptedSourceMetadata!.provider,
                  adoptedSourceMetadata!.aiClientInstanceId,
                  input.sourceExecutionId,
                  sourceCommand.id
                ]
              );
              await upsertEncryptedFieldPayloadWithClient(
                client,
                actor,
                requireProvider(),
                {
                  sourceTable: MESSAGE_SOURCE,
                  sourceId: userMessageId,
                  sourceColumn: "body",
                  plaintext: payload.prompt,
                  plaintextContentType: "text/plain",
                  rowFamily: "personal_agent_chat_message",
                  aad: {
                    conversationId: input.conversationId,
                    messageId: userMessageId
                  }
                }
              );
              if (assistantText !== null) {
                const assistantMessageId = randomUUID();
                await client.query(
                  `insert into personal_agent_chat_messages
                 (id, conversation_id, owner_user_id, turn_id, sequence, kind,
                  author_agent_id, author_agent_version, author_name, provider,
                  ai_client_instance_id, execution_id, source_execution_id,
                  source_command_id, truncated, state)
                   values ($1, $2, $3, $4, $5, 'agent_reply', $6, $7, $8, $9,
                           $10, $11, $11, $12, $13, 'completed')`,
                  [
                    assistantMessageId,
                    input.conversationId,
                    actor.userId,
                    turnId,
                    sequence++,
                    adoptedSourceMetadata!.agentId,
                    adoptedSourceMetadata!.agentVersion,
                    adoptedSourceMetadata!.agentName,
                    adoptedSourceMetadata!.provider,
                    adoptedSourceMetadata!.aiClientInstanceId,
                    input.sourceExecutionId,
                    sourceCommand.id,
                    assistantTruncated
                  ]
                );
                await upsertEncryptedFieldPayloadWithClient(
                  client,
                  actor,
                  requireProvider(),
                  {
                    sourceTable: MESSAGE_SOURCE,
                    sourceId: assistantMessageId,
                    sourceColumn: "body",
                    plaintext: assistantText,
                    plaintextContentType: "text/plain",
                    rowFamily: "personal_agent_chat_message",
                    aad: {
                      conversationId: input.conversationId,
                      messageId: assistantMessageId
                    }
                  }
                );
              }
            }
            await client.query(
              `update personal_agent_chat_roots
                  set next_sequence = $3, next_turn_ordinal = $4
                where conversation_id = $1 and owner_user_id = $2`,
              [input.conversationId, actor.userId, sequence, turnOrdinal]
            );
          }
        }

        const recipients = input.recipients;
        const namedAgentIds = recipients
          .filter((recipient) => recipient.kind === "agent")
          .map((recipient) => recipient.agentId);
        const participantCount = await client.query<{ count: number }>(
          `select count(distinct agent_id)::integer as count
             from (
               select agent_id from personal_agent_chat_participants
                where conversation_id = $1 and owner_user_id = $2
               union all
               select agent_id from personal_agent_conversation_participants
                where conversation_id = $1 and owner_user_id = $2
               union all
               select unnest($3::uuid[]) as agent_id
             ) named_participants`,
          [input.conversationId, actor.userId, namedAgentIds]
        );
        if ((participantCount.rows[0]?.count ?? 0) > 16) {
          throw Object.assign(
            new Error("A Personal conversation can contain at most 16 Agents"),
            {
              statusCode: 409,
              code: "PERSONAL_CHAT_PARTICIPANT_LIMIT"
            }
          );
        }
        const participantOrdinalResult = await client.query<{
          next_ordinal: number;
        }>(
          `select coalesce(max(ordinal), -1) + 1 as next_ordinal
             from (
               select ordinal from personal_agent_chat_participants
                where conversation_id = $1 and owner_user_id = $2
               union all
               select ordinal from personal_agent_conversation_participants
                where conversation_id = $1 and owner_user_id = $2
               union all
               select ordinal from personal_agent_chat_generic_participants
                where conversation_id = $1 and owner_user_id = $2
             ) participant_ordinals`,
          [input.conversationId, actor.userId]
        );
        let nextParticipantOrdinal =
          participantOrdinalResult.rows[0]!.next_ordinal;
        for (let index = 0; index < recipients.length; index += 1) {
          const recipient = recipients[index]!;
          if (recipient.kind === "generic") {
            const participantKey = digest({
              provider: recipient.provider,
              aiClientInstanceId: recipient.aiClientInstanceId,
              model: recipient.model
            });
            const existing = await client.query<{ ordinal: number }>(
              `select ordinal from personal_agent_chat_generic_participants
                where conversation_id = $1 and owner_user_id = $2 and participant_key = $3`,
              [input.conversationId, actor.userId, participantKey]
            );
            const ordinal =
              existing.rows[0]?.ordinal ?? nextParticipantOrdinal++;
            await client.query(
              `insert into personal_agent_chat_generic_participants
               (conversation_id, owner_user_id, participant_key, provider,
                ai_client_instance_id, ordinal, launch_snapshot)
               values ($1, $2, $3, $4, $5, $6, $7::jsonb)
               on conflict (conversation_id, participant_key) do update
                 set launch_snapshot = excluded.launch_snapshot, updated_at = now()`,
              [
                input.conversationId,
                actor.userId,
                participantKey,
                recipient.provider,
                recipient.aiClientInstanceId,
                ordinal,
                JSON.stringify(recipient)
              ]
            );
            continue;
          }
          const identity = await client.query<{
            name: string;
            avatar_reference: string | null;
            lifecycle: string;
            current_version: number;
          }>(
            `select name, avatar_reference, lifecycle, current_version
               from personal_agent_identities
              where id = $1 and owner_user_id = $2 for share`,
            [recipient.agentId, actor.userId]
          );
          if (
            identity.rows[0]?.lifecycle !== "active" ||
            identity.rows[0]?.current_version !== recipient.agentVersion
          ) {
            throw Object.assign(
              new Error(
                "Personal Agent version changed; reload before sending"
              ),
              {
                statusCode: 409,
                code: "PERSONAL_AGENT_VERSION_CONFLICT"
              }
            );
          }
          const existingOrdinal = await client.query<{ ordinal: number }>(
            `select ordinal from personal_agent_chat_participants
              where conversation_id = $1 and owner_user_id = $2 and agent_id = $3`,
            [input.conversationId, actor.userId, recipient.agentId]
          );
          const ordinal =
            existingOrdinal.rows[0]?.ordinal ?? nextParticipantOrdinal++;
          await client.query(
            `insert into personal_agent_chat_participants
             (conversation_id, owner_user_id, agent_id, agent_version, ordinal, launch_snapshot)
             values ($1, $2, $3, $4, $5, $6::jsonb)
             on conflict (conversation_id, agent_id) do update
               set agent_version = excluded.agent_version,
                   ordinal = personal_agent_chat_participants.ordinal,
                   launch_snapshot = excluded.launch_snapshot,
                   updated_at = now()`,
            [
              input.conversationId,
              actor.userId,
              recipient.agentId,
              recipient.agentVersion,
              ordinal,
              JSON.stringify(recipient)
            ]
          );
          await client.query(
            `insert into personal_agent_conversation_participants
             (conversation_id, owner_user_id, agent_id, ordinal)
             values ($1, $2, $3, $4)
             on conflict (conversation_id, agent_id) do nothing`,
            [input.conversationId, actor.userId, recipient.agentId, ordinal]
          );
        }

        const activeAgentId = recipients.find(
          (recipient) => recipient.kind === "agent"
        );
        await client.query(
          `update personal_agent_conversations
              set active_agent_id = $3, version = version + 1, updated_at = now()
            where conversation_id = $1 and owner_user_id = $2`,
          [
            input.conversationId,
            actor.userId,
            activeAgentId?.kind === "agent" ? activeAgentId.agentId : null
          ]
        );

        const ordinalResult = await client.query<{
          next_turn_ordinal: number;
          next_sequence: number;
        }>(
          `update personal_agent_chat_roots
              set next_turn_ordinal = next_turn_ordinal + 1,
                  next_sequence = next_sequence + 1,
                  status = 'queued', updated_at = now()
            where conversation_id = $1 and owner_user_id = $2
            returning next_turn_ordinal - 1 as next_turn_ordinal,
                      next_sequence - 1 as next_sequence`,
          [input.conversationId, actor.userId]
        );
        const turnOrdinal = ordinalResult.rows[0]!.next_turn_ordinal;
        const messageSequence = ordinalResult.rows[0]!.next_sequence;
        const turnId = randomUUID();
        const messageId = randomUUID();
        await client.query(
          `insert into personal_agent_chat_turns
           (id, conversation_id, owner_user_id, request_id, request_digest,
            user_message_id, ordinal, status)
           values ($1, $2, $3, $4, $5, $6, $7, 'queued')`,
          [
            turnId,
            input.conversationId,
            actor.userId,
            input.requestId,
            fingerprint,
            messageId,
            turnOrdinal
          ]
        );
        await client.query(
          `insert into personal_agent_chat_messages
           (id, conversation_id, owner_user_id, turn_id, sequence, kind, state)
           values ($1, $2, $3, $4, $5, 'user', 'completed')`,
          [
            messageId,
            input.conversationId,
            actor.userId,
            turnId,
            messageSequence
          ]
        );
        await upsertEncryptedFieldPayloadWithClient(
          client,
          actor,
          requireProvider(),
          {
            sourceTable: MESSAGE_SOURCE,
            sourceId: messageId,
            sourceColumn: "body",
            plaintext: input.text,
            plaintextContentType: "text/plain",
            rowFamily: "personal_agent_chat_message",
            aad: { conversationId: input.conversationId, messageId }
          }
        );

        const deliveryIds: string[] = [];
        for (let ordinal = 0; ordinal < recipients.length; ordinal += 1) {
          const recipient = recipients[ordinal]!;
          const deliveryId = randomUUID();
          deliveryIds.push(deliveryId);
          let agentName: string | null = null;
          if (recipient.kind === "agent") {
            const name = await client.query<{ name: string }>(
              `select name from personal_agent_identities where id = $1 and owner_user_id = $2`,
              [recipient.agentId, actor.userId]
            );
            agentName = name.rows[0]?.name ?? null;
          }
          await client.query(
            `insert into personal_agent_chat_deliveries
             (id, conversation_id, owner_user_id, turn_id, message_id, recipient_kind,
              agent_id, agent_version, agent_name, ordinal, launch_snapshot, status)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'queued')`,
            [
              deliveryId,
              input.conversationId,
              actor.userId,
              turnId,
              messageId,
              recipient.kind,
              recipient.agentId,
              recipient.agentVersion,
              agentName,
              ordinal,
              JSON.stringify(recipient)
            ]
          );
          if (recipient.kind === "agent") {
            const prepared = input.preparedAgentContexts?.[recipient.agentId];
            if (prepared !== undefined) {
              await upsertEncryptedFieldPayloadWithClient(
                client,
                actor,
                requireProvider(),
                {
                  sourceTable: DELIVERY_SOURCE,
                  sourceId: deliveryId,
                  sourceColumn: "personal_agent_context",
                  plaintext: prepared,
                  rowFamily: "personal_agent_chat_delivery_context",
                  aad: {
                    conversationId: input.conversationId,
                    deliveryId,
                    agentId: recipient.agentId
                  }
                }
              );
            }
          }
        }
        await client.query("commit");

        const response = await loadConversation(
          actor,
          input.conversationId,
          {},
          pool
        );
        if (!response) throw ownerNotFound();
        const message = response.conversation.messages.find(
          (item) => item.id === messageId
        );
        const deliveries = response.conversation.deliveries.filter((item) =>
          deliveryIds.includes(item.id)
        );
        if (!message)
          throw new Error(
            "Personal chat message was not returned after admission"
          );
        return personalAgentChatSubmitResponseSchema.parse({
          conversation: response.conversation,
          message,
          deliveries
        });
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async getPersonalAgentChat(actor, conversationId, page = {}) {
      return loadConversation(actor, conversationId, page);
    },

    async renamePersonalAgentChat(actor, input) {
      const result = await pool.query(
        `update personal_agent_chat_roots
            set title = $3, updated_at = now()
          where conversation_id = $1 and owner_user_id = $2`,
        [input.conversationId, actor.userId, input.title]
      );
      if (result.rowCount !== 1) return null;
      return loadConversation(actor, input.conversationId);
    },

    async listPersonalAgentChats(actor, input = {}) {
      const limit = normalizeLimit(input.limit ?? 40);
      const beforeValues: unknown[] = [actor.userId];
      let beforeClause = "";
      if (input.before) {
        const date = new Date(input.before);
        if (!Number.isFinite(date.getTime())) {
          throw Object.assign(new Error("Conversation cursor is invalid"), {
            statusCode: 400,
            code: "INVALID_CONVERSATION_CURSOR"
          });
        }
        beforeValues.push(date.toISOString());
        beforeClause = `and updated_at < $${beforeValues.length}`;
      }
      beforeValues.push(limit + 1);
      const rootRows = await pool.query<RootRow>(
        `select * from personal_agent_chat_roots
          where owner_user_id = $1 ${beforeClause}
          order by updated_at desc, conversation_id desc
          limit $${beforeValues.length}`,
        beforeValues
      );
      const hasMore = rootRows.rows.length > limit;
      const roots = rootRows.rows.slice(0, limit);
      const summaries: PersonalAgentChatConversationSummary[] = [];
      for (const root of roots) {
        const participantCount = await pool.query<{ count: string }>(
          `select count(*)::text as count from personal_agent_chat_participants
            where conversation_id = $1 and owner_user_id = $2`,
          [root.conversation_id, actor.userId]
        );
        const last = await pool.query<{
          agent_id: string | null;
          agent_name: string | null;
          launch_snapshot: PersonalAgentChatLaunchSnapshot;
          execution_id: string | null;
        }>(
          `select d.agent_id, d.agent_name, d.launch_snapshot, d.execution_id
             from personal_agent_chat_deliveries d
            where d.conversation_id = $1 and d.owner_user_id = $2
            order by d.created_at desc, d.ordinal desc limit 1`,
          [root.conversation_id, actor.userId]
        );
        const lastRow = last.rows[0];
        const sourceExecutionIds = Array.isArray(root.source_execution_ids)
          ? root.source_execution_ids
          : [];
        const childRows = await pool.query<{
          execution_id: string;
          logical_session_id: string | null;
        }>(
          `select distinct d.execution_id, e.logical_session_id
             from personal_agent_chat_deliveries d
             left join managed_conversation_executions e
               on e.id = d.execution_id and e.owner_user_id = d.owner_user_id
            where d.conversation_id = $1 and d.owner_user_id = $2 and d.execution_id is not null`,
          [root.conversation_id, actor.userId]
        );
        const childExecutionIds = [
          ...new Set(childRows.rows.map((row) => row.execution_id))
        ];
        const allExecutionIds = [
          ...new Set([...sourceExecutionIds, ...childExecutionIds])
        ];
        const sourceSessions = allExecutionIds.length
          ? await pool.query<{ logical_session_id: string }>(
              `select distinct logical_session_id from managed_conversation_executions
                where owner_user_id = $1 and id = any($2::uuid[]) and logical_session_id is not null`,
              [actor.userId, allExecutionIds]
            )
          : { rows: [] };
        const active = root.active_delivery_id
          ? await pool.query<{
              execution_id: string | null;
              launch_snapshot: PersonalAgentChatLaunchSnapshot;
            }>(
              `select execution_id, launch_snapshot from personal_agent_chat_deliveries
                where id = $1 and owner_user_id = $2`,
              [root.active_delivery_id, actor.userId]
            )
          : null;
        const activeAgent = await pool.query<{
          active_agent_id: string | null;
        }>(
          `select active_agent_id from personal_agent_conversations
            where conversation_id = $1 and owner_user_id = $2`,
          [root.conversation_id, actor.userId]
        );
        summaries.push({
          conversationId: root.conversation_id,
          title: root.title,
          projectId: root.project_id,
          contextKind: root.context_kind,
          activeAgentId: activeAgent.rows[0]?.active_agent_id ?? null,
          activeExecutionId: active?.rows[0]?.execution_id ?? null,
          activeProvider:
            active?.rows[0]?.launch_snapshot.provider ??
            lastRow?.launch_snapshot.provider ??
            null,
          status: root.status,
          participantCount: Number(participantCount.rows[0]?.count ?? 0),
          latestAgentId: lastRow?.agent_id ?? null,
          latestAgentName: lastRow?.agent_name ?? null,
          updatedAt: iso(root.updated_at),
          sourceExecutionIds,
          childExecutionIds,
          capturedSessionIds: sourceSessions.rows.map(
            (row) => row.logical_session_id
          )
        });
      }
      return personalAgentChatConversationPageSchema.parse({
        conversations: summaries,
        hasMore,
        nextCursor: hasMore
          ? (roots.at(-1)?.updated_at.toISOString() ?? null)
          : null
      });
    },

    async claimNextPersonalAgentChatDelivery(input) {
      if (
        !Number.isSafeInteger(input.leaseMs) ||
        input.leaseMs < 1_000 ||
        input.leaseMs > 120_000
      ) {
        throw new TypeError("Personal chat delivery lease is invalid");
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const expired = await client.query<{
          id: string;
          conversation_id: string;
          owner_user_id: string;
          execution_id: string | null;
          command_id: string | null;
          reconciliation_only: boolean;
          resume_without_dispatch: boolean;
        }>(
          `select d.id, d.conversation_id, d.owner_user_id, d.execution_id, d.command_id,
                  (d.execution_id is not null or d.command_id is not null) as reconciliation_only,
                  (
                    (d.execution_id is null and d.command_id is null)
                    or (command.state = 'queued' and command.attempts = 0)
                    or (command.command_kind = 'start' and command.state = 'completed'
                        and followup.state = 'queued' and followup.attempts = 0)
                  ) as resume_without_dispatch
             from personal_agent_chat_roots r
             join personal_agent_chat_deliveries d
               on d.id = r.active_delivery_id and d.owner_user_id = r.owner_user_id
             left join managed_conversation_commands command
               on command.id = d.command_id and command.owner_user_id = d.owner_user_id
              and command.execution_id = d.execution_id
             left join managed_conversation_commands followup
               on command.command_kind = 'start'
              and command.result->>'initialPromptCommandId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and followup.id = (command.result->>'initialPromptCommandId')::uuid
              and followup.owner_user_id = command.owner_user_id
              and followup.execution_id = command.execution_id
            where r.target_device_id = $1 and r.target_deployment_id = $2
              and ($3::uuid is null or r.owner_user_id = $3)
              and d.status in ('starting', 'running') and d.claim_until <= now()
            order by d.claim_until
            for update of r, d skip locked limit 8`,
          [input.targetDeviceId, input.deploymentId, input.ownerUserId ?? null]
        );
        for (const stale of expired.rows) {
          const uncertain =
            Boolean(stale.execution_id || stale.command_id) &&
            !stale.resume_without_dispatch;
          await client.query(
            `update personal_agent_chat_deliveries
                set status = $3,
                    error_code = case when $3 = 'uncertain' then 'DELIVERY_LEASE_EXPIRED' else null end,
                    claim_owner = null, claim_token = null, claim_until = null,
                    completed_at = case when $3 = 'uncertain' then now() else null end,
                    updated_at = now()
              where id = $1 and owner_user_id = $2`,
            [stale.id, stale.owner_user_id, uncertain ? "uncertain" : "queued"]
          );
          await client.query(
            `update personal_agent_chat_roots
                set status = $3,
                    active_delivery_id = case when $3 = 'queued' then null else active_delivery_id end,
                    updated_at = now()
              where conversation_id = $1 and owner_user_id = $2`,
            [
              stale.conversation_id,
              stale.owner_user_id,
              uncertain ? "uncertain" : "queued"
            ]
          );
        }
        const candidate = await client.query<{
          id: string;
          conversation_id: string;
          owner_user_id: string;
          turn_id: string;
          message_id: string;
          ordinal: number;
          launch_snapshot: PersonalAgentChatLaunchSnapshot;
          execution_id: string | null;
          command_id: string | null;
          active_delivery_id: string | null;
          target_device_id: string;
          target_deployment_id: string;
          status: string;
          reconciliation_only: boolean;
          context_transfer: PersonalAgentChatContextTransfer | null;
        }>(
          `select d.id, d.conversation_id, d.owner_user_id, d.turn_id,
                  d.message_id, d.ordinal, d.launch_snapshot, d.execution_id,
                  d.command_id, r.active_delivery_id, r.target_device_id,
                  r.target_deployment_id, d.status, d.context_transfer,
                  (r.status = 'uncertain' and d.status = 'uncertain'
                    and r.active_delivery_id = d.id) as reconciliation_only
             from personal_agent_chat_roots r
             join lateral (
               select d.* from personal_agent_chat_deliveries d
                where d.conversation_id = r.conversation_id and d.owner_user_id = r.owner_user_id
                  and ((r.status = 'queued' and d.status = 'queued') or
                       (r.status = 'uncertain' and d.status = 'uncertain'
                         and d.id = r.active_delivery_id))
                order by d.created_at, d.ordinal limit 1
             ) d on true
            where ((r.status = 'queued' and r.active_delivery_id is null) or
                   (r.status = 'uncertain' and r.active_delivery_id = d.id))
              and r.target_device_id = $1 and r.target_deployment_id = $2
              and ($3::uuid is null or r.owner_user_id = $3)
            order by r.updated_at, r.conversation_id
            for update of r, d skip locked limit 1`,
          [input.targetDeviceId, input.deploymentId, input.ownerUserId ?? null]
        );
        const row = candidate.rows[0];
        if (!row) {
          await client.query("commit");
          return null;
        }
        const claimToken = randomUUID();
        const updated = await client.query<{ id: string }>(
          `update personal_agent_chat_deliveries
              set status = case when $5::boolean then 'uncertain' else 'starting' end,
                  claim_owner = $2, claim_token = $3,
                  claim_until = now() + ($4::text || ' milliseconds')::interval,
                  started_at = coalesce(started_at, now()), updated_at = now()
            where id = $1 and status = case when $5::boolean then 'uncertain' else 'queued' end
            returning id`,
          [
            row.id,
            input.runnerId,
            claimToken,
            input.leaseMs,
            row.reconciliation_only
          ]
        );
        if (!updated.rows[0]) {
          await client.query("rollback");
          return null;
        }
        await client.query(
          `update personal_agent_chat_roots
              set status = case when $4::boolean then 'uncertain' else 'running' end,
                  active_delivery_id = $2,
             updated_at = now() where conversation_id = $1 and owner_user_id = $3`,
          [
            row.conversation_id,
            row.id,
            row.owner_user_id,
            row.reconciliation_only
          ]
        );
        await client.query(
          `update personal_agent_chat_turns set status = 'running', updated_at = now()
            where id = $1 and owner_user_id = $2`,
          [row.turn_id, row.owner_user_id]
        );
        if (row.reconciliation_only) {
          await client.query("commit");
          return {
            deliveryId: row.id,
            conversationId: row.conversation_id,
            ownerUserId: row.owner_user_id,
            turnId: row.turn_id,
            messageId: row.message_id,
            ordinal: row.ordinal,
            claimToken,
            targetDeviceId: row.target_device_id,
            targetDeploymentId: row.target_deployment_id,
            launch: row.launch_snapshot,
            prompt: "",
            personalAgentContext: null,
            conversationContextText: null,
            contextTransfer: row.context_transfer,
            executionId: row.execution_id,
            commandId: row.command_id,
            reconciliationOnly: true
          };
        }
        const promptResult =
          await decryptAuthorizedEncryptedFieldPayloadsWithClient(
            client,
            { userId: row.owner_user_id },
            requireProvider(),
            [
              {
                sourceTable: MESSAGE_SOURCE,
                sourceId: row.message_id,
                sourceColumn: "body"
              }
            ]
          );
        const prompt = promptResult.get(
          encryptedFieldReferenceKey({
            sourceTable: MESSAGE_SOURCE,
            sourceId: row.message_id,
            sourceColumn: "body"
          })
        )?.plaintext;
        if (typeof prompt !== "string")
          throw new Error("Encrypted Personal chat prompt is missing");
        let personalAgentContext: unknown | null = null;
        let conversationContextText: string | null = null;
        let contextTransfer: PersonalAgentChatContextTransfer | null = null;
        if (row.launch_snapshot.kind === "agent") {
          const contextResult =
            await decryptAuthorizedEncryptedFieldPayloadsWithClient(
              client,
              { userId: row.owner_user_id },
              requireProvider(),
              [
                {
                  sourceTable: DELIVERY_SOURCE,
                  sourceId: row.id,
                  sourceColumn: "personal_agent_context"
                }
              ]
            );
          personalAgentContext =
            contextResult.get(
              encryptedFieldReferenceKey({
                sourceTable: DELIVERY_SOURCE,
                sourceId: row.id,
                sourceColumn: "personal_agent_context"
              })
            )?.plaintext ?? null;
        }
        const isAgentRecipient = row.launch_snapshot.kind === "agent";
        const participantKey = digest({
          provider: row.launch_snapshot.provider,
          aiClientInstanceId: row.launch_snapshot.aiClientInstanceId,
          model: row.launch_snapshot.model
        });
        const rootScope = await client.query<{
          project_id: string | null;
          workspace_id: string;
          target_device_id: string;
          target_deployment_id: string;
        }>(
          `select project_id, workspace_id, target_device_id, target_deployment_id
             from personal_agent_chat_roots
            where conversation_id = $1 and owner_user_id = $2`,
          [row.conversation_id, row.owner_user_id]
        );
        const scope = rootScope.rows[0];
        let cursorBeforeSequence = 0;
        let recipientHasNativeHistory = false;
        if (isAgentRecipient) {
          const participant = await client.query<{
            execution_id: string | null;
            last_context_cursor: number;
            launch_snapshot: PersonalAgentChatLaunchSnapshot;
          }>(
            `select execution_id, last_context_cursor, launch_snapshot
               from personal_agent_chat_participants
              where conversation_id = $1 and owner_user_id = $2 and agent_id = $3`,
            [
              row.conversation_id,
              row.owner_user_id,
              row.launch_snapshot.agentId
            ]
          );
          const current = participant.rows[0];
          if (
            scope &&
            current?.execution_id &&
            current.launch_snapshot.kind === "agent" &&
            current.launch_snapshot.agentId === row.launch_snapshot.agentId &&
            current.launch_snapshot.agentVersion ===
              row.launch_snapshot.agentVersion &&
            current.launch_snapshot.provider === row.launch_snapshot.provider &&
            current.launch_snapshot.aiClientInstanceId ===
              row.launch_snapshot.aiClientInstanceId &&
            current.launch_snapshot.model === row.launch_snapshot.model &&
            current.launch_snapshot.reasoningEffort ===
              row.launch_snapshot.reasoningEffort &&
            current.launch_snapshot.permissionMode ===
              row.launch_snapshot.permissionMode
          ) {
            const retained = await client.query<{ id: string }>(
              `select id from managed_conversation_executions
                where id = $1 and owner_user_id = $2
                  and project_id is not distinct from $3
                  and provider = $4 and ai_client_instance_id = $5 and model = $6
                  and reasoning_effort is not distinct from $7 and permission_mode = $8
                  and runner_device_id = $9 and runner_deployment_id = $10
                  and personal_agent_chat_workspace_id = $11 and state = 'running'`,
              [
                current.execution_id,
                row.owner_user_id,
                scope.project_id,
                row.launch_snapshot.provider,
                row.launch_snapshot.aiClientInstanceId,
                row.launch_snapshot.model,
                row.launch_snapshot.reasoningEffort,
                row.launch_snapshot.permissionMode,
                scope.target_device_id,
                scope.target_deployment_id,
                scope.workspace_id
              ]
            );
            recipientHasNativeHistory = retained.rows.length > 0;
            if (recipientHasNativeHistory)
              cursorBeforeSequence = current.last_context_cursor;
          }
        } else {
          const participant = await client.query<{
            execution_id: string | null;
            last_context_cursor: number;
            launch_snapshot: PersonalAgentChatLaunchSnapshot;
          }>(
            `select execution_id, last_context_cursor, launch_snapshot
               from personal_agent_chat_generic_participants
              where conversation_id = $1 and owner_user_id = $2 and participant_key = $3`,
            [row.conversation_id, row.owner_user_id, participantKey]
          );
          const current = participant.rows[0];
          if (
            scope &&
            current?.execution_id &&
            current.launch_snapshot.kind === "generic" &&
            current.launch_snapshot.provider === row.launch_snapshot.provider &&
            current.launch_snapshot.aiClientInstanceId ===
              row.launch_snapshot.aiClientInstanceId &&
            current.launch_snapshot.model === row.launch_snapshot.model &&
            current.launch_snapshot.reasoningEffort ===
              row.launch_snapshot.reasoningEffort &&
            current.launch_snapshot.permissionMode ===
              row.launch_snapshot.permissionMode
          ) {
            const retained = await client.query<{ id: string }>(
              `select id from managed_conversation_executions
                where id = $1 and owner_user_id = $2
                  and project_id is not distinct from $3
                  and provider = $4 and ai_client_instance_id = $5 and model = $6
                  and reasoning_effort is not distinct from $7 and permission_mode = $8
                  and runner_device_id = $9 and runner_deployment_id = $10
                  and personal_agent_chat_workspace_id = $11 and state = 'running'`,
              [
                current.execution_id,
                row.owner_user_id,
                scope.project_id,
                row.launch_snapshot.provider,
                row.launch_snapshot.aiClientInstanceId,
                row.launch_snapshot.model,
                row.launch_snapshot.reasoningEffort,
                row.launch_snapshot.permissionMode,
                scope.target_device_id,
                scope.target_deployment_id,
                scope.workspace_id
              ]
            );
            recipientHasNativeHistory = retained.rows.length > 0;
            if (recipientHasNativeHistory)
              cursorBeforeSequence = current.last_context_cursor;
          }
        }
        const sourceRows = await client.query<{
          id: string;
          sequence: number;
          turn_id: string;
          kind: string;
          author_agent_id: string | null;
          provider: string | null;
          ai_client_instance_id: string | null;
          state: string;
          window_omitted_messages: number;
          window_omitted_exchanges: number;
          window_omitted_from: number | null;
          window_omitted_through: number | null;
        }>(
          `with recent_turns as (
               select id
                 from personal_agent_chat_turns
                where conversation_id = $1 and owner_user_id = $2
                order by ordinal desc limit 25
             ), all_candidates as (
               select message.*
                 from personal_agent_chat_messages message
                where message.conversation_id = $1 and message.owner_user_id = $2
                  and message.sequence > $3
                  and message.state = 'completed'
                  and (message.kind = 'user' or
                       (message.kind = 'agent_reply' and
                         (($4::uuid is not null and
                           (not $8::boolean or message.author_agent_id is null or message.author_agent_id <> $4)) or
                          ($4::uuid is null and
                           (not $8::boolean or message.author_agent_id is not null or
                            coalesce(message.provider, '') <> $6 or
                            coalesce(message.ai_client_instance_id, '') <> $7)))))
                  and message.id <> $5
             ), recent_candidates as (
               select candidate.*
                 from all_candidates candidate
                 join recent_turns recent on recent.id = candidate.turn_id
             ), selected_recent as (
               select * from recent_candidates
                order by sequence desc limit 128
             ), direct_message as (
               select message.*
                 from personal_agent_chat_messages message
                where message.id = $5 and message.conversation_id = $1
                  and message.owner_user_id = $2 and message.kind = 'user'
                  and message.state = 'completed'
             ), picked as (
               select * from selected_recent
               union all
               select * from direct_message
             ), omitted as (
               select candidate.* from all_candidates candidate
                where not exists (select 1 from picked where picked.id = candidate.id)
             ), omitted_summary as (
               select count(*)::integer as omitted_messages,
                      count(distinct turn_id)::integer as omitted_exchanges,
                      min(sequence)::integer as omitted_from,
                      max(sequence)::integer as omitted_through
                 from omitted
             )
             select picked.id, picked.sequence, picked.turn_id, picked.kind,
                    picked.author_agent_id, picked.provider, picked.ai_client_instance_id,
                    picked.state,
                    omitted_summary.omitted_messages as window_omitted_messages,
                    omitted_summary.omitted_exchanges as window_omitted_exchanges,
                    omitted_summary.omitted_from as window_omitted_from,
                    omitted_summary.omitted_through as window_omitted_through
               from picked cross join omitted_summary
              order by picked.sequence asc`,
          [
            row.conversation_id,
            row.owner_user_id,
            cursorBeforeSequence,
            isAgentRecipient ? row.launch_snapshot.agentId : null,
            row.message_id,
            row.launch_snapshot.provider,
            row.launch_snapshot.aiClientInstanceId,
            recipientHasNativeHistory
          ]
        );
        const sourceBodies =
          await decryptAuthorizedEncryptedFieldPayloadsWithClient(
            client,
            { userId: row.owner_user_id },
            requireProvider(),
            sourceRows.rows.map((source) => ({
              sourceTable: MESSAGE_SOURCE,
              sourceId: source.id,
              sourceColumn: "body"
            }))
          );
        const bounded = buildMultiAgentPublicContext({
          messages: sourceRows.rows.map((source) => ({
            id: source.id,
            sequence: source.sequence,
            exchangeId: source.turn_id,
            kind: source.kind,
            visibility: "public" as const,
            state: source.state,
            authorAgentId: source.author_agent_id,
            provider: source.provider,
            aiClientInstanceId: source.ai_client_instance_id,
            text:
              (sourceBodies.get(
                encryptedFieldReferenceKey({
                  sourceTable: MESSAGE_SOURCE,
                  sourceId: source.id,
                  sourceColumn: "body"
                })
              )?.plaintext as string | undefined) ?? ""
          })),
          recipientAgentId: isAgentRecipient
            ? row.launch_snapshot.agentId
            : null,
          recipientHasNativeHistory,
          ...(isAgentRecipient
            ? {}
            : {
                recipientProvider: row.launch_snapshot.provider,
                recipientAiClientInstanceId:
                  row.launch_snapshot.aiClientInstanceId
              }),
          afterSequence: cursorBeforeSequence,
          maxExchanges: CONTEXT_MAX_EXCHANGES,
          maxUtf8Bytes: CONTEXT_MAX_BYTES,
          currentMessageId: row.message_id
        });
        const windowOmittedMessages =
          sourceRows.rows[0]?.window_omitted_messages ?? 0;
        const windowOmittedExchanges =
          sourceRows.rows[0]?.window_omitted_exchanges ?? 0;
        const windowOmittedFrom =
          sourceRows.rows[0]?.window_omitted_from ?? null;
        const windowOmittedThrough =
          sourceRows.rows[0]?.window_omitted_through ?? null;
        const boundedEnvelope = JSON.parse(bounded.contextText) as Record<
          string,
          unknown
        >;
        const boundedOmissions = boundedEnvelope.omissions as Record<
          string,
          unknown
        >;
        const contextOmittedFrom = [
          windowOmittedFrom,
          bounded.omittedSequenceRange?.from
        ]
          .filter(
            (value): value is number => value !== null && value !== undefined
          )
          .reduce<number | null>(
            (minimum, value) =>
              minimum === null ? value : Math.min(minimum, value),
            null
          );
        const contextOmittedThrough = [
          windowOmittedThrough,
          bounded.omittedSequenceRange?.through
        ]
          .filter(
            (value): value is number => value !== null && value !== undefined
          )
          .reduce<number | null>(
            (maximum, value) =>
              maximum === null ? value : Math.max(maximum, value),
            null
          );
        if (windowOmittedMessages > 0 || bounded.omittedSequenceRange) {
          boundedOmissions.windowOmittedMessages = windowOmittedMessages;
          boundedOmissions.windowOmittedExchanges = windowOmittedExchanges;
          boundedOmissions.windowOmittedBytesKnown = false;
          boundedOmissions.omittedSequenceRange =
            contextOmittedFrom !== null && contextOmittedThrough !== null
              ? { from: contextOmittedFrom, through: contextOmittedThrough }
              : null;
        }
        conversationContextText = JSON.stringify(boundedEnvelope);
        contextTransfer = {
          cursorBeforeSequence: bounded.cursorBeforeSequence,
          cursorThroughSequence: bounded.cursorThroughSequence,
          lastContextMessageSequence: bounded.messages.at(-1)?.sequence ?? null,
          transferredExchanges: bounded.counts.includedExchangeCount,
          transferredMessages: bounded.counts.includedMessageCount,
          omittedExchanges:
            bounded.counts.omittedExchangeCount + windowOmittedExchanges,
          omittedMessages:
            bounded.counts.omittedMessageCount + windowOmittedMessages,
          includedUtf8Bytes: bounded.counts.includedUtf8Bytes,
          omittedUtf8Bytes: bounded.counts.omittedUtf8Bytes,
          omittedUtf8BytesKnown: windowOmittedMessages === 0,
          truncated: bounded.counts.truncatedMessageCount > 0,
          omissionsStatus: "not_provided",
          omittedSequenceRange:
            contextOmittedFrom !== null && contextOmittedThrough !== null
              ? { from: contextOmittedFrom, through: contextOmittedThrough }
              : null
        };
        await client.query(
          `update personal_agent_chat_deliveries set context_transfer = $3::jsonb, updated_at = now()
              where id = $1 and owner_user_id = $2 and claim_token = $4 and claim_until > now()`,
          [
            row.id,
            row.owner_user_id,
            JSON.stringify(contextTransfer),
            claimToken
          ]
        );
        await upsertEncryptedFieldPayloadWithClient(
          client,
          { userId: row.owner_user_id },
          requireProvider(),
          {
            sourceTable: DELIVERY_SOURCE,
            sourceId: row.id,
            sourceColumn: "conversation_context",
            plaintext: conversationContextText,
            plaintextContentType: "application/json",
            rowFamily: "personal_agent_chat_delivery_context",
            aad: { conversationId: row.conversation_id, deliveryId: row.id }
          }
        );
        await client.query("commit");
        return {
          deliveryId: row.id,
          conversationId: row.conversation_id,
          ownerUserId: row.owner_user_id,
          turnId: row.turn_id,
          messageId: row.message_id,
          ordinal: row.ordinal,
          claimToken,
          targetDeviceId: row.target_device_id,
          targetDeploymentId: row.target_deployment_id,
          launch: row.launch_snapshot,
          prompt,
          personalAgentContext,
          conversationContextText,
          contextTransfer,
          executionId: row.execution_id,
          commandId: row.command_id,
          reconciliationOnly: false
        };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async renewPersonalAgentChatDeliveryClaim(input) {
      if (
        !Number.isSafeInteger(input.leaseMs) ||
        input.leaseMs < 1_000 ||
        input.leaseMs > 120_000
      ) {
        throw new TypeError("Personal chat delivery lease is invalid");
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const location = await client.query<{ conversation_id: string }>(
          `select conversation_id from personal_agent_chat_deliveries
            where id = $1 and owner_user_id = $2`,
          [input.deliveryId, input.ownerUserId]
        );
        const conversationId = location.rows[0]?.conversation_id;
        if (!conversationId) {
          await client.query("rollback");
          return false;
        }
        const root = await client.query<{
          active_delivery_id: string | null;
          status: string;
        }>(
          `select active_delivery_id, status from personal_agent_chat_roots
            where conversation_id = $1 and owner_user_id = $2 for update`,
          [conversationId, input.ownerUserId]
        );
        if (root.rows[0]?.active_delivery_id !== input.deliveryId) {
          await client.query("rollback");
          return false;
        }
        const renewed = await client.query(
          `update personal_agent_chat_deliveries
              set claim_until = now() + ($4::text || ' milliseconds')::interval,
                  updated_at = now()
            where id = $1 and owner_user_id = $2 and claim_token = $3
              and status in ('starting', 'running', 'uncertain') and claim_until > now()`,
          [input.deliveryId, input.ownerUserId, input.claimToken, input.leaseMs]
        );
        if (renewed.rowCount !== 1) {
          await client.query("rollback");
          return false;
        }
        await client.query("commit");
        return true;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async attachManagedConversationToPersonalAgentChatDelivery(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const location = await client.query<{ conversation_id: string }>(
          `select conversation_id from personal_agent_chat_deliveries
            where id = $1 and owner_user_id = $2`,
          [input.deliveryId, input.ownerUserId]
        );
        const conversationId = location.rows[0]?.conversation_id;
        if (!conversationId) {
          await client.query("rollback");
          return false;
        }
        const root = await client.query<{
          active_delivery_id: string | null;
          status: string;
        }>(
          `select active_delivery_id, status from personal_agent_chat_roots
            where conversation_id = $1 and owner_user_id = $2 for update`,
          [conversationId, input.ownerUserId]
        );
        if (
          root.rows[0]?.active_delivery_id !== input.deliveryId ||
          !["running", "uncertain"].includes(root.rows[0].status)
        ) {
          await client.query("rollback");
          return false;
        }
        const result = await client.query(
          `update personal_agent_chat_deliveries
              set execution_id = $4, command_id = $5, status = 'running', updated_at = now()
            where id = $1 and owner_user_id = $2 and claim_token = $3
              and status in ('starting', 'running') and claim_until > now()`,
          [
            input.deliveryId,
            input.ownerUserId,
            input.claimToken,
            input.executionId,
            input.commandId
          ]
        );
        if (result.rowCount !== 1) {
          await client.query("rollback");
          return false;
        }
        await client.query(
          `update personal_agent_chat_participants p
            set execution_id = $3, status = 'running', updated_at = now()
           from personal_agent_chat_deliveries d
          where d.id = $1 and d.owner_user_id = $2 and d.agent_id = p.agent_id
            and d.conversation_id = p.conversation_id`,
          [input.deliveryId, input.ownerUserId, input.executionId]
        );
        await client.query("commit");
        return true;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async completePersonalAgentChatDelivery(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const location = await client.query<{ conversation_id: string }>(
          `select conversation_id from personal_agent_chat_deliveries
            where id = $1 and owner_user_id = $2`,
          [input.deliveryId, input.ownerUserId]
        );
        const conversationId = location.rows[0]?.conversation_id;
        if (!conversationId) {
          await client.query("rollback");
          return false;
        }
        const rootResult = await client.query<{
          active_delivery_id: string | null;
          next_sequence: number;
          status: string;
        }>(
          `select active_delivery_id, next_sequence, status from personal_agent_chat_roots
            where conversation_id = $1 and owner_user_id = $2 for update`,
          [conversationId, input.ownerUserId]
        );
        const root = rootResult.rows[0];
        if (
          !root ||
          root.active_delivery_id !== input.deliveryId ||
          !["running", "uncertain"].includes(root.status)
        ) {
          await client.query("rollback");
          return false;
        }
        const deliveryResult = await client.query<
          DeliveryRow & {
            conversation_id: string;
            owner_user_id: string;
            message_id: string;
          }
        >(
          `select *, claim_until > now() as lease_valid from personal_agent_chat_deliveries
            where id = $1 and owner_user_id = $2 for update`,
          [input.deliveryId, input.ownerUserId]
        );
        const delivery = deliveryResult.rows[0];
        if (
          !delivery ||
          delivery.claim_token !== input.claimToken ||
          delivery.execution_id !== input.executionId ||
          !(
            ["starting", "running"].includes(delivery.status) ||
            (root.status === "uncertain" && delivery.status === "uncertain")
          ) ||
          !(delivery as DeliveryRow & { lease_valid?: boolean }).lease_valid
        ) {
          await client.query("rollback");
          return false;
        }
        if (
          !isDeepStrictEqual(
            input.contextTransfer ?? null,
            delivery.context_transfer ?? null
          )
        ) {
          throw Object.assign(
            new Error("Personal chat context receipt changed"),
            {
              statusCode: 409,
              code: "CONTEXT_TRANSFER_CONFLICT"
            }
          );
        }
        const linked = await client.query<{ id: string }>(
          `select id from managed_conversation_commands
            where id = $1 and owner_user_id = $2 and execution_id = $3
              and personal_agent_chat_delivery_id = $4`,
          [
            delivery.command_id,
            input.ownerUserId,
            input.executionId,
            input.deliveryId
          ]
        );
        const command = await client.query<{
          id: string;
          state: string;
          encrypted_payload: Record<string, unknown> | null;
        }>(
          `select id, state, encrypted_payload from managed_conversation_commands
            where id = $1 and owner_user_id = $2 and execution_id = $3
              and command_kind = 'prompt'
              and personal_agent_chat_delivery_id = $4`,
          [
            input.commandId,
            input.ownerUserId,
            input.executionId,
            input.deliveryId
          ]
        );
        if (!linked.rows[0] || command.rows[0]?.state !== "completed") {
          await client.query("rollback");
          return false;
        }
        let committedReply: string | null = null;
        if (command.rows[0].encrypted_payload) {
          const decoded = await decryptEnvelopeToUtf8(
            requireProvider(),
            command.rows[0]
              .encrypted_payload as unknown as EncryptedPayloadEnvelope
          );
          const payload = JSON.parse(decoded) as Record<string, unknown>;
          const output = payload.assistantOutput;
          if (
            output &&
            typeof output === "object" &&
            !Array.isArray(output) &&
            typeof (output as Record<string, unknown>).text === "string"
          ) {
            committedReply = (output as Record<string, unknown>).text as string;
          }
        }
        if (
          committedReply === null &&
          delivery.agent_id &&
          input.jobId &&
          options.getPersonalAgentTurnOutput
        ) {
          const job = await client.query<{ id: string; state: string }>(
            `select id, state from personal_agent_execution_jobs
              where id = $1 and owner_user_id = $2 and conversation_id = $3
                and command_id = $4`,
            [input.jobId, input.ownerUserId, input.executionId, input.commandId]
          );
          if (job.rows[0]?.state === "succeeded") {
            committedReply = await options.getPersonalAgentTurnOutput(
              { userId: input.ownerUserId },
              { jobId: job.rows[0].id }
            );
          }
        }
        if (committedReply === null || committedReply !== input.reply) {
          throw Object.assign(
            new Error(
              "Personal chat reply is not captured by the linked Agent turn"
            ),
            {
              statusCode: 409,
              code: "PERSONAL_CHAT_OUTPUT_CONFLICT"
            }
          );
        }
        const replyId = randomUUID();
        const sequence = root.next_sequence;
        await client.query(
          `insert into personal_agent_chat_messages
           (id, conversation_id, owner_user_id, turn_id, sequence, kind,
            author_agent_id, author_agent_version, author_name, provider,
            ai_client_instance_id, execution_id, job_id, truncated, state)
           values ($1, $2, $3, $4, $5, 'agent_reply', $6, $7, $8, $9, $10, $11, $12, $13, 'completed')`,
          [
            replyId,
            delivery.conversation_id,
            input.ownerUserId,
            delivery.turn_id,
            sequence,
            delivery.agent_id,
            delivery.agent_version,
            delivery.agent_name,
            delivery.launch_snapshot.provider,
            delivery.launch_snapshot.aiClientInstanceId,
            input.executionId,
            input.jobId,
            input.truncated
          ]
        );
        await upsertEncryptedFieldPayloadWithClient(
          client,
          { userId: input.ownerUserId },
          requireProvider(),
          {
            sourceTable: MESSAGE_SOURCE,
            sourceId: replyId,
            sourceColumn: "body",
            plaintext: input.reply,
            plaintextContentType: "text/plain",
            rowFamily: "personal_agent_chat_message",
            aad: {
              conversationId: delivery.conversation_id,
              messageId: replyId
            }
          }
        );
        const completed = await client.query(
          `update personal_agent_chat_deliveries
              set status = 'completed', job_id = $4, context_transfer = $5::jsonb,
                  claim_until = null, completed_at = now(), updated_at = now()
            where id = $1 and owner_user_id = $2 and claim_token = $3`,
          [
            input.deliveryId,
            input.ownerUserId,
            input.claimToken,
            input.jobId,
            JSON.stringify(input.contextTransfer)
          ]
        );
        if (completed.rowCount !== 1) {
          await client.query("rollback");
          return false;
        }
        const cursorThrough = input.contextTransfer?.cursorThroughSequence ?? 0;
        if (delivery.agent_id && input.contextTransfer) {
          const committed = multiAgentContextCursorAfterDelivery({
            cursorBeforeSequence: input.contextTransfer.cursorBeforeSequence,
            cursorThroughSequence: cursorThrough,
            delivery: "delivered"
          });
          await client.query(
            `update personal_agent_chat_participants
                set last_context_cursor = greatest(last_context_cursor, $4),
                    status = 'completed', updated_at = now()
              where conversation_id = $1 and owner_user_id = $2 and agent_id = $3`,
            [
              delivery.conversation_id,
              input.ownerUserId,
              delivery.agent_id,
              committed
            ]
          );
        } else if (input.contextTransfer) {
          const genericKey = digest({
            provider: delivery.launch_snapshot.provider,
            aiClientInstanceId: delivery.launch_snapshot.aiClientInstanceId,
            model: delivery.launch_snapshot.model
          });
          const committed = multiAgentContextCursorAfterDelivery({
            cursorBeforeSequence: input.contextTransfer.cursorBeforeSequence,
            cursorThroughSequence: cursorThrough,
            delivery: "delivered"
          });
          await client.query(
            `update personal_agent_chat_generic_participants
                set last_context_cursor = greatest(last_context_cursor, $4),
                    status = 'completed', updated_at = now()
              where conversation_id = $1 and owner_user_id = $2 and participant_key = $3`,
            [delivery.conversation_id, input.ownerUserId, genericKey, committed]
          );
        }
        await client.query(
          `update personal_agent_chat_roots
              set active_delivery_id = null,
                  next_sequence = next_sequence + 1,
                  status = case when exists (
                    select 1 from personal_agent_chat_deliveries pending
                     where pending.conversation_id = $1 and pending.owner_user_id = $2
                       and pending.status = 'queued'
                  ) then 'queued' else 'idle' end,
                  updated_at = now()
            where conversation_id = $1 and owner_user_id = $2`,
          [delivery.conversation_id, input.ownerUserId]
        );
        await client.query(
          `update personal_agent_chat_turns t
              set status = case when exists (
                select 1 from personal_agent_chat_deliveries pending
                 where pending.turn_id = t.id and pending.status in ('queued', 'starting', 'running')
              ) then 'running' else 'completed' end,
                  updated_at = now()
            where t.id = $1 and t.owner_user_id = $2`,
          [delivery.turn_id, input.ownerUserId]
        );
        await client.query("commit");
        return true;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async failPersonalAgentChatDelivery(input) {
      const status =
        input.certainty === "indeterminate" ? "uncertain" : "failed";
      const rootStatus =
        input.certainty === "indeterminate" ? "uncertain" : "blocked";
      const client = await pool.connect();
      try {
        await client.query("begin");
        const location = await client.query<{ conversation_id: string }>(
          `select conversation_id from personal_agent_chat_deliveries
            where id = $1 and owner_user_id = $2`,
          [input.deliveryId, input.ownerUserId]
        );
        const conversationId = location.rows[0]?.conversation_id;
        if (!conversationId) {
          await client.query("rollback");
          return false;
        }
        const root = await client.query<{
          active_delivery_id: string | null;
          status: string;
        }>(
          `select active_delivery_id, status from personal_agent_chat_roots
            where conversation_id = $1 and owner_user_id = $2 for update`,
          [conversationId, input.ownerUserId]
        );
        if (root.rows[0]?.active_delivery_id !== input.deliveryId) {
          await client.query("rollback");
          return false;
        }
        const result = await client.query(
          `update personal_agent_chat_deliveries
              set status = $4, error_code = $5, claim_until = null,
                  completed_at = now(), updated_at = now()
            where id = $1 and owner_user_id = $2 and claim_token = $3
              and (
                status in ('starting', 'running') or
                ($6::boolean and status = 'uncertain')
              ) and claim_until > now()`,
          [
            input.deliveryId,
            input.ownerUserId,
            input.claimToken,
            status,
            input.errorCode,
            root.rows[0].status === "uncertain"
          ]
        );
        if (result.rowCount !== 1) {
          await client.query("rollback");
          return false;
        }
        await client.query(
          `update personal_agent_chat_roots
              set status = $3,
                  active_delivery_id = case when $3 = 'blocked' then null else active_delivery_id end,
                  updated_at = now()
            where conversation_id = $1 and owner_user_id = $2`,
          [conversationId, input.ownerUserId, rootStatus]
        );
        await client.query("commit");
        return true;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async cancelPersonalAgentChatBatch(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const operationDigest = digest({
          operation: "cancel",
          conversationId: input.conversationId,
          messageId: input.messageId,
          confirmedStopped: input.confirmedStopped === true
        });
        await client.query(
          `select pg_advisory_xact_lock(hashtextextended($1, 0)),
                  pg_advisory_xact_lock(hashtextextended($2, 0))`,
          [
            `personal-chat-root:${actor.userId}:${input.conversationId}`,
            `personal-chat-request:${actor.userId}:${input.requestId}`
          ]
        );
        const root = await client.query<{
          active_delivery_id: string | null;
          status: string;
        }>(
          `select active_delivery_id, status from personal_agent_chat_roots
            where conversation_id = $1 and owner_user_id = $2 for update`,
          [input.conversationId, actor.userId]
        );
        if (!root.rows[0]) {
          await client.query("rollback");
          return null;
        }
        const replay = await client.query<{
          operation: string;
          request_digest: string;
          result: { canceledDeliveryIds?: string[] };
        }>(
          `select operation, request_digest, result
             from personal_agent_chat_control_requests
            where owner_user_id = $1 and request_id = $2 for update`,
          [actor.userId, input.requestId]
        );
        if (replay.rows[0]) {
          if (
            replay.rows[0].operation !== "cancel" ||
            replay.rows[0].request_digest !== operationDigest
          ) {
            throw requestConflict();
          }
          await client.query("commit");
          const response = await loadConversation(actor, input.conversationId);
          return response
            ? {
                conversation: response.conversation,
                canceledDeliveryIds:
                  replay.rows[0].result.canceledDeliveryIds ?? []
              }
            : null;
        }
        const message = await client.query(
          `select id from personal_agent_chat_messages
            where id = $1 and conversation_id = $2 and owner_user_id = $3 and kind = 'user'`,
          [input.messageId, input.conversationId, actor.userId]
        );
        if (!message.rows[0]) {
          await client.query("rollback");
          return null;
        }
        const activeResult = root.rows[0].active_delivery_id
          ? await client.query<{
              message_id: string;
              status: string;
              cancel_requested: boolean;
            }>(
              `select message_id, status, cancel_requested from personal_agent_chat_deliveries
                where id = $1 and owner_user_id = $2 for update`,
              [root.rows[0].active_delivery_id, actor.userId]
            )
          : null;
        const active = activeResult?.rows[0];
        const activeMatches = active?.message_id === input.messageId;
        if (
          root.rows[0].status === "uncertain" &&
          !(
            input.confirmedStopped === true &&
            activeMatches &&
            active?.status === "uncertain" &&
            active.cancel_requested
          )
        ) {
          await client.query("rollback");
          return null;
        }
        const canceled = await client.query<{ id: string }>(
          `update personal_agent_chat_deliveries
              set status = 'canceled', claim_until = null, completed_at = now(), updated_at = now()
            where conversation_id = $1 and owner_user_id = $2 and message_id = $3
              and status in ('queued', 'blocked')
            returning id`,
          [input.conversationId, actor.userId, input.messageId]
        );
        if (activeMatches && input.confirmedStopped) {
          const stopped = await client.query<{ id: string }>(
            `update personal_agent_chat_deliveries
                set status = 'canceled', claim_until = null, completed_at = now(), updated_at = now()
              where id = $1 and owner_user_id = $2
                and status in ('starting', 'running', 'uncertain')
              returning id`,
            [root.rows[0].active_delivery_id, actor.userId]
          );
          canceled.rows.push(...stopped.rows);
        } else if (activeMatches) {
          await client.query(
            `update personal_agent_chat_deliveries
                set cancel_requested = true, updated_at = now()
              where id = $1 and owner_user_id = $2 and status in ('starting', 'running')`,
            [root.rows[0].active_delivery_id, actor.userId]
          );
        }
        const clearActive =
          !active || (activeMatches && input.confirmedStopped === true);
        await client.query(
          `update personal_agent_chat_roots
              set status = case
                    when active_delivery_id is not null and not $3::boolean then 'running'
                    when exists (
                      select 1 from personal_agent_chat_deliveries pending
                       where pending.conversation_id = $1 and pending.owner_user_id = $2
                         and pending.status = 'queued'
                    ) then 'queued' else 'idle' end,
                  active_delivery_id = case when $3::boolean then null else active_delivery_id end,
                  updated_at = now()
            where conversation_id = $1 and owner_user_id = $2`,
          [input.conversationId, actor.userId, clearActive]
        );
        await client.query(
          `update personal_agent_chat_turns set status = case when $3::boolean then 'canceled' else 'running' end, updated_at = now()
            where owner_user_id = $1 and user_message_id = $2`,
          [
            actor.userId,
            input.messageId,
            !activeMatches || input.confirmedStopped
          ]
        );
        if (!activeMatches || input.confirmedStopped) {
          await client.query(
            `update personal_agent_chat_messages set state = 'canceled'
              where id = $1 and owner_user_id = $2`,
            [input.messageId, actor.userId]
          );
        }
        const result = {
          canceledDeliveryIds: canceled.rows.map((row) => row.id)
        };
        await client.query(
          `insert into personal_agent_chat_control_requests
           (owner_user_id, request_id, conversation_id, operation, request_digest, result)
           values ($1, $2, $3, 'cancel', $4, $5::jsonb)`,
          [
            actor.userId,
            input.requestId,
            input.conversationId,
            operationDigest,
            JSON.stringify(result)
          ]
        );
        await client.query("commit");
        const response = await loadConversation(actor, input.conversationId);
        return response
          ? { conversation: response.conversation, ...result }
          : null;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async continuePersonalAgentChatBatch(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const operationDigest = digest({
          operation: "continue",
          conversationId: input.conversationId,
          skipFailedDeliveryId: input.skipFailedDeliveryId
        });
        await client.query(
          `select pg_advisory_xact_lock(hashtextextended($1, 0)),
                  pg_advisory_xact_lock(hashtextextended($2, 0))`,
          [
            `personal-chat-root:${actor.userId}:${input.conversationId}`,
            `personal-chat-request:${actor.userId}:${input.requestId}`
          ]
        );
        const root = await client.query<{
          status: string;
          active_delivery_id: string | null;
        }>(
          `select status, active_delivery_id from personal_agent_chat_roots
            where conversation_id = $1 and owner_user_id = $2 for update`,
          [input.conversationId, actor.userId]
        );
        if (!root.rows[0]) {
          await client.query("rollback");
          return null;
        }
        const replay = await client.query<{
          operation: string;
          request_digest: string;
          result: {
            skippedDeliveryId?: string;
            resumedDeliveryId?: string | null;
          };
        }>(
          `select operation, request_digest, result
             from personal_agent_chat_control_requests
            where owner_user_id = $1 and request_id = $2 for update`,
          [actor.userId, input.requestId]
        );
        if (replay.rows[0]) {
          if (
            replay.rows[0].operation !== "continue" ||
            replay.rows[0].request_digest !== operationDigest
          ) {
            throw requestConflict();
          }
          await client.query("commit");
          const response = await loadConversation(actor, input.conversationId);
          return response
            ? {
                conversation: response.conversation,
                skippedDeliveryId:
                  replay.rows[0].result.skippedDeliveryId ??
                  input.skipFailedDeliveryId,
                resumedDeliveryId:
                  replay.rows[0].result.resumedDeliveryId ?? null
              }
            : null;
        }
        if (
          root.rows[0].status === "uncertain" ||
          root.rows[0].active_delivery_id
        ) {
          await client.query("rollback");
          return null;
        }
        const failed = await client.query<{
          turn_id: string;
          message_id: string;
        }>(
          `update personal_agent_chat_deliveries
              set status = 'skipped', updated_at = now()
            where id = $1 and conversation_id = $2 and owner_user_id = $3 and status = 'failed'
            returning turn_id, message_id`,
          [input.skipFailedDeliveryId, input.conversationId, actor.userId]
        );
        if (!failed.rows[0]) {
          await client.query("rollback");
          return null;
        }
        const next = await client.query<{ id: string }>(
          `select id from personal_agent_chat_deliveries
            where turn_id = $1 and owner_user_id = $2 and status = 'queued'
            order by ordinal limit 1`,
          [failed.rows[0].turn_id, actor.userId]
        );
        await client.query(
          `update personal_agent_chat_roots set status = $3, updated_at = now()
            where conversation_id = $1 and owner_user_id = $2`,
          [input.conversationId, actor.userId, next.rows[0] ? "queued" : "idle"]
        );
        const result = {
          skippedDeliveryId: input.skipFailedDeliveryId,
          resumedDeliveryId: next.rows[0]?.id ?? null
        };
        await client.query(
          `insert into personal_agent_chat_control_requests
           (owner_user_id, request_id, conversation_id, operation, request_digest, result)
           values ($1, $2, $3, 'continue', $4, $5::jsonb)`,
          [
            actor.userId,
            input.requestId,
            input.conversationId,
            operationDigest,
            JSON.stringify(result)
          ]
        );
        await client.query("commit");
        const response = await loadConversation(actor, input.conversationId);
        return response
          ? {
              conversation: response.conversation,
              ...result
            }
          : null;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  };
};

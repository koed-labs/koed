import { createHash } from "node:crypto";
import pg from "pg";
import type {
  ActorContext,
  Visibility,
  WorkflowTokenUsageInput,
  WorkflowTokenUsageRecord,
  WorkflowTokenUsageRollupInput,
  WorkflowTokenUsageRollupRecord,
  WorkflowTokenUsageSourceReference,
  WorkflowTokenUsageSourceReferenceType
} from "./types.js";

export interface WorkflowTokenUsageRepository {
  recordWorkflowTokenUsage(
    actor: ActorContext,
    input: WorkflowTokenUsageInput
  ): Promise<WorkflowTokenUsageRecord>;
  listWorkflowTokenUsageRollups(
    actor: ActorContext,
    input?: WorkflowTokenUsageRollupInput
  ): Promise<WorkflowTokenUsageRollupRecord[]>;
}

type WorkflowTokenUsageRow = {
  id: string;
  workflow_type: string;
  workflow_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  conversation_item_id: string | null;
  model: string | null;
  usage_source: string;
  usage_accuracy: string;
  usage_kind: string;
  connector_client: string | null;
  tokenizer_package: string | null;
  tokenizer_encoding: string | null;
  tokenizer_model: string | null;
  tokenizer_exact_model_match: boolean | null;
  tokenizer_heuristic_fallback: boolean | null;
  tokenizer_version: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
  usage_scope: string;
  created_at: Date;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const mapWorkflowTokenUsage = (
  row: WorkflowTokenUsageRow
): WorkflowTokenUsageRecord => ({
  id: row.id,
  workflowType: row.workflow_type,
  workflowId: row.workflow_id,
  sessionId: row.session_id,
  turnId: row.turn_id,
  conversationItemId: row.conversation_item_id,
  model: row.model,
  usageSource: row.usage_source,
  usageAccuracy: row.usage_accuracy,
  usageKind: row.usage_kind,
  connectorClient: row.connector_client,
  tokenizerPackage: row.tokenizer_package,
  tokenizerEncoding: row.tokenizer_encoding,
  tokenizerModel: row.tokenizer_model,
  tokenizerExactModelMatch: row.tokenizer_exact_model_match,
  tokenizerHeuristicFallback: row.tokenizer_heuristic_fallback,
  tokenizerVersion: row.tokenizer_version,
  inputTokens: row.input_tokens,
  cachedInputTokens: row.cached_input_tokens,
  outputTokens: row.output_tokens,
  reasoningOutputTokens: row.reasoning_output_tokens,
  totalTokens: row.total_tokens,
  usageScope: row.usage_scope,
  createdAt: row.created_at.toISOString()
});

const validateWorkflowTokenUsageSources = async (
  db: pg.Pool | pg.PoolClient,
  input: {
    ownerUserId: string | null;
    visibility: Visibility;
    usage: WorkflowTokenUsageInput;
  }
): Promise<void> => {
  const { usage } = input;
  if (usage.sessionId) {
    const session = await db.query<{ id: string }>(
      `
        select id
        from sessions
        where id = $1
          and invalidated_at is null
          and visibility = $2::visibility_scope
          and owner_user_id = $3
        limit 1
      `,
      [usage.sessionId, input.visibility, input.ownerUserId]
    );
    if (session.rowCount === 0) {
      throw new Error("Session not found or not visible");
    }
  }

  if (usage.turnId) {
    const turn = await db.query<{ id: string }>(
      `
        select id
        from turns
        where id = $1
          and visibility = $2::visibility_scope
          and owner_user_id = $3
          and ($4::uuid is null or session_id = $4)
        limit 1
      `,
      [
        usage.turnId,
        input.visibility,
        input.ownerUserId,
        usage.sessionId ?? null
      ]
    );
    if (turn.rowCount === 0) {
      throw new Error("Turn not found or not visible");
    }
  }

  if (usage.conversationItemId) {
    const item = await db.query<{ id: string }>(
      `
        select id
        from conversation_items
        where id = $1
          and visibility = $2::visibility_scope
          and owner_user_id = $3
          and ($4::uuid is null or session_id = $4)
          and ($5::uuid is null or turn_id = $5)
        limit 1
      `,
      [
        usage.conversationItemId,
        input.visibility,
        input.ownerUserId,
        usage.sessionId ?? null,
        usage.turnId ?? null
      ]
    );
    if (item.rowCount === 0) {
      throw new Error("Conversation item not found or not visible");
    }
  }
};

const workflowTokenUsageSourceReferences = (
  usage: WorkflowTokenUsageInput
): WorkflowTokenUsageSourceReference[] => {
  const references: WorkflowTokenUsageSourceReference[] = [
    ...(usage.sourceReferences ?? [])
  ];
  const add = (
    type: WorkflowTokenUsageSourceReferenceType,
    id: string | undefined
  ) => {
    if (id) {
      references.push({ type, id });
    }
  };
  add("question", usage.questionId);
  add("answer_job", usage.answerJobId);
  add("lcm_node", usage.lcmNodeId);
  add("message", usage.messageId);
  add("tool_event", usage.toolEventId);
  add("memory_event", usage.memoryEventId);

  const unique = new Map<string, WorkflowTokenUsageSourceReference>();
  for (const reference of references) {
    unique.set(`${reference.type}:${reference.id}`, reference);
  }
  return [...unique.values()];
};

const validateUuidSourceReference = (
  reference: WorkflowTokenUsageSourceReference
) => {
  if (!uuidPattern.test(reference.id)) {
    throw new Error(`Invalid ${reference.type} source reference id`);
  }
};

const validateWorkflowTokenUsageSourceReferences = async (
  db: pg.Pool | pg.PoolClient,
  input: {
    ownerUserId: string | null;
    visibility: Visibility;
    usage: WorkflowTokenUsageInput;
    references: WorkflowTokenUsageSourceReference[];
  }
): Promise<void> => {
  for (const reference of input.references) {
    if (reference.type === "answer_job") {
      if (input.usage.workflowId !== reference.id) {
        throw new Error(
          "Answer job source reference must match workflowId for local answer jobs"
        );
      }
      continue;
    }

    validateUuidSourceReference(reference);
    const tableByType: Record<
      Exclude<WorkflowTokenUsageSourceReferenceType, "answer_job">,
      string
    > = {
      question: "memory_questions",
      lcm_node: "memory_nodes",
      message: "messages",
      tool_event: "tool_events",
      memory_event: "memory_events"
    };
    const table = tableByType[reference.type];
    const invalidationFilter =
      reference.type === "question" ? "" : "and invalidated_at is null";
    const found = await db.query<{ id: string }>(
      `
        select id
        from ${table}
        where id = $1
          and visibility = $2::visibility_scope
          and owner_user_id = $3
          ${invalidationFilter}
        limit 1
      `,
      [reference.id, input.visibility, input.ownerUserId]
    );
    if (found.rowCount === 0) {
      throw new Error(
        `${reference.type} source reference not found or not visible`
      );
    }
  }
};

export const createWorkflowTokenUsageRepository = (
  pool: pg.Pool
): WorkflowTokenUsageRepository => ({
  async recordWorkflowTokenUsage(actor, input) {
    const visibility = input.visibility ?? "personal";
    const ownerUserId = actor.userId;
    const sourceReferences = workflowTokenUsageSourceReferences(input);
    const idempotencyKey =
      input.idempotencyKey ??
      createHash("sha256")
        .update(
          JSON.stringify({
            workflowType: input.workflowType,
            workflowId: input.workflowId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            conversationItemId: input.conversationItemId,
            sourceReferences,
            usageScope: input.usageScope ?? "last",
            usageSource: input.usageSource ?? "app_server",
            usageAccuracy: input.usageAccuracy ?? "provider_reported",
            usageKind: input.usageKind ?? "turn_delta",
            model: input.model,
            totalTokens: input.totalTokens,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            cachedInputTokens: input.cachedInputTokens,
            reasoningOutputTokens: input.reasoningOutputTokens
          })
        )
        .digest("hex");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await validateWorkflowTokenUsageSources(client, {
        ownerUserId,
        visibility,
        usage: input
      });
      await validateWorkflowTokenUsageSourceReferences(client, {
        ownerUserId,
        visibility,
        usage: input,
        references: sourceReferences
      });
      const result = await client.query<WorkflowTokenUsageRow>(
        `
          insert into workflow_token_usage (
            owner_user_id,
            visibility,
            workflow_type,
            workflow_id,
            session_id,
            turn_id,
            conversation_item_id,
            source_runtime,
            source_kind,
            source_adapter_version,
            usage_source,
            usage_accuracy,
            usage_kind,
            connector_client,
            tokenizer_package,
            tokenizer_encoding,
            tokenizer_model,
            tokenizer_exact_model_match,
            tokenizer_heuristic_fallback,
            tokenizer_version,
            model,
            model_context_window,
            input_tokens,
            cached_input_tokens,
            output_tokens,
            reasoning_output_tokens,
            total_tokens,
            usage_scope,
            metadata,
            idempotency_key,
            source_hash
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14, $15, $16,
            $17, $18, $19, $20, $21, $22, $23, $24,
            $25, $26, $27, $28, $29, $30, $31
          )
          on conflict do nothing
          returning
            id, workflow_type, workflow_id, session_id, turn_id,
            conversation_item_id, model, usage_source, usage_accuracy,
            usage_kind, connector_client, tokenizer_package, tokenizer_encoding,
            tokenizer_model, tokenizer_exact_model_match,
            tokenizer_heuristic_fallback, tokenizer_version,
            input_tokens, cached_input_tokens,
            output_tokens, reasoning_output_tokens, total_tokens, usage_scope,
            created_at
        `,
        [
          ownerUserId,
          visibility,
          input.workflowType,
          input.workflowId ?? null,
          input.sessionId ?? null,
          input.turnId ?? null,
          input.conversationItemId ?? null,
          input.sourceRuntime ?? null,
          input.sourceKind ?? null,
          input.sourceAdapterVersion ?? null,
          input.usageSource ?? "app_server",
          input.usageAccuracy ?? "provider_reported",
          input.usageKind ?? "turn_delta",
          input.connectorClient ?? null,
          input.tokenizerPackage ?? null,
          input.tokenizerEncoding ?? null,
          input.tokenizerModel ?? null,
          input.tokenizerExactModelMatch ?? null,
          input.tokenizerHeuristicFallback ?? null,
          input.tokenizerVersion ?? null,
          input.model ?? null,
          input.modelContextWindow ?? null,
          input.inputTokens ?? null,
          input.cachedInputTokens ?? null,
          input.outputTokens ?? null,
          input.reasoningOutputTokens ?? null,
          input.totalTokens ?? null,
          input.usageScope ?? "last",
          input.metadata ?? {},
          idempotencyKey,
          input.sourceHash ?? idempotencyKey
        ]
      );
      const row =
        result.rows[0] ??
        (
          await client.query<WorkflowTokenUsageRow>(
            `
              select
                id, workflow_type, workflow_id, session_id, turn_id,
                conversation_item_id, model, usage_source, usage_accuracy,
                usage_kind, connector_client, tokenizer_package,
                tokenizer_encoding, tokenizer_model,
                tokenizer_exact_model_match, tokenizer_heuristic_fallback,
                tokenizer_version, input_tokens, cached_input_tokens,
                output_tokens, reasoning_output_tokens, total_tokens,
                usage_scope, created_at
              from workflow_token_usage
              where idempotency_key = $1
                and visibility = $2::visibility_scope
                and owner_user_id = $3
              limit 1
            `,
            [idempotencyKey, visibility, ownerUserId]
          )
        ).rows[0];
      if (!row) {
        throw Object.assign(
          new Error(
            "Duplicate token usage conflicts with data outside caller visibility"
          ),
          { statusCode: 409 }
        );
      }
      if (sourceReferences.length > 0) {
        await client.query(
          `
            insert into workflow_token_usage_source_references (
              workflow_token_usage_id,
              source_type,
              source_id
            )
            select $1::uuid, ref.source_type, ref.source_id
            from jsonb_to_recordset($2::jsonb) as ref(source_type text, source_id text)
            on conflict do nothing
          `,
          [
            row.id,
            JSON.stringify(
              sourceReferences.map((reference) => ({
                source_type: reference.type,
                source_id: reference.id
              }))
            )
          ]
        );
      }
      await client.query("commit");
      return mapWorkflowTokenUsage(row);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async listWorkflowTokenUsageRollups(actor, input = {}) {
    const groupBy = input.groupBy?.length ? input.groupBy : ["workflow"];
    const groupExpressions: Record<string, string> = {
      workflow: "workflow_type",
      model: "coalesce(model, 'unknown')",
      owner: "owner_user_id::text",
      project:
        "coalesce(s.project_override_id, s.automatic_project_id, s.metadata ->> 'projectId', s.cwd, wtu.metadata ->> 'projectId')",
      thread:
        "coalesce(s.external_session_id, wtu.metadata ->> 'appServerThreadId', wtu.metadata ->> 'executionThreadId', wtu.metadata ->> 'threadId', wtu.session_id::text)",
      connector:
        "coalesce(connector_client, source_kind, source_runtime::text)",
      accuracy: "usage_accuracy",
      date: "observed_at::date::text"
    };
    const selectedGroups = groupBy.filter((group) => groupExpressions[group]);
    const selectGroups = selectedGroups.map(
      (group) => `${groupExpressions[group]} as ${group}`
    );
    const groupSql = selectedGroups.map((group) => groupExpressions[group]);
    const estimateFilter = input.includeEstimates
      ? `and usage_accuracy in ('provider_reported', 'provider_partial', 'local_estimate')
         and usage_kind in ('turn_delta', 'estimate')`
      : `and usage_accuracy = 'provider_reported'
         and usage_kind = 'turn_delta'`;
    const rows = await pool.query<
      Record<string, string | null> & {
        row_count: string;
        input_tokens: string | null;
        cached_input_tokens: string | null;
        output_tokens: string | null;
        reasoning_output_tokens: string | null;
        total_tokens: string | null;
      }
    >(
      `
        select
          ${selectGroups.join(",\n          ")},
          count(*)::text as row_count,
          coalesce(sum(input_tokens), 0)::text as input_tokens,
          coalesce(sum(cached_input_tokens), 0)::text as cached_input_tokens,
          coalesce(sum(output_tokens), 0)::text as output_tokens,
          coalesce(sum(reasoning_output_tokens), 0)::text as reasoning_output_tokens,
          coalesce(sum(total_tokens), 0)::text as total_tokens
        from workflow_token_usage wtu
        left join sessions s on s.id = wtu.session_id
        where (
            wtu.visibility = 'personal'
            and wtu.owner_user_id = $1
          )
          ${estimateFilter}
          and ($2::timestamptz is null or wtu.observed_at >= $2)
          and ($3::timestamptz is null or wtu.observed_at < $3)
        group by ${groupSql.join(", ")}
        order by ${groupSql.join(", ")}
      `,
      [actor.userId, input.from ?? null, input.to ?? null]
    );
    return rows.rows.map((row) => {
      const group: Record<string, string | null> = {};
      for (const key of selectedGroups) {
        group[key] = row[key] ?? null;
      }
      return {
        group,
        rowCount: Number(row.row_count),
        inputTokens: Number(row.input_tokens ?? 0),
        cachedInputTokens: Number(row.cached_input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        reasoningOutputTokens: Number(row.reasoning_output_tokens ?? 0),
        totalTokens: Number(row.total_tokens ?? 0)
      };
    });
  }
});

import {
  personalAgentHistoryJobSchema,
  parsePersonalAgentExecutionJob,
  type PersonalAgentExecutionSettings,
  type PersonalAgentExecutionJob,
  type PersonalAgentHistoryJob
} from "@koed/shared";

export type PersonalAgentHistorySource = "job" | "delivery";

export type PersonalAgentHistoryCursor = {
  createdAt: string;
  id: string;
  source: PersonalAgentHistorySource;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Accept old timestamp/ID cursors while emitting a source-aware combined cursor. */
export const encodePersonalAgentHistoryCursor = (
  value: PersonalAgentHistoryCursor
): string =>
  Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");

export const decodePersonalAgentHistoryCursor = (
  cursor: string
): PersonalAgentHistoryCursor => {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    // Previous releases encoded the tuple as timestamp + NUL + ID.
    const [createdAt, id] = decoded.split("\u0000");
    if (
      createdAt &&
      id &&
      !Number.isNaN(Date.parse(createdAt)) &&
      uuidPattern.test(id)
    ) {
      return { createdAt, id, source: "job" };
    }
    throw new TypeError("Invalid Personal Agent history cursor");
  }
  if (
    !value ||
    typeof value !== "object" ||
    (value as Record<string, unknown>).v !== 1
  ) {
    throw new TypeError("Invalid Personal Agent history cursor");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.createdAt !== "string" ||
    Number.isNaN(Date.parse(candidate.createdAt)) ||
    typeof candidate.id !== "string" ||
    !uuidPattern.test(candidate.id) ||
    (candidate.source !== "job" && candidate.source !== "delivery")
  ) {
    throw new TypeError("Invalid Personal Agent history cursor");
  }
  return {
    createdAt: candidate.createdAt,
    id: candidate.id,
    source: candidate.source
  };
};

export type PersonalAgentNativeHistoryRow = {
  id: string;
  owner_user_id: string;
  conversation_id: string;
  message_id: string;
  command_id: string | null;
  root_title: string | null;
  project_id: string | null;
  agent_id: string;
  agent_version: number;
  agent_name: string | null;
  status:
    | "queued"
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "uncertain"
    | "blocked"
    | "canceled"
    | "skipped";
  execution_id: string | null;
  output_reference?: null;
  created_at: Date;
  created_at_cursor: string;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
  provider: string | null;
  model: string | null;
  ai_client_instance_id: string | null;
  reasoning_effort: string | null;
  permission_mode: PersonalAgentExecutionSettings["permissionMode"];
};

export const personalAgentNativeDeliveryState = (
  status: PersonalAgentNativeHistoryRow["status"]
): PersonalAgentExecutionJob["state"] => {
  switch (status) {
    case "queued":
    case "starting":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
    case "skipped":
      return "canceled";
    case "uncertain":
    case "blocked":
      return "waiting";
  }
};

export const mapPersonalAgentNativeHistoryRow = (
  row: PersonalAgentNativeHistoryRow,
  input: { goal: string | null }
): PersonalAgentHistoryJob => {
  const job = parsePersonalAgentExecutionJob({
    contractVersion: 1,
    id: row.id,
    ownerUserId: row.owner_user_id,
    // Native history belongs to the Personal conversation root, which is what
    // the Studio opens when a user selects this history item.
    conversationId: row.conversation_id,
    commandId: row.command_id,
    title:
      input.goal?.replace(/\s+/gu, " ").trim().slice(0, 512) ||
      row.root_title?.slice(0, 512) ||
      "Agent task",
    projectId:
      row.project_id && row.project_id.length <= 256 ? row.project_id : null,
    attribution: {
      kind: "agent",
      agentId: row.agent_id,
      agentVersion: row.agent_version
    },
    state: personalAgentNativeDeliveryState(row.status),
    counters: {
      attemptsStarted: 0,
      attemptsSucceeded: 0,
      attemptsFailed: 0,
      attemptsCanceled: 0,
      attemptsInterrupted: 0
    },
    lastAttemptId: null,
    outputReference: null,
    version: 1,
    lastObservedAt: row.updated_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  });
  // Native deliveries are work items, not persisted Job attempts. Keep the
  // attempt fields empty until a real attempt row exists; expose their
  // immutable launch settings separately for the history display.
  return personalAgentHistoryJobSchema.parse({
    ...job,
    goal: input.goal,
    agentName: row.agent_name,
    attempts: [],
    latestAttempt: null,
    executionSettings: {
      provider: row.provider,
      model: row.model,
      aiClientInstanceId: row.ai_client_instance_id,
      reasoningEffort: row.reasoning_effort,
      permissionMode: row.permission_mode
    }
  });
};

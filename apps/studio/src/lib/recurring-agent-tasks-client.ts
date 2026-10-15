"use client";

import {
  recurringAgentOccurrenceSchema,
  recurringAgentOccurrencePageSchema,
  recurringAgentTaskListSchema,
  recurringAgentTaskSchema,
  type CreateRecurringAgentTask,
  type RecurringAgentOccurrence,
  type RecurringAgentOccurrencePage,
  type RecurringAgentTask,
  type RecurringAgentTaskControl,
  type UpdateRecurringAgentTask
} from "@koed/shared/recurring-agent-tasks";
import {
  PersonalAgentsHttpError,
  studioAuthenticatedRequest
} from "./personal-agents-client";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class RecurringAgentTasksHttpError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "RecurringAgentTasksHttpError";
    this.status = status;
    this.code = code;
  }
}

export type RecurringAgentTaskPage = Readonly<{
  tasks: readonly RecurringAgentTask[];
  nextCursor: string | null;
}>;

export function recurringTaskClientAlias(
  instance: Readonly<{ instanceId: string; hostedInstanceId?: string }>,
  hosted: boolean
): string {
  return hosted
    ? (instance.hostedInstanceId ?? instance.instanceId)
    : instance.instanceId;
}

function isHostedStudio(): boolean {
  if (typeof window === "undefined") return false;
  return /^\/studio(?:\/|$)/u.test(window.location.pathname);
}

function recurringPath(path: string): string {
  return `${isHostedStudio() ? "/v1" : "/studio-api"}${path}`;
}

function safeError(error: unknown): RecurringAgentTasksHttpError {
  const status =
    error instanceof PersonalAgentsHttpError ? error.status : undefined;
  const code =
    error instanceof PersonalAgentsHttpError ? error.code : undefined;
  const message =
    status === 401 || status === 403
      ? "Your session cannot manage these recurring tasks. Refresh Studio and try again."
      : status === 404
        ? "This Agent or recurring task is no longer available. Refresh and try again."
        : status === 409
          ? "The task changed or is running. Refresh its status before trying again."
          : status === 422
            ? "The task settings could not be accepted. Check the selected schedule and AI Client settings."
            : status === 429
              ? "Koed is receiving too many requests. Wait a moment, then try again."
              : "Recurring tasks are unavailable right now. Check the Koed connection and try again.";
  return new RecurringAgentTasksHttpError(message, status, code);
}

async function request(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<unknown> {
  try {
    return await studioAuthenticatedRequest(recurringPath(path), init, signal);
  } catch (error) {
    throw safeError(error);
  }
}

function parsedTask(payload: unknown): RecurringAgentTask {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new RecurringAgentTasksHttpError(
      "The recurring task service returned an invalid response."
    );
  const task = recurringAgentTaskSchema.safeParse(
    (payload as Record<string, unknown>).task
  );
  if (!task.success)
    throw new RecurringAgentTasksHttpError(
      "The recurring task service returned an invalid response."
    );
  return task.data;
}

function parsedOccurrence(payload: unknown): RecurringAgentOccurrence {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new RecurringAgentTasksHttpError(
      "The recurring task service returned an invalid response."
    );
  const occurrence = recurringAgentOccurrenceSchema.safeParse(
    (payload as Record<string, unknown>).occurrence
  );
  if (!occurrence.success)
    throw new RecurringAgentTasksHttpError(
      "The recurring task service returned an invalid response."
    );
  return occurrence.data;
}

export const recurringAgentTasksClient = {
  async list(
    agentId: string,
    signal?: AbortSignal
  ): Promise<RecurringAgentTask[]> {
    return [...(await this.listPage(agentId, undefined, signal)).tasks];
  },

  async listPage(
    agentId: string,
    before?: string,
    signal?: AbortSignal
  ): Promise<RecurringAgentTaskPage> {
    if (before && !uuidPattern.test(before))
      throw new RecurringAgentTasksHttpError(
        "The task list cursor is invalid. Refresh the task list."
      );
    const query = new URLSearchParams({ limit: "10" });
    if (before) query.set("before", before);
    const payload = await request(
      `/personal-agents/${encodeURIComponent(agentId)}/recurring-tasks?${query.toString()}`,
      {},
      signal
    );
    const result = recurringAgentTaskListSchema.safeParse(payload);
    if (!result.success)
      throw new RecurringAgentTasksHttpError(
        "The recurring task service returned an invalid response."
      );
    return {
      tasks: result.data.tasks,
      nextCursor: result.data.nextCursor ?? null
    };
  },

  async create(
    agentId: string,
    values: CreateRecurringAgentTask,
    signal?: AbortSignal
  ): Promise<RecurringAgentTask> {
    return parsedTask(
      await request(
        `/personal-agents/${encodeURIComponent(agentId)}/recurring-tasks`,
        { method: "POST", body: JSON.stringify(values) },
        signal
      )
    );
  },

  async get(taskId: string, signal?: AbortSignal): Promise<RecurringAgentTask> {
    return parsedTask(
      await request(
        `/recurring-agent-tasks/${encodeURIComponent(taskId)}`,
        {},
        signal
      )
    );
  },

  async update(
    taskId: string,
    values: UpdateRecurringAgentTask,
    signal?: AbortSignal
  ): Promise<RecurringAgentTask> {
    return parsedTask(
      await request(
        `/recurring-agent-tasks/${encodeURIComponent(taskId)}`,
        { method: "PATCH", body: JSON.stringify(values) },
        signal
      )
    );
  },

  async control(
    taskId: string,
    values: RecurringAgentTaskControl,
    signal?: AbortSignal
  ): Promise<RecurringAgentTask> {
    return parsedTask(
      await request(
        `/recurring-agent-tasks/${encodeURIComponent(taskId)}/control`,
        { method: "POST", body: JSON.stringify(values) },
        signal
      )
    );
  },

  async runNow(
    taskId: string,
    requestId: string,
    expectedRevision: number,
    signal?: AbortSignal
  ): Promise<RecurringAgentOccurrence> {
    if (!uuidPattern.test(requestId))
      throw new RecurringAgentTasksHttpError(
        "A secure request ID is required before running now."
      );
    return parsedOccurrence(
      await request(
        `/recurring-agent-tasks/${encodeURIComponent(taskId)}/run-now`,
        {
          method: "POST",
          body: JSON.stringify({ requestId, expectedRevision })
        },
        signal
      )
    );
  },

  async occurrences(
    taskId: string,
    before?: string,
    signal?: AbortSignal
  ): Promise<RecurringAgentOccurrencePage> {
    const query = new URLSearchParams({ limit: "50" });
    if (before) {
      if (!uuidPattern.test(before))
        throw new RecurringAgentTasksHttpError(
          "The occurrence history cursor is invalid. Refresh the task history."
        );
      query.set("before", before);
    }
    const payload = await request(
      `/recurring-agent-tasks/${encodeURIComponent(taskId)}/occurrences?${query.toString()}`,
      {},
      signal
    );
    const result = recurringAgentOccurrencePageSchema.safeParse(payload);
    if (!result.success)
      throw new RecurringAgentTasksHttpError(
        "The recurring task service returned an invalid history page."
      );
    return result.data;
  }
};

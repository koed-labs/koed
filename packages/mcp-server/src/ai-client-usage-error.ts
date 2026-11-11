import type { CodexThreadTokenUsage } from "./codex-app-server-runner.js";

/** Usage observed before an AI Client run failed. No missing count is inferred. */
export class AiClientUsageError extends Error {
  readonly model: string;
  readonly tokenUsage?: CodexThreadTokenUsage;
  readonly threadId?: string;
  readonly memoryAnswerTaskErrorCode?: unknown;
  readonly retryable?: unknown;

  constructor(
    error: unknown,
    usage: {
      model: string;
      tokenUsage?: CodexThreadTokenUsage;
      threadId?: string;
    }
  ) {
    super(error instanceof Error ? error.message : String(error), {
      cause: error
    });
    this.name = "AiClientUsageError";
    this.model = usage.model;
    this.tokenUsage = usage.tokenUsage;
    this.threadId = usage.threadId;
    if (error && typeof error === "object") {
      if ("memoryAnswerTaskErrorCode" in error)
        this.memoryAnswerTaskErrorCode = error.memoryAnswerTaskErrorCode;
      if ("retryable" in error) this.retryable = error.retryable;
    }
  }
}

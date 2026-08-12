import { z } from "zod";
import { codexIdePromptUserText } from "@koed/core";
import {
  CodexAppServerTurnError,
  type CodexAppServerRawEvent,
  type CodexThreadTokenUsage
} from "./codex-app-server-runner.js";
import { runAiClientJsonTask } from "./ai-client-runner.js";
import type { MemoryApiClient } from "./index.js";
import {
  acquireLocalSummaryLock,
  resolveLcmSummaryWorkerConfig,
  type LcmSummaryWorkerConfig
} from "./lcm-summary-worker.js";
import {
  loadPrompt,
  renderPromptWithMetadata,
  type RenderedPrompt
} from "./prompt-loader.js";

export const SESSION_TITLE_PROMPT_VERSION = "session-title-codex-json-v1";
const MAX_SESSION_TITLE_EXCERPT_CHARS = 1_200;
const ENVIRONMENT_CONTEXT_BLOCK =
  /<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/gi;

export interface SessionTitleCandidate {
  id: string;
  externalSessionId: string | null;
  projectName: string | null;
  projectPath: string | null;
  currentTitle: string | null;
  eventCount: number;
  sourceItems: Array<{
    id: string;
    actor: string;
    content: string;
    capturedAt: string;
  }>;
}

export interface SessionTitleResult {
  sessionId: string;
  submitted: boolean;
  title?: string;
  titleModel?: string;
  error?: string;
}

export interface SessionTitleTelemetry {
  sessionId: string;
  model: string;
  promptVersion: string;
  durationMs: number;
  tokenUsage?: CodexThreadTokenUsage;
  threadId?: string;
  turnId?: string;
}

export type SessionTitleTelemetryObserver = (
  telemetry: SessionTitleTelemetry
) => void | Promise<void>;

type SessionTitlePromptResult = {
  title: string;
  model: string;
  tokenUsage?: CodexThreadTokenUsage;
  threadId?: string;
  turnId?: string;
  rawEvents?: CodexAppServerRawEvent[];
};

export type SessionTitleRunner = (
  prompt: string,
  config: LcmSummaryWorkerConfig,
  timeoutMs: number
) => Promise<SessionTitlePromptResult>;

const sessionTitleSchema = z.object({
  title: z.string().trim().min(1).max(120)
});

const stripJsonFences = (text: string): string => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
};

const titlePromptText = (text: string): string =>
  codexIdePromptUserText(text)
    .replace(ENVIRONMENT_CONTEXT_BLOCK, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeTitle = (title: string): string =>
  titlePromptText(title)
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .slice(0, 120);

const parseSessionTitle = (text: string): string => {
  const parsed = sessionTitleSchema.parse(JSON.parse(stripJsonFences(text)));
  return normalizeTitle(parsed.title);
};

const boundedExcerpt = (content: string): string => {
  const normalized = titlePromptText(content);
  if (normalized.length <= MAX_SESSION_TITLE_EXCERPT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_SESSION_TITLE_EXCERPT_CHARS).trim()} ... [truncated]`;
};

const sourceItemsForPrompt = (session: SessionTitleCandidate): string =>
  session.sourceItems
    .map((item, index) => {
      const actor = item.actor || "unknown";
      const content = boundedExcerpt(item.content);
      return `${index + 1}. ${actor}: ${content}`;
    })
    .join("\n");

const buildVersionedSessionTitlePrompt = (
  session: SessionTitleCandidate,
  env: NodeJS.ProcessEnv = process.env
): RenderedPrompt =>
  renderPromptWithMetadata(
    "session-title",
    {
      session_id: session.id,
      external_session_id: session.externalSessionId ?? "none",
      current_title: session.currentTitle
        ? titlePromptText(session.currentTitle) || "none"
        : "none",
      project: session.projectName ?? session.projectPath ?? "unknown",
      title_event_count: session.eventCount,
      conversation_excerpts: sourceItemsForPrompt(session)
    },
    { env }
  );

export const buildSessionTitlePrompt = (
  session: SessionTitleCandidate
): string => buildVersionedSessionTitlePrompt(session).text;

export const runSessionTitle: SessionTitleRunner = async (
  prompt,
  config,
  timeoutMs
): Promise<SessionTitlePromptResult> => {
  const result = await runAiClientJsonTask(
    prompt,
    {
      provider: config.provider,
      executablePath: config.executablePath,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      cwd: config.cwd,
      env: config.env,
      clientName: "koed-session-title-worker",
      systemPrompt: loadPrompt("ai-client-session-title-base").body,
      outputSchema: {
        type: "object",
        properties: { title: { type: "string", minLength: 1, maxLength: 120 } },
        required: ["title"],
        additionalProperties: false
      }
    },
    timeoutMs
  );
  return {
    ...result,
    title: parseSessionTitle(result.text)
  };
};

const runPromptWithRetries = async (
  prompt: string,
  config: LcmSummaryWorkerConfig,
  runner: SessionTitleRunner
): Promise<SessionTitlePromptResult> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const result = await runner(prompt, config, config.timeoutMs * attempt);
      return {
        ...result,
        title: normalizeTitle(result.title)
      };
    } catch (error) {
      lastError = error;
      if (attempt < config.maxAttempts && config.retryDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.retryDelayMs * 2 ** (attempt - 1))
        );
      }
    }
  }
  throw lastError;
};

const generateSessionTitle = async (
  client: MemoryApiClient,
  session: SessionTitleCandidate,
  config: LcmSummaryWorkerConfig,
  runner: SessionTitleRunner,
  telemetryObserver?: SessionTitleTelemetryObserver
): Promise<SessionTitleResult> => {
  try {
    const prompt = buildVersionedSessionTitlePrompt(session, config.env);
    const startedAt = performance.now();
    const result = await runPromptWithRetries(prompt.text, config, runner);
    await telemetryObserver?.({
      sessionId: session.id,
      model: result.model,
      promptVersion: prompt.version,
      durationMs: performance.now() - startedAt,
      ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
      ...(result.threadId ? { threadId: result.threadId } : {}),
      ...(result.turnId ? { turnId: result.turnId } : {})
    });
    await client.submitSessionTitle(session.id, {
      title: result.title,
      titleModel: result.model,
      titlePromptVersion: prompt.version
    });
    return {
      sessionId: session.id,
      submitted: true,
      title: result.title,
      titleModel: result.model
    };
  } catch (error) {
    return {
      sessionId: session.id,
      submitted: false,
      error:
        error instanceof CodexAppServerTurnError || error instanceof Error
          ? error.message
          : String(error)
    };
  }
};

const runWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index]!);
      }
    }
  );
  await Promise.all(runners);
  return results;
};

export const generatePendingSessionTitles = async (
  client: MemoryApiClient,
  options: {
    limit?: number;
    minUserEvents?: number;
    config?: LcmSummaryWorkerConfig;
    runner?: SessionTitleRunner;
    telemetryObserver?: SessionTitleTelemetryObserver;
  } = {}
) => {
  const config = options.config ?? resolveLcmSummaryWorkerConfig();
  const requestedLimit = options.limit ?? 5;
  const minUserEvents = options.minUserEvents ?? 3;
  const releaseLock = acquireLocalSummaryLock(
    config.env,
    Math.max(config.timeoutMs * config.maxAttempts * requestedLimit, 1_800_000)
  );
  if (!releaseLock) {
    return {
      requestedLimit,
      minUserEvents,
      processedCount: 0,
      submittedCount: 0,
      failedCount: 0,
      skippedReason: "already_running",
      localOnly: true,
      config: {
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: config.timeoutMs,
        maxAttempts: config.maxAttempts,
        retryDelayMs: config.retryDelayMs,
        concurrency: config.concurrency,
        executablePath: config.executablePath
      },
      results: []
    };
  }

  try {
    const pending = (await client.listPendingSessionTitles({
      limit: requestedLimit,
      minUserEvents
    })) as { sessions?: SessionTitleCandidate[] };
    const sessions = pending.sessions ?? [];
    const runner = options.runner ?? runSessionTitle;
    const results = await runWithConcurrency(
      sessions,
      config.concurrency,
      (session) =>
        generateSessionTitle(
          client,
          session,
          config,
          runner,
          options.telemetryObserver
        )
    );

    return {
      requestedLimit,
      minUserEvents,
      processedCount: results.length,
      submittedCount: results.filter((result) => result.submitted).length,
      failedCount: results.filter((result) => !result.submitted).length,
      localOnly: true,
      config: {
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: config.timeoutMs,
        maxAttempts: config.maxAttempts,
        retryDelayMs: config.retryDelayMs,
        concurrency: config.concurrency,
        executablePath: config.executablePath
      },
      results
    };
  } finally {
    releaseLock();
  }
};

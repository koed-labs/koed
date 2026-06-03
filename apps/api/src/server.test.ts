import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ExpandedMemoryNode,
  MemoryActor,
  MemoryEventRecord,
  MemorySearchResult
} from "@koed/core";
import type {
  ActorContext,
  ApiTokenRecord,
  CapturedSessionRecord,
  CreateMemoryNodeInput,
  CreateUserInput,
  LocalMemoryAgentSettingRecord,
  MemoryQuestionDetailRecord,
  MemoryNodeRecord,
  MemorySourceRepository,
  UserRecord,
  Visibility
} from "@koed/db";
import {
  buildServer,
  canReceiveGraphStreamPayload,
  graphUpdateActionForPayload,
  shouldIgnoreGraphStreamPayload
} from "./server/index.js";

afterEach(() => {
  for (const name of [
    "KOED_ALLOW_PUBLIC_REGISTRATION",
    "MEMORY_RATE_LIMIT_WINDOW_MS",
    "MEMORY_RATE_LIMIT_MAX",
    "MEMORY_READ_RATE_LIMIT_WINDOW_MS",
    "MEMORY_READ_RATE_LIMIT_MAX",
    "MEMORY_WRITE_RATE_LIMIT_WINDOW_MS",
    "MEMORY_WRITE_RATE_LIMIT_MAX",
    "MEMORY_RECALL_RATE_LIMIT_WINDOW_MS",
    "MEMORY_RECALL_RATE_LIMIT_MAX",
    "RATE_LIMIT_STORE",
    "RATE_LIMIT_REDIS_URL",
    "CACHE_STORE",
    "CACHE_REDIS_URL",
    "GRAPH_CACHE_TTL_SECONDS",
    "KOED_HOST_CHECKOUT_PATH",
    "CORS_ORIGINS",
    "API_CORS_ORIGINS"
  ]) {
    delete process.env[name];
  }
});

const cookieHeader = (response: {
  headers: Record<string, unknown>;
}): string => {
  const cookie = response.headers["set-cookie"];
  const firstCookie = isStringArray(cookie)
    ? cookie[0]
    : typeof cookie === "string"
      ? cookie
      : undefined;
  return firstCookie?.split(";")[0] ?? "";
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const jsonBody = <T>(response: { body: string }): T =>
  JSON.parse(response.body) as T;

type TokenResponse = {
  token: string;
  apiToken: { tokenPrefix: string };
};

type AccessResponse = {
  ok?: boolean;
  auth?: string;
  providerConfigSupported?: boolean;
};

type CaptureResponse = {
  event: {
    id: string;
    visibility: string;
    metadata: Record<string, unknown>;
  };
  compaction?: { leafNodeIds: string[] };
  processing?: { compaction: { inline: boolean } };
};

type SearchResponse = { hits: unknown[] };
type AnswerResponse = {
  markdown: string;
  evidenceBundle: { instructions: string };
  evidence: Array<{ summaryText?: string }>;
  citations: unknown[];
};
type PolicyResponse = { policy: { captureState: string } };
type ClusterResponse = { clusters: Array<Record<string, unknown>> };
type MemoryItemsResponse = { memories: Array<Record<string, unknown>> };
type GraphOverviewResponse = { overview: Record<string, unknown> };
type GraphNodesResponse = { nodes: Array<Record<string, unknown>> };
type GraphNodeResponse = {
  node: Record<string, unknown> & {
    sources: Array<Record<string, unknown>>;
  };
};
type GraphEventsResponse = {
  events: Array<
    Record<string, unknown> & {
      id: string;
      actor: MemoryActor;
      content?: string;
      timestamp: string;
    }
  >;
};
type GraphThreadIndexResponse = {
  projects: Array<{
    id: string;
    name: string;
    path: string | null;
    eventCount: number;
    threads: Array<{
      id: string;
      name: string;
      sessionId: string | null;
      projectId: string;
      projectName: string;
      eventCount: number;
      invalidatedCount: number;
      latestAt: string;
      sample: string;
      threadKind: string;
      parentThreadId: string | null;
      parentSessionId: string | null;
    }>;
  }>;
};
type GraphEventResponse = {
  event: Record<string, unknown> & { rawContent?: string };
};
type MemoryExportResponse = { nodes: Array<Record<string, unknown>> };
type SessionResponse = { session: { id: string } };
type ExpandedResponse = { expanded: { sources: Array<{ content: string }> } };
type OpenApiResponse = { paths: Record<string, unknown> };
type MemoryQuestionResponse = { question: MemoryQuestionDetailRecord };
type MemoryQuestionsResponse = { questions: MemoryQuestionDetailRecord[] };

const createFakeRepository = (): MemorySourceRepository => {
  const users = new Map<string, UserRecord>();
  const sessions = new Map<string, string>();
  const tokens = new Map<string, ApiTokenRecord & { tokenHash: string }>();
  const memories: MemoryNodeRecord[] = [];
  const policies: Array<{
    id: string;
    ownerUserId: string;
    targetType: "global" | "project" | "thread";
    projectId: string | null;
    projectName: string | null;
    projectPath: string | null;
    threadId: string | null;
    threadName: string | null;
    captureState: "enabled" | "disabled" | "ask" | null;
    visibility: Visibility | null;
    pauseUntil: string | null;
    createdAt: string;
    updatedAt: string;
  }> = [];
  const capturedSessions = new Map<string, CapturedSessionRecord>();
  const events: MemoryEventRecord[] = [];
  const eventIdempotencyKeys = new Map<string, string>();
  const eventSourceHashes = new Map<string, string>();
  const nodeSources = new Map<string, string[]>();
  const invalidatedNodes = new Set<string>();
  const invalidatedEvents = new Set<string>();
  const summaryCorrections = new Map<string, string>();
  const memoryQuestions = new Map<string, MemoryQuestionDetailRecord>();
  const localMemoryAgentSettings = new Map<
    string,
    LocalMemoryAgentSettingRecord
  >();

  return {
    health: async () => true,
    async countUsers() {
      return users.size;
    },
    async createUser(input: CreateUserInput) {
      const id = randomUUID();
      users.set(id, {
        id,
        email: input.email.toLowerCase(),
        displayName: input.displayName ?? null,
        passwordHash: input.passwordHash ?? null
      });
      return { id };
    },
    async findUserByEmail(email: string) {
      return (
        [...users.values()].find(
          (user) => user.email === email.toLowerCase()
        ) ?? null
      );
    },
    async getUser(userId: string) {
      return users.get(userId) ?? null;
    },
    async createSession(userId: string, sessionHash: string) {
      sessions.set(sessionHash, userId);
    },
    async getSessionUser(sessionHash: string) {
      const userId = sessions.get(sessionHash);
      return userId ? (users.get(userId) ?? null) : null;
    },
    async revokeSession(sessionHash: string) {
      sessions.delete(sessionHash);
    },
    async createApiToken(input) {
      const id = randomUUID();
      const record = {
        id,
        ownerUserId: input.ownerUserId,
        name: input.name,
        tokenPrefix: input.tokenPrefix,
        scopes: input.scopes ?? [],
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        tokenHash: input.tokenHash
      };
      tokens.set(input.tokenHash, record);
      return record;
    },
    async listApiTokens(userId: string) {
      return [...tokens.values()].filter(
        (token) => token.ownerUserId === userId && !token.revokedAt
      );
    },
    async revokeApiToken(userId: string, tokenId: string) {
      const token = [...tokens.values()].find(
        (candidate) =>
          candidate.id === tokenId && candidate.ownerUserId === userId
      );
      if (!token) {
        return false;
      }
      token.revokedAt = new Date().toISOString();
      return true;
    },
    async getApiTokenUser(tokenHash: string) {
      const token = tokens.get(tokenHash);
      return token ? (users.get(token.ownerUserId) ?? null) : null;
    },
    async createCapturedSession(actor: ActorContext, input) {
      const id = randomUUID();
      const record: CapturedSessionRecord = {
        id,
        ownerUserId: actor.userId,
        visibility: "personal",
        externalSessionId: input.externalSessionId ?? null,
        workspaceId: input.workspaceId ?? input.cwd ?? null,
        sourceRuntime: input.sourceRuntime ?? "codex",
        captureMethod: input.captureMethod ?? "mcp",
        model: input.model ?? null,
        cwd: input.cwd ?? null,
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString()
      };
      capturedSessions.set(id, record);
      return record;
    },
    async updateCapturedSessionTitle(actor, sessionId, input) {
      const session = capturedSessions.get(sessionId);
      const title = input.title.replace(/\s+/g, " ").trim();
      if (
        !session ||
        !title ||
        session.ownerUserId !== actor.userId ||
        session.visibility !== "personal"
      ) {
        return null;
      }
      const nextSession: CapturedSessionRecord = {
        ...session,
        metadata: {
          ...session.metadata,
          threadName: title,
          threadNameSource: "manual",
          threadNameEditedAt: new Date().toISOString()
        }
      };
      capturedSessions.set(sessionId, nextSession);
      return nextSession;
    },
    async listCapturedSessionsNeedingTitles(actor, input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 5, 1), 25);
      const minUserEvents = Math.min(Math.max(input.minUserEvents ?? 3, 1), 50);
      const candidates = [...capturedSessions.values()]
        .filter((session) => {
          if (
            session.ownerUserId !== actor.userId ||
            session.visibility !== "personal"
          ) {
            return false;
          }
          if (session.metadata.threadNameSource === "manual") {
            return false;
          }
          const title =
            typeof session.metadata.threadName === "string"
              ? session.metadata.threadName.trim()
              : "";
          return (
            !title ||
            title === session.id ||
            title === session.externalSessionId ||
            session.metadata.threadNameSource === "provisional"
          );
        })
        .map((session) => {
          const sessionEvents = events.filter(
            (event) =>
              event.sessionId === session.id &&
              event.ownerUserId === actor.userId &&
              event.visibility === "personal"
          );
          const titleEventCount = sessionEvents.filter(
            (event) => event.actor === "user" || event.actor === "agent"
          ).length;
          return { session, sessionEvents, titleEventCount };
        })
        .filter((candidate) => candidate.titleEventCount >= minUserEvents)
        .slice(0, limit);

      return candidates.map(({ session, sessionEvents, titleEventCount }) => ({
        id: session.id,
        externalSessionId: session.externalSessionId,
        projectName:
          typeof session.metadata.projectName === "string"
            ? session.metadata.projectName
            : session.cwd,
        projectPath:
          typeof session.metadata.projectPath === "string"
            ? session.metadata.projectPath
            : session.cwd,
        currentTitle:
          typeof session.metadata.threadName === "string"
            ? session.metadata.threadName
            : null,
        eventCount: titleEventCount,
        sourceItems: sessionEvents
          .filter(
            (event) =>
              (event.actor === "user" ||
                event.actor === "assistant" ||
                event.actor === "agent" ||
                event.actor === "subagent") &&
              event.content.trim()
          )
          .slice(0, 8)
          .map((event) => ({
            id: event.id,
            actor: event.actor,
            content: event.content,
            capturedAt: event.createdAt
          }))
      }));
    },
    async updateCapturedSessionGeneratedTitle(actor, sessionId, input) {
      const session = capturedSessions.get(sessionId);
      const title = input.title.replace(/\s+/g, " ").trim();
      if (
        !session ||
        !title ||
        session.ownerUserId !== actor.userId ||
        session.visibility !== "personal" ||
        session.metadata.threadNameSource === "manual"
      ) {
        return null;
      }
      const existingTitle =
        typeof session.metadata.threadName === "string"
          ? session.metadata.threadName.trim()
          : "";
      if (
        existingTitle &&
        existingTitle !== session.id &&
        existingTitle !== session.externalSessionId &&
        !["generated", "lcm", "provisional"].includes(
          typeof session.metadata.threadNameSource === "string"
            ? session.metadata.threadNameSource
            : ""
        )
      ) {
        return null;
      }
      const nextSession: CapturedSessionRecord = {
        ...session,
        metadata: {
          ...session.metadata,
          threadName: title,
          threadNameSource: input.source,
          threadNameGeneratedAt: new Date().toISOString()
        }
      };
      capturedSessions.set(sessionId, nextSession);
      return nextSession;
    },
    async createConversationItems(_actor, input) {
      return input.items.map((item, index) => ({
        id: randomUUID(),
        sessionId: item.sessionId ?? null,
        turnId: item.turnId ?? null,
        sourceKind: item.sourceKind,
        sourceAdapterVersion: item.sourceAdapterVersion,
        sourceTransport: item.sourceTransport,
        externalSessionId: item.externalSessionId ?? null,
        externalThreadId: item.externalThreadId ?? null,
        externalTurnId: item.externalTurnId ?? null,
        externalItemId: item.externalItemId ?? null,
        sourceRecordType: item.sourceRecordType,
        sourceEventType: item.sourceEventType ?? null,
        sourceSequence: item.sourceSequence ?? index,
        idempotencyKey: item.idempotencyKey,
        createdAt: new Date().toISOString()
      }));
    },
    async recordWorkflowTokenUsage(_actor, input) {
      return {
        id: randomUUID(),
        workflowType: input.workflowType,
        workflowId: input.workflowId ?? null,
        sessionId: input.sessionId ?? null,
        turnId: input.turnId ?? null,
        conversationItemId: input.conversationItemId ?? null,
        model: input.model ?? null,
        usageSource: input.usageSource ?? "app_server",
        usageAccuracy: input.usageAccuracy ?? "provider_reported",
        usageKind: input.usageKind ?? "turn_delta",
        connectorClient: input.connectorClient ?? null,
        tokenizerPackage: input.tokenizerPackage ?? null,
        tokenizerEncoding: input.tokenizerEncoding ?? null,
        tokenizerModel: input.tokenizerModel ?? null,
        tokenizerExactModelMatch: input.tokenizerExactModelMatch ?? null,
        tokenizerHeuristicFallback: input.tokenizerHeuristicFallback ?? null,
        tokenizerVersion: input.tokenizerVersion ?? null,
        inputTokens: input.inputTokens ?? null,
        cachedInputTokens: input.cachedInputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        reasoningOutputTokens: input.reasoningOutputTokens ?? null,
        totalTokens: input.totalTokens ?? null,
        usageScope: input.usageScope ?? "last",
        createdAt: new Date().toISOString()
      };
    },
    async listWorkflowTokenUsageRollups() {
      return [
        {
          group: { workflow: "memory_question" },
          rowCount: 1,
          inputTokens: 4,
          cachedInputTokens: 1,
          outputTokens: 2,
          reasoningOutputTokens: 0,
          totalTokens: 6
        }
      ];
    },
    async projectPendingConversationItems(_actor, input) {
      if (input?.visibility !== "personal") {
        throw new Error("API token projection must stay personal-scoped");
      }
      return {
        rawItemsScanned: 0,
        rawItemsProjected: 0,
        messagesCreated: 0,
        toolEventsCreated: 0,
        memoryEventsCreated: 0,
        tokenUsageRowsCreated: 0,
        memoryEventIds: [],
        memoryEventScopes: []
      };
    },
    async listConversationProjectionActors() {
      return [];
    },
    async createMemoryQuestion(actor, input) {
      const now = new Date().toISOString();
      const record: MemoryQuestionDetailRecord = {
        id: randomUUID(),
        ownerUserId: actor.userId,
        visibility: "personal",
        retrievalScope: input.retrievalScope ?? "personal",
        searchDomain: input.searchDomain,
        workspaceId: input.workspaceId ?? null,
        projectName: input.projectName ?? null,
        projectPath: input.projectPath ?? null,
        sessionId: input.sessionId ?? null,
        threadId: input.threadId ?? null,
        threadName: input.threadName ?? null,
        query: input.query,
        answerPreview: null,
        answerMarkdown: null,
        errorMessage: null,
        evidence: null,
        citations: null,
        retrieval: null,
        localMemoryWorker: null,
        localMemoryWorkerConfig: input.localMemoryWorkerConfig ?? null,
        response: null,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        answeredAt: null,
        processingStartedAt: null,
        processingLeaseUntil: null,
        attemptCount: 0,
        lastErrorMessage: null,
        evidenceCount: 0
      };
      memoryQuestions.set(record.id, record);
      return record;
    },
    async listMemoryQuestions(actor, input = {}) {
      const query = input.query?.toLowerCase();
      return [...memoryQuestions.values()]
        .filter((question) => question.ownerUserId === actor.userId)
        .filter(
          (question) =>
            !input.searchDomain || question.searchDomain === input.searchDomain
        )
        .filter(
          (question) =>
            !input.workspaceId || question.workspaceId === input.workspaceId
        )
        .filter(
          (question) =>
            !input.sessionId || question.sessionId === input.sessionId
        )
        .filter((question) => !input.status || question.status === input.status)
        .filter(
          (question) =>
            !query ||
            question.query.toLowerCase().includes(query) ||
            (question.answerMarkdown ?? "").toLowerCase().includes(query)
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 100));
    },
    async claimPendingMemoryQuestions(actor, input = {}) {
      const now = new Date();
      const leaseUntil = new Date(
        now.getTime() + (input.leaseSeconds ?? 180) * 1000
      ).toISOString();
      const claimed: MemoryQuestionDetailRecord[] = [];
      for (const question of [...memoryQuestions.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      )) {
        if (claimed.length >= (input.limit ?? 1)) {
          break;
        }
        if (
          question.ownerUserId !== actor.userId ||
          question.status !== "pending" ||
          (input.questionId && question.id !== input.questionId)
        ) {
          continue;
        }
        if (
          question.processingLeaseUntil &&
          Date.parse(question.processingLeaseUntil) > now.getTime()
        ) {
          continue;
        }
        const updated: MemoryQuestionDetailRecord = {
          ...question,
          processingStartedAt: now.toISOString(),
          processingLeaseUntil: leaseUntil,
          attemptCount: question.attemptCount + 1,
          lastErrorMessage: null,
          updatedAt: now.toISOString()
        };
        memoryQuestions.set(question.id, updated);
        claimed.push(updated);
      }
      return claimed;
    },
    async getMemoryQuestion(actor, questionId) {
      const question = memoryQuestions.get(questionId);
      return question?.ownerUserId === actor.userId ? question : null;
    },
    async listLocalMemoryAgentSettings(actor) {
      return [...localMemoryAgentSettings.values()]
        .filter((setting) => setting.ownerUserId === actor.userId)
        .sort((left, right) => left.flowKey.localeCompare(right.flowKey));
    },
    async upsertLocalMemoryAgentSetting(actor, input) {
      const key = `${actor.userId}:${input.flowKey}`;
      const existing = localMemoryAgentSettings.get(key);
      const now = new Date().toISOString();
      const record: LocalMemoryAgentSettingRecord = {
        ownerUserId: actor.userId,
        flowKey: input.flowKey,
        provider: input.provider,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        timeoutMs: input.timeoutMs,
        maxAttempts: input.maxAttempts,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      localMemoryAgentSettings.set(key, record);
      return record;
    },
    async updateMemoryQuestion(actor, questionId, input) {
      const question = memoryQuestions.get(questionId);
      if (
        !question ||
        question.ownerUserId !== actor.userId ||
        question.status !== "pending" ||
        (input.attemptCount !== undefined &&
          input.attemptCount !== question.attemptCount)
      ) {
        return null;
      }
      const updatedAt = new Date().toISOString();
      const updated: MemoryQuestionDetailRecord =
        input.status === "answered"
          ? {
              ...question,
              status: "answered",
              answerMarkdown: input.answerMarkdown,
              answerPreview: input.answerMarkdown.slice(0, 280),
              errorMessage: null,
              response: input.response ?? question.response,
              evidence: input.evidence ?? question.evidence,
              citations: input.citations ?? question.citations,
              retrieval: input.retrieval ?? question.retrieval,
              localMemoryWorker:
                input.localMemoryWorker ?? question.localMemoryWorker,
              evidenceCount: input.evidence?.length ?? question.evidenceCount,
              answeredAt: updatedAt,
              updatedAt,
              processingLeaseUntil: null,
              lastErrorMessage: null
            }
          : input.status === "error"
            ? {
                ...question,
                status: "error",
                answerMarkdown: null,
                answerPreview: null,
                errorMessage: input.errorMessage,
                response: input.response ?? question.response,
                retrieval: input.retrieval ?? question.retrieval,
                localMemoryWorker:
                  input.localMemoryWorker ?? question.localMemoryWorker,
                answeredAt: updatedAt,
                updatedAt,
                processingLeaseUntil: null,
                lastErrorMessage: input.errorMessage
              }
            : {
                ...question,
                status: "pending",
                answerMarkdown: null,
                answerPreview: null,
                errorMessage: null,
                response: input.response ?? question.response,
                evidence: input.evidence ?? question.evidence,
                citations: input.citations ?? question.citations,
                retrieval: input.retrieval ?? question.retrieval,
                localMemoryWorker:
                  input.localMemoryWorker ?? question.localMemoryWorker,
                evidenceCount: input.evidence?.length ?? question.evidenceCount,
                answeredAt: null,
                updatedAt,
                processingStartedAt: null,
                processingLeaseUntil: null,
                lastErrorMessage: input.lastErrorMessage
              };
      memoryQuestions.set(questionId, updated);
      return updated;
    },
    async createMemoryNode(actor: ActorContext, input: CreateMemoryNodeInput) {
      const record: MemoryNodeRecord = {
        id: randomUUID(),
        ownerUserId: actor.userId,
        visibility: input.visibility,
        title: input.title ?? null,
        summaryText: input.summaryText
      };
      memories.push(record);
      return record;
    },
    async getEffectiveCapturePolicy(actor, input = {}) {
      const session = input.sessionId
        ? capturedSessions.get(input.sessionId)
        : null;
      const projectId = input.projectId ?? session?.workspaceId ?? undefined;
      const threadIds = [
        input.threadId,
        input.sessionId,
        session?.externalSessionId
      ].filter(Boolean);
      const matching = policies
        .filter((policy) => policy.ownerUserId === actor.userId)
        .filter(
          (policy) =>
            policy.targetType === "global" ||
            (policy.targetType === "project" &&
              policy.projectId === projectId) ||
            (policy.targetType === "thread" &&
              threadIds.includes(policy.threadId ?? ""))
        )
        .sort((left, right) => {
          const priority = { global: 1, project: 2, thread: 3 };
          return priority[right.targetType] - priority[left.targetType];
        });
      const effective = matching[0] ?? null;
      const global = matching.find((policy) => policy.targetType === "global");
      const pauseUntil = effective?.pauseUntil ?? global?.pauseUntil ?? null;
      const paused = pauseUntil
        ? new Date(pauseUntil).getTime() > Date.now()
        : false;
      return {
        captureState: paused
          ? "disabled"
          : (effective?.captureState ?? global?.captureState ?? "enabled"),
        visibility: effective?.visibility ?? global?.visibility ?? "personal",
        paused,
        pauseUntil,
        source: effective?.targetType ?? (global ? "global" : "default"),
        policy: effective
      };
    },
    async listCapturePolicies(actor, targetType) {
      return policies.filter(
        (policy) =>
          policy.ownerUserId === actor.userId &&
          (!targetType || policy.targetType === targetType)
      );
    },
    async upsertCapturePolicy(actor, input) {
      const existing = policies.find(
        (policy) =>
          policy.ownerUserId === actor.userId &&
          policy.targetType === input.targetType &&
          (policy.projectId ?? "") === (input.projectId ?? "") &&
          (policy.threadId ?? "") === (input.threadId ?? "")
      );
      const now = new Date().toISOString();
      const record = {
        id: existing?.id ?? randomUUID(),
        ownerUserId: actor.userId,
        targetType: input.targetType,
        projectId: input.projectId ?? null,
        projectName: input.projectName ?? null,
        projectPath: input.projectPath ?? null,
        threadId: input.threadId ?? null,
        threadName: input.threadName ?? null,
        captureState: input.captureState ?? null,
        visibility: input.visibility ?? null,
        pauseUntil:
          input.pauseUntil instanceof Date
            ? input.pauseUntil.toISOString()
            : (input.pauseUntil ?? null),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      if (existing) {
        Object.assign(existing, record);
        return existing;
      }
      policies.push(record);
      return record;
    },
    async deleteCapturePolicy(actor, policyId) {
      const index = policies.findIndex(
        (policy) =>
          policy.id === policyId && policy.ownerUserId === actor.userId
      );
      if (index === -1) return false;
      policies.splice(index, 1);
      return true;
    },
    async getVisibleMemoryNode(actor: ActorContext, nodeId: string) {
      return (
        memories.find((memory) => {
          if (invalidatedNodes.has(memory.id)) return false;
          if (memory.id !== nodeId) {
            return false;
          }
          if (memory.visibility === "personal") {
            return memory.ownerUserId === actor.userId;
          }
          return false;
        }) ?? null
      );
    },
    async listVisibleMemoryNodes(actor: ActorContext, visibility?: Visibility) {
      return memories.filter((memory) => {
        if (invalidatedNodes.has(memory.id)) return false;
        if (visibility && memory.visibility !== visibility) {
          return false;
        }
        if (memory.visibility === "personal") {
          return memory.ownerUserId === actor.userId;
        }
        return false;
      });
    },
    async getLocalEmbeddingStatus() {
      return {
        enabled: true,
        healthy: false,
        model: null,
        dimensions: null,
        error: "test repository"
      };
    },
    async listMemoryBrowserItems(actor, input = {}) {
      return memories
        .filter((memory) => {
          if (input.visibility && memory.visibility !== input.visibility)
            return false;
          if (invalidatedNodes.has(memory.id)) return false;
          if (
            input.pinned !== undefined &&
            Boolean(memory.pinnedAt) !== input.pinned
          )
            return false;
          if (
            input.query &&
            !memory.summaryText
              .toLowerCase()
              .includes(input.query.toLowerCase())
          )
            return false;
          if (memory.visibility === "personal")
            return memory.ownerUserId === actor.userId;
          return false;
        })
        .slice(0, input.limit ?? 100)
        .map((memory) => ({
          id: memory.id,
          clusterId:
            memory.summaryText.toLowerCase().includes("football") ||
            memory.summaryText.toLowerCase().includes("tennis")
              ? "sports"
              : "general",
          clusterLabel:
            memory.summaryText.toLowerCase().includes("football") ||
            memory.summaryText.toLowerCase().includes("tennis")
              ? "Sports"
              : "General",
          text: memory.summaryText,
          title: memory.title,
          visibility: memory.visibility,
          createdAt: memory.createdAt ?? new Date().toISOString(),
          updatedAt: memory.updatedAt ?? new Date().toISOString(),
          pinnedAt: memory.pinnedAt ?? null,
          projectId: memory.projectId ?? null,
          projectName: memory.projectName ?? null,
          projectPath: memory.projectPath ?? null,
          threadId: memory.threadId ?? null,
          threadName: memory.threadName ?? null
        }));
    },
    async listMemoryClusters(actor, input = {}) {
      const items = await this.listMemoryBrowserItems(actor, input);
      const groups = new Map<
        string,
        {
          id: string;
          label: string;
          count: number;
          latestUpdatedAt: string;
          pinnedCount: number;
          items: typeof items;
        }
      >();
      for (const item of items) {
        const group = groups.get(item.clusterId);
        if (group) {
          group.count += 1;
          group.items.push(item);
        } else {
          groups.set(item.clusterId, {
            id: item.clusterId,
            label: item.clusterLabel,
            count: 1,
            latestUpdatedAt: item.updatedAt,
            pinnedCount: item.pinnedAt ? 1 : 0,
            items: [item]
          });
        }
      }
      return [...groups.values()];
    },
    async listMemoriesInCluster(actor, clusterId, input = {}) {
      const items = await this.listMemoryBrowserItems(actor, input);
      return items.filter((item) => item.clusterId === clusterId);
    },
    async updateMemoryPresentation(actor, nodeId, input) {
      const memory = await this.getVisibleMemoryNode(actor, nodeId);
      if (!memory) return null;
      if (input.summaryText) memory.summaryText = input.summaryText;
      if (input.pinned !== undefined)
        memory.pinnedAt = input.pinned ? new Date().toISOString() : null;
      if (input.visibility) memory.visibility = input.visibility;
      return (
        (await this.listMemoryBrowserItems(actor)).find(
          (item) => item.id === nodeId
        ) ?? null
      );
    },
    async deleteMemory(actor, nodeId) {
      const memory = await this.getVisibleMemoryNode(actor, nodeId);
      if (!memory) return false;
      invalidatedNodes.add(memory.id);
      return true;
    },
    async getLcmGraphOverview(actor) {
      const visibleNodes = await this.listLcmGraphNodes(actor, {
        includeInvalidated: true
      });
      const visibleEvents = await this.listLcmGraphEvents(actor, {
        includeInvalidated: true
      });
      return {
        capturedEvents: visibleEvents.filter((event) => !event.invalidatedAt)
          .length,
        leafNodes: visibleNodes.filter(
          (node) => node.kind === "leaf" && !node.invalidatedAt
        ).length,
        rollupNodes: visibleNodes.filter(
          (node) => node.kind === "rollup" && !node.invalidatedAt
        ).length,
        pendingSummaries: visibleNodes.filter(
          (node) => node.summaryStatus === "pending" && !node.invalidatedAt
        ).length,
        pendingLcmDiagnostics: {
          pendingCount: visibleNodes.filter(
            (node) => node.summaryStatus === "pending" && !node.invalidatedAt
          ).length,
          oldestPendingCreatedAt: null,
          staleThresholdMinutes: 15,
          stale: false
        },
        invalidatedRecords:
          visibleNodes.filter((node) => node.invalidatedAt).length +
          visibleEvents.filter((event) => event.invalidatedAt).length,
        embeddings: {
          enabled: true,
          healthy: false,
          model: null,
          dimensions: null,
          total: 0,
          memoryNodes: 0,
          memoryEvents: 0,
          messages: 0
        }
      };
    },
    async listLcmGraphNodes(actor, input = {}) {
      return memories
        .filter((memory) => {
          if (!input.includeInvalidated && invalidatedNodes.has(memory.id))
            return false;
          if (input.visibility && memory.visibility !== input.visibility)
            return false;
          if (
            input.query &&
            memory.id !== input.query &&
            !memory.summaryText
              .toLowerCase()
              .includes(input.query.toLowerCase())
          )
            return false;
          if (memory.visibility === "personal")
            return memory.ownerUserId === actor.userId;
          return false;
        })
        .slice(0, input.limit ?? 100)
        .map((memory) => ({
          id: memory.id,
          kind: "leaf" as const,
          depth: 0,
          summaryText: memory.summaryText,
          summaryStatus: summaryCorrections.has(memory.id)
            ? ("summarized" as const)
            : ("pending" as const),
          visibility: memory.visibility,
          ownerUserId: memory.ownerUserId,
          projectId: memory.projectId ?? null,
          projectName: memory.projectName ?? null,
          projectPath: memory.projectPath ?? null,
          sessionId: null,
          threadId: memory.threadId ?? null,
          threadName: memory.threadName ?? null,
          createdAt: memory.createdAt ?? new Date().toISOString(),
          updatedAt: memory.updatedAt ?? new Date().toISOString(),
          invalidatedAt: invalidatedNodes.has(memory.id)
            ? new Date().toISOString()
            : null,
          invalidationReason: invalidatedNodes.has(memory.id)
            ? "user_deleted"
            : null,
          sourceEventCount: nodeSources.get(memory.id)?.length ?? 0,
          sourceTokenEstimate: null,
          summaryTokenEstimate: null,
          summaryModel: summaryCorrections.get(memory.id) ?? null,
          summaryPromptVersion: null,
          summaryStructuredJson: null,
          summaryStructuredSchemaVersion: null,
          lcmAlgorithmVersion: "test-lcm",
          embeddingCount: 0,
          summaryCorrectedAt: summaryCorrections.has(memory.id)
            ? new Date().toISOString()
            : null,
          summaryCorrectedByUserId: summaryCorrections.has(memory.id)
            ? actor.userId
            : null
        }));
    },
    async getLcmGraphNode(actor, nodeId, input = {}) {
      const node = (
        await this.listLcmGraphNodes(actor, {
          includeInvalidated: input.includeInvalidated,
          query: nodeId,
          limit: 1
        })
      ).find((candidate) => candidate.id === nodeId);
      if (!node) return null;
      const sourceIds = nodeSources.get(nodeId) ?? [];
      const sources = (
        await this.listLcmGraphEvents(actor, {
          includeInvalidated: true,
          limit: 500
        })
      ).filter((event) => sourceIds.includes(event.id));
      return {
        ...node,
        sourceItems: sourceIds.map((eventId, position) => ({
          kind: "memory_event" as const,
          sourceTable: "memory_events" as const,
          sourceId: eventId,
          position
        })),
        sources,
        childNodes: [],
        parentNodes: []
      };
    },
    async updateLcmGraphNode(actor, nodeId, input) {
      const memory = await this.getVisibleMemoryNode(actor, nodeId);
      if (!memory) return null;
      if (input.summaryText) {
        memory.summaryText = input.summaryText;
        memory.updatedAt = new Date().toISOString();
        summaryCorrections.set(nodeId, "user-corrected");
      }
      if (input.visibility) memory.visibility = input.visibility;
      return this.getLcmGraphNode(actor, nodeId);
    },
    async invalidateLcmGraphNode(actor, nodeId) {
      return this.deleteMemory(actor, nodeId);
    },
    async listLcmGraphEvents(actor, input = {}) {
      return events
        .filter((event) => {
          if (!input.includeInvalidated && invalidatedEvents.has(event.id))
            return false;
          if (input.visibility && event.visibility !== input.visibility)
            return false;
          if (
            input.query &&
            event.id !== input.query &&
            !event.content.toLowerCase().includes(input.query.toLowerCase())
          )
            return false;
          const projectId = event.workspaceId ?? null;
          const threadId =
            typeof event.metadata.externalSessionId === "string"
              ? event.metadata.externalSessionId
              : event.sessionId;
          if (input.projectId && projectId !== input.projectId) return false;
          if (input.threadId && threadId !== input.threadId) return false;
          if (event.visibility === "personal")
            return event.ownerUserId === actor.userId;
          return false;
        })
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.id.localeCompare(left.id)
        )
        .filter((event) => {
          if (!input.cursorTimestamp) return true;
          return (
            event.createdAt < input.cursorTimestamp ||
            (event.createdAt === input.cursorTimestamp &&
              input.cursorId !== undefined &&
              event.id < input.cursorId)
          );
        })
        .slice(0, input.limit ?? 100)
        .map((event) => {
          const session = event.sessionId
            ? capturedSessions.get(event.sessionId)
            : undefined;
          const threadKind =
            event.metadata.threadKind ?? session?.metadata.threadKind;
          const graphActor =
            threadKind === "subagent" && event.actor === "user"
              ? "agent"
              : threadKind === "subagent" && event.actor === "assistant"
                ? "subagent"
                : event.metadata.transcriptType === "agent_message" &&
                    event.actor === "assistant"
                  ? "agent"
                  : event.actor;
          return {
            id: event.id,
            actor: graphActor,
            eventType: event.eventType,
            sourceRuntime: "codex-cli" as const,
            captureMethod: "hook" as const,
            model: null,
            workspaceId: event.workspaceId,
            projectId: event.workspaceId,
            projectName:
              typeof event.metadata.projectName === "string"
                ? event.metadata.projectName
                : null,
            projectPath:
              typeof event.metadata.projectPath === "string"
                ? event.metadata.projectPath
                : null,
            sessionId: event.sessionId,
            threadId:
              typeof event.metadata.externalSessionId === "string"
                ? event.metadata.externalSessionId
                : event.sessionId,
            threadName:
              typeof event.metadata.threadName === "string"
                ? event.metadata.threadName
                : null,
            timestamp: event.createdAt,
            sourceEventTime: null,
            sourceSequence: null,
            capturedAt: event.createdAt,
            createdAt: event.createdAt,
            visibility: event.visibility,
            invalidatedAt: invalidatedEvents.has(event.id)
              ? new Date().toISOString()
              : null,
            invalidationReason: invalidatedEvents.has(event.id)
              ? "user_deleted"
              : null,
            contentPreview:
              event.content.length > 220
                ? `${event.content.slice(0, 217)}...`
                : event.content,
            ...(input.includeContent ? { content: event.content } : {}),
            ...(input.includeRaw || input.query === event.id
              ? { rawContent: event.content }
              : {}),
            metadata: event.metadata,
            linkedNodeIds: [...nodeSources.entries()]
              .filter(([, ids]) => ids.includes(event.id))
              .map(([nodeId]) => nodeId)
          };
        });
    },
    async listLcmGraphThreads(actor, input = {}) {
      const visibleEvents = await this.listLcmGraphEvents(actor, {
        ...input,
        limit: 500
      });
      const projectMap = new Map<
        string,
        {
          id: string;
          name: string;
          path: string | null;
          eventCount: number;
          threads: Array<{
            id: string;
            name: string;
            sessionId: string | null;
            projectId: string;
            projectName: string;
            eventCount: number;
            invalidatedCount: number;
            latestAt: string;
            sample: string;
            threadKind: "conversation" | "subagent";
            parentThreadId: string | null;
            parentSessionId: string | null;
          }>;
        }
      >();
      const threadMap = new Map<
        string,
        {
          id: string;
          name: string;
          sessionId: string | null;
          projectId: string;
          projectName: string;
          eventCount: number;
          invalidatedCount: number;
          latestAt: string;
          sample: string;
          threadKind: "conversation" | "subagent";
          parentThreadId: string | null;
          parentSessionId: string | null;
        }
      >();

      for (const event of visibleEvents) {
        const projectId =
          event.projectId ??
          event.projectPath ??
          event.workspaceId ??
          "unknown-project";
        const projectName =
          event.projectName ??
          event.projectPath ??
          event.workspaceId ??
          "Unknown project";
        const project = projectMap.get(projectId) ?? {
          id: projectId,
          name: projectName,
          path: event.projectPath,
          eventCount: 0,
          threads: []
        };
        const threadId = event.threadId ?? event.sessionId ?? event.id;
        const threadMapKey = `${projectId}:${threadId}`;
        let thread = threadMap.get(threadMapKey);
        if (!thread) {
          thread = {
            id: threadId,
            name:
              event.threadName ??
              event.threadId ??
              event.sessionId ??
              "Untitled conversation",
            sessionId: event.sessionId,
            projectId,
            projectName,
            eventCount: 0,
            invalidatedCount: 0,
            latestAt: event.timestamp,
            sample: event.contentPreview as string,
            threadKind:
              event.metadata.threadKind === "subagent"
                ? "subagent"
                : "conversation",
            parentThreadId:
              typeof event.metadata.parentThreadId === "string"
                ? event.metadata.parentThreadId
                : null,
            parentSessionId:
              typeof event.metadata.parentSessionId === "string"
                ? event.metadata.parentSessionId
                : null
          };
          threadMap.set(threadMapKey, thread);
          project.threads.push(thread);
        }
        project.eventCount += 1;
        thread.eventCount += 1;
        if (event.invalidatedAt) {
          thread.invalidatedCount += 1;
        }
        if (event.timestamp > thread.latestAt) {
          thread.name =
            event.threadName ??
            event.threadId ??
            event.sessionId ??
            "Untitled conversation";
          thread.projectName = projectName;
          thread.latestAt = event.timestamp;
          thread.sample = event.contentPreview as string;
        }
        projectMap.set(projectId, project);
      }

      for (const session of capturedSessions.values()) {
        if (input.visibility && session.visibility !== input.visibility)
          continue;
        if (
          session.visibility === "personal" &&
          session.ownerUserId !== actor.userId
        )
          continue;
        const projectId =
          (typeof session.metadata.workspaceId === "string"
            ? session.metadata.workspaceId
            : null) ??
          session.workspaceId ??
          session.cwd ??
          "unknown-project";
        const projectName =
          (typeof session.metadata.projectName === "string"
            ? session.metadata.projectName
            : null) ??
          session.workspaceId ??
          session.cwd ??
          "Unknown project";
        const threadId =
          (typeof session.metadata.externalSessionId === "string"
            ? session.metadata.externalSessionId
            : null) ??
          session.externalSessionId ??
          session.id;
        if (input.projectId && projectId !== input.projectId) continue;
        if (input.threadId && threadId !== input.threadId) continue;
        if (
          input.query &&
          session.id !== input.query &&
          !threadId.toLowerCase().includes(input.query.toLowerCase()) &&
          !projectName.toLowerCase().includes(input.query.toLowerCase())
        )
          continue;
        const project = projectMap.get(projectId) ?? {
          id: projectId,
          name: projectName,
          path:
            typeof session.metadata.projectPath === "string"
              ? session.metadata.projectPath
              : session.cwd,
          eventCount: 0,
          threads: []
        };
        const threadMapKey = `${projectId}:${threadId}`;
        if (!threadMap.has(threadMapKey)) {
          const thread = {
            id: threadId,
            name:
              (typeof session.metadata.threadName === "string"
                ? session.metadata.threadName
                : null) ??
              session.externalSessionId ??
              "Untitled conversation",
            sessionId: session.id,
            projectId,
            projectName,
            eventCount: 0,
            invalidatedCount: 0,
            latestAt: session.createdAt,
            sample: "",
            threadKind:
              session.metadata.threadKind === "subagent"
                ? ("subagent" as const)
                : ("conversation" as const),
            parentThreadId:
              typeof session.metadata.parentThreadId === "string"
                ? session.metadata.parentThreadId
                : null,
            parentSessionId:
              typeof session.metadata.parentSessionId === "string"
                ? session.metadata.parentSessionId
                : null
          };
          threadMap.set(threadMapKey, thread);
          project.threads.push(thread);
        }
        projectMap.set(projectId, project);
      }

      const limitedThreads = [...threadMap.values()]
        .sort((left, right) => right.latestAt.localeCompare(left.latestAt))
        .slice(0, input.limit ?? 100);
      const limitedThreadIds = new Set(
        limitedThreads.map((thread) => `${thread.projectId}:${thread.id}`)
      );

      return [...projectMap.values()]
        .map((project) => {
          const threads = project.threads
            .filter((thread) =>
              limitedThreadIds.has(`${thread.projectId}:${thread.id}`)
            )
            .sort((left, right) => right.latestAt.localeCompare(left.latestAt));
          return {
            ...project,
            eventCount: threads.reduce(
              (total, thread) => total + thread.eventCount,
              0
            ),
            threads
          };
        })
        .filter((project) => project.threads.length > 0)
        .sort((left, right) => {
          const leftLatest = left.threads[0]?.latestAt ?? "";
          const rightLatest = right.threads[0]?.latestAt ?? "";
          return rightLatest.localeCompare(leftLatest);
        });
    },
    async getLcmGraphEvent(actor, eventId, input = {}) {
      const event = (
        await this.listLcmGraphEvents(actor, {
          includeInvalidated: input.includeInvalidated,
          query: eventId,
          limit: 1
        })
      ).find((candidate) => candidate.id === eventId);
      return event && input.includeRaw
        ? {
            ...event,
            rawContent:
              events.find((candidate) => candidate.id === eventId)?.content ??
              ""
          }
        : (event ?? null);
    },
    async updateLcmGraphEvent(actor, eventId, input) {
      const event = await this.getLcmGraphEvent(actor, eventId);
      if (!event) return null;
      const raw = events.find((candidate) => candidate.id === eventId);
      if (raw && input.visibility) raw.visibility = input.visibility;
      if (input.invalidated) invalidatedEvents.add(eventId);
      return this.getLcmGraphEvent(actor, eventId, {
        includeInvalidated: Boolean(input.invalidated)
      });
    },
    async invalidateLcmGraphEvent(actor, eventId) {
      const event = await this.getLcmGraphEvent(actor, eventId);
      if (!event) return false;
      invalidatedEvents.add(eventId);
      return true;
    },
    async exportMemoryRecords(actor) {
      const overview = await this.getLcmGraphOverview(actor);
      const nodes = await Promise.all(
        (await this.listLcmGraphNodes(actor, { includeInvalidated: true })).map(
          (node) =>
            this.getLcmGraphNode(actor, node.id, { includeInvalidated: true })
        )
      );
      return {
        exportedAt: new Date().toISOString(),
        overview,
        nodes: nodes.filter((node): node is NonNullable<typeof node> =>
          Boolean(node)
        ),
        events: await this.listLcmGraphEvents(actor, {
          includeInvalidated: true
        })
      };
    },
    async listSourcesNeedingEmbeddings() {
      return [];
    },
    async getEmbeddableSource() {
      return null;
    },
    async getLcmNodeForSummarization() {
      return null;
    },
    async listLcmNodesNeedingSummaries() {
      return [];
    },
    async getVisibleLcmNodeForSummarization() {
      return null;
    },
    async updateLcmNodeSummary() {},
    async upsertSourceEmbedding() {
      return { id: randomUUID(), inserted: true };
    },
    async createMemoryEvent(actor, input) {
      if (input.sessionId) {
        const session = capturedSessions.get(input.sessionId);
        if (!session || session.ownerUserId !== actor.userId) {
          throw new Error("Session not found or not visible");
        }
      }
      const duplicateId =
        (input.idempotencyKey
          ? eventIdempotencyKeys.get(input.idempotencyKey)
          : undefined) ??
        (input.sourceHash
          ? eventSourceHashes.get(input.sourceHash)
          : undefined);
      const duplicate = duplicateId
        ? events.find((event) => event.id === duplicateId)
        : undefined;
      if (duplicate) {
        return duplicate;
      }
      const event: MemoryEventRecord = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        sessionId: input.sessionId ?? null,
        turnId: input.turnId ?? null,
        actor: input.actor as MemoryActor,
        eventType: input.rawEventType,
        content: input.content,
        metadata: input.metadata ?? {},
        visibility: input.visibility,
        ownerUserId: actor.userId,
        createdAt: new Date(Date.now() + events.length).toISOString()
      };
      events.push(event);
      if (input.idempotencyKey) {
        eventIdempotencyKeys.set(input.idempotencyKey, event.id);
      }
      if (input.sourceHash) {
        eventSourceHashes.set(input.sourceHash, event.id);
      }
      return event;
    },
    async searchMemoryNodes(actor, input) {
      const results = memories
        .filter((memory) => {
          if (memory.visibility !== input.scope) {
            return false;
          }
          if (memory.visibility === "personal") {
            return memory.ownerUserId === actor.userId;
          }
          return false;
        })
        .filter((memory) =>
          memory.summaryText.toLowerCase().includes(input.query.toLowerCase())
        )
        .slice(0, input.limit ?? 10)
        .map(
          (memory): MemorySearchResult => ({
            nodeId: memory.id,
            visibility: memory.visibility,
            summaryText: memory.summaryText,
            score: 1,
            citation: { nodeId: memory.id, visibility: memory.visibility }
          })
        );
      return {
        results,
        metadata: {
          retrievalMode: "semantic_vector",
          vectorHitsCount: 0,
          textHitsCount: 0,
          embeddingModel: null,
          embeddingDimensions: null
        }
      };
    },
    async createLcmNodes(actor) {
      const uncompacted = events.filter((event) => {
        const visible = event.ownerUserId === actor.userId;
        return (
          visible &&
          ![...nodeSources.values()].some((sourceIds) =>
            sourceIds.includes(event.id)
          )
        );
      });
      const leafNodeIds = uncompacted.map((event) => {
        const node: MemoryNodeRecord = {
          id: randomUUID(),
          ownerUserId: actor.userId,
          visibility: event.visibility,
          title: null,
          summaryText: event.content,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          pinnedAt: null,
          projectId: event.workspaceId,
          projectName:
            typeof event.metadata.projectName === "string"
              ? event.metadata.projectName
              : null,
          projectPath:
            typeof event.metadata.projectPath === "string"
              ? event.metadata.projectPath
              : event.workspaceId,
          threadId:
            typeof event.metadata.externalSessionId === "string"
              ? event.metadata.externalSessionId
              : event.sessionId,
          threadName:
            typeof event.metadata.threadName === "string"
              ? event.metadata.threadName
              : null
        };
        memories.push(node);
        nodeSources.set(node.id, [event.id]);
        return node.id;
      });
      return { leafNodeIds, rollupNodeId: null };
    },
    async expandMemoryNode(nodeId, actor) {
      const node =
        memories.find((memory) => {
          if (memory.id !== nodeId) {
            return false;
          }
          if (memory.visibility === "personal") {
            return memory.ownerUserId === actor.userId;
          }
          return false;
        }) ?? null;
      if (!node) {
        throw new Error("Memory node not found or not visible");
      }
      return {
        nodeId,
        visibility: node.visibility,
        sourceItems: (nodeSources.get(nodeId) ?? []).map(
          (eventId, position) => ({
            kind: "memory_event",
            sourceTable: "memory_events",
            sourceId: eventId,
            position
          })
        ),
        sources: (nodeSources.get(nodeId) ?? []).map(
          (eventId) => events.find((event) => event.id === eventId)!
        )
      } satisfies ExpandedMemoryNode;
    }
  };
};

describe("api health", () => {
  it("invalidates graph cache for embedding updates without broadcasting them", () => {
    const embeddingPayload = {
      id: randomUUID(),
      operation: "INSERT",
      table: "memory_embeddings"
    } as const;
    const eventPayload = {
      id: randomUUID(),
      operation: "INSERT",
      table: "memory_events"
    } as const;
    const questionPayload = {
      id: randomUUID(),
      operation: "UPDATE",
      table: "memory_questions"
    } as const;

    expect(graphUpdateActionForPayload(embeddingPayload)).toEqual({
      broadcast: false,
      invalidateCache: true
    });
    expect(graphUpdateActionForPayload(eventPayload)).toEqual({
      broadcast: true,
      invalidateCache: true
    });
    expect(graphUpdateActionForPayload(questionPayload)).toEqual({
      broadcast: true,
      invalidateCache: false
    });
    expect(shouldIgnoreGraphStreamPayload(embeddingPayload)).toBe(true);
    expect(shouldIgnoreGraphStreamPayload(eventPayload)).toBe(false);
    expect(shouldIgnoreGraphStreamPayload(questionPayload)).toBe(false);
  });

  it("authorizes graph stream payloads by memory visibility", () => {
    const ownerId = randomUUID();
    const outsiderId = randomUUID();

    expect(
      canReceiveGraphStreamPayload(
        { userId: ownerId },
        {
          table: "memory_events",
          visibility: "personal",
          ownerUserId: ownerId
        }
      )
    ).toBe(true);
    expect(
      canReceiveGraphStreamPayload(
        { userId: outsiderId },
        {
          table: "memory_events",
          visibility: "personal",
          ownerUserId: ownerId
        }
      )
    ).toBe(false);
    expect(
      canReceiveGraphStreamPayload(
        { userId: outsiderId },
        {
          table: "memory_events",
          visibility: "unsupported"
        }
      )
    ).toBe(false);
    expect(
      canReceiveGraphStreamPayload(
        { userId: outsiderId },
        {
          table: "schema_migrations"
        }
      )
    ).toBe(true);
  });

  it("returns OK", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("OK");
  });

  it("returns a request id header and accepts safe caller-provided ids", async () => {
    const app = await buildServer();
    const generated = await app.inject({ method: "GET", url: "/health" });
    const provided = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "operator-request-1" }
    });
    await app.close();

    expect(generated.headers["x-request-id"]).toEqual(expect.any(String));
    expect(provided.headers["x-request-id"]).toBe("operator-request-1");
  });

  it("allows browser write preflight requests", async () => {
    const app = await buildServer();
    const patchResponse = await app.inject({
      method: "OPTIONS",
      url: "/v1/memory/questions/00000000-0000-4000-8000-000000000000",
      headers: {
        origin: "http://localhost:5174",
        "access-control-request-method": "PATCH"
      }
    });
    const putResponse = await app.inject({
      method: "OPTIONS",
      url: "/v1/memory/local-agent-settings/mcp_memory_answer",
      headers: {
        origin: "http://localhost:5174",
        "access-control-request-method": "PUT"
      }
    });
    await app.close();

    expect(patchResponse.statusCode).toBe(204);
    expect(putResponse.statusCode).toBe(204);
    expect(patchResponse.headers["access-control-allow-methods"]).toContain(
      "PATCH"
    );
    expect(putResponse.headers["access-control-allow-methods"]).toContain(
      "PUT"
    );
  });

  it("keeps public status probes coarse and requires auth for details", async () => {
    process.env.KOED_HOST_CHECKOUT_PATH = "/sensitive/local/path";
    const app = await buildServer({ repository: createFakeRepository() });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    const details = await app.inject({ method: "GET", url: "/health/details" });
    const publicStatus = await app.inject({
      method: "GET",
      url: "/self-host/status"
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "status@example.com", password: "password123" }
    });
    const privateStatus = await app.inject({
      method: "GET",
      url: "/self-host/status",
      headers: { cookie: cookieHeader(registered) }
    });
    await app.close();

    expect(ready.statusCode).toBe(200);
    expect(ready.body).not.toContain("test repository");
    expect(details.statusCode).toBe(401);
    expect(publicStatus.statusCode).toBe(200);
    expect(publicStatus.body).toContain("not_disclosed");
    expect(publicStatus.body).not.toContain("/sensitive/local/path");
    expect(privateStatus.statusCode).toBe(200);
    expect(privateStatus.body).not.toContain("/sensitive/local/path");
  });

  it("uses separate memory rate-limit buckets with Retry-After headers", async () => {
    process.env.MEMORY_READ_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.MEMORY_READ_RATE_LIMIT_MAX = "1";
    process.env.MEMORY_WRITE_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.MEMORY_WRITE_RATE_LIMIT_MAX = "2";
    process.env.MEMORY_RECALL_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.MEMORY_RECALL_RATE_LIMIT_MAX = "1";
    const app = await buildServer({ repository: createFakeRepository() });
    const headers = { authorization: "Bearer invalid" };

    const firstRead = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers
    });
    const secondRead = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers
    });
    const firstWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {}
    });
    const firstRecall = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers,
      payload: {}
    });
    const secondRecall = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers,
      payload: {}
    });
    await app.close();

    expect(firstRead.statusCode).not.toBe(429);
    expect(firstRead.headers["x-ratelimit-limit"]).toBe("1");
    expect(firstRead.headers["retry-after"]).toBeUndefined();
    expect(secondRead.statusCode).toBe(429);
    expect(secondRead.headers["retry-after"]).toBeDefined();
    expect(firstWrite.statusCode).not.toBe(429);
    expect(firstWrite.headers["x-ratelimit-limit"]).toBe("2");
    expect(firstRecall.statusCode).not.toBe(429);
    expect(firstRecall.headers["x-ratelimit-limit"]).toBe("1");
    expect(secondRecall.statusCode).toBe(429);
  });

  it("uses injected rate-limit and cache providers", async () => {
    const cacheReads: string[] = [];
    const cacheWrites: string[] = [];
    const rateLimitKeys: string[] = [];
    const app = await buildServer({
      repository: createFakeRepository(),
      rateLimitStore: {
        increment(key, windowMs) {
          rateLimitKeys.push(key);
          return Promise.resolve({
            count: 1,
            resetAt: Date.now() + windowMs
          });
        }
      },
      cacheProvider: {
        getJson<T>(key: string) {
          cacheReads.push(key);
          return Promise.resolve(null as T | null);
        },
        setJson<T>(key: string, value: T) {
          void value;
          cacheWrites.push(key);
          return Promise.resolve();
        },
        deleteByPrefix() {
          return Promise.resolve();
        }
      }
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "cache@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const overview = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/overview",
      headers: { cookie }
    });
    await app.close();

    expect(overview.statusCode).toBe(200);
    expect(rateLimitKeys.some((key) => key.startsWith("memoryRead:"))).toBe(
      true
    );
    expect(
      cacheReads.some((key) => key.startsWith("koed:graph:overview:"))
    ).toBe(true);
    expect(
      cacheWrites.some((key) => key.startsWith("koed:graph:overview:"))
    ).toBe(true);
  });
});

describe("account and access flows", () => {
  it("disables browser session bootstrap by default outside tests", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousLogLevel = process.env.LOG_LEVEL;
    process.env.NODE_ENV = "production";
    process.env.LOG_LEVEL = "silent";
    const app = await buildServer({ repository: createFakeRepository() });
    try {
      const setup = await app.inject({
        method: "POST",
        url: "/auth/setup",
        payload: { email: "setup@example.com", password: "password123" }
      });
      const register = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "register@example.com", password: "password123" }
      });
      const setupStatus = await app.inject({
        method: "GET",
        url: "/auth/setup-status"
      });

      expect(setup.statusCode).toBe(410);
      expect(register.statusCode).toBe(410);
      expect(jsonBody<{ authMode: string }>(setupStatus).authMode).toBe(
        "local_operator_token_bootstrap"
      );
    } finally {
      await app.close();
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousLogLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = previousLogLevel;
      }
    }
  });

  it("registers a solo user without exposing manual memory-node writes", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "solo@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie }
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/memory-nodes",
      headers: { cookie },
      payload: { visibility: "shared", summaryText: "shared memory" }
    });
    await app.close();

    expect(registered.statusCode).toBe(200);
    expect(jsonBody<{ user: { email: string } }>(me).user.email).toBe(
      "solo@example.com"
    );
    expect(rejected.statusCode).toBe(404);
  });

  it("authenticates API requests with bearer tokens", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "token@example.com", password: "password123" }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie: cookieHeader(registered) },
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;
    const authed = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers: { authorization: `Bearer ${token}` }
    });
    await app.close();

    expect(createdToken.statusCode).toBe(200);
    expect(jsonBody<TokenResponse>(createdToken).apiToken.tokenPrefix).toBe(
      token.slice(0, 12)
    );
    expect(authed.statusCode).toBe(200);
    expect(jsonBody<AccessResponse>(authed).ok).toBe(true);
  });

  it("rejects cross-origin browser-session writes without blocking bearer API tokens", async () => {
    process.env.CORS_ORIGINS = "http://console.example.test";

    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "origin@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const rejected = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie, origin: "http://evil.example.test" },
      payload: { name: "Blocked" }
    });
    const allowed = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie, origin: "http://console.example.test" },
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(allowed).token;
    const bearerRequest = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "http://evil.example.test"
      },
      payload: { query: "anything" }
    });
    const mixedCredentialRequest = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: {
        cookie,
        authorization: `Bearer ${token}`,
        origin: "http://evil.example.test"
      },
      payload: { name: "Mixed Credentials" }
    });
    await app.close();

    expect(rejected.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(bearerRequest.statusCode).toBe(200);
    expect(mixedCredentialRequest.statusCode).toBe(403);
  });

  it("rejects cross-origin session-establishing writes", async () => {
    process.env.CORS_ORIGINS = "http://console.example.test";
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";

    const app = await buildServer({ repository: createFakeRepository() });
    const rejectedRegister = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { origin: "http://evil.example.test" },
      payload: { email: "blocked-origin@example.com", password: "password123" }
    });
    const allowedRegister = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { origin: "http://console.example.test" },
      payload: { email: "allowed-origin@example.com", password: "password123" }
    });
    const rejectedLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: "http://evil.example.test" },
      payload: { email: "allowed-origin@example.com", password: "password123" }
    });
    await app.close();

    expect(rejectedRegister.statusCode).toBe(403);
    expect(allowedRegister.statusCode).toBe(200);
    expect(rejectedLogin.statusCode).toBe(403);
  });

  it("does not treat root-level API_CORS_ORIGINS as an API process setting", async () => {
    process.env.CORS_ORIGINS = "http://console.example.test";
    process.env.API_CORS_ORIGINS = "http://legacy.example.test";
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";

    const app = await buildServer({ repository: createFakeRepository() });
    const rejectedRegister = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { origin: "http://legacy.example.test" },
      payload: { email: "legacy-cors@example.com", password: "password123" }
    });
    const allowedRegister = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { origin: "http://console.example.test" },
      payload: { email: "configured-cors@example.com", password: "password123" }
    });
    await app.close();

    expect(rejectedRegister.statusCode).toBe(403);
    expect(allowedRegister.statusCode).toBe(200);
  });

  it("does not grant API-token access to session-only routes", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "console-auth@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const bearerHeaders = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };

    const consoleRequests = await Promise.all([
      app.inject({ method: "GET", url: "/me", headers: bearerHeaders }),
      app.inject({
        method: "GET",
        url: "/api-tokens",
        headers: bearerHeaders
      }),
      app.inject({
        method: "GET",
        url: "/self-host/diagnostics",
        headers: bearerHeaders
      }),
      app.inject({
        method: "GET",
        url: "/health/details",
        headers: bearerHeaders
      }),
      app.inject({
        method: "GET",
        url: "/self-host/status",
        headers: bearerHeaders
      })
    ]);
    const accessCheck = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers: bearerHeaders
    });
    const sessionMe = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie }
    });
    await app.close();

    expect(createdToken.statusCode).toBe(200);
    expect(consoleRequests.map((response) => response.statusCode)).toEqual([
      401, 401, 401, 401, 200
    ]);
    expect(jsonBody<{ redacted: boolean }>(consoleRequests[4]).redacted).toBe(
      true
    );
    expect(accessCheck.statusCode).toBe(200);
    expect(sessionMe.statusCode).toBe(200);
  });

  it("does not expose provider configuration routes", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "provider@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const saved = await app.inject({
      method: "POST",
      url: "/provider-configs",
      headers: { cookie },
      payload: {
        provider: "openai-compatible",
        visibility: "personal",
        apiKey: "sk-test",
        baseUrl: "https://models.example.test/v1",
        embeddingModel: "embed-model",
        summaryModel: "summary-model",
        answerModel: "answer-model",
        embeddingDimensions: 1536,
        enabled: true
      }
    });
    const listed = await app.inject({
      method: "GET",
      url: "/provider-configs",
      headers: { cookie }
    });
    await app.close();

    expect(saved.statusCode).toBe(404);
    expect(listed.statusCode).toBe(404);
  });

  it("supports MCP bearer access checks and rejects cookie auth on v1 endpoints", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "mcp-check@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    expect(createdToken.statusCode).toBe(200);
    const token = jsonBody<TokenResponse>(createdToken).token;
    const rejectedCookie = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers: { cookie }
    });
    const checked = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers: { authorization: `Bearer ${token}` }
    });
    await app.close();

    expect(rejectedCookie.statusCode).toBe(401);
    expect(checked.statusCode).toBe(200);
    expect(jsonBody<AccessResponse>(checked).auth).toBe("bearer_api_token");
  });

  it("captures conversation memory through MCP endpoints", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "mcp-memory@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;
    const headers = { authorization: `Bearer ${token}` };

    const personal = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        actor: "user",
        eventType: "user_prompt",
        content: "Alice prefers concise changelog summaries"
      }
    });
    const search = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers,
      payload: { query: "concise changelog", retrieval_scope: "personal" }
    });
    const answer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers,
      payload: { query: "concise changelog", retrieval_scope: "personal" }
    });
    const rawConversationItems = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers,
      payload: {
        items: [
          {
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalThreadId: "thread-api-test",
            externalTurnId: "turn-api-test",
            sourceRecordType: "app_server_notification",
            sourceEventType: "turn/completed",
            sourceSequence: 0,
            rawJson: { method: "turn/completed" },
            sourceHash: "api-raw-source-hash",
            idempotencyKey: "api-raw-idempotency-key"
          }
        ]
      }
    });
    const tokenUsage = await app.inject({
      method: "POST",
      url: "/v1/memory/token-usage",
      headers,
      payload: {
        workflowType: "memory_question",
        workflowId: "question-api-test",
        answerJobId: "question-api-test",
        sourceReferences: [{ type: "answer_job", id: "question-api-test" }],
        usageSource: "local_estimate",
        usageAccuracy: "local_estimate",
        usageKind: "estimate",
        connectorClient: "codex",
        tokenizerPackage: "js-tiktoken",
        tokenizerEncoding: "o200k_base",
        tokenizerModel: "gpt-5-codex",
        tokenizerExactModelMatch: true,
        tokenizerHeuristicFallback: false,
        tokenizerVersion: "test",
        inputTokens: 4,
        cachedInputTokens: 1,
        outputTokens: 2,
        totalTokens: 6,
        usageScope: "last"
      }
    });
    const tokenUsageRollups = await app.inject({
      method: "GET",
      url: "/v1/memory/token-usage/rollups?group_by=workflow&include_estimates=false",
      headers
    });
    const projection = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items/project",
      headers,
      payload: { limit: 10 }
    });
    const rejectedSharedAnswer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers,
      payload: { query: "concise changelog", retrieval_scope: "shared" }
    });
    const cookieAnswer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers: { cookie },
      payload: { query: "concise changelog", retrieval_scope: "personal" }
    });
    await app.close();

    expect(personal.statusCode).toBe(200);
    expect(jsonBody<CaptureResponse>(personal).event.visibility).toBe(
      "personal"
    );
    expect(search.statusCode).toBe(200);
    expect(jsonBody<SearchResponse>(search).hits).toHaveLength(1);
    expect(answer.statusCode).toBe(200);
    const answerBody = jsonBody<AnswerResponse>(answer);
    expect(answerBody.markdown).toContain("Evidence bundle returned");
    expect(answerBody.evidenceBundle.instructions).toContain(
      "Codex should synthesize"
    );
    expect(answerBody.evidence[0]?.summaryText).toContain("concise changelog");
    expect(answerBody.citations).toHaveLength(1);
    expect(rawConversationItems.statusCode).toBe(200);
    expect(
      jsonBody<{ items: unknown[] }>(rawConversationItems).items
    ).toHaveLength(1);
    expect(tokenUsage.statusCode).toBe(200);
    expect(tokenUsageRollups.statusCode).toBe(200);
    expect(
      jsonBody<{ rollups: Array<{ totalTokens: number }> }>(tokenUsageRollups)
        .rollups[0]?.totalTokens
    ).toBe(6);
    expect(projection.statusCode).toBe(200);
    expect(rejectedSharedAnswer.statusCode).toBe(400);
    expect(cookieAnswer.statusCode).toBe(200);
    expect(
      jsonBody<AnswerResponse>(cookieAnswer).evidence[0]?.summaryText
    ).toContain("concise changelog");
  });

  it("sanitizes storage-unsafe strings before forwarding raw conversation item ingestion", async () => {
    const repository = createFakeRepository();
    const createConversationItems =
      repository.createConversationItems.bind(repository);
    const forwardedInputs: Array<Record<string, unknown>> = [];
    repository.createConversationItems = async (actor, input) => {
      forwardedInputs.push(input as Record<string, unknown>);
      const encodedInput = JSON.stringify(input);
      if (encodedInput.includes("\u0000") || encodedInput.includes("\\u0000")) {
        throw new Error("Repository received unsanitized NUL");
      }
      return createConversationItems(actor, input);
    };
    const app = await buildServer({ repository });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "nul-raw-ingestion@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        items: [
          {
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourcePath: `/tmp/a${"\u0000"}b.jsonl`,
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: `Raw API text a${"\u0000"}b${"\uD800"}c`
                }
              }
            },
            rawText: `Raw text 你好 🚀\nline a${"\u0000"}b`,
            transportChunkText: `Transport text a${"\uDC00"}b`,
            sourceHash: "nul-api-source-hash",
            idempotencyKey: "nul-api-idempotency-key",
            metadata: { label: `metadata a${"\u0000"}b`, valid: "Cafe\u0301" }
          }
        ]
      }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const forwardedItem = (
      forwardedInputs[0]?.items as Array<{
        rawJson: { params: { item: { text: string } } };
        rawText: string;
        transportChunkText: string;
        sourcePath: string;
        metadata: Record<string, unknown>;
      }>
    )?.[0];
    expect(forwardedItem?.rawJson.params.item.text).toBe("Raw API text a�b�c");
    expect(forwardedItem?.rawText).toBe("Raw text 你好 🚀\nline a�b");
    expect(forwardedItem?.transportChunkText).toBe("Transport text a�b");
    expect(forwardedItem?.sourcePath).toBe("/tmp/a�b.jsonl");
    expect(forwardedItem?.metadata).toMatchObject({
      valid: "Cafe\u0301",
      koedSanitization: {
        nulCharacters: {
          replacement: "U+FFFD",
          replacementCount: 4
        },
        malformedUtf16: {
          replacement: "U+FFFD",
          replacementCount: 2
        }
      }
    });
    expect(JSON.stringify(forwardedItem)).not.toContain("\\u0000");
  });

  it("forwards staged retrieval controls through MCP recall endpoints", async () => {
    const repository = createFakeRepository();
    const recallInputs: Array<Record<string, unknown>> = [];
    const originalSearchMemoryNodes =
      repository.searchMemoryNodes.bind(repository);
    repository.searchMemoryNodes = async (actor, input) => {
      recallInputs.push(input as Record<string, unknown>);
      return originalSearchMemoryNodes(actor, input);
    };
    const app = await buildServer({ repository });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "staged-retrieval@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;
    const parentNodeId = randomUUID();

    const search = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        query: "Seraphina",
        retrieval_scope: "personal",
        retrieval_stage: "lexical_search",
        parent_node_ids: [parentNodeId],
        strict_limit: "false",
        limit: 2
      }
    });
    const answer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers: { cookie },
      payload: {
        query: "Seraphina",
        retrieval_scope: "personal",
        retrieval_stage: "score_scan",
        strict_limit: true,
        limit: 1
      }
    });
    await app.close();

    expect(search.statusCode).toBe(200);
    expect(answer.statusCode).toBe(200);
    expect(recallInputs[0]).toMatchObject({
      retrievalStage: "lexical_search",
      parentNodeIds: [parentNodeId],
      strictLimit: false,
      limit: 2
    });
    expect(recallInputs[1]).toMatchObject({
      retrievalStage: "score_scan",
      strictLimit: true,
      limit: 1
    });
  });

  it("rejects unsupported capture policy visibility for API-token setup", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "unsupported-capture@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };

    const unsupportedPolicy = await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers,
      payload: {
        targetType: "global",
        captureState: "enabled",
        visibility: "public"
      }
    });
    await app.close();

    expect(unsupportedPolicy.statusCode).toBe(400);
  });

  it("treats duplicate capture source hashes as idempotent", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "duplicate-capture@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const payload = {
      actor: "user",
      eventType: "user_prompt",
      content: "Duplicate source hash should not create two events",
      sourceHash: "duplicate-source-hash-test"
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload
    });
    const graph = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events?query=Duplicate%20source%20hash&includeInvalidated=false",
      headers
    });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(jsonBody<CaptureResponse>(second).event.id).toBe(
      jsonBody<CaptureResponse>(first).event.id
    );
    expect(jsonBody<GraphEventsResponse>(graph).events).toHaveLength(1);
  });

  it("compacts duplicate captures using the returned event visibility", async () => {
    const repository = createFakeRepository();
    const compactionScopes: Array<{ visibility: Visibility }> = [];
    const originalCreateLcmNodes = repository.createLcmNodes.bind(repository);
    repository.createLcmNodes = async (actor, input) => {
      compactionScopes.push({
        visibility: input.visibility
      });
      return originalCreateLcmNodes(actor, input);
    };
    const app = await buildServer({
      repository,
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "duplicate-capture-scope@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const payload = {
      actor: "user",
      eventType: "user_prompt",
      content: "Duplicate capture scope should follow returned event",
      sourceHash: "duplicate-source-hash-scope-test"
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload
    });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(jsonBody<CaptureResponse>(second).event.visibility).toBe("personal");
    expect(compactionScopes.at(-1)).toEqual({
      visibility: "personal"
    });
  });

  it("resolves capture policy inheritance and skips disabled capture", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "policy@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };

    await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers,
      payload: {
        targetType: "global",
        captureState: "enabled",
        visibility: "personal"
      }
    });
    const global = await app.inject({
      method: "GET",
      url: "/v1/capture-policy/effective?projectId=repo-a",
      headers
    });
    await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers,
      payload: {
        targetType: "project",
        projectId: "repo-a",
        captureState: "disabled"
      }
    });
    const project = await app.inject({
      method: "GET",
      url: "/v1/capture-policy/effective?projectId=repo-a",
      headers
    });
    await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers,
      payload: {
        targetType: "thread",
        projectId: "repo-a",
        threadId: "thread-a",
        captureState: "enabled"
      }
    });
    const thread = await app.inject({
      method: "GET",
      url: "/v1/capture-policy/effective?projectId=repo-a&threadId=thread-a",
      headers
    });
    const skipped = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        workspaceId: "repo-a",
        actor: "user",
        eventType: "user_prompt",
        content: "This disabled capture should not store"
      }
    });
    await app.close();

    expect(jsonBody<PolicyResponse>(global).policy.captureState).toBe(
      "enabled"
    );
    expect(jsonBody<PolicyResponse>(project).policy.captureState).toBe(
      "disabled"
    );
    expect(jsonBody<PolicyResponse>(thread).policy.captureState).toBe(
      "enabled"
    );
    expect(jsonBody<Record<string, unknown>>(skipped)).toMatchObject({
      skipped: true,
      reason: "capture_disabled"
    });
  });

  it("stores provenance and presents memories as browsable clusters", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "browser@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const captured = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        workspaceId: "/repo/sports",
        actor: "user",
        eventType: "user_prompt",
        content: "Jacobo likes football",
        metadata: {
          projectName: "Sports Repo",
          projectPath: "/repo/sports",
          externalSessionId: "thread-sports",
          threadName: "Sports chat"
        }
      }
    });
    const nodeId =
      jsonBody<CaptureResponse>(captured).compaction?.leafNodeIds[0];
    await app.inject({
      method: "PATCH",
      url: `/v1/memory/nodes/${nodeId}`,
      headers: { cookie },
      payload: { pinned: true }
    });
    const clusters = await app.inject({
      method: "GET",
      url: "/v1/memory/clusters",
      headers: { cookie }
    });
    const items = await app.inject({
      method: "GET",
      url: "/v1/memory/items?pinned=true",
      headers: { cookie }
    });
    await app.close();

    expect(jsonBody<CaptureResponse>(captured).event.metadata.projectName).toBe(
      "Sports Repo"
    );
    expect(jsonBody<ClusterResponse>(clusters).clusters[0]).toMatchObject({
      label: "Sports"
    });
    const pinnedMemory = jsonBody<MemoryItemsResponse>(items).memories[0];
    expect(pinnedMemory).toMatchObject({
      text: "Jacobo likes football",
      projectName: "Sports Repo",
      threadName: "Sports chat"
    });
    expect(typeof pinnedMemory?.pinnedAt).toBe("string");
    expect(clusters.headers.deprecation).toBe("true");
  });

  it("browses and governs LCM graph records without curated memory endpoints", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "graph@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const captured = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        workspaceId: "repo-graph",
        actor: "user",
        eventType: "user_prompt",
        content: "Graph browser source record",
        metadata: {
          projectName: "Graph Repo",
          externalSessionId: "thread-graph",
          threadName: "Graph thread"
        }
      }
    });
    const capturedBody = jsonBody<CaptureResponse>(captured);
    const eventId = capturedBody.event.id;
    const nodeId = capturedBody.compaction?.leafNodeIds[0];
    const overview = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/overview",
      headers: { cookie }
    });
    const nodes = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/nodes",
      headers: { cookie }
    });
    const nodeDetail = await app.inject({
      method: "GET",
      url: `/v1/memory/graph/nodes/${nodeId}`,
      headers: { cookie }
    });
    const nodeBatch = await app.inject({
      method: "GET",
      url: `/v1/memory/graph/nodes?ids=${nodeId}`,
      headers: { cookie }
    });
    const corrected = await app.inject({
      method: "PATCH",
      url: `/v1/memory/nodes/${nodeId}`,
      headers: { cookie },
      payload: { summaryText: "Corrected graph browser summary" }
    });
    const events = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events",
      headers: { cookie }
    });
    const rawEvent = await app.inject({
      method: "GET",
      url: `/v1/memory/graph/events/${eventId}?includeRaw=true`,
      headers: { cookie }
    });
    const deletedEvent = await app.inject({
      method: "DELETE",
      url: `/v1/memory/graph/events/${eventId}`,
      headers: { cookie }
    });
    const activeEvents = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events",
      headers: { cookie }
    });
    const deletedNode = await app.inject({
      method: "DELETE",
      url: `/v1/memory/nodes/${nodeId}`,
      headers: { cookie }
    });
    const activeNodes = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/nodes",
      headers: { cookie }
    });
    const exported = await app.inject({
      method: "GET",
      url: "/v1/memory/export",
      headers: { cookie }
    });
    await app.close();

    expect(jsonBody<GraphOverviewResponse>(overview).overview).toMatchObject({
      capturedEvents: 1,
      leafNodes: 1,
      rollupNodes: 0,
      pendingSummaries: 1
    });
    expect(jsonBody<GraphNodesResponse>(nodes).nodes[0]).toMatchObject({
      id: nodeId,
      projectName: "Graph Repo",
      threadName: "Graph thread",
      visibility: "personal"
    });
    expect(jsonBody<GraphNodesResponse>(nodeBatch).nodes).toHaveLength(1);
    expect(jsonBody<GraphNodesResponse>(nodeBatch).nodes[0]).toMatchObject({
      id: nodeId
    });
    expect(
      jsonBody<GraphNodeResponse>(nodeDetail).node.sources[0]
    ).toMatchObject({
      id: eventId,
      contentPreview: "Graph browser source record"
    });
    const correctedNode = jsonBody<GraphNodeResponse>(corrected).node;
    expect(correctedNode).toMatchObject({
      summaryText: "Corrected graph browser summary"
    });
    expect(typeof correctedNode.summaryCorrectedByUserId).toBe("string");
    expect(jsonBody<GraphEventsResponse>(events).events[0]).toMatchObject({
      id: eventId,
      linkedNodeIds: [nodeId]
    });
    expect(jsonBody<GraphEventResponse>(rawEvent).event.rawContent).toBe(
      "Graph browser source record"
    );
    expect(deletedEvent.statusCode).toBe(200);
    expect(jsonBody<GraphEventsResponse>(activeEvents).events).toHaveLength(0);
    expect(deletedNode.statusCode).toBe(200);
    expect(jsonBody<GraphNodesResponse>(activeNodes).nodes).toHaveLength(0);
    expect(jsonBody<MemoryExportResponse>(exported).nodes[0]).toMatchObject({
      id: nodeId,
      invalidationReason: "user_deleted"
    });
  });

  it("serves a lightweight graph thread index without raw event rows", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "thread-index@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };

    const firstThreadEvent = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        workspaceId: "repo-index-a",
        actor: "user",
        eventType: "user_prompt",
        content:
          "First conversation event with details that should stay out of raw rows",
        metadata: {
          projectName: "Index Repo A",
          projectPath: "/work/repo-index-a",
          externalSessionId: "thread-index-a",
          threadName: "Index conversation A"
        }
      }
    });
    await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        workspaceId: "repo-index-a",
        actor: "assistant",
        eventType: "assistant_response",
        content: "Renamed conversation event preview",
        metadata: {
          projectName: "Renamed Index Repo A",
          projectPath: "/work/renamed-repo-index-a",
          externalSessionId: "thread-index-a",
          threadName: "Renamed index conversation A"
        }
      }
    });
    await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        workspaceId: "repo-index-b",
        actor: "user",
        eventType: "user_prompt",
        content: "Another project conversation preview",
        metadata: {
          projectName: "Index Repo B",
          externalSessionId: "thread-index-b",
          threadName: "Index conversation B"
        }
      }
    });

    const activeIndex = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?limit=100&includeInvalidated=false",
      headers: { cookie }
    });
    const limitedIndex = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?limit=1&includeInvalidated=false",
      headers: { cookie }
    });
    const firstEventPage = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events?threadId=thread-index-a&limit=1&includeInvalidated=false",
      headers: { cookie }
    });
    const firstCursorEvent = jsonBody<GraphEventsResponse>(firstEventPage)
      .events[0] as { id: string; timestamp: string };
    const secondEventPage = await app.inject({
      method: "GET",
      url: `/v1/memory/graph/events?threadId=thread-index-a&limit=1&cursorTimestamp=${encodeURIComponent(firstCursorEvent.timestamp)}&cursorId=${encodeURIComponent(firstCursorEvent.id)}&includeInvalidated=false`,
      headers: { cookie }
    });
    const invalidCursorPage = await app.inject({
      method: "GET",
      url: `/v1/memory/graph/events?threadId=thread-index-a&limit=1&cursorTimestamp=${encodeURIComponent(firstCursorEvent.timestamp)}&includeInvalidated=false`,
      headers: { cookie }
    });
    await app.inject({
      method: "DELETE",
      url: `/v1/memory/graph/events/${jsonBody<CaptureResponse>(firstThreadEvent).event.id}`,
      headers: { cookie }
    });
    const activeAfterDelete = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?includeInvalidated=false",
      headers: { cookie }
    });
    const includingInvalidated = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?includeInvalidated=true",
      headers: { cookie }
    });
    const selectedThreadEvents = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events?threadId=thread-index-a&limit=250&includeInvalidated=false",
      headers: { cookie }
    });
    await app.close();

    const active = jsonBody<GraphThreadIndexResponse>(activeIndex);
    const indexA = active.projects
      .flatMap((project) => project.threads)
      .find((thread) => thread.id === "thread-index-a");
    expect(indexA).toMatchObject({
      name: "Renamed index conversation A",
      projectId: "repo-index-a",
      projectName: "Renamed Index Repo A",
      eventCount: 2,
      invalidatedCount: 0,
      sample: "Renamed conversation event preview"
    });
    const projectA = active.projects.find(
      (project) => project.id === "repo-index-a"
    );
    expect(projectA).toMatchObject({
      name: "Renamed Index Repo A",
      path: "/work/renamed-repo-index-a",
      eventCount: 2
    });
    expect(indexA).not.toHaveProperty("rawContent");
    expect(indexA).not.toHaveProperty("contentPreview");
    expect(indexA).not.toHaveProperty("metadata");
    expect(
      jsonBody<GraphThreadIndexResponse>(limitedIndex).projects
    ).toHaveLength(1);
    expect(
      jsonBody<GraphThreadIndexResponse>(limitedIndex).projects.flatMap(
        (project) => project.threads
      )
    ).toHaveLength(1);
    expect(jsonBody<GraphEventsResponse>(secondEventPage).events).toHaveLength(
      1
    );
    expect(
      (
        jsonBody<GraphEventsResponse>(secondEventPage).events[0] as {
          id: string;
        }
      ).id
    ).not.toBe(firstCursorEvent.id);
    expect(invalidCursorPage.statusCode).toBe(400);
    expect(
      jsonBody<GraphThreadIndexResponse>(activeAfterDelete)
        .projects.flatMap((project) => project.threads)
        .find((thread) => thread.id === "thread-index-a")
    ).toMatchObject({ eventCount: 1, invalidatedCount: 0 });
    expect(
      jsonBody<GraphThreadIndexResponse>(includingInvalidated)
        .projects.flatMap((project) => project.threads)
        .find((thread) => thread.id === "thread-index-a")
    ).toMatchObject({ eventCount: 2, invalidatedCount: 1 });
    expect(
      jsonBody<GraphEventsResponse>(selectedThreadEvents).events
    ).toHaveLength(1);
  });

  it("renames captured session titles in the graph thread index", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "session-title@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        externalSessionId: "thread-title-a",
        cwd: "/work/title-repo",
        metadata: {
          projectName: "Title Repo",
          threadName: "thread-title-a"
        }
      }
    });
    const session = jsonBody<SessionResponse>(sessionResponse).session;
    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/memory/graph/sessions/${session.id}/title`,
      headers: { cookie },
      payload: { title: "Redis Projection Followup" }
    });
    const threads = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?includeInvalidated=false",
      headers: { cookie }
    });
    await app.close();

    expect(renamed.statusCode).toBe(200);
    expect(jsonBody<SessionResponse>(renamed).session).toMatchObject({
      id: session.id
    });
    expect(
      jsonBody<GraphThreadIndexResponse>(threads)
        .projects.flatMap((project) => project.threads)
        .find((thread) => thread.sessionId === session.id)
    ).toMatchObject({
      id: "thread-title-a",
      name: "Redis Projection Followup"
    });
  });

  it("lists and accepts local generated session titles", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "generated-session-title@example.com",
        password: "password123"
      }
    });
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie: cookieHeader(registered) },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        externalSessionId: "thread-generated-title",
        cwd: "/work/title-repo",
        metadata: { threadName: "thread-generated-title" }
      }
    });
    const session = jsonBody<SessionResponse>(sessionResponse).session;
    for (const content of [
      "Can we add early generated titles for history browser chats?",
      "Can those generated titles avoid waiting for LCM summaries?",
      "Please make manual renames keep winning over generated names."
    ]) {
      await app.inject({
        method: "POST",
        url: `/v1/sessions/${session.id}/events`,
        headers,
        payload: {
          actor: "user",
          eventType: "user_prompt",
          content,
          metadata: {}
        }
      });
    }

    const pending = await app.inject({
      method: "GET",
      url: "/v1/memory/session-titles/pending?min_user_events=3",
      headers
    });
    const submitted = await app.inject({
      method: "POST",
      url: `/v1/memory/session-titles/${session.id}`,
      headers,
      payload: {
        title: "History Browser Titles",
        titleModel: "codex-app-server:test",
        titlePromptVersion: "session-title-codex-json-v1"
      }
    });
    const pendingAfterSubmit = await app.inject({
      method: "GET",
      url: "/v1/memory/session-titles/pending?min_user_events=3",
      headers
    });
    await app.close();

    expect(pending.statusCode).toBe(200);
    expect(
      jsonBody<{ sessions: Array<{ id: string }> }>(pending).sessions
    ).toEqual([expect.objectContaining({ id: session.id })]);
    expect(submitted.statusCode).toBe(200);
    expect(jsonBody<{ title: string }>(submitted).title).toBe(
      "History Browser Titles"
    );
    expect(
      jsonBody<{ sessions: Array<{ id: string }> }>(pendingAfterSubmit).sessions
    ).toHaveLength(0);
  });

  it("keeps captured session shells for child threads and exposes parent linkage", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "child-thread-shell@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };

    await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        externalSessionId: "parent-thread",
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        cwd: "/work/koed",
        idempotencyKey: "parent-thread-key",
        metadata: {
          externalSessionId: "parent-thread",
          threadName: "Parent conversation",
          projectName: "Koed",
          projectPath: "/work/koed",
          threadKind: "conversation"
        }
      }
    });
    await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        externalSessionId: "child-thread",
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        cwd: "/work/koed",
        idempotencyKey: "child-thread-key",
        metadata: {
          externalSessionId: "child-thread",
          threadName: "Capture reviewer",
          projectName: "Koed",
          projectPath: "/work/koed",
          threadKind: "subagent",
          parentThreadId: "parent-thread",
          parentSessionId: "parent-session"
        }
      }
    });

    const threadIndex = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?includeInvalidated=false",
      headers: { cookie }
    });
    await app.close();

    const threads = jsonBody<GraphThreadIndexResponse>(
      threadIndex
    ).projects.flatMap((project) => project.threads);
    expect(
      threads.find((thread) => thread.id === "child-thread")
    ).toMatchObject({
      name: "Capture reviewer",
      eventCount: 0,
      threadKind: "subagent",
      parentThreadId: "parent-thread",
      parentSessionId: "parent-session"
    });
    expect(
      threads.find((thread) => thread.id === "parent-thread")
    ).toMatchObject({
      name: "Parent conversation",
      threadKind: "conversation"
    });
  });

  it("preserves explicit subagent display actors in graph events", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "subagent-display-actors@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const metadata = {
      externalSessionId: "child-thread",
      threadKind: "subagent",
      parentThreadId: "parent-thread",
      transcriptType: "agent_message"
    };

    for (const event of [
      {
        actor: "agent",
        content: "Parent agent prompt to child"
      },
      {
        actor: "subagent",
        content: "Child subagent reply"
      },
      {
        actor: "user",
        content: "Legacy parent prompt"
      },
      {
        actor: "assistant",
        content: "Legacy child reply"
      }
    ] as const) {
      await app.inject({
        method: "POST",
        url: "/v1/memory/capture-personal-event",
        headers,
        payload: {
          workspaceId: "repo-subagent",
          actor: event.actor,
          eventType: "codex_transcript_agent",
          content: event.content,
          metadata
        }
      });
    }

    const events = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events?threadId=child-thread&includeContent=true",
      headers: { cookie }
    });
    await app.close();

    const actorsByContent = jsonBody<GraphEventsResponse>(events).events.reduce<
      Record<string, MemoryActor>
    >((result, event) => {
      if (event.content) {
        result[event.content] = event.actor;
      }
      return result;
    }, {});
    expect(actorsByContent).toMatchObject({
      "Parent agent prompt to child": "agent",
      "Child subagent reply": "subagent",
      "Legacy parent prompt": "agent",
      "Legacy child reply": "subagent"
    });
  });

  it("returns full event content from the list endpoint without raw content", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "graph-include-content@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const fullContent = `${"Expanded content. ".repeat(20)}Tail marker.`;

    await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        workspaceId: "repo-content",
        actor: "agent",
        eventType: "codex_transcript_agent",
        content: fullContent,
        metadata: {
          externalSessionId: "thread-content",
          transcriptType: "agent_message"
        }
      }
    });

    const events = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events?threadId=thread-content&includeContent=true&includeRaw=false",
      headers: { cookie }
    });
    await app.close();

    const event = jsonBody<GraphEventsResponse>(events).events[0];
    expect(event).toMatchObject({
      actor: "agent",
      content: fullContent
    });
    expect(event?.contentPreview).not.toBe(fullContent);
    expect(event).not.toHaveProperty("rawContent");
  });

  it("returns evidence for memory_answer without backend provider configuration", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "no-provider-answer@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    expect(createdToken.statusCode).toBe(200);
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        actor: "user",
        eventType: "user_prompt",
        content: "No provider answer marker"
      }
    });
    const answer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers,
      payload: { query: "provider answer marker", retrieval_scope: "personal" }
    });
    await app.close();

    expect(answer.statusCode).toBe(200);
    const body = jsonBody<AnswerResponse>(answer);
    expect(body.evidence[0]?.summaryText).toContain("No provider answer");
  });

  it("does not compact captured conversation events on the API hot path by default", async () => {
    const repository = createFakeRepository();
    let compactionCalls = 0;
    const originalCreateLcmNodes = repository.createLcmNodes.bind(repository);
    repository.createLcmNodes = async (...args) => {
      compactionCalls += 1;
      return originalCreateLcmNodes(...args);
    };
    const app = await buildServer({ repository });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "async-write@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers: {
        authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
      },
      payload: {
        actor: "user",
        eventType: "user_prompt",
        content: "Async processing marker"
      }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(compactionCalls).toBe(0);
    const body = jsonBody<CaptureResponse>(response);
    expect(body.compaction).toBeUndefined();
    if (!body.processing) {
      throw new Error("Expected async processing metadata");
    }
    expect(body.processing.compaction.inline).toBe(false);
  });

  it("reports provider configuration as unsupported for API-token access checks", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "server-synthesis-opt-in@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie: cookieHeader(registered) },
      payload: { name: "Client Integration" }
    });
    const access = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers: {
        authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
      }
    });
    await app.close();

    expect(access.statusCode).toBe(200);
    const body = jsonBody<AccessResponse>(access);
    expect(body.providerConfigSupported).toBe(false);
  });

  it("persists memory questions and exposes shell and detail records", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "memory-question@example.com", password: "password123" }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie: cookieHeader(registered) },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/memory/questions",
      headers,
      payload: {
        query: "What did we decide about rate limits?",
        search_domain: "project",
        workspace_id: "project-1",
        project_name: "Koed",
        thread_id: "thread-1",
        thread_name: "Explorer",
        local_memory_worker_config: {
          provider: "codex",
          model: "gpt-5.4",
          reasoning_effort: "medium",
          timeout_ms: 150000,
          max_attempts: 4
        }
      }
    });
    const questionId = jsonBody<MemoryQuestionResponse>(created).question.id;
    const claimed = await app.inject({
      method: "POST",
      url: "/v1/memory/questions/claim-pending",
      headers,
      payload: { question_id: questionId, limit: 1, lease_seconds: 120 }
    });
    const secondClaim = await app.inject({
      method: "POST",
      url: "/v1/memory/questions/claim-pending",
      headers,
      payload: { question_id: questionId, limit: 1, lease_seconds: 120 }
    });
    const pending = await app.inject({
      method: "GET",
      url: "/v1/memory/questions?status=pending",
      headers
    });
    const answered = await app.inject({
      method: "PATCH",
      url: `/v1/memory/questions/${questionId}`,
      headers,
      payload: {
        status: "answered",
        attempt_count:
          jsonBody<MemoryQuestionsResponse>(claimed).questions[0]!.attemptCount,
        answer_markdown: "Use the documented read and write limits.",
        evidence: [{ id: "evidence-1" }],
        citations: [{ id: "citation-1" }],
        retrieval: { searchDomain: "project" },
        local_memory_worker: { status: "ok" },
        response: { markdown: "Use the documented read and write limits." }
      }
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/memory/questions?search_domain=project&workspace_id=project-1",
      headers
    });
    const detail = await app.inject({
      method: "GET",
      url: `/v1/memory/questions/${questionId}`,
      headers
    });
    await app.close();

    expect(created.statusCode).toBe(200);
    expect(jsonBody<MemoryQuestionResponse>(created).question.status).toBe(
      "pending"
    );
    expect(
      jsonBody<MemoryQuestionResponse>(created).question.retrievalScope
    ).toBe("personal");
    expect(
      jsonBody<MemoryQuestionResponse>(created).question.localMemoryWorkerConfig
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      reasoning_effort: "medium",
      timeout_ms: 150000,
      max_attempts: 4
    });
    expect(claimed.statusCode).toBe(200);
    expect(jsonBody<MemoryQuestionsResponse>(claimed).questions).toHaveLength(
      1
    );
    expect(
      jsonBody<MemoryQuestionsResponse>(claimed).questions[0]?.attemptCount
    ).toBe(1);
    expect(jsonBody<MemoryQuestionsResponse>(secondClaim).questions).toEqual(
      []
    );
    expect(jsonBody<MemoryQuestionsResponse>(pending).questions).toHaveLength(
      1
    );
    expect(answered.statusCode).toBe(200);
    expect(jsonBody<MemoryQuestionResponse>(answered).question.status).toBe(
      "answered"
    );
    expect(jsonBody<MemoryQuestionsResponse>(listed).questions).toHaveLength(1);
    expect(jsonBody<MemoryQuestionResponse>(detail).question).toMatchObject({
      id: questionId,
      answerMarkdown: "Use the documented read and write limits.",
      evidenceCount: 1,
      localMemoryWorkerConfig: {
        provider: "codex",
        model: "gpt-5.4",
        reasoning_effort: "medium",
        timeout_ms: 150000,
        max_attempts: 4
      },
      searchDomain: "project",
      workspaceId: "project-1"
    });
  });

  it("releases failed memory questions back to pending for retry", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "memory-question-retry@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie: cookieHeader(registered) },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/memory/questions",
      headers,
      payload: {
        query: "What should retry?",
        search_domain: "global"
      }
    });
    const questionId = jsonBody<MemoryQuestionResponse>(created).question.id;
    const claimed = await app.inject({
      method: "POST",
      url: "/v1/memory/questions/claim-pending",
      headers,
      payload: { question_id: questionId, limit: 1, lease_seconds: 120 }
    });
    const released = await app.inject({
      method: "PATCH",
      url: `/v1/memory/questions/${questionId}`,
      headers,
      payload: {
        status: "pending",
        attempt_count:
          jsonBody<MemoryQuestionsResponse>(claimed).questions[0]!.attemptCount,
        last_error_message: "Codex unavailable",
        response: { markdown: "raw fallback must not become the answer" },
        retrieval: { mode: "test" },
        local_memory_worker: {
          usedFallback: true,
          skippedReason: "codex_failed"
        }
      }
    });
    const reclaimed = await app.inject({
      method: "POST",
      url: "/v1/memory/questions/claim-pending",
      headers,
      payload: { question_id: questionId, limit: 1, lease_seconds: 120 }
    });
    await app.close();

    expect(released.statusCode).toBe(200);
    expect(jsonBody<MemoryQuestionResponse>(released).question).toMatchObject({
      id: questionId,
      status: "pending",
      answerMarkdown: null,
      errorMessage: null,
      lastErrorMessage: "Codex unavailable"
    });
    expect(
      jsonBody<MemoryQuestionResponse>(released).question.answerPreview
    ).toBeNull();
    expect(
      jsonBody<MemoryQuestionsResponse>(reclaimed).questions[0]
    ).toMatchObject({
      id: questionId,
      status: "pending",
      attemptCount:
        jsonBody<MemoryQuestionsResponse>(claimed).questions[0]!.attemptCount +
        1,
      lastErrorMessage: null
    });
  });

  it("persists local memory agent settings through API tokens", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "local-agent-settings@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie: cookieHeader(registered) },
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };

    const savedMcp = await app.inject({
      method: "PUT",
      url: "/v1/memory/local-agent-settings/mcp_memory_answer",
      headers,
      payload: {
        provider: "codex",
        model: "gpt-5.4",
        reasoning_effort: "high",
        timeout_ms: 180000,
        max_attempts: 3
      }
    });
    const savedLcm = await app.inject({
      method: "PUT",
      url: "/v1/memory/local-agent-settings/lcm_summary",
      headers,
      payload: {
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoning_effort: "medium",
        timeout_ms: 120000,
        max_attempts: 2
      }
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/memory/local-agent-settings",
      headers
    });
    await app.close();

    expect(savedMcp.statusCode).toBe(200);
    expect(savedLcm.statusCode).toBe(200);
    expect(listed.statusCode).toBe(200);
    expect(
      jsonBody<{ settings: LocalMemoryAgentSettingRecord[] }>(listed).settings
    ).toEqual([
      expect.objectContaining({
        flowKey: "lcm_summary",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium"
      }),
      expect.objectContaining({
        flowKey: "mcp_memory_answer",
        model: "gpt-5.4",
        reasoningEffort: "high"
      })
    ]);
  });

  it("rejects unsupported retrieval scope for persisted questions", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "memory-question-scope@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie: cookieHeader(registered) },
      payload: { name: "Client Integration" }
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/memory/questions",
      headers: {
        authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
      },
      payload: {
        query: "What did we decide about memory?",
        retrieval_scope: "shared"
      }
    });
    await app.close();

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({
      error: "Invalid request payload"
    });
  });

  it("creates MCP sessions, captures session events, exposes nodes, and serves OpenAPI JSON", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "mcp-session@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie },
      payload: { name: "Client Integration" }
    });
    expect(createdToken.statusCode).toBe(200);
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const session = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        externalSessionId: "codex-session-1",
        model: "gpt-5.5",
        cwd: "/tmp/project"
      }
    });
    expect(session.statusCode).toBe(200);
    const sessionId = jsonBody<SessionResponse>(session).session.id;
    const event = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/events`,
      headers,
      payload: {
        actor: "assistant",
        eventType: "message",
        content: "Session event memory marker"
      }
    });
    const nodeId = jsonBody<CaptureResponse>(event).compaction?.leafNodeIds[0];
    const node = await app.inject({
      method: "GET",
      url: `/v1/memory/nodes/${nodeId}`,
      headers
    });
    const expanded = await app.inject({
      method: "GET",
      url: `/v1/memory/nodes/${nodeId}/expand`,
      headers
    });
    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    await app.close();

    expect(session.statusCode).toBe(200);
    expect(event.statusCode).toBe(200);
    expect(node.statusCode).toBe(200);
    expect(
      jsonBody<ExpandedResponse>(expanded).expanded.sources[0]?.content
    ).toBe("Session event memory marker");
    expect(
      jsonBody<OpenApiResponse>(openapi).paths["/v1/memory/answer"]
    ).toBeDefined();
  });
});

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
  CreateTeamInput,
  CreateUserInput,
  MemoryQuestionDetailRecord,
  MemoryNodeRecord,
  MemorySourceRepository,
  TeamMemberRecord,
  TeamRecord,
  UserRecord,
  Visibility
} from "@koed/db";
import {
  buildServer,
  graphUpdateActionForPayload,
  shouldIgnoreGraphStreamPayload
} from "./server.js";

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
    "GRAPH_CACHE_TTL_SECONDS"
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

type TeamResponse = {
  team: { name: string; inviteCode: string };
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
  const teams = new Map<
    string,
    TeamRecord & { members: Map<string, "owner" | "admin" | "member"> }
  >();
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

  const getMembership = (userId: string, teamId: string) =>
    teams.get(teamId)?.members.get(userId);

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
    async createTeam(input: CreateTeamInput) {
      const id = randomUUID();
      teams.set(id, {
        id,
        name: input.name,
        inviteCode: input.inviteCode ?? "INVITE",
        role: "owner",
        members: new Map([[input.createdByUserId, "owner"]])
      });
      return { id };
    },
    async addTeamMember(teamId: string, userId: string, role = "member") {
      teams.get(teamId)?.members.set(userId, role);
    },
    async joinTeamByInviteCode(userId: string, inviteCode: string) {
      const team = [...teams.values()].find(
        (candidate) => candidate.inviteCode === inviteCode
      );
      if (!team) {
        throw new Error("Invalid invite code");
      }
      team.members.set(userId, "member");
      return {
        id: team.id,
        name: team.name,
        inviteCode: team.inviteCode,
        role: "member"
      };
    },
    async getCurrentTeam(userId: string) {
      const team = [...teams.values()].find((candidate) =>
        candidate.members.has(userId)
      );
      if (!team) {
        return null;
      }
      return {
        id: team.id,
        name: team.name,
        inviteCode: team.inviteCode,
        role: team.members.get(userId)
      };
    },
    async listTeamMembers(userId: string, teamId: string) {
      if (!getMembership(userId, teamId)) {
        throw new Error("User is not an active member of the requested team");
      }
      const team = teams.get(teamId);
      if (!team) {
        return [];
      }
      return [...team.members.entries()].flatMap<TeamMemberRecord>(
        ([memberUserId, role]) => {
          const member = users.get(memberUserId);
          return member
            ? [
                {
                  userId: member.id,
                  email: member.email,
                  displayName: member.displayName,
                  role,
                  joinedAt: new Date().toISOString()
                }
              ]
            : [];
        }
      );
    },
    async createApiToken(input) {
      if (input.teamId && !getMembership(input.ownerUserId, input.teamId)) {
        throw new Error("User is not an active member of the requested team");
      }
      const id = randomUUID();
      const record = {
        id,
        ownerUserId: input.ownerUserId,
        teamId: input.teamId ?? null,
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
        teamId: null,
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
    async createMemoryQuestion(actor, input) {
      const now = new Date().toISOString();
      const record: MemoryQuestionDetailRecord = {
        id: randomUUID(),
        ownerUserId: actor.userId,
        teamId: null,
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
      const answeredAt = new Date().toISOString();
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
              answeredAt,
              updatedAt: answeredAt,
              processingLeaseUntil: null,
              lastErrorMessage: null
            }
          : {
              ...question,
              status: "error",
              answerMarkdown: null,
              answerPreview: null,
              errorMessage: input.errorMessage,
              response: input.response ?? question.response,
              retrieval: input.retrieval ?? question.retrieval,
              localMemoryWorker:
                input.localMemoryWorker ?? question.localMemoryWorker,
              answeredAt,
              updatedAt: answeredAt,
              processingLeaseUntil: null,
              lastErrorMessage: input.errorMessage
            };
      memoryQuestions.set(questionId, updated);
      return updated;
    },
    async createMemoryNode(actor: ActorContext, input: CreateMemoryNodeInput) {
      if (input.visibility === "team") {
        if (!input.teamId) {
          throw new Error("Team visibility requires a teamId");
        }
        if (!getMembership(actor.userId, input.teamId)) {
          throw new Error("User is not an active member of the requested team");
        }
      }
      const record: MemoryNodeRecord = {
        id: randomUUID(),
        ownerUserId: input.visibility === "personal" ? actor.userId : null,
        teamId: input.visibility === "team" ? input.teamId! : null,
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
          return Boolean(
            memory.teamId && getMembership(actor.userId, memory.teamId)
          );
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
        return Boolean(
          memory.teamId && getMembership(actor.userId, memory.teamId)
        );
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
          return Boolean(
            memory.teamId && getMembership(actor.userId, memory.teamId)
          );
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
          return Boolean(
            memory.teamId && getMembership(actor.userId, memory.teamId)
          );
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
          teamId: memory.teamId,
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
          return Boolean(
            event.teamId && getMembership(actor.userId, event.teamId)
          );
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
        if (
          session.visibility === "team" &&
          (!session.teamId || !getMembership(actor.userId, session.teamId))
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
      if (input.visibility === "team") {
        if (!input.teamId) {
          throw new Error("Team visibility requires a teamId");
        }
        if (!getMembership(actor.userId, input.teamId)) {
          throw new Error("User is not an active member of the requested team");
        }
      }
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
        ownerUserId: input.visibility === "personal" ? actor.userId : null,
        teamId: input.visibility === "team" ? input.teamId! : null,
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
          if (
            input.scope !== "personal_and_team" &&
            memory.visibility !== input.scope
          ) {
            return false;
          }
          if (memory.visibility === "personal") {
            return memory.ownerUserId === actor.userId;
          }
          return Boolean(
            memory.teamId && getMembership(actor.userId, memory.teamId)
          );
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
    async createLcmNodes(actor, input) {
      if (input.visibility === "team") {
        if (!input.teamId) {
          throw new Error("Team visibility requires a teamId");
        }
        if (!getMembership(actor.userId, input.teamId)) {
          throw new Error("User is not an active member of the requested team");
        }
      }
      const uncompacted = events.filter((event) => {
        const visible =
          input.visibility === "personal"
            ? event.ownerUserId === actor.userId
            : event.teamId === input.teamId;
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
          ownerUserId: event.visibility === "personal" ? actor.userId : null,
          teamId: event.visibility === "team" ? event.teamId : null,
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
          return Boolean(
            memory.teamId && getMembership(actor.userId, memory.teamId)
          );
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

  it("returns OK", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("OK");
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
      payload: { visibility: "team", summaryText: "team memory" }
    });
    await app.close();

    expect(registered.statusCode).toBe(200);
    expect(
      jsonBody<{ currentTeam: unknown | null }>(me).currentTeam
    ).toBeNull();
    expect(rejected.statusCode).toBe(404);
  });

  it("creates a team and lets another user join by invite code", async () => {
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    const repository = createFakeRepository();
    const app = await buildServer({ repository });
    const owner = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "owner@example.com", password: "password123" }
    });
    const ownerCookie = cookieHeader(owner);
    const created = await app.inject({
      method: "POST",
      url: "/teams",
      headers: { cookie: ownerCookie },
      payload: { name: "Research" }
    });
    const inviteCode = jsonBody<TeamResponse>(created).team.inviteCode;

    const member = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "member@example.com", password: "password123" }
    });
    const joined = await app.inject({
      method: "POST",
      url: "/teams/join",
      headers: { cookie: cookieHeader(member) },
      payload: { inviteCode }
    });
    await app.close();

    expect(created.statusCode).toBe(200);
    expect(joined.statusCode).toBe(200);
    expect(jsonBody<TeamResponse>(joined).team.name).toBe("Research");
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
    const rejectedTeamAnswer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers,
      payload: { query: "concise changelog", retrieval_scope: "personal+team" }
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
    expect(rejectedTeamAnswer.statusCode).toBe(400);
    expect(cookieAnswer.statusCode).toBe(200);
    expect(
      jsonBody<AnswerResponse>(cookieAnswer).evidence[0]?.summaryText
    ).toContain("concise changelog");
  });

  it("rejects team capture policies for API-token setup", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "team-capture@example.com", password: "password123" }
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

    const teamPolicy = await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers,
      payload: {
        targetType: "global",
        captureState: "enabled",
        visibility: "team"
      }
    });
    await app.close();

    expect(teamPolicy.statusCode).toBe(400);
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
    const compactionScopes: Array<{ visibility: Visibility; teamId?: string }> =
      [];
    const originalCreateLcmNodes = repository.createLcmNodes.bind(repository);
    repository.createLcmNodes = async (actor, input) => {
      compactionScopes.push({
        visibility: input.visibility,
        teamId: input.teamId
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
    const createdTeam = await app.inject({
      method: "POST",
      url: "/teams",
      headers: { cookie },
      payload: { name: "Capture Team" }
    });
    await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers,
      payload: {
        targetType: "global",
        captureState: "enabled",
        visibility: "team"
      }
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload
    });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(createdTeam.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(jsonBody<CaptureResponse>(second).event.visibility).toBe("personal");
    expect(compactionScopes.at(-1)).toEqual({
      visibility: "personal",
      teamId: undefined
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
        thread_name: "Explorer"
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
      searchDomain: "project",
      workspaceId: "project-1"
    });
  });

  it("rejects unsupported team retrieval scope for persisted questions", async () => {
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
        query: "What did we decide about team memory?",
        retrieval_scope: "personal+team"
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

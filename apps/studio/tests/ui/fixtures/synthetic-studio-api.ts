import type { Page, Route } from "@playwright/test";
import type {
  TeamOverviewSnapshot,
  TeamAgentOffer,
  TeamAgentRequest
} from "@koed/shared";
import realtimeCursorFixture from "./realtime-cursor.json";

export const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  team: "22222222-2222-4222-8222-222222222222",
  secondTeam: "16161616-1616-4616-8616-161616161616",
  general: "33333333-3333-4333-8333-333333333333",
  launch: "44444444-4444-4444-8444-444444444444",
  directMessage: "17171717-1717-4717-8717-171717171717",
  groupDirectMessage: "18181818-1818-4818-8818-181818181818",
  otherTeammate: "19191919-1919-4919-8919-191919191919",
  sharedProject: "20202020-2020-4020-8020-202020202020",
  sharedProjectThread: "21212121-2121-4121-8121-212121212121",
  teammateAgent: "22232323-2323-4232-8232-232323232323",
  otherTeammateAgent: "24242424-2424-4424-8424-242424242424",
  agentRequestMessage: "25252525-2525-4525-8525-252525252525",
  agentRequest: "26262626-2626-4626-8626-262626262626",
  root: "55555555-5555-4555-8555-555555555555",
  reply: "66666666-6666-4666-8666-666666666666",
  ownSecond: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ownThird: "12121212-1212-4212-8212-121212121212",
  olderJob: "13131313-1313-4313-8313-131313131313",
  busyAgent: "77777777-7777-4777-8777-777777777777",
  idleAgent: "88888888-8888-4888-8888-888888888888",
  retiredAgent: "99999999-9999-4999-8999-999999999999",
  unknownAgent: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  teammate: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  subscription: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  nativePublication: "15151515-1515-4515-8515-151515151515",
  recurringTask: "30303030-3030-4030-8030-303030303030",
  recurringOccurrence: "31313131-3131-4131-8131-313131313131"
} as const;

const now = new Date().toISOString();
const epoch = Date.parse(now);
const realtimeCursor = realtimeCursorFixture.cursor;

type SyntheticMessage = {
  id: string;
  threadId: string;
  threadSequence: number;
  audienceVersion: number;
  scope: "team";
  personalOwnerUserId: null;
  teamId: string;
  teamWorkspaceId: null;
  senderKind: "user";
  senderPrincipalId: string;
  senderUserId: string;
  senderDisplayName: string;
  recipientStatus: "sent";
  bodyText: string;
  mentionUserIds: string[];
  metadata: Record<string, never>;
  provenance: { kind: "user"; id: string };
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  rootMessageId: string | null;
  version: number;
  replyCount: number;
  unreadReplyCount: number;
  reactions: Array<{ emoji: string; count: number; reacted: boolean }>;
};

type SyntheticAgent = {
  id: string;
  ownerUserId: string;
  name: string;
  role: string;
  soulInstructions: string;
  lifecycle: "active" | "retired";
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
};

type HeldResponse = {
  started: Promise<void>;
  waiting: Promise<void>;
  begin: () => void;
  release: () => void;
};

const agent = (
  id: string,
  name: string,
  lifecycle: SyntheticAgent["lifecycle"] = "active"
): SyntheticAgent => ({
  id,
  ownerUserId: ids.user,
  name,
  role: "Synthetic teammate",
  soulInstructions: "Use clear, concise language.",
  lifecycle,
  currentVersion: 1,
  createdAt: now,
  updatedAt: now,
  retiredAt: lifecycle === "retired" ? now : null,
  defaultProvider: null,
  defaultModel: null,
  defaultReasoningEffort: null
});

const rawThread = (id: string, name: string, systemKey: string | null) => ({
  id,
  logicalId: id,
  scope: "team",
  kind: "team_channel",
  personalOwnerUserId: null,
  teamId: ids.team,
  teamWorkspaceId: null,
  teamProjectId: null,
  sharedLogicalMemoryId: null,
  shareGrantId: null,
  systemKey,
  name,
  topic: null,
  createdByUserId: null,
  version: 1,
  lifecycle: "active",
  latestSequence: 4,
  lastReadMessageId: null,
  lastReadSequence: 0,
  unreadCount: 0,
  participants: [],
  createdAt: now,
  updatedAt: now,
  lastActivityAt: now,
  archivedAt: null
});

const rawDirectThread = (
  id: string,
  kind: "dm" | "group_dm",
  participants: Array<{
    userId: string;
    displayName: string;
    membershipState: "enabled" | "disabled";
  }>
) => ({
  ...rawThread(id, "", null),
  kind,
  name: null,
  topic: null,
  participants
});

const rawProjectThread = () => ({
  ...rawThread(ids.sharedProjectThread, "Synthetic launch", null),
  kind: "team_project_channel",
  teamProjectId: ids.sharedProject
});

const rawMessage = (input: {
  id: string;
  threadId: string;
  sequence: number;
  bodyText: string;
  rootMessageId?: string | null;
  senderUserId?: string;
  mentionUserIds?: string[];
  reactions?: Array<{ emoji: string; count: number; reacted: boolean }>;
}): SyntheticMessage => ({
  id: input.id,
  threadId: input.threadId,
  threadSequence: input.sequence,
  audienceVersion: 1,
  scope: "team",
  personalOwnerUserId: null,
  teamId: ids.team,
  teamWorkspaceId: null,
  senderKind: "user",
  senderPrincipalId: input.senderUserId ?? ids.user,
  senderUserId: input.senderUserId ?? ids.user,
  senderDisplayName:
    input.senderUserId === ids.teammate
      ? "Synthetic teammate"
      : "Synthetic user",
  recipientStatus: "sent",
  bodyText: input.bodyText,
  mentionUserIds: input.mentionUserIds ?? [],
  metadata: {},
  provenance: {
    kind: "user",
    id: input.senderUserId ?? ids.user
  },
  createdAt: now,
  updatedAt: now,
  editedAt: null,
  rootMessageId: input.rootMessageId ?? null,
  version: 1,
  replyCount: 1,
  unreadReplyCount: 0,
  reactions: input.reactions ?? []
});

const syntheticJob = (id: string, title: string, state: string) => ({
  id,
  title,
  goal: "Exercise the Studio activity view with synthetic data.",
  conversationId: ids.root,
  agentName: "Busy Reviewer",
  projectId: ids.launch,
  projectName: "Synthetic launch",
  state,
  updatedAt: epoch,
  createdAt: epoch,
  startedAt: epoch,
  completedAt: null,
  attempts: []
});

const syntheticLiveJob = (id: string) => ({
  id,
  title: "Synthetic active review",
  goal: "Exercise the Studio activity view with synthetic data.",
  conversationId: ids.root,
  projectId: ids.launch,
  projectName: "Synthetic launch",
  state: "running",
  updatedAt: new Date().toISOString()
});

export class SyntheticStudioApi {
  teamOverview: TeamOverviewSnapshot | null = null;
  teamOverviewPage2: TeamOverviewSnapshot | null = null;
  teamOverviewStatus = 200;
  readonly teamOffers = new Map<string, TeamAgentOffer>();
  readonly teamAgentRequests: TeamAgentRequest[] = [];
  private readonly teamAgentRequestIdsByKey = new Map<string, string>();
  readonly unexpectedMutations: string[] = [];
  readonly unexpectedReads: string[] = [];
  readonly mutationCounts = new Map<string, number>();
  readonly requestCounts = new Map<string, number>();
  readonly recurringTaskWrites: Array<Record<string, unknown>> = [];
  private readonly agents = [
    agent(ids.busyAgent, "Busy Reviewer"),
    agent(ids.idleAgent, "Calm Reviewer"),
    agent(ids.retiredAgent, "Retired Reviewer", "retired"),
    agent(ids.unknownAgent, "Unknown Reviewer")
  ];
  private readonly detailHolds = new Map<string, HeldResponse>();
  private readonly jobsPageHolds = new Map<string, HeldResponse>();
  private readonly projectConnectionHolds = new Map<string, HeldResponse>();
  private readonly projectConnectionHoldSkips = new Map<string, number>();
  private readonly jobsPageAttempts = new Map<string, number>();
  private readonly recurringTasks = new Map<string, Record<string, unknown>>();
  private readonly recurringOccurrences = new Map<
    string,
    Array<Record<string, unknown>>
  >();
  private readonly recurringTaskListHolds = new Map<string, HeldResponse>();
  private readonly seenClientMessages = new Map<
    string,
    ReturnType<typeof rawMessage>
  >();
  private readonly messages = [
    rawMessage({
      id: ids.root,
      threadId: ids.general,
      sequence: 1,
      bodyText: "Synthetic channel message"
    }),
    rawMessage({
      id: ids.reply,
      threadId: ids.general,
      sequence: 2,
      bodyText: "Synthetic teammate reply",
      rootMessageId: ids.root,
      senderUserId: ids.teammate
    }),
    rawMessage({
      id: ids.ownSecond,
      threadId: ids.general,
      sequence: 3,
      bodyText: `Synthetic second human message ${"long test content ".repeat(80)}`
    }),
    rawMessage({
      id: ids.ownThird,
      threadId: ids.general,
      sequence: 4,
      bodyText: `Synthetic third human message ${"long test content ".repeat(80)}`
    }),
    rawMessage({
      id: "14141414-1414-4414-8414-141414141414",
      threadId: ids.launch,
      sequence: 1,
      bodyText: "Synthetic launch channel message"
    })
  ];

  holdNextDetail(agentId: string): HeldResponse {
    let markStarted!: () => void;
    let unblock!: () => void;
    const held: HeldResponse = {
      started: new Promise<void>((resolve) => (markStarted = resolve)),
      waiting: new Promise<void>((resolve) => (unblock = resolve)),
      begin: () => markStarted(),
      release: () => unblock()
    };
    this.detailHolds.set(agentId, held);
    return held;
  }

  holdNextJobsPage(agentId: string): HeldResponse {
    let markStarted!: () => void;
    let unblock!: () => void;
    const held: HeldResponse = {
      started: new Promise<void>((resolve) => (markStarted = resolve)),
      waiting: new Promise<void>((resolve) => (unblock = resolve)),
      begin: () => markStarted(),
      release: () => unblock()
    };
    this.jobsPageHolds.set(agentId, held);
    return held;
  }

  holdNextRecurringTaskList(agentId: string): HeldResponse {
    let markStarted!: () => void;
    let unblock!: () => void;
    const held: HeldResponse = {
      started: new Promise<void>((resolve) => (markStarted = resolve)),
      waiting: new Promise<void>((resolve) => (unblock = resolve)),
      begin: () => markStarted(),
      release: () => unblock()
    };
    this.recurringTaskListHolds.set(agentId, held);
    return held;
  }

  seedRecurringTask(agentId: string, title: string): void {
    const createdAt = new Date().toISOString();
    this.recurringTasks.set(ids.recurringTask, {
      id: ids.recurringTask,
      agentId,
      title,
      prompt: "Synthetic private recurring instructions.",
      schedule: {
        kind: "interval",
        everyMinutes: 60,
        anchorAt: createdAt
      },
      context: { projectId: null, contextKind: "independent" },
      execution: {
        provider: "codex",
        aiClientInstanceId: "codex.synthetic",
        targetDeviceId: "synthetic-runner",
        model: "gpt-6-sol",
        reasoningEffort: null,
        permissionMode: "supervised"
      },
      status: "paused",
      revision: 1,
      nextRunAt: null,
      lastRunAt: null,
      lastErrorCode: null,
      createdAt,
      updatedAt: createdAt
    });
    this.recurringOccurrences.set(ids.recurringTask, []);
  }

  dispatchLatestRecurringOccurrence(taskId = ids.recurringTask): void {
    const occurrences = this.recurringOccurrences.get(taskId) ?? [];
    const latest = occurrences[0];
    if (!latest) return;
    this.recurringOccurrences.set(taskId, [
      {
        ...latest,
        status: "dispatched",
        executionId: ids.recurringOccurrence,
        updatedAt: new Date().toISOString()
      },
      ...occurrences.slice(1)
    ]);
  }

  holdNextProjectConnection(
    teamProjectId: string,
    skipRequests = 0
  ): HeldResponse {
    let markStarted!: () => void;
    let unblock!: () => void;
    const held: HeldResponse = {
      started: new Promise<void>((resolve) => (markStarted = resolve)),
      waiting: new Promise<void>((resolve) => (unblock = resolve)),
      begin: () => markStarted(),
      release: () => unblock()
    };
    this.projectConnectionHolds.set(teamProjectId, held);
    this.projectConnectionHoldSkips.set(teamProjectId, skipRequests);
    return held;
  }

  async install(page: Page): Promise<void> {
    await page.addInitScript(
      ({ subscriptionId, cursor }) => {
        const debug = { streamResponses: 0 };
        (
          window as Window & { __syntheticRealtimeDebug?: typeof debug }
        ).__syntheticRealtimeDebug = debug;
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const requestUrl =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          if (
            new URL(requestUrl, window.location.href).pathname !==
            "/v1/collaboration/realtime/stream"
          ) {
            return originalFetch(input, init);
          }
          debug.streamResponses += 1;
          const encoder = new TextEncoder();
          const ready = encoder.encode(
            `event: ready\ndata: ${JSON.stringify({ protocolVersion: 7, subscription: { id: subscriptionId }, cursor })}\n\n`
          );
          const signal =
            init?.signal ??
            (input instanceof Request ? input.signal : undefined);
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(ready);
              if (signal?.aborted) controller.close();
              else
                signal?.addEventListener("abort", () => controller.close(), {
                  once: true
                });
            }
          });
          return new Promise((resolve, reject) => {
            const abort = () => {
              reject(
                new DOMException("Synthetic stream was aborted", "AbortError")
              );
            };
            if (signal?.aborted) {
              abort();
              return;
            }
            signal?.addEventListener("abort", abort, { once: true });
            resolve(
              new Response(body, {
                status: 200,
                headers: { "content-type": "text/event-stream" }
              })
            );
          });
        };
      },
      { subscriptionId: ids.subscription, cursor: realtimeCursor }
    );
    await page.route("**/*", async (route) => this.handleRoute(route));
  }

  private async handleRoute(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const port = process.env.KOED_STUDIO_UI_TEST_PORT ?? "43119";
    if (url.origin !== `http://127.0.0.1:${port}`) {
      await route.abort();
      return;
    }
    if (
      !(
        path === "/me" ||
        path.startsWith("/v1/") ||
        path.startsWith("/studio-api/")
      )
    ) {
      await route.continue();
      return;
    }

    const method = request.method();
    const requestKey = `${method} ${path}`;
    this.requestCounts.set(
      requestKey,
      (this.requestCounts.get(requestKey) ?? 0) + 1
    );
    const body = request.postDataJSON() as Record<string, unknown> | null;
    if (
      (path === "/v1/home/access" || path === "/studio-api/home-feed/access") &&
      method === "GET"
    ) {
      await route.fulfill({
        json: {
          accountScope: `synthetic-home:${ids.user}:synthetic-backend`,
          backendId: "synthetic-backend"
        }
      });
      return;
    }
    if (
      (path === "/v1/home" || path === "/studio-api/home-feed") &&
      method === "GET"
    ) {
      await route.fulfill({
        json: {
          schemaVersion: "koed.home-feed/v1",
          accountScope: `synthetic-home:${ids.user}:synthetic-backend`,
          generatedAt: "2026-10-02T12:00:00.000Z",
          coverage: [
            {
              source: "managed_runtime_item",
              complete: true,
              nextCursor: null
            },
            { source: "managed_execution", complete: true, nextCursor: null },
            {
              source: "native_agent_activity",
              complete: true,
              nextCursor: null
            },
            { source: "personal_agent_job", complete: true, nextCursor: null },
            { source: "pull_request_review", complete: true, nextCursor: null }
          ],
          needsYou: [],
          ongoing: [],
          recent: [],
          cleared: [],
          badgeCount: 0
        }
      });
      return;
    }
    if (path === "/me" && method === "GET") {
      await route.fulfill({
        json: {
          user: {
            id: ids.user,
            email: "synthetic@example.test",
            displayName: "Synthetic user"
          }
        }
      });
      return;
    }
    if (path === "/v1/capabilities" && method === "GET") {
      await route.fulfill({ json: { auth: { providers: ["local"] } } });
      return;
    }
    if (path === "/v1/teams/navigation" && method === "GET") {
      await route.fulfill({
        json: {
          principal: { id: ids.user, displayName: "Synthetic user" },
          teams: [
            {
              team: { id: ids.team, name: "Synthetic Team" },
              membership: {
                teamId: ids.team,
                userId: ids.user,
                role: "owner",
                status: "enabled"
              },
              members: [
                {
                  userId: ids.user,
                  displayName: "Synthetic user",
                  status: "enabled"
                },
                {
                  userId: ids.teammate,
                  displayName: "Synthetic teammate",
                  status: "enabled"
                },
                {
                  userId: ids.otherTeammate,
                  displayName: "Other teammate",
                  status: "enabled"
                }
              ],
              workspaces: []
            }
          ]
        }
      });
      return;
    }
    if (path === "/v1/memory/local-agent-settings" && method === "GET") {
      await route.fulfill({
        json: { settings: [], instances: [], capabilitySnapshots: [] }
      });
      return;
    }
    if (path === "/v1/managed-conversations/access" && method === "GET") {
      await route.fulfill({
        json: { backendId: url.origin, user: { id: ids.user } }
      });
      return;
    }
    if (path === "/v1/managed-conversations" && method === "GET") {
      await route.fulfill({
        json: {
          executions: [
            {
              id: ids.root,
              projectId: null,
              provider: "codex",
              aiClientInstanceId: "codex.synthetic",
              runnerDeviceId: "synthetic-runner",
              model: "gpt-6-sol",
              reasoningEffort: null,
              permissionMode: "supervised",
              executionGeneration: 1,
              stateVersion: 1,
              state: "running",
              lastErrorCode: null,
              createdAt: now,
              updatedAt: now,
              startedAt: now,
              stoppedAt: null
            }
          ]
        }
      });
      return;
    }
    if (
      path === `/v1/managed-conversations/${ids.root}/project-moves/latest` &&
      method === "GET"
    ) {
      await route.fulfill({ json: { move: null } });
      return;
    }
    if (path === "/v1/personal-conversations" && method === "GET") {
      await route.fulfill({
        json: { conversations: [], hasMore: false, nextCursor: null }
      });
      return;
    }
    const hostedExecutionPath = path.match(
      /^\/v1\/managed-conversations\/([^/]+)\/(runtime|agent-state)$/
    );
    if (hostedExecutionPath && method === "GET") {
      const [, executionId, resource] = hostedExecutionPath;
      const execution = {
        id: executionId,
        projectId: null,
        provider: "codex",
        aiClientInstanceId: "codex.synthetic",
        runnerDeviceId: "synthetic-runner",
        model: "gpt-6-sol",
        reasoningEffort: null,
        permissionMode: "supervised",
        executionGeneration: 1,
        stateVersion: 1,
        state: "running",
        lastErrorCode: null
      };
      await route.fulfill({
        json:
          resource === "runtime"
            ? {
                execution,
                items: [],
                hasIndeterminatePrompt: false,
                latestCommand: null
              }
            : {
                executionId,
                executionGeneration: 1,
                executionState: "running",
                activeAgentId: null,
                participants: [],
                jobs: [],
                messages: []
              }
      });
      return;
    }
    if (
      (path === "/v1/managed-conversations/launch-options" ||
        path === "/studio-api/managed-conversations/launch-options") &&
      method === "GET"
    ) {
      await route.fulfill({
        json: {
          runners: [
            {
              kind: "local_device",
              deviceId: "synthetic-runner",
              displayName: "Synthetic runner"
            }
          ],
          instances: [
            {
              instanceId: "codex.synthetic",
              driverId: "codex",
              runnerDeviceId: "synthetic-runner",
              ready: true,
              readiness: "ready",
              capabilities: {
                permissionModes: [{ mode: "supervised", support: "supported" }]
              },
              models: [
                {
                  id: "gpt-6-sol",
                  displayName: "GPT 6 Sol",
                  supportedReasoningEfforts: ["medium", "high"]
                }
              ]
            }
          ]
        }
      });
      return;
    }
    if (path === "/studio-api/collaboration/session" && method === "GET") {
      await route.fulfill({
        status: 404,
        json: { error: "Synthetic local connection unavailable" }
      });
      return;
    }
    if (path === "/studio-api/projects/capabilities" && method === "GET") {
      await route.fulfill({ json: { canCreateLocalProject: false } });
      return;
    }
    if (path === "/studio-api/personal-scope" && method === "GET") {
      await route.fulfill({
        json: { scopeKey: `${url.origin}|${ids.user}` }
      });
      return;
    }
    if (path === "/studio-api/personal-removals" && method === "GET") {
      await route.fulfill({ json: { removals: [] } });
      return;
    }
    if (path === "/studio-api/projects" && method === "GET") {
      await route.fulfill({ json: { projects: [] } });
      return;
    }

    if (
      path === `/v1/teams/${ids.team}/memory-retention/members` &&
      method === "GET"
    ) {
      await route.fulfill({
        json: {
          teamId: ids.team,
          members: [
            {
              userId: ids.user,
              displayName: "Synthetic user",
              enabled: true,
              version: 1
            }
          ]
        }
      });
      return;
    }
    if (path === "/v1/shared-memory/owned-shares" && method === "GET") {
      await route.fulfill({
        json: {
          shares: [],
          pagination: {
            limit: 100,
            hasMore: false,
            next: null,
            snapshotAt: now
          }
        }
      });
      return;
    }
    if (path === "/v1/personal-agent-role-templates" && method === "GET") {
      await route.fulfill({ json: { templates: [] } });
      return;
    }
    if (path === "/v1/personal-agents" && method === "GET") {
      await route.fulfill({ json: { agents: this.agents } });
      return;
    }
    if (path === "/v1/personal-agents/capabilities" && method === "GET") {
      await route.fulfill({ json: { capabilities: [] } });
      return;
    }
    if (path === "/v1/personal-agents/activity" && method === "GET") {
      const activity = url.searchParams
        .getAll("agentId")
        .map((agentId) => this.activity(agentId));
      await route.fulfill({ json: { contractVersion: 1, activity } });
      return;
    }
    const recurringCollection = path.match(
      /^\/v1\/personal-agents\/([^/]+)\/recurring-tasks$/
    );
    if (recurringCollection) {
      const [, agentId] = recurringCollection;
      if (method === "GET") {
        const held = this.recurringTaskListHolds.get(agentId);
        if (held) {
          this.recurringTaskListHolds.delete(agentId);
          held.begin();
          await held.waiting;
        }
        const tasks = [...this.recurringTasks.values()].filter(
          (task) => task.agentId === agentId
        );
        await route.fulfill({ json: { tasks, nextCursor: null } });
        return;
      }
      if (method === "POST") {
        const createdAt = new Date().toISOString();
        const input = body ?? {};
        const task = {
          id: ids.recurringTask,
          agentId,
          title: input.title,
          prompt: input.prompt,
          schedule: input.schedule,
          context: input.context,
          execution: input.execution,
          status: "paused",
          revision: 1,
          nextRunAt: null,
          lastRunAt: null,
          lastErrorCode: null,
          createdAt,
          updatedAt: createdAt
        };
        this.recurringTasks.set(ids.recurringTask, task);
        this.recurringOccurrences.set(ids.recurringTask, []);
        this.recurringTaskWrites.push({ action: "create", ...input });
        await this.recordMutation(route, `POST ${path}`);
        await route.fulfill({ status: 201, json: { task } });
        return;
      }
    }
    const recurringTaskPath = path.match(
      /^\/v1\/recurring-agent-tasks\/([^/]+)(?:\/(control|run-now|occurrences))?$/
    );
    if (recurringTaskPath) {
      const [, taskId, action] = recurringTaskPath;
      const task = this.recurringTasks.get(taskId);
      if (!task) {
        await route.fulfill({ status: 404, json: { error: "not_found" } });
        return;
      }
      if (method === "GET" && !action) {
        await route.fulfill({ json: { task } });
        return;
      }
      if (method === "PATCH" && !action) {
        const input = body ?? {};
        const updated = {
          ...task,
          title: input.title,
          prompt: input.prompt,
          schedule: input.schedule,
          context: input.context,
          execution: input.execution,
          status: "paused",
          revision: Number(task.revision) + 1,
          updatedAt: new Date().toISOString()
        };
        this.recurringTasks.set(taskId, updated);
        this.recurringTaskWrites.push({ action: "update", ...input });
        await this.recordMutation(route, `PATCH ${path}`);
        await route.fulfill({ json: { task: updated } });
        return;
      }
      if (method === "POST" && action === "control") {
        const input = body ?? {};
        const status =
          input.action === "archive"
            ? "archived"
            : input.action === "pause"
              ? "paused"
              : "active";
        const updated = {
          ...task,
          status,
          revision: Number(task.revision) + 1,
          nextRunAt:
            status === "active"
              ? new Date(Date.now() + 60 * 60_000).toISOString()
              : null,
          updatedAt: new Date().toISOString()
        };
        this.recurringTasks.set(taskId, updated);
        this.recurringTaskWrites.push({ action: "control", ...input });
        await this.recordMutation(route, `POST ${path}`);
        await route.fulfill({ json: { task: updated } });
        return;
      }
      if (method === "POST" && action === "run-now") {
        const createdAt = new Date().toISOString();
        const occurrence = {
          id: ids.recurringOccurrence,
          taskId,
          taskRevision: Number(task.revision),
          trigger: "manual",
          scheduledAt: createdAt,
          status: "reserved",
          conversationId: ids.root,
          messageId: null,
          deliveryId: null,
          executionId: null,
          errorCode: null,
          createdAt,
          updatedAt: createdAt,
          completedAt: null
        };
        this.recurringOccurrences.set(taskId, [occurrence]);
        this.recurringTasks.set(taskId, {
          ...task,
          lastRunAt: createdAt,
          revision: Number(task.revision) + 1,
          updatedAt: createdAt
        });
        this.recurringTaskWrites.push({ action: "run-now", ...(body ?? {}) });
        await this.recordMutation(route, `POST ${path}`);
        await route.fulfill({ json: { occurrence } });
        return;
      }
      if (method === "GET" && action === "occurrences") {
        await route.fulfill({
          json: {
            occurrences: this.recurringOccurrences.get(taskId) ?? [],
            nextCursor: null
          }
        });
        return;
      }
    }
    const agentPath = path.match(
      /^\/v1\/personal-agents\/([^/]+)(?:\/(jobs|retire|restore))?$/
    );
    if (agentPath) {
      const [, agentId, action] = agentPath;
      const current = this.agents.find((entry) => entry.id === agentId);
      if (method === "GET" && action === "jobs") {
        const cursor = url.searchParams.get("before") ?? "";
        const pageKey = `${agentId}:${cursor}`;
        const attempt = (this.jobsPageAttempts.get(pageKey) ?? 0) + 1;
        this.jobsPageAttempts.set(pageKey, attempt);
        const held = this.jobsPageHolds.get(agentId);
        if (held) {
          this.jobsPageHolds.delete(agentId);
          held.begin();
          await held.waiting;
        }
        if (attempt === 1 && !held) {
          await route.fulfill({
            status: 503,
            json: {
              error: "Synthetic older Jobs page is temporarily unavailable."
            }
          });
          return;
        }
        await route.fulfill({
          json: {
            contractVersion: 1,
            jobs: [
              syntheticJob(
                ids.olderJob,
                "Synthetic older archived job",
                "completed"
              )
            ],
            hasMore: false,
            nextCursor: null
          }
        });
        return;
      }
      if (method === "GET" && !action && current) {
        const held = this.detailHolds.get(agentId);
        if (held) {
          this.detailHolds.delete(agentId);
          held.begin();
          await held.waiting;
        }
        await route.fulfill({
          json: { agent: current, ...this.detail(current.id) }
        });
        return;
      }
      if (
        method === "POST" &&
        (action === "retire" || action === "restore") &&
        current
      ) {
        const index = this.agents.findIndex((entry) => entry.id === current.id);
        const next = {
          ...current,
          lifecycle:
            action === "retire" ? ("retired" as const) : ("active" as const),
          currentVersion: current.currentVersion + 1,
          updatedAt: new Date().toISOString(),
          retiredAt: action === "retire" ? new Date().toISOString() : null
        };
        this.agents[index] = next;
        await this.recordMutation(route, `${method} ${path}`);
        await route.fulfill({ json: { agent: next, ...this.detail(next.id) } });
        return;
      }
    }

    if (path === "/v1/collaboration/teams/overview" && method === "GET") {
      if (this.teamOverviewStatus !== 200) {
        await route.fulfill({
          status: this.teamOverviewStatus,
          json: { error: "Synthetic overview unavailable" }
        });
        return;
      }
      const cursor = url.searchParams.get("cursor");
      await route.fulfill({
        json:
          cursor && this.teamOverviewPage2
            ? this.teamOverviewPage2
            : (this.teamOverview ?? {
                schemaVersion: "koed.team-overview/v1",
                access: { accountScope: ids.user, backendId: url.origin },
                generatedAt: now,
                nextCursor: null,
                teams: [
                  { teamId: ids.team, name: "Synthetic Team", badgeCount: 0 }
                ],
                coverage: [
                  {
                    source: "message_attention",
                    complete: true,
                    nextCursor: null
                  },
                  {
                    source: "agent_request",
                    complete: true,
                    nextCursor: null
                  },
                  {
                    source: "team_job_action",
                    complete: true,
                    nextCursor: null
                  },
                  {
                    source: "pull_request_action",
                    complete: true,
                    nextCursor: null
                  },
                  {
                    source: "team_job_outcome",
                    complete: true,
                    nextCursor: null
                  },
                  {
                    source: "team_agent_action",
                    complete: true,
                    nextCursor: null
                  },
                  {
                    source: "team_agent_outcome",
                    complete: true,
                    nextCursor: null
                  }
                ],
                attention: [],
                catchUp: [],
                currentJobOutcomes: [],
                cleared: [],
                badgeCount: 0
              })
      });
      return;
    }
    const overviewMutation = path.match(
      /^\/v1\/collaboration\/teams\/([^/]+)\/overview\/([^/]+)\/(clear|restore|seen)$/
    );
    if (overviewMutation && method === "POST") {
      const [, teamId, encodedId, action] = overviewMutation;
      const eventId = decodeURIComponent(encodedId);
      const feeds = [this.teamOverview, this.teamOverviewPage2].filter(
        (entry): entry is TeamOverviewSnapshot => entry !== null
      );
      const body = request.postDataJSON() as { sourceRevision?: unknown };
      const feed = feeds.find((candidate) =>
        [
          ...candidate.attention,
          ...candidate.cleared,
          ...candidate.catchUp
        ].some(
          (entry) => entry.sourceEventId === eventId && entry.teamId === teamId
        )
      );
      const item = feed
        ? [...feed.attention, ...feed.cleared, ...feed.catchUp].find(
            (entry) =>
              entry.sourceEventId === eventId && entry.teamId === teamId
          )
        : undefined;
      if (!feed || !item || item.sourceRevision !== body.sourceRevision) {
        await route.fulfill({
          status: 409,
          json: { error: "revision_changed" }
        });
        return;
      }
      await this.recordMutation(route, `overview:${eventId}:${action}`);
      if (action === "seen") {
        feed.catchUp = feed.catchUp.filter((entry) => entry !== item);
      } else {
        feed.attention = feed.attention.filter((entry) => entry !== item);
        feed.cleared = feed.cleared.filter((entry) => entry !== item);
        if (action === "clear") feed.cleared.push(item);
        else feed.attention.push(item);
      }
      const attention = feeds.flatMap((current) => current.attention);
      for (const current of feeds) {
        current.badgeCount = attention.length;
        current.teams = current.teams.map((team) => ({
          ...team,
          badgeCount: attention.filter((entry) => entry.teamId === team.teamId)
            .length
        }));
      }
      await route.fulfill({
        json: {
          sourceEventId: eventId,
          sourceRevision: item.sourceRevision,
          cleared: action === "clear",
          seen: action === "seen"
        }
      });
      return;
    }
    const teamPrefix = `/v1/collaboration/teams/${ids.team}`;
    const projectConnectionPath = path.match(
      new RegExp(`^${teamPrefix}/public-square/projects/([^/]+)/connection$`)
    );
    if (projectConnectionPath && method === "GET") {
      const teamProjectId = decodeURIComponent(projectConnectionPath[1]);
      const held = this.projectConnectionHolds.get(teamProjectId);
      const skipped = this.projectConnectionHoldSkips.get(teamProjectId) ?? 0;
      if (held && skipped > 0) {
        this.projectConnectionHoldSkips.set(teamProjectId, skipped - 1);
      } else if (held) {
        this.projectConnectionHolds.delete(teamProjectId);
        this.projectConnectionHoldSkips.delete(teamProjectId);
        held.begin();
        await held.waiting;
      }
      await route.fulfill({
        json: {
          connection: {
            teamId: ids.team,
            teamProjectId,
            localProjectId: "synthetic-local-project",
            connectedAt: now,
            version: 1
          }
        }
      });
      return;
    }
    if (path === `${teamPrefix}/channels` && method === "GET") {
      await route.fulfill({
        json: {
          threads: [
            rawThread(ids.general, "general", "team.general"),
            rawThread(ids.launch, "launch", null)
          ]
        }
      });
      return;
    }
    if (path === `${teamPrefix}/participants` && method === "GET") {
      await route.fulfill({
        json: {
          participants: [
            {
              userId: ids.user,
              displayName: "Synthetic user",
              membershipState: "enabled"
            },
            {
              userId: ids.teammate,
              displayName: "Synthetic teammate",
              membershipState: "enabled"
            },
            {
              userId: ids.otherTeammate,
              displayName: "Other teammate",
              membershipState: "enabled"
            }
          ]
        }
      });
      return;
    }
    if (path === `${teamPrefix}/direct-messages` && method === "GET") {
      await route.fulfill({
        json: {
          threads: [
            rawDirectThread(ids.directMessage, "dm", [
              {
                userId: ids.user,
                displayName: "Synthetic user",
                membershipState: "enabled"
              },
              {
                userId: ids.teammate,
                displayName: "Synthetic teammate",
                membershipState: "enabled"
              }
            ]),
            rawDirectThread(ids.groupDirectMessage, "group_dm", [
              {
                userId: ids.user,
                displayName: "Synthetic user",
                membershipState: "enabled"
              },
              {
                userId: ids.teammate,
                displayName: "Synthetic teammate",
                membershipState: "enabled"
              },
              {
                userId: ids.otherTeammate,
                displayName: "Other teammate",
                membershipState: "disabled"
              }
            ])
          ]
        }
      });
      return;
    }
    if (path === `${teamPrefix}/projects` && method === "GET") {
      await route.fulfill({
        json: {
          projects: [
            {
              id: ids.sharedProject,
              teamId: ids.team,
              name: "Synthetic launch context",
              thread: rawProjectThread()
            }
          ]
        }
      });
      return;
    }
    if (path === `${teamPrefix}/agent-offers` && method === "GET") {
      await route.fulfill({
        json: {
          teamId: ids.team,
          offers: [...this.teamOffers.values()],
          serverTime: now
        }
      });
      return;
    }
    if (path.startsWith(`${teamPrefix}/agent-offers/`) && method === "PUT") {
      const agentId = path.split("/").at(-1)!;
      const agent = this.agents.find((entry) => entry.id === agentId);
      const input = request.postDataJSON();
      const previous = this.teamOffers.get(agentId);
      if (!agent || input.expectedVersion !== (previous?.version ?? 0)) {
        await route.fulfill({
          status: 409,
          json: { error: "revision_changed" }
        });
        return;
      }
      const offer: TeamAgentOffer = {
        teamId: ids.team,
        agentId,
        ownerId: ids.user,
        ownerName: "Synthetic user",
        agentName: agent.name,
        description: input.description,
        enabled: input.enabled,
        version: (previous?.version ?? 0) + 1,
        canManage: true
      };
      this.teamOffers.set(agentId, offer);
      await this.recordMutation(route, `offer:${agentId}`);
      await route.fulfill({ json: { offer } });
      return;
    }
    if (path === `${teamPrefix}/public-square` && method === "GET") {
      await route.fulfill({
        json: {
          page: {
            teamId: ids.team,
            items: [
              {
                id: ids.nativePublication,
                source: "native_command",
                jobId: null,
                agentId: ids.busyAgent,
                agentName: "Busy Reviewer",
                ownerId: ids.user,
                ownerName: "Synthetic user",
                projectId: ids.launch,
                projectName: "Synthetic launch",
                ownerExecutionId: null,
                status: "running",
                lastKnownStatus: null,
                phase: "working",
                phaseObservedAt: now,
                publishedAt: now,
                startedAt: now,
                updatedAt: now,
                completedAt: null,
                lastSeenAt: now,
                waitingOn: null,
                ownerLeftTeam: false,
                sharedBrief: "A Team-visible native publication.",
                version: 1,
                canEditBrief: false,
                canRemoveRetainedBrief: false
              },
              {
                id: ids.olderJob,
                jobId: ids.root,
                agentId: ids.busyAgent,
                agentName: "Busy Reviewer",
                ownerId: ids.user,
                ownerName: "Synthetic user",
                projectId: ids.launch,
                projectName: "Synthetic launch",
                status: "running",
                lastKnownStatus: null,
                phase: "checking",
                phaseObservedAt: now,
                publishedAt: now,
                startedAt: now,
                updatedAt: now,
                completedAt: null,
                lastSeenAt: now,
                ownerLeftTeam: false,
                sharedBrief:
                  "Exercise the responsive Project room and Agent card.",
                version: 1,
                canEditBrief: false,
                canRemoveRetainedBrief: false
              }
            ],
            idleAgents: [
              {
                agentId: ids.idleAgent,
                agentName: "Idle Planner",
                ownerId: ids.user,
                ownerName: "Synthetic user"
              }
            ],
            nextCursor: null,
            serverTime: now
          }
        }
      });
      return;
    }
    if (path === `${teamPrefix}/agent-requests` && method === "POST") {
      const offer = this.teamOffers.get(String(body?.agentId ?? ""));
      if (!offer || !offer.enabled || offer.ownerId === ids.user) {
        await route.fulfill({
          status: 404,
          json: { error: "Synthetic Agent offer unavailable" }
        });
        return;
      }
      const key = String(body?.idempotencyKey ?? "");
      const priorId = this.teamAgentRequestIdsByKey.get(key);
      const prior = this.teamAgentRequests.find((item) => item.id === priorId);
      const requestRecord: TeamAgentRequest = prior ?? {
        id: ids.agentRequest,
        teamId: ids.team,
        teamProjectId: String(body?.teamProjectId ?? ""),
        channelId: String(body?.channelId ?? ""),
        requestMessageId: ids.agentRequestMessage,
        originRootMessageId:
          typeof body?.rootMessageId === "string" ? body.rootMessageId : null,
        requesterId: ids.user,
        requesterName: "Synthetic user",
        ownerId: offer.ownerId,
        ownerName: offer.ownerName,
        agentId: offer.agentId,
        agentName: offer.agentName,
        status: "awaiting_owner",
        jobId: null,
        jobStatus: null,
        executionStatus: null,
        outcomeMessageId: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        canWithdraw: true,
        canReview: false
      };
      if (!prior) {
        this.teamAgentRequests.push(requestRecord);
        this.teamAgentRequestIdsByKey.set(key, requestRecord.id);
      }
      await this.recordMutation(route, `POST ${path}`);
      await route.fulfill({ json: { request: requestRecord } });
      return;
    }
    if (path.startsWith(`${teamPrefix}/agent-requests`) && method === "GET") {
      const channelId = url.searchParams.get("channelId");
      const teamProjectId = url.searchParams.get("teamProjectId");
      const requests = this.teamAgentRequests.filter(
        (item) =>
          (!channelId || item.channelId === channelId) &&
          (!teamProjectId || item.teamProjectId === teamProjectId)
      );
      await route.fulfill({
        json: {
          teamId: ids.team,
          requests,
          nextCursor: null,
          serverTime: now
        }
      });
      return;
    }
    const messagesPath = path.match(
      /^\/v1\/collaboration\/teams\/([^/]+)\/threads\/([^/]+)\/messages(?:\/([^/]+)(?:\/(reactions))?)?$/
    );
    if (messagesPath) {
      const [, teamId, threadId, messageId, action] = messagesPath;
      if (teamId !== ids.team) {
        await route.fulfill({
          status: 404,
          json: { error: "unknown synthetic Team" }
        });
        return;
      }
      if (method === "GET" && !messageId) {
        const rootId = url.searchParams.get("rootMessageId");
        const items = this.messages.filter(
          (message) =>
            message.threadId === threadId &&
            (rootId
              ? message.rootMessageId === rootId
              : message.rootMessageId === null)
        );
        await route.fulfill({
          json: { messages: items, hasMore: false, nextBeforeSequence: null }
        });
        return;
      }
      if (method === "POST" && !messageId) {
        const key = request.headers()["idempotency-key"] ?? crypto.randomUUID();
        let sent = this.seenClientMessages.get(key);
        if (!sent) {
          sent = rawMessage({
            id: crypto.randomUUID(),
            threadId,
            sequence: this.messages.length + 1,
            bodyText: String(body?.bodyText ?? ""),
            mentionUserIds: Array.isArray(body?.mentionUserIds)
              ? body.mentionUserIds
              : [],
            rootMessageId:
              typeof body?.rootMessageId === "string"
                ? body.rootMessageId
                : null
          });
          this.seenClientMessages.set(key, sent);
          this.messages.push(sent);
        }
        await this.recordMutation(route, `POST ${path}`);
        await route.fulfill({
          json: { message: sent, acceptedBody: sent.bodyText }
        });
        return;
      }
      if (method === "PATCH" && messageId && !action) {
        const target = this.messages.find(
          (message) => message.id === messageId
        );
        if (!target) {
          await route.fulfill({
            status: 404,
            json: { error: "message not found" }
          });
          return;
        }
        target.bodyText = String(body?.bodyText ?? target.bodyText);
        if (Array.isArray(body?.mentionUserIds))
          target.mentionUserIds = body.mentionUserIds;
        target.version += 1;
        target.editedAt = new Date().toISOString();
        target.updatedAt = target.editedAt;
        await this.recordMutation(route, `PATCH ${path}`);
        await route.fulfill({ json: { message: target } });
        return;
      }
      if (method === "PUT" && messageId && action === "reactions") {
        const target = this.messages.find(
          (message) => message.id === messageId
        );
        if (target)
          target.reactions = [
            {
              emoji: String(body?.emoji ?? "🎉"),
              count: body?.active ? 1 : 0,
              reacted: Boolean(body?.active)
            }
          ];
        await this.recordMutation(route, `PUT ${path}`);
        await route.fulfill({ json: { message: target } });
        return;
      }
    }
    if (path.endsWith("/read-state") && method === "PUT") {
      await this.recordMutation(route, `PUT ${path}`);
      await route.fulfill({ json: {} });
      return;
    }
    if (path === "/v1/collaboration/realtime/snapshot" && method === "POST") {
      await route.fulfill({
        json: {
          protocolVersion: 7,
          cursor: realtimeCursor,
          subscription: { id: ids.subscription },
          snapshot: { scope: "team", teamId: ids.team }
        }
      });
      return;
    }
    if (path === "/v1/collaboration/realtime/stream" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `event: ready\ndata: ${JSON.stringify({ protocolVersion: 7, subscription: { id: ids.subscription }, cursor: realtimeCursor })}\n\n`
      });
      return;
    }
    if (path === "/v1/collaboration/realtime/ack" && method === "POST") {
      await this.recordMutation(route, `POST ${path}`);
      await route.fulfill({ json: {} });
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      this.unexpectedMutations.push(`${method} ${path}`);
      await route.fulfill({
        status: 501,
        json: { error: "unhandled synthetic API mutation" }
      });
      return;
    }
    this.unexpectedReads.push(`${method} ${path}${url.search}`);
    await route.fulfill({
      json: {
        teams: [],
        threads: [],
        participants: [],
        projects: [],
        messages: [],
        items: [],
        requests: [],
        offers: [],
        hasMore: false,
        members: []
      }
    });
  }

  private activity(agentId: string) {
    if (agentId === ids.busyAgent)
      return {
        agentId,
        status: "running",
        availability: "available",
        freshness: "fresh",
        observedAt: new Date().toISOString(),
        runningAttempts: 1,
        persistedRunningAttempts: 1,
        activeJobsCount: 1,
        activeJobsTruncated: false,
        activeJobs: [syntheticLiveJob("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")],
        projectSummary: {
          projects: [
            {
              id: ids.launch,
              name: "Synthetic launch",
              status: "active",
              startedAt: new Date().toISOString()
            }
          ],
          count: 1,
          truncated: false
        }
      };
    if (agentId === ids.unknownAgent)
      return {
        agentId,
        status: "unknown",
        availability: "unavailable",
        freshness: "unknown",
        observedAt: null,
        runningAttempts: null,
        persistedRunningAttempts: null,
        activeJobsCount: null,
        activeJobsTruncated: false,
        activeJobs: []
      };
    return {
      agentId,
      status: "idle",
      availability: "available",
      freshness: "fresh",
      observedAt: new Date().toISOString(),
      runningAttempts: 0,
      persistedRunningAttempts: 0,
      activeJobsCount: 0,
      activeJobsTruncated: false,
      activeJobs: [],
      projectSummary: {
        projects: [
          {
            id: ids.launch,
            name: "Synthetic launch",
            status: "active",
            startedAt: new Date().toISOString()
          }
        ],
        count: 1,
        truncated: false
      }
    };
  }

  private detail(agentId: string) {
    const status = this.activity(agentId);
    return {
      jobsHasMore: true,
      jobsNextCursor: "synthetic_jobs_cursor_0001",
      stats: {
        projects: 1,
        projectsAvailable: true,
        runningNow: status.runningAttempts,
        totalJobs: 2,
        runningAttemptsMayBeStale: false
      },
      projects: [
        {
          id: ids.launch,
          name: "Synthetic launch",
          status: "active",
          startedAt: epoch
        }
      ],
      runningNow:
        status.status === "running"
          ? [
              syntheticJob(
                "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                "Synthetic active review",
                "running"
              )
            ]
          : [],
      jobs: [
        syntheticJob(
          "ffffffff-ffff-4fff-8fff-ffffffffffff",
          "Synthetic historical job",
          "completed"
        )
      ],
      highlights: []
    };
  }

  private async recordMutation(route: Route, identity: string): Promise<void> {
    this.mutationCounts.set(
      identity,
      (this.mutationCounts.get(identity) ?? 0) + 1
    );
  }
}

export async function installSyntheticApi(
  page: Page
): Promise<SyntheticStudioApi> {
  const api = new SyntheticStudioApi();
  await api.install(page);
  return api;
}

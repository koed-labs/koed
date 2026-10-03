import type { Page, Route } from "@playwright/test";
import type { TeamOverviewSnapshot, TeamAgentOffer } from "@koed/shared";
import realtimeCursorFixture from "./realtime-cursor.json";

export const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  team: "22222222-2222-4222-8222-222222222222",
  general: "33333333-3333-4333-8333-333333333333",
  launch: "44444444-4444-4444-8444-444444444444",
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
  subscription: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
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
  teamOverviewStatus = 200;
  readonly teamOffers = new Map<string, TeamAgentOffer>();
  readonly unexpectedMutations: string[] = [];
  readonly unexpectedReads: string[] = [];
  readonly mutationCounts = new Map<string, number>();
  readonly requestCounts = new Map<string, number>();
  private readonly agents = [
    agent(ids.busyAgent, "Busy Reviewer"),
    agent(ids.idleAgent, "Calm Reviewer"),
    agent(ids.retiredAgent, "Retired Reviewer", "retired"),
    agent(ids.unknownAgent, "Unknown Reviewer")
  ];
  private readonly detailHolds = new Map<string, HeldResponse>();
  private readonly jobsPageHolds = new Map<string, HeldResponse>();
  private readonly jobsPageAttempts = new Map<string, number>();
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
    if (
      path === "/v1/managed-conversations/launch-options" &&
      method === "GET"
    ) {
      await route.fulfill({ json: { runners: [], instances: [] } });
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
      await route.fulfill({
        json: this.teamOverview ?? {
          schemaVersion: "koed.team-overview/v1",
          access: { accountScope: ids.user, backendId: url.origin },
          generatedAt: now,
          nextCursor: null,
          teams: [{ teamId: ids.team, name: "Synthetic Team", badgeCount: 0 }],
          coverage: [
            { source: "message_attention", complete: true, nextCursor: null },
            { source: "agent_request", complete: true, nextCursor: null },
            { source: "team_job_action", complete: true, nextCursor: null },
            { source: "pull_request_action", complete: true, nextCursor: null },
            { source: "team_job_outcome", complete: true, nextCursor: null }
          ],
          attention: [],
          catchUp: [],
          currentJobOutcomes: [],
          cleared: [],
          badgeCount: 0
        }
      });
      return;
    }
    const overviewMutation = path.match(
      /^\/v1\/collaboration\/teams\/([^/]+)\/overview\/([^/]+)\/(clear|restore|seen)$/
    );
    if (overviewMutation && method === "POST") {
      const [, teamId, encodedId, action] = overviewMutation;
      const eventId = decodeURIComponent(encodedId);
      const feed = this.teamOverview;
      const body = request.postDataJSON() as { sourceRevision?: unknown };
      const item = [
        ...(feed?.attention ?? []),
        ...(feed?.cleared ?? []),
        ...(feed?.catchUp ?? [])
      ].find(
        (entry) => entry.sourceEventId === eventId && entry.teamId === teamId
      );
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
        feed.badgeCount = feed.attention.length;
        feed.teams = feed.teams.map((team) => ({
          ...team,
          badgeCount: feed.attention.filter(
            (entry) => entry.teamId === team.teamId
          ).length
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
            { userId: ids.user, displayName: "Synthetic user" },
            { userId: ids.teammate, displayName: "Synthetic teammate" }
          ]
        }
      });
      return;
    }
    if (
      [`${teamPrefix}/direct-messages`, `${teamPrefix}/projects`].includes(
        path
      ) &&
      method === "GET"
    ) {
      await route.fulfill({
        json: path.endsWith("/projects") ? { projects: [] } : { threads: [] }
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
    if (path.startsWith(`${teamPrefix}/agent-requests`) && method === "GET") {
      await route.fulfill({
        json: {
          teamId: ids.team,
          requests: [],
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

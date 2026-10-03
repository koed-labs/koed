import { describe, expect, it, vi } from "vitest";
import {
  homeFeedSchemaVersion,
  teamOverviewSchemaVersion,
  type HomeSnapshot,
  type TeamOverviewSnapshot
} from "@koed/shared";
import {
  createStudioNotificationAuthority,
  type StudioNotificationMessageAuthority
} from "./studio-notification-authority.js";

const ids = {
  team: "11111111-1111-4111-8111-111111111111",
  thread: "22222222-2222-4222-8222-222222222222",
  message: "33333333-3333-4333-8333-333333333333",
  execution: "44444444-4444-4444-8444-444444444444",
  principal: "55555555-5555-4555-8555-555555555555"
};
const at = "2026-10-02T12:00:00.000Z";
const teamSnapshot = (
  scope = "team-scope",
  input: {
    attention?: TeamOverviewSnapshot["attention"];
    nextCursor?: string | null;
  } = {}
): TeamOverviewSnapshot => ({
  schemaVersion: teamOverviewSchemaVersion,
  access: { accountScope: scope, backendId: null },
  generatedAt: at,
  teams: [{ teamId: ids.team, name: "Team", badgeCount: 1 }],
  coverage: (
    [
      "message_attention",
      "agent_request",
      "team_job_action",
      "team_job_outcome",
      "pull_request_action"
    ] as const
  ).map((source) => ({ source, complete: true, nextCursor: null })),
  currentJobOutcomes: [],
  attention: input.attention ?? [
    {
      sourceEventId: "dm:thread",
      source: "message_attention",
      sourceId: ids.thread,
      sourceRevision: "g1abc",
      teamId: ids.team,
      teamName: "Team",
      kind: "message",
      priority: "attention",
      state: "recent",
      title: "private title ignored",
      summary: "private body ignored",
      updatedAt: at,
      unreadCount: 1,
      destination: {
        kind: "thread",
        threadId: ids.thread,
        rootMessageId: null
      }
    }
  ],
  catchUp: [],
  cleared: [],
  nextCursor: input.nextCursor ?? null,
  badgeCount: (input.attention ?? [1]).length
});
const homeSnapshot = (
  input: {
    needsYou?: HomeSnapshot["needsYou"];
    nextCursor?: string | null;
  } = {}
): HomeSnapshot => ({
  schemaVersion: homeFeedSchemaVersion,
  accountScope: "home-scope",
  generatedAt: at,
  coverage: [
    {
      source: "managed_runtime_item",
      complete: input.nextCursor === null,
      nextCursor: input.nextCursor ?? null
    }
  ],
  needsYou: input.needsYou ?? [
    {
      sourceEventId: "runtime:one",
      source: "managed_runtime_item",
      sourceId: "runtime-one",
      sourceRevision: "r1",
      kind: "question",
      state: "blocked",
      title: "private title ignored",
      summary: "private summary ignored",
      updatedAt: at,
      destination: { kind: "execution", executionId: ids.execution }
    }
  ],
  cleared: [],
  ongoing: [],
  recent: [],
  badgeCount: 1
});
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
const teamIntent = {
  version: 1 as const,
  source: "team_overview" as const,
  accountScope: "team-scope",
  backendId: null,
  sourceEventId: "dm:thread",
  sourceRevision: "g1abc",
  messageId: ids.message
};

const authorityFor = (input: {
  snapshots: TeamOverviewSnapshot[];
  message?: StudioNotificationMessageAuthority;
}) => {
  let index = 0;
  const requestedUrls: string[] = [];
  const fetchImpl = vi.fn(async (request: RequestInfo | URL) => {
    requestedUrls.push(String(request));
    return response(input.snapshots[index++]);
  });
  const loadTeamMessage = vi.fn(
    async () =>
      input.message ?? {
        principalId: ids.principal,
        isDirectMessage: true,
        message: {
          id: ids.message,
          scope: "team" as const,
          teamId: ids.team,
          senderKind: "user" as const,
          senderId: "66666666-6666-4666-8666-666666666666",
          mentionUserIds: [ids.principal]
        }
      }
  );
  return {
    authority: createStudioNotificationAuthority({
      getAccess: async () => ({
        apiOrigin: "http://127.0.0.1:43300",
        apiToken: "secret"
      }),
      fetchImpl,
      loadTeamMessage
    }),
    fetchImpl,
    requestedUrls,
    loadTeamMessage
  };
};

describe("Studio notification authority", () => {
  it("re-reads authenticated Home and derives only safe route/classification", async () => {
    const requestedUrls: string[] = [];
    const responses = [
      response({ accountScope: "home-scope", backendId: "home-backend" }),
      response(homeSnapshot())
    ];
    const fetchImpl = vi.fn(async (request: RequestInfo | URL) => {
      requestedUrls.push(String(request));
      return responses.shift()!;
    });
    const authority = createStudioNotificationAuthority({
      getAccess: async () => ({
        apiOrigin: "http://127.0.0.1:43300",
        apiToken: "secret"
      }),
      fetchImpl,
      loadTeamMessage: async () => {
        throw new Error("not used by Home");
      }
    });
    await expect(
      authority.resolve({
        version: 1,
        source: "home",
        accountScope: "home-scope",
        backendId: "home-backend",
        sourceEventId: "runtime:one",
        sourceRevision: "r1"
      })
    ).resolves.toMatchObject({
      classification: "agent_input",
      destination: { kind: "execution", executionId: ids.execution }
    });
    expect(requestedUrls).toEqual([
      "http://127.0.0.1:43300/v1/home/access",
      "http://127.0.0.1:43300/v1/home?source=managed_runtime_item&limit=100"
    ]);
  });

  it("checks a bounded second source-specific Home page", async () => {
    const empty = homeSnapshot({ needsYou: [], nextCursor: "next-home-page" });
    const requestedUrls: string[] = [];
    const responses = [
      response({ accountScope: "home-scope", backendId: "home-backend" }),
      response(empty),
      response(homeSnapshot())
    ];
    const fetchImpl = vi.fn(async (request: RequestInfo | URL) => {
      requestedUrls.push(String(request));
      return responses.shift()!;
    });
    const authority = createStudioNotificationAuthority({
      getAccess: async () => ({
        apiOrigin: "http://127.0.0.1:43300",
        apiToken: "secret"
      }),
      fetchImpl,
      loadTeamMessage: async () => {
        throw new Error("not used by Home");
      }
    });
    await expect(
      authority.resolve({
        version: 1,
        source: "home",
        accountScope: "home-scope",
        backendId: "home-backend",
        sourceEventId: "runtime:one",
        sourceRevision: "r1"
      })
    ).resolves.toMatchObject({ classification: "agent_input" });
    expect(requestedUrls).toEqual([
      "http://127.0.0.1:43300/v1/home/access",
      "http://127.0.0.1:43300/v1/home?source=managed_runtime_item&limit=100",
      "http://127.0.0.1:43300/v1/home?source=managed_runtime_item&limit=100&cursor=next-home-page"
    ]);
  });

  it("distinguishes explicit mention from an ordinary direct message", async () => {
    const mentioned = authorityFor({
      snapshots: [teamSnapshot(), teamSnapshot()]
    });
    await expect(
      mentioned.authority.resolve(teamIntent)
    ).resolves.toMatchObject({
      classification: "mention",
      destination: {
        kind: "team_thread",
        teamId: ids.team,
        threadId: ids.thread,
        messageId: ids.message
      }
    });
    const ordinary = authorityFor({
      snapshots: [teamSnapshot(), teamSnapshot()],
      message: {
        principalId: ids.principal,
        isDirectMessage: true,
        message: {
          id: ids.message,
          scope: "team",
          teamId: ids.team,
          senderKind: "user",
          senderId: "66666666-6666-4666-8666-666666666666",
          mentionUserIds: []
        }
      }
    });
    await expect(ordinary.authority.resolve(teamIntent)).resolves.toMatchObject(
      {
        classification: "direct_message"
      }
    );
  });

  it("checks a bounded second Team overview page before and after message authority", async () => {
    const firstPage = teamSnapshot("team-scope", {
      attention: [],
      nextCursor: "team-cursor"
    });
    const { authority, fetchImpl, requestedUrls } = authorityFor({
      snapshots: [firstPage, teamSnapshot(), firstPage, teamSnapshot()]
    });
    await expect(authority.resolve(teamIntent)).resolves.toMatchObject({
      classification: "mention"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(requestedUrls).toEqual([
      "http://127.0.0.1:43300/v1/collaboration/teams/overview?limit=100",
      "http://127.0.0.1:43300/v1/collaboration/teams/overview?limit=100&cursor=team-cursor",
      "http://127.0.0.1:43300/v1/collaboration/teams/overview?limit=100",
      "http://127.0.0.1:43300/v1/collaboration/teams/overview?limit=100&cursor=team-cursor"
    ]);
  });

  it("rejects account or event changes during the separate broker message read", async () => {
    const accountChanged = authorityFor({
      snapshots: [teamSnapshot(), teamSnapshot("different-account")]
    });
    await expect(
      accountChanged.authority.resolve(teamIntent)
    ).resolves.toBeNull();
    const revisionChanged = teamSnapshot();
    revisionChanged.attention[0]!.sourceRevision = "g2new";
    const eventChanged = authorityFor({
      snapshots: [teamSnapshot(), revisionChanged]
    });
    await expect(
      eventChanged.authority.resolve(teamIntent)
    ).resolves.toBeNull();
  });
});

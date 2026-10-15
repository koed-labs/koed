import { expect, test } from "@playwright/test";
import { ids, installSyntheticApi } from "./fixtures/synthetic-studio-api";

const openTeam = async (page: Parameters<typeof installSyntheticApi>[0]) => {
  await page.setViewportSize({ width: 1600, height: 560 });
  await page.goto(`/studio/collaboration?team=${ids.team}`);
  await expect(
    page.getByRole("button", { name: "general", exact: true }).first()
  ).toBeVisible();
  await expect(
    page.getByPlaceholder("Message #general", { exact: true })
  ).toBeVisible();
  await waitForRealtime(page);
};

const waitForRealtime = async (
  page: Parameters<typeof installSyntheticApi>[0]
) => {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __syntheticRealtimeDebug?: { streamResponses: number };
            }
          ).__syntheticRealtimeDebug?.streamResponses ?? 0
      )
    )
    .toBeGreaterThan(0);
};

test("Team reply drafts stay scoped through channel changes and reload, and sends apply once", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  await openTeam(page);
  await expect
    .poll(
      () =>
        api.requestCounts.get("POST /v1/collaboration/realtime/snapshot") ?? 0
    )
    .toBeGreaterThan(0);
  const teamNavigation = page.getByRole("navigation", {
    name: "Team navigation"
  });
  await expect(teamNavigation).toBeVisible();
  const channelComposer = page.getByPlaceholder("Message #general", {
    exact: true
  });
  await expect(
    page.getByText(/Your @Agent message is sent to this channel/)
  ).toBeVisible();
  const generalNavigation = teamNavigation.getByRole("button", {
    name: "general"
  });
  await generalNavigation.focus();
  await generalNavigation.press("Enter");
  await expect(channelComposer).toBeVisible();
  const messageRail = page.getByRole("navigation", {
    name: "Your messages in this conversation"
  });
  const firstJump = messageRail.getByRole("button", {
    name: "Jump to your message 1: Synthetic channel message"
  });
  const secondJump = messageRail.getByRole("button", {
    name: /Jump to your message 2: Synthetic second human message/
  });
  await expect(firstJump).toBeVisible();
  await expect(secondJump).toBeVisible();
  await secondJump.focus();
  await secondJump.press("Enter");
  await expect(secondJump).toHaveAttribute("aria-current", "location");
  await expect(firstJump).not.toHaveAttribute("aria-current", "location");
  await firstJump.focus();
  await firstJump.press("Enter");
  await expect(firstJump).toHaveAttribute("aria-current", "location");
  await expect(secondJump).not.toHaveAttribute("aria-current", "location");
  await waitForRealtime(page);
  const root = page.locator(`[data-message-id="${ids.root}"]`);
  await expect(root).toContainText("Synthetic channel message");
  await root
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  const threadRoot = page.locator(`[data-thread-message-id="${ids.root}"]`);
  await threadRoot.hover();
  await expect(
    threadRoot.getByRole("button", { name: "Edit", exact: true })
  ).toBeVisible();
  await expect(
    page
      .locator(`[data-thread-message-id="${ids.reply}"]`)
      .getByRole("button", { name: "Edit", exact: true })
  ).toHaveCount(0);

  const reply = page.getByPlaceholder("Reply in thread...", { exact: true });
  await expect(reply).toBeVisible();
  const draft = "Synthetic private thread draft";
  await reply.fill(draft);

  await page.getByRole("button", { name: "launch", exact: true }).click();
  await expect(
    page.getByPlaceholder("Message #launch", { exact: true })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "general", exact: true })
    .first()
    .click();
  await page
    .locator(`[data-message-id="${ids.root}"]`)
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  await expect(
    page.getByPlaceholder("Reply in thread...", { exact: true })
  ).toHaveValue(draft);

  await page.reload();
  await waitForRealtime(page);
  await page
    .getByRole("button", { name: "general", exact: true })
    .first()
    .click();
  await waitForRealtime(page);
  await page
    .locator(`[data-message-id="${ids.root}"]`)
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  const restored = page.getByPlaceholder("Reply in thread...", { exact: true });
  await expect(restored).toHaveValue(draft);
  const sentText = "Synthetic one-time reply";
  await restored.fill(sentText);
  await page.getByRole("button", { name: "Send message" }).last().click();
  await expect(
    page
      .locator(
        "[data-thread-message-id]:not([data-thread-pending-client-message-id])"
      )
      .getByText(sentText, { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Pending · saved on this device.", { exact: true })
  ).toHaveCount(0);

  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
  const messageWrites = [...api.mutationCounts.entries()].filter(
    ([path]) =>
      path.startsWith("POST /") &&
      path.includes("/collaboration/teams/") &&
      path.endsWith("/messages")
  );
  expect(
    messageWrites,
    JSON.stringify({
      mutations: [...api.mutationCounts],
      requests: [...api.requestCounts]
    })
  ).toEqual([
    [
      `POST /v1/collaboration/teams/${ids.team}/threads/${ids.general}/messages`,
      1
    ]
  ]);
});

test("shared composer switches from human formatting to Agent execution controls", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  await openTeam(page);
  const composer = page.getByPlaceholder("Message #general", { exact: true });
  await expect(
    page.getByRole("toolbar", { name: "Message formatting" }).last()
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Bold", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select execution access" })
  ).toHaveCount(0);
  await composer.fill("@Busy");
  const busyAgent = page
    .getByRole("listbox", { name: "Mention someone" })
    .getByRole("option", { name: /Busy Reviewer/ });
  await expect(busyAgent).toBeVisible();
  await busyAgent.click();
  await expect(
    page.getByRole("toolbar", { name: "Message formatting" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Select execution access" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select model and effort" })
  ).toBeVisible();
  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
});

test("an offline reply is queued, retried exactly once, and leaves later typing intact", async ({
  page,
  context
}) => {
  const api = await installSyntheticApi(page);
  await openTeam(page);
  await page
    .locator(`[data-message-id="${ids.root}"]`)
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  const reply = page.getByPlaceholder("Reply in thread...", { exact: true });
  const queued = "Synthetic offline reply";

  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await reply.fill(queued);
  await reply.press("Enter");
  await expect(
    page.getByText("Pending · saved on this device.", { exact: true })
  ).toBeVisible();

  const laterDraft = "Synthetic later unsent draft";
  await reply.fill(laterDraft);
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  await expect(
    page
      .locator(
        "[data-thread-message-id]:not([data-thread-pending-client-message-id])"
      )
      .getByText(queued, { exact: true })
  ).toBeVisible({ timeout: 15_000 });
  await expect(reply).toHaveValue(laterDraft, { timeout: 15_000 });

  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
  const messageWrites = [...api.mutationCounts.entries()].filter(
    ([path]) =>
      path.startsWith("POST /") &&
      path.includes("/collaboration/teams/") &&
      path.endsWith("/messages")
  );
  expect(
    messageWrites,
    JSON.stringify({
      requests: [...api.requestCounts],
      stream: await page.evaluate(
        () =>
          (window as Window & { __syntheticRealtimeDebug?: unknown })
            .__syntheticRealtimeDebug
      )
    })
  ).toEqual([
    [
      `POST /v1/collaboration/teams/${ids.team}/threads/${ids.general}/messages`,
      1
    ]
  ]);
});

const overviewMessage = {
  sourceEventId: "message:synthetic-thread",
  source: "message_attention" as const,
  sourceId: ids.general,
  sourceRevision: "1",
  teamId: ids.team,
  teamName: "Synthetic Team",
  kind: "message" as const,
  priority: "attention" as const,
  state: "blocked" as const,
  title: "Replies in #general",
  summary: "Latest relevant reply",
  updatedAt: "2026-10-02T12:00:00.000Z",
  unreadCount: 5,
  destination: {
    kind: "thread" as const,
    threadId: ids.general,
    rootMessageId: ids.root
  }
};
const overviewOutcome = {
  sourceEventId: "outcome:synthetic-job",
  source: "team_job_outcome" as const,
  sourceId: ids.olderJob,
  sourceRevision: "1",
  teamId: ids.team,
  teamName: "Synthetic Team",
  kind: "job_outcome" as const,
  priority: "attention" as const,
  state: "recent" as const,
  title: "Synthetic Project work completed",
  summary: "Published Team outcome",
  updatedAt: "2026-10-02T12:00:00.000Z",
  destination: {
    kind: "team_job" as const,
    publicationId: ids.olderJob,
    jobId: ids.root,
    teamProjectId: ids.launch
  }
};
const overviewNativeAction = {
  sourceEventId: "agent-action:synthetic-publication",
  source: "team_agent_action" as const,
  sourceId: ids.nativePublication,
  sourceRevision: "native-action:2",
  teamId: ids.team,
  teamName: "Synthetic Team",
  kind: "agent_action" as const,
  priority: "blocker" as const,
  state: "blocked" as const,
  title: "Native Agent work needs your attention",
  summary: "A next step shared with the Team is waiting.",
  updatedAt: "2026-10-02T12:00:00.000Z",
  destination: {
    kind: "team_agent_work" as const,
    publicationId: ids.nativePublication,
    teamProjectId: ids.launch
  }
};
const overviewNativeOutcome = {
  sourceEventId: "agent-outcome:synthetic-publication",
  source: "team_agent_outcome" as const,
  sourceId: ids.nativePublication,
  sourceRevision: "native-outcome:3",
  teamId: ids.team,
  teamName: "Synthetic Team",
  kind: "agent_outcome" as const,
  priority: "attention" as const,
  state: "recent" as const,
  title: "Native Agent work completed",
  summary: "A concise outcome shared with the Team.",
  updatedAt: "2026-10-02T12:00:00.000Z",
  destination: {
    kind: "team_agent_work" as const,
    publicationId: ids.nativePublication,
    teamProjectId: ids.launch
  }
};
function overviewFixture() {
  return {
    schemaVersion: "koed.team-overview/v1" as const,
    access: { accountScope: ids.user, backendId: "synthetic-backend" },
    generatedAt: "2026-10-02T12:00:00.000Z",
    nextCursor: null,
    teams: [{ teamId: ids.team, name: "Synthetic Team", badgeCount: 1 }],
    coverage: [
      "message_attention",
      "agent_request",
      "team_job_action",
      "team_job_outcome",
      "team_agent_action",
      "team_agent_outcome",
      "pull_request_action"
    ].map((source) => ({
      source: source as
        | "message_attention"
        | "agent_request"
        | "team_job_action"
        | "team_job_outcome"
        | "team_agent_action"
        | "team_agent_outcome"
        | "pull_request_action",
      complete: true,
      nextCursor: null
    })),
    currentJobOutcomes: [
      {
        teamId: overviewOutcome.teamId,
        sourceEventId: overviewOutcome.sourceEventId,
        sourceRevision: overviewOutcome.sourceRevision
      }
    ],
    attention: [{ ...overviewMessage }],
    catchUp: [],
    cleared: [],
    badgeCount: 1
  };
}

test("Team overview groups attention, clears exact reminders and opens the original thread", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  api.teamOverview = overviewFixture();
  await openTeam(page);
  await page.getByRole("button", { name: /For you/ }).click();
  const row = page.locator(
    '[data-team-overview-event="message:synthetic-thread"]'
  );
  await expect(row).toBeVisible();
  await expect(row).toContainText("5 unread messages");
  await expect(page.getByText("1 grouped item needs you.")).toBeVisible();
  const readCount = [...api.requestCounts]
    .filter(([key]) => key.includes("read-state"))
    .reduce((sum, [, count]) => sum + count, 0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(row).toBeVisible();
  expect(
    [...api.requestCounts]
      .filter(([key]) => key.includes("read-state"))
      .reduce((sum, [, count]) => sum + count, 0)
  ).toBe(readCount);
  await row.getByRole("button", { name: "Clear reminder" }).click();
  await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();
  await page.getByText("Cleared reminders", { exact: false }).click();
  await row.getByRole("button", { name: "Restore reminder" }).click();
  await expect(page.getByText("1 grouped item needs you.")).toBeVisible();
  await row.getByRole("button", { name: "Open", exact: true }).click();
  await expect(
    page.getByPlaceholder("Reply in thread...", { exact: true })
  ).toBeVisible();
  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
});

test("Team overview retains verified offline rows, then purges attention and seen outcomes on access loss", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  api.teamOverview = {
    ...overviewFixture(),
    catchUp: [{ ...overviewOutcome }],
    currentJobOutcomes: [
      {
        teamId: overviewOutcome.teamId,
        sourceEventId: overviewOutcome.sourceEventId,
        sourceRevision: overviewOutcome.sourceRevision
      }
    ]
  };
  await openTeam(page);
  await page.getByRole("button", { name: /For you/ }).click();
  const messageRow = page.locator(
    '[data-team-overview-event="message:synthetic-thread"]'
  );
  const outcomeRow = page.locator(
    '[data-team-overview-event="outcome:synthetic-job"]'
  );
  await expect(messageRow).toBeVisible();
  await expect(outcomeRow).toBeVisible();
  await expect
    .poll(
      () => api.mutationCounts.get("overview:outcome:synthetic-job:seen") ?? 0
    )
    .toBe(1);
  await expect(outcomeRow).toBeVisible();
  api.teamOverviewStatus = 503;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Offline · may be out of date")).toBeVisible();
  await expect(
    messageRow.getByRole("button", { name: "Open", exact: true })
  ).toBeDisabled();
  await expect(
    messageRow.getByRole("button", { name: "Clear reminder" })
  ).toBeDisabled();
  api.teamOverviewStatus = 401;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(messageRow).toHaveCount(0);
  await expect(outcomeRow).toHaveCount(0);
  await expect(page.getByText(/Team access changed/)).toBeVisible();
  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
});

test("native Team Agent activity routes to its Public Square publication and keeps a visible outcome for this visit", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  api.teamOverview = {
    ...overviewFixture(),
    teams: [{ teamId: ids.team, name: "Synthetic Team", badgeCount: 1 }],
    attention: [{ ...overviewNativeAction }],
    catchUp: [{ ...overviewNativeOutcome }],
    currentJobOutcomes: [
      {
        teamId: overviewNativeOutcome.teamId,
        sourceEventId: overviewNativeOutcome.sourceEventId,
        sourceRevision: overviewNativeOutcome.sourceRevision
      }
    ],
    badgeCount: 1
  };
  await openTeam(page);
  await page.getByRole("button", { name: /For you/ }).click();
  const actionRow = page.locator(
    '[data-team-overview-event="agent-action:synthetic-publication"]'
  );
  const outcomeRow = page.locator(
    '[data-team-overview-event="agent-outcome:synthetic-publication"]'
  );
  await expect(actionRow).toBeVisible();
  await expect(outcomeRow).toBeVisible();
  await expect
    .poll(
      () =>
        api.mutationCounts.get(
          "overview:agent-outcome:synthetic-publication:seen"
        ) ?? 0
    )
    .toBe(1);
  await expect(outcomeRow).toBeVisible();
  api.teamOverview.currentJobOutcomes = [];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(outcomeRow).toHaveCount(0);
  await actionRow.getByRole("button", { name: "Open", exact: true }).click();
  await expect(
    page.getByText("A Team-visible native publication.", { exact: true })
  ).toBeVisible();
  await expect(
    page.locator(`#public-square-item-${ids.nativePublication}`)
  ).toBeVisible();
  expect(page.url()).not.toContain("chat=1");
  expect(
    [...api.requestCounts.keys()].filter(
      (path) =>
        path.includes("managed-conversations") && path.endsWith("/create")
    )
  ).toEqual([]);
  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
});

test("Team overview keeps identical source events separate across Teams and pages", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  const sharedAction = (teamId: string, teamName: string) => ({
    sourceEventId: "pr-op:shared-review",
    source: "pull_request_action" as const,
    sourceId: "shared-review",
    sourceRevision: "review:4",
    teamId,
    teamName,
    kind: "pull_request_action" as const,
    priority: "attention" as const,
    state: "blocked" as const,
    title: "Review shared pull request",
    summary: "The same review is visible through two Team connections.",
    updatedAt: "2026-10-02T12:00:00.000Z",
    destination: {
      kind: "pull_request_review" as const,
      reviewId: ids.nativePublication,
      repositoryId: "synthetic/repository",
      number: 42
    }
  });
  const sharedOutcome = (teamId: string, teamName: string) => ({
    sourceEventId: "agent-outcome:shared-publication",
    source: "team_agent_outcome" as const,
    sourceId: ids.nativePublication,
    sourceRevision: "native-outcome:8",
    teamId,
    teamName,
    kind: "agent_outcome" as const,
    priority: "attention" as const,
    state: "recent" as const,
    title: "Shared Agent work completed",
    summary: "A concise Team-visible outcome.",
    updatedAt: "2026-10-02T12:00:00.000Z",
    destination: {
      kind: "team_agent_work" as const,
      publicationId: ids.nativePublication,
      teamProjectId: ids.launch
    }
  });
  const teams = [
    { teamId: ids.team, name: "Synthetic Team", badgeCount: 1 },
    { teamId: ids.secondTeam, name: "Second Synthetic Team", badgeCount: 1 }
  ];
  const teamOneOutcome = sharedOutcome(ids.team, "Synthetic Team");
  const teamTwoOutcome = sharedOutcome(ids.secondTeam, "Second Synthetic Team");
  const teamOneOutcomeRef = {
    teamId: teamOneOutcome.teamId,
    sourceEventId: teamOneOutcome.sourceEventId,
    sourceRevision: teamOneOutcome.sourceRevision
  };
  const teamTwoOutcomeRef = {
    teamId: teamTwoOutcome.teamId,
    sourceEventId: teamTwoOutcome.sourceEventId,
    sourceRevision: teamTwoOutcome.sourceRevision
  };
  api.teamOverview = {
    ...overviewFixture(),
    nextCursor: "second-team-page",
    teams,
    attention: [sharedAction(ids.team, "Synthetic Team")],
    catchUp: [teamOneOutcome],
    currentJobOutcomes: [teamOneOutcomeRef],
    badgeCount: 2
  };
  api.teamOverviewPage2 = {
    ...overviewFixture(),
    nextCursor: null,
    teams,
    attention: [sharedAction(ids.secondTeam, "Second Synthetic Team")],
    catchUp: [teamTwoOutcome],
    currentJobOutcomes: [teamOneOutcomeRef, teamTwoOutcomeRef],
    badgeCount: 2
  };

  await openTeam(page);
  await page.getByRole("button", { name: /For you/ }).click();
  const row = (teamId: string, eventId: string) =>
    page.locator(
      `[data-team-overview-team="${teamId}"][data-team-overview-event="${eventId}"]`
    );
  const teamOneAction = row(ids.team, "pr-op:shared-review");
  const teamTwoAction = row(ids.secondTeam, "pr-op:shared-review");
  const teamOneOutcomeRow = row(ids.team, "agent-outcome:shared-publication");
  const teamTwoOutcomeRow = row(
    ids.secondTeam,
    "agent-outcome:shared-publication"
  );
  await expect(teamOneAction).toBeVisible();
  await expect(teamOneOutcomeRow).toBeVisible();
  await expect
    .poll(
      () =>
        api.mutationCounts.get(
          "overview:agent-outcome:shared-publication:seen"
        ) ?? 0
    )
    .toBe(1);

  await page.getByRole("button", { name: "Load more Team activity" }).click();
  await expect(teamTwoAction).toBeVisible();
  await expect(teamTwoOutcomeRow).toBeVisible();
  await teamTwoOutcomeRow.scrollIntoViewIfNeeded();
  await expect
    .poll(
      () =>
        api.mutationCounts.get(
          "overview:agent-outcome:shared-publication:seen"
        ) ?? 0
    )
    .toBe(2);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(teamOneOutcomeRow).toBeVisible();
  await expect(teamTwoOutcomeRow).toBeVisible();

  api.teamOverview.currentJobOutcomes = [teamTwoOutcomeRef];
  api.teamOverviewPage2.currentJobOutcomes = [teamTwoOutcomeRef];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(teamOneOutcomeRow).toHaveCount(0);
  await expect(teamTwoOutcomeRow).toBeVisible();
  await expect(teamTwoAction).toBeVisible();

  await teamOneAction.getByRole("button", { name: "Clear reminder" }).click();
  await expect(teamTwoAction).toBeVisible();
  await page.getByText("Cleared reminders", { exact: false }).click();
  await expect(
    teamOneAction.getByRole("button", { name: "Restore reminder" })
  ).toBeVisible();
  await expect(
    teamTwoAction.getByRole("button", { name: "Clear reminder" })
  ).toBeVisible();

  const actionWrites = [...api.requestCounts.entries()].filter(
    ([path]) =>
      path.includes("/overview/pr-op%3Ashared-review/clear") ||
      path.includes("/overview/pr-op:shared-review/clear")
  );
  expect(actionWrites).toEqual([
    [
      `POST /v1/collaboration/teams/${ids.team}/overview/pr-op%3Ashared-review/clear`,
      1
    ]
  ]);
  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
});

test("a seen outcome is removed when its publication loses access within the same Team", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  api.teamOverview = {
    ...overviewFixture(),
    catchUp: [{ ...overviewOutcome }],
    currentJobOutcomes: [
      {
        teamId: overviewOutcome.teamId,
        sourceEventId: overviewOutcome.sourceEventId,
        sourceRevision: overviewOutcome.sourceRevision
      }
    ]
  };
  await openTeam(page);
  await page.getByRole("button", { name: /For you/ }).click();
  const outcome = page.locator(
    '[data-team-overview-event="outcome:synthetic-job"]'
  );
  await expect
    .poll(
      () => api.mutationCounts.get("overview:outcome:synthetic-job:seen") ?? 0
    )
    .toBe(1);
  await expect(outcome).toBeVisible();
  api.teamOverview.currentJobOutcomes = [];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(outcome).toHaveCount(0);
  await expect(
    page.locator('[data-team-overview-event="message:synthetic-thread"]')
  ).toBeVisible();
  expect(api.unexpectedReads).toEqual([]);
  expect(api.unexpectedMutations).toEqual([]);
});

test("Team filters use grouped attention counts and ordinary catch-up adds no badge", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  const secondTeam = "20202020-2020-4202-8202-202020202020";
  const secondary = {
    ...overviewMessage,
    sourceEventId: "message:other-team",
    teamId: secondTeam,
    teamName: "Other Team",
    title: "Other Team direct message",
    unreadCount: 1
  };
  const catchUp = {
    ...overviewMessage,
    sourceEventId: "message:ordinary",
    state: "recent" as const,
    title: "Ordinary channel catch-up",
    unreadCount: 12
  };
  api.teamOverview = {
    ...overviewFixture(),
    teams: [
      { teamId: ids.team, name: "Synthetic Team", badgeCount: 1 },
      { teamId: secondTeam, name: "Other Team", badgeCount: 1 }
    ],
    attention: [{ ...overviewMessage }, secondary],
    catchUp: [catchUp],
    badgeCount: 2
  };
  await openTeam(page);
  await page.getByRole("button", { name: /For you/ }).click();
  const filters = page.getByRole("navigation", { name: "Filter by Team" });
  await expect(
    filters.getByRole("button", { name: "All teams 2" })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("2 grouped items need you.")).toBeVisible();
  await expect(page.getByText("Ordinary channel catch-up")).toBeVisible();
  await filters.getByRole("button", { name: "Other Team 1" }).click();
  await expect(page.getByText("Other Team direct message")).toBeVisible();
  await expect(
    page.getByText("Replies in #general", { exact: true })
  ).toHaveCount(0);
  await expect(page.getByText("Ordinary channel catch-up")).toHaveCount(0);
  await expect(page.getByText("1 grouped item needs you.")).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByText("Other Team direct message")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  api.teamOverview = {
    ...api.teamOverview,
    teams: [{ teamId: ids.team, name: "Synthetic Team", badgeCount: 1 }],
    attention: [{ ...overviewMessage }],
    badgeCount: 1
  };
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Other Team direct message")).toHaveCount(0);
  await expect(
    page.getByText("Replies in #general", { exact: true })
  ).toBeVisible();
  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
});

test("human @ mentions send selected Team user IDs and edits preserve them", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  const sentBodies: Array<Record<string, unknown>> = [];
  const editResponses: Array<Record<string, unknown>> = [];
  let sentMessageId = "";
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes(`/v1/collaboration/teams/${ids.team}/threads/`) &&
      request.url().endsWith("/messages")
    ) {
      sentBodies.push(
        JSON.parse(request.postData() ?? "{}") as Record<string, unknown>
      );
    }
  });
  page.on("response", async (response) => {
    if (
      response.request().method() === "POST" &&
      response.url().includes(`/v1/collaboration/teams/${ids.team}/threads/`) &&
      response.url().endsWith("/messages")
    ) {
      const payload = (await response.json().catch(() => null)) as {
        message?: { id?: string };
      } | null;
      sentMessageId = payload?.message?.id ?? sentMessageId;
    }
    if (
      response.request().method() === "PATCH" &&
      response.url().includes(`/v1/collaboration/teams/${ids.team}/threads/`) &&
      response.url().endsWith(`/messages/${sentMessageId}`)
    ) {
      const payload = (await response.json().catch(() => null)) as {
        message?: Record<string, unknown>;
      } | null;
      if (payload?.message) editResponses.push(payload.message);
    }
  });
  await openTeam(page);
  await page
    .locator(`[data-message-id="${ids.root}"]`)
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  const composer = page.getByPlaceholder("Reply in thread...", { exact: true });
  await composer.fill("Please review @Synth");
  const teammateOption = page
    .getByRole("listbox", { name: "Mention someone" })
    .getByRole("option", { name: /Synthetic teammate/ });
  await expect(teammateOption).toBeVisible();
  await teammateOption.click();
  const submittedText = "Please review @synthetic_teammate_bbbbbbbb";
  await expect(composer).toHaveValue(`${submittedText} `);
  await expect(
    page.getByRole("toolbar", { name: "Message formatting" }).last()
  ).toBeVisible();
  await page.waitForTimeout(300);
  await page.reload();
  await openTeam(page);
  await page
    .locator(`[data-message-id="${ids.root}"]`)
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  await expect(composer).toHaveValue(`${submittedText} `);
  await composer.press("Enter");
  await expect.poll(() => sentBodies.length).toBe(1);
  expect(sentBodies[0]).toMatchObject({
    bodyText: submittedText,
    rootMessageId: ids.root,
    mentionUserIds: [ids.teammate]
  });
  await expect.poll(() => sentMessageId).not.toBe("");
  const sentRow = page.locator(`[data-thread-message-id="${sentMessageId}"]`);
  await expect(sentRow.getByText(submittedText, { exact: true })).toBeVisible();
  await sentRow.hover();
  await sentRow.getByRole("button", { name: "Edit", exact: true }).click();
  const editText = page.getByRole("textbox", { name: "Edit message" });
  await editText.fill(`${submittedText}!`);
  await sentRow.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(
    sentRow.getByText(`${submittedText}!`, { exact: true })
  ).toBeVisible();
  await expect.poll(() => editResponses.length).toBe(1);
  expect(editResponses[0]?.mentionUserIds).toEqual([ids.teammate]);
  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
});

test("direct messages route only current participant Agents and keep human mentions", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  const directMessageBodies: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request
        .url()
        .includes(
          `/v1/collaboration/teams/${ids.team}/threads/${ids.directMessage}/messages`
        )
    ) {
      directMessageBodies.push(
        JSON.parse(request.postData() ?? "{}") as Record<string, unknown>
      );
    }
  });
  api.teamOffers.set(ids.teammateAgent, {
    teamId: ids.team,
    agentId: ids.teammateAgent,
    ownerId: ids.teammate,
    ownerName: "Synthetic teammate",
    agentName: "Mira Analyst",
    description: "A teammate-owned Agent.",
    enabled: true,
    version: 1,
    canManage: false
  });
  api.teamOffers.set(ids.otherTeammateAgent, {
    teamId: ids.team,
    agentId: ids.otherTeammateAgent,
    ownerId: ids.otherTeammate,
    ownerName: "Other teammate",
    agentName: "Excluded Agent",
    description: "An Agent owned by a former participant.",
    enabled: true,
    version: 1,
    canManage: false
  });

  await openTeam(page);
  const teamNavigation = page.getByRole("navigation", {
    name: "Team navigation"
  });
  await teamNavigation
    .getByRole("button", { name: "Synthetic teammate", exact: true })
    .click();
  const composer = page.getByPlaceholder("Message Synthetic teammate", {
    exact: true
  });
  await expect(composer).toBeVisible();
  await expect(
    page.getByText(/Agents work privately; owners choose what to share here/)
  ).toBeVisible();

  await composer.fill("@Mira");
  const mentions = page.getByRole("listbox", { name: "Mention someone" });
  const teammateAgentOption = mentions.getByRole("option", {
    name: /Mira Analyst/
  });
  await expect(teammateAgentOption).toBeVisible();
  await expect(
    mentions.getByRole("option", { name: /Excluded Agent/ })
  ).toHaveCount(0);
  await teammateAgentOption.click();
  await page.getByRole("button", { name: "Send message" }).last().click();
  await page.getByRole("button", { name: "Synthetic launch context" }).click();
  const requests = page.getByRole("region", {
    name: "Agent requests in this conversation"
  });
  await expect(requests).toContainText("Awaiting owner");
  expect(api.teamAgentRequests).toHaveLength(1);
  expect(api.teamAgentRequests[0]).toMatchObject({
    teamProjectId: ids.sharedProject,
    channelId: ids.directMessage,
    agentId: ids.teammateAgent,
    ownerId: ids.teammate,
    requesterId: ids.user,
    canReview: false
  });
  await expect(
    requests.getByRole("button", { name: "Review privately" })
  ).toHaveCount(0);
  await expect(requests.getByRole("button", { name: "View work" })).toHaveCount(
    0
  );

  await composer.fill("@Synthetic");
  const humanOption = page
    .getByRole("listbox", { name: "Mention someone" })
    .getByRole("option", { name: /Synthetic teammate/ });
  await expect(humanOption).toBeVisible();
  await humanOption.click();
  const humanMessage = "A direct human mention";
  await composer.pressSequentially(` ${humanMessage}`);
  await composer.press("Enter");
  await expect.poll(() => directMessageBodies.length).toBe(1);
  expect(directMessageBodies[0]).toMatchObject({
    mentionUserIds: [ids.teammate]
  });
  expect(directMessageBodies[0]?.bodyText).toContain(humanMessage);

  await teamNavigation
    .getByRole("button", {
      name: "Synthetic teammate, Other teammate",
      exact: true
    })
    .click();
  const groupComposer = page.getByPlaceholder(
    "Message Synthetic teammate, Other teammate",
    { exact: true }
  );
  await expect(groupComposer).toBeVisible();
  await groupComposer.fill("@Mira");
  const groupMentions = page.getByRole("listbox", {
    name: "Mention someone"
  });
  await expect(
    groupMentions.getByRole("option", { name: /Mira Analyst/ })
  ).toBeVisible();
  await expect(
    groupMentions.getByRole("option", { name: /Excluded Agent/ })
  ).toHaveCount(0);

  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
});

test("a late owned Agent project check cannot post into a newly selected conversation or clear its draft", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  const connection = api.holdNextProjectConnection(ids.sharedProject, 1);
  const messageBodies: Array<{ path: string; body: Record<string, unknown> }> =
    [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes(`/v1/collaboration/teams/${ids.team}/threads/`) &&
      request.url().endsWith("/messages")
    ) {
      messageBodies.push({
        path: new URL(request.url()).pathname,
        body: JSON.parse(request.postData() ?? "{}") as Record<string, unknown>
      });
    }
  });

  await openTeam(page);
  const teamNavigation = page.getByRole("navigation", {
    name: "Team navigation"
  });
  await teamNavigation
    .getByRole("button", { name: "Synthetic teammate", exact: true })
    .click();
  const directComposer = page.getByPlaceholder("Message Synthetic teammate", {
    exact: true
  });
  await expect(directComposer).toBeVisible();
  await directComposer.fill("@Busy");
  await page
    .getByRole("listbox", { name: "Mention someone" })
    .getByRole("option", { name: /Busy Reviewer/ })
    .click();

  const modelMenu = page.getByRole("button", {
    name: "Select model and effort"
  });
  await modelMenu.click();
  const modelDialog = page.getByRole("dialog", {
    name: "Model and reasoning"
  });
  await modelDialog.getByRole("button").first().click();
  await modelDialog
    .getByRole("button", { name: "GPT 6 Sol", exact: true })
    .click();
  await directComposer.pressSequentially(" owned work captured in room A");
  await page.getByRole("button", { name: "Send message" }).last().click();
  const ownedAgentProjectChooser = page
    .getByText(/Choose a Team Project for Busy Reviewer/)
    .locator("..");
  await ownedAgentProjectChooser
    .getByRole("button", { name: "Synthetic launch context", exact: true })
    .click();
  await connection.started;

  await teamNavigation
    .getByRole("button", {
      name: "Synthetic teammate, Other teammate",
      exact: true
    })
    .click();
  const groupComposer = page.getByPlaceholder(
    "Message Synthetic teammate, Other teammate",
    { exact: true }
  );
  await expect(groupComposer).toBeVisible();
  const roomBDraft = "Room B draft must survive Room A completion";
  await groupComposer.fill(roomBDraft);

  const connectionResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname ===
      `/v1/collaboration/teams/${ids.team}/public-square/projects/${ids.sharedProject}/connection`
    );
  });
  connection.release();
  await connectionResponse;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await expect(groupComposer).toHaveValue(roomBDraft);
  await expect.poll(() => messageBodies.length).toBe(0);
  await expect(page).toHaveURL(/\/studio\/collaboration/);

  await teamNavigation
    .getByRole("button", { name: "Synthetic teammate", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Synthetic launch context",
      exact: true
    })
  ).toBeEnabled();

  const retryConnection = api.holdNextProjectConnection(ids.sharedProject);
  await page
    .getByRole("button", {
      name: "Synthetic launch context",
      exact: true
    })
    .click();
  await retryConnection.started;
  await teamNavigation
    .getByRole("button", {
      name: "Synthetic teammate, Other teammate",
      exact: true
    })
    .click();
  await teamNavigation
    .getByRole("button", { name: "Synthetic teammate", exact: true })
    .click();
  const retryResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname ===
      `/v1/collaboration/teams/${ids.team}/public-square/projects/${ids.sharedProject}/connection`
    );
  });
  retryConnection.release();
  await retryResponse;
  await expect(
    page.getByRole("button", {
      name: "Synthetic launch context",
      exact: true
    })
  ).toBeEnabled();
  await expect(page).toHaveURL(/\/studio\/collaboration/);
  await expect.poll(() => messageBodies.length).toBe(0);

  await teamNavigation
    .getByRole("button", {
      name: "Synthetic teammate, Other teammate",
      exact: true
    })
    .click();
  await expect(groupComposer).toHaveValue(roomBDraft);
  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
});

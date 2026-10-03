import { expect, test, type Page } from "@playwright/test";
import type { HomeItem, HomeSnapshot } from "@koed/shared/home";
import type { TeamOverviewSnapshot } from "@koed/shared/team-overview";
import { ids, installSyntheticApi } from "./fixtures/synthetic-studio-api";

const approval = (
  id: string,
  source: HomeItem["source"] = "managed_runtime_item"
): HomeItem => ({
  sourceEventId: `${source === "personal_agent_job" ? "job" : "runtime"}:${id}`,
  source,
  sourceId: id,
  sourceRevision: "1",
  kind: source === "personal_agent_job" ? "intervention" : "approval",
  state: "blocked",
  title: "PRIVATE JOB BRIEF MUST NOT APPEAR",
  summary: "/private/workspace secret command",
  updatedAt: new Date(Date.now() + 1_000).toISOString(),
  destination: {
    kind: "execution",
    executionId: "123e4567-e89b-42d3-a456-426614174000"
  }
});

async function notificationFixture(page: Page, enablePreference = true) {
  await installSyntheticApi(page);
  const state = {
    items: [approval("old")],
    scope: "notification-owner",
    reads: 0,
    unavailable: false
  };
  await page.route("**/v1/collaboration/teams/overview**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } })
  );
  await page.route("**/v1/home**", async (route) => {
    const url = new URL(route.request().url());
    if (state.unavailable)
      return route.fulfill({ status: 401, json: { error: "signed_out" } });
    if (url.pathname.endsWith("/access"))
      return route.fulfill({
        json: { accountScope: state.scope, backendId: "notification-backend" }
      });
    state.reads += 1;
    const source = url.searchParams.get("source");
    const snapshot: HomeSnapshot = {
      schemaVersion: "koed.home-feed/v1",
      accountScope: state.scope,
      generatedAt: new Date().toISOString(),
      coverage: [
        "managed_runtime_item",
        "managed_execution",
        "personal_agent_job",
        "pull_request_review"
      ].map((value) => ({
        source: value as HomeItem["source"],
        complete: true,
        nextCursor: null
      })),
      needsYou: state.items.filter((item) => !source || item.source === source),
      ongoing: [],
      recent: [],
      cleared: [],
      badgeCount: state.items.length
    };
    return route.fulfill({ json: snapshot });
  });
  if (enablePreference)
    await page.addInitScript(() => {
      localStorage.setItem(
        "koed.studio.notifications.v1:home:notification-owner:notification-backend",
        "enabled"
      );
    });
  await page.clock.install();
  await page.goto("/studio/agents", { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await expect.poll(() => state.reads).toBeGreaterThanOrEqual(2);
  return state;
}

async function poll(page: Page, state: { reads: number }) {
  const previous = state.reads;
  await page.clock.runFor(30_001);
  await expect.poll(() => state.reads).toBeGreaterThan(previous);
}

test("silent baseline, fresh approval and failed Job alerts survive a Team outage without exposing private content", async ({
  page
}) => {
  const state = await notificationFixture(page);
  await expect(page.locator("[data-toast]")).toHaveCount(0);
  state.items.push(approval("fresh"));
  await poll(page, state);
  await expect(page.locator("[data-toast]")).toHaveCount(1);
  await expect(page.locator("[data-toast]")).not.toContainText(
    "PRIVATE JOB BRIEF"
  );
  await expect(page.locator("[data-toast]")).not.toContainText(
    "secret command"
  );
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  state.items.push(approval("failed", "personal_agent_job"));
  await poll(page, state);
  await expect(page.locator("[data-toast]")).toHaveCount(1);
  await expect(page.locator("[data-toast]")).toContainText(/failed/i);
  await poll(page, state);
  await expect(page.locator("[data-toast]")).toHaveCount(0);
});

test("an alert click rechecks access and account changes establish a silent baseline", async ({
  page
}) => {
  const state = await notificationFixture(page);
  state.items.push(approval("fresh"));
  await poll(page, state);
  await expect(page.locator("[data-toast]")).toHaveCount(1);
  state.unavailable = true;
  await page
    .locator("[data-toast]")
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await expect(page).toHaveURL(/\/studio\/agents\/?$/);
  state.unavailable = false;
  state.scope = "different-owner";
  state.items.push(approval("other-account-old"));
  await poll(page, state);
  await expect(page.locator("[data-toast]")).toHaveCount(0);
});

test("a long suspension resumes silently instead of replaying activity accumulated while away", async ({
  page
}) => {
  const state = await notificationFixture(page);
  state.items.push(approval("while-away"));
  await page.clock.fastForward(120_000);
  await expect.poll(() => state.reads).toBeGreaterThan(2);
  await expect(page.locator("[data-toast]")).toHaveCount(0);
});

test("real hosted message shape produces fresh mention alerts, leaves ordinary replies quiet, and rejects revoked clicks", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  let messageReads = 0;
  let revoked = false;
  let revokeDuringRead = false;
  let overviewReads = 0;
  const oldTime = new Date(Date.now() - 10_000).toISOString();
  const message = (id: string, mentions: string[], createdAt: string) => ({
    id,
    threadId: ids.general,
    threadSequence: 1,
    audienceVersion: 1,
    scope: "team",
    personalOwnerUserId: null,
    teamId: ids.team,
    teamWorkspaceId: null,
    senderKind: "user",
    senderPrincipalId: ids.teammate,
    senderUserId: ids.teammate,
    senderDisplayName: "Maya",
    recipientStatus: "sent",
    bodyText: "PRIVATE HUMAN MESSAGE",
    mentionUserIds: mentions,
    metadata: {},
    provenance: { kind: "user", id: ids.teammate },
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    rootMessageId: ids.root,
    version: 1,
    replyCount: 0,
    unreadReplyCount: 0,
    reactions: []
  });
  const messages = [message(ids.reply, [ids.user], oldTime)];
  const overview = (): TeamOverviewSnapshot => ({
    schemaVersion: "koed.team-overview/v1",
    access: { accountScope: "notification-team-owner", backendId: null },
    generatedAt: new Date().toISOString(),
    nextCursor: null,
    teams: revoked ? [] : [{ teamId: ids.team, name: "Team", badgeCount: 1 }],
    coverage: [
      "message_attention",
      "agent_request",
      "team_job_action",
      "pull_request_action",
      "team_job_outcome"
    ].map((source) => ({
      source: source as TeamOverviewSnapshot["coverage"][number]["source"],
      complete: true,
      nextCursor: null
    })),
    attention: revoked
      ? []
      : [
          {
            sourceEventId: `message-root:${ids.root}`,
            source: "message_attention",
            sourceId: ids.root,
            sourceRevision: String(messages.length),
            teamId: ids.team,
            teamName: "Team",
            kind: "message",
            priority: "attention",
            state: "recent",
            title: "PRIVATE OVERVIEW TITLE",
            summary: "PRIVATE SUMMARY",
            updatedAt: new Date().toISOString(),
            unreadCount: messages.length,
            destination: {
              kind: "thread",
              threadId: ids.general,
              rootMessageId: ids.root
            }
          }
        ],
    catchUp: [],
    cleared: [],
    currentJobOutcomes: [],
    badgeCount: 1
  });
  await page.route("**/v1/collaboration/teams/overview**", (route) => {
    overviewReads += 1;
    return route.fulfill({ json: overview() });
  });
  await page.route(
    `**/v1/collaboration/teams/${ids.team}/threads/${ids.general}/messages**`,
    (route) => {
      messageReads += 1;
      const params = new URL(route.request().url()).searchParams;
      if (revoked)
        return route.fulfill({ status: 403, json: { error: "revoked" } });
      if (
        [...params.keys()].some(
          (key) =>
            ![
              "afterSequence",
              "beforeSequence",
              "limit",
              "rootMessageId"
            ].includes(key)
        )
      )
        return route.fulfill({ status: 400, json: { error: "invalid_query" } });
      if (revokeDuringRead) revoked = true;
      return route.fulfill({
        json: { messages, hasMore: false, nextBeforeSequence: null }
      });
    }
  );
  await page.addInitScript(() =>
    localStorage.setItem(
      "koed.studio.notifications.v1:team_overview:notification-team-owner:local",
      "enabled"
    )
  );
  await page.clock.install();
  await page.goto("/studio/agents", { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await expect.poll(() => messageReads).toBeGreaterThan(0);
  await expect(page.locator("[data-toast]")).toHaveCount(0);
  messages.push(
    message(ids.ownSecond, [], new Date(Date.now() + 1000).toISOString())
  );
  let reads = messageReads;
  await page.clock.runFor(30_001);
  await expect.poll(() => messageReads).toBeGreaterThan(reads);
  await expect(page.locator("[data-toast]")).toHaveCount(0);
  messages.push(
    message(ids.ownThird, [ids.user], new Date(Date.now() + 2000).toISOString())
  );
  reads = messageReads;
  await page.clock.runFor(30_001);
  await expect.poll(() => messageReads).toBeGreaterThan(reads);
  await expect(page.locator("[data-toast]")).toHaveCount(1);
  await expect(page.locator("[data-toast]")).toContainText("Maya");
  await expect(page.locator("[data-toast]")).not.toContainText("PRIVATE");
  revokeDuringRead = true;
  const overviewBeforeClick = overviewReads;
  await page
    .locator("[data-toast]")
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await expect.poll(() => revoked).toBe(true);
  await expect
    .poll(() => overviewReads)
    .toBeGreaterThan(overviewBeforeClick + 1);
  await expect(page).toHaveURL(/\/studio\/agents\/?$/);
  expect(api.unexpectedMutations).toEqual([]);
});

test("foreground web alerts work by default without opting into macOS system notifications", async ({
  page
}) => {
  const state = await notificationFixture(page, false);
  state.items.push(approval("default-in-app"));
  await poll(page, state);
  await expect(page.locator("[data-toast]")).toHaveCount(1);
});

test("web in-app opt-out is saved in Settings and survives reopening Studio", async ({
  page
}) => {
  const state = await notificationFixture(page, false);
  await page.goto("/studio/settings", { waitUntil: "domcontentloaded" });
  const setting = page.getByRole("checkbox", {
    name: "Enable in-app notifications"
  });
  await expect(setting).toBeEnabled();
  await expect(setting).toBeChecked();
  await setting.uncheck();
  await expect(setting).not.toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem(
          "koed.studio.notifications.v1:home:notification-owner:notification-backend"
        )
      )
    )
    .toBe("disabled");
  const before = state.reads;
  await page.goto("/studio/agents", { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => state.reads).toBeGreaterThan(before + 1);
  state.items.push(approval("disabled-in-app"));
  await poll(page, state);
  await expect(page.locator("[data-toast]")).toHaveCount(0);
});

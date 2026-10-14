import { expect, test, type Page, type Route } from "@playwright/test";
import type { HomeItem, HomeSnapshot } from "@koed/shared/home";
import type { PersonalAgentChatConversationSummary } from "@koed/shared";
import { installSyntheticApi } from "./fixtures/synthetic-studio-api";

const executionItem: HomeItem = {
  sourceEventId: "runtime:approval-1",
  source: "managed_runtime_item",
  sourceId: "approval-1",
  sourceRevision: "1",
  kind: "approval",
  state: "blocked",
  title: "Synthetic approval",
  summary: "The managed chat is waiting for a decision.",
  updatedAt: "2026-10-02T12:00:00.000Z",
  destination: {
    kind: "execution",
    executionId: "123e4567-e89b-42d3-a456-426614174000"
  }
};

const prItem: HomeItem = {
  sourceEventId: "pull-request:review-1",
  source: "pull_request_review",
  sourceId: "review-1",
  sourceRevision: "1",
  kind: "pull_request_review",
  state: "review",
  title: "Synthetic PR review",
  summary: "Review the current pull request.",
  updatedAt: "2026-10-02T12:01:00.000Z",
  destination: {
    kind: "pull_request_review",
    reviewId: "123e4567-e89b-42d3-a456-426614174111",
    repositoryId: "repository-one",
    number: 42
  }
};

const olderJobItem: HomeItem = {
  sourceEventId: "execution:older-job",
  source: "managed_execution",
  sourceId: "older-job",
  sourceRevision: "1",
  kind: "job_review",
  state: "review",
  title: "Older Agent job review",
  summary: "This actionable review is on the next page.",
  updatedAt: "2026-10-01T12:00:00.000Z",
  destination: {
    kind: "execution",
    executionId: "123e4567-e89b-42d3-a456-426614174222"
  }
};

const nativeConversationId = "123e4567-e89b-42d3-a456-426614174555";
const nativeDeliveryId = "123e4567-e89b-42d3-a456-426614174666";
const nativeChildExecutionId = "123e4567-e89b-42d3-a456-426614174777";
const nativeAgentId = "123e4567-e89b-42d3-a456-426614174888";
const nativeAgentActivityItem: HomeItem = {
  sourceEventId: `delivery:${nativeDeliveryId}`,
  source: "native_agent_activity",
  sourceId: nativeDeliveryId,
  sourceRevision: "n0123456789abcdef",
  kind: "agent_work",
  state: "blocked",
  title: "Ada · Reconcile the failed delivery",
  summary: "Failed on Codex",
  updatedAt: "2026-10-02T12:02:00.000Z",
  destination: {
    kind: "execution",
    executionId: nativeConversationId
  }
};

const nativeConversation: PersonalAgentChatConversationSummary = {
  conversationId: nativeConversationId,
  title: "Release planning",
  projectId: null,
  contextKind: "independent",
  activeAgentId: nativeAgentId,
  activeExecutionId: nativeChildExecutionId,
  activeProvider: "codex",
  status: "failed",
  participantCount: 1,
  latestAgentId: nativeAgentId,
  latestAgentName: "Ada",
  updatedAt: "2026-10-02T12:02:00.000Z",
  sourceExecutionIds: [],
  childExecutionIds: [nativeChildExecutionId],
  capturedSessionIds: []
};

class HomeFixture {
  needsYou: HomeItem[] = [executionItem, prItem, olderJobItem];
  ongoing: HomeItem[] = [];
  recent: HomeItem[] = [];
  cleared: HomeItem[] = [];
  accountScope = "synthetic-owner";
  feedUnavailable = false;
  accessUnavailable = false;
  signedOut = false;
  hideFirstPageNeedsYou = false;
  personalConversations: PersonalAgentChatConversationSummary[] = [];

  async route(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (new URL(request.url()).pathname === "/v1/home/access") {
      if (this.accessUnavailable) {
        await route.fulfill({ status: 503, json: { error: "unavailable" } });
        return;
      }
      await route.fulfill({
        json: {
          accountScope: this.accountScope,
          backendId: "synthetic-backend"
        }
      });
      return;
    }
    if (
      (path === "/v1/personal-conversations" ||
        path === "/studio-api/personal-conversations") &&
      request.method() === "GET"
    ) {
      const { personalAgentChatConversationPageSchema } =
        await import("@koed/shared");
      const response = personalAgentChatConversationPageSchema.parse({
        conversations: this.personalConversations,
        hasMore: false,
        nextCursor: null
      });
      await route.fulfill({
        json: response
      });
      return;
    }
    if (
      (path === "/v1/managed-conversations" ||
        path === "/studio-api/managed-conversations") &&
      request.method() === "GET"
    ) {
      await route.fulfill({ json: { executions: [] } });
      return;
    }
    if (request.method() === "GET") {
      if (this.feedUnavailable) {
        await route.fulfill({ status: 503, json: { error: "unavailable" } });
        return;
      }
      const url = new URL(request.url());
      const source = url.searchParams.get("source");
      const cursor = url.searchParams.get("cursor");
      const isNextManagedPage =
        source === "managed_execution" && cursor === "managed-cursor-1";
      const pageNeedsYou = isNextManagedPage
        ? [olderJobItem]
        : this.hideFirstPageNeedsYou
          ? []
          : this.needsYou.filter((item) => item.source !== "managed_execution");
      const snapshot: HomeSnapshot = {
        schemaVersion: "koed.home-feed/v1",
        accountScope: this.accountScope,
        generatedAt: new Date().toISOString(),
        coverage: [
          { source: "managed_runtime_item", complete: true, nextCursor: null },
          { source: "native_agent_activity", complete: true, nextCursor: null },
          ...(source
            ? [
                {
                  source: "managed_execution" as const,
                  complete: true,
                  nextCursor: null
                }
              ]
            : [
                {
                  source: "managed_execution" as const,
                  complete: true,
                  nextCursor: "managed-cursor-1"
                }
              ]),
          { source: "personal_agent_job", complete: true, nextCursor: null },
          { source: "pull_request_review", complete: true, nextCursor: null }
        ],
        needsYou: pageNeedsYou,
        ongoing: source ? [] : this.ongoing,
        recent: source ? [] : this.recent,
        cleared: source ? [] : this.cleared,
        badgeCount: this.needsYou.length
      };
      await route.fulfill({ json: snapshot });
      return;
    }
    const sourceEventId = decodeURIComponent(path.split("/").at(-2) ?? "");
    const body = request.postDataJSON() as { sourceRevision?: unknown };
    const item = [...this.needsYou, ...this.cleared].find(
      (candidate) => candidate.sourceEventId === sourceEventId
    );
    if (!item || body.sourceRevision !== item.sourceRevision) {
      await route.fulfill({ status: 409, json: { error: "revision_changed" } });
      return;
    }
    const shouldClear = path.endsWith("/clear");
    this.needsYou = this.needsYou.filter((candidate) => candidate !== item);
    this.cleared = this.cleared.filter((candidate) => candidate !== item);
    if (shouldClear) this.cleared = [...this.cleared, item];
    else this.needsYou = [...this.needsYou, item];
    await route.fulfill({
      json: {
        sourceEventId,
        sourceRevision: item.sourceRevision,
        cleared: shouldClear
      }
    });
  }
}

const installHomeFixture = async (page: Page, home: HomeFixture) => {
  await installSyntheticApi(page);
  await page.route("**/me", async (route) => {
    if (!home.signedOut) {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 401, json: { error: "signed_out" } });
  });
  await page.route("**/v1/personal-conversations**", (route) =>
    home.route(route)
  );
  await page.route("**/studio-api/personal-conversations**", (route) =>
    home.route(route)
  );
  await page.route("**/v1/managed-conversations**", (route) =>
    home.route(route)
  );
  await page.route("**/studio-api/managed-conversations**", (route) =>
    home.route(route)
  );
  await page.route("**/v1/home**", (route) => home.route(route));
};

test("reminder clear syncs across pages, survives polling, and returns for a new source revision", async ({
  page,
  context
}) => {
  const home = new HomeFixture();
  await installHomeFixture(page, home);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/studio", { waitUntil: "domcontentloaded" });
  await page.clock.install({ time: new Date("2026-10-02T12:00:00.000Z") });
  await expect(
    page.getByRole("button", { name: "Clear Synthetic approval" })
  ).toBeVisible();
  await expect(page.getByText("3 things need you.")).toBeVisible();
  await expect(page.getByText("Older Agent job review")).toHaveCount(0);
  await page.getByRole("button", { name: "Load more chats" }).click();
  await expect(page.getByText("Older Agent job review")).toBeVisible();

  await page.getByRole("button", { name: "Clear Synthetic approval" }).click();
  await page.getByRole("button", { name: /Cleared/ }).click();
  await expect(
    page.getByRole("button", { name: "Clear Synthetic approval" })
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Cleared/ })).toContainText(
    "1"
  );

  const secondPage = await context.newPage();
  await installHomeFixture(secondPage, home);
  await secondPage.goto("/studio", { waitUntil: "domcontentloaded" });
  await expect(
    secondPage.getByRole("button", { name: /Cleared/ })
  ).toContainText("1");
  await expect(
    secondPage.getByRole("button", { name: "Clear Synthetic approval" })
  ).toHaveCount(0);

  await page.clock.fastForward(30_000);
  await expect(
    page.getByRole("button", { name: "Clear Synthetic approval" })
  ).toHaveCount(0);
  expect(home.needsYou).toContainEqual(prItem);

  const nextRevision = {
    ...executionItem,
    sourceRevision: "2",
    updatedAt: "2026-10-02T12:02:00.000Z"
  };
  home.cleared = home.cleared.filter(
    (item) => item.sourceEventId !== executionItem.sourceEventId
  );
  home.needsYou = [...home.needsYou, nextRevision];
  await page
    .getByRole("region", { name: "Home activity" })
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Clear Synthetic approval" })
  ).toBeVisible();
  await expect(page.getByText("3 things need you.")).toBeVisible();
  await secondPage.close();

  await page.getByRole("button", { name: "Clear Synthetic approval" }).click();
  await expect(
    page.getByRole("button", { name: "Restore Synthetic approval" })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Restore Synthetic approval" })
    .click();
  await expect(
    page.getByRole("button", { name: "Clear Synthetic approval" })
  ).toBeVisible();

  home.needsYou = home.needsYou.filter(
    (item) => item.sourceEventId !== executionItem.sourceEventId
  );
  await page
    .getByRole("region", { name: "Home activity" })
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Clear Synthetic approval" })
  ).toHaveCount(0);
});

test("sign-out and same-owner re-enable never reveal the old Home snapshot while offline", async ({
  page
}) => {
  const home = new HomeFixture();
  await installHomeFixture(page, home);
  await page.goto("/studio", { waitUntil: "domcontentloaded" });
  const oldReminder = page.getByRole("button", {
    name: /Synthetic approval approval/
  });
  await expect(oldReminder).toBeVisible();

  home.signedOut = true;
  home.accessUnavailable = true;
  home.feedUnavailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText(
      "This session expired or was revoked. Sign in again to continue."
    )
  ).toBeVisible();
  await expect(oldReminder).toHaveCount(0);

  home.signedOut = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Home could not be reached.")).toBeVisible();
  await expect(oldReminder).toHaveCount(0);
});

test("opening a Home item navigates without clearing, and stale data is retained read-only offline", async ({
  page
}) => {
  const home = new HomeFixture();
  await installHomeFixture(page, home);
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/studio", { waitUntil: "domcontentloaded" });
  const homeRegion = page.getByRole("region", { name: "Home activity" });
  await expect(
    homeRegion.getByRole("button", { name: /Synthetic approval approval/ })
  ).toBeVisible();
  await homeRegion
    .getByRole("button", { name: /Synthetic PR review pull request review/ })
    .click();
  await expect(page).toHaveURL(
    /\/studio\/pull-requests\?review=123e4567-e89b-42d3-a456-426614174111/
  );
  expect(home.needsYou).toContainEqual(executionItem);

  await page.goBack();
  await expect(
    homeRegion.getByRole("button", { name: /Synthetic approval approval/ })
  ).toBeVisible();
  await homeRegion
    .getByRole("button", { name: /Synthetic approval approval/ })
    .click();
  await expect(page).toHaveURL(
    /execution=123e4567-e89b-42d3-a456-426614174000/
  );
  expect(home.needsYou).toContainEqual(executionItem);
  await page.goBack();
  await expect(
    page
      .getByRole("region", { name: "Home activity" })
      .getByRole("button", { name: "Clear Synthetic approval" })
  ).toBeVisible();
  await page.route("**/v1/home**", (route) => route.abort());
  await page
    .getByRole("region", { name: "Home activity" })
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await expect(page.getByText("Offline · may be out of date")).toBeVisible();
  await expect(
    homeRegion.getByRole("button", { name: "Clear Synthetic approval" })
  ).toBeDisabled();
  await expect(
    homeRegion.getByRole("button", { name: /Synthetic approval approval/ })
  ).toBeDisabled();

  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      )
      .toBe(true);
  }
});

test("a verified owner change clears protected Home rows before an offline feed response", async ({
  page
}) => {
  const home = new HomeFixture();
  await installHomeFixture(page, home);
  await page.goto("/studio", { waitUntil: "domcontentloaded" });
  const homeRegion = page.getByRole("region", { name: "Home activity" });
  await expect(homeRegion.getByText("Synthetic approval")).toBeVisible();

  home.accountScope = "synthetic-owner-two";
  home.feedUnavailable = true;
  await homeRegion
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await expect(homeRegion.getByText("Synthetic approval")).toHaveCount(0);
  await expect(
    homeRegion.getByText("Home could not be reached.")
  ).toBeVisible();
});

test("an exact global badge can exceed the currently loaded actionable rows", async ({
  page
}) => {
  const home = new HomeFixture();
  home.needsYou = [olderJobItem];
  home.hideFirstPageNeedsYou = true;
  await installHomeFixture(page, home);
  await page.goto("/studio", { waitUntil: "domcontentloaded" });
  const homeRegion = page.getByRole("region", { name: "Home activity" });
  await expect(homeRegion.getByText("1 thing needs you.")).toBeVisible();
  await expect(homeRegion.getByText("Nothing here needs you.")).toHaveCount(0);
  await expect(
    homeRegion.getByText(
      "More items need you. Load another Home page to see them."
    )
  ).toBeVisible();
  await homeRegion.getByRole("button", { name: "Load more chats" }).click();
  await expect(homeRegion.getByText("Older Agent job review")).toBeVisible();
});

test("native Agent activity opens the saved conversation root and clear only changes its reminder", async ({
  page
}) => {
  const home = new HomeFixture();
  home.needsYou = [nativeAgentActivityItem];
  home.personalConversations = [nativeConversation];
  await installHomeFixture(page, home);
  const conversationsResponse = page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return (
      (path === "/v1/personal-conversations" ||
        path === "/studio-api/personal-conversations") &&
      response.request().method() === "GET"
    );
  });
  await page.goto("/studio", { waitUntil: "domcontentloaded" });
  const response = await conversationsResponse;
  expect(response.ok()).toBe(true);
  const { personalAgentChatConversationPageSchema } =
    await import("@koed/shared");
  expect(
    personalAgentChatConversationPageSchema.parse(await response.json())
      .conversations
  ).toEqual([nativeConversation]);
  const homeRegion = page.getByRole("region", { name: "Home activity" });
  const row = homeRegion.getByRole("button", {
    name: /Ada · Reconcile the failed delivery Agent work Blocked/
  });
  await expect(row).toBeVisible();
  await expect(homeRegion.getByText("Failed on Codex")).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(
    new RegExp(`/studio/?\\?chat=1&conversation=${nativeConversationId}`)
  );
  expect(home.needsYou).toContainEqual(nativeAgentActivityItem);

  await page.goBack();
  const clear = homeRegion.getByRole("button", {
    name: "Clear Ada · Reconcile the failed delivery"
  });
  await expect(clear).toBeVisible();
  await clear.click();
  await homeRegion.getByRole("button", { name: /^Cleared/ }).click();
  await expect(
    homeRegion.getByRole("button", {
      name: "Restore Ada · Reconcile the failed delivery"
    })
  ).toBeVisible();
  expect(home.needsYou).not.toContainEqual(nativeAgentActivityItem);
  expect(home.cleared).toContainEqual(nativeAgentActivityItem);
});

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
    page.getByRole("toolbar", { name: "Message formatting" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Bold", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select execution access" })
  ).toHaveCount(0);
  await composer.fill("@Busy");
  const busyAgent = page
    .getByRole("listbox", { name: "Available agents" })
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

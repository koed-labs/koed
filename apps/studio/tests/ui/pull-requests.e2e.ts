import { expect, test } from "@playwright/test";
import { installPullRequestsFixture } from "./fixtures/pull-requests-fixture";

test("GitHub PR inbox connects explicitly, separates authored and requested work, and opens bounded code details", async ({
  page
}) => {
  const api = await installPullRequestsFixture(page);

  await page.goto("/studio/plugins");
  await expect(
    page.getByRole("button", { name: "Sign in with GitHub" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  expect(
    api.requests.some(
      (request) =>
        (request.body as { payload?: { kind?: string } })?.payload?.kind ===
        "browser_sign_in"
    )
  ).toBeTruthy();

  await page.goto("/studio/pull-requests");
  await expect(
    page.getByRole("button", { name: "Review requested", exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Requested review", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Authored change", { exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "Authored", exact: true }).click();
  await expect(
    page.getByText("Authored change", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Requested review", { exact: true })).toHaveCount(
    0
  );

  await page
    .getByRole("button", { name: "Review requested", exact: true })
    .click();
  await expect(
    page.getByText("Requested review", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Authored change", { exact: true })).toHaveCount(
    0
  );
  await page.getByRole("button", { name: /Requested review.*#10/ }).click();
  await expect(
    page.getByRole("heading", { name: "Requested review", exact: true })
  ).toBeVisible();
  await page.screenshot({
    path: "output/playwright/pr-review-detail.png",
    fullPage: true
  });
  await page.getByRole("button", { name: "Code" }).click();
  await expect(page.getByText("src/example.ts", { exact: true })).toBeVisible();
  await expect(page.locator("pre").first()).toContainText("+new");
  await page.screenshot({
    path: "output/playwright/pr-detail.png",
    fullPage: true
  });
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      )
      .toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  expect(
    api.requests.some(
      (request) =>
        (request.body as { payload?: { kind?: string } })?.payload?.kind ===
        "inbox"
    )
  ).toBeTruthy();
  expect(
    api.requests.some(
      (request) =>
        (request.body as { payload?: { kind?: string } })?.payload?.kind ===
        "pull_request_details"
    )
  ).toBeTruthy();
});

test("a selected Agent gets a durable PR review Conversation with its normal runtime questions", async ({
  page
}) => {
  const api = await installPullRequestsFixture(page);
  await page.goto("/studio/plugins");
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.goto("/studio/pull-requests");
  await expect(
    page.getByRole("button", { name: "Review requested", exact: true })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review requested", exact: true })
    .click();
  await page.getByRole("button", { name: /Requested review.*#10/ }).click();
  await page
    .getByLabel("Agent", { exact: false })
    .selectOption({ label: "Busy Reviewer" });
  await page
    .getByLabel("Model", { exact: false })
    .selectOption("codex:gpt-6-sol");
  await page.getByRole("button", { name: "Review with Agent" }).click();
  await expect(page.getByText(/Review pull request #10/)).toBeVisible();
  await expect(
    page.getByText("Which area should the review focus on?", { exact: true })
  ).toBeVisible();
  await page.screenshot({
    path: "output/playwright/pr-managed-chat.png",
    fullPage: true
  });
  await page.getByLabel("Review focus").selectOption("Correctness");
  await page.getByRole("button", { name: "Submit answer" }).click();
  await expect(
    page.getByText(
      "Response submitted · showing the latest runner request state.",
      { exact: true }
    )
  ).toBeVisible();
  expect(
    api.requests.some(
      (request) =>
        request.path === "managed/" &&
        (request.body as Record<string, unknown>)?.pullRequestReviewId ===
          "66666666-6666-4666-8666-666666666666"
    )
  ).toBeTruthy();
  expect(
    api.requests.some((request) =>
      request.path.includes(
        "runtime-items/99999999-9999-4999-8999-999999999999/respond"
      )
    )
  ).toBeTruthy();

  await page.getByRole("button", { name: "Summary", exact: true }).click();
  const freeze = page.getByRole("button", {
    name: "Freeze review for confirmation"
  });
  await expect(freeze).toBeEnabled();
  await freeze.click();
  await expect(page.getByText(/Confirm exact GitHub content/)).toBeVisible();
  await expect(page.getByText(/d{12}/)).toBeVisible();
  await page.getByRole("button", { name: "Edit draft" }).click();
  await page.getByLabel("Review summary").fill("Edited exact review summary.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Previous frozen review")).toBeVisible();
  const draftConflict = page.getByRole("status").filter({
    hasText: "A newer saved draft arrived"
  });
  if (await draftConflict.isVisible()) {
    await draftConflict.getByRole("button", { name: "Reload saved" }).click();
  }
  await expect(page.getByText("Edited exact review summary.")).toBeVisible();
  await page
    .getByRole("button", { name: "Freeze review for confirmation" })
    .click();
  await expect(page.getByText(/Confirm exact GitHub content/)).toBeVisible();
  await expect(page.getByText(/e{12}/)).toBeVisible();
  await expect(
    page.getByLabel(
      "I reviewed this exact content and want to publish it to GitHub."
    )
  ).not.toBeChecked();
  expect(
    api.requests.filter((request) => request.path.endsWith("/draft/freeze"))
  ).toHaveLength(2);
  await page.screenshot({
    path: "output/playwright/pr-frozen-review.png",
    fullPage: true
  });
  const exactReview = page.getByLabel(
    "I reviewed this exact content and want to publish it to GitHub."
  );
  await exactReview.check();
  api.queueNextState("publish_review", "pending");
  await page
    .getByRole("button", { name: "Request publishing approval" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Publication operation" })
  ).toContainText("Publication operation");
  await page.getByRole("button", { name: "Cancel while queued" }).click();
  await expect(
    page
      .getByText("The queued publication was cancelled before it completed.", {
        exact: true
      })
      .first()
  ).toBeVisible();
  expect(
    api.requests.some((request) => request.path.endsWith("/cancel"))
  ).toBeTruthy();

  api.queueNextState("publish_review", "uncertain");
  await page
    .getByRole("button", { name: "Request publishing approval" })
    .click();
  const checkPublication = page.getByRole("button", {
    name: "Check publication outcome"
  });
  await expect(checkPublication).toBeVisible();
  await checkPublication.click();
  expect(
    api.requests.some(
      (request) =>
        (request.body as { payload?: { kind?: string } })?.payload?.kind ===
        "reconcile_review"
    )
  ).toBeTruthy();

  await page
    .getByPlaceholder("Describe the exact fixes you want…")
    .fill("Fix the confirmed issue without changing other files.");
  await page
    .getByRole("button", { name: "Allow fixes and send request" })
    .click();
  await page.getByRole("button", { name: "Summary", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Propose fixes" })
  ).toBeVisible();
  api.queueNextState("prepare_push", "pending");
  await page.getByRole("button", { name: "Prepare push proposal" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Push operation is pending."
  );
  await page.getByRole("button", { name: "Cancel while queued" }).click();
  await expect(
    page
      .getByText(
        "The queued push operation was cancelled before it completed.",
        { exact: true }
      )
      .first()
  ).toBeVisible();

  await page.getByRole("button", { name: "Prepare push proposal" }).click();
  await expect(page.getByText("Proposal ready", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "output/playwright/pr-push-proposal.png",
    fullPage: true
  });
  await page.getByLabel(/I checked this exact diff/).check();
  api.queueNextState("push", "uncertain");
  await page.getByRole("button", { name: "Push confirmed proposal" }).click();
  const checkPush = page.getByRole("button", {
    name: "Check remote outcome (read only)"
  });
  await expect(checkPush).toBeVisible();
  await checkPush.click();
  expect(
    api.requests.some(
      (request) =>
        (request.body as { payload?: { kind?: string } })?.payload?.kind ===
        "reconcile_push"
    )
  ).toBeTruthy();

  await page.reload();
  await page
    .getByRole("button", { name: "Review requested", exact: true })
    .click();
  await page.getByRole("button", { name: /Requested review.*#10/ }).click();
  const chatTab = page.getByRole("button", { name: "Chat", exact: true });
  await expect(chatTab).toBeEnabled({ timeout: 10_000 });
  await chatTab.click();
  await expect(page.getByText(/Review pull request #10/)).toBeVisible();
  await expect(
    page.getByText("Which area should the review focus on?", { exact: true })
  ).toBeVisible();
  await page.screenshot({
    path: "output/playwright/pr-managed-chat-restored.png",
    fullPage: true
  });
});

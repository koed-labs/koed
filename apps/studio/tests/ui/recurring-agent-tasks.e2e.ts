import { expect, test } from "@playwright/test";
import { ids, installSyntheticApi } from "./fixtures/synthetic-studio-api";

test("recurring tasks save paused, require activation, run explicitly, and link private history", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  await page.goto("/studio/agents");
  await page
    .getByRole("button", { name: /Busy Reviewer/ })
    .first()
    .click();

  const section = page
    .getByRole("region", { name: "Recurring Agent tasks" })
    .last();
  await expect(section).toContainText("Private to you");
  await expect(section).toContainText("No recurring tasks for Busy Reviewer.");
  await section.getByRole("button", { name: "Create recurring task" }).click();
  await page.getByLabel("Task name").fill("Morning review");
  await page
    .getByLabel("Instructions")
    .fill("Review the open work and report blockers.");
  await page
    .getByLabel("AI Client and Personal Device")
    .selectOption("codex.synthetic");
  await page.getByLabel("Task model").selectOption("gpt-6-sol");
  await page.getByLabel("Reasoning effort").selectOption("__client_default__");
  await page.getByLabel("Permission mode").selectOption("supervised");
  await section.getByRole("button", { name: "Create paused task" }).click();

  await expect(section).toContainText("Morning review");
  await expect(section).toContainText("Paused");
  await expect(section).toContainText("Every 1 hour(s)");
  await expect(section).toContainText("Codex · gpt-6-sol · Ask for approval");
  expect(api.recurringTaskWrites[0]).toMatchObject({
    action: "create",
    context: { projectId: null, contextKind: "independent" },
    execution: {
      provider: "codex",
      aiClientInstanceId: "codex.synthetic",
      targetDeviceId: "synthetic-runner",
      model: "gpt-6-sol",
      reasoningEffort: null,
      permissionMode: "supervised"
    },
    requestId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  });

  await section
    .getByLabel("I reviewed these settings and want to activate this schedule.")
    .check();
  await section.getByRole("button", { name: "Activate" }).click();
  await expect(section).toContainText("Active");
  await section.getByRole("button", { name: "Run now" }).click();
  await section.getByRole("button", { name: "Run history" }).click();
  await expect(section).toContainText("Waiting to start · Run now");
  await expect(
    section.getByRole("button", { name: "Open Conversation" })
  ).toHaveCount(0);
  await expect(section).toContainText("Conversation not created");
  api.dispatchLatestRecurringOccurrence();
  await section
    .getByRole("button", { name: "Refresh recurring tasks" })
    .click();
  await expect(section).toContainText("Started · Run now");
  await section.getByRole("button", { name: "Open Conversation" }).click();
  await expect(page).toHaveURL(new RegExp(`execution=${ids.root}`));
  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
});

test("an older Agent task-list response cannot replace the newly selected Agent", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  api.seedRecurringTask(ids.busyAgent, "Busy private schedule");
  const held = api.holdNextRecurringTaskList(ids.busyAgent);
  await page.goto("/studio/agents");
  await page
    .getByRole("button", { name: /Busy Reviewer/ })
    .first()
    .click();
  await held.started;
  await page
    .getByRole("button", { name: /Calm Reviewer/ })
    .first()
    .click();

  const section = page
    .getByRole("region", { name: "Recurring Agent tasks" })
    .last();
  await expect(section).toContainText("No recurring tasks for Calm Reviewer.");
  held.release();
  await expect(section).not.toContainText("Busy private schedule");
  expect(api.unexpectedReads).toEqual([]);
});

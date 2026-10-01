import { expect, test } from "@playwright/test";
import { ids, installSyntheticApi } from "./fixtures/synthetic-studio-api";

test("older Agent Jobs can be retried after a failed page read", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  await page.goto("/studio/agents");
  await page
    .getByRole("button", { name: /Busy Reviewer/ })
    .first()
    .click();
  await expect(page.getByLabel("Busy Reviewer details")).toBeVisible();
  await page.getByRole("button", { name: "Load more older Jobs" }).click();
  const retry = page.getByRole("button", {
    name: "Retry loading older Jobs"
  });
  await expect(retry).toBeVisible();
  await expect(
    page.getByText("Synthetic older Jobs page is temporarily unavailable.", {
      exact: true
    })
  ).toBeVisible();
  await retry.click();
  await expect(
    page.getByText("Synthetic older archived job", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Load more older Jobs/ })
  ).toHaveCount(0);
  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
});

test("a late older Jobs page cannot replace the newly selected Agent", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  const held = api.holdNextJobsPage(ids.busyAgent);
  await page.goto("/studio/agents");
  await page
    .getByRole("button", { name: /Busy Reviewer/ })
    .first()
    .click();
  await expect(page.getByLabel("Busy Reviewer details")).toBeVisible();
  await page.getByRole("button", { name: "Load more older Jobs" }).click();
  await held.started;
  await page
    .getByRole("button", { name: /Calm Reviewer/ })
    .first()
    .click();
  await expect(page.getByLabel("Calm Reviewer details")).toBeVisible();
  held.release();
  await expect(page.getByLabel("Calm Reviewer details")).toBeVisible();
  await expect(
    page.getByText("Synthetic older archived job", { exact: true })
  ).toHaveCount(0);
  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
});

import { expect, test } from "@playwright/test";
import { ids, installSyntheticApi } from "./fixtures/synthetic-studio-api";

test("Agents filters and collection views stay usable when an older detail read returns late", async ({
  page
}) => {
  const api = await installSyntheticApi(page);
  const held = api.holdNextDetail(ids.busyAgent);

  await page.goto("/studio/agents");
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Synthetic active review", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Synthetic launch", { exact: true }).first()
  ).toBeVisible();
  await expect(
    page.getByText("Exercise the Studio activity view with synthetic data.", {
      exact: true
    })
  ).toBeVisible();
  const busyCollectionCard = page
    .getByRole("region", { name: "Agent collection" })
    .getByRole("button", { name: /Busy Reviewer/ });
  await expect(busyCollectionCard).toContainText("Active in");
  await expect(busyCollectionCard).toContainText("Synthetic launch");
  await expect(busyCollectionCard).not.toContainText(
    "Project activity is being checked."
  );
  expect(
    api.requestCounts.get("GET /v1/personal-agents/activity")
  ).toBeGreaterThan(0);
  for (const unselectedId of [
    ids.idleAgent,
    ids.retiredAgent,
    ids.unknownAgent
  ])
    expect(
      api.requestCounts.get(`GET /v1/personal-agents/${unselectedId}`)
    ).toBeUndefined();

  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Calm Reviewer" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Cards", exact: true }).click();

  await page
    .getByRole("button", { name: /Busy Reviewer/ })
    .first()
    .click();
  await held.started;
  await page
    .getByRole("button", { name: /Calm Reviewer/ })
    .first()
    .click();
  await expect(page.getByLabel("Calm Reviewer details")).toBeVisible();
  held.release();
  await expect(page.getByLabel("Calm Reviewer details")).toBeVisible();
  await expect(page.getByLabel("Busy Reviewer details")).toHaveCount(0);

  await page.getByRole("button", { name: "Retired", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Retired Reviewer/ })
  ).toBeVisible();
  // The active-work overview remains visible above the filtered collection.
  await expect(
    page.getByText("Synthetic active review", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Active", exact: true }).click();

  await page
    .getByRole("button", { name: /Busy Reviewer/ })
    .first()
    .click();
  await expect(page.getByLabel("Busy Reviewer details")).toBeVisible();
  await page.getByRole("button", { name: "Retire agent", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("Retire Busy Reviewer?");
  await confirmation
    .getByRole("button", { name: "Retire agent", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);
  await page.getByRole("button", { name: "Retired", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Busy Reviewer/ })
  ).toBeVisible();

  expect(api.unexpectedMutations).toEqual([]);
  expect(api.unexpectedReads).toEqual([]);
  expect(
    [...api.mutationCounts.keys()].filter((key) => key.includes("/retire"))
  ).toHaveLength(1);
});

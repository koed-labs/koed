import { expect, test, type Page } from "@playwright/test";
import { ids, installSyntheticApi } from "./fixtures/synthetic-studio-api";

async function expectFits(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const main = document.querySelector("main");
        return Math.max(
          document.documentElement.scrollWidth - window.innerWidth,
          main ? main.scrollWidth - main.clientWidth : 0
        );
      })
    )
    .toBeLessThanOrEqual(1);
}

for (const width of [320, 360, 390, 768, 1024, 1440]) {
  test(`Agents and Team chat remain usable at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const api = await installSyntheticApi(page);
    await page.goto("/studio/agents");
    await expect(
      page.getByRole("heading", { name: "Agents", exact: true })
    ).toBeVisible();
    await expectFits(page);
    await page
      .getByRole("region", { name: "Agent collection" })
      .getByRole("button", { name: /Busy Reviewer/ })
      .click();
    const details = page.getByRole("complementary", {
      name: "Busy Reviewer details"
    });
    await expect(details).toBeVisible();
    const detailsBox = await details.boundingBox();
    expect(detailsBox!.width).toBeGreaterThan(180);
    expect(detailsBox!.x + detailsBox!.width).toBeLessThanOrEqual(width);
    await expectFits(page);
    await page.screenshot({ path: testInfo.outputPath("agent-details.png") });
    await details.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: /Create agent/i })
    ).toBeVisible();
    await expectFits(page);
    await page.screenshot({ path: testInfo.outputPath("create-agent.png") });
    await page.goto(`/studio/collaboration?team=${ids.team}`);
    const composer = page.getByPlaceholder("Message #general", { exact: true });
    await expect(composer).toBeVisible();
    await expectFits(page);
    const box = await composer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(140);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await composer.fill("@Busy");
    const mentions = page.getByRole("listbox", { name: "Mention someone" });
    await expect(mentions).toBeVisible();
    const mentionsBox = await mentions.boundingBox();
    expect(mentionsBox!.x).toBeGreaterThanOrEqual(0);
    expect(mentionsBox!.x + mentionsBox!.width).toBeLessThanOrEqual(width);
    await mentions.getByRole("option", { name: /Busy Reviewer/ }).click();
    await page.getByRole("button", { name: "Select model and effort" }).click();
    await expect(
      page.getByRole("button", { name: "Reset model and effort" })
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("agent-controls.png") });
    await page.getByRole("button", { name: "Select model and effort" }).click();
    await composer.fill("Responsive draft stays in this channel");
    if (width < 768) {
      await page.setViewportSize({ width, height: 480 });
      const shortBox = await composer.boundingBox();
      expect(shortBox!.y + shortBox!.height).toBeLessThanOrEqual(480);
      await expect(composer).toHaveValue(
        "Responsive draft stays in this channel"
      );
      await page.setViewportSize({ width, height: 800 });
      await page.getByRole("button", { name: "Open team navigation" }).click();
      const nav = page.getByRole("navigation", { name: "Team navigation" });
      await expect(nav).toBeVisible();
      await nav.getByRole("button", { name: "launch", exact: true }).click();
      await expect(nav).not.toBeVisible();
      await expect(
        page.getByPlaceholder("Message #launch", { exact: true })
      ).toBeVisible();
      await page.getByRole("button", { name: "Open team navigation" }).click();
      await nav.getByRole("button", { name: "general", exact: true }).click();
      await expect(composer).toHaveValue(
        "Responsive draft stays in this channel"
      );
    }
    await page
      .locator(`[data-message-id="${ids.root}"]`)
      .getByRole("button", { name: "Reply in thread", exact: true })
      .click();
    await expect(
      page.getByPlaceholder("Reply in thread...", { exact: true })
    ).toBeVisible();
    await expectFits(page);
    const replyBox = await page
      .getByPlaceholder("Reply in thread...", { exact: true })
      .boundingBox();
    expect(replyBox!.x).toBeGreaterThanOrEqual(0);
    expect(replyBox!.x + replyBox!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath("team-thread.png") });
    await page.getByRole("button", { name: "Close thread" }).click();
    const openNav = page.getByRole("button", { name: "Open team navigation" });
    if (await openNav.isVisible()) await openNav.click();
    await page
      .getByRole("navigation", { name: "Team navigation" })
      .getByRole("button", { name: "Public Square", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Highlights", exact: true })
    ).toBeVisible();
    await expectFits(page);
    await page.screenshot({ path: testInfo.outputPath("public-square.png") });
    expect(api.unexpectedMutations).toEqual([]);
    expect(api.unexpectedReads).toEqual([]);
  });
}

for (const width of [360, 768, 1024]) {
  test(`Preview chat and Settings fit at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 700 });
    const api = await installSyntheticApi(page);
    await page.goto("/studio/personal-preview");
    await expect(
      page.getByPlaceholder("Start a local preview chat")
    ).toBeVisible();
    await expectFits(page);
    await page
      .getByRole("button", { name: "New chat", exact: true })
      .last()
      .click();
    await expect(
      page.getByPlaceholder("Message this local preview")
    ).toBeVisible();
    await expectFits(page);
    await page.getByRole("button", { name: "Open Build panel" }).click();
    await expect(
      page.getByRole("button", { name: "Hide panel" })
    ).toBeVisible();
    await expectFits(page);
    await page.screenshot({ path: testInfo.outputPath("preview-build.png") });
    await page.goto("/studio/settings");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true })
    ).toBeVisible();
    await expectFits(page);
    await page.screenshot({ path: testInfo.outputPath("settings.png") });
    expect(api.unexpectedMutations).toEqual([]);
    expect(api.unexpectedReads).toEqual([]);
  });
}

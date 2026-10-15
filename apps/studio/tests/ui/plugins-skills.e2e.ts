import { expect, test, type Page } from "@playwright/test";
import { installPullRequestsFixture } from "./fixtures/pull-requests-fixture";

async function installResources(page: Page, initiallyFail = false) {
  await installPullRequestsFixture(page);
  const requests: Array<Record<string, unknown>> = [];
  const state = { fail: initiallyFail };
  await page.route("**/v1/memory/local-agent-settings", (route) =>
    route.fulfill({
      json: {
        settings: [],
        instances: [
          {
            instanceId: "codex.synthetic",
            hostedInstanceId: "codex.synthetic",
            driverId: "codex",
            displayName: "Synthetic Codex",
            sourceDeviceLabel: "Test computer",
            enabled: true
          }
        ],
        capabilitySnapshots: [
          {
            hostedInstanceId: "codex.synthetic",
            authenticationState: "authenticated"
          }
        ]
      }
    })
  );
  await page.route("**/v1/ai-client-resources/discover", async (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    const now = new Date().toISOString();
    await route.fulfill({
      json: {
        operationId: "11111111-1111-4111-8111-111111111111",
        requestId: body.requestId,
        hostedInstanceId: body.hostedInstanceId,
        projectId: body.projectId,
        state: state.fail ? "failed" : "completed",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        ...(state.fail
          ? { errorCode: "AiClientCodexAuthenticationRequired" }
          : {
              catalog: {
                version: 1,
                provider: "codex",
                aiClientInstanceId: "codex.synthetic",
                hostedInstanceId: "codex.synthetic",
                computerLabel: "Test computer",
                projectId: null,
                observedAt: now,
                expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                resources: [
                  {
                    resourceId: `res_${"a".repeat(64)}`,
                    kind: "skill",
                    name: "Synthetic review",
                    source: "user",
                    status: "ready",
                    availability: "available",
                    executionSupport: "koed_managed",
                    invocation: "native_skill"
                  },
                  {
                    resourceId: `res_${"b".repeat(64)}`,
                    kind: "plugin",
                    name: "Configured integration",
                    source: "configured",
                    status: "unavailable",
                    availability: "configured",
                    executionSupport: "inventory_only",
                    invocation: null
                  },
                  {
                    resourceId: `res_${"c".repeat(64)}`,
                    kind: "mcp_server",
                    name: "Unknown integration",
                    source: "configured",
                    status: "unavailable",
                    availability: "unknown",
                    executionSupport: "inventory_only",
                    invocation: null
                  },
                  {
                    resourceId: `res_${"d".repeat(64)}`,
                    kind: "mcp_server",
                    name: "Signed-out integration",
                    source: "configured",
                    status: "unavailable",
                    availability: "needs_sign_in",
                    executionSupport: "inventory_only",
                    invocation: null
                  }
                ]
              }
            })
      }
    });
  });
  return { state, requests };
}

test("native inventory distinguishes configured, unknown and sign-in states on a small screen", async ({
  page
}) => {
  const fixture = await installResources(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/studio/plugins");
  const inventory = page.getByRole("region", { name: "AI Client plugins" });
  await expect(
    inventory.getByText("Configured integration", { exact: true })
  ).toBeVisible();
  await expect(
    inventory.getByText("Status unknown", { exact: true })
  ).toBeVisible();
  await expect(
    inventory.getByText("Needs sign-in", { exact: true })
  ).toBeVisible();
  await expect(
    inventory.getByText("Available in Client", { exact: true })
  ).toHaveCount(0);
  await expect(
    inventory.getByText(
      /Install, configure and connect accounts in the original AI Client/
    )
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth
    )
  ).toBe(true);
  expect(fixture.requests.length).toBe(1);
  expect(Object.keys(fixture.requests[0]!).sort()).toEqual([
    "hostedInstanceId",
    "projectId",
    "requestId"
  ]);
});

test("resource discovery gives actionable sign-in feedback and recovers through bounded manual refresh", async ({
  page
}) => {
  const fixture = await installResources(page, true);
  await page.goto("/studio/plugins");
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  const inventory = page.getByRole("region", { name: "AI Client skills" });
  await expect(inventory.getByText(/Sign in through Codex/)).toBeVisible();
  fixture.state.fail = false;
  const before = fixture.requests.length;
  await inventory.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    inventory.getByText("Synthetic review", { exact: true })
  ).toBeVisible();
  await expect(
    inventory.getByText("Available in Client", { exact: true })
  ).toBeVisible();
  expect(fixture.requests.length - before).toBe(1);
  expect(
    fixture.requests.every(
      (request) =>
        request.hostedInstanceId === "codex.synthetic" &&
        request.projectId === null
    )
  ).toBe(true);
});

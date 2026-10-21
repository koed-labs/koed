// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SharingRuleDetailReview as Review,
  SharingRuleDelivery
} from "@koed/shared";
import {
  SharingRuleDetailReview,
  type RuleDetailClient
} from "./SharingRuleDetailReview.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const review: Review = {
  ruleId: id(1),
  teamId: id(2),
  teamWorkspaceId: id(3),
  selectorKind: "project",
  state: "paused",
  maximumFidelity: "memory_events",
  includeCuratedMemory: false,
  previousMaximumFidelity: "lcm_rollups",
  previousIncludeCuratedMemory: false,
  expectedAuthorityVersion: 5,
  publisherFence: 1,
  teamPolicyVersion: 1,
  teamPolicyHash: "a".repeat(64),
  workspacePolicyVersion: 1,
  workspacePolicyHash: "b".repeat(64),
  effectivePrivacyPolicyHash: "c".repeat(64),
  policyBindingHash: "d".repeat(64),
  memberBindingHash: "e".repeat(64),
  memberCount: 7,
  ownerPolicyExpansionCount: 2,
  disclosureIncrease: true,
  teamName: "Team",
  workspaceName: "Engineering",
  expiresAt: "2026-10-21T12:05:00Z",
  reviewHash: "f".repeat(64)
};
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
});
const mount = async (client: RuleDetailClient, onDelivery = vi.fn()) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <SharingRuleDetailReview
        client={client}
        ruleId={id(1)}
        teamId={id(2)}
        workspaceId={id(3)}
        maximumFidelity="lcm_rollups"
        includeCuratedMemory={false}
        onDelivery={onDelivery}
      />
    )
  );
  return onDelivery;
};
const click = async (text: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === text
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
const chooseEvents = async () => {
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = "memory_events";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
describe("rule detail review", () => {
  it("reviews the whole rule and sends only the exact reviewed scope for native confirmation", async () => {
    const client = {
      reviewRuleDetail: vi.fn<RuleDetailClient["reviewRuleDetail"]>(
        async () => review
      ),
      amendRuleDetail: vi.fn<RuleDetailClient["amendRuleDetail"]>(
        async (intent) =>
          ({
            intent: { ...intent, teamWorkspaceId: intent.workspaceId },
            state: "queued",
            control: null,
            creation: null,
            presentation: {
              sourceTitle: "Project rule",
              teamName: "Team",
              workspaceName: "Engineering"
            },
            failureCode: null,
            updatedAt: new Date().toISOString()
          }) as SharingRuleDelivery
      )
    };
    const onDelivery = await mount(client);
    await click("Change rule detail");
    await chooseEvents();
    await click("Review detail change");
    expect(client.reviewRuleDetail).toHaveBeenCalledExactlyOnceWith({
      ruleId: id(1),
      teamId: id(2),
      workspaceId: id(3),
      maximumFidelity: "memory_events",
      includeCuratedMemory: false
    });
    expect(container.textContent).toContain("whole rule");
    expect(container.textContent).toContain(
      "7 existing members. Rule remains paused."
    );
    expect(container.textContent).toContain(
      "Owner permission also broadens for 2 existing members."
    );
    expect(client.amendRuleDetail).not.toHaveBeenCalled();
    await click("Review increased sharing");
    expect(client.amendRuleDetail).toHaveBeenCalledWith({
      operationKind: "detail",
      mutationId: expect.any(String),
      ruleId: id(1),
      teamId: id(2),
      workspaceId: id(3),
      review
    });
    expect(onDelivery).toHaveBeenCalledOnce();
  });
  it("requires a fresh review after confirmation fails", async () => {
    const client = {
      reviewRuleDetail: vi.fn<RuleDetailClient["reviewRuleDetail"]>(
        async () => review
      ),
      amendRuleDetail: vi.fn<RuleDetailClient["amendRuleDetail"]>(async () => {
        throw new Error("Rule changed");
      })
    };
    await mount(client);
    await click("Change rule detail");
    await chooseEvents();
    await click("Review detail change");
    await click("Review increased sharing");
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(container.textContent).not.toContain("Review increased sharing");
    await click("Review detail change");
    expect(client.reviewRuleDetail).toHaveBeenCalledTimes(2);
    expect(client.amendRuleDetail).toHaveBeenCalledTimes(1);
  });
  it("cancels without requesting or changing authority", async () => {
    const client = {
      reviewRuleDetail: vi.fn<RuleDetailClient["reviewRuleDetail"]>(),
      amendRuleDetail: vi.fn<RuleDetailClient["amendRuleDetail"]>()
    };
    await mount(client);
    await click("Change rule detail");
    await chooseEvents();
    await click("Cancel");
    expect(client.reviewRuleDetail).not.toHaveBeenCalled();
    expect(client.amendRuleDetail).not.toHaveBeenCalled();
  });
});

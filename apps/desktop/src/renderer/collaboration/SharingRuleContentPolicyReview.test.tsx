// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  noPrivacyLabelsPolicy,
  resolveSharingRuleContentPolicy,
  sharingRuleContentPolicyReviewSchema,
  sharingRuleDeliverySchema,
  type PrivacyLabelPolicy
} from "@koed/shared";
import { SharingRuleContentPolicyReview } from "./SharingRuleContentPolicyReview.js";

type Client = Parameters<typeof SharingRuleContentPolicyReview>[0]["client"];
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const hash = "a".repeat(64);
const previous = { ...noPrivacyLabelsPolicy(), private_email: true };
const required = { ...noPrivacyLabelsPolicy(), secret: true };
const review = (labels: PrivacyLabelPolicy) => {
  const proposed = resolveSharingRuleContentPolicy({
    globalLabels: required,
    globalPolicyHash: hash,
    labels
  });
  return sharingRuleContentPolicyReviewSchema.parse({
    ruleId: id(1),
    teamId: id(2),
    teamWorkspaceId: id(3),
    selectorKind: "project",
    state: "paused",
    maximumFidelity: "memory_events",
    includeCuratedMemory: false,
    expectedAuthorityVersion: 2,
    publisherFence: 1,
    teamPolicyVersion: 1,
    teamPolicyHash: hash,
    workspacePolicyVersion: 1,
    workspacePolicyHash: hash,
    policyBindingHash: hash,
    memberBindingHash: hash,
    memberCount: 2,
    teamName: "Team",
    workspaceName: "Engineering",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reviewHash: hash,
    labels,
    previousLabels: previous,
    previousEffectiveLabels: { ...previous, secret: true },
    requiredLabels: required,
    effectiveLabels: proposed.effectiveLabels,
    effectivePrivacyPolicyHash: proposed.effectivePrivacyPolicyHash,
    globalPolicyHash: hash,
    previousGlobalPolicyHash: hash,
    expectedContentPolicyVersion: 1,
    disclosureIncrease: !labels.private_email
  });
};
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
});
const mount = async (client: Client) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onDelivery = vi.fn();
  await act(async () =>
    root!.render(
      <SharingRuleContentPolicyReview
        client={client}
        ruleId={id(1)}
        teamId={id(2)}
        workspaceId={id(3)}
        authorityVersion={2}
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
const fixture = () => ({
  reviewRuleContentPolicy: vi.fn<Client["reviewRuleContentPolicy"]>(
    async (input) => review(input.labels)
  ),
  amendRuleContentPolicy: vi.fn<Client["amendRuleContentPolicy"]>(
    async (input) => {
      const { workspaceId, ...intent } = input;
      return sharingRuleDeliverySchema.parse({
        intent: { ...intent, teamWorkspaceId: workspaceId },
        presentation: {
          sourceTitle: "Project rule",
          teamName: "Team",
          workspaceName: "Engineering"
        },
        state: "queued",
        control: null,
        creation: null,
        failureCode: null,
        updatedAt: new Date().toISOString()
      });
    }
  )
});
const broaden = async () => {
  const email = [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.includes("Private email addresses"))!
    .querySelector("input")!;
  expect(email.checked).toBe(true);
  await act(async () => email.click());
  await click("Review content policy");
};
describe("rule content-policy review", () => {
  it("discovers current masks without offering that proposal, preserves required masks, and confirms only the reviewed change", async () => {
    const client = fixture();
    const onDelivery = await mount(client);
    await click("Change content policy");
    expect(client.reviewRuleContentPolicy).toHaveBeenCalledExactlyOnceWith({
      ruleId: id(1),
      teamId: id(2),
      workspaceId: id(3),
      labels: noPrivacyLabelsPolicy()
    });
    expect(client.amendRuleContentPolicy).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Review increased sharing");
    const secret = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Secrets"))!
      .querySelector("input")!;
    expect(secret.checked).toBe(true);
    expect(secret.disabled).toBe(true);
    await broaden();
    expect(container.textContent).toContain(
      "2 existing members. Rule remains paused."
    );
    expect(client.amendRuleContentPolicy).not.toHaveBeenCalled();
    const exactReview =
      await client.reviewRuleContentPolicy.mock.results[1]!.value;
    await click("Review increased sharing");
    expect(client.amendRuleContentPolicy).toHaveBeenCalledExactlyOnceWith({
      operationKind: "content_policy",
      mutationId: expect.any(String),
      ruleId: id(1),
      teamId: id(2),
      workspaceId: id(3),
      review: exactReview
    });
    expect(onDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: "queued" })
    );
  });
  it("requires a fresh policy review when approval or execution fails", async () => {
    const client = fixture();
    client.amendRuleContentPolicy.mockRejectedValue(
      new Error("Rule authority changed")
    );
    await mount(client);
    await click("Change content policy");
    await broaden();
    await click("Review increased sharing");
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(container.textContent).not.toContain("Review increased sharing");
    expect(client.amendRuleContentPolicy).toHaveBeenCalledOnce();
    await click("Review content policy");
    expect(client.reviewRuleContentPolicy).toHaveBeenCalledTimes(3);
    expect(client.amendRuleContentPolicy).toHaveBeenCalledOnce();
  });
});

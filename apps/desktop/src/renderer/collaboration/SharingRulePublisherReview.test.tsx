// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sharingRulePublisherTakeoverLocalReviewSchema,
  sharingRuleDeliverySchema,
  type GitAnchorSharingReviewPage
} from "@koed/shared";
import {
  SharingRulePublisherReview,
  type PublisherReviewClient
} from "./SharingRulePublisherReview.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const sourceIdentity = {
  originatingDeploymentId: "original-Personal-deployment",
  originatingDeviceId: "original-Personal-device",
  logicalSessionId: "original-Conversation"
};
const review = () =>
  sharingRulePublisherTakeoverLocalReviewSchema.parse({
    localSource: {
      localSessionId: id(21),
      localLogicalSessionId: id(22),
      identityState: "verified",
      portable: { ownerUserId: id(10), ...sourceIdentity },
      contextVersion: { git: 1, folder: 1 }
    },
    review: {
      ruleId: id(1),
      teamId: id(2),
      teamWorkspaceId: id(3),
      expectedAuthorityVersion: 3,
      publisherFence: 2,
      sourceIdentity,
      selectorKind: "captured_session",
      state: "paused",
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false,
      effectivePrivacyPolicyHash: "a".repeat(64),
      teamName: "Team",
      workspaceName: "Workspace",
      currentPublisher: {
        credentialId: id(4),
        deviceInstanceId: "device-a",
        label: "Original laptop",
        available: false
      },
      receivingPublisher: {
        credentialId: id(5),
        deviceInstanceId: "device-b",
        label: "Receiving laptop",
        available: true
      },
      logicalMemoryId: id(7),
      membershipId: id(8),
      shareGrantId: id(9),
      membershipVersion: 1,
      selectionScope: null,
      expiresAt: new Date(Date.now() + 60000).toISOString()
    }
  });
const client = () => ({
  reviewPublisherTakeover: vi
    .fn<PublisherReviewClient["reviewPublisherTakeover"]>()
    .mockResolvedValue(review()),
  takeOverPublisher: vi.fn<PublisherReviewClient["takeOverPublisher"]>(),
  reviewGitAnchorSharing:
    vi.fn<NonNullable<PublisherReviewClient["reviewGitAnchorSharing"]>>()
});
const props = {
  ruleId: id(1),
  teamId: id(2),
  workspaceId: id(3),
  authorityVersion: 3,
  publisherFence: 2,
  maximumFidelity: "lcm_rollups" as const,
  sourceChoices: [{ sessionId: id(21), title: "Synced original Conversation" }]
};
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
});
const mount = async (
  value: Parameters<typeof SharingRulePublisherReview>[0]
) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<SharingRulePublisherReview {...value} />)
  );
};
const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (entry) => entry.textContent === label
  )!;
const click = async (label: string) =>
  act(async () => {
    button(label).click();
  });

describe("owner publisher transfer review", () => {
  it("verifies the chosen local source, preserves paused state, and requests native approval once before reporting queued delivery", async () => {
    const api = client(),
      onDelivery = vi.fn();
    let finish: () => void = () => {
      throw new Error("No native approval request");
    };
    api.takeOverPublisher.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          finish = () => {
            const { workspaceId, ...intent } = input;
            resolve(
              sharingRuleDeliverySchema.parse({
                intent: { ...intent, teamWorkspaceId: workspaceId },
                presentation: {
                  sourceTitle: "Conversation",
                  teamName: "Team",
                  workspaceName: "Workspace"
                },
                state: "queued",
                control: null,
                creation: null,
                failureCode: null,
                updatedAt: new Date().toISOString()
              })
            );
          };
        })
    );
    await mount({ ...props, client: api, onDelivery });
    await click("Transfer publisher");
    await click("Review publisher transfer");
    expect(api.reviewPublisherTakeover).toHaveBeenCalledExactlyOnceWith({
      ruleId: id(1),
      teamId: id(2),
      workspaceId: id(3),
      expectedAuthorityVersion: 3,
      publisherFence: 2,
      localSessionId: id(21)
    });
    expect(host.textContent).toContain("Updates remain paused");
    expect(host.textContent).toContain("Original laptop → Receiving laptop");
    expect(api.takeOverPublisher).not.toHaveBeenCalled();
    await click("Continue to publisher approval");
    await click("Continue to publisher approval");
    expect(api.takeOverPublisher).toHaveBeenCalledTimes(1);
    expect(api.takeOverPublisher).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKind: "publisher_takeover",
        workspaceId: id(3),
        localSource: expect.objectContaining({ localSessionId: id(21) })
      })
    );
    expect(onDelivery).not.toHaveBeenCalled();
    await act(async () => {
      finish();
    });
    expect(onDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: "queued" })
    );
    expect(host.textContent).not.toContain("Team accepted");
  });
  it.each(["expired", "wrong_destination"] as const)(
    "rejects an %s review before native approval",
    async (kind) => {
      const api = client(),
        value = review();
      api.reviewPublisherTakeover.mockResolvedValue({
        ...value,
        review: {
          ...value.review,
          ...(kind === "expired"
            ? { expiresAt: new Date(Date.now() - 1000).toISOString() }
            : { teamWorkspaceId: id(99) })
        }
      });
      await mount({ ...props, client: api, onDelivery: vi.fn() });
      await click("Transfer publisher");
      await click("Review publisher transfer");
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      expect(button("Continue to publisher approval")).toBeUndefined();
      expect(api.takeOverPublisher).not.toHaveBeenCalled();
    }
  );
  it("discards an old source review when the current rule version changes", async () => {
    const api = client();
    let finish: (value: ReturnType<typeof review>) => void = () => {
      throw new Error("Missing review");
    };
    api.reviewPublisherTakeover.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const value = { ...props, client: api, onDelivery: vi.fn() };
    await mount(value);
    await click("Transfer publisher");
    await click("Review publisher transfer");
    await act(async () =>
      root!.render(
        <SharingRulePublisherReview {...value} authorityVersion={4} />
      )
    );
    await act(async () => {
      finish(review());
    });
    expect(button("Transfer publisher")).toBeDefined();
    expect(button("Continue to publisher approval")).toBeUndefined();
    expect(api.takeOverPublisher).not.toHaveBeenCalled();
  });
  it("loads bounded Personal choices explicitly, omits local-only identities and preserves the original receiving pointer", async () => {
    const api = client();
    const target = {
      kind: "project" as const,
      project: { ownerUserId: id(10), projectId: id(30) }
    };
    const page: GitAnchorSharingReviewPage = {
      target,
      destination: {
        teamId: id(2),
        workspaceId: id(3),
        representation: "lcm_rollups",
        effectiveMaximumFidelity: "memory_events",
        effectiveIncludeCuratedMemory: false,
        teamPolicyVersion: 1,
        teamPolicyHash: "a".repeat(64),
        workspacePolicyVersion: 1,
        workspacePolicyHash: "b".repeat(64)
      },
      snapshotVersion: id(31),
      entries: [
        {
          source: review().localSource,
          reason: { kind: "session", inclusionId: id(32), revisionId: id(33) },
          projectVersion: 1,
          title: "Receiving checkpoint",
          readiness: "unresolved",
          sourceRevision: null,
          itemCount: 0
        },
        {
          source: {
            ...review().localSource,
            localSessionId: id(25),
            identityState: "local_only",
            portable: null
          },
          reason: { kind: "session", inclusionId: id(34), revisionId: id(35) },
          projectVersion: 1,
          title: "Only here",
          readiness: "eligible",
          sourceRevision: 1,
          itemCount: 1
        }
      ],
      nextCursor: "next-Personal-page",
      complete: false,
      completionToken: null,
      includesFutureConversations: true,
      expiresAt: new Date(Date.now() + 60000).toISOString()
    };
    api.reviewGitAnchorSharing
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({
        ...page,
        nextCursor: null,
        complete: true,
        completionToken: "complete"
      });
    await mount({
      ...props,
      target,
      sourceChoices: [],
      client: api,
      onDelivery: vi.fn()
    });
    await click("Transfer publisher");
    expect(
      [...host.querySelectorAll("option")].map((entry) => entry.textContent)
    ).toEqual(["Choose a Conversation", "Receiving checkpoint"]);
    expect(host.querySelector("select")!.value).toBe(id(21));
    await click("Load more Conversations");
    expect(api.reviewGitAnchorSharing).toHaveBeenLastCalledWith({
      target,
      teamId: id(2),
      workspaceId: id(3),
      representation: "lcm_rollups",
      cursor: "next-Personal-page"
    });
    expect(host.querySelectorAll("option")).toHaveLength(2);
    expect(api.takeOverPublisher).not.toHaveBeenCalled();
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { sharingSelectionDescriptor } from "@koed/shared";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CollaborationSnapshot,
  GitAnchorSharingReviewInput,
  GitAnchorSharingReviewPage
} from "@koed/shared/collaboration";
import { GitAnchorSharingReview } from "./GitAnchorSharingReview.js";
import { RepositorySharingRules } from "./RepositorySharingRules.js";
import { mergeProjectSources } from "../../project-memory-ui.js";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
const reviewClient = (
  reviewGitAnchorSharing: CollaborationRendererClient["reviewGitAnchorSharing"]
) => ({
  reviewGitAnchorSharing,
  reviewPublisherTakeover:
    vi.fn<CollaborationRendererClient["reviewPublisherTakeover"]>(),
  takeOverPublisher: vi.fn<CollaborationRendererClient["takeOverPublisher"]>(),
  listRepositoryRules: vi.fn<
    CollaborationRendererClient["listRepositoryRules"]
  >(async () => ({ rules: [], nextCursor: null })),
  listSharingRuleDeliveries: vi.fn(async () => []),
  reviewRuleContentPolicy: vi.fn<
    CollaborationRendererClient["reviewRuleContentPolicy"]
  >(async () => {
    throw new Error("Unexpected content-policy review");
  }),
  amendRuleContentPolicy: vi.fn<
    CollaborationRendererClient["amendRuleContentPolicy"]
  >(async () => {
    throw new Error("Unexpected content-policy amendment");
  }),
  reviewRuleDetail: vi.fn<CollaborationRendererClient["reviewRuleDetail"]>(
    async () => {
      throw new Error("Unexpected detail review");
    }
  ),
  amendRuleDetail: vi.fn<CollaborationRendererClient["amendRuleDetail"]>(
    async () => {
      throw new Error("Unexpected detail amendment");
    }
  ),
  controlRepositoryRule: vi.fn<
    CollaborationRendererClient["controlRepositoryRule"]
  >(async () => {
    throw new Error("Unexpected group control");
  }),
  reviewRepositoryRuleCreation: vi.fn<
    CollaborationRendererClient["reviewRepositoryRuleCreation"]
  >(async () => {
    throw new Error("Unexpected creation review");
  }),
  createRepositoryRule: vi.fn<
    CollaborationRendererClient["createRepositoryRule"]
  >(async () => {
    throw new Error("Unexpected rule creation");
  })
});

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const target = {
  kind: "repository",
  repository: {
    kind: "portable_repository",
    key: "gr_fixture_anchor",
    root: null,
    branch: null,
    reason: "origin",
    checkoutId: null,
    originatingDeviceId: "device-a",
    selectedRemote: "origin",
    anchorDisplay: "example/anchor"
  }
} satisfies GitAnchorSharingReviewInput["target"];
const folderTarget = {
  kind: "folder",
  folder: {
    ownerUserId: id(90),
    folderId: "folder-exact",
    originatingDeploymentId: "local-deployment",
    originatingDeviceId: "device-a",
    originatingProfileId: "profile-a",
    directoryIncarnationId: "folder-instance-a"
  }
} satisfies GitAnchorSharingReviewInput["target"];
const projectTarget = {
  kind: "project",
  project: { ownerUserId: id(90), projectId: id(91) }
} satisfies GitAnchorSharingReviewInput["target"];
const availableTeams: CollaborationSnapshot["navigation"]["teams"] = [
  {
    id: id(1),
    name: "Engineering",
    role: "owner",
    lifecycle: "active",
    unreadCount: 0,
    people: [],
    directMessages: [],
    version: 1,
    workspaces: [
      {
        id: id(2),
        name: "Platform",
        description: null,
        access: "write",
        lifecycle: "active",
        version: 1,
        channels: [],
        sharedMemory: []
      }
    ]
  }
];
const page = (complete: boolean): GitAnchorSharingReviewPage => ({
  target,
  destination: {
    teamId: id(1),
    workspaceId: id(2),
    representation: "lcm_rollups",
    effectiveMaximumFidelity: "memory_events",
    effectiveIncludeCuratedMemory: false,
    teamPolicyVersion: 1,
    teamPolicyHash: "a".repeat(64),
    workspacePolicyVersion: 1,
    workspacePolicyHash: "b".repeat(64)
  },
  snapshotVersion: id(3),
  entries: [
    {
      source: {
        localSessionId: id(4),
        localLogicalSessionId: id(5),
        portable: null,
        identityState: "local_only",
        contextVersion: { git: 1, folder: 1 }
      },
      reason: { kind: "selection", targetKind: "repository" },
      projectVersion: null,
      title: "Reviewed source",
      readiness: "eligible",
      sourceRevision: 7,
      itemCount: 1
    }
  ],
  nextCursor: complete ? null : "opaque-review-cursor",
  complete,
  completionToken: complete ? "completed-review" : null,
  includesFutureConversations: true,
  expiresAt: "2099-01-01T00:00:00.000Z"
});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const select = async (index: number, value: string) =>
  act(async () => {
    const element = document.querySelectorAll("select")[index]!;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
const click = async (label: string) =>
  act(async () => {
    const button = [...document.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === label
    );
    if (!button) throw new Error(`Missing ${label}`);
    button.click();
  });

describe("Git Anchor sharing review dialog", () => {
  it("uses the local anchor label and exposes Pause and Stop without changing rule identity", async () => {
    const client = reviewClient(vi.fn());
    const ruleId = id(20);
    client.listRepositoryRules.mockResolvedValue({
      rules: [
        {
          ruleId,
          selector: sharingSelectionDescriptor(target),
          team: { id: id(1), name: "Engineering" },
          workspace: { id: id(2), name: "Workspace" },
          state: "active",
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          authorityVersion: 4,
          publisherFence: 2,
          publisherAvailable: true
        }
      ],
      nextCursor: null
    });
    client.controlRepositoryRule.mockImplementation(
      async ({ workspaceId, ...intent }) => ({
        intent: { ...intent, teamWorkspaceId: workspaceId },
        presentation: {
          sourceTitle: "example/anchor",
          teamName: "Engineering",
          workspaceName: "Workspace"
        },
        state: "queued",
        control: null,
        creation: null,
        failureCode: null,
        updatedAt: new Date().toISOString()
      })
    );
    const localProjects = mergeProjectSources(
      [
        {
          id: "local-project",
          name: "Local checkout",
          path: "/work/anchor",
          repository: target.repository,
          eventCount: 0,
          threads: []
        }
      ],
      []
    );
    await act(async () =>
      root.render(
        <RepositorySharingRules
          client={client}
          creation={null}
          localProjects={localProjects}
          query="example/anchor"
        />
      )
    );
    const summary = document.querySelector<HTMLElement>(
      ".collab-sharing-rule-list-item > summary"
    )!;
    expect(summary.textContent).toContain("example/anchor");
    expect(summary.textContent).not.toContain("gr_fixture_anchor");
    await act(async () => {
      summary.click();
    });
    expect(
      document.querySelector('[aria-label="More sharing actions"]')
    ).toBeNull();
    expect(
      [
        ...document.querySelectorAll(".collab-sharing-inline-actions button")
      ].map((button) => button.textContent)
    ).toEqual(["Pause", "Stop"]);
    const stop = [
      ...document.querySelectorAll<HTMLButtonElement>("button")
    ].find((item) => item.textContent === "Stop");
    expect(stop).toBeDefined();
    await act(async () => stop!.click());
    expect(client.controlRepositoryRule).toHaveBeenCalledExactlyOnceWith({
      selectorKind: "selection",
      mutationId: expect.any(String),
      ruleId,
      teamId: id(1),
      workspaceId: id(2),
      expectedAuthorityVersion: 4,
      publisherFence: 2,
      controlAction: "stop"
    });
  });
  it.each([target, folderTarget, projectTarget])(
    "uses the completed $kind review for explicit future-member creation and waits for Team acknowledgment",
    async (target) => {
      const final = { ...page(true), target },
        client = reviewClient(vi.fn().mockResolvedValue(final));
      const scope = {
        selector: sharingSelectionDescriptor(
          target.kind === "project"
            ? { ...target, project: { ...target.project, projectId: id(99) } }
            : target
        ),
        teamId: id(1),
        teamWorkspaceId: id(2),
        maximumFidelity: "lcm_rollups" as const,
        includeCuratedMemory: false,
        includesFutureConversations: true as const,
        completedReviewHash: "a".repeat(64),
        selectionSnapshotVersion: final.snapshotVersion,
        teamPolicyVersion: 1,
        teamPolicyHash: "b".repeat(64),
        workspacePolicyVersion: 1,
        workspacePolicyHash: "c".repeat(64),
        effectivePrivacyPolicyHash: "d".repeat(64)
      };
      client.reviewRepositoryRuleCreation.mockResolvedValue({
        scope,
        teamName: "Engineering",
        workspaceName: "Workspace"
      });
      client.createRepositoryRule.mockImplementation(async (input) => {
        const { workspaceId, ...intent } = input;
        return {
          intent: { ...intent, teamWorkspaceId: workspaceId },
          presentation: {
            sourceTitle: "example/anchor",
            teamName: "Engineering",
            workspaceName: "Workspace"
          },
          state: "queued",
          control: null,
          creation: null,
          failureCode: null,
          updatedAt: new Date().toISOString()
        };
      });
      await act(async () =>
        root.render(
          <GitAnchorSharingReview
            client={client}
            target={target}
            selectionTitle={
              target.kind === "project" ? "PRIVATE PROJECT NAME" : undefined
            }
            availableTeams={availableTeams}
            onClose={vi.fn()}
          />
        )
      );
      const share = () =>
        [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Continue to approval"
        )!;
      expect(client.listRepositoryRules).toHaveBeenCalledWith({
        selector: sharingSelectionDescriptor(target),
        target,
        afterRuleId: null,
        limit: 50
      });
      expect(share()).toBeUndefined();
      await select(0, id(1));
      await select(1, id(2));
      await click("Review");
      expect(share().disabled).toBe(false);
      await click("Continue to approval");
      expect(
        client.reviewRepositoryRuleCreation
      ).toHaveBeenCalledExactlyOnceWith({
        target,
        teamId: id(1),
        workspaceId: id(2),
        representation: "lcm_rollups",
        completionToken: final.completionToken
      });
      if (target.kind === "project") {
        expect(document.body.textContent).toContain("PRIVATE PROJECT NAME");
        expect(
          JSON.stringify(client.reviewRepositoryRuleCreation.mock.calls)
        ).not.toContain("PRIVATE PROJECT NAME");
      }
      expect(client.createRepositoryRule).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          workspaceId: id(2),
          includesFutureConversations: true,
          completedReviewHash: scope.completedReviewHash,
          review: expect.objectContaining({
            target,
            completionToken: final.completionToken
          })
        })
      );
      expect(document.body.textContent).toContain(
        "Waiting for Team acknowledgment"
      );
      expect(document.body.textContent).not.toContain(
        "Team accepted the sharing rule"
      );
      expect(share().disabled).toBe(true);
    }
  );
  it.each([target, folderTarget, projectTarget])(
    "can request stopping an empty $kind rule with an unavailable publisher without claiming immediate revocation",
    async (target) => {
      const client = reviewClient(vi.fn()),
        ruleId = id(20);
      client.listRepositoryRules.mockResolvedValue({
        rules: [
          {
            ruleId,
            selector: sharingSelectionDescriptor(target),
            team: { id: id(1), name: "Engineering" },
            workspace: { id: id(2), name: "Workspace" },
            state: "active",
            maximumFidelity: "lcm_rollups",
            includeCuratedMemory: false,
            authorityVersion: 4,
            publisherFence: 2,
            publisherAvailable: false
          }
        ],
        nextCursor: null
      });
      client.controlRepositoryRule.mockImplementation(async (input) => {
        const { workspaceId, ...intent } = input;
        return {
          intent: { ...intent, teamWorkspaceId: workspaceId },
          presentation: {
            sourceTitle: "example/anchor",
            teamName: "Engineering",
            workspaceName: "Workspace"
          },
          state: "queued",
          control: null,
          creation: null,
          failureCode: null,
          updatedAt: new Date().toISOString()
        };
      });
      await act(async () =>
        root.render(
          <GitAnchorSharingReview
            client={client}
            target={target}
            availableTeams={availableTeams}
            onClose={vi.fn()}
          />
        )
      );
      expect(document.body.textContent).toContain("Publisher unavailable");
      expect(document.body.textContent).not.toContain("Sharing rules for this");
      expect(document.body.textContent).not.toContain("Refresh sharing rules");
      if (target.kind === "repository")
        expect(
          document.querySelector(".collab-sharing-rule-list-item > summary")
            ?.textContent
        ).toContain(target.repository.anchorDisplay);
      const retry = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry catch-up"
      )!;
      expect(retry.disabled).toBe(true);
      await act(async () => {
        document.querySelector<HTMLDetailsElement>(
          ".collab-sharing-rule-list-item"
        )!.open = true;
      });
      await act(async () => {
        const item = [
          ...document.querySelectorAll<HTMLButtonElement>("button")
        ].find((node) => node.textContent === "Stop")!;
        item.click();
      });
      expect(client.controlRepositoryRule).toHaveBeenCalledExactlyOnceWith({
        selectorKind: "selection",
        mutationId: expect.any(String),
        ruleId,
        teamId: id(1),
        workspaceId: id(2),
        expectedAuthorityVersion: 4,
        publisherFence: 2,
        controlAction: "stop"
      });
      expect(document.body.textContent).toContain(
        "Team access may remain until acknowledged"
      );
      expect(document.body.textContent).not.toContain(
        "This rule supplies no Team access"
      );
    }
  );
  it("does not present a partial enumeration as complete and merges repeated source/reason records", async () => {
    let finish!: (value: GitAnchorSharingReviewPage) => void;
    const next = new Promise<GitAnchorSharingReviewPage>((resolve) => {
      finish = resolve;
    });
    const reviewGitAnchorSharing = vi
      .fn()
      .mockResolvedValueOnce(page(false))
      .mockReturnValueOnce(next);
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <GitAnchorSharingReview
          client={reviewClient(reviewGitAnchorSharing)}
          target={target}
          availableTeams={availableTeams}
          onClose={onClose}
        />
      )
    );
    await select(0, id(1));
    await select(1, id(2));
    await click("Review");
    await vi.waitFor(() =>
      expect(reviewGitAnchorSharing).toHaveBeenCalledTimes(2)
    );
    expect(document.body.textContent).toContain(
      "The selection is not complete yet."
    );
    expect(document.body.textContent).not.toContain("Complete review:");
    await act(async () => finish(page(true)));
    expect(document.body.textContent).toContain("1 Conversation1 ready");
    expect(
      document.querySelector(".collab-sharing-readiness strong")?.textContent
    ).toBe("1 Conversation");
    expect(
      document.querySelector('[aria-label="Reviewed Conversations"]')
    ).toBeNull();
    expect(document.body.textContent).toContain(
      "Existing & future Conversations"
    );
    expect(document.body.textContent).toContain(
      "No consent or Share Grant exists until sharing is approved"
    );
    expect(reviewGitAnchorSharing).toHaveBeenLastCalledWith({
      target,
      teamId: id(1),
      workspaceId: id(2),
      representation: "lcm_rollups",
      cursor: "opaque-review-cursor"
    });
    await click("Back");
    await click("Cancel");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("discards failed partial review data and refreshes the exact selected scope", async () => {
    const reviewGitAnchorSharing = vi
      .fn()
      .mockResolvedValueOnce(page(false))
      .mockRejectedValueOnce(new Error("Selection changed"))
      .mockResolvedValueOnce({
        ...page(true),
        entries: [
          {
            ...page(true).entries[0]!,
            readiness: "unresolved",
            sourceRevision: null,
            itemCount: null
          }
        ]
      });
    await act(async () =>
      root.render(
        <GitAnchorSharingReview
          client={reviewClient(reviewGitAnchorSharing)}
          target={target}
          availableTeams={availableTeams}
          onClose={vi.fn()}
        />
      )
    );
    await select(0, id(1));
    await select(1, id(2));
    await click("Review");
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')).not.toBeNull()
    );
    expect(document.body.textContent).not.toContain("Complete review:");
    expect(
      document.querySelector('[aria-label="Reviewed Conversations"]')
    ).toBeNull();
    await click("Refresh review");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "1 Conversation0 ready1 waiting"
      )
    );
    expect(reviewGitAnchorSharing).toHaveBeenLastCalledWith({
      target,
      teamId: id(1),
      workspaceId: id(2),
      representation: "lcm_rollups",
      cursor: null
    });
  });

  it("can cancel a running review without accepting its late response", async () => {
    let finish!: (value: GitAnchorSharingReviewPage) => void;
    const reviewGitAnchorSharing = vi.fn(
      () =>
        new Promise<GitAnchorSharingReviewPage>((resolve) => {
          finish = resolve;
        })
    );
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <GitAnchorSharingReview
          client={reviewClient(reviewGitAnchorSharing)}
          target={target}
          availableTeams={availableTeams}
          onClose={onClose}
        />
      )
    );
    await select(0, id(1));
    await select(1, id(2));
    await click("Review");
    await click("Cancel");
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => {
      root.render(null);
      finish(page(true));
    });
    expect(
      document.querySelector('[aria-label="Reviewed Conversations"]')
    ).toBeNull();
  });
});

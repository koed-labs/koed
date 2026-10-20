// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@koed/shared";
import type { ManagedProjectDesktopApi } from "../../../ipc/managed-project-protocol.js";
import type { ManagedConversationDesktopApi } from "../../../ipc/managed-conversation-protocol.js";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import { HqProjectPullRequests } from "./HqProjectPullRequests.js";

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Atlas"
} as Project;
const executionId = "22222222-2222-4222-8222-222222222222";
const hash = "a".repeat(64);
const review = {
  id: "review-212",
  number: 212,
  title: "Colleague's fix",
  state: "open",
  draft: false,
  sourceBranch: "fix",
  targetBranch: "main",
  headObjectId: "b".repeat(40),
  author: "colleague",
  webUrl: "https://github.com/acme/repo/pull/212",
  updatedAt: "2026-10-20T00:00:00.000Z"
};
const remote = {
  remoteName: "origin",
  provider: "github",
  host: "github.com",
  transport: "https",
  locator: { namespace: "acme", repository: "repo", project: null },
  remoteIdentityHash: hash,
  connectionId: "33333333-3333-4333-8333-333333333333",
  credentialGeneration: 1,
  connectionState: "connected",
  capabilities: ["review_request_read", "checks_read"]
};

describe("Project HQ pull requests", () => {
  let node: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    node.remove();
  });
  const conversations = {
    list: vi.fn(async () => ({
      executions: [
        {
          executionId,
          projectId: project.id,
          sessionId: null,
          threadId: null,
          state: "running"
        }
      ]
    })),
    runtime: vi.fn(async () => ({ executionGeneration: 1, items: [] }))
  } as unknown as ManagedConversationDesktopApi;
  const projectsApi = {} as ProjectsDesktopApi;

  it("shows a ticketless colleague PR in Needs you and uses Native merge IPC", async () => {
    const command = vi.fn(async (request: Record<string, unknown>) => {
      if (request.operation === "source_control_merge_capability")
        return {
          ...request,
          result: {
            kind: "review_request_merge_capability",
            available: true,
            reason: "ready",
            allowedMergeMethods: ["squash"],
            provider: "github",
            openUrl: review.webUrl
          }
        };
      if (request.operation === "source_control_merge")
        return { ...request, result: { kind: "declined" } };
      const source = request.sourceControlOperation as { kind: string };
      const result =
        source.kind === "remotes"
          ? { kind: "remotes", remotes: [remote], headObjectId: "b".repeat(40) }
          : source.kind === "review_requests"
            ? {
                kind: "review_requests",
                reviewRequests: [review],
                nextCursor: null
              }
            : {
                kind: "checks",
                checks: [
                  {
                    id: "check",
                    name: "CI",
                    state: "completed",
                    conclusion: "success",
                    webUrl: null
                  }
                ]
              };
      return { ...request, result };
    });
    await act(async () =>
      root.render(
        <HqProjectPullRequests
          mode="need"
          ownerId="owner"
          profileKey="profile"
          project={project}
          personalProjects={[project]}
          graphProjects={[]}
          workItems={[]}
          api={{ command } as unknown as ManagedProjectDesktopApi}
          conversations={conversations}
          projectsApi={projectsApi}
        />
      )
    );
    expect(node.textContent).toContain("Colleague's fix");
    expect(node.textContent).toContain("CI success");
    const merge = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Merge"
    )!;
    await act(async () => merge.click());
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "source_control_merge",
        reviewRequestNumber: 212,
        mergeMethod: "squash"
      })
    );
    expect(node.textContent).toContain("Merge review declined");
  });

  it("does not reopen a canceled Agent proposal after reload", async () => {
    const command = vi.fn(async (request: Record<string, unknown>) => {
      if (request.operation === "source_control_merge_capability")
        return {
          ...request,
          result: {
            kind: "review_request_merge_capability",
            available: true,
            reason: "ready",
            allowedMergeMethods: ["squash"],
            provider: "github",
            openUrl: review.webUrl
          }
        };
      if (request.operation === "source_control_merge")
        return { ...request, result: { kind: "declined" } };
      const source = request.sourceControlOperation as { kind: string };
      return {
        ...request,
        result:
          source.kind === "remotes"
            ? {
                kind: "remotes",
                remotes: [remote],
                headObjectId: review.headObjectId
              }
            : source.kind === "review_requests"
              ? {
                  kind: "review_requests",
                  reviewRequests: [review],
                  nextCursor: null
                }
              : { kind: "checks", checks: [] }
      };
    });
    let proposalState: "canceled" | "pending" = "canceled";
    const declinedConversations = {
      list: conversations.list,
      runtime: vi.fn(async () => ({
        executionGeneration: 1,
        items: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            executionGeneration: 1,
            state: proposalState,
            payload: { mergeProposal: { reviewRequestNumber: 212 } }
          }
        ]
      }))
    } as unknown as ManagedConversationDesktopApi;
    const view = (profileKey: string) => (
      <HqProjectPullRequests
        mode="need"
        ownerId="owner"
        profileKey={profileKey}
        project={project}
        personalProjects={[project]}
        graphProjects={[]}
        workItems={[]}
        api={{ command } as unknown as ManagedProjectDesktopApi}
        conversations={declinedConversations}
        projectsApi={projectsApi}
      />
    );
    await act(async () => root.render(view("profile")));
    expect(node.textContent).toContain("Colleague's fix");
    await act(async () => root.render(view("profile")));
    expect(command).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: "source_control_merge" })
    );
    proposalState = "pending";
    await act(async () => root.render(view("new-profile")));
    await act(async () => root.render(view("new-profile")));
    expect(
      command.mock.calls.filter(
        ([request]) => request.operation === "source_control_merge"
      )
    ).toHaveLength(1);
  });
});

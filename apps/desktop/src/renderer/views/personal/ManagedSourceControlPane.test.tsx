// @vitest-environment happy-dom
import type {
  ManagedProjectDesktopApi,
  ManagedProjectRequest,
  ManagedProjectResult
} from "../../../ipc/managed-project-protocol.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedSourceControlPane } from "./ManagedSourceControlPane.js";
const executionId = "11111111-1111-4111-8111-111111111111";
const now = "2026-08-19T00:00:00.000Z";
describe("ManagedSourceControlPane", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  const render = async (api: ManagedProjectDesktopApi, revision: number) => {
    await act(async () => {
      root.render(
        <ManagedSourceControlPane
          api={api}
          identity={{ executionId, executionGeneration: 1 }}
          revision={revision}
        />
      );
    });
  };
  it.each(["detail", "detail-error", "comments-page", "remote-page"])(
    "keeps responses attached to their selection (%s)",
    async (race) => {
      let finish: ((result: unknown) => void) | undefined;
      let fail: ((error: Error) => void) | undefined;
      let hold = false;
      const remotes = ["origin", "upstream"].map((name, index) => ({
        remoteName: name,
        provider: "github",
        host: "github.com",
        transport: "https",
        locator: { namespace: "acme", repository: name, project: null },
        remoteIdentityHash: String(index + 1).repeat(64),
        connectionId: "connection",
        credentialGeneration: 1,
        connectionState: "connected",
        capabilities: [
          "review_request_read",
          "checks_read",
          "comments_read",
          "reviews_write"
        ]
      }));
      const review = (number: number) => ({
        id: `review-${number}`,
        number,
        title: `Review ${number}`,
        state: "open",
        draft: false,
        sourceBranch: "feature",
        targetBranch: "main",
        headObjectId: String(number).repeat(40),
        author: "author",
        webUrl: null,
        updatedAt: now
      });
      const comment = (body: string) => ({
        id: body,
        author: "author",
        body,
        createdAt: now,
        webUrl: null
      });
      const command = vi.fn(
        async (
          request: ManagedProjectRequest
        ): Promise<ManagedProjectResult> => {
          if (request.operation !== "source_control")
            throw new Error("Expected source control");
          const op = request.sourceControlOperation;
          let result: unknown;
          if (op.kind === "remotes")
            result = { kind: "remotes", remotes, headObjectId: "a".repeat(40) };
          else if (op.kind === "review_requests")
            result = {
              kind: op.kind,
              reviewRequests: [review(1), review(2)],
              nextCursor: null
            };
          else if (op.kind === "checks") result = { kind: op.kind, checks: [] };
          else if (op.kind === "comments") {
            if (
              hold &&
              (race.startsWith("detail") ? op.number === 2 : Boolean(op.cursor))
            ) {
              result = await new Promise((resolve, reject) => {
                finish = resolve;
                fail = reject;
              });
            } else
              result = {
                kind: op.kind,
                comments: [comment(`Current ${op.number}`)],
                nextCursor: "next"
              };
          } else throw new Error(`Unexpected ${op.kind}`);
          return {
            requestId: request.requestId,
            operation: "source_control",
            result
          } as ManagedProjectResult;
        }
      );
      await render({ command, subscribe: () => () => undefined }, 1);
      const click = async (text: string) => {
        const button = Array.from(container.querySelectorAll("button")).find(
          (item) => item.textContent?.includes(text)
        );
        expect(button).toBeDefined();
        await act(async () => button!.click());
      };
      hold = true;
      if (race.startsWith("detail")) {
        await click("Review 2");
        expect(container.textContent).not.toContain("Current 1");
        expect(
          Array.from(container.querySelectorAll("button")).find(
            (item) => item.textContent === "Approve"
          )?.disabled
        ).toBe(true);
        hold = false;
        await click("Review 1");
      } else {
        await click("Load more comments");
        hold = false;
        if (race === "remote-page") {
          await act(async () => {
            const select = container.querySelector("select")!;
            select.value = remotes[1]!.remoteIdentityHash;
            select.dispatchEvent(new Event("change", { bubbles: true }));
          });
        } else await click("Review 2");
      }
      expect(finish).toBeDefined();
      await act(async () => {
        if (race === "detail-error") fail!(new Error("Old request failed"));
        else
          finish!({
            kind: "comments",
            comments: [comment("Obsolete response")],
            nextCursor: "obsolete"
          });
      });
      expect(container.textContent).not.toContain("Obsolete response");
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).toContain(
        race === "comments-page" ? "Current 2" : "Current 1"
      );
      expect(
        Array.from(container.querySelectorAll("button")).find(
          (item) => item.textContent === "Approve"
        )?.disabled
      ).toBe(false);
    }
  );
  it.each([false, true])(
    "loads reviews, comments, and the correct push revision (pagination: %s)",
    async (paged) => {
      const remoteIdentityHash = "b".repeat(64);
      const headObjectId = "a".repeat(40);
      const remoteObjectId = "c".repeat(40);
      const command = vi.fn(
        async (
          request: ManagedProjectRequest
        ): Promise<ManagedProjectResult> => {
          if (request.operation !== "source_control") {
            throw new Error(`Unexpected operation ${request.operation}`);
          }
          const source = request.sourceControlOperation;
          const result =
            source.kind === "remotes"
              ? {
                  kind: "remotes" as const,
                  headObjectId,
                  remotes: [
                    {
                      remoteName: "origin",
                      provider: "github" as const,
                      host: "github.com",
                      transport: "https" as const,
                      locator: {
                        namespace: "acme",
                        repository: "repo",
                        project: null
                      },
                      remoteIdentityHash,
                      connectionId: "22222222-2222-4222-8222-222222222222",
                      credentialGeneration: 1,
                      connectionState: "connected" as const,
                      capabilities: [
                        "repository_read" as const,
                        "branch_read" as const,
                        "fetch" as const,
                        "push" as const,
                        "review_request_read" as const,
                        "review_request_create" as const,
                        "checks_read" as const,
                        "comments_read" as const,
                        "comments_write" as const,
                        "reviews_write" as const
                      ]
                    }
                  ]
                }
              : source.kind === "inspect"
                ? {
                    kind: "inspect" as const,
                    remote: {} as never,
                    defaultBranch: "main",
                    defaultBranchObjectId: remoteObjectId,
                    currentBranch: "feature",
                    headObjectId
                  }
                : source.kind === "branches"
                  ? {
                      kind: "branches" as const,
                      branches:
                        !paged || source.cursor
                          ? [
                              {
                                name: "feature",
                                objectId: remoteObjectId,
                                isDefault: false,
                                isProtected: false
                              }
                            ]
                          : Array.from({ length: 100 }, (_, index) => ({
                              name: `other-${index}`,
                              objectId: remoteObjectId,
                              isDefault: false,
                              isProtected: false
                            })),
                      nextCursor:
                        paged && !source.cursor ? "branches-page-2" : null
                    }
                  : source.kind === "review_requests"
                    ? {
                        kind: "review_requests" as const,
                        reviewRequests: [
                          {
                            id: source.cursor ? "review-8" : "review-7",
                            number: source.cursor ? 8 : 7,
                            title: source.cursor
                              ? "Later review"
                              : "Fixture review",
                            state: "open" as const,
                            draft: false,
                            sourceBranch: "feature",
                            targetBranch: "main",
                            headObjectId,
                            author: "author",
                            webUrl: "https://github.com/acme/repo/pull/7",
                            updatedAt: now
                          }
                        ],
                        nextCursor:
                          paged && !source.cursor ? "reviews-page-2" : null
                      }
                    : source.kind === "checks"
                      ? { kind: "checks" as const, checks: [] }
                      : source.kind === "comments"
                        ? {
                            kind: "comments" as const,
                            comments: source.cursor
                              ? [
                                  {
                                    id: "later-comment",
                                    author: "reviewer",
                                    body: "Later comment",
                                    createdAt: now,
                                    webUrl: null
                                  }
                                ]
                              : [],
                            nextCursor:
                              paged && !source.cursor ? "comments-page-2" : null
                          }
                        : {
                            kind: source.kind,
                            operationId: "33333333-3333-4333-8333-333333333333",
                            status: "completed" as const,
                            headObjectId
                          };
          return {
            requestId: request.requestId,
            executionId,
            operation: "source_control",
            result
          } as ManagedProjectResult;
        }
      );
      const api: ManagedProjectDesktopApi = {
        command,
        subscribe: () => () => undefined
      };
      await render(api, 1);
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Fixture review")
      );
      expect(container.textContent).toContain("Open review request");
      if (paged) {
        await act(async () => {
          [...container.querySelectorAll<HTMLButtonElement>("button")]
            .find(
              (button) => button.textContent === "Load more review requests"
            )!
            .click();
        });
        expect(container.textContent).toContain("Later review");
        await act(async () => {
          [...container.querySelectorAll<HTMLButtonElement>("button")]
            .find((button) => button.textContent === "Load more comments")!
            .click();
        });
        expect(container.textContent).toContain("Later comment");
      }
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Push current branch"]'
          )!
          .click();
      });
      const push = command.mock.calls
        .map(([request]) => request)
        .find(
          (request) =>
            request.operation === "source_control" &&
            request.sourceControlOperation.kind === "push"
        );
      expect(push).toMatchObject({
        sourceControlOperation: {
          kind: "push",
          expectedRemoteObjectId: remoteObjectId
        }
      });

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[aria-label="Fetch remote"]')
          ?.click();
      });
      await vi.waitFor(() =>
        expect(
          command.mock.calls.some(
            ([request]) =>
              request.operation === "source_control" &&
              request.sourceControlOperation.kind === "fetch"
          )
        ).toBe(true)
      );
      expect(JSON.stringify(command.mock.calls)).not.toContain(
        "https://github.com/acme/repo.git"
      );
    }
  );
});

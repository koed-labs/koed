// @vitest-environment happy-dom

import type {
  ManagedWorkspaceDesktopApi,
  ManagedWorkspaceRequest,
  ManagedWorkspaceResult
} from "../../../ipc/managed-workspace-protocol.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManagedWorkspaceCockpit } from "./ManagedWorkspaceCockpit.js";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    write() {}
    writeln() {}
    dispose() {}
  }
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  }
}));

const executionId = "11111111-1111-4111-8111-111111111111";
const now = "2026-08-19T00:00:00.000Z";

const diffResult = (requestId: string): ManagedWorkspaceResult => ({
  requestId,
  executionId,
  operation: "diff_read",
  value: {
    executionId,
    executionGeneration: 1,
    scope: "full",
    scopeKey: "full",
    fromCheckpointId: "22222222-2222-4222-8222-222222222222",
    toCheckpointId: "33333333-3333-4333-8333-333333333333",
    revisionDigest: "a".repeat(64),
    complete: true,
    truncated: false,
    fileCount: 1,
    byteCount: 42,
    diff: {
      fromCommitObjectId: "1".repeat(40),
      toCommitObjectId: "2".repeat(40),
      complete: true,
      files: [
        {
          path: "src/example.ts",
          status: "modified",
          binary: false,
          patch: "@@ -1 +1 @@\n-old\n+new",
          patchTruncated: false
        }
      ],
      fileCount: 1,
      returnedFileCount: 1,
      byteCount: 42,
      truncated: false,
      continuation: null,
      revisionDigest: "a".repeat(64)
    }
  }
});

describe("ManagedWorkspaceCockpit", () => {
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
    vi.unstubAllGlobals();
  });

  const render = async (api: ManagedWorkspaceDesktopApi, revision: number) => {
    await act(async () => {
      root.render(
        <ManagedWorkspaceCockpit
          api={api}
          identity={{ executionId, executionGeneration: 1 }}
          onAttachFile={vi.fn()}
          onAttachTerminal={vi.fn()}
          revision={revision}
        />
      );
    });
  };

  it("renders exact diffs and does not refresh terminals for unrelated revisions", async () => {
    const command = vi.fn(
      async (
        request: ManagedWorkspaceRequest
      ): Promise<ManagedWorkspaceResult> => {
        if (request.operation === "diff_read")
          return diffResult(request.requestId);
        if (request.operation === "terminal_list") {
          return { ...request, terminals: [] };
        }
        if (request.operation === "terminal_profiles") {
          return {
            ...request,
            profiles: [
              { id: "system_default", label: "System shell", available: true }
            ]
          };
        }
        throw new Error(`Unexpected operation ${request.operation}`);
      }
    );
    const api: ManagedWorkspaceDesktopApi = {
      command,
      subscribe: () => () => undefined
    };
    await render(api, 1);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open coding workspace"]'
        )
        ?.click();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("src/example.ts")
    );
    expect(container.textContent).toContain("+new");

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((button) => button.getAttribute("aria-label") === "Terminal")
        ?.click();
    });
    await vi.waitFor(() =>
      expect(
        command.mock.calls.filter(
          ([request]) => request.operation === "terminal_list"
        )
      ).toHaveLength(1)
    );
    await render(api, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      command.mock.calls.filter(
        ([request]) => request.operation === "terminal_list"
      )
    ).toHaveLength(1);
  });

  it("queues a confirmed Restore to the displayed baseline checkpoint", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    );
    const command = vi.fn(
      async (
        request: ManagedWorkspaceRequest
      ): Promise<ManagedWorkspaceResult> => {
        if (request.operation === "diff_read") {
          return diffResult(request.requestId);
        }
        if (request.operation === "checkpoint_restore") {
          return {
            requestId: request.requestId,
            executionId,
            operation: "checkpoint_restore",
            command: {
              id: "44444444-4444-4444-8444-444444444444",
              state: "queued",
              commandKind: "checkpoint_restore",
              executionId,
              executionGeneration: 1,
              createdAt: now
            }
          };
        }
        throw new Error(`Unexpected operation ${request.operation}`);
      }
    );
    const api: ManagedWorkspaceDesktopApi = {
      command,
      subscribe: () => () => undefined
    };

    await render(api, 1);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open coding workspace"]'
        )
        ?.click();
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Restore"));
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Restore"))
        ?.click();
    });

    await vi.waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "checkpoint_restore",
          executionId,
          executionGeneration: 1,
          checkpointId: "22222222-2222-4222-8222-222222222222",
          idempotencyKey: expect.stringMatching(/^checkpoint-restore:/)
        })
      )
    );
  });

  it("settles queued file work once initially and once after a realtime revision", async () => {
    const commandId = "22222222-2222-4222-8222-222222222222";
    let completed = false;
    const command = vi.fn(
      async (
        request: ManagedWorkspaceRequest
      ): Promise<ManagedWorkspaceResult> => {
        if (request.operation === "diff_read")
          return diffResult(request.requestId);
        if (request.operation === "file_start") {
          return {
            requestId: request.requestId,
            executionId,
            operation: "file_start",
            command: {
              id: commandId,
              state: "queued",
              commandKind: "file_browse",
              executionId,
              executionGeneration: 1,
              createdAt: now
            }
          };
        }
        if (request.operation === "file_result") {
          return {
            requestId: request.requestId,
            executionId,
            operation: "file_result",
            command: {
              id: commandId,
              state: completed ? "completed" : "queued",
              commandKind: "file_browse",
              executionId,
              executionGeneration: 1,
              createdAt: now
            },
            result: completed
              ? {
                  protocolVersion: 1,
                  checkpointId: "33333333-3333-4333-8333-333333333333",
                  checkpointSequence: 1,
                  revision: {
                    checkpointId: "33333333-3333-4333-8333-333333333333",
                    revisionDigest: "b".repeat(64)
                  },
                  kind: "browse",
                  path: "",
                  entries: [
                    {
                      path: "src",
                      name: "src",
                      entryKind: "directory",
                      size: null,
                      executable: false
                    }
                  ],
                  totalEntries: 1,
                  nextOffset: null
                }
              : null
          };
        }
        throw new Error(`Unexpected operation ${request.operation}`);
      }
    );
    const api: ManagedWorkspaceDesktopApi = {
      command,
      subscribe: () => () => undefined
    };
    await render(api, 1);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open coding workspace"]'
        )
        ?.click();
    });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((button) => button.getAttribute("aria-label") === "Files")
        ?.click();
    });
    await vi.waitFor(() =>
      expect(
        command.mock.calls.filter(
          ([request]) => request.operation === "file_result"
        )
      ).toHaveLength(1)
    );

    completed = true;
    await render(api, 2);
    await vi.waitFor(() => expect(container.textContent).toContain("src"));
    expect(
      command.mock.calls.filter(
        ([request]) => request.operation === "file_result"
      )
    ).toHaveLength(2);
  });

  it("attaches an available preview without receiving its navigation URL", async () => {
    const previewId = "66666666-6666-4666-8666-666666666666";
    const terminalId = "77777777-7777-4777-8777-777777777777";
    let subscribed:
      | Parameters<ManagedWorkspaceDesktopApi["subscribe"]>[0]
      | undefined;
    const command = vi.fn(
      async (
        request: ManagedWorkspaceRequest
      ): Promise<ManagedWorkspaceResult> => {
        if (request.operation === "diff_read")
          return diffResult(request.requestId);
        if (request.operation === "preview_list") {
          return {
            ...request,
            previews: [
              {
                id: previewId,
                executionId,
                executionGeneration: 1,
                lifecycleGeneration: 1,
                terminalId,
                state: "available",
                source: "terminal_output",
                policyVersion: 1,
                discoveredAt: now,
                updatedAt: now
              }
            ]
          };
        }
        if (request.operation === "terminal_list") {
          return { ...request, terminals: [] };
        }
        if (request.operation === "terminal_profiles") {
          return { ...request, profiles: [] };
        }
        if (request.operation === "preview_attach") {
          return { ...request, accepted: true };
        }
        if (request.operation === "preview_detach") {
          return { ...request, accepted: true };
        }
        throw new Error(`Unexpected operation ${request.operation}`);
      }
    );
    const api: ManagedWorkspaceDesktopApi = {
      command,
      subscribe: (listener) => {
        subscribed = listener;
        return () => undefined;
      }
    };
    await render(api, 1);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open coding workspace"]'
        )
        ?.click();
    });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((button) => button.getAttribute("aria-label") === "Preview")
        ?.click();
    });
    await vi.waitFor(() =>
      expect(
        command.mock.calls.some(
          ([request]) => request.operation === "preview_attach"
        )
      ).toBe(true)
    );
    expect(container.textContent).toContain("Preview 1");
    expect(JSON.stringify(command.mock.calls)).not.toContain("127.0.0.1");

    await act(async () => {
      subscribed?.({
        kind: "preview",
        surfaceId: (
          command.mock.calls.find(
            ([request]) => request.operation === "preview_attach"
          )?.[0] as Extract<
            ManagedWorkspaceRequest,
            { operation: "preview_attach" }
          >
        ).surfaceId,
        previewId,
        lifecycleGeneration: 1,
        state: "ready"
      });
    });
    expect(container.textContent).not.toContain("Loading preview");
  });

  it("renders provider-neutral source control and submits bounded mutations", async () => {
    const remoteIdentityHash = "b".repeat(64);
    const headObjectId = "a".repeat(40);
    const remoteObjectId = "c".repeat(40);
    const command = vi.fn(
      async (
        request: ManagedWorkspaceRequest
      ): Promise<ManagedWorkspaceResult> => {
        if (request.operation === "diff_read")
          return diffResult(request.requestId);
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
                    branches: [],
                    nextCursor: null
                  }
                : source.kind === "review_requests"
                  ? {
                      kind: "review_requests" as const,
                      reviewRequests: [
                        {
                          id: "review-7",
                          number: 7,
                          title: "Fixture review",
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
                      nextCursor: null
                    }
                  : source.kind === "checks"
                    ? { kind: "checks" as const, checks: [] }
                    : source.kind === "comments"
                      ? {
                          kind: "comments" as const,
                          comments: [],
                          nextCursor: null
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
        } as ManagedWorkspaceResult;
      }
    );
    const api: ManagedWorkspaceDesktopApi = {
      command,
      subscribe: () => () => undefined
    };
    await render(api, 1);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open coding workspace"]'
        )
        ?.click();
    });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find(
          (button) => button.getAttribute("aria-label") === "Source control"
        )
        ?.click();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Fixture review")
    );
    expect(container.textContent).toContain("Open review request");
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
  });
});

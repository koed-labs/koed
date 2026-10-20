// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceProjectWorkItem } from "@koed/shared";
import type { ManagedConversationDesktopApi } from "../../../ipc/managed-conversation-protocol.js";
import type { ManagedProjectDesktopApi } from "../../../ipc/managed-project-protocol.js";
import { SharedProjectExecution } from "./SharedProjectExecution.js";

vi.mock("../memory/ExecutionMemoryChips.js", () => ({
  ExecutionMemoryChips: ({ executionId }: { executionId: string }) => (
    <span data-testid="private-memory">{executionId}</span>
  )
}));

const item = {
  id: "team-item",
  title: "Review change",
  status: "review",
  prUrl: "https://github.example/acme/repo/pull/42",
  prState: "waiting_review",
  stepLabel: "Pull request open"
} as WorkspaceProjectWorkItem;
const binding = {
  teamWorkItemId: "team-item",
  executionId: "my-execution",
  agentId: "my-agent"
};

describe("Shared Project owner execution", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  const runtime = {
    operation: "runtime",
    executionId: "my-execution",
    executionGeneration: 7,
    items: []
  } as unknown as Awaited<ReturnType<ManagedConversationDesktopApi["runtime"]>>;
  const api = {
    runtime: vi.fn(async () => runtime)
  } as unknown as ManagedConversationDesktopApi;
  const render = async (
    managedProject: ManagedProjectDesktopApi,
    workItem = item
  ) => {
    await act(async () =>
      root.render(
        <SharedProjectExecution
          binding={binding}
          item={workItem}
          api={api}
          managedProject={managedProject}
          ownerId="owner"
          profileKey="profile"
          projectId="personal-project"
          panelActive={false}
          onPanelOpen={() => {}}
          onPanelClose={() => {}}
          onTeamRefresh={() => {}}
        />
      )
    );
  };
  it("uses only its private execution selector and the exact public PR URL for Native merge", async () => {
    const command = vi.fn(async (input: { operation: string }) => {
      if (input.operation === "source_control") {
        const request = input as unknown as {
          sourceControlOperation: { kind: string };
        };
        return request.sourceControlOperation.kind === "remotes"
          ? {
              operation: "source_control",
              result: {
                kind: "remotes",
                remotes: [
                  {
                    connectionState: "connected",
                    capabilities: ["review_request_read"],
                    host: "github.example",
                    remoteIdentityHash: "a".repeat(64)
                  }
                ]
              }
            }
          : {
              operation: "source_control",
              result: {
                kind: "review_request",
                reviewRequest: { webUrl: item.prUrl, state: "open", number: 42 }
              }
            };
      }
      if (input.operation === "source_control_merge_capability")
        return {
          operation: input.operation,
          result: {
            kind: "review_request_merge_capability",
            available: true,
            allowedMergeMethods: ["squash"]
          }
        };
      return {
        operation: "source_control_merge",
        result: { kind: "declined" }
      };
    });
    await render({ command } as unknown as ManagedProjectDesktopApi);
    expect(
      container.querySelector('[data-testid="private-memory"]')?.textContent
    ).toBe("my-execution");
    const merge = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === "Merge"
    );
    expect(merge).toBeTruthy();
    expect(merge?.parentElement?.className).toBe("hq-project-prs__actions");
    expect(merge?.closest(".hq-project-view__work-item-text")).toBeNull();
    await act(async () => merge!.click());
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "source_control_merge",
        executionId: "my-execution",
        executionGeneration: 7,
        reviewRequestNumber: 42,
        remoteIdentityHash: "a".repeat(64),
        mergeMethod: "squash"
      })
    );
    expect(JSON.stringify(command.mock.calls)).not.toContain("team-item");
  });
  it("does not offer Native merge when provider URL differs from Team PR", async () => {
    const command = vi.fn(async (input: { operation: string }) => {
      if (input.operation !== "source_control")
        throw new Error("No merge authority");
      const request = input as unknown as {
        sourceControlOperation: { kind: string };
      };
      return request.sourceControlOperation.kind === "remotes"
        ? {
            operation: "source_control",
            result: {
              kind: "remotes",
              remotes: [
                {
                  connectionState: "connected",
                  capabilities: ["review_request_read"],
                  host: "github.example",
                  remoteIdentityHash: "a".repeat(64)
                }
              ]
            }
          }
        : {
            operation: "source_control",
            result: {
              kind: "review_request",
              reviewRequest: {
                webUrl: "https://github.example/other/repo/pull/42",
                state: "open",
                number: 42
              }
            }
          };
    });
    await render({ command } as unknown as ManagedProjectDesktopApi);
    expect(container.textContent).not.toContain("Merge");
    expect(command.mock.calls.map(([input]) => input.operation)).not.toContain(
      "source_control_merge_capability"
    );
  });
});

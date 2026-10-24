// @vitest-environment happy-dom
import { randomUUID } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectHqConversationDesktopApi } from "../../../ipc/project-hq-conversation-protocol.js";
import type { ManagedConversationDesktopApi } from "../../../ipc/managed-conversation-protocol.js";
import type { DesktopApi } from "../../../types.js";
import { HqProjectConversation } from "./HqProjectConversation.js";

const activeProps = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null
}));
vi.mock("../conversation/HqConversation.js", () => ({
  HqActiveConversation: (props: Record<string, unknown>) => {
    activeProps.value = props;
    return <div>Captured HQ</div>;
  },
  HqConversationSettings: () => null
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  vi.useRealTimers();
});

const renderHq = async (input: {
  projectId: string;
  ownerIdentity: string;
  api: ProjectHqConversationDesktopApi;
  catchUpEnabled?: boolean;
  onOpenTeam?: () => void;
  teamUnreadCount?: number;
  foreground?: boolean;
  activityRevision?: string;
  chiefInstanceId?: string | null;
  managedConversations?: ManagedConversationDesktopApi;
  localAiClients?: DesktopApi["localAiClients"];
}) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const render = async (next = input) =>
    act(async () => {
      root.render(
        <HqProjectConversation
          project={
            { id: next.projectId, name: "Project", path: "/project" } as never
          }
          chiefName="Chief"
          chiefInstanceId={next.chiefInstanceId ?? null}
          localAiClients={next.localAiClients}
          usageAuthorityKey="owner:profile:revision"
          usageDismissalScopeKey="owner:profile"
          api={next.api}
          managedConversations={
            next.managedConversations ??
            ({
              launchOptions: async () => ({
                options: { runners: [], instances: [] }
              }),
              inspect: async () => ({ status: "starting", conversation: null })
            } as never)
          }
          managedProject={null}
          store={{ registerPrivateThread: () => undefined } as never}
          lifecycle={{} as never}
          markdownAdapters={{} as never}
          ownerIdentity={next.ownerIdentity}
          catchUpEnabled={next.catchUpEnabled}
          onOpenTeam={next.onOpenTeam}
          teamUnreadCount={next.teamUnreadCount}
          foreground={next.foreground}
          activityRevision={next.activityRevision}
        />
      );
    });
  await render();
  return { host, render };
};

describe("Project HQ trusted catch-up presentation", () => {
  it("warns in a cold Project HQ and forwards usage authority to the active HQ", async () => {
    const projectId = randomUUID();
    const executionId = randomUUID();
    const conversation = {
      executionId,
      projectId,
      capturedSessionId: randomUUID(),
      threadId: randomUUID(),
      executionOwner: { driverId: "codex", instanceId: "codex.fixture" }
    };
    const options = {
      runners: [],
      instances: [
        {
          instanceId: "codex.fixture",
          driverId: "codex",
          displayName: "Codex",
          ready: true,
          models: [
            {
              id: "gpt-fixture",
              isDefault: true,
              supportedReasoningEfforts: ["medium"]
            }
          ],
          capabilities: {
            defaultPermissionMode: "supervised",
            permissionModes: [{ mode: "supervised", support: "supported" }]
          }
        }
      ]
    };
    const managedConversations = {
      launchOptions: async () => ({ operation: "launch_options", options }),
      inspect: async () => ({ status: "ready", conversation })
    } as unknown as ManagedConversationDesktopApi;
    const localAiClients = {
      usage: async () => ({
        operation: "usage",
        usageScopeId: "account-a",
        readModel: {
          instances: [],
          capabilitySnapshots: [],
          settings: [],
          defaults: {}
        },
        usage: [
          {
            instanceId: "codex.fixture",
            accountVerified: true,
            source: "codex_app_server",
            bucketId: "codex",
            bucketName: "Codex",
            window: "secondary",
            windowDurationMins: 10080,
            usedPercent: 96,
            status: "near_limit",
            resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
            planType: null,
            details: {
              ordinaryUsageAllowed: true,
              spendControlReached: false,
              rateLimitReachedType: null
            },
            observedAt: new Date(Date.now() - 60_000).toISOString()
          }
        ]
      })
    } as unknown as DesktopApi["localAiClients"];
    const coldApi = {
      reserve: async () => ({ projectId, executionId: null })
    } as unknown as ProjectHqConversationDesktopApi;
    const { host } = await renderHq({
      projectId,
      ownerIdentity: "owner:profile",
      api: coldApi,
      chiefInstanceId: "codex.fixture",
      managedConversations,
      localAiClients
    });
    await act(async () => {
      const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(input, "Project HQ request");
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    expect(host.querySelector(".hq-usage-suggestion")?.textContent).toContain(
      "4% of this week left"
    );
    expect(host.querySelector(".hq-usage-suggestion__primary")).toBeNull();
    const activeApi = {
      reserve: async () => ({ projectId, executionId }),
      read: async () => ({
        conversation: { executionId },
        execution: {
          capturedSessionId: conversation.capturedSessionId,
          graphProjectId: projectId,
          graphThreadId: conversation.threadId
        }
      })
    } as unknown as ProjectHqConversationDesktopApi;
    await renderHq({
      projectId,
      ownerIdentity: "owner:profile",
      api: activeApi,
      chiefInstanceId: "codex.fixture",
      managedConversations,
      localAiClients
    });
    expect(activeProps.value).toMatchObject({
      privateProjectHq: true,
      localAiClients,
      usageAuthorityKey: "owner:profile:revision",
      usageDismissalScopeKey: "owner:profile"
    });
  });
  it("does not launch catch-up before the verified feature gate is enabled", async () => {
    const projectId = randomUUID();
    const catchUp = vi.fn();
    const api = {
      reserve: vi.fn(async () => ({ projectId, executionId: null })),
      catchUp
    } as unknown as ProjectHqConversationDesktopApi;
    await renderHq({ projectId, ownerIdentity: "owner-a", api });
    expect(api.reserve).toHaveBeenCalledWith(projectId);
    expect(catchUp).not.toHaveBeenCalled();
  });

  it("offers explicit Retry only after pre-send proof and keeps one request ID after an unknown response", async () => {
    const projectId = randomUUID();
    const executionId = randomUUID();
    const failedCommandId = randomUUID();
    const retryCatchUp = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"));
    const api = {
      reserve: vi.fn(async () => ({ projectId, executionId: null })),
      catchUp: vi.fn(async () => ({
        projectId,
        status: "retry_available",
        executionId,
        commandId: failedCommandId
      })),
      retryCatchUp
    } as unknown as ProjectHqConversationDesktopApi;
    const { host } = await renderHq({
      projectId,
      ownerIdentity: "owner-a",
      api,
      catchUpEnabled: true
    });
    const retry = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Retry catch-up")
    );
    expect(retry).toBeTruthy();
    await act(async () => retry!.click());
    await act(async () => retry!.click());
    expect(retryCatchUp).toHaveBeenCalledTimes(2);
    expect(retryCatchUp.mock.calls[0]?.slice(0, 2)).toEqual([
      projectId,
      failedCommandId
    ]);
    expect(retryCatchUp.mock.calls[0]?.[2]).toBe(
      retryCatchUp.mock.calls[1]?.[2]
    );
  });

  it("discards a stale catch-up response after owner identity changes", async () => {
    const firstProjectId = randomUUID();
    const secondProjectId = randomUUID();
    let releaseFirst: ((value: unknown) => void) | null = null;
    const api = {
      reserve: vi.fn(async (projectId: string) => ({
        projectId,
        executionId: null
      })),
      catchUp: vi.fn((projectId: string) =>
        projectId === firstProjectId
          ? new Promise((resolve) => {
              releaseFirst = resolve;
            })
          : Promise.resolve({
              projectId,
              status: "nothing",
              executionId: null,
              commandId: null
            })
      )
    } as unknown as ProjectHqConversationDesktopApi;
    const mountedHq = await renderHq({
      projectId: firstProjectId,
      ownerIdentity: "owner-a",
      api,
      catchUpEnabled: true
    });
    await mountedHq.render({
      projectId: secondProjectId,
      ownerIdentity: "owner-b",
      api,
      catchUpEnabled: true
    });
    await act(async () =>
      releaseFirst?.({
        projectId: firstProjectId,
        status: "retry_available",
        executionId: randomUUID(),
        commandId: randomUUID()
      })
    );
    expect(mountedHq.host.textContent).not.toContain("stopped before reaching");
  });

  it("discards an old owner response after an A to B to A scope return", async () => {
    const projectId = randomUUID();
    let releaseOld: ((value: unknown) => void) | null = null;
    const catchUp = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseOld = resolve;
          })
      )
      .mockResolvedValue({
        projectId,
        status: "nothing",
        executionId: null,
        commandId: null
      });
    const api = {
      reserve: vi.fn(async () => ({ projectId, executionId: null })),
      catchUp
    } as unknown as ProjectHqConversationDesktopApi;
    const mountedHq = await renderHq({
      projectId,
      ownerIdentity: "owner-a",
      api,
      catchUpEnabled: true
    });
    await mountedHq.render({
      projectId,
      ownerIdentity: "owner-b",
      api,
      catchUpEnabled: true
    });
    await mountedHq.render({
      projectId,
      ownerIdentity: "owner-a",
      api,
      catchUpEnabled: true
    });
    await act(async () =>
      releaseOld?.({
        projectId,
        status: "retry_available",
        executionId: randomUUID(),
        commandId: randomUUID()
      })
    );
    expect(catchUp).toHaveBeenCalledTimes(3);
    expect(mountedHq.host.textContent).not.toContain("stopped before reaching");
  });

  it("shows the current Team unread count even when no catch-up turn is pending", async () => {
    const projectId = randomUUID();
    const onOpenTeam = vi.fn();
    const api = {
      reserve: vi.fn(async () => ({ projectId, executionId: null })),
      catchUp: vi.fn(async () => ({
        projectId,
        status: "nothing",
        executionId: null,
        commandId: null
      }))
    } as unknown as ProjectHqConversationDesktopApi;
    const hq = await renderHq({
      projectId,
      ownerIdentity: "owner-a",
      api,
      catchUpEnabled: true,
      onOpenTeam,
      teamUnreadCount: 1
    });
    const line = Array.from(hq.host.querySelectorAll("button")).find(
      (button) => button.textContent === "1 new message in Team"
    );
    expect(line).toBeTruthy();
    await act(async () => line!.click());
    expect(onOpenTeam).toHaveBeenCalledOnce();
    await hq.render({
      projectId,
      ownerIdentity: "owner-a",
      api,
      catchUpEnabled: true,
      onOpenTeam,
      teamUnreadCount: 3
    });
    expect(hq.host.textContent).toContain("3 new messages in Team");
  });

  it("rechecks a cold start, then the retained reply ACK, and opens only the linked Team tab", async () => {
    const projectId = randomUUID();
    const executionId = randomUUID();
    const onOpenTeam = vi.fn();
    const catchUp = vi
      .fn()
      .mockResolvedValueOnce({
        projectId,
        status: "starting",
        executionId,
        commandId: null
      })
      .mockResolvedValueOnce({
        projectId,
        status: "queued",
        executionId,
        commandId: randomUUID()
      })
      .mockResolvedValueOnce({
        projectId,
        status: "nothing",
        executionId,
        commandId: null
      });
    const api = {
      reserve: vi.fn(async () => ({ projectId, executionId: null })),
      catchUp
    } as unknown as ProjectHqConversationDesktopApi;
    vi.useFakeTimers();
    const { host } = await renderHq({
      projectId,
      ownerIdentity: "owner-a",
      api,
      catchUpEnabled: true,
      onOpenTeam
    });
    expect(catchUp).toHaveBeenCalledTimes(1);
    const openTeam = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Open Team")
    );
    expect(openTeam).toBeTruthy();
    await act(async () => openTeam!.click());
    expect(onOpenTeam).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(catchUp).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Catching up on this Project");
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(catchUp).toHaveBeenCalledTimes(3);
    expect(host.textContent).not.toContain("Catching up on this Project");
    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(catchUp).toHaveBeenCalledTimes(3);
  });

  it("detects a newly ready Source while the same foreground HQ remains open", async () => {
    const projectId = randomUUID();
    const executionId = randomUUID();
    const catchUp = vi
      .fn()
      .mockResolvedValueOnce({
        projectId,
        status: "nothing",
        executionId,
        commandId: null
      })
      .mockResolvedValueOnce({
        projectId,
        status: "queued",
        executionId,
        commandId: randomUUID()
      })
      .mockResolvedValueOnce({
        projectId,
        status: "nothing",
        executionId,
        commandId: null
      });
    const api = {
      reserve: vi.fn(async () => ({ projectId, executionId })),
      catchUp
    } as unknown as ProjectHqConversationDesktopApi;
    vi.useFakeTimers();
    const { host } = await renderHq({
      projectId,
      ownerIdentity: "owner-a",
      api,
      catchUpEnabled: true,
      foreground: true
    });
    expect(catchUp).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(catchUp).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Catching up on this Project");
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(catchUp).toHaveBeenCalledTimes(3);
    expect(host.textContent).not.toContain("Catching up on this Project");
  });
});

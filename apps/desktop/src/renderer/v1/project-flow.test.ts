// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../project-memory-ui.js";
import type { V1ConversationIntent } from "../../ipc/v1-state-protocol.js";
import {
  acknowledgeLateV1Capture,
  confirmV1ProjectMembership,
  lateV1CaptureSessionId,
  selectV1ExecutionTarget,
  useV1ProjectMembershipReconciler
} from "./project-flow.js";

const project = {
  id: "project-one",
  name: "Project one",
  namedProject: { projectId: "named-one", version: 7 }
} as DesktopProject;
const independent = {
  id: "independent",
  localProjectId: "lp_independent"
} as DesktopProject;
const intent = {
  idempotencyKey: "launch-one",
  projectId: "lp_independent",
  presentationProjectId: "project-one"
} as V1ConversationIntent;
type Manage = NonNullable<PersonalDesktopApi["manageProject"]>;
type ManagedResult = Awaited<ReturnType<Manage>>;
const reviewed = (included: boolean, excluded = false): ManagedResult =>
  ({
    project: { projectId: "named-one", version: 7 },
    explanation: {
      sessionId: "session-one",
      included,
      reasons: [],
      exclusion: excluded ? { exclusionId: "exclusion-one" } : null,
      syncExclusion: null
    }
  }) as unknown as ManagedResult;

describe("v1 Project launch and membership", () => {
  it("keeps a membership attempt alive across unrelated effect rerenders and retries only on request", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    let settle!: () => void;
    const confirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        })
    );
    const onError = vi.fn();
    const currentScope = () => "owner-one";
    const liveIntent = {
      ...intent,
      executionId: "execution-one",
      capturedSessionId: "session-one"
    };
    function Harness({
      unrelated,
      retry
    }: {
      unrelated: number;
      retry: number;
    }) {
      useV1ProjectMembershipReconciler({
        enabled: true,
        scopeKey: "owner-one",
        intents: [liveIntent],
        retryRevision: retry,
        currentScope,
        confirm,
        onError
      });
      return createElement("span", null, unrelated);
    }
    await act(async () => {
      root.render(createElement(Harness, { unrelated: 0, retry: 0 }));
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(createElement(Harness, { unrelated: 1, retry: 0 }));
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle();
    });
    await act(async () => {
      root.render(createElement(Harness, { unrelated: 2, retry: 1 }));
    });
    expect(confirm).toHaveBeenCalledTimes(2);
    await act(async () => {
      settle();
      root.unmount();
    });
    node.remove();
  });
  it("uses a late captured ID from realtime or lifecycle but ignores the provisional execution ID", () => {
    const launched = { ...intent, executionId: "execution-one" };
    expect(lateV1CaptureSessionId(launched, null, "execution-one")).toBeNull();
    expect(lateV1CaptureSessionId(launched, null, "session-one")).toBe(
      "session-one"
    );
    expect(lateV1CaptureSessionId(launched, "session-two", "session-one")).toBe(
      "session-two"
    );
    expect(
      lateV1CaptureSessionId(
        { ...launched, capturedSessionId: "session-one" },
        null,
        "session-one"
      )
    ).toBeNull();
  });
  it("acknowledges a session delivered after launch", async () => {
    const ack = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    await expect(
      acknowledgeLateV1Capture({
        intent: { ...intent, executionId: "execution-one" },
        sessionId: "session-one",
        scope: "owner-one",
        currentScope: () => "owner-one",
        ack,
        refresh
      })
    ).resolves.toBe(true);
    expect(ack).toHaveBeenCalledWith({
      idempotencyKey: "launch-one",
      executionId: "execution-one",
      capturedSessionId: "session-one"
    });
    expect(refresh).toHaveBeenCalledOnce();
    await expect(
      acknowledgeLateV1Capture({
        intent: {
          ...intent,
          executionId: "execution-one",
          capturedSessionId: "session-one"
        },
        sessionId: "session-one",
        scope: "owner-one",
        currentScope: () => "owner-one",
        ack,
        refresh
      })
    ).resolves.toBe(false);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge late capture after an owner scope switch", async () => {
    const ack = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    await expect(
      acknowledgeLateV1Capture({
        intent: { ...intent, executionId: "execution-one" },
        sessionId: "session-one",
        scope: "owner-one",
        currentScope: () => "owner-two",
        ack,
        refresh
      })
    ).resolves.toBe(false);
    expect(ack).not.toHaveBeenCalled();
  });
  it("uses an independent Folder for a folderless Project and requires a choice when several Folders match", () => {
    expect(
      selectV1ExecutionTarget({
        selectedProjectId: "project-one",
        folders: [],
        activeProject: project,
        independentProject: independent
      })
    ).toMatchObject({
      executionProject: independent,
      executionProjectId: "lp_independent",
      selectedFolder: null
    });
    const folders = [
      { id: "folder-one", path: "/one" },
      { id: "folder-two", path: "/two" }
    ] as unknown as Parameters<typeof selectV1ExecutionTarget>[0]["folders"];
    expect(
      selectV1ExecutionTarget({
        selectedProjectId: "project-one",
        folders,
        activeProject: project,
        independentProject: independent
      })
    ).toMatchObject({
      executionProject: project,
      executionProjectId: null,
      selectedFolder: null
    });
    expect(
      selectV1ExecutionTarget({
        selectedProjectId: "project-one",
        folders,
        selectedFolderId: "folder-two",
        activeProject: project,
        independentProject: independent
      }).executionProjectId
    ).toBe("folder-two");
  });

  const setup = (result: ManagedResult) => {
    let scope = "owner-one";
    const manageProject = vi.fn<Manage>(async () => result);
    const ack = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    const loadProject = vi.fn(async () => project);
    const run = () =>
      confirmV1ProjectMembership({
        intent,
        executionId: "execution-one",
        sessionId: "session-one",
        scope: "owner-one",
        currentScope: () => scope,
        loadProject,
        manageProject,
        ack,
        refresh
      });
    return {
      run,
      manageProject,
      ack,
      refresh,
      loadProject,
      setScope: (next: string) => {
        scope = next;
      }
    };
  };

  it("acks an already-included Conversation without adding it twice", async () => {
    const flow = setup(reviewed(true));
    await expect(flow.run()).resolves.toBe(true);
    expect(flow.manageProject).toHaveBeenCalledTimes(1);
    expect(flow.manageProject).toHaveBeenCalledWith({
      action: "explain_session",
      projectId: "project-one",
      expectedVersion: 7,
      sessionId: "session-one"
    });
    expect(flow.ack).toHaveBeenCalledWith({
      idempotencyKey: "launch-one",
      executionId: "execution-one",
      capturedSessionId: "session-one",
      projectMembershipConfirmed: true
    });
    expect(flow.refresh).toHaveBeenCalledOnce();
  });

  it("skips a Conversation whose membership was already acknowledged", async () => {
    const flow = setup(reviewed(true));
    await expect(
      confirmV1ProjectMembership({
        intent: { ...intent, projectMembershipConfirmed: true },
        executionId: "execution-one",
        sessionId: "session-one",
        scope: "owner-one",
        currentScope: () => "owner-one",
        loadProject: flow.loadProject,
        manageProject: flow.manageProject,
        ack: flow.ack,
        refresh: flow.refresh
      })
    ).resolves.toBe(false);
    expect(flow.loadProject).not.toHaveBeenCalled();
    expect(flow.manageProject).not.toHaveBeenCalled();
    expect(flow.ack).not.toHaveBeenCalled();
  });

  it("adds a Conversation using the reviewed version", async () => {
    const flow = setup(reviewed(false));
    await expect(flow.run()).resolves.toBe(true);
    expect(flow.manageProject).toHaveBeenNthCalledWith(2, {
      action: "add_session",
      projectId: "project-one",
      expectedVersion: 7,
      sessionId: "session-one"
    });
  });

  it("respects an exclusion and leaves the acknowledgement pending", async () => {
    const flow = setup(reviewed(false, true));
    await expect(flow.run()).rejects.toThrow("excluded");
    expect(flow.manageProject).toHaveBeenCalledTimes(1);
    expect(flow.ack).not.toHaveBeenCalled();
  });

  it("does not mutate membership after the owner scope changes during load or review", async () => {
    const load = setup(reviewed(false));
    load.loadProject.mockImplementation(async () => {
      load.setScope("owner-two");
      return project;
    });
    await expect(load.run()).resolves.toBe(false);
    expect(load.manageProject).not.toHaveBeenCalled();
    expect(load.ack).not.toHaveBeenCalled();

    const review = setup(reviewed(false));
    review.manageProject.mockImplementation(async () => {
      review.setScope("owner-two");
      return reviewed(false);
    });
    await expect(review.run()).resolves.toBe(false);
    expect(review.manageProject).toHaveBeenCalledTimes(1);
    expect(review.ack).not.toHaveBeenCalled();
  });
});

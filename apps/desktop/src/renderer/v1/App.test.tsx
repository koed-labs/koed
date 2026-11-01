// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { DesktopProject } from "../../project-memory-ui.js";
import type { V1Profile, V1Provenance } from "../../ipc/v1-state-protocol.js";
import {
  createV1ProfileWriter,
  projectConversationRows,
  projectConversationSummary,
  projectConversationTime,
  projectPageConversations,
  selectV1History,
  selectV1Projects,
  shouldShowV1Onboarding
} from "./App.js";

const profile = (): V1Profile => ({
  onboarding: { selections: {}, completed: false }
});
const provenance = (): V1Provenance => ({
  schemaVersion: 1,
  conversations: {},
  projects: {}
});
const project = (id: string): DesktopProject =>
  ({ id, name: id, namedProject: { projectId: id } }) as DesktopProject;

describe("V1 app state", () => {
  it("shows a launched Project chat before capture and replaces it with the captured row", () => {
    const state = provenance();
    state.conversations["launch-one"] = {
      idempotencyKey: "launch-one",
      projectId: "independent",
      presentationProjectId: "project-one",
      executionId: "execution-one",
      aiClientDriverId: "codex",
      aiClientInstanceId: "client-one",
      model: "model-one",
      reasoningEffort: null,
      permissionMode: "supervised",
      runnerKind: "local_device",
      createdAt: "2026-10-01T12:00:00Z"
    };
    const rows = projectPageConversations(
      "project-one",
      [],
      Object.values(state.conversations),
      new Map()
    );
    expect(rows).toMatchObject([
      {
        key: "execution-one",
        pendingCapture: true,
        pendingLabel: "Waiting for capture"
      }
    ]);
    state.conversations["launch-one"]!.capturedSessionId = "session-one";
    expect(
      projectPageConversations(
        "project-one",
        [],
        Object.values(state.conversations),
        new Map()
      )
    ).toMatchObject([
      { pendingCapture: false, pendingLabel: "Adding to Project" }
    ]);
    const captured = [
      {
        id: "source-one",
        sessionId: "session-one",
        name: "Captured title",
        sample: "Real answer",
        latestAt: "2026-10-01T13:00:00Z"
      }
    ] as DesktopProject["threads"];
    expect(
      projectPageConversations(
        "project-one",
        captured,
        Object.values(state.conversations),
        new Map()
      )
    ).toMatchObject([
      {
        key: "session-one",
        executionId: "execution-one",
        title: "Captured title",
        pendingCapture: false
      }
    ]);
    state.conversations["launch-one"]!.projectMembershipConfirmed = true;
    expect(
      projectPageConversations(
        "project-one",
        [],
        Object.values(state.conversations),
        new Map()
      )
    ).toEqual([]);
  });
  it("shows only captured v1 Conversations included in a Project, newest first", () => {
    const alpha = {
      id: "alpha",
      sessionId: "alpha",
      latestAt: "2026-10-01T12:00:00Z",
      sample: "  First\n reply  "
    };
    const beta = {
      id: "beta",
      sessionId: "beta",
      latestAt: "2026-10-02T12:00:00Z",
      sample: "Second"
    };
    const external = {
      id: "external",
      sessionId: "external",
      latestAt: "2026-10-03T12:00:00Z",
      sample: "External"
    };
    const selected = project("project");
    selected.threads = [alpha, external, beta] as DesktopProject["threads"];
    expect(
      projectConversationRows(selected, new Set(["alpha", "beta"])).map(
        (thread) => thread.id
      )
    ).toEqual(["beta", "alpha"]);
    expect(
      projectConversationSummary(alpha as DesktopProject["threads"][number])
    ).toBe("First reply");
    expect(
      projectConversationSummary({
        ...alpha,
        sample: "  "
      } as DesktopProject["threads"][number])
    ).toBe("No messages yet");
    expect(projectConversationTime("invalid")).toBe("");
    expect(
      projectConversationTime(
        "2026-10-02T12:00:00Z",
        new Date("2026-10-03T12:00:00Z")
      )
    ).toBe("Yesterday");
  });
  it("filters captured external Projects and Conversations by exact local provenance", () => {
    const state = provenance();
    state.projects["00000000-0000-4000-8000-000000000001"] = {
      requestId: "00000000-0000-4000-8000-000000000001",
      name: "Made here",
      projectId: "00000000-0000-4000-8000-000000000002",
      createdAt: new Date().toISOString()
    };
    state.conversations["start-a"] = {
      idempotencyKey: "start-a",
      projectId: "folder-a",
      aiClientDriverId: "codex",
      aiClientInstanceId: "client-a",
      model: "model-a",
      reasoningEffort: null,
      permissionMode: "supervised",
      runnerKind: "local_device",
      executionId: "00000000-0000-4000-8000-000000000003",
      createdAt: new Date().toISOString()
    };
    expect(
      selectV1Projects(
        [
          project("00000000-0000-4000-8000-000000000002"),
          project("00000000-0000-4000-8000-000000000099")
        ],
        state
      ).map((item) => item.id)
    ).toEqual(["00000000-0000-4000-8000-000000000002"]);
    expect(selectV1History(state).map((item) => item.executionId)).toEqual([
      "00000000-0000-4000-8000-000000000003"
    ]);
  });

  it("serializes onboarding saves and keeps completion after a late draft", async () => {
    let current = profile();
    const writes: V1Profile[] = [];
    const save = createV1ProfileWriter(
      () => current,
      async (next) => {
        await Promise.resolve();
        writes.push(next);
        return next;
      },
      (next) => {
        current = next;
      }
    );
    const draft = save((value) => ({
      ...value,
      onboarding: { ...value.onboarding, step: "memory" }
    }));
    const agent = save((value) => ({ ...value, agentName: "Ada" }));
    const complete = save((value) => ({
      ...value,
      onboarding: { ...value.onboarding, completed: true }
    }));
    await Promise.all([draft, agent, complete]);
    await save((value) =>
      value.onboarding.completed
        ? value
        : { ...value, onboarding: { ...value.onboarding, step: "intro" } }
    );
    expect(writes).toHaveLength(3);
    expect(current.agentName).toBe("Ada");
    expect(current.onboarding).toMatchObject({
      step: "memory",
      completed: true
    });
    expect(shouldShowV1Onboarding(current, true)).toBe(false);
    expect(shouldShowV1Onboarding(current, false)).toBe(true);
  });
});

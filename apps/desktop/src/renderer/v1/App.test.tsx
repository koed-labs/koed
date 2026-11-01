// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { DesktopProject } from "../../project-memory-ui.js";
import type { V1Profile, V1Provenance } from "../../ipc/v1-state-protocol.js";
import {
  createV1ProfileWriter,
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

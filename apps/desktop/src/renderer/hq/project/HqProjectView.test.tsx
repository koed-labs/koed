import { describe, expect, it } from "vitest";
import type { Project } from "@koed/shared";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { projectHqExecutionBelongsTo } from "./HqProjectView.js";

const personalId = "00000000-0000-4000-8000-000000002071";
const anotherPersonalId = "00000000-0000-4000-8000-000000002072";
const graphId = "graph-koed";
const sessionId = "00000000-0000-4000-8000-000000002073";
const projects = [
  { id: personalId, name: "Koed" },
  { id: anotherPersonalId, name: "Other" }
] as Project[];
const graphProjects = [
  {
    id: graphId,
    threads: [
      { id: "thread-one", sessionId, personalProjectId: personalId },
      {
        id: "thread-two",
        sessionId: "other-session",
        personalProjectId: anotherPersonalId
      }
    ]
  }
] as DesktopProject[];

describe("Project HQ runtime identity", () => {
  it("accepts the canonical Personal Project ID and only captured sessions linked to that Project", () => {
    const entry = {
      executionId: "run",
      projectId: graphId,
      sessionId,
      threadId: "thread-one",
      state: "running"
    };
    expect(
      projectHqExecutionBelongsTo(entry, personalId, projects, graphProjects)
    ).toBe(true);
    expect(
      projectHqExecutionBelongsTo(
        entry,
        anotherPersonalId,
        projects,
        graphProjects
      )
    ).toBe(false);
    expect(
      projectHqExecutionBelongsTo(
        { ...entry, sessionId: "unknown" },
        personalId,
        projects,
        graphProjects
      )
    ).toBe(false);
    expect(
      projectHqExecutionBelongsTo(
        { ...entry, projectId: anotherPersonalId },
        personalId,
        projects,
        graphProjects
      )
    ).toBe(false);
    expect(
      projectHqExecutionBelongsTo(
        { ...entry, projectId: personalId, sessionId: null },
        personalId,
        projects,
        graphProjects
      )
    ).toBe(true);
  });
});

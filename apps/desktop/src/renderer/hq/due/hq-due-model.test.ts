import { describe, expect, it } from "vitest";
import type { Project } from "@koed/shared/project-contract";
import type { WorkItem } from "@koed/shared/work-item-contract";
import type { WorkspaceProjectWorkItem } from "@koed/shared";
import {
  dueChip,
  dueChoiceDate,
  nowDeadlineItems,
  nowSharedDeadlineItems
} from "./hq-due-model.js";

const project = { id: "project-a", name: "Econ 101" } as Project;
const item = (
  id: string,
  dueOn: string | null,
  status: WorkItem["status"] = "todo",
  executionId: string | null = null
) =>
  ({
    id,
    projectId: project.id,
    title: id,
    dueOn,
    status,
    executionId,
    updatedAt: "2026-10-20T00:00:00.000Z"
  }) as WorkItem;

describe("HQ deadline model", () => {
  it("reads one calendar date in each viewer's time zone without moving its stored date", () => {
    const instant = new Date("2026-10-20T23:30:00.000Z");
    expect(dueChip("2026-10-22", "Asia/Tokyo", instant)?.[1]).toBe(
      "Due tomorrow"
    );
    expect(dueChip("2026-10-22", "America/Los_Angeles", instant)?.[1]).toBe(
      "Due Thu"
    );
    expect(dueChoiceDate("today", "Asia/Tokyo", instant)).toBe("2026-10-21");
    expect(dueChoiceDate("today", "America/Los_Angeles", instant)).toBe(
      "2026-10-20"
    );
    expect(dueChoiceDate("friday", "Asia/Tokyo", instant)).toBe("2026-10-23");
    expect(dueChoiceDate("next week", "Asia/Tokyo", instant)).toBe(
      "2026-10-26"
    );
    expect(dueChoiceDate("no date", "Asia/Tokyo", instant)).toBeNull();
  });

  it("orders overdue before today and tomorrow, excludes agent work and deduplicates", () => {
    const now = new Date("2026-10-20T12:00:00.000Z");
    const rows = [
      item("tomorrow", "2026-10-21"),
      item("overdue", "2026-10-18"),
      item("today", "2026-10-20"),
      item("agent-on-it", "2026-10-19", "doing", "execution"),
      item("later", "2026-10-23"),
      item("done", "2026-10-23", "done"),
      item("tomorrow", "2026-10-21")
    ];
    const { soon, week } = nowDeadlineItems(
      [project],
      new Map([[project.id, rows]]),
      "UTC",
      now
    );
    expect(soon.map(({ item }) => item.id)).toEqual([
      "overdue",
      "today",
      "tomorrow"
    ]);
    expect(week.map(({ item }) => item.id)).toEqual(["later"]);
  });

  it("includes the seventh day shown by v50 and excludes later dates", () => {
    const now = new Date("2026-10-20T12:00:00.000Z");
    const rows = [
      item("seventh-day", "2026-10-27"),
      item("eighth-day", "2026-10-28")
    ];
    expect(
      nowDeadlineItems(
        [project],
        new Map([[project.id, rows]]),
        "UTC",
        now
      ).week.map(({ item }) => item.id)
    ).toEqual(["seventh-day"]);
    const sharedRows = rows.map((row) => ({
      ...row,
      dispatchKey: null
    })) as unknown as WorkspaceProjectWorkItem[];
    expect(
      nowSharedDeadlineItems(
        [project],
        new Map([[project.id, sharedRows]]),
        "UTC",
        now
      ).week.map(({ item }) => item.id)
    ).toEqual(["seventh-day"]);
  });

  it("uses Team Work Item IDs and dispatch state for shared deadlines", () => {
    const now = new Date("2026-10-20T12:00:00.000Z");
    const teamItem = (
      id: string,
      dueOn: string,
      dispatchKey: string | null = null
    ) =>
      ({
        id,
        title: id,
        dueOn,
        dispatchKey,
        status: "todo",
        updatedAt: "2026-10-20T00:00:00.000Z"
      }) as WorkspaceProjectWorkItem;
    const shared = {
      ...project,
      workspaceProjectId: "team-project-id"
    } as Project;
    const rows = [
      teamItem("team-tomorrow", "2026-10-21"),
      teamItem("team-overdue", "2026-10-18"),
      teamItem("team-agent", "2026-10-19", "dispatch"),
      teamItem("team-friday", "2026-10-23"),
      teamItem("team-overdue", "2026-10-18")
    ];
    const { soon, week } = nowSharedDeadlineItems(
      [shared],
      new Map([[shared.id, rows]]),
      "UTC",
      now
    );
    expect(soon.map(({ item }) => item.id)).toEqual([
      "team-overdue",
      "team-tomorrow"
    ]);
    expect(week.map(({ item }) => item.id)).toEqual(["team-friday"]);
    expect(soon.every((entry) => entry.authority === "team")).toBe(true);
  });
});

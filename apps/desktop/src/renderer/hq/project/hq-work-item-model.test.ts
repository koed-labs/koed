import { describe, expect, it } from "vitest";
import type { WorkItem } from "@koed/shared";
import {
  parseWorkItemInput,
  projectWorkItemSections,
  safeWorkItemPrUrl,
  viewerToday,
  workItemDueLabel
} from "./hq-work-item-model.js";

const at = "2026-10-20T10:00:00.000Z";
const base = {
  status: "todo",
  dueOn: null,
  createdAt: at,
  updatedAt: at,
  doneAt: null,
  prState: null
} as WorkItem;
const item = (id: string, changes: Partial<WorkItem> = {}): WorkItem => ({
  ...base,
  id,
  title: id,
  ...changes
});

describe("Project HQ Work Item sections", () => {
  it("parses a due phrase and puts dated to-dos first, then newest undated", () => {
    const now = new Date(at);
    expect(
      parseWorkItemInput("Review slides by Friday", "Europe/Oslo", now)
    ).toEqual({ title: "Review slides", due: "2026-10-23" });
    const sections = projectWorkItemSections(
      [
        item("old", { createdAt: "2026-10-18T10:00:00Z" }),
        item("soon", { dueOn: "2026-10-21" }),
        item("later", { dueOn: "2026-10-23" }),
        item("new", { createdAt: "2026-10-19T10:00:00Z" })
      ],
      "Europe/Oslo",
      now
    );
    expect(sections.todos.map(({ id }) => id)).toEqual(["later", "new", "old"]);
    expect(sections.needs.map(({ id }) => id)).toEqual(["soon"]);
  });

  it("uses viewer-local calendar for due and done today, and never treats a closed PR as done", () => {
    const now = new Date("2026-10-20T23:30:00Z");
    const due = item("due", { dueOn: "2026-10-22" });
    expect(workItemDueLabel(due, "Europe/Oslo", now)).toBe("Due tomorrow");
    expect(workItemDueLabel(due, "America/Los_Angeles", now)).toBe("Due Thu");
    expect(viewerToday("Europe/Oslo", now)).toBe("2026-10-21");
    const sections = projectWorkItemSections(
      [
        item("done", { status: "done", doneAt: "2026-10-20T23:00:00Z" }),
        item("closed", { status: "blocked", prState: "closed" }),
        item("doing", { status: "doing", dueOn: "2026-10-20" })
      ],
      "Europe/Oslo",
      now
    );
    expect(sections.doneToday.map(({ id }) => id)).toEqual(["done"]);
    expect(sections.needs.map(({ id }) => id)).toEqual(["closed"]);
    expect(sections.needs.some(({ id }) => id === "doing")).toBe(false);
    expect(
      safeWorkItemPrUrl(
        item("pr", { prUrl: "https://github.com/koed-labs/koed/pull/1" })
      )
    ).toBe("https://github.com/koed-labs/koed/pull/1");
    expect(
      safeWorkItemPrUrl(item("unsafe", { prUrl: "javascript:alert(1)" }))
    ).toBeNull();
  });
});

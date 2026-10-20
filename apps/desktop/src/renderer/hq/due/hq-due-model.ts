import type { Project } from "@koed/shared/project-contract";
import type { WorkItem } from "@koed/shared/work-item-contract";
import type { WorkspaceProjectWorkItem } from "@koed/shared";
import {
  dueInfo,
  parseCanonicalDueDate,
  resolveDue
} from "@koed/shared/due-date";
import { viewerToday } from "../project/hq-work-item-model.js";

export type HqDueItem = { project: Project; item: WorkItem; daysUntil: number };
export type HqSharedDueItem = {
  project: Project;
  item: WorkspaceProjectWorkItem;
  daysUntil: number;
  authority: "team";
};

export const dueDaysUntil = (
  dueOn: string | null,
  timeZone: string,
  now: Date
): number | null => {
  const due = parseCanonicalDueDate(dueOn);
  if (!due) return null;
  const today = viewerToday(timeZone, now);
  // Both values are civil dates. UTC here is only a stable day-number conversion.
  return Math.round(
    (Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
      86_400_000
  );
};

export const dueChip = (dueOn: string | null, timeZone: string, now: Date) => {
  const due = parseCanonicalDueDate(dueOn);
  return due ? dueInfo(due, { timeZone, now }) : null;
};

export const dueChoiceDate = (
  choice: "today" | "tomorrow" | "friday" | "next week" | "no date",
  timeZone: string,
  now: Date
) => (choice === "no date" ? null : resolveDue(choice, { timeZone, now }));

export const nowDeadlineItems = (
  projects: readonly Project[],
  itemsByProject: ReadonlyMap<string, readonly WorkItem[]>,
  timeZone: string,
  now: Date
) => {
  const soon: HqDueItem[] = [];
  const week: HqDueItem[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    for (const item of itemsByProject.get(project.id) ?? []) {
      if (
        seen.has(item.id) ||
        item.projectId !== project.id ||
        item.status === "done"
      )
        continue;
      seen.add(item.id);
      const daysUntil = dueDaysUntil(item.dueOn, timeZone, now);
      if (daysUntil === null) continue;
      const entry = { project, item, daysUntil };
      if (daysUntil <= 1 && item.status === "todo" && !item.executionId)
        soon.push(entry);
      else if (daysUntil >= 2 && daysUntil <= 7) week.push(entry);
    }
  }
  const order = (a: HqDueItem, b: HqDueItem) =>
    a.daysUntil - b.daysUntil ||
    a.item.updatedAt.localeCompare(b.item.updatedAt) ||
    a.item.id.localeCompare(b.item.id);
  return { soon: soon.sort(order), week: week.sort(order) };
};

export const nowSharedDeadlineItems = (
  projects: readonly Project[],
  itemsByProject: ReadonlyMap<string, readonly WorkspaceProjectWorkItem[]>,
  timeZone: string,
  now: Date
) => {
  const soon: HqSharedDueItem[] = [];
  const week: HqSharedDueItem[] = [];
  for (const project of projects) {
    const seen = new Set<string>();
    for (const item of itemsByProject.get(project.id) ?? []) {
      if (seen.has(item.id) || item.status === "done") continue;
      seen.add(item.id);
      const daysUntil = dueDaysUntil(item.dueOn, timeZone, now);
      if (daysUntil === null) continue;
      const entry: HqSharedDueItem = {
        project,
        item,
        daysUntil,
        authority: "team"
      };
      if (daysUntil <= 1 && item.status === "todo" && !item.dispatchKey)
        soon.push(entry);
      else if (daysUntil >= 2 && daysUntil <= 7) week.push(entry);
    }
  }
  const order = (a: HqSharedDueItem, b: HqSharedDueItem) =>
    a.daysUntil - b.daysUntil ||
    a.item.updatedAt.localeCompare(b.item.updatedAt) ||
    a.item.id.localeCompare(b.item.id);
  return { soon: soon.sort(order), week: week.sort(order) };
};

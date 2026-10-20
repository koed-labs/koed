import type { WorkItem } from "@koed/shared/work-item-contract";
import {
  dueInfo,
  dueSoon,
  parseCanonicalDueDate,
  parseDue
} from "@koed/shared/due-date";

export const viewerTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const viewerToday = (timeZone: string, now: Date): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
};

export const parseWorkItemInput = (text: string, timeZone: string, now: Date) =>
  parseDue(text, { timeZone, now });

export const workItemDueLabel = (
  item: WorkItem,
  timeZone: string,
  now: Date
): string | null => {
  const due = parseCanonicalDueDate(item.dueOn);
  return due ? dueInfo(due, { timeZone, now })[1] : null;
};

export const projectWorkItemSections = (
  items: readonly WorkItem[],
  timeZone: string,
  now: Date
) => {
  const todos = items
    .filter((item) => item.status === "todo")
    .sort((a, b) => {
      if (a.dueOn && b.dueOn)
        return (
          a.dueOn.localeCompare(b.dueOn) ||
          b.createdAt.localeCompare(a.createdAt)
        );
      if (a.dueOn) return -1;
      if (b.dueOn) return 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  const doing = items
    .filter((item) => item.status === "doing")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const doneToday = items
    .filter(
      (item) =>
        item.status === "done" &&
        item.doneAt &&
        viewerToday(timeZone, new Date(item.doneAt)) ===
          viewerToday(timeZone, now)
    )
    .sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  const needs = items
    .filter(
      (item) =>
        item.status === "blocked" ||
        (item.status === "todo" &&
          !item.executionId &&
          dueSoon(parseCanonicalDueDate(item.dueOn), { timeZone, now })) ||
        (item.status === "review" &&
          (item.prState === "ready_to_merge" ||
            item.prState === "waiting_review"))
    )
    .sort(
      (a, b) =>
        (a.dueOn ?? "9999-12-31").localeCompare(b.dueOn ?? "9999-12-31") ||
        b.updatedAt.localeCompare(a.updatedAt)
    );
  const needIds = new Set(needs.map((item) => item.id));
  const review = items
    .filter(
      (item) =>
        item.status === "review" &&
        (item.prUrl || item.prNumber) &&
        !needIds.has(item.id)
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const remainingTodos = todos.filter((item) => !needIds.has(item.id));
  return { todos: remainingTodos, doing, review, doneToday, needs };
};

export const safeWorkItemPrUrl = (item: WorkItem): string | null => {
  if (!item.prUrl) return null;
  try {
    const url = new URL(item.prUrl);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
};

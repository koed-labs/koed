import type {
  projectActivityPageSchema,
  projectSeenSchema
} from "@koed/shared/project-activity-contract";
import type { z } from "zod";

type Page = z.infer<typeof projectActivityPageSchema>;
type Seen = z.infer<typeof projectSeenSchema>;
export type ProjectActivity = Page["items"][number];

export type ProjectActivityReader = {
  activitySeen(projectId: string): Promise<Seen>;
  activityPage(projectId: string, after?: string): Promise<Page>;
};

/** The HQ rows already expose Work Items, their state, Sources, and PRs. */
export const residualProjectActivity = (
  items: readonly ProjectActivity[]
): ProjectActivity[] =>
  items.filter(
    (item) =>
      ((item.kind === "source_ready" || item.kind === "source_failed") &&
        item.sourceOutcome?.status ===
          (item.kind === "source_ready" ? "ready" : "failed")) ||
      item.kind === "assertion_created"
  );

/** Capture the unseen high-water mark without advancing project_seen. */
export const loadUnseenProjectActivity = async (
  reader: ProjectActivityReader,
  projectId: string,
  current: () => boolean
): Promise<{
  seen: Seen;
  highWater: string | null;
  items: ProjectActivity[];
}> => {
  const seen = await reader.activitySeen(projectId);
  if (!current()) throw new Error("Project identity changed during catch-up.");
  let after = seen.cursor;
  const items: ProjectActivity[] = [];
  const visited = new Set<string>([after]);
  for (let pageCount = 0; pageCount < 100; pageCount++) {
    const page = await reader.activityPage(projectId, after);
    if (!current())
      throw new Error("Project identity changed during catch-up.");
    items.push(...page.items);
    if (!page.hasMore)
      return {
        seen,
        highWater: page.items.at(-1)?.cursor ?? items.at(-1)?.cursor ?? null,
        items: residualProjectActivity(items)
      };
    if (!page.nextCursor || visited.has(page.nextCursor))
      throw new Error("Project activity pagination did not advance.");
    after = page.nextCursor;
    visited.add(after);
  }
  throw new Error("Project activity exceeds the bounded catch-up window.");
};

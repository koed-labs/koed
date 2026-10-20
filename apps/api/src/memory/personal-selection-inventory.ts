import type { MemorySourceRepository, ActorContext } from "@koed/db";
import type { PersonalSelectionSnapshot } from "@koed/shared";

/** Current Desktop inventories use the same bounded source enumeration as
 * future consumers. Header reads retain the target and enumerated IDs. */
export const listSelectedPersonalThreads = async (
  repo: Pick<
    MemorySourceRepository,
    | "listLcmGraphThreads"
    | "startPersonalSelectionEnumeration"
    | "continuePersonalSelectionEnumeration"
    | "reconcilePersonalSelectionChanges"
  >,
  actor: ActorContext,
  personalSelection: PersonalSelectionSnapshot,
  label: string
) => {
  if (
    personalSelection.version !== 1 ||
    personalSelection.target.kind === "global"
  )
    throw Object.assign(
      new Error(
        "This inventory requires an explicit current Personal selection."
      ),
      { statusCode: 400 }
    );
  let page = await repo.startPersonalSelectionEnumeration(actor, {
    target: personalSelection.target
  });
  const threads = new Map<
    string,
    Awaited<
      ReturnType<MemorySourceRepository["listLcmGraphThreads"]>
    >[number]["threads"][number]
  >();
  const seen = new Set<string>();
  for (;;) {
    const sessionIds = [
      ...new Set(page.entries.map((entry) => entry.source.localSessionId))
    ].filter((id) => !seen.has(id));
    for (const id of sessionIds) seen.add(id);
    if (seen.size > 5000)
      throw Object.assign(
        new Error(
          `This ${label} has too many Conversations to open in this view.`
        ),
        { statusCode: 413 }
      );
    if (sessionIds.length) {
      const groups = await repo.listLcmGraphThreads(actor, {
        personalSelection,
        sessionIds,
        limit: sessionIds.length,
        offset: 0,
        groupBySession: true
      });
      for (const thread of groups.flatMap((group) => group.threads))
        if (thread.sessionId && seen.has(thread.sessionId))
          threads.set(thread.sessionId, thread);
    }
    if (!page.nextCursor) break;
    page = await repo.continuePersonalSelectionEnumeration(actor, {
      cursor: page.nextCursor
    });
  }
  const changed = await repo.reconcilePersonalSelectionChanges(actor, {
    cursor: page.changeCursor!
  });
  if (changed.reconciliationRequired)
    throw Object.assign(
      new Error(
        "Selection changed while its inventory was loading. Reload the current selection."
      ),
      { statusCode: 409, code: "selection_enumeration_stale" }
    );
  return [...threads.values()].sort(
    (left, right) =>
      new Date(right.latestAt).getTime() - new Date(left.latestAt).getTime() ||
      right.id.localeCompare(left.id)
  );
};

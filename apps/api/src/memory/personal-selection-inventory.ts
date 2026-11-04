import type { MemorySourceRepository, ActorContext } from "@koed/db";
import type { PersonalSelectionSnapshot } from "@koed/shared";

type InventoryRepository = Pick<
  MemorySourceRepository,
  | "listLcmGraphThreads"
  | "personalInventorySelections"
  | "startPersonalSelectionEnumeration"
  | "continuePersonalSelectionEnumeration"
  | "reconcilePersonalSelectionChanges"
>;

/** Header reads retain the exact target and enumerated IDs. A membership
 * change discards the whole attempt; new content alone does not invalidate it. */
export const listSelectedPersonalThreads = async (
  repo: InventoryRepository,
  actor: ActorContext,
  personalSelection: PersonalSelectionSnapshot,
  label: string
) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readSelectedPersonalThreads(
        repo,
        actor,
        personalSelection,
        label
      );
    } catch (cause) {
      if (
        attempt >= 2 ||
        !(cause instanceof Error) ||
        !("code" in cause) ||
        cause.code !== "selection_enumeration_stale"
      )
        throw cause;
    }
  }
};

const readSelectedPersonalThreads = async (
  repo: InventoryRepository,
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
  // Older adapters retain the stricter generic fence. Production uses the
  // inspection-only adapter; sharing and recall consumers remain unchanged.
  const selections = repo.personalInventorySelections ?? repo;
  let page = await selections.startPersonalSelectionEnumeration(actor, {
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
    page = await selections.continuePersonalSelectionEnumeration(actor, {
      cursor: page.nextCursor
    });
  }
  const changed = await selections.reconcilePersonalSelectionChanges(actor, {
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

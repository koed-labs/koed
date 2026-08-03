import type {
  CollaborationSelection,
  SharedMemorySourcePage
} from "@koed/shared/collaboration";

type SharedSessionSelection = Extract<
  CollaborationSelection,
  { kind: "shared_session" }
>;

type SharedSourceBackfillState = {
  selection: SharedSessionSelection;
  source: SharedMemorySourcePage;
  maximumItems: number;
  pageLimit: number;
};

type SharedSourceBackfillHooks = {
  current: () => SharedSourceBackfillState | null;
  loadOlder: (input: {
    selection: SharedSessionSelection;
    cursor: string;
    limit: number;
  }) => Promise<SharedMemorySourcePage>;
  apply: (page: SharedMemorySourcePage) => Promise<void>;
};

const selectionKey = (selection: SharedSessionSelection): string =>
  [selection.teamId, selection.workspaceId, selection.sharedSessionId].join(
    ":"
  );

const sameSelection = (
  left: SharedSessionSelection,
  right: SharedSessionSelection
): boolean => selectionKey(left) === selectionKey(right);

export class SharedSourceBackfillCoordinator {
  readonly #runs = new Map<string, Promise<void>>();

  start(
    selection: SharedSessionSelection,
    snapshotRevision: string,
    hooks: SharedSourceBackfillHooks
  ): void {
    const key = `${selectionKey(selection)}:${snapshotRevision}`;
    if (this.#runs.has(key)) return;
    const run = this.#backfill(selection, hooks)
      .catch(() => undefined)
      .finally(() => {
        if (this.#runs.get(key) === run) this.#runs.delete(key);
      });
    this.#runs.set(key, run);
  }

  async #backfill(
    selection: SharedSessionSelection,
    hooks: SharedSourceBackfillHooks
  ): Promise<void> {
    while (true) {
      const state = hooks.current();
      if (
        !state ||
        !sameSelection(state.selection, selection) ||
        !state.source.hasOlder ||
        !state.source.olderCursor ||
        state.source.items.length >= state.maximumItems
      ) {
        return;
      }
      const cursor = state.source.olderCursor;
      const page = await hooks.loadOlder({
        selection,
        cursor,
        limit: Math.min(
          state.pageLimit,
          state.maximumItems - state.source.items.length
        )
      });
      const latest = hooks.current();
      if (!latest || !sameSelection(latest.selection, selection)) return;
      await hooks.apply(page);
      if (page.olderCursor === cursor) return;
    }
  }
}

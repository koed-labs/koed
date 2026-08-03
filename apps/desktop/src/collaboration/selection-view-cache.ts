import type {
  CollaborationSelection,
  CollaborationSnapshot
} from "@koed/shared/collaboration";

type CacheEntry = {
  selection: CollaborationSelection;
  view: CollaborationSnapshot["view"];
  lastAccessedAt: number;
  loadedAt: number;
};

export class CollaborationSelectionViewCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<CollaborationSnapshot | null>>();

  constructor(
    private readonly identity: (selection: CollaborationSelection) => string,
    private readonly teamId: (
      selection: CollaborationSelection
    ) => string | null,
    private readonly limit: number,
    private readonly retentionMs: number,
    private readonly now: () => number = Date.now
  ) {}

  remember(snapshot: CollaborationSnapshot): void {
    if (snapshot.view.kind === "empty") return;
    const now = this.now();
    this.#entries.set(this.identity(snapshot.selection), {
      selection: snapshot.selection,
      view: snapshot.view,
      lastAccessedAt: now,
      loadedAt: now
    });
    this.#prune(now);
  }

  get(selection: CollaborationSelection): CollaborationSnapshot["view"] | null {
    const key = this.identity(selection);
    const entry = this.#entries.get(key);
    const now = this.now();
    if (!entry || now - entry.loadedAt > this.retentionMs) {
      this.#entries.delete(key);
      return null;
    }
    entry.lastAccessedAt = now;
    return entry.view;
  }

  clearTeam(teamId?: string): void {
    for (const [key, entry] of this.#entries) {
      const entryTeamId = this.teamId(entry.selection);
      if (
        entryTeamId !== null &&
        (teamId === undefined || entryTeamId === teamId)
      ) {
        this.#entries.delete(key);
      }
    }
  }

  clearThread(threadId: string): void {
    for (const [key, entry] of this.#entries) {
      if (
        (entry.view.kind === "thread" && entry.view.thread.id === threadId) ||
        (entry.view.kind === "shared_session" &&
          entry.view.companion.thread.id === threadId)
      ) {
        this.#entries.delete(key);
      }
    }
  }

  clearSharedSession(sharedSessionId: string): void {
    for (const [key, entry] of this.#entries) {
      if (
        entry.selection.kind === "shared_session" &&
        entry.selection.sharedSessionId === sharedSessionId
      ) {
        this.#entries.delete(key);
      }
    }
  }

  inFlight(
    selection: CollaborationSelection
  ): Promise<CollaborationSnapshot | null> | undefined {
    return this.#inFlight.get(this.identity(selection));
  }

  coordinate(
    selection: CollaborationSelection,
    load: () => Promise<CollaborationSnapshot | null>
  ): Promise<CollaborationSnapshot | null> {
    const key = this.identity(selection);
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    const pending = load().finally(() => {
      if (this.#inFlight.get(key) === pending) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, pending);
    return pending;
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (now - entry.lastAccessedAt > this.retentionMs) {
        this.#entries.delete(key);
      }
    }
    if (this.#entries.size <= this.limit) return;
    const oldest = [...this.#entries.entries()].sort(
      ([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt
    );
    for (const [key] of oldest) {
      if (this.#entries.size <= this.limit) break;
      this.#entries.delete(key);
    }
  }
}

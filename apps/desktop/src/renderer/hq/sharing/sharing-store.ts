import type { CollaborationRendererEvent, SharingOverview } from "@koed/shared";
import type { SharingDesktopApi } from "../../../ipc/sharing-protocol.js";

export type SharingSnapshot = Readonly<{
  ownerId: string | null;
  profileKey: string | null;
  overview: SharingOverview | null;
  loading: boolean;
  error: string | null;
}>;

/** A single owner-scoped read model for future Sharing views. Call invalidate after Team events. */
export class SharingStore {
  readonly #listeners = new Set<() => void>();
  #snapshot: SharingSnapshot = {
    ownerId: null,
    profileKey: null,
    overview: null,
    loading: false,
    error: null
  };
  #generation = 0;
  #pending: Promise<void> | null = null;
  #dirty = false;
  #active = false;
  #unsubscribeEvents: (() => void) | null = null;
  #refreshOnFocus = () => {
    this.invalidate();
  };
  constructor(
    readonly api: SharingDesktopApi,
    readonly events: {
      subscribe(
        listener: (event: CollaborationRendererEvent) => void
      ): () => void;
    } | null = null
  ) {}
  current = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #set(snapshot: SharingSnapshot) {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
  setOwner(ownerId: string | null, profileKey: string | null) {
    if (
      this.#snapshot.ownerId === ownerId &&
      this.#snapshot.profileKey === profileKey
    )
      return;
    this.#generation++;
    this.#pending = null;
    this.#dirty = false;
    this.#set({
      ownerId,
      profileKey,
      overview: null,
      loading: false,
      error: null
    });
    if (this.#active && ownerId) void this.refresh();
  }
  start() {
    if (this.#active) return;
    this.#active = true;
    const events =
      this.events ??
      (typeof window !== "undefined"
        ? window.koedDesktop?.collaboration
        : null);
    this.#unsubscribeEvents =
      events?.subscribe(() => this.invalidate()) ?? null;
    if (typeof window !== "undefined")
      window.addEventListener("focus", this.#refreshOnFocus);
    if (this.#snapshot.ownerId) void this.refresh();
  }
  stop() {
    if (!this.#active) return;
    this.#active = false;
    this.#generation++;
    this.#pending = null;
    this.#dirty = false;
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = null;
    if (typeof window !== "undefined")
      window.removeEventListener("focus", this.#refreshOnFocus);
    this.#set({
      ...this.#snapshot,
      overview: null,
      loading: false,
      error: null
    });
  }
  invalidate = () => {
    if (!this.#active || !this.#snapshot.ownerId) return;
    if (this.#pending) {
      this.#dirty = true;
      return;
    }
    void this.refresh();
  };
  refresh = (): Promise<void> => {
    if (!this.#active || !this.#snapshot.ownerId) return Promise.resolve();
    if (this.#pending) return this.#pending;
    const generation = this.#generation;
    this.#set({ ...this.#snapshot, loading: true, error: null });
    const task = (async () => {
      try {
        const overview = await this.api.read();
        if (generation === this.#generation && this.#active)
          this.#set({
            ...this.#snapshot,
            overview,
            loading: false,
            error: null
          });
      } catch (error) {
        if (generation === this.#generation && this.#active)
          this.#set({
            ...this.#snapshot,
            loading: false,
            error:
              error instanceof Error ? error.message : "Sharing is unavailable."
          });
      }
    })();
    this.#pending = task;
    void task.finally(() => {
      if (this.#pending === task) {
        this.#pending = null;
        if (this.#dirty) {
          this.#dirty = false;
          void this.refresh();
        }
      }
    });
    return task;
  };
}

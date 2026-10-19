import {
  defaultHqLayoutPreferences,
  hqLayoutPreferencesSchema,
  type HqLayoutPreferences,
  type HqLayoutPreferencesApi
} from "../../ipc/hq-layout-preferences-protocol.js";

export type HqLayoutPreferencesSnapshot = {
  error: string | null;
  loading: boolean;
  preferences: HqLayoutPreferences;
};

type PreferenceKey = keyof HqLayoutPreferences;
type PreferenceRevisions = Record<PreferenceKey, number>;
type PendingWrite = {
  preferences: HqLayoutPreferences;
  revision: number;
};

const preferenceKeys: PreferenceKey[] = [
  "sidebarWidth",
  "rightColumnWidth",
  "rightColumnHidden"
];

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class HqLayoutPreferencesStore {
  readonly #api: HqLayoutPreferencesApi | undefined;
  readonly #debounceMs: number;
  readonly #listeners = new Set<() => void>();
  #loaded = false;
  #loadPromise: Promise<HqLayoutPreferencesSnapshot> | null = null;
  #pendingWrite: PendingWrite | null = null;
  #revisions: PreferenceRevisions = {
    sidebarWidth: 0,
    rightColumnWidth: 0,
    rightColumnHidden: 0
  };
  #snapshot: HqLayoutPreferencesSnapshot = {
    error: null,
    loading: true,
    preferences: { ...defaultHqLayoutPreferences }
  };
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writePromise: Promise<void> | null = null;
  #writeRevision = 0;

  constructor(
    api: HqLayoutPreferencesApi | undefined = window.koedDesktop?.hqLayout,
    debounceMs = 120
  ) {
    this.#api = api;
    this.#debounceMs = debounceMs;
  }

  current = (): HqLayoutPreferencesSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  load = (): Promise<HqLayoutPreferencesSnapshot> => {
    if (this.#loadPromise) return this.#loadPromise;
    this.#loadPromise = this.#load();
    return this.#loadPromise;
  };

  setSidebarWidth = (sidebarWidth: number): void => {
    this.#update({ sidebarWidth });
  };

  setRightColumnWidth = (rightColumnWidth: number | null): void => {
    this.#update({ rightColumnWidth });
  };

  setRightColumnHidden = (rightColumnHidden: boolean): void => {
    this.#update({ rightColumnHidden });
  };

  dispose = (): void => {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#pendingWrite) void this.flush();
    this.#listeners.clear();
  };

  flush = async (): Promise<void> => {
    if (!this.#api) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#loaded) await this.load();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#flushWrite();
  };

  async #load() {
    try {
      const loaded = this.#api
        ? hqLayoutPreferencesSchema.parse(await this.#api.get())
        : { ...defaultHqLayoutPreferences };
      const hasUserChanges = Object.values(this.#revisions).some(Boolean);
      const preferences: HqLayoutPreferences = {
        sidebarWidth:
          this.#revisions.sidebarWidth > 0
            ? this.#snapshot.preferences.sidebarWidth
            : loaded.sidebarWidth,
        rightColumnWidth:
          this.#revisions.rightColumnWidth > 0
            ? this.#snapshot.preferences.rightColumnWidth
            : loaded.rightColumnWidth,
        rightColumnHidden:
          this.#revisions.rightColumnHidden > 0
            ? this.#snapshot.preferences.rightColumnHidden
            : loaded.rightColumnHidden
      };
      this.#loaded = true;
      this.#replace({ error: null, loading: false, preferences });
      if (hasUserChanges) this.#scheduleWrite();
    } catch (cause) {
      this.#loaded = true;
      this.#replace({
        ...this.#snapshot,
        error: errorMessage(cause),
        loading: false
      });
      if (this.#api && Object.values(this.#revisions).some(Boolean)) {
        this.#scheduleWrite();
      }
    }
    return this.#snapshot;
  }

  #update(patch: Partial<HqLayoutPreferences>): void {
    const preferences = hqLayoutPreferencesSchema.parse({
      ...this.#snapshot.preferences,
      ...patch
    });
    const changedKeys = preferenceKeys.filter(
      (key) => preferences[key] !== this.#snapshot.preferences[key]
    );
    const explicitPreloadIntents = this.#loaded
      ? []
      : preferenceKeys.filter(
          (key) =>
            key in patch && preferences[key] === this.#snapshot.preferences[key]
        );
    const revisedKeys = new Set([...changedKeys, ...explicitPreloadIntents]);
    if (revisedKeys.size === 0) return;
    for (const key of revisedKeys) this.#revisions[key] += 1;
    if (changedKeys.length === 0) return;
    this.#replace({ error: null, loading: false, preferences });
    this.#scheduleWrite();
  }

  #scheduleWrite(): void {
    if (!this.#api || !this.#loaded) return;
    this.#pendingWrite = {
      preferences: { ...this.#snapshot.preferences },
      revision: ++this.#writeRevision
    };
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#flushWrite();
    }, this.#debounceMs);
  }

  async #flushWrite(): Promise<void> {
    if (!this.#api) return;
    while (this.#writePromise || this.#pendingWrite) {
      if (this.#writePromise) {
        await this.#writePromise;
        continue;
      }
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      const write = this.#pendingWrite;
      if (!write) continue;
      this.#pendingWrite = null;
      const writePromise = (async () => {
        try {
          await this.#api!.set(write.preferences);
          if (write.revision === this.#writeRevision) {
            this.#replace({ ...this.#snapshot, error: null });
          }
        } catch (cause) {
          if (write.revision === this.#writeRevision) {
            this.#replace({ ...this.#snapshot, error: errorMessage(cause) });
          }
        }
      })();
      this.#writePromise = writePromise;
      try {
        await writePromise;
      } finally {
        if (this.#writePromise === writePromise) this.#writePromise = null;
      }
    }
  }

  #replace(snapshot: HqLayoutPreferencesSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

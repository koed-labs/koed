import {
  defaultHqSidebarPreferences,
  hqSidebarFoldedGroupLimit,
  hqSidebarPreferencesSchema,
  type HqSidebarPreferences,
  type HqSidebarPreferencesApi
} from "../../ipc/hq-sidebar-preferences-protocol.js";

export type HqSidebarPreferencesSnapshot = {
  error: string | null;
  loading: boolean;
  foldedGroups: Readonly<Record<string, boolean>>;
};

type PendingWrite = {
  preferences: HqSidebarPreferences;
  revision: number;
};

const JUST_ME_GROUP_ID = "just-me";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const copyPreferences = (
  preferences: HqSidebarPreferences
): HqSidebarPreferences => ({
  foldedGroups: { ...preferences.foldedGroups }
});

export class HqSidebarPreferencesStore {
  readonly #api: HqSidebarPreferencesApi | undefined;
  readonly #debounceMs: number;
  readonly #listeners = new Set<() => void>();
  readonly #pendingGroupIntents = new Map<string, boolean>();
  #groupsAuthoritative = false;
  #currentGroupIds: Set<string> | null = null;
  #groupOrder: string[] = [JUST_ME_GROUP_ID];
  #loaded = false;
  #loadPromise: Promise<HqSidebarPreferencesSnapshot> | null = null;
  #pendingWrite: PendingWrite | null = null;
  #snapshot: HqSidebarPreferencesSnapshot = {
    error: null,
    loading: true,
    foldedGroups: { ...defaultHqSidebarPreferences.foldedGroups }
  };
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writePromise: Promise<void> | null = null;
  #writeRevision = 0;

  constructor(
    api: HqSidebarPreferencesApi | undefined = window.koedDesktop?.hqSidebar,
    debounceMs = 120
  ) {
    this.#api = api;
    this.#debounceMs = debounceMs;
  }

  current = (): HqSidebarPreferencesSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  load = (): Promise<HqSidebarPreferencesSnapshot> => {
    if (this.#loadPromise) return this.#loadPromise;
    this.#loadPromise = this.#load();
    return this.#loadPromise;
  };

  isGroupFolded = (groupId: string): boolean =>
    this.#snapshot.foldedGroups[groupId] === true;

  reconcileGroups = (groupIds: readonly string[]): void => {
    const nextOrder = [
      JUST_ME_GROUP_ID,
      ...new Set(groupIds.filter((groupId) => groupId !== JUST_ME_GROUP_ID))
    ];
    if (
      this.#currentGroupIds &&
      this.#pendingGroupIntents.size === 0 &&
      nextOrder.length === this.#groupOrder.length &&
      nextOrder.every((groupId, index) => groupId === this.#groupOrder[index])
    ) {
      return;
    }

    this.#groupOrder = nextOrder;
    this.#currentGroupIds = new Set(nextOrder);
    this.#groupsAuthoritative = true;
    const intents = [...this.#pendingGroupIntents.entries()];
    const foldedGroups = { ...this.#snapshot.foldedGroups };
    for (const [groupId, folded] of intents) {
      if (!this.#currentGroupIds.has(groupId)) {
        this.#pendingGroupIntents.delete(groupId);
      } else if (this.#loaded) {
        if (folded) foldedGroups[groupId] = true;
        else delete foldedGroups[groupId];
        this.#pendingGroupIntents.delete(groupId);
      }
    }
    const compactedGroups = this.#compactGroups(foldedGroups);
    const changed =
      JSON.stringify(compactedGroups) !==
      JSON.stringify(this.#snapshot.foldedGroups);
    if (!changed) {
      if (this.#loaded && intents.length > 0) this.#scheduleWrite();
      return;
    }

    this.#replace({ ...this.#snapshot, foldedGroups: compactedGroups });
    if (this.#loaded) this.#scheduleWrite();
  };

  setGroupFolded = (groupId: string, folded: boolean): void => {
    const nextGroups = { ...this.#snapshot.foldedGroups };
    if (folded) nextGroups[groupId] = true;
    else delete nextGroups[groupId];

    const canPersistGroup =
      this.#groupsAuthoritative && this.#currentGroupIds?.has(groupId);
    if (!this.#loaded || !canPersistGroup) {
      this.#pendingGroupIntents.set(groupId, folded);
    } else {
      this.#pendingGroupIntents.delete(groupId);
    }
    const preferences = canPersistGroup
      ? {
          foldedGroups: hqSidebarPreferencesSchema.parse({
            foldedGroups: this.#compactGroups(
              nextGroups,
              folded ? groupId : undefined
            )
          }).foldedGroups
        }
      : { foldedGroups: nextGroups };
    const changed =
      JSON.stringify(preferences.foldedGroups) !==
      JSON.stringify(this.#snapshot.foldedGroups);

    if (!changed) return;
    this.#replace({
      ...this.#snapshot,
      foldedGroups: preferences.foldedGroups
    });
    if (canPersistGroup) this.#scheduleWrite();
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

  async #load(): Promise<HqSidebarPreferencesSnapshot> {
    try {
      const loaded = this.#api
        ? hqSidebarPreferencesSchema.parse(await this.#api.get())
        : copyPreferences(defaultHqSidebarPreferences);
      const foldedGroups = this.#groupsAuthoritative
        ? this.#compactGroups(loaded.foldedGroups)
        : { ...loaded.foldedGroups };
      const intents = [...this.#pendingGroupIntents.entries()];
      const applicableIntents = intents.filter(
        ([groupId]) =>
          !this.#groupsAuthoritative || this.#currentGroupIds?.has(groupId)
      );
      for (const [groupId, folded] of applicableIntents) {
        if (folded) foldedGroups[groupId] = true;
        else delete foldedGroups[groupId];
      }
      const compactedGroups = this.#groupsAuthoritative
        ? this.#compactGroups(
            foldedGroups,
            applicableIntents.reverse().find(([, folded]) => folded)?.[0]
          )
        : foldedGroups;
      if (this.#groupsAuthoritative) {
        for (const [groupId] of intents) {
          this.#pendingGroupIntents.delete(groupId);
        }
      }
      this.#loaded = true;
      this.#replace({
        error: null,
        loading: false,
        foldedGroups: compactedGroups
      });
      if (
        applicableIntents.length > 0 ||
        JSON.stringify(compactedGroups) !== JSON.stringify(loaded.foldedGroups)
      ) {
        this.#scheduleWrite();
      }
    } catch (cause) {
      this.#loaded = true;
      this.#replace({
        ...this.#snapshot,
        error: errorMessage(cause),
        loading: false
      });
      if (this.#api && this.#pendingGroupIntents.size > 0) {
        this.#scheduleWrite();
      }
    }
    return this.#snapshot;
  }

  #scheduleWrite(): void {
    if (!this.#api || !this.#loaded || !this.#groupsAuthoritative) return;
    this.#pendingWrite = {
      preferences: {
        foldedGroups: this.#compactGroups(this.#snapshot.foldedGroups)
      },
      revision: ++this.#writeRevision
    };
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#flushWrite();
    }, this.#debounceMs);
  }

  #compactGroups(
    groups: Readonly<Record<string, boolean>>,
    preferredGroupId?: string
  ): Record<string, boolean> {
    const candidates = this.#currentGroupIds
      ? this.#groupOrder
      : [...Object.keys(groups)];
    const orderedCandidates = preferredGroupId
      ? [
          JUST_ME_GROUP_ID,
          preferredGroupId,
          ...candidates.filter(
            (groupId) =>
              groupId !== JUST_ME_GROUP_ID && groupId !== preferredGroupId
          )
        ]
      : candidates;
    const foldedGroups: Record<string, boolean> = {};
    for (const groupId of orderedCandidates) {
      if (!Object.hasOwn(groups, groupId)) continue;
      if (Object.keys(foldedGroups).length >= hqSidebarFoldedGroupLimit) break;
      foldedGroups[groupId] = groups[groupId]!;
    }
    return hqSidebarPreferencesSchema.parse({ foldedGroups }).foldedGroups;
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

  #replace(snapshot: HqSidebarPreferencesSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

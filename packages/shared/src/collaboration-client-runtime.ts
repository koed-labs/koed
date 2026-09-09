import type {
  CollaborationSelection,
  CollaborationSnapshot,
  CollaborationSubscription
} from "./collaboration-contract.js";
import { negotiateDurableRealtimeTransport } from "./durable-realtime.js";

export { negotiateDurableRealtimeTransport };

export interface CollaborationClientBinding {
  backendId: string | null;
  principalId: string | null;
  remoteUrl: string | null;
  transportId: string;
}

export interface CollaborationSubscriptionRecord {
  subscription: CollaborationSubscription;
  preferredSelection: CollaborationSelection | null;
  selectionIntentGeneration: number;
}

interface SelectionCacheEntry {
  authorityGeneration: number;
  lastAccessedAt: number;
  loadedAt: number;
  selection: CollaborationSelection;
  view: CollaborationSnapshot["view"];
}

interface CoordinatedSelectionLoad {
  authorityGeneration: number;
  promise: Promise<CollaborationSnapshot | null>;
}

type SubscriptionScope = CollaborationSubscription["scope"];

const subscriptionScopeKey = (scope: SubscriptionScope): string =>
  scope.scope === "personal" ? "personal" : `team:${scope.teamId}`;

const bindingEquals = (
  left: CollaborationClientBinding | null,
  right: CollaborationClientBinding
): boolean =>
  left !== null &&
  left.backendId === right.backendId &&
  left.principalId === right.principalId &&
  left.remoteUrl === right.remoteUrl &&
  left.transportId === right.transportId;

export class CollaborationClientRuntime {
  readonly #subscriptionsById = new Map<
    string,
    CollaborationSubscriptionRecord
  >();
  readonly #subscriptionIdByScope = new Map<string, string>();
  readonly #subscriptionAttempts = new Map<string, Promise<void>>();
  readonly #selectionViews = new Map<string, SelectionCacheEntry>();
  readonly #selectionLoads = new Map<string, CoordinatedSelectionLoad>();
  #authorityGeneration = 0;
  #lastRevocationGeneration = -1;
  #binding: CollaborationClientBinding | null = null;
  #disposed = false;

  constructor(
    private readonly options: {
      createSubscription: (
        scope: SubscriptionScope
      ) => Promise<CollaborationSubscription | null>;
      releaseSubscription: (subscriptionId: string) => Promise<void>;
      preferredSelection: (scope: SubscriptionScope) => {
        selection: CollaborationSelection | null;
        intentGeneration: number;
      };
      selectionIdentity: (selection: CollaborationSelection) => string;
      teamIdForSelection: (selection: CollaborationSelection) => string | null;
      selectionCacheLimit: number;
      selectionCacheRetentionMs: number;
      now?: () => number;
    }
  ) {
    if (
      !Number.isSafeInteger(options.selectionCacheLimit) ||
      options.selectionCacheLimit < 1 ||
      !Number.isSafeInteger(options.selectionCacheRetentionMs) ||
      options.selectionCacheRetentionMs < 1
    ) {
      throw new TypeError("Collaboration client cache policy is invalid");
    }
  }

  binding(): CollaborationClientBinding | null {
    return this.#binding;
  }

  bind(next: CollaborationClientBinding): boolean {
    if (this.#disposed) return false;
    if (!next.transportId.trim()) {
      throw new TypeError("Collaboration client transport is required");
    }
    if (bindingEquals(this.#binding, next)) return false;
    const hadBinding = this.#binding !== null;
    this.#binding = { ...next };
    if (hadBinding) this.invalidateAuthority();
    return true;
  }

  authorityGeneration(): number {
    return this.#authorityGeneration;
  }

  authorityIsCurrent(generation: number): boolean {
    return !this.#disposed && generation === this.#authorityGeneration;
  }

  authorityWasRevokedSince(generation: number): boolean {
    return this.#lastRevocationGeneration > generation;
  }

  invalidateAuthority(input: { revoked?: boolean } = {}): number {
    this.#authorityGeneration += 1;
    if (input.revoked) {
      this.#lastRevocationGeneration = this.#authorityGeneration;
    }
    this.#selectionLoads.clear();
    return this.#authorityGeneration;
  }

  hasSubscription(subscriptionId: string): boolean {
    return this.#subscriptionsById.has(subscriptionId);
  }

  subscription(
    subscriptionId: string
  ): CollaborationSubscriptionRecord | undefined {
    return this.#subscriptionsById.get(subscriptionId);
  }

  recordSubscription(
    subscription: CollaborationSubscription,
    preferredSelection?: CollaborationSelection | null,
    preferredSelectionIntentGeneration?: number
  ): void {
    const key = subscriptionScopeKey(subscription.scope);
    const previousId = this.#subscriptionIdByScope.get(key);
    const previous = previousId
      ? this.#subscriptionsById.get(previousId)
      : undefined;
    if (previousId && previousId !== subscription.id) {
      this.#subscriptionsById.delete(previousId);
    }
    const preferred = this.options.preferredSelection(subscription.scope);
    this.#subscriptionsById.set(subscription.id, {
      subscription,
      preferredSelection:
        preferredSelection === undefined
          ? (previous?.preferredSelection ?? null)
          : preferredSelection,
      selectionIntentGeneration:
        preferredSelectionIntentGeneration ??
        previous?.selectionIntentGeneration ??
        preferred.intentGeneration
    });
    this.#subscriptionIdByScope.set(key, subscription.id);
  }

  dropSubscription(
    subscriptionId: string
  ): CollaborationSubscriptionRecord | undefined {
    const record = this.#subscriptionsById.get(subscriptionId);
    this.#subscriptionsById.delete(subscriptionId);
    if (
      record &&
      this.#subscriptionIdByScope.get(
        subscriptionScopeKey(record.subscription.scope)
      ) === subscriptionId
    ) {
      this.#subscriptionIdByScope.delete(
        subscriptionScopeKey(record.subscription.scope)
      );
    }
    return record;
  }

  updateSubscriptionVersion(subscriptionId: string, version: number): void {
    const record = this.#subscriptionsById.get(subscriptionId);
    if (!record) return;
    record.subscription = {
      ...record.subscription,
      state: "active",
      version
    };
  }

  async subscribe(scope: SubscriptionScope): Promise<void> {
    const key = subscriptionScopeKey(scope);
    if (this.#subscriptionIdByScope.has(key) || this.#disposed) return;
    const activeAttempt = this.#subscriptionAttempts.get(key);
    if (activeAttempt) return activeAttempt;
    const authorityGeneration = this.#authorityGeneration;
    const preferred = this.options.preferredSelection(scope);
    const attempt = (async () => {
      const subscription = await this.options.createSubscription(scope);
      if (!subscription) return;
      if (
        !this.authorityIsCurrent(authorityGeneration) ||
        this.#subscriptionIdByScope.has(key)
      ) {
        await this.options.releaseSubscription(subscription.id);
        return;
      }
      this.recordSubscription(
        subscription,
        preferred.selection,
        preferred.intentGeneration
      );
    })();
    this.#subscriptionAttempts.set(key, attempt);
    try {
      await attempt;
    } finally {
      if (this.#subscriptionAttempts.get(key) === attempt) {
        this.#subscriptionAttempts.delete(key);
      }
    }
  }

  async resetSubscriptions(): Promise<void> {
    this.invalidateAuthority();
    const ids = [...this.#subscriptionsById.keys()];
    this.#subscriptionsById.clear();
    this.#subscriptionIdByScope.clear();
    await Promise.allSettled([
      ...this.#subscriptionAttempts.values(),
      ...ids.map((id) => this.options.releaseSubscription(id))
    ]);
  }

  rememberSelectionView(snapshot: CollaborationSnapshot): void {
    if (snapshot.view.kind === "empty" || this.#disposed) return;
    const now = this.#now();
    this.#selectionViews.set(
      this.options.selectionIdentity(snapshot.selection),
      {
        authorityGeneration: this.#authorityGeneration,
        selection: snapshot.selection,
        view: snapshot.view,
        lastAccessedAt: now,
        loadedAt: now
      }
    );
    this.#pruneSelectionViews(now);
  }

  selectionView(
    selection: CollaborationSelection
  ): CollaborationSnapshot["view"] | null {
    const key = this.options.selectionIdentity(selection);
    const entry = this.#selectionViews.get(key);
    const now = this.#now();
    if (
      !entry ||
      entry.authorityGeneration !== this.#authorityGeneration ||
      now - entry.loadedAt > this.options.selectionCacheRetentionMs
    ) {
      this.#selectionViews.delete(key);
      return null;
    }
    entry.lastAccessedAt = now;
    return entry.view;
  }

  clearTeamSelectionViews(teamId?: string): void {
    for (const [key, entry] of this.#selectionViews) {
      const entryTeamId = this.options.teamIdForSelection(entry.selection);
      if (
        entryTeamId !== null &&
        (teamId === undefined || entryTeamId === teamId)
      ) {
        this.#selectionViews.delete(key);
      }
    }
  }

  clearThreadSelectionViews(threadId: string): void {
    for (const [key, entry] of this.#selectionViews) {
      if (
        (entry.view.kind === "thread" && entry.view.thread.id === threadId) ||
        (entry.view.kind === "shared_session" &&
          entry.view.companion.thread.id === threadId)
      ) {
        this.#selectionViews.delete(key);
      }
    }
  }

  clearSharedSessionSelectionView(sharedSessionId: string): void {
    for (const [key, entry] of this.#selectionViews) {
      if (
        entry.selection.kind === "shared_session" &&
        entry.selection.sharedSessionId === sharedSessionId
      ) {
        this.#selectionViews.delete(key);
      }
    }
  }

  coordinateSelectionLoad(
    selection: CollaborationSelection,
    load: () => Promise<CollaborationSnapshot | null>
  ): Promise<CollaborationSnapshot | null> {
    const key = this.options.selectionIdentity(selection);
    const authorityGeneration = this.#authorityGeneration;
    const existing = this.#selectionLoads.get(key);
    if (existing && existing.authorityGeneration === authorityGeneration) {
      return existing.promise;
    }
    const pending = load()
      .then((result) =>
        this.authorityIsCurrent(authorityGeneration) ? result : null
      )
      .finally(() => {
        if (this.#selectionLoads.get(key)?.promise === pending) {
          this.#selectionLoads.delete(key);
        }
      });
    this.#selectionLoads.set(key, { authorityGeneration, promise: pending });
    return pending;
  }

  coordinatedSelectionLoad(
    selection: CollaborationSelection
  ): Promise<CollaborationSnapshot | null> | undefined {
    const load = this.#selectionLoads.get(
      this.options.selectionIdentity(selection)
    );
    return load?.authorityGeneration === this.#authorityGeneration
      ? load.promise
      : undefined;
  }

  dispose(): string[] {
    if (this.#disposed) return [];
    this.#disposed = true;
    this.#authorityGeneration += 1;
    this.#selectionLoads.clear();
    this.#selectionViews.clear();
    const ids = [...this.#subscriptionsById.keys()];
    this.#subscriptionsById.clear();
    this.#subscriptionIdByScope.clear();
    return ids;
  }

  #now(): number {
    return (this.options.now ?? Date.now)();
  }

  #pruneSelectionViews(now: number): void {
    for (const [key, entry] of this.#selectionViews) {
      if (now - entry.lastAccessedAt > this.options.selectionCacheRetentionMs) {
        this.#selectionViews.delete(key);
      }
    }
    if (this.#selectionViews.size <= this.options.selectionCacheLimit) return;
    const oldest = [...this.#selectionViews.entries()].sort(
      ([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt
    );
    for (const [key] of oldest) {
      if (this.#selectionViews.size <= this.options.selectionCacheLimit) break;
      this.#selectionViews.delete(key);
    }
  }
}

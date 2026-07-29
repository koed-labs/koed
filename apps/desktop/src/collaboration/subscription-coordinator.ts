import type {
  CollaborationSelection,
  CollaborationSubscription
} from "@koed/shared/collaboration";

export type CollaborationSubscriptionRecord = {
  subscription: CollaborationSubscription;
  preferredSelection: CollaborationSelection | null;
  selectionIntentGeneration: number;
};

type SubscriptionScope = CollaborationSubscription["scope"];

const scopeKey = (scope: SubscriptionScope): string =>
  scope.scope === "personal" ? "personal" : `team:${scope.teamId}`;

export class CollaborationSubscriptionCoordinator {
  readonly #byId = new Map<string, CollaborationSubscriptionRecord>();
  readonly #idByScope = new Map<string, string>();
  readonly #inFlight = new Map<string, Promise<void>>();
  #generation = 0;
  #disposed = false;

  constructor(
    private readonly create: (
      scope: SubscriptionScope
    ) => Promise<CollaborationSubscription | null>,
    private readonly unsubscribe: (subscriptionId: string) => Promise<void>,
    private readonly preferredSelection: (scope: SubscriptionScope) => {
      selection: CollaborationSelection | null;
      intentGeneration: number;
    }
  ) {}

  has(subscriptionId: string): boolean {
    return this.#byId.has(subscriptionId);
  }

  get(subscriptionId: string): CollaborationSubscriptionRecord | undefined {
    return this.#byId.get(subscriptionId);
  }

  record(
    subscription: CollaborationSubscription,
    preferredSelection?: CollaborationSelection | null,
    preferredSelectionIntentGeneration?: number
  ): void {
    const key = scopeKey(subscription.scope);
    const previousId = this.#idByScope.get(key);
    const previous = previousId ? this.#byId.get(previousId) : undefined;
    if (previousId && previousId !== subscription.id) {
      this.#byId.delete(previousId);
    }
    const preferred = this.preferredSelection(subscription.scope);
    this.#byId.set(subscription.id, {
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
    this.#idByScope.set(key, subscription.id);
  }

  drop(subscriptionId: string): CollaborationSubscriptionRecord | undefined {
    const record = this.#byId.get(subscriptionId);
    this.#byId.delete(subscriptionId);
    if (
      record &&
      this.#idByScope.get(scopeKey(record.subscription.scope)) ===
        subscriptionId
    ) {
      this.#idByScope.delete(scopeKey(record.subscription.scope));
    }
    return record;
  }

  updateVersion(subscriptionId: string, version: number): void {
    const record = this.#byId.get(subscriptionId);
    if (!record) return;
    record.subscription = {
      ...record.subscription,
      state: "active",
      version
    };
  }

  async subscribe(scope: SubscriptionScope): Promise<void> {
    const key = scopeKey(scope);
    if (this.#idByScope.has(key) || this.#disposed) return;
    const activeAttempt = this.#inFlight.get(key);
    if (activeAttempt) return activeAttempt;
    const generation = this.#generation;
    const preferred = this.preferredSelection(scope);
    const attempt = (async () => {
      const subscription = await this.create(scope);
      if (!subscription) return;
      if (
        this.#disposed ||
        generation !== this.#generation ||
        this.#idByScope.has(key)
      ) {
        await this.unsubscribe(subscription.id);
        return;
      }
      this.record(
        subscription,
        preferred.selection,
        preferred.intentGeneration
      );
    })();
    this.#inFlight.set(key, attempt);
    try {
      await attempt;
    } finally {
      if (this.#inFlight.get(key) === attempt) this.#inFlight.delete(key);
    }
  }

  async reset(): Promise<void> {
    this.#generation += 1;
    const ids = [...this.#byId.keys()];
    this.#byId.clear();
    this.#idByScope.clear();
    await Promise.allSettled([
      ...this.#inFlight.values(),
      ...ids.map((id) => this.unsubscribe(id))
    ]);
  }

  dispose(): string[] {
    this.#disposed = true;
    this.#generation += 1;
    const ids = [...this.#byId.keys()];
    this.#byId.clear();
    this.#idByScope.clear();
    return ids;
  }
}

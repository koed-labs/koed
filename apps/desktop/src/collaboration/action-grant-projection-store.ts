import type { CollaborationActionGrantProjection } from "./renderer-client.js";

export class CollaborationActionGrantProjectionStore {
  readonly #listeners = new Set<() => void>();
  readonly #projections = new Map<string, CollaborationActionGrantProjection>();
  #snapshot: readonly CollaborationActionGrantProjection[] = [];
  #authorityGeneration = 0;

  constructor(private readonly limit = 20) {}

  current(): readonly CollaborationActionGrantProjection[] {
    return this.#snapshot;
  }

  get(id: string): CollaborationActionGrantProjection | undefined {
    return this.#projections.get(id);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(projection: CollaborationActionGrantProjection): void {
    this.#projections.delete(projection.id);
    this.#projections.set(projection.id, projection);
    while (this.#projections.size > this.limit) {
      const oldest = this.#projections.keys().next().value;
      if (!oldest) break;
      this.#projections.delete(oldest);
    }
    this.#snapshot = [...this.#projections.values()];
    for (const listener of this.#listeners) listener();
  }

  authorityGeneration(): number {
    return this.#authorityGeneration;
  }

  authorityIsCurrent(generation: number): boolean {
    return generation === this.#authorityGeneration;
  }

  revokeAuthority(): void {
    this.#authorityGeneration += 1;
  }

  dispose(): void {
    this.#listeners.clear();
    this.#projections.clear();
    this.#snapshot = [];
  }
}

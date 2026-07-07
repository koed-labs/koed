export const INTERACTIVE_PRIORITY = "interactive";
export const BACKGROUND_PRIORITY = "background";

export type EmbeddingPriority =
  | typeof INTERACTIVE_PRIORITY
  | typeof BACKGROUND_PRIORITY;

const priorityRank = new Map<string, number>([
  [INTERACTIVE_PRIORITY, 0],
  ["question", 0],
  ["foreground", 0],
  [BACKGROUND_PRIORITY, 10]
]);

export interface SchedulerSnapshot {
  active: boolean;
  waiting_interactive: number;
  waiting_background: number;
}

interface Waiter {
  rank: number;
  sequence: number;
  normalized: EmbeddingPriority;
  resolve: () => void;
}

export const normalizeEmbeddingPriority = (
  value: string | null | undefined
): EmbeddingPriority => {
  const normalized = (value ?? INTERACTIVE_PRIORITY).trim().toLowerCase();
  return priorityRank.get(normalized) === 10
    ? BACKGROUND_PRIORITY
    : INTERACTIVE_PRIORITY;
};

export class EmbeddingPriorityScheduler {
  private active = false;
  private nextSequence = 0;
  private waiting: Waiter[] = [];

  async slot<T>(
    priority: string | null | undefined,
    task: () => Promise<T> | T
  ): Promise<T> {
    const normalized = normalizeEmbeddingPriority(priority);
    const waiter: Waiter = {
      rank: priorityRank.get(normalized) ?? 0,
      sequence: this.nextSequence,
      normalized,
      resolve: () => undefined
    };
    this.nextSequence += 1;
    await new Promise<void>((resolve) => {
      waiter.resolve = resolve;
      this.waiting.push(waiter);
      this.drain();
    });
    try {
      return await task();
    } finally {
      this.active = false;
      this.drain();
    }
  }

  snapshot(): SchedulerSnapshot {
    return {
      active: this.active,
      waiting_interactive: this.waiting.filter((waiter) => waiter.rank === 0)
        .length,
      waiting_background: this.waiting.filter((waiter) => waiter.rank > 0)
        .length
    };
  }

  private drain(): void {
    if (this.active || this.waiting.length === 0) {
      return;
    }
    const next = this.waiting.reduce((best, current) => {
      if (current.rank < best.rank) return current;
      if (current.rank === best.rank && current.sequence < best.sequence) {
        return current;
      }
      return best;
    });
    this.waiting = this.waiting.filter((waiter) => waiter !== next);
    this.active = true;
    queueMicrotask(next.resolve);
  }
}

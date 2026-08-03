export type RendererEventQueueLimits = {
  maxCount: number;
  maxBytes: number;
};

type QueueItem<T> = {
  event: T;
  bytes: number;
  retryAttempt: number;
};

export class RendererEventQueue<T> {
  #pending: QueueItem<T>[] = [];
  #pendingBytes = 0;
  #processing = false;
  #disposed = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly limits: () => RendererEventQueueLimits,
    private readonly process: (
      event: T,
      retryAttempt: number
    ) => Promise<number | null>,
    private readonly overflow: () => void,
    private readonly afterProcess: (event: T) => void
  ) {}

  enqueue(
    event: T,
    bytes: number,
    options: { prepend?: boolean; preemptRetry?: boolean } = {}
  ): boolean {
    if (this.#disposed) return false;
    if (options.preemptRetry) this.#clearRetry();
    const limits = this.limits();
    if (
      this.#pending.length + 1 > limits.maxCount ||
      this.#pendingBytes + bytes > limits.maxBytes
    ) {
      this.clear();
      this.overflow();
      return false;
    }
    const item = { event, bytes, retryAttempt: 0 };
    if (options.prepend) this.#pending.unshift(item);
    else this.#pending.push(item);
    this.#pendingBytes += bytes;
    void this.#drain();
    return true;
  }

  drop(predicate: (event: T) => boolean): void {
    this.#pending = this.#pending.filter((item) => {
      if (!predicate(item.event)) return true;
      this.#pendingBytes -= item.bytes;
      return false;
    });
    this.#pendingBytes = Math.max(0, this.#pendingBytes);
  }

  clear(): void {
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearRetry();
    this.clear();
  }

  async #drain(): Promise<void> {
    if (this.#processing || this.#disposed || this.#retryTimer !== null) return;
    this.#processing = true;
    try {
      while (this.#pending.length > 0 && !this.#disposed) {
        const next = this.#pending.shift()!;
        this.#pendingBytes -= next.bytes;
        let retryDelay: number | null;
        try {
          retryDelay = await this.process(next.event, next.retryAttempt);
        } finally {
          this.afterProcess(next.event);
        }
        if (retryDelay !== null) {
          this.#pending.unshift({
            ...next,
            retryAttempt: next.retryAttempt + 1
          });
          this.#pendingBytes += next.bytes;
          this.#retryTimer = setTimeout(() => {
            this.#retryTimer = null;
            void this.#drain();
          }, retryDelay);
          return;
        }
      }
    } finally {
      this.#processing = false;
      if (
        this.#pending.length > 0 &&
        this.#retryTimer === null &&
        !this.#disposed
      ) {
        queueMicrotask(() => void this.#drain());
      }
    }
  }

  #clearRetry(): void {
    if (this.#retryTimer === null) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }
}

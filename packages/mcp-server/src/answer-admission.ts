type Release = () => void;

export class AnswerExecutionCapacity {
  private active = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly maxActive: number) {
    if (!Number.isInteger(maxActive) || maxActive < 1) {
      throw new Error("Answer execution capacity must be positive");
    }
  }

  tryAcquire(): Release | null {
    if (this.active >= this.maxActive) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      for (const listener of this.listeners) listener();
    };
  }

  onAvailable(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get diagnostics() {
    return { active: this.active };
  }
}

export class BlockingAnswerAdmission {
  private readonly queue: Array<{
    resolve: (release: Release) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];
  private readonly unsubscribe: () => void;

  constructor(
    private readonly capacity: AnswerExecutionCapacity,
    private readonly maxQueued: number
  ) {
    if (!Number.isInteger(maxQueued) || maxQueued < 1) {
      throw new Error("Answer admission queue capacity must be positive");
    }
    this.unsubscribe = capacity.onAvailable(() => this.drain());
  }

  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) {
      return Promise.reject(new Error("Koed memory request was cancelled"));
    }
    const release = this.capacity.tryAcquire();
    if (release) return Promise.resolve(release);
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(
        Object.assign(new Error("Koed Memory Answer queue is full"), {
          statusCode: 429
        })
      );
    }
    return new Promise((resolve, reject) => {
      const entry: (typeof this.queue)[number] = { resolve, reject, signal };
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error("Koed memory request was cancelled"));
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
    });
  }

  close(): void {
    this.unsubscribe();
    for (const entry of this.queue.splice(0)) {
      entry.signal?.removeEventListener("abort", entry.abort!);
      entry.reject(new Error("Koed local AI runtime is shutting down"));
    }
  }

  get diagnostics() {
    return { ...this.capacity.diagnostics, queued: this.queue.length };
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const release = this.capacity.tryAcquire();
      if (!release) return;
      const entry = this.queue.shift()!;
      entry.signal?.removeEventListener("abort", entry.abort!);
      if (entry.signal?.aborted) {
        release();
        entry.reject(new Error("Koed memory request was cancelled"));
        continue;
      }
      entry.resolve(release);
    }
  }
}

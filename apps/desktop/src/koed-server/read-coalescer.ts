/**
 * Many Desktop views poll the same local API reads (Conversation list, launch
 * options, Project lists) every few seconds. On a busy Mac those reads queue
 * behind each other and every screen waits. The coalescer lets callers that
 * ask for the same read at the same time share one request, and reuses a
 * just-finished answer for a short moment. Any write clears it, so a view
 * never sees its own change missing.
 */
export type ReadCoalescer = {
  read<T>(key: string, load: () => Promise<T>): Promise<T>;
  clear(): void;
};

export const createReadCoalescer = (
  freshMs: number,
  now: () => number = Date.now
): ReadCoalescer => {
  type Entry = { value: Promise<unknown>; settledAt: number | null };
  const entries = new Map<string, Entry>();
  let generation = 0;
  return {
    read<T>(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && (hit.settledAt === null || now() - hit.settledAt < freshMs))
        return hit.value as Promise<T>;
      const started = generation;
      const value = load();
      const entry: Entry = { value, settledAt: null };
      entries.set(key, entry);
      value.then(
        () => {
          // A write while this read was in flight may have made it stale.
          if (started !== generation) {
            if (entries.get(key) === entry) entries.delete(key);
            return;
          }
          entry.settledAt = now();
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        }
      );
      return value;
    },
    clear() {
      generation += 1;
      entries.clear();
    }
  };
};

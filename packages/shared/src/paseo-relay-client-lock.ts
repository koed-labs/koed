const queues = new Map<string, Promise<void>>();

export const withPaseoRelayClientLock = async <T>(
  routeId: string,
  operation: () => Promise<T>
): Promise<T> => {
  const previous = queues.get(routeId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  queues.set(routeId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(routeId) === tail) queues.delete(routeId);
  }
};

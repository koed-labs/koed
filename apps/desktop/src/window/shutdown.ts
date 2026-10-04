/** Keeps failed or stalled service cleanup from trapping Desktop in Quit. */
export const createDesktopShutdown = (input: {
  cleanup: () => Promise<void>;
  finish: (forced: boolean) => void;
  timeoutMs?: number;
}): (() => Promise<void>) => {
  let shutdown: Promise<void> | null = null;
  return () => {
    if (shutdown) return shutdown;
    shutdown = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (forced: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        input.finish(forced);
        resolve();
      };
      const timeout = setTimeout(() => finish(true), input.timeoutMs ?? 15_000);
      void Promise.resolve()
        .then(input.cleanup)
        .then(
          () => finish(false),
          () => finish(true)
        );
    });
    return shutdown;
  };
};

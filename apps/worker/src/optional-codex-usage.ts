/** Optional telemetry must never reject the provider's completed turn. */
export const scheduleOptionalCodexUsage = <Instance>(input: {
  resolveInstance: () => Instance;
  publish: (instance: Instance) => Promise<unknown>;
  onError: (error: unknown) => void;
}): void => {
  void Promise.resolve()
    .then(input.resolveInstance)
    .then(input.publish)
    .catch((error: unknown) => {
      try {
        input.onError(error);
      } catch {
        /* Diagnostics are also optional. */
      }
    });
};

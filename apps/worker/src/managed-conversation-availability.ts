import type { WorkerBackgroundService } from "./background-service-gate.js";

export const createManagedConversationServiceForWorker = (
  create: () => Promise<WorkerBackgroundService | null>
): Promise<WorkerBackgroundService | null> => {
  // Keep the factory dormant so no credentials are resolved and no work is claimed.
  void create;
  return Promise.resolve(null);
};

export interface WorkerBackgroundService {
  start(): void;
  stop(): void | Promise<void>;
}

export interface ActiveWorkerBackgroundServices {
  stop(): Promise<void>;
}

export const startWorkerBackgroundServices = (input: {
  personal: Array<WorkerBackgroundService | null>;
  maintenance: Array<WorkerBackgroundService | null>;
  team: Array<WorkerBackgroundService | null>;
  teamCollaborationEnabled: boolean;
}): ActiveWorkerBackgroundServices => {
  const active = [
    ...input.personal,
    ...input.maintenance,
    ...(input.teamCollaborationEnabled ? input.team : [])
  ].filter((service): service is WorkerBackgroundService => service !== null);

  for (const service of active) service.start();

  return {
    stop: async () => {
      await Promise.all(
        active.map(async (service) => {
          await service.stop();
        })
      );
    }
  };
};

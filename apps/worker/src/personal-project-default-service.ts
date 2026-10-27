import type { PersonalProjectDefaultRepository } from "@koed/db";
import {
  createNotificationDrainController,
  type NotificationDrainPool
} from "./notification-drain-controller.js";

/** Use the existing wake/retry scheduler. Durable scan checkpoints remain in
 * PostgreSQL and source capture never waits for organization work. */
export const createPersonalProjectDefaultService = (input: {
  repository: PersonalProjectDefaultRepository;
  wakePool: NotificationDrainPool;
  logger: { error(bindings: Record<string, unknown>, message: string): void };
}) => {
  const processOnce = async () => {
    const ownerUserId =
      await input.repository.nextPersonalProjectDefaultOwner();
    if (!ownerUserId) {
      controller.scheduleRetry(
        await input.repository.nextPersonalProjectDefaultRetryAt()
      );
      return { processed: false };
    }
    try {
      await input.repository.reconcilePersonalProjectDefaults({
        userId: ownerUserId
      });
      return { processed: true };
    } catch (error) {
      await input.repository.deferPersonalProjectDefaults({
        userId: ownerUserId
      });
      throw error;
    }
  };
  const controller = createNotificationDrainController({
    channels: ["koed_project_defaults"],
    wakePool: input.wakePool,
    processOnce,
    shouldContinue: (result) => result.processed,
    onProcessError: (error) =>
      input.logger.error(
        { errorClass: error instanceof Error ? error.name : "UnknownError" },
        "Project default reconciliation failed; retained work will retry"
      )
  });
  return { start: controller.start, stop: controller.stop, processOnce };
};

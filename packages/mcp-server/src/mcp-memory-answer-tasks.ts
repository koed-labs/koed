import { z } from "zod";
import { uuidSchema } from "./memory-tool-schemas.js";

export {
  collectMemoryAnswerTask,
  pendingMemoryAnswerTask,
  presentMemoryAnswerTask,
  validateMemoryAnswerTask
} from "../integrations/pi/memory-answer-task-presentation.mjs";

export const memoryAnswerTaskInputSchema = z
  .object({ task_id: uuidSchema })
  .strict();

export const memoryAnswerResultInputSchema = memoryAnswerTaskInputSchema.extend(
  {
    wait: z.boolean().default(false)
  }
);

export const memoryAnswerResultToolDescription =
  "Collect an accepted non-blocking Memory Answer by task_id. Default wait=false returns immediately: pending or compact final answer. Explicit wait=true blocks until completion, cancellation, failure, disconnect, task expiry, or the existing observation lifecycle limit; use it when the next action needs recall and no useful independent work remains. Do not use a tight polling loop or repeat memory_answer. Collection never starts another recall and detaching does not cancel execution. Compact only; use blocking memory_answer for citations or evidence.";
export const memoryAnswerCancelToolDescription =
  "Cancel an accepted Memory Answer by task_id when it is no longer needed. Returns immediately. Cancellation may still be in progress; completed recall cannot be cancelled.";

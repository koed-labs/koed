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
    wait_seconds: z.number().int().min(0).max(30).default(0)
  }
);

export const memoryAnswerResultToolDescription =
  "Collect an accepted non-blocking Memory Answer by task_id. Default wait_seconds=0 returns immediately: pending or compact final answer. Explicit wait_seconds (integer 1-30) blocks up to that many seconds for completion; use it when the next action needs recall and no useful independent work remains. A timeout returns pending; do not use a tight polling loop or repeat memory_answer. Collection never starts another recall. Compact only; use blocking memory_answer for citations or evidence.";
export const memoryAnswerCancelToolDescription =
  "Cancel an accepted Memory Answer by task_id when it is no longer needed. Returns immediately. Cancellation may still be in progress; completed recall cannot be cancelled.";

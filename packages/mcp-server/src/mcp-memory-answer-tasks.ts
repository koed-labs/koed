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
  "Get a non-blocking Memory Answer using its task_id. Default wait=false returns the current state now. Use wait=true when the answer is needed and independent work is finished; wait on the same task until it settles or existing expiry, observation or harness limits end the call. Pending is not not-found. Do not poll rapidly or repeat the question. A disconnect does not cancel execution; keep the ID. Returns the answer with citations or evidence requested at submission; compact is the default.";
export const memoryAnswerCancelToolDescription =
  "Cancel an accepted Memory Answer by task_id when it is no longer needed. Returns immediately. Cancellation may still be in progress; completed recall cannot be cancelled.";

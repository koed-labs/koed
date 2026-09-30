import { z } from "zod";

import {
  personalAgentIntentSignalSchema,
  personalAgentTurnStatusSchema,
  type PersonalAgentIntentSignal,
  type PersonalAgentTurnStatus
} from "@koed/shared";

/** Input shape exposed as a provider-native tool in existing Agent turns. */
export const personalAgentIntentToolInputSchema = z
  .object({
    kind: z.enum(["assign", "continue", "new_job"]),
    goal: z.string().trim().min(1).max(1_000).optional()
  })
  .strict();

export const parsePersonalAgentIntentToolInput = (
  value: unknown
): PersonalAgentIntentSignal => personalAgentIntentSignalSchema.parse(value);

export const PERSONAL_AGENT_INTENT_TOOL_NAME = "koed_agent_intent";

export const PERSONAL_AGENT_INTENT_TOOL_DESCRIPTION =
  "Record the user's explicit intent to assign or continue work. Call only after the user explicitly asked you to perform work, before taking work actions. Do not call for planning, questions, discussion, result questions, summary drafting, or ambiguity. The tool records intent only and does not grant permissions.";

export const PERSONAL_AGENT_TURN_STATUS_TOOL_NAME = "koed_agent_turn_status";

export const PERSONAL_AGENT_TURN_STATUS_TOOL_DESCRIPTION =
  "Record whether the assigned Job is complete or needs an owner's answer. Call complete only when the requested goal is fully done. Call awaiting_owner when work is blocked on a user decision or answer. This reports outcome; it does not grant permissions.";

export const personalAgentTurnStatusToolInputSchema = z
  .object({ status: personalAgentTurnStatusSchema })
  .strict();

export const parsePersonalAgentTurnStatusToolInput = (
  value: unknown
): PersonalAgentTurnStatus =>
  personalAgentTurnStatusToolInputSchema.parse(value).status;

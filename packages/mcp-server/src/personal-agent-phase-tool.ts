import {
  personalAgentPhaseSchema,
  type PersonalAgentPhase
} from "@koed/shared";
import { z } from "zod";

/** Input exposed as a provider-native tool in an assigned Agent turn. */
export const personalAgentPhaseToolInputSchema = z
  .object({ phase: personalAgentPhaseSchema })
  .strict();

export const parsePersonalAgentPhaseToolInput = (
  value: unknown
): PersonalAgentPhase => personalAgentPhaseToolInputSchema.parse(value).phase;

export const PERSONAL_AGENT_PHASE_TOOL_NAME = "koed_job_phase";

export const PERSONAL_AGENT_PHASE_TOOL_DESCRIPTION =
  "Report the assigned Job's explicit work phase. Use working while implementing or taking action, checking while verifying or reviewing results, and working again if you return to implementation. This is progress only: it does not mark the Job complete or request an owner's answer.";

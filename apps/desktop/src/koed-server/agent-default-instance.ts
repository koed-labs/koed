import type { AgentBootstrapContext } from "@koed/shared/agent-contract";
import {
  codeDefaultAssignmentFor,
  documentDefault,
  environmentDefaultFor
} from "./local-ai-client-defaults.js";

/** Resolve owner-bound conversations configuration; readiness belongs to dispatch. */
export const resolveChiefDefaultInstance = (
  context: AgentBootstrapContext,
  ownerUserId: string,
  environment: NodeJS.ProcessEnv
): string | null => {
  if (context.ownerUserId !== ownerUserId)
    throw new Error("Agent bootstrap owner identity mismatch.");
  const fallback = environmentDefaultFor(
    "conversations",
    documentDefault(codeDefaultAssignmentFor("conversations")),
    environment
  );
  const assignment =
    context.savedConversations ??
    (fallback.available && fallback.assignment
      ? {
          provider: fallback.assignment.provider,
          aiClientInstanceId: fallback.assignment.ai_client_instance_id
        }
      : null);
  if (!assignment) return null;
  const matches = context.enabledInstances.filter(
    (item) => item.instanceId === assignment.aiClientInstanceId
  );
  if (matches.length !== 1 || matches[0]?.driverId !== assignment.provider)
    return null;
  return matches[0].instanceId;
};

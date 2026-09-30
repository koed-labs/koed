import { personalAgentsHttpAdapter } from "@/lib/personal-agents-client";
import type { TeamAgentRequestsClient } from "@/lib/team-agent-requests-client";
import {
  buildTeamAgentMentions,
  type TeamAgentMention
} from "@/lib/team-agent-mentions-state";
export {
  buildOwnedAgentHandoffDraft,
  buildTeamAgentMentions,
  privateAgentHandoffHref,
  teamMentionSelectionForScope,
  type ScopedTeamMentionSelection,
  type TeamAgentMention
} from "@/lib/team-agent-mentions-state";

export async function loadTeamAgentMentions(
  client: TeamAgentRequestsClient,
  teamId: string,
  principalId: string,
  signal: AbortSignal
): Promise<TeamAgentMention[]> {
  const [agents, offers] = await Promise.all([
    personalAgentsHttpAdapter.list(signal),
    client.listOffers(teamId)
  ]);
  if (signal.aborted) return [];
  return buildTeamAgentMentions(principalId, agents, offers);
}

"use client";

import { useEffect, useMemo, useState } from "react";
import type { TeamAgentRequestsClient } from "@/lib/team-agent-requests-client";
import {
  loadTeamAgentMentions,
  type TeamAgentMention
} from "@/lib/team-agent-mentions";

type State = { key: string; options: TeamAgentMention[]; error: string | null };

export function useTeamAgentMentions(
  client: TeamAgentRequestsClient,
  teamId: string,
  principalId: string,
  authorityKey: string,
  revision: number
) {
  const [state, setState] = useState<State>({
    key: "",
    options: [],
    error: null
  });
  const key = `${authorityKey}\u0000${teamId}\u0000${principalId}`;
  useEffect(() => {
    if (!teamId || !principalId) return;
    const controller = new AbortController();
    // The key-tagged state prevents agents from the previous Team/account painting during a scope transition.
    void loadTeamAgentMentions(client, teamId, principalId, controller.signal)
      .then((options) => {
        if (!controller.signal.aborted) setState({ key, options, error: null });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            options: [],
            error:
              failure instanceof Error
                ? failure.message
                : "Team Agents are unavailable."
          });
      });
    return () => controller.abort();
  }, [authorityKey, client, key, principalId, revision, teamId]);
  return useMemo(
    () =>
      state.key === key
        ? { options: state.options, error: state.error, loading: false }
        : { options: [], error: null, loading: true },
    [key, state]
  );
}

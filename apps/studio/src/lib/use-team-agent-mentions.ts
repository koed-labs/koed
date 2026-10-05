"use client";

import { useEffect, useMemo, useState } from "react";
import type { TeamAgentRequestsClient } from "@/lib/team-agent-requests-client";
import {
  loadTeamAgentMentions,
  type TeamAgentMention
} from "@/lib/team-agent-mentions";

import { managedRequest, parseLaunchInstances } from "@/lib/managed-agent-chat";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";
type State = {
  key: string;
  options: TeamAgentMention[];
  error: string | null;
  models: AgentModelCapability[];
};

export function useTeamAgentMentions(
  client: TeamAgentRequestsClient,
  teamId: string,
  principalId: string,
  authorityKey: string,
  revision: number
) {
  const [state, setState] = useState<State>({
    key: "",
    models: [],
    options: [],
    error: null
  });
  const key = `${authorityKey}\u0000${teamId}\u0000${principalId}`;
  useEffect(() => {
    if (!teamId || !principalId) return;
    const controller = new AbortController();
    // The key-tagged state prevents agents from the previous Team/account painting during a scope transition.
    void Promise.all([
      loadTeamAgentMentions(client, teamId, principalId, controller.signal),
      managedRequest("/launch-options", undefined, controller.signal)
        .then((options) =>
          parseLaunchInstances(options).flatMap((instance) => instance.models)
        )
        .catch(() => [])
    ])
      .then(([options, models]) => {
        if (!controller.signal.aborted)
          setState({ key, options, models, error: null });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            models: [],
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
        ? {
            options: state.options,
            models: state.models,
            error: state.error,
            modelAvailabilityWarning:
              state.models.length === 0
                ? "AI models are unavailable. Check your AI Client settings before starting work."
                : null,
            loading: false
          }
        : {
            options: [],
            models: [],
            error: null,
            modelAvailabilityWarning: null,
            loading: true
          },
    [key, state]
  );
}

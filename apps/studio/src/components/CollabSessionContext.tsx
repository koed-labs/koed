"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { CollabLanding } from "@/lib/home";
import { useWorkspace } from "./WorkspaceProvider";

// The team-side view model is fully flat now: there is no notion of "the
// project you're currently inside" any more (that used to hide every other
// project's channels/DMs/agents, which is exactly the drill-down the
// sidebar redesign got rid of). A channel, DM or agent id already carries
// whatever project context it needs, so the session only has to remember
// which one is open.
export type CollabView =
  | { type: "square" }
  | { type: "channel"; id: string }
  | { type: "dm"; id: string }
  | { type: "agent"; id: string }
  | { type: "inbox" };

type CollabSessionValue = {
  view: CollabView;
  openView: (view: CollabView) => void;
  openSquare: () => void;
  openChannel: (channelId: string) => void;
  openDm: (dmId: string) => void;
  openAgent: (agentId: string) => void;
  openInbox: () => void;
};

const CollabSessionContext = createContext<CollabSessionValue | undefined>(undefined);

// "For you" is the team's front door - landing on a team with no more
// specific instruction (a Home-feed click, or just switching teams) drops
// you there instead of the Square, the same way Personal opens on Home
// rather than the last thread you happened to have open.
function viewFromLanding(landing: CollabLanding): CollabView {
  if (landing.view === "inbox") return { type: "inbox" };
  if (landing.view === "agent" && landing.viewId) return { type: "agent", id: landing.viewId };
  if (landing.view === "channel" && landing.viewId) return { type: "channel", id: landing.viewId };
  return { type: "square" };
}

export function CollabSessionProvider({ children }: { children: React.ReactNode }) {
  const { activeTeamId, collabLanding, clearCollabLanding, markDmRead } = useWorkspace();
  const [view, setView] = useState<CollabView>({ type: "inbox" });
  const [sessionTeamId, setSessionTeamId] = useState(activeTeamId);

  if (sessionTeamId !== activeTeamId) {
    setSessionTeamId(activeTeamId);
    if (collabLanding && collabLanding.teamId === activeTeamId) {
      setView(viewFromLanding(collabLanding));
    } else {
      setView({ type: "inbox" });
    }
  }

  useEffect(() => {
    if (!collabLanding) return;
    if (collabLanding.teamId !== activeTeamId) return;
    // Apply a one-shot route landing after workspace hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView(viewFromLanding(collabLanding));
    clearCollabLanding();
  }, [activeTeamId, clearCollabLanding, collabLanding]);

  const openView = useCallback((next: CollabView) => {
    setView(next);
  }, []);

  const openSquare = useCallback(() => {
    setView({ type: "square" });
  }, []);

  const openChannel = useCallback((channelId: string) => {
    setView({ type: "channel", id: channelId });
  }, []);

  const openDm = useCallback(
    (dmId: string) => {
      markDmRead(dmId);
      setView({ type: "dm", id: dmId });
    },
    [markDmRead]
  );

  const openAgent = useCallback((agentId: string) => {
    setView({ type: "agent", id: agentId });
  }, []);

  const openInbox = useCallback(() => {
    setView({ type: "inbox" });
  }, []);

  return (
    <CollabSessionContext.Provider
      value={{
        view,
        openView,
        openSquare,
        openChannel,
        openDm,
        openAgent,
        openInbox,
      }}
    >
      {children}
    </CollabSessionContext.Provider>
  );
}

export function useCollabSession() {
  const context = useContext(CollabSessionContext);
  if (!context) {
    throw new Error("useCollabSession must be used within a CollabSessionProvider");
  }
  return context;
}

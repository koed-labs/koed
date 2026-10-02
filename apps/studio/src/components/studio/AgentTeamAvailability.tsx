"use client";

import { useEffect, useMemo, useState } from "react";
import { TeamAgentOffers } from "@/components/TeamAgentOffers";
import { loadHostedSession } from "@/lib/hosted-session";
import { StudioCollaborationClient } from "@/lib/studio-collaboration-client";
import { TeamAgentRequestsClient } from "@/lib/team-agent-requests-client";

/** Uses the existing Team offers authority; never publishes the private Agent profile. */
export function AgentTeamAvailability({
  agentId,
  ownerId,
  backendId
}: {
  agentId: string;
  ownerId: string;
  backendId: string;
}) {
  const transport =
    process.env.NEXT_PUBLIC_KOED_STUDIO_HOSTED === "1" ? "hosted" : "studio";
  const client = useMemo(
    () => new TeamAgentRequestsClient(transport),
    [transport]
  );
  const [context, setContext] = useState<{
    state: "loading" | "ready" | "unavailable";
    authorityKey: string;
    teams: Array<{ id: string; name: string }>;
  }>({ state: "loading", authorityKey: "", teams: [] });
  const [revision, setRevision] = useState(0);
  const identityKey = `${backendId}:${ownerId}:${agentId}`;

  useEffect(() => {
    let current = true;
    let sequence = 0;
    const refresh = async () => {
      const read = ++sequence;
      setContext({ state: "loading", authorityKey: "", teams: [] });
      try {
        let principalId: string | null;
        let authority: string | null;
        let teams: Array<{ id: string; name: string }>;
        if (transport === "hosted") {
          const session = await loadHostedSession();
          if (session.status !== "authenticated")
            throw new Error("Team account unavailable");
          principalId = session.user.id;
          authority = window.location.origin;
          teams = session.teams.map(({ id, name }) => ({ id, name }));
        } else {
          const snapshot = await new StudioCollaborationClient().loadSession();
          principalId = snapshot.navigation.teamPrincipal?.id ?? null;
          authority = snapshot.connection.backendId;
          teams = snapshot.navigation.teams.map(({ id, name }) => ({
            id,
            name
          }));
        }
        if (!current || read !== sequence) return;
        if (principalId !== ownerId || !authority)
          throw new Error("Team and Agent accounts differ");
        setContext({
          state: "ready",
          authorityKey: `${identityKey}:${authority}`,
          teams
        });
      } catch {
        if (current && read === sequence)
          setContext({ state: "unavailable", authorityKey: "", teams: [] });
      }
    };
    void refresh();
    const wake = () => void refresh();
    const offline = () => {
      sequence += 1;
      setContext({ state: "unavailable", authorityKey: "", teams: [] });
    };
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("offline", offline);
    return () => {
      current = false;
      sequence += 1;
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", offline);
    };
  }, [identityKey, ownerId, transport, revision]);

  return (
    <section
      aria-label="Team availability"
      className="space-y-3 border-t border-border px-5 py-5"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wider text-subtle">
        Team availability
      </h2>
      <p className="text-xs leading-relaxed text-subtle">
        Teammates see this Agent’s name and the description you approve.
        Instructions and Conversations stay private.
      </p>
      {context.state === "loading" && (
        <p role="status" className="text-xs text-faint">
          Checking your Teams…
        </p>
      )}
      {context.state === "unavailable" && (
        <div className="space-y-2">
          <p role="status" className="text-xs text-faint">
            Connect the same Koed account to manage Team availability.
          </p>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs text-subtle"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {context.state === "ready" && context.teams.length === 0 && (
        <p className="text-xs text-faint">You have no Teams yet.</p>
      )}
      {context.state === "ready" &&
        context.teams.map((team) => (
          <TeamAgentOffers
            key={`${context.authorityKey}:${team.id}`}
            teamId={team.id}
            teamName={team.name}
            onlyAgentId={agentId}
            authorityKey={context.authorityKey}
            refreshRevision={revision}
            client={client}
          />
        ))}
    </section>
  );
}

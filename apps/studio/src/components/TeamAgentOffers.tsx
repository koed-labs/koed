"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { LoaderCircle, RotateCw } from "lucide-react";
import {
  personalAgentsHttpAdapter,
  type PersonalAgent
} from "@/lib/personal-agents-client";
import {
  TeamAgentRequestError,
  TeamAgentRequestsClient
} from "@/lib/team-agent-requests-client";
import type { TeamAgentOffer } from "@koed/shared/team-agent-requests";

type LoadState = "loading" | "ready" | "unavailable";

/** Owner-private controls for publishing only the selected Agent identity and short description to this Team. */
export function TeamAgentOffers({
  teamId,
  teamName,
  onlyAgentId,
  authorityKey,
  refreshRevision,
  client
}: {
  teamId: string;
  teamName?: string;
  onlyAgentId?: string;
  authorityKey: string;
  refreshRevision: number;
  client: TeamAgentRequestsClient;
}) {
  const [agents, setAgents] = useState<PersonalAgent[]>([]);
  const [offers, setOffers] = useState<TeamAgentOffer[]>([]);
  const [draftDescriptions, setDraftDescriptions] = useState<
    Record<string, string>
  >({});
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [loadedAuthority, setLoadedAuthority] = useState<string | null>(null);
  const authorityRef = useRef(authorityKey);
  useLayoutEffect(() => {
    authorityRef.current = authorityKey;
  }, [authorityKey]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const visibleState = loadedAuthority === authorityKey ? state : "loading";
  const titleId = `team-agent-offers-${teamId}-${onlyAgentId ?? "all"}`;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const capturedAuthority = authorityKey;
      try {
        const [nextOffers, nextAgents] = await Promise.all([
          client.listOffers(teamId),
          personalAgentsHttpAdapter.list(signal)
        ]);
        if (
          signal?.aborted ||
          capturedAuthority !== authorityRef.current ||
          !mounted.current
        )
          return;
        setOffers(nextOffers);
        setAgents(
          nextAgents.filter(
            (agent) =>
              agent.lifecycle === "active" &&
              (!onlyAgentId || agent.id === onlyAgentId)
          )
        );
        setDraftDescriptions(
          Object.fromEntries(
            nextOffers
              .filter((offer) => offer.canManage)
              .map((offer) => [offer.agentId, offer.description])
          )
        );
        setState("ready");
        setLoadedAuthority(capturedAuthority);
      } catch (failure) {
        if (
          signal?.aborted ||
          capturedAuthority !== authorityRef.current ||
          !mounted.current
        )
          return;
        setError(
          failure instanceof Error
            ? failure.message
            : "Agent offers are unavailable."
        );
        setState("unavailable");
        setLoadedAuthority(capturedAuthority);
      }
    },
    [authorityKey, client, teamId, onlyAgentId]
  );

  const retry = () => {
    setState("loading");
    setError(null);
    setGeneration((value) => value + 1);
  };

  useEffect(() => {
    const controller = new AbortController();
    // This effect starts the authenticated Team/owner read; its response populates the UI.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [generation, load, refreshRevision]);

  const offersByAgent = useMemo(
    () => new Map(offers.map((offer) => [offer.agentId, offer])),
    [offers]
  );
  const updateOffer = async (agent: PersonalAgent, enabled: boolean) => {
    if (pendingIds.has(agent.id)) return;
    const previous = offersByAgent.get(agent.id);
    const capturedAuthority = authorityKey;
    const submittedDescription =
      draftDescriptions[agent.id] ?? previous?.description ?? "";
    setPendingIds((current) => new Set(current).add(agent.id));
    setError(null);
    try {
      const saved = await client.setOffer({
        teamId,
        agentId: agent.id,
        expectedVersion: previous?.version ?? 0,
        enabled,
        description: submittedDescription.trim()
      });
      if (!mounted.current || capturedAuthority !== authorityRef.current)
        return;
      setOffers((current) => [
        ...current.filter((offer) => offer.agentId !== saved.agentId),
        saved
      ]);
      setDraftDescriptions((current) =>
        (current[agent.id] ?? previous?.description ?? "") ===
        submittedDescription
          ? { ...current, [agent.id]: saved.description }
          : current
      );
    } catch (failure) {
      if (!mounted.current || capturedAuthority !== authorityRef.current)
        return;
      setError(
        failure instanceof Error
          ? failure.message
          : "The Team offer could not be updated."
      );
      if (failure instanceof TeamAgentRequestError && failure.status === 409)
        setGeneration((value) => value + 1);
      else if (
        failure instanceof TeamAgentRequestError &&
        [401, 403].includes(failure.status)
      ) {
        setOffers([]);
        setAgents([]);
        setState("unavailable");
      }
    } finally {
      if (mounted.current && capturedAuthority === authorityRef.current)
        setPendingIds((current) => {
          const next = new Set(current);
          next.delete(agent.id);
          return next;
        });
    }
  };

  return (
    <section
      className="rounded-2xl border border-border/70 bg-surface/20 px-5 py-4"
      aria-labelledby={titleId}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={titleId} className="text-sm font-medium text-foreground">
            {onlyAgentId
              ? (teamName ?? "Team availability")
              : "Make an Agent available"}
          </h2>
          {!onlyAgentId && (
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-faint">
              Choose which of your Agents teammates can ask for help. Only the
              Agent name and this short description are shared with{" "}
              {"this Team"}; your private instructions and Conversations stay
              private.
            </p>
          )}
        </div>
        {visibleState === "loading" && (
          <LoaderCircle
            className="mt-0.5 h-4 w-4 animate-spin text-faint"
            aria-label="Loading Agent offers"
          />
        )}
        {visibleState === "unavailable" && (
          <button
            type="button"
            onClick={retry}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-subtle hover:bg-surface-hover"
          >
            <RotateCw className="h-3 w-3" />
            Retry
          </button>
        )}
      </div>
      {visibleState === "unavailable" && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
      {visibleState === "ready" &&
        (agents.length === 0 ? (
          <p className="mt-3 text-xs text-faint">
            Create an Agent before offering help to this Team.
          </p>
        ) : (
          <div className="mt-4 divide-y divide-border/60">
            {agents.map((agent) => {
              const offer = offersByAgent.get(agent.id);
              const isOwnerOffer = offer?.canManage === true;
              const enabled = Boolean(isOwnerOffer && offer?.enabled);
              const pending = pendingIds.has(agent.id);
              return (
                <div
                  key={agent.id}
                  className={`grid gap-3 py-3 first:pt-0 last:pb-0 ${onlyAgentId ? "" : "sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">
                      {agent.name}{" "}
                      <span className="font-normal text-faint">· you</span>
                    </p>
                    <label className="mt-2 block">
                      <span className="sr-only">
                        Short description for {agent.name}
                      </span>
                      <textarea
                        value={
                          draftDescriptions[agent.id] ??
                          offer?.description ??
                          ""
                        }
                        onChange={(event) =>
                          setDraftDescriptions((current) => ({
                            ...current,
                            [agent.id]: event.target.value
                          }))
                        }
                        rows={2}
                        maxLength={500}
                        placeholder="What teammates can ask this Agent to help with"
                        className="w-full resize-y rounded-lg border border-border bg-background/70 px-3 py-2 text-xs text-foreground placeholder:text-faint focus:border-accent/50 focus:outline-none"
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:pt-0.5">
                    {isOwnerOffer && (
                      <span className="text-[10px] text-faint">
                        {enabled ? "Available to this Team" : "Not shared"}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={pending}
                      aria-pressed={enabled}
                      aria-label={
                        onlyAgentId
                          ? `${enabled ? "Disable" : "Make"} ${agent.name} ${enabled ? "availability for" : "available to"} ${teamName ?? "this Team"}`
                          : undefined
                      }
                      onClick={() => void updateOffer(agent, !enabled)}
                      className={`rounded-md border px-2.5 py-1.5 text-[10px] font-medium disabled:opacity-50 ${enabled ? "border-border text-subtle hover:bg-surface-hover" : "border-accent/30 bg-accent/10 text-accent hover:bg-accent/15"}`}
                    >
                      {pending
                        ? "Saving…"
                        : enabled
                          ? "Disable"
                          : "Share with Team"}
                    </button>
                    {(draftDescriptions[agent.id] ?? "").trim() !==
                      (offer?.description ?? "") && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => void updateOffer(agent, enabled)}
                        className="rounded-md border border-border px-2.5 py-1.5 text-[10px] text-subtle disabled:opacity-50"
                      >
                        Save description
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      {error && visibleState === "ready" && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

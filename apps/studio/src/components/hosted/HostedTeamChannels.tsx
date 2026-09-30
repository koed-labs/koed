"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CollaborationMessage, CollaborationThread } from "@koed/shared/collaboration";
import { ChatComposer } from "@/components/ChatComposer";
import { ChannelHeader } from "@/components/ChannelView";
import { TeamDirectMessageBubble, directMessageTitle } from "@/components/TeamDirectMessage";
import { CreateChannelModal } from "@/components/CreateChannelModal";
import { SidebarProvider } from "@/components/SidebarContext";
import { TeamShell } from "@/components/TeamShell";
import { TeamChannelNavigation } from "@/components/TeamSidebar";
import { PublicSquare } from "@/components/PublicSquare";
import type { HostedTeam, HostedUser } from "@/lib/hosted-session";
import { loadHostedLaunchOptions } from "@/lib/hosted-managed-chats";
import { HostedTeamCollaborationClient, HostedTeamRequestError } from "@/lib/hosted-team-collaboration";
import type { HostedTeamPerson } from "@/lib/hosted-team-collaboration";
import { PublicSquareClient } from "@/lib/public-square-client";
import { usePublicSquare } from "@/lib/use-public-square";
import { createBrowserTeamDraftStore } from "@/lib/browser-team-draft-store";
import { directMessageAttemptKey, directMessageParticipantsAreEligible, mergeTeamMessages, resolvePendingSend, retainPendingSendAfterUncertainOutcome, studioRequestMayApply, studioSelectionMatches, teamDraftForHydration } from "@/lib/team-channel-state";
import type { StudioTeamDraft, StudioTeamDraftAuthority } from "@/lib/studio-collaboration-client";

const makeAuthority = (teamId: string, threadId: string, userId: string): StudioTeamDraftAuthority => ({
  backendId: typeof window === "undefined" ? "" : window.location.origin,
  principalUserId: userId,
  teamId,
  threadId
});

export function HostedTeamChannels({ team, user, allTeams, onAuthorizationLost }: {
  team: HostedTeam;
  user: HostedUser;
  allTeams: HostedTeam[];
  onAuthorizationLost: () => void;
}) {
  const client = useMemo(() => new HostedTeamCollaborationClient(), []);
  const publicSquareClient = useMemo(() => new PublicSquareClient("hosted"), []);
  const drafts = useMemo(() => {
    try { return createBrowserTeamDraftStore(); } catch { return null; }
  }, []);
  const [channels, setChannels] = useState<CollaborationThread[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string; thread: CollaborationThread }>>([]);
  const [people, setPeople] = useState<HostedTeamPerson[]>([]);
  const [directMessages, setDirectMessages] = useState<CollaborationThread[]>([]);
  const [navigationLoadedOwner, setNavigationLoadedOwner] = useState("");
  const [threadId, setThreadId] = useState("");
  const [squareOpen, setSquareOpen] = useState(false);
  const [localProjectsState, setLocalProjectsState] = useState<{ owner: string; loaded: boolean; projects: Array<{ id: string; name: string }> }>({ owner: "", loaded: false, projects: [] });
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [messageSelection, setMessageSelection] = useState<{ teamId: string; threadId: string } | null>(null);
  const [loadedPage, setLoadedPage] = useState<{ teamId: string; threadId: string } | null>(null);
  const [beforeSequence, setBeforeSequence] = useState<number | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [pendingSend, setPendingSend] = useState<StudioTeamDraft["pendingSend"]>(null);
  const [hydrated, setHydrated] = useState(false);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [visibleRead, setVisibleRead] = useState<{ id: string; sequence: number; teamId: string; threadId: string } | null>(null);
  const [readCursor, setReadCursor] = useState(0);
  const messagesRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const revokedRef = useRef(false);
  const navigationGeneration = useRef(0);
  const directMessageRequestIds = useRef(new Map<string, string>());
  const navigationOwner = useRef("");
  const draftByAuthority = useRef(new Map<string, StudioTeamDraft>());
  const selectedThreadRef = useRef(threadId);
  selectedThreadRef.current = threadId;
  const ownerKey = `${user.id}:${team.id}`;
  const localProjectsOwner = `${typeof window === "undefined" ? "" : window.location.origin}:${user.id}`;
  const localProjects = localProjectsState.owner === localProjectsOwner ? localProjectsState.projects : [];
  const loadingLocalProjects = localProjectsState.owner !== localProjectsOwner || !localProjectsState.loaded;
  const navigationReady = navigationLoadedOwner === ownerKey;
  const visibleChannels = useMemo(() => navigationReady ? channels : [], [channels, navigationReady]);
  const visibleProjects = useMemo(() => navigationReady ? projects : [], [navigationReady, projects]);
  const visiblePeople = useMemo(() => navigationReady ? people : [], [navigationReady, people]);
  const visibleDirectMessages = useMemo(() => navigationReady ? directMessages : [], [directMessages, navigationReady]);
  const activeThreads = useMemo(() => [...visibleChannels, ...visibleProjects.map((project) => project.thread), ...visibleDirectMessages], [visibleChannels, visibleDirectMessages, visibleProjects]);
  const activeThread = activeThreads.find((thread) => thread.id === threadId) ?? null;
  const squareProjects = useMemo(() => visibleProjects.map((project) => ({ id: project.id, name: project.name })), [visibleProjects]);
  const square = usePublicSquare({
    client: publicSquareClient,
    scope: { backendId: typeof window === "undefined" ? "" : window.location.origin, principalUserId: user.id, teamId: team.id },
    projects: squareProjects,
    localProjects,
    enabled: navigationReady,
    onAuthorizationLost
  });
  const refreshSquare = square.refresh;
  const messageViewReady = Boolean(navigationReady && activeThread && messageSelection?.teamId === team.id && messageSelection.threadId === activeThread.id);
  const visibleMessages = messageViewReady ? messages : [];
  const visiblePage = messageViewReady && loadedPage?.teamId === team.id && loadedPage.threadId === activeThread?.id;
  const activeDirectMessage = activeThread?.kind === "dm" || activeThread?.kind === "group_dm" ? activeThread : null;
  const activeDirectMessageTitle = activeDirectMessage ? directMessageTitle(activeDirectMessage, user.id) : "";
  const authority = activeThread ? makeAuthority(team.id, activeThread.id, user.id) : null;
  const authorityKey = authority ? JSON.stringify(authority) : null;
  const visibleDraftText = authorityKey && hydratedKey === authorityKey ? draftText : "";
  const visiblePendingSend = authorityKey && hydratedKey === authorityKey ? pendingSend : null;
  if (authorityKey && hydratedKey === authorityKey) draftByAuthority.current.set(authorityKey, { text: draftText, pendingSend });

  const handleAuthorizationLost = useCallback(() => {
    revokedRef.current = true;
    navigationGeneration.current += 1;
    setChannels([]);
    setProjects([]);
    setPeople([]);
    setDirectMessages([]);
    setNavigationLoadedOwner("");
    setThreadId("");
    selectedThreadRef.current = "";
    setMessages([]);
    setMessageSelection(null);
    setLoadedPage(null);
    setBeforeSequence(null);
    setHasOlder(false);
    setDraftText("");
    setPendingSend(null);
    setHydrated(false);
    setHydratedKey(null);
    setVisibleRead(null);
    setError("Team access changed. Refresh to check your access.");
    draftByAuthority.current.clear();
    if (drafts) {
      void drafts.deleteTeam({ backendId: typeof window === "undefined" ? "" : window.location.origin, principalUserId: user.id, teamId: team.id }).catch(() => undefined);
    }
    onAuthorizationLost();
  }, [drafts, onAuthorizationLost, team.id, user.id]);

  const refreshNavigation = useCallback(async () => {
    const generation = ++navigationGeneration.current;
    const ownerKey = `${user.id}:${team.id}`;
    const preserveSelection = navigationOwner.current === ownerKey;
    const priorThreadId = preserveSelection ? selectedThreadRef.current : "";
    if (!preserveSelection) {
      navigationOwner.current = ownerKey;
      setChannels([]);
      setProjects([]);
      setPeople([]);
      setDirectMessages([]);
      setThreadId("");
      selectedThreadRef.current = "";
      setMessages([]);
      setDraftText("");
      setPendingSend(null);
      setHydrated(false);
      setHydratedKey(null);
      setVisibleRead(null);
      draftByAuthority.current.clear();
    }
    setLoading(true);
    try {
      const [nextChannels, nextProjects, nextPeople, nextDirectMessages] = await Promise.all([
        client.listChannels(team.id), client.listProjects(team.id), client.listPeople(team.id), client.listDirectMessages(team.id)
      ]);
      if (!studioRequestMayApply({ capturedGeneration: generation, currentGeneration: navigationGeneration.current, mounted: mountedRef.current })) return;
      revokedRef.current = false;
      setChannels(nextChannels);
      setProjects(nextProjects);
      setPeople(nextPeople);
      setDirectMessages(nextDirectMessages);
      setNavigationLoadedOwner(ownerKey);
      const availableThreads = [...nextChannels, ...nextProjects.map((project) => project.thread), ...nextDirectMessages];
      const initialThreadId = availableThreads.some((thread) => thread.id === priorThreadId)
        ? priorThreadId
        : nextChannels.find((thread) => thread.name === "general")?.id ?? nextChannels[0]?.id ?? nextProjects[0]?.thread.id ?? nextDirectMessages[0]?.id ?? "";
      if (priorThreadId && priorThreadId !== initialThreadId) {
        setMessages([]);
        setMessageSelection(null);
        setLoadedPage(null);
        setBeforeSequence(null);
        setHasOlder(false);
        setDraftText("");
        setPendingSend(null);
        setHydrated(false);
        setHydratedKey(null);
        setVisibleRead(null);
      }
      setThreadId(initialThreadId);
      selectedThreadRef.current = initialThreadId;
      setError(null);
    } catch (failure) {
      if (!studioRequestMayApply({ capturedGeneration: generation, currentGeneration: navigationGeneration.current, mounted: mountedRef.current })) return;
      if (failure instanceof HostedTeamRequestError && [401, 403].includes(failure.status)) handleAuthorizationLost();
      else setError(failure instanceof Error ? failure.message : "Team channels are unavailable.");
    } finally { if (studioRequestMayApply({ capturedGeneration: generation, currentGeneration: navigationGeneration.current, mounted: mountedRef.current })) setLoading(false); }
  }, [client, handleAuthorizationLost, team.id, user.id]);

  const loadPage = useCallback(async (id: string, before: number | null = null, prepend = false) => {
    const ownerKey = `${user.id}:${team.id}`;
    try {
      const page = await client.loadMessages(team.id, id, before, 50);
      if (!mountedRef.current || navigationOwner.current !== ownerKey || selectedThreadRef.current !== id) return;
      setMessages((current) => {
        return mergeTeamMessages(current, page.items);
      });
      setMessageSelection({ teamId: team.id, threadId: id });
      setLoadedPage({ teamId: team.id, threadId: id });
      setHasOlder(page.hasOlder);
      setBeforeSequence(page.nextBeforeSequence);
      setError(null);
    } catch (failure) {
      if (!mountedRef.current || navigationOwner.current !== ownerKey || selectedThreadRef.current !== id) return;
      if (failure instanceof HostedTeamRequestError && [401, 403].includes(failure.status)) handleAuthorizationLost();
      else setError(failure instanceof Error ? failure.message : "Channel history is unavailable.");
    }
  }, [client, handleAuthorizationLost, team.id, user.id]);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; navigationGeneration.current += 1; }; }, []);
  useEffect(() => { void refreshNavigation(); }, [refreshNavigation]);
  useEffect(() => {
    let active = true;
    void loadHostedLaunchOptions().then((options) => {
      if (active) setLocalProjectsState({ owner: localProjectsOwner, loaded: true, projects: options.projects.map((project) => ({ id: project.id, name: project.name })) });
    }).catch(() => {
      if (active) setLocalProjectsState({ owner: localProjectsOwner, loaded: true, projects: [] });
    });
    return () => { active = false; };
  }, [localProjectsOwner]);
  useEffect(() => {
    if (!drafts) return;
    void drafts.retainAuthorizedTeams({ backendId: typeof window === "undefined" ? "" : window.location.origin, principalUserId: user.id, teamIds: allTeams.map((item) => item.id) });
  }, [allTeams, drafts, user.id]);
  useEffect(() => {
    if (!activeThread || !authority || !drafts) { setHydrated(false); return; }
    if (!allTeams.some((item) => item.id === team.id)) {
      setHydrated(false);
      handleAuthorizationLost();
      return;
    }
    let current = true;
    setHydrated(false);
    setHydratedKey(null);
    setMessages([]);
    setMessageSelection(null);
    setLoadedPage(null);
    setBeforeSequence(null);
    setHasOlder(false);
    const authorize = activeThread.kind === "dm" || activeThread.kind === "group_dm"
      ? client.listDirectMessages(team.id).then((threads) => threads.some((thread) => thread.id === activeThread.id && (thread.kind === "dm" || thread.kind === "group_dm")))
      : Promise.resolve(true);
    void authorize.then(async (authorized) => {
      if (!current || revokedRef.current) return null;
      if (!authorized) {
        setMessages([]);
        setDraftText("");
        setPendingSend(null);
        setError("This direct message is no longer available to your account.");
        const fallback = channels.find((thread) => thread.name === "general")?.id ?? channels[0]?.id ?? projects[0]?.thread.id ?? "";
        selectedThreadRef.current = fallback;
        setThreadId(fallback);
        return null;
      }
      void loadPage(activeThread.id);
      await drafts.retainAuthorizedTeams({ backendId: authority.backendId, principalUserId: user.id, teamIds: allTeams.map((item) => item.id) });
      return { stored: await drafts.load(authority) };
    }).then((stored) => {
      if (!stored) return;
      if (!current || revokedRef.current) return;
      const draft = teamDraftForHydration(stored.stored);
      draftByAuthority.current.set(JSON.stringify(authority), draft);
      setDraftText(draft.text);
      setPendingSend(draft.pendingSend);
      setHydrated(true);
      setHydratedKey(JSON.stringify(authority));
    }).catch((failure: unknown) => {
      if (!current || revokedRef.current) return;
      if (failure instanceof HostedTeamRequestError && [401, 403].includes(failure.status)) handleAuthorizationLost();
      else setError(activeThread.kind === "dm" || activeThread.kind === "group_dm"
        ? "Direct message access could not be checked. Try again."
        : "Encrypted draft recovery is unavailable in this browser.");
    });
    return () => { current = false; };
  }, [activeThread?.id, activeThread?.kind, allTeams, authority?.backendId, authority?.principalUserId, authority?.teamId, channels, client, drafts, handleAuthorizationLost, loadPage, projects, team.id, user.id]);
  useEffect(() => {
    if (!drafts || !authority || !hydrated || hydratedKey !== authorityKey) return;
    const value: StudioTeamDraft = { text: draftText, pendingSend, updatedAt: new Date().toISOString() };
    const persist = () => revokedRef.current ? Promise.resolve() : drafts.save(authority, value);
    const timer = window.setTimeout(() => void persist().catch(() => setError("Draft could not be encrypted and saved.")), 200);
    return () => { window.clearTimeout(timer); void persist().catch(() => undefined); };
  }, [authority?.backendId, authority?.principalUserId, authority?.teamId, authority?.threadId, draftText, drafts, hydrated, hydratedKey, pendingSend]);
  useEffect(() => { setReadCursor(0); setVisibleRead(null); }, [team.id, threadId]);
  useEffect(() => {
    const unsubscribe = client.subscribeTeam(team.id, async (event) => {
      const resource = event.resource;
      const currentThreadId = selectedThreadRef.current;
      const update = event.update;
      if (update && typeof update === "object" && "type" in update && update.type === "public_square_invalidated") {
        if ("teamId" in update && update.teamId === team.id) {
          await refreshSquare();
        }
      }
      if (resource && typeof resource === "object" && "threadId" in resource && resource.threadId === currentThreadId) await loadPage(currentThreadId);
      await refreshNavigation();
    }, handleAuthorizationLost);
    return unsubscribe;
  }, [client, handleAuthorizationLost, loadPage, refreshNavigation, refreshSquare, team.id]);
  useEffect(() => {
    if (!navigationReady || !activeThread || !visibleRead || visibleRead.teamId !== team.id || visibleRead.threadId !== activeThread.id || !document.hasFocus() || document.visibilityState !== "visible" || visibleRead.sequence <= readCursor || visibleRead.sequence <= 0) return;
    const capturedOwnerKey = `${user.id}:${team.id}`;
    const capturedThreadId = activeThread.id;
    void client.markRead(team.id, capturedThreadId, visibleRead.id).then(() => {
      if (navigationOwner.current === capturedOwnerKey && selectedThreadRef.current === capturedThreadId) setReadCursor(visibleRead.sequence);
    }).catch(() => undefined);
  }, [activeThread, client, navigationReady, readCursor, team.id, user.id, visibleRead]);

  const send = async (body: string) => {
    if (!activeThread || !authority || !drafts || !hydrated) return;
    if (pendingSend) { setError("Resolve the earlier send before sending edited text."); return; }
    const capturedAuthority = authority;
    const capturedKey = authorityKey;
    const capturedTeamId = team.id;
    const capturedOwnerKey = `${user.id}:${team.id}`;
    const capturedThreadId = activeThread.id;
    if (!capturedKey) return;
    const identity = { clientMessageId: crypto.randomUUID(), body, createdAt: new Date().toISOString() };
    draftByAuthority.current.set(capturedKey, { text: "", pendingSend: identity });
    setPendingSend(identity);
    setDraftText("");
    let requestStarted = false;
    try {
      await drafts.save(capturedAuthority, { text: "", pendingSend: identity });
      if (revokedRef.current || !mountedRef.current || navigationOwner.current !== capturedOwnerKey) return;
      requestStarted = true;
      const message = await client.sendMessage(capturedTeamId, capturedThreadId, identity.body, identity.clientMessageId);
      if (revokedRef.current || !mountedRef.current || navigationOwner.current !== capturedOwnerKey) return;
      const currentlySelected = navigationOwner.current === capturedOwnerKey && studioSelectionMatches({ teamId: capturedTeamId, threadId: capturedThreadId }, { teamId: team.id, threadId: selectedThreadRef.current });
      if (currentlySelected) setMessages((current) => [...current.filter((item) => item.id !== message.id), message].slice(-250));
      const latest = draftByAuthority.current.get(capturedKey) ?? { text: "", pendingSend: identity };
      const settled = resolvePendingSend(latest, identity.clientMessageId, "accepted", identity.body);
      draftByAuthority.current.set(capturedKey, settled);
      try { await drafts.save(capturedAuthority, settled); }
      catch {
        if (currentlySelected && authorityKey === capturedKey) setError("Message sent. The edited draft update could not be saved in this browser.");
        return;
      }
      if (currentlySelected && authorityKey === capturedKey) {
        setPendingSend(settled.pendingSend);
        setDraftText(settled.text);
        setError(null);
      }
    } catch (failure) {
      if (!mountedRef.current || revokedRef.current || navigationOwner.current !== capturedOwnerKey) return;
      const latest = draftByAuthority.current.get(capturedKey) ?? { text: "", pendingSend: identity };
      const definitiveRejection = failure instanceof HostedTeamRequestError && [400, 404, 422].includes(failure.status);
      const settled = requestStarted && !definitiveRejection
        ? retainPendingSendAfterUncertainOutcome(latest, identity)
        : resolvePendingSend(latest, identity.clientMessageId, "not-sent", body);
      draftByAuthority.current.set(capturedKey, settled);
      await drafts.save(capturedAuthority, settled).catch(() => undefined);
      if (navigationOwner.current === capturedOwnerKey && studioSelectionMatches({ teamId: capturedTeamId, threadId: capturedThreadId }, { teamId: team.id, threadId: selectedThreadRef.current }) && authorityKey === capturedKey) {
        setPendingSend(settled.pendingSend);
        setDraftText(settled.text);
      }
      if (failure instanceof HostedTeamRequestError && [401, 403].includes(failure.status)) handleAuthorizationLost();
      else if (studioSelectionMatches({ teamId: capturedTeamId, threadId: capturedThreadId }, { teamId: team.id, threadId: selectedThreadRef.current }) && authorityKey === capturedKey) setError(requestStarted ? "Send status is unknown. Retry the original send identity before sending another message." : "Not sent. The draft is saved on this device; retry after reconnecting.");
    }
  };

  const reconcile = async () => {
    if (!pendingSend || !activeThread || !authority || !drafts) return;
    const pending = pendingSend;
    const capturedAuthority = authority;
    const capturedKey = authorityKey;
    const capturedThreadId = activeThread.id;
    const capturedOwnerKey = `${user.id}:${team.id}`;
    try {
      const message = await client.sendMessage(team.id, capturedThreadId, pending.body, pending.clientMessageId);
      if (revokedRef.current || !mountedRef.current || navigationOwner.current !== capturedOwnerKey) return;
      const currentlySelected = navigationOwner.current === capturedOwnerKey && studioSelectionMatches({ teamId: team.id, threadId: capturedThreadId }, { teamId: team.id, threadId: selectedThreadRef.current });
      if (currentlySelected) setMessages((current) => [...current.filter((item) => item.id !== message.id), message].slice(-250));
      const latest = draftByAuthority.current.get(capturedKey!) ?? { text: draftText, pendingSend: pending };
      const settled = resolvePendingSend(latest, pending.clientMessageId, "accepted", pending.body);
      draftByAuthority.current.set(capturedKey!, settled);
      try { await drafts.save(capturedAuthority, settled); }
      catch {
        if (currentlySelected && authorityKey === capturedKey) setError("Message sent. The edited draft update could not be saved in this browser.");
        return;
      }
      if (currentlySelected && authorityKey === capturedKey) {
        setPendingSend(settled.pendingSend);
        setDraftText(settled.text);
        setError(null);
      }
    } catch (failure) {
      if (!mountedRef.current || revokedRef.current || navigationOwner.current !== capturedOwnerKey) return;
      if (failure instanceof HostedTeamRequestError && [401, 403].includes(failure.status)) handleAuthorizationLost();
      else if (studioSelectionMatches({ teamId: team.id, threadId: capturedThreadId }, { teamId: team.id, threadId: selectedThreadRef.current }) && authorityKey === capturedKey) setError("Send status is still unknown. Keep the original send identity and try again.");
    }
  };

  const createChannel = async (name: string) => {
    const generation = navigationGeneration.current;
    try {
      const thread = await client.createChannel(team.id, name, null, crypto.randomUUID());
      if (!studioRequestMayApply({ capturedGeneration: generation, currentGeneration: navigationGeneration.current, mounted: mountedRef.current })) return;
      setChannels((current) => [...current.filter((item) => item.id !== thread.id), thread]);
      setThreadId(thread.id);
      setCreateOpen(false);
    } catch (failure) {
      if (!studioRequestMayApply({ capturedGeneration: generation, currentGeneration: navigationGeneration.current, mounted: mountedRef.current })) return;
      if (failure instanceof HostedTeamRequestError && [401, 403].includes(failure.status)) { handleAuthorizationLost(); return; }
      setError(failure instanceof Error ? failure.message : "Channel creation failed.");
    }
  };

  const startDirectMessage = async (participantUserIds: string[]) => {
    const generation = navigationGeneration.current;
    const ownerKey = `${user.id}:${team.id}`;
    const enabledMemberIds = new Set(people.filter((person) => person.membershipState === "enabled").map((person) => person.id));
    const participants = participantUserIds.slice().sort();
    if (!directMessageParticipantsAreEligible({ principalUserId: user.id, participantUserIds: participants, enabledMemberIds })) throw new Error("Choose an enabled teammate to message.");
    const requestKey = directMessageAttemptKey(team.id, user.id, participants);
    const requestId = directMessageRequestIds.current.get(requestKey) ?? crypto.randomUUID();
    directMessageRequestIds.current.set(requestKey, requestId);
    try {
      const thread = participants.length === 1
        ? await client.startDirectMessage(team.id, participants[0], requestId)
        : await client.startGroupDirectMessage(team.id, participants, requestId);
      if (!studioRequestMayApply({ capturedGeneration: generation, currentGeneration: navigationGeneration.current, mounted: mountedRef.current }) || ownerKey !== `${user.id}:${team.id}` || revokedRef.current) return;
      directMessageRequestIds.current.delete(requestKey);
      setDirectMessages((current) => [...current.filter((item) => item.id !== thread.id), thread]);
      setThreadId(thread.id);
      selectedThreadRef.current = thread.id;
      setError(null);
    } catch (failure) {
      if (failure instanceof HostedTeamRequestError && [400, 404, 422].includes(failure.status)) directMessageRequestIds.current.delete(requestKey);
      if (failure instanceof HostedTeamRequestError && [401, 403].includes(failure.status)) handleAuthorizationLost();
      throw failure;
    }
  };
  const updateDraft = (value: string) => {
    if (authorityKey && hydratedKey === authorityKey) draftByAuthority.current.set(authorityKey, { text: value, pendingSend });
    setDraftText(value);
  };

  return <div className="flex h-full min-h-0 min-w-0 flex-1 bg-background">
    <SidebarProvider>
      <TeamChannelNavigation teamName={team.name} channels={activeThreads.filter((thread) => thread.kind !== "dm" && thread.kind !== "group_dm").map((thread) => ({ id: thread.id, name: thread.name }))} people={visiblePeople.map((person) => ({ id: person.id, name: person.displayName }))} principalUserId={user.id} directMessages={visibleDirectMessages.filter((thread): thread is Extract<CollaborationThread, { kind: "dm" | "group_dm" }> => thread.kind === "dm" || thread.kind === "group_dm")} selectedId={squareOpen ? "public-square" : threadId} squareSelected={squareOpen} onOpenSquare={() => setSquareOpen(true)} onSelect={(id) => { setSquareOpen(false); setThreadId(id); }} onCreate={() => { setSquareOpen(false); setCreateOpen(true); }} onNewDirectMessage={(participantIds) => { setSquareOpen(false); return startDirectMessage(participantIds); }} />
      <div className="relative min-h-0 min-w-0 flex-1">
      <TeamShell
        heading={squareOpen ? "Public Square" : undefined}
        wallpaper={!squareOpen && !activeDirectMessage}
        crumbs={!squareOpen && activeDirectMessage ? [team.name, activeDirectMessageTitle] : undefined}
        subheader={!squareOpen && !activeDirectMessage ? <ChannelHeader channelName={activeThread?.name ?? "Select a channel"} project={null} agents={[]} members={people.filter((person) => person.membershipState === "enabled").map((person) => ({ id: person.id, name: person.displayName }))} /> : undefined}
        footer={!squareOpen && <footer className="border-t border-border bg-background p-4"><div className="mx-auto max-w-3xl"><div className="no-drag">{visiblePendingSend && <div className="mb-2 flex items-center justify-between rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted"><span>Previous send may have been accepted. Reconcile before retrying.</span><button type="button" onClick={() => void reconcile()} className="font-medium text-foreground hover:underline">Reconcile send</button></div>}<ChatComposer placeholder={activeDirectMessage ? `Message ${activeDirectMessageTitle}` : `Message #${activeThread?.name ?? "channel"}`} projectName={activeDirectMessage ? team.name : activeThread?.name ?? team.name} branch="shared" value={visibleDraftText} onChange={updateDraft} onSend={(text) => send(text)} showExecutionControls={false} showMetaBar={false} showFormattingToolbar sendEnabled={Boolean(activeThread && drafts && hydrated && hydratedKey === authorityKey)} footer={visiblePendingSend ? "Resolve the previous send before sending this edit." : activeDirectMessage ? "Direct messages stay among these people." : "Message everyone in this channel."} /></div></div></footer>}
      >
        {squareOpen ? <PublicSquare
          key={`${user.id}:${team.id}`}
          teamName={team.name}
          items={square.items}
          projects={square.projects}
          localProjects={square.localProjects}
          loadingLocalProjects={loadingLocalProjects}
          ownerBriefDrafts={square.ownerBriefDrafts}
          connections={square.connections}
          state={square.state}
          error={square.error}
          serverTime={square.serverTime}
          hasMore={Boolean(square.nextCursor)}
          loadingMore={square.loadingMore}
          onRetry={() => { void square.refresh(); }}
          onLoadMore={() => { void square.loadMore(); }}
          onShareBrief={(id, brief, version) => square.setBrief(id, brief, version)}
          onWithdrawBrief={(id, version) => square.setBrief(id, null, version)}
          onRemoveRetainedBrief={(id, version) => square.setBrief(id, null, version)}
          onRequestBriefDraft={square.loadBriefDraft}
          onConnectProject={square.connectProject}
          canUnshareProjects={team.membership.role === "owner" || team.membership.role === "admin"}
          onUnshareProject={square.unshareProject}
        /> : <>
        <div ref={messagesRef} className={`mx-auto max-w-3xl pt-4 ${activeDirectMessage ? "space-y-4" : "space-y-3"}`}>
          {visiblePage && hasOlder && beforeSequence && <button type="button" onClick={() => activeThread && void loadPage(activeThread.id, beforeSequence, true)} className="mx-auto block text-xs text-muted hover:text-foreground">Load older messages</button>}
          {visibleMessages.length === 0 && <p className="text-sm text-subtle">{activeDirectMessage ? `Private to ${activeDirectMessageTitle}. Agents are not in this thread.` : "No messages yet. Start the conversation."}</p>}
          {visibleMessages.map((message) => <HostedMessage key={message.id} message={message} directMessagePrincipalUserId={activeDirectMessage ? user.id : undefined} onVisible={() => {
            if (message.sender.id !== user.id && activeThread?.id === message.threadId && selectedThreadRef.current === message.threadId && message.teamId === team.id && document.visibilityState === "visible" && document.hasFocus()) {
              setVisibleRead((current) => !current || message.sequence > current.sequence ? { id: message.id, sequence: message.sequence, teamId: team.id, threadId: message.threadId } : current);
            }
          }} />)}
        </div>
        {error && <p role="status" className="mx-auto w-full max-w-3xl pt-2 text-xs text-warning">{error}</p>}
        </>}
      </TeamShell>
      </div>
    </SidebarProvider>
    {createOpen && <CreateChannelModal teamName={team.name} existingNames={activeThreads.map((item) => item.name?.toLowerCase() ?? "")} onClose={() => setCreateOpen(false)} onCreateChat={(name) => void createChannel(name)} projectDisabledReason="Choose a local folder in the Koed Studio desktop app to create a Shared Project channel." />}
  </div>;
}

function HostedMessage({ message, onVisible, directMessagePrincipalUserId }: { message: CollaborationMessage; onVisible: () => void; directMessagePrincipalUserId?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && document.visibilityState === "visible" && document.hasFocus()) onVisible();
    }, { threshold: 0.6 });
    observer.observe(element);
    const focused = () => {
      const bounds = element.getBoundingClientRect();
      if (document.visibilityState === "visible" && document.hasFocus() && bounds.bottom > 0 && bounds.top < window.innerHeight) onVisible();
    };
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", focused);
    return () => { observer.disconnect(); window.removeEventListener("focus", focused); document.removeEventListener("visibilitychange", focused); };
  }, [onVisible]);
  const isDirectMessage = directMessagePrincipalUserId !== undefined;
  const isYou = isDirectMessage && message.sender.id === directMessagePrincipalUserId;
  return <article ref={ref} className={isDirectMessage ? isYou ? "flex justify-end" : "flex justify-start" : "flex gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover/30"}>{isDirectMessage
    ? <TeamDirectMessageBubble message={message} principalUserId={directMessagePrincipalUserId ?? ""} />
    : <><div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-xs font-semibold">{message.sender.displayName.slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-baseline gap-2"><span className="text-sm font-medium">{message.sender.displayName}</span><time className="text-[10px] text-subtle">{new Date(message.createdAt).toLocaleString()}</time></div><p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground-secondary">{message.body}</p></div></>}</article>;
}

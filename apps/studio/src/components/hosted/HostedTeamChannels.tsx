"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CollaborationMessage, CollaborationThread } from "@koed/shared/collaboration";
import { ChatComposer } from "@/components/ChatComposer";
import { ChannelHeader } from "@/components/ChannelView";
import { CreateChannelModal } from "@/components/CreateChannelModal";
import { SidebarProvider } from "@/components/SidebarContext";
import { TeamShell } from "@/components/TeamShell";
import { TeamChannelNavigation } from "@/components/TeamSidebar";
import type { HostedTeam, HostedUser } from "@/lib/hosted-session";
import { HostedTeamCollaborationClient, HostedTeamRequestError } from "@/lib/hosted-team-collaboration";
import { createBrowserTeamDraftStore } from "@/lib/browser-team-draft-store";
import { mergeTeamMessages, resolvePendingSend, retainPendingSendAfterUncertainOutcome, studioRequestMayApply, studioSelectionMatches } from "@/lib/team-channel-state";
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
  const drafts = useMemo(() => {
    try { return createBrowserTeamDraftStore(); } catch { return null; }
  }, []);
  const [channels, setChannels] = useState<CollaborationThread[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string; thread: CollaborationThread }>>([]);
  const [threadId, setThreadId] = useState("");
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [beforeSequence, setBeforeSequence] = useState<number | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [pendingSend, setPendingSend] = useState<StudioTeamDraft["pendingSend"]>(null);
  const [hydrated, setHydrated] = useState(false);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [visibleRead, setVisibleRead] = useState<{ id: string; sequence: number } | null>(null);
  const [readCursor, setReadCursor] = useState(0);
  const messagesRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const revokedRef = useRef(false);
  const navigationGeneration = useRef(0);
  const draftByAuthority = useRef(new Map<string, StudioTeamDraft>());
  const selectedThreadRef = useRef(threadId);
  selectedThreadRef.current = threadId;
  const activeThreads = useMemo(() => [...channels, ...projects.map((project) => project.thread)], [channels, projects]);
  const activeThread = activeThreads.find((thread) => thread.id === threadId) ?? null;
  const authority = activeThread ? makeAuthority(team.id, activeThread.id, user.id) : null;
  const authorityKey = authority ? JSON.stringify(authority) : null;
  if (authorityKey && hydratedKey === authorityKey) draftByAuthority.current.set(authorityKey, { text: draftText, pendingSend });

  const handleAuthorizationLost = useCallback(() => {
    revokedRef.current = true;
    navigationGeneration.current += 1;
    setChannels([]);
    setProjects([]);
    setThreadId("");
    selectedThreadRef.current = "";
    setMessages([]);
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
    setLoading(true);
    try {
      const [nextChannels, nextProjects] = await Promise.all([client.listChannels(team.id), client.listProjects(team.id)]);
      if (!studioRequestMayApply({ capturedGeneration: generation, currentGeneration: navigationGeneration.current, mounted: mountedRef.current })) return;
      revokedRef.current = false;
      setChannels(nextChannels);
      setProjects(nextProjects);
      setThreadId((current) => current && [...nextChannels, ...nextProjects.map((project) => project.thread)].some((thread) => thread.id === current)
        ? current
        : nextChannels.find((thread) => thread.name === "general")?.id ?? nextChannels[0]?.id ?? nextProjects[0]?.thread.id ?? "");
      setError(null);
    } catch (failure) {
      if (!studioRequestMayApply({ capturedGeneration: generation, currentGeneration: navigationGeneration.current, mounted: mountedRef.current })) return;
      if (failure instanceof HostedTeamRequestError && [401, 403].includes(failure.status)) handleAuthorizationLost();
      else setError(failure instanceof Error ? failure.message : "Team channels are unavailable.");
    } finally { if (studioRequestMayApply({ capturedGeneration: generation, currentGeneration: navigationGeneration.current, mounted: mountedRef.current })) setLoading(false); }
  }, [client, handleAuthorizationLost, team.id]);

  const loadPage = useCallback(async (id: string, before: number | null = null, prepend = false) => {
    try {
      const page = await client.loadMessages(team.id, id, before, 50);
      if (!mountedRef.current || selectedThreadRef.current !== id) return;
      setMessages((current) => {
        return mergeTeamMessages(current, page.items);
      });
      setHasOlder(page.hasOlder);
      setBeforeSequence(page.nextBeforeSequence);
      setError(null);
    } catch (failure) {
      if (!mountedRef.current || selectedThreadRef.current !== id) return;
      if (failure instanceof HostedTeamRequestError && [401, 403].includes(failure.status)) handleAuthorizationLost();
      else setError(failure instanceof Error ? failure.message : "Channel history is unavailable.");
    }
  }, [client, handleAuthorizationLost, team.id]);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; navigationGeneration.current += 1; }; }, []);
  useEffect(() => { void refreshNavigation(); }, [refreshNavigation]);
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
    setBeforeSequence(null);
    setHasOlder(false);
    void drafts.retainAuthorizedTeams({ backendId: authority.backendId, principalUserId: user.id, teamIds: allTeams.map((item) => item.id) }).then(() => drafts.load(authority)).then((stored) => {
      if (!current || revokedRef.current) return;
      draftByAuthority.current.set(JSON.stringify(authority), { text: stored?.text ?? "", pendingSend: stored?.pendingSend ?? null });
      setDraftText(stored?.text ?? "");
      setPendingSend(stored?.pendingSend ?? null);
      setHydrated(true);
      setHydratedKey(JSON.stringify(authority));
    }).catch(() => {
      if (current) setError("Encrypted draft recovery is unavailable in this browser.");
    });
    void loadPage(activeThread.id);
    return () => { current = false; };
  }, [activeThread?.id, allTeams, authority?.backendId, authority?.principalUserId, authority?.teamId, drafts, handleAuthorizationLost, loadPage, team.id, user.id]);
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
      if (resource && typeof resource === "object" && "threadId" in resource && resource.threadId === currentThreadId) await loadPage(currentThreadId);
      await refreshNavigation();
    }, handleAuthorizationLost);
    return unsubscribe;
  }, [client, handleAuthorizationLost, loadPage, refreshNavigation, team.id]);
  useEffect(() => {
    if (!activeThread || !visibleRead || !document.hasFocus() || document.visibilityState !== "visible" || visibleRead.sequence <= readCursor || visibleRead.sequence <= 0) return;
    void client.markRead(team.id, activeThread.id, visibleRead.id).then(() => setReadCursor(visibleRead.sequence)).catch(() => undefined);
  }, [activeThread, client, readCursor, team.id, visibleRead]);

  const send = async (body: string) => {
    if (!activeThread || !authority || !drafts || !hydrated) return;
    if (pendingSend) { setError("Resolve the earlier send before sending edited text."); return; }
    const capturedAuthority = authority;
    const capturedKey = authorityKey;
    const capturedTeamId = team.id;
    const capturedThreadId = activeThread.id;
    if (!capturedKey) return;
    const identity = { clientMessageId: crypto.randomUUID(), body, createdAt: new Date().toISOString() };
    draftByAuthority.current.set(capturedKey, { text: "", pendingSend: identity });
    setPendingSend(identity);
    setDraftText("");
    let requestStarted = false;
    try {
      await drafts.save(capturedAuthority, { text: "", pendingSend: identity });
      if (revokedRef.current || !mountedRef.current) return;
      requestStarted = true;
      const message = await client.sendMessage(capturedTeamId, capturedThreadId, identity.body, identity.clientMessageId);
      if (revokedRef.current || !mountedRef.current) return;
      const currentlySelected = studioSelectionMatches({ teamId: capturedTeamId, threadId: capturedThreadId }, { teamId: team.id, threadId: selectedThreadRef.current });
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
      if (!mountedRef.current || revokedRef.current) return;
      const latest = draftByAuthority.current.get(capturedKey) ?? { text: "", pendingSend: identity };
      const definitiveRejection = failure instanceof HostedTeamRequestError && [400, 404, 422].includes(failure.status);
      const settled = requestStarted && !definitiveRejection
        ? retainPendingSendAfterUncertainOutcome(latest, identity)
        : resolvePendingSend(latest, identity.clientMessageId, "not-sent", body);
      draftByAuthority.current.set(capturedKey, settled);
      await drafts.save(capturedAuthority, settled).catch(() => undefined);
      if (studioSelectionMatches({ teamId: capturedTeamId, threadId: capturedThreadId }, { teamId: team.id, threadId: selectedThreadRef.current }) && authorityKey === capturedKey) {
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
    try {
      const message = await client.sendMessage(team.id, capturedThreadId, pending.body, pending.clientMessageId);
      if (revokedRef.current || !mountedRef.current) return;
      const currentlySelected = studioSelectionMatches({ teamId: team.id, threadId: capturedThreadId }, { teamId: team.id, threadId: selectedThreadRef.current });
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
      if (!mountedRef.current || revokedRef.current) return;
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
  const updateDraft = (value: string) => {
    if (authorityKey && hydratedKey === authorityKey) draftByAuthority.current.set(authorityKey, { text: value, pendingSend });
    setDraftText(value);
  };

  return <div className="flex h-full min-h-0 min-w-0 flex-1 bg-background">
    <SidebarProvider>
      <TeamChannelNavigation teamName={team.name} channels={activeThreads.map((thread) => ({ id: thread.id, name: thread.name }))} people={team.members.map((member) => ({ id: member.id, name: member.name ?? "Team member" }))} selectedId={threadId} onSelect={setThreadId} onCreate={() => setCreateOpen(true)} />
      <div className="relative flex min-h-0 min-w-0 flex-1">
      <TeamShell
        wallpaper
        subheader={<ChannelHeader channelName={activeThread?.name ?? "Select a channel"} project={null} agents={[]} members={team.members.map((member) => ({ id: member.id, name: member.name ?? "Team member" }))} />}
        footer={<footer className="border-t border-border bg-background p-4"><div className="mx-auto max-w-3xl">{pendingSend && <div className="mb-2 flex items-center justify-between rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted"><span>Previous send may have been accepted. Reconcile before retrying.</span><button type="button" onClick={() => void reconcile()} className="font-medium text-foreground hover:underline">Reconcile send</button></div>}<ChatComposer placeholder={`Message #${activeThread?.name ?? "channel"}`} projectName={activeThread?.name ?? team.name} branch="shared" value={draftText} onChange={updateDraft} onSend={(text) => send(text)} showExecutionControls={false} showMetaBar={false} showFormattingToolbar sendEnabled={Boolean(activeThread && drafts && hydrated && hydratedKey === authorityKey)} footer={pendingSend ? "Resolve the previous send before sending this edit." : "Message everyone in this channel."} /></div></footer>}
      >
        <div ref={messagesRef} className="mx-auto max-w-3xl space-y-3">{hasOlder && beforeSequence && <button type="button" onClick={() => activeThread && void loadPage(activeThread.id, beforeSequence, true)} className="mx-auto block text-xs text-muted hover:text-foreground">Load older messages</button>}{messages.length === 0 && <p className="pt-8 text-sm text-subtle">No messages yet. Start the conversation.</p>}{messages.map((message) => <HostedMessage key={message.id} message={message} onVisible={() => {
        if (message.sender.id !== user.id) setVisibleRead((current) => !current || message.sequence > current.sequence ? { id: message.id, sequence: message.sequence } : current);
      }} />)}</div>
        {error && <p role="status" className="mx-auto w-full max-w-3xl pt-2 text-xs text-warning">{error}</p>}
      </TeamShell>
      </div>
    </SidebarProvider>
    {createOpen && <CreateChannelModal teamName={team.name} existingNames={activeThreads.map((item) => item.name?.toLowerCase() ?? "")} onClose={() => setCreateOpen(false)} onCreateChat={(name) => void createChannel(name)} projectDisabledReason="Choose a local folder in the Koed Studio desktop app to create a Shared Project channel." />}
  </div>;
}

function HostedMessage({ message, onVisible }: { message: CollaborationMessage; onVisible: () => void }) {
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
  return <article ref={ref} className="flex gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover/30"><div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-xs font-semibold">{message.sender.displayName.slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-baseline gap-2"><span className="text-sm font-medium">{message.sender.displayName}</span><time className="text-[10px] text-subtle">{new Date(message.createdAt).toLocaleString()}</time></div><p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground-secondary">{message.body}</p></div></article>;
}

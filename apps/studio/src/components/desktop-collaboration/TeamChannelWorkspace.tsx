"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Settings, User } from "lucide-react";
import {
  collaborationMessagePageSchema,
  type CollaborationMessage,
  type CollaborationMessagePage,
  type CollaborationRendererCommand,
  type CollaborationSnapshot,
  type CollaborationThread
} from "@koed/shared/collaboration";
import { ChatComposer } from "@/components/ChatComposer";
import { CreateChannelModal } from "@/components/CreateChannelModal";
import { CreateProjectModal } from "@/components/CreateProjectModal";
import { ChannelHeader } from "@/components/ChannelView";
import { TeamShell } from "@/components/TeamShell";
import { TeamChannelNavigation } from "@/components/TeamSidebar";
import { SidebarProvider } from "@/components/SidebarContext";
import type { StudioTeamDraft, StudioTeamDraftAuthority } from "@/lib/studio-collaboration-client";
import { StudioCollaborationClient } from "@/lib/studio-collaboration-client";
import { mayPersistTeamDraft, mergeTeamMessages, resolvePendingSend, retainPendingSendAfterUncertainOutcome, studioSelectionMatches, visibleReadMayAdvance } from "@/lib/team-channel-state";
import { chooseLocalProjectFolder, registerLocalProject } from "@/lib/local-projects";

type DraftAuthority = StudioTeamDraftAuthority;
type DraftStore = {
  loadDraft(authority: DraftAuthority): Promise<StudioTeamDraft | null>;
  saveDraft(authority: DraftAuthority, draft: StudioTeamDraft): Promise<void>;
  deleteDraft(authority: DraftAuthority): Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const teamChannels = (snapshot: CollaborationSnapshot, teamId: string) =>
  snapshot.navigation.teams.find((team) => team.id === teamId)?.channels ?? [];
const projectChannels = (snapshot: CollaborationSnapshot, teamId: string) =>
  snapshot.navigation.teams.find((team) => team.id === teamId)?.sharedProjects ?? [];

export function TeamChannelWorkspace({
  snapshot: initialSnapshot,
  client,
  drafts,
  onRefresh
}: {
  snapshot: CollaborationSnapshot;
  client: StudioCollaborationClient;
  drafts: DraftStore;
  onRefresh: () => void;
}) {
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(initialSnapshot);
  const [teamId, setTeamId] = useState(initialSnapshot.navigation.teams[0]?.id ?? "");
  const [threadId, setThreadId] = useState(() => {
    const team = initialSnapshot.navigation.teams[0];
    return team?.channels.find((thread) => thread.name === "general")?.id ?? team?.channels[0]?.id ?? team?.sharedProjects[0]?.thread.id ?? "";
  });
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [page, setPage] = useState<CollaborationMessagePage | null>(null);
  const [draftText, setDraftText] = useState("");
  const [pendingSend, setPendingSend] = useState<StudioTeamDraft["pendingSend"]>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [hydratedAuthorityKey, setHydratedAuthorityKey] = useState<string | null>(null);
  const [visibleRead, setVisibleRead] = useState<{ id: string; sequence: number; senderId: string } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const saveSequence = useRef(0);
  const snapshotEpoch = useRef(0);
  const revokedRef = useRef(false);
  const draftByAuthority = useRef(new Map<string, StudioTeamDraft>());
  const projectRequestIds = useRef(new Map<string, { requestId: string; name: string }>());
  const localProjectRegistrations = useRef(new Map<string, Promise<{ id: string; name: string; lastSeenAt: string | null }>>());
  const activeTeam = snapshot?.navigation.teams.find((team) => team.id === teamId) ?? null;
  const threads = useMemo(() => [
    ...(snapshot ? teamChannels(snapshot, teamId) : []),
    ...(snapshot ? projectChannels(snapshot, teamId).map((project) => project.thread) : [])
  ], [snapshot, teamId]);
  const activeThread = threads.find((thread) => thread.id === threadId) ?? null;
  const authority: DraftAuthority | null = snapshot && snapshot.navigation.teamPrincipal && snapshot.connection.backendId && teamId && threadId
    ? { backendId: snapshot.connection.backendId, principalUserId: snapshot.navigation.teamPrincipal.id, teamId, threadId }
    : null;
  const authorityKey = authority ? JSON.stringify(authority) : null;
  if (!revokedRef.current && authorityKey && authorityKey === hydratedAuthorityKey) {
    draftByAuthority.current.set(authorityKey, { text: draftText, pendingSend });
  }
  const selectedRef = useRef({ teamId, threadId });
  selectedRef.current = { teamId, threadId };

  const run = useCallback(async (
    command: CollaborationRendererCommand["command"],
    input: Record<string, unknown>,
    requestId?: string
  ) => client.run(command, input, requestId), [client]);

  const clearRevokedView = useCallback(() => {
    revokedRef.current = true;
    snapshotEpoch.current += 1;
    selectedRef.current = { teamId: "", threadId: "" };
    setSnapshot(null);
    setTeamId("");
    setThreadId("");
    setMessages([]);
    setPage(null);
    setDraftText("");
    setPendingSend(null);
    setHydratedAuthorityKey(null);
    setVisibleRead(null);
    setStatus("Team access changed. Refresh to check your access.");
    setCreateChannelOpen(false);
    setCreateProjectOpen(false);
    draftByAuthority.current.clear();
  }, []);
  const refreshSnapshot = useCallback(async () => {
    const epoch = snapshotEpoch.current;
    const result = await run("collaboration.load", { forceRemoteNavigation: true });
    if (epoch !== snapshotEpoch.current) return;
    if (result.ok && "snapshot" in result.data) {
      revokedRef.current = false;
      setSnapshot(result.data.snapshot);
    } else if (!result.ok && result.error.code === "access_revoked") clearRevokedView();
  }, [clearRevokedView, run]);
  const refreshSnapshotRef = useRef(refreshSnapshot);
  refreshSnapshotRef.current = refreshSnapshot;

  const loadPage = useCallback(async (id: string, selectedTeamId: string, cursor: string | null = null) => {
    if (!UUID.test(id) || !UUID.test(selectedTeamId)) return;
    setLoading(true);
    const result = await run("collaboration.load_message_page", {
      thread: { scope: "team", teamId: selectedTeamId, threadId: id },
      direction: cursor === null ? "newer" : "older",
      cursor,
      limit: 50
    });
    const stillSelected = selectedRef.current.teamId === selectedTeamId && selectedRef.current.threadId === id;
    if (stillSelected && result.ok && "page" in result.data) {
      const validated = collaborationMessagePageSchema.safeParse(result.data.page);
      if (validated.success && validated.data.threadId === id) {
        setPage(validated.data);
        setMessages((current) => {
          if (cursor === null && current.length === 0) return validated.data.items;
          return mergeTeamMessages(current, validated.data.items);
        });
      }
    } else if (stillSelected) {
      if (!result.ok && result.error.code === "access_revoked") clearRevokedView();
      else setStatus(result.ok ? null : result.error.userMessage);
    }
    if (stillSelected) setLoading(false);
  }, [clearRevokedView, run]);
  const loadPageRef = useRef(loadPage);
  loadPageRef.current = loadPage;

  useEffect(() => {
    readReported.current = 0;
    readPending.current = null;
    setVisibleRead(null);
  }, [teamId, threadId]);

  useEffect(() => {
    void refreshSnapshot();
    return client.subscribe((event) => {
      if (event.type === "update") {
        const selected = selectedRef.current;
        const changedThread = event.resource.scope === "team" && event.resource.teamId === selected.teamId
          ? event.resource.threadId
          : null;
        if (changedThread) {
          if (changedThread === selected.threadId && selected.teamId) void loadPageRef.current(changedThread, selected.teamId);
          void refreshSnapshotRef.current();
        }
      } else if (event.type === "connection" && event.connection.state === "access_revoked") {
        clearRevokedView();
      } else if (event.type === "control" && event.reason === "access_revoked") {
        clearRevokedView();
      } else if (event.type === "snapshot" || event.type === "control") {
        void refreshSnapshotRef.current();
      }
    }, (next) => { if (!revokedRef.current) setSnapshot(next); });
  }, [client, clearRevokedView]);

  useEffect(() => {
    if (teamId && !threads.some((thread) => thread.id === threadId)) {
      const team = snapshot?.navigation.teams.find((item) => item.id === teamId);
      setThreadId(team?.channels.find((thread) => thread.name === "general")?.id ?? team?.channels[0]?.id ?? team?.sharedProjects[0]?.thread.id ?? "");
    }
  }, [snapshot, teamId, threadId, threads]);

  useEffect(() => {
    setHydratedAuthorityKey(null);
    setMessages([]);
    setPage(null);
    setDraftText("");
    setPendingSend(null);
    setStatus(null);
    if (!activeThread || !authority) return;
    let active = true;
    void drafts.loadDraft(authority).then((stored) => {
      if (!active || revokedRef.current) return;
      draftByAuthority.current.set(JSON.stringify(authority), { text: stored?.text ?? "", pendingSend: stored?.pendingSend ?? null });
      setDraftText(stored?.text ?? "");
      setPendingSend(stored?.pendingSend ?? null);
      setHydratedAuthorityKey(JSON.stringify(authority));
    }).catch(() => {
      if (active) {
        setStatus("Draft recovery is unavailable on this device.");
        setHydratedAuthorityKey(JSON.stringify(authority));
      }
    });
    void loadPageRef.current(activeThread.id, teamId);
    return () => { active = false; };
  }, [activeThread?.id, authority?.backendId, authority?.principalUserId, authority?.teamId, drafts, teamId]);

  useEffect(() => {
    if (!pendingSend || !authority || !messages.some((message) => message.clientMessageId === pendingSend.clientMessageId)) return;
    setPendingSend(null);
    setStatus(null);
    void drafts.saveDraft(authority, { text: draftText, pendingSend: null });
  }, [authority, draftText, drafts, messages, pendingSend]);

  useEffect(() => {
    if (!authority || !mayPersistTeamDraft({ authorityKey, hydratedAuthorityKey })) return;
    const currentDraft = {
      text: draftText,
      pendingSend,
      updatedAt: new Date().toISOString()
    };
    const persist = () => revokedRef.current ? Promise.resolve() : drafts.saveDraft(authority, currentDraft).catch(() => setStatus("Draft could not be saved on this device."));
    const sequence = ++saveSequence.current;
    const timer = window.setTimeout(() => {
      void persist();
    }, 250);
    return () => {
      window.clearTimeout(timer);
      if (saveSequence.current === sequence) {
        // Navigation and ordinary component teardown must flush the last
        // hydrated text; only run a cleanup write if a debounce was pending.
        void persist();
      }
    };
  }, [authorityKey, hydratedAuthorityKey, draftText, pendingSend, drafts]);

  const readReported = useRef(0);
  const readPending = useRef<number | null>(null);
  useEffect(() => {
    const focusedVisible = document.visibilityState === "visible" && document.hasFocus();
    const visible = visibleRead;
    if (!focusedVisible || !activeThread || !visible || !authority || readPending.current === visible.sequence || !visibleReadMayAdvance({
      messageId: visible.id,
      sequence: visible.sequence,
      senderId: visible.senderId,
      principalUserId: authority.principalUserId,
      focused: focusedVisible,
      lastReportedSequence: readReported.current
    })) return;
    readPending.current = visible.sequence;
    void run("collaboration.mark_read", {
      thread: { scope: "team", teamId, threadId: activeThread.id },
      messageId: visible.id
    }).then((result) => {
      if (result.ok) readReported.current = Math.max(readReported.current, visible.sequence);
      if (readPending.current === visible.sequence) readPending.current = null;
    }).catch(() => { if (readPending.current === visible.sequence) readPending.current = null; });
  }, [activeThread, authority, run, teamId, visibleRead]);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        const visible = [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-message-visible='true']") ?? [])]
          .sort((left, right) => Number(right.dataset.sequence) - Number(left.dataset.sequence))[0];
        if (visible) setVisibleRead({ id: visible.dataset.messageId ?? "", sequence: Number(visible.dataset.sequence), senderId: visible.dataset.senderId ?? "" });
      }
    };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => { window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, []);

  const selectThread = async (thread: CollaborationThread) => {
    if (!activeTeam) return;
    setThreadId(thread.id);
    await run("collaboration.select", {
      selection: thread.kind === "team_project_channel"
        ? { kind: "team_project_channel", teamId: activeTeam.id, teamProjectId: thread.teamProjectId, threadId: thread.id }
        : { kind: "team_channel", teamId: activeTeam.id, threadId: thread.id },
      navigationIntent: "foreground"
    });
  };

  const send = async (body: string) => {
    if (!activeThread || !authority) return;
    const capturedAuthority = authority;
    const capturedKey = authorityKey;
    const capturedTeamId = teamId;
    const capturedThreadId = activeThread.id;
    if (!capturedKey) return;
    if (pendingSend) {
      setStatus("Resolve the earlier send before sending edited text.");
      return;
    }
    const nextPending = { clientMessageId: crypto.randomUUID(), body, createdAt: new Date().toISOString() };
    draftByAuthority.current.set(capturedKey, { text: "", pendingSend: nextPending });
    setPendingSend(nextPending);
    setDraftText("");
    let requestStarted = false;
    try {
      await drafts.saveDraft(capturedAuthority, { text: "", pendingSend: nextPending });
      if (revokedRef.current) return;
      requestStarted = true;
      const result = await run("collaboration.send_message", {
        thread: { scope: "team", teamId: capturedTeamId, threadId: capturedThreadId },
        clientMessageId: nextPending.clientMessageId,
        body
      });
      if (revokedRef.current) return;
      const sentMessage = result.ok && "message" in result.data ? result.data.message : null;
      const currentlySelected = studioSelectionMatches({ teamId: capturedTeamId, threadId: capturedThreadId }, selectedRef.current);
      if (sentMessage) {
        if (currentlySelected) setMessages((current) => [...current.filter((item) => item.id !== sentMessage.id), sentMessage]);
        const latest = draftByAuthority.current.get(capturedKey) ?? { text: "", pendingSend: nextPending };
        const settled = resolvePendingSend(latest, nextPending.clientMessageId, "accepted", body);
        draftByAuthority.current.set(capturedKey, settled);
        try {
          await drafts.saveDraft(capturedAuthority, settled);
        } catch {
          if (currentlySelected && authorityKey === capturedKey) setStatus("Message sent. The edited draft update could not be saved on this device.");
          return;
        }
        if (currentlySelected && authorityKey === capturedKey) {
          setDraftText(settled.text);
          setPendingSend(settled.pendingSend);
          setStatus(null);
        }
      } else if (result.ok && "durableSend" in result.data) {
        if (currentlySelected && authorityKey === capturedKey) setStatus("Sending…");
      } else if (!result.ok && result.error.code === "access_revoked") {
        clearRevokedView();
      } else if (!result.ok && result.error.retryable) {
        const latest = draftByAuthority.current.get(capturedKey) ?? { text: "", pendingSend: nextPending };
        const retained = retainPendingSendAfterUncertainOutcome(latest, nextPending);
        draftByAuthority.current.set(capturedKey, retained);
        await drafts.saveDraft(capturedAuthority, retained).catch(() => undefined);
        if (currentlySelected && authorityKey === capturedKey) {
          setDraftText(retained.text);
          setPendingSend(retained.pendingSend);
          setStatus("Send status is unknown. Resolve the original send before retrying.");
        }
      } else {
        const latest = draftByAuthority.current.get(capturedKey) ?? { text: "", pendingSend: nextPending };
        const settled = resolvePendingSend(latest, nextPending.clientMessageId, "not-sent", body);
        draftByAuthority.current.set(capturedKey, settled);
        await drafts.saveDraft(capturedAuthority, settled);
        if (currentlySelected && authorityKey === capturedKey) {
          setDraftText(settled.text);
          setPendingSend(settled.pendingSend);
          setStatus("Not sent. Your draft is saved on this device; retry when connected.");
        }
      }
    } catch (failure) {
      if (revokedRef.current) return;
      const latest = draftByAuthority.current.get(capturedKey) ?? { text: "", pendingSend: nextPending };
      const settled = requestStarted
        ? retainPendingSendAfterUncertainOutcome(latest, nextPending)
        : resolvePendingSend(latest, nextPending.clientMessageId, "not-sent", body);
      draftByAuthority.current.set(capturedKey, settled);
      await drafts.saveDraft(capturedAuthority, settled).catch(() => undefined);
      if (studioSelectionMatches({ teamId: capturedTeamId, threadId: capturedThreadId }, selectedRef.current) && authorityKey === capturedKey) {
        setDraftText(settled.text);
        setPendingSend(settled.pendingSend);
        setStatus(requestStarted ? "Send status is unknown. Resolve the original send before retrying." : failure instanceof Error ? failure.message : "Not sent. Your draft is saved on this device.");
      }
    }
  };

  const reconcilePendingSend = async () => {
    if (!pendingSend || !activeThread || !authority) return;
    const original = pendingSend;
    const capturedAuthority = authority;
    const capturedKey = authorityKey;
    const capturedTeamId = teamId;
    const capturedThreadId = activeThread.id;
    const result = await run("collaboration.retry_message", {
      thread: { scope: "team", teamId: capturedTeamId, threadId: capturedThreadId },
      clientMessageId: original.clientMessageId,
      body: original.body
    });
    if (revokedRef.current) return;
    const message = result.ok && "message" in result.data ? result.data.message : null;
    if (message) {
      const currentlySelected = studioSelectionMatches({ teamId: capturedTeamId, threadId: capturedThreadId }, selectedRef.current);
      if (currentlySelected) setMessages((current) => [...current.filter((item) => item.id !== message.id), message]);
      const latest = draftByAuthority.current.get(capturedKey!) ?? { text: draftText, pendingSend: original };
      const settled = resolvePendingSend(latest, original.clientMessageId, "accepted", original.body);
      draftByAuthority.current.set(capturedKey!, settled);
      try {
        await drafts.saveDraft(capturedAuthority, settled);
      } catch {
        if (currentlySelected && authorityKey === capturedKey) setStatus("Message sent. The edited draft update could not be saved on this device.");
        return;
      }
      if (currentlySelected && authorityKey === capturedKey) {
        setDraftText(settled.text);
        setPendingSend(settled.pendingSend);
        setStatus(null);
      }
      return;
    }
    if (studioSelectionMatches({ teamId: capturedTeamId, threadId: capturedThreadId }, selectedRef.current) && authorityKey === capturedKey) {
      setStatus(result.ok ? "Send is still being reconciled. Keep this draft and try again." : result.error.userMessage);
    }
  };

  const onMessageVisibility = useCallback((message: CollaborationMessage, visible: boolean) => {
    if (!visible || !authority || !visibleReadMayAdvance({
      messageId: message.id,
      sequence: message.sequence,
      senderId: message.sender.id,
      principalUserId: authority.principalUserId,
      focused: document.visibilityState === "visible" && document.hasFocus(),
      lastReportedSequence: -1
    })) return;
    setVisibleRead((current) => !current || message.sequence > current.sequence
      ? { id: message.id, sequence: message.sequence, senderId: message.sender.id }
      : current);
  }, [authority?.principalUserId]);
  const changeDraftText = (text: string) => {
    if (authorityKey && hydratedAuthorityKey === authorityKey) {
      draftByAuthority.current.set(authorityKey, { text, pendingSend });
    }
    setDraftText(text);
  };

  const createChannel = async (name: string) => {
    const result = await run("collaboration.create_team_channel", { teamId, name, topic: null });
    if (revokedRef.current) return;
    const candidateThread = result.ok && "thread" in result.data ? result.data.thread : null;
    if (candidateThread?.kind === "team_channel") {
      const createdThread = candidateThread;
      setSnapshot((current) => current && ({
        ...current,
        navigation: {
          ...current.navigation,
          teams: current.navigation.teams.map((team) => team.id === teamId
            ? { ...team, channels: [...team.channels, createdThread] }
            : team)
        }
      }));
      setCreateChannelOpen(false);
      await selectThread(createdThread);
    } else if (!result.ok) setChannelError(result.error.userMessage);
  };

  const createProject = async (project: { name: string; selectionId?: string }) => {
    if (!project.selectionId) throw new Error("Choose a local folder before creating this Shared Project.");
    const selectionId = project.selectionId;
    const priorAttempt = projectRequestIds.current.get(selectionId);
    if (priorAttempt && priorAttempt.name !== project.name) {
      throw new Error("This folder already has an unresolved Shared Project request. Retry with the original name, or choose a folder to begin a new attempt.");
    }
    const requestId = priorAttempt?.requestId ?? crypto.randomUUID();
    projectRequestIds.current.set(selectionId, { requestId, name: project.name });
    let registration = localProjectRegistrations.current.get(selectionId);
    if (!registration) {
      registration = registerLocalProject({ name: project.name, selectionId });
      localProjectRegistrations.current.set(selectionId, registration);
      void registration.catch(() => {
        if (localProjectRegistrations.current.get(selectionId) === registration) localProjectRegistrations.current.delete(selectionId);
      });
    }
    await registration;
    if (revokedRef.current) return;
    const result = await run("collaboration.create_team_shared_project", { teamId, name: project.name }, requestId);
    if (revokedRef.current) return;
    const createdProject = result.ok && "project" in result.data ? result.data.project : null;
    const candidateThread = result.ok && "thread" in result.data ? result.data.thread : null;
    if (!createdProject || candidateThread?.kind !== "team_project_channel") {
      throw new Error(!result.ok ? result.error.userMessage : "Koed returned an invalid Shared Project.");
    }
    const createdThread = candidateThread;
    projectRequestIds.current.delete(selectionId);
    localProjectRegistrations.current.delete(selectionId);
    setSnapshot((current) => current && ({
      ...current,
      navigation: {
        ...current.navigation,
        teams: current.navigation.teams.map((team) => team.id === teamId
          ? { ...team, sharedProjects: [...team.sharedProjects, { ...createdProject, thread: createdThread }] }
          : team)
      }
    }));
    setCreateProjectOpen(false);
    await selectThread(createdThread);
  };

  const loadOlder = () => {
    if (!activeThread || !page?.hasOlder || !page.olderCursor) return;
    void loadPage(activeThread.id, teamId, page.olderCursor);
  };

  if (!snapshot || !activeTeam) return <div className="flex h-full min-h-0 w-full bg-background text-foreground"><nav aria-label="Workspace navigation" className="flex h-full w-[72px] shrink-0 flex-col items-center border-r border-border bg-sidebar py-4 pt-10"><Link href="/" aria-label="Personal Workspace" title="Personal Workspace" className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-surface-hover text-foreground"><User className="h-5 w-5" /></Link><div className="mt-auto"><Link href="/settings" aria-label="Settings" title="Settings" className="flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-surface-hover"><Settings className="h-5 w-5" /></Link></div></nav><div className="flex flex-1 items-center justify-center text-sm text-muted"><div className="text-center">{status ?? "No Team access is available."}<button type="button" onClick={onRefresh} className="ml-3 underline">Refresh</button></div></div></div>;
  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      <SidebarProvider>
      <aside className="flex w-[72px] shrink-0 flex-col items-center border-r border-border bg-sidebar py-4 pt-10">
        <Link href="/" aria-label="Personal Workspace" title="Personal Workspace" className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-surface-hover text-foreground transition-colors hover:bg-surface-active"><User className="h-5 w-5" /></Link>
        <div className="my-2 h-px w-8 bg-surface-hover" />
        {snapshot.navigation.teams.map((team, index) => <button key={team.id} type="button" aria-label={team.name} aria-current={team.id === teamId ? "page" : undefined} title={team.name} onClick={() => {
          setTeamId(team.id);
          const next = snapshot.navigation.teams.find((item) => item.id === team.id);
          setThreadId(next?.channels.find((thread) => thread.name === "general")?.id ?? next?.channels[0]?.id ?? next?.sharedProjects[0]?.thread.id ?? "");
        }} className={`mb-3 flex h-10 w-10 items-center justify-center rounded-xl border text-sm font-semibold ${team.id === teamId ? "border-accent/50 bg-surface-hover text-foreground ring-2 ring-accent" : "border-border bg-surface text-muted hover:bg-surface-hover"}`}>{team.name.slice(0, 1).toUpperCase() || index + 1}</button>)}
        <Link href="/settings" aria-label="Settings" title="Settings" className="mt-auto flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-hover hover:text-foreground"><Settings className="h-5 w-5" /></Link>
      </aside>
      <TeamChannelNavigation
        teamName={activeTeam.name}
        channels={threads.map((thread) => ({ id: thread.id, name: thread.name }))}
        people={activeTeam.people.map((person) => ({ id: person.id, name: person.displayName }))}
        selectedId={threadId}
        onSelect={(id) => { const thread = threads.find((item) => item.id === id); if (thread) void selectThread(thread); }}
        onCreate={() => { setChannelError(null); setCreateChannelOpen(true); }}
      />
      <section className="relative flex min-w-0 flex-1 flex-col">
        <TeamShell
          wallpaper
          subheader={<ChannelHeader channelName={activeThread?.name ?? "Select a channel"} project={null} agents={[]} members={activeTeam.people.map((person) => ({ id: person.id, name: person.displayName }))} />}
          footer={<footer className="border-t border-border bg-background p-4"><div className="mx-auto max-w-3xl">{pendingSend && <div className="mb-2 flex items-center justify-between rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted"><span>Previous send may have been accepted. Resolve it before retrying.</span><button type="button" onClick={() => void reconcilePendingSend()} className="font-medium text-foreground hover:underline">Reconcile send</button></div>}<ChatComposer placeholder={`Message #${activeThread?.name ?? "channel"}`} projectName={activeThread?.name ?? "Team"} branch="shared" value={draftText} onChange={changeDraftText} onSend={(text) => send(text)} showExecutionControls={false} showMetaBar={false} showFormattingToolbar sendEnabled={Boolean(activeThread && hydratedAuthorityKey === authorityKey)} footer={pendingSend ? "Resolve the earlier send before sending this edit." : "Message everyone in this channel."} /></div></footer>}
        >
          <div ref={bodyRef} className="mx-auto max-w-3xl space-y-3 pt-4">
            {page?.hasOlder && <button type="button" onClick={loadOlder} className="mx-auto block text-xs text-muted hover:text-foreground">Load older messages</button>}
            {messages.length === 0 && !loading && <p className="pt-8 text-sm text-subtle">No messages yet. Start the conversation.</p>}
            {messages.map((message) => <MessageRow key={message.id} message={message} onVisibility={onMessageVisibility} />)}
            {status && <p role="status" className="text-xs text-warning">{status}</p>}
          </div>
        </TeamShell>
      </section>
      </SidebarProvider>
      {createChannelOpen && <CreateChannelModal teamName={activeTeam.name} existingNames={threads.map((thread) => thread.name.toLowerCase())} onClose={() => setCreateChannelOpen(false)} onCreateChat={(name) => void createChannel(name)} onChooseProject={() => { setCreateChannelOpen(false); setCreateProjectOpen(true); }} />}
      {createProjectOpen && <CreateProjectModal teams={[{ id: activeTeam.id, name: activeTeam.name }]} forceTeamId={activeTeam.id} onChooseFolder={chooseLocalProjectFolder} onClose={() => setCreateProjectOpen(false)} onBack={() => { setCreateProjectOpen(false); setCreateChannelOpen(true); }} onCreate={createProject} />}
      {channelError && <div role="alert" className="fixed bottom-5 right-5 z-[110] rounded-lg border border-border bg-surface px-4 py-3 text-sm shadow-xl">{channelError}</div>}
    </div>
  );
}

function MessageRow({ message, onVisibility }: { message: CollaborationMessage; onVisibility: (message: CollaborationMessage, visible: boolean) => void }) {
  const name = message.sender.displayName ?? "Team member";
  const rowRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      const visible = Boolean(entry?.isIntersecting && document.visibilityState === "visible" && document.hasFocus());
      row.dataset.messageVisible = visible ? "true" : "false";
      row.dataset.messageId = message.id;
      row.dataset.sequence = String(message.sequence);
      onVisibility(message, visible);
    }, { threshold: 0.6 });
    observer.observe(row);
    const checkOnFocus = () => {
      if (!row.isConnected || document.visibilityState !== "visible" || !document.hasFocus()) return;
      const bounds = row.getBoundingClientRect();
      const visible = bounds.bottom > 0 && bounds.top < window.innerHeight;
      if (visible) onVisibility(message, true);
    };
    window.addEventListener("focus", checkOnFocus);
    document.addEventListener("visibilitychange", checkOnFocus);
    return () => { observer.disconnect(); window.removeEventListener("focus", checkOnFocus); document.removeEventListener("visibilitychange", checkOnFocus); };
  }, [message, onVisibility]);
  return <article ref={rowRef} data-message-visible="false" data-message-id={message.id} data-sequence={message.sequence} data-sender-id={message.sender.id} className="flex gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover/30"><div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-xs font-semibold">{name.slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-baseline gap-2"><span className="text-sm font-medium">{name}</span><time className="text-[10px] text-subtle">{new Date(message.createdAt).toLocaleString()}</time></div><p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground-secondary">{message.body}</p>{message.delivery === "failed" && <p className="text-xs text-warning">Not sent</p>}</div></article>;
}

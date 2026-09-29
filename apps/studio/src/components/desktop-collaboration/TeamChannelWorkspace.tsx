"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Settings, User } from "lucide-react";
import {
  collaborationMessagePageSchema,
  type CollaborationMessage,
  type CollaborationMessagePage,
  type CollaborationRendererCommand,
  type CollaborationSendReceipt,
  type CollaborationSnapshot,
  type CollaborationThread
} from "@koed/shared/collaboration";
import { ChatComposer } from "@/components/ChatComposer";
import { CreateChannelModal } from "@/components/CreateChannelModal";
import { CreateProjectModal } from "@/components/CreateProjectModal";
import { ChannelHeader } from "@/components/ChannelView";
import { TeamDirectMessageBubble, directMessageTitle } from "@/components/TeamDirectMessage";
import { TeamShell } from "@/components/TeamShell";
import { TeamChannelNavigation } from "@/components/TeamSidebar";
import { SidebarProvider } from "@/components/SidebarContext";
import type { StudioTeamDraft, StudioTeamDraftAuthority } from "@/lib/studio-collaboration-client";
import { StudioCollaborationClient } from "@/lib/studio-collaboration-client";
import { describeStudioCommandFailure, directMessageAttemptKey, directMessageParticipantsAreEligible, directMessageThreadMatchesRequest, draftAfterCompletedReceiptWrite, draftTextAfterSendPreflight, durableSendFailureDisposition, durableSendMatchesAuthority, durableSendStatus, mayCompleteDraftHydration, mayPersistTeamDraft, mergeTeamMessages, readCompletionMayApply, readSequenceFor, rememberReadSequence, resolvePendingSend, realtimeUpdateMayAcknowledge, retainPendingSendAfterUncertainOutcome, studioSelectionMatches, teamDraftForAcceptedReceipt, teamDraftWithoutReceiptAck, visibleReadMayAdvance } from "@/lib/team-channel-state";
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
  const [messageSelection, setMessageSelection] = useState<{ teamId: string; threadId: string } | null>(null);
  const [page, setPage] = useState<CollaborationMessagePage | null>(null);
  const [draftText, setDraftText] = useState("");
  const [pendingSend, setPendingSend] = useState<StudioTeamDraft["pendingSend"]>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [hydratedAuthorityKey, setHydratedAuthorityKey] = useState<string | null>(null);
  const [visibleRead, setVisibleRead] = useState<{ id: string; sequence: number; senderId: string; teamId: string; threadId: string } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const readReported = useRef(new Map<string, number>());
  const readPending = useRef(new Map<string, number>());
  const saveSequence = useRef(0);
  const snapshotEpoch = useRef(0);
  const revokedRef = useRef(false);
  const draftByAuthority = useRef(new Map<string, StudioTeamDraft>());
  const draftWriteTails = useRef(new Map<string, Promise<void>>());
  const receiptCompletions = useRef(new Map<string, Map<string, { messageId: string; acknowledged: boolean }>>());
  const sendLocks = useRef(new Set<string>());
  const projectRequestIds = useRef(new Map<string, { requestId: string; name: string }>());
  const directMessageRequestIds = useRef(new Map<string, string>());
  const threadSelectionGeneration = useRef(0);
  const localProjectRegistrations = useRef(new Map<string, Promise<{ id: string; name: string; lastSeenAt: string | null }>>());
  const activeTeam = snapshot?.navigation.teams.find((team) => team.id === teamId) ?? null;
  const threads = useMemo(() => [
    ...(snapshot ? teamChannels(snapshot, teamId) : []),
    ...(snapshot ? projectChannels(snapshot, teamId).map((project) => project.thread) : []),
    ...(snapshot?.navigation.teams.find((team) => team.id === teamId)?.directMessages ?? [])
  ], [snapshot, teamId]);
  const activeThread = threads.find((thread) => thread.id === threadId) ?? null;
  const activeDirectMessage = activeThread?.kind === "dm" || activeThread?.kind === "group_dm" ? activeThread : null;
  const activeDirectMessageTitle = activeDirectMessage && snapshot?.navigation.teamPrincipal
    ? directMessageTitle(activeDirectMessage, snapshot.navigation.teamPrincipal.id)
    : "";
  const authority: DraftAuthority | null = snapshot && snapshot.navigation.teamPrincipal && snapshot.connection.backendId && teamId && threadId
    ? { backendId: snapshot.connection.backendId, principalUserId: snapshot.navigation.teamPrincipal.id, teamId, threadId }
    : null;
  const authorityKey = authority ? JSON.stringify(authority) : null;
  const messagesMatchSelection = Boolean(activeThread && messageSelection?.teamId === teamId && messageSelection.threadId === activeThread.id);
  const visibleMessages = messagesMatchSelection ? messages : [];
  const visiblePage = messagesMatchSelection ? page : null;
  const visibleDraftText = authorityKey && hydratedAuthorityKey === authorityKey ? draftText : "";
  const visiblePendingSend = authorityKey && hydratedAuthorityKey === authorityKey ? pendingSend : null;
  const authorityKeyRef = useRef<string | null>(authorityKey);
  authorityKeyRef.current = authorityKey;
  const selectedRef = useRef({ teamId, threadId });
  selectedRef.current = { teamId, threadId };

  const run = useCallback(async (
    command: CollaborationRendererCommand["command"],
    input: Record<string, unknown>,
    requestId?: string
  ) => client.run(command, input, requestId), [client]);

  const persistDraft = useCallback((draftAuthority: DraftAuthority, candidate: StudioTeamDraft): Promise<StudioTeamDraft> => {
    const key = JSON.stringify(draftAuthority);
    const previous = draftWriteTails.current.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const latest = draftByAuthority.current.get(key) ?? candidate;
      const completions = receiptCompletions.current.get(key);
      const latestCompletion = latest.pendingSend ? completions?.get(latest.pendingSend.clientMessageId) : undefined;
      const candidateCompletion = candidate.pendingSend ? completions?.get(candidate.pendingSend.clientMessageId) : undefined;
      const completion = latestCompletion
        ? { clientMessageId: latest.pendingSend!.clientMessageId, ...latestCompletion }
          : candidateCompletion
            ? { clientMessageId: candidate.pendingSend!.clientMessageId, ...candidateCompletion }
            : null;
      const value = completion
        ? draftAfterCompletedReceiptWrite({ latest, candidate, ...completion })
        : candidate;
      await drafts.saveDraft(draftAuthority, value);
      if (completion && draftByAuthority.current.get(key) === latest) {
        draftByAuthority.current.set(key, value);
      }
      return value;
    });
    const tail = operation.then(() => undefined, () => undefined);
    draftWriteTails.current.set(key, tail);
    void tail.then(() => { if (draftWriteTails.current.get(key) === tail) draftWriteTails.current.delete(key); });
    return operation;
  }, [drafts]);

  const acknowledgeReceiptMarker = useCallback(async (draftAuthority: DraftAuthority, marker: NonNullable<StudioTeamDraft["receiptAckPending"]>) => {
    const result = await run("collaboration.acknowledge_send_receipt", {
      thread: { scope: "team", teamId: draftAuthority.teamId, threadId: draftAuthority.threadId },
      clientMessageId: marker.clientMessageId,
      messageId: marker.messageId
    });
    if (!result.ok || !("acknowledged" in result.data) || !result.data.acknowledged) {
      throw new Error(result.ok ? "The send receipt is still waiting to be confirmed." : result.error.userMessage);
    }
  }, [run]);

  const clearSavedReceiptMarker = useCallback(async (draftAuthority: DraftAuthority, marker: NonNullable<StudioTeamDraft["receiptAckPending"]>) => {
    const key = JSON.stringify(draftAuthority);
    const completions = receiptCompletions.current.get(key) ?? new Map<string, { messageId: string; acknowledged: boolean }>();
    const completion = completions.get(marker.clientMessageId) ?? { messageId: marker.messageId, acknowledged: false };
    completions.set(marker.clientMessageId, completion);
    receiptCompletions.current.set(key, completions);
    await acknowledgeReceiptMarker(draftAuthority, marker);
    if (revokedRef.current) return;
    if (completion.messageId === marker.messageId) completion.acknowledged = true;
    const latest = draftByAuthority.current.get(key);
    if (!latest) return;
    const withoutMarker = teamDraftWithoutReceiptAck(latest, marker.clientMessageId, marker.messageId);
    if (withoutMarker === latest) return;
    try {
      await persistDraft(draftAuthority, withoutMarker);
    } catch (failure) {
      completion.acknowledged = false;
      throw failure;
    }
    if (revokedRef.current) return;
    const current = draftByAuthority.current.get(key) ?? withoutMarker;
    const normalizedCurrent = teamDraftWithoutReceiptAck(current, marker.clientMessageId, marker.messageId);
    draftByAuthority.current.set(key, normalizedCurrent);
    if (authorityKeyRef.current === key) {
      setDraftText(normalizedCurrent.text);
      setPendingSend(normalizedCurrent.pendingSend);
    }
  }, [acknowledgeReceiptMarker, persistDraft]);

  const completeAcceptedReceipt = useCallback(async (draftAuthority: DraftAuthority, receipt: CollaborationSendReceipt): Promise<boolean> => {
    if (revokedRef.current) return false;
    const key = JSON.stringify(draftAuthority);
    const latest = draftByAuthority.current.get(key);
    if (!latest) return false;
    const settled = teamDraftForAcceptedReceipt({ authority: draftAuthority, draft: latest, receipt });
    if (!settled) return false;
    const marker = settled.receiptAckPending!;
    const completions = receiptCompletions.current.get(key) ?? new Map<string, { messageId: string; acknowledged: boolean }>();
    completions.set(marker.clientMessageId, { messageId: marker.messageId, acknowledged: false });
    receiptCompletions.current.set(key, completions);
    saveSequence.current += 1;
    try {
      let saved = await persistDraft(draftAuthority, latest);
      if (revokedRef.current) return false;
      // If the user edited while IndexedDB was saving, save that newer text
      // with the same exact pending-send resolution before acknowledging.
      while (true) {
        const current = draftByAuthority.current.get(key) ?? saved;
        if (current.text !== saved.text) {
          saved = await persistDraft(draftAuthority, current);
          if (revokedRef.current) return false;
          continue;
        }
        if (current.pendingSend?.clientMessageId === receipt.clientMessageId) {
          saved = await persistDraft(draftAuthority, current);
          if (revokedRef.current) return false;
          continue;
        }
        break;
      }
      const current = draftByAuthority.current.get(key) ?? saved;
      const committed = current.pendingSend?.clientMessageId === receipt.clientMessageId
        ? teamDraftForAcceptedReceipt({ authority: draftAuthority, draft: current, receipt }) ?? saved
        : { ...current, receiptAckPending: marker };
      draftByAuthority.current.set(key, committed);
      if (authorityKeyRef.current === key) {
        setDraftText(committed.text);
        setPendingSend(committed.pendingSend);
        setStatus(null);
        setMessages((messagesNow) => mergeTeamMessages(messagesNow, [receipt.message]));
      }
      await clearSavedReceiptMarker(draftAuthority, marker);
      return true;
    } catch {
      if (!revokedRef.current && authorityKeyRef.current === key) {
        const current = draftByAuthority.current.get(key);
        if (current?.pendingSend?.clientMessageId !== receipt.clientMessageId) {
          setStatus("Message sent. Device confirmation is still being saved.");
        } else {
          setStatus("The sent message is confirmed. Its local draft is still being saved.");
        }
      }
      return false;
    }
  }, [clearSavedReceiptMarker, persistDraft]);

  const clearRevokedView = useCallback(() => {
    revokedRef.current = true;
    snapshotEpoch.current += 1;
    selectedRef.current = { teamId: "", threadId: "" };
    setSnapshot(null);
    setTeamId("");
    setThreadId("");
    setMessages([]);
    setMessageSelection(null);
    setPage(null);
    setDraftText("");
    setPendingSend(null);
    setLoading(false);
    setHydratedAuthorityKey(null);
    setVisibleRead(null);
    setStatus("Team access changed. Refresh to check your access.");
    setCreateChannelOpen(false);
    setCreateProjectOpen(false);
    draftByAuthority.current.clear();
    receiptCompletions.current.clear();
    saveSequence.current += 1;
    readReported.current.clear();
    readPending.current.clear();
  }, []);
  const recoverPendingReceipt = useCallback(async (draftAuthority: DraftAuthority, clientMessageId: string): Promise<"recovered" | "missing" | "error"> => {
    const result = await run("collaboration.get_send_receipt", {
      thread: { scope: "team", teamId: draftAuthority.teamId, threadId: draftAuthority.threadId },
      clientMessageId
    });
    if (!result.ok) {
      if (result.error.code === "access_revoked") clearRevokedView();
      else if (authorityKeyRef.current === JSON.stringify(draftAuthority)) setStatus(result.error.userMessage);
      return "error";
    }
    if (!("receipt" in result.data) || !result.data.receipt) return "missing";
    const receipt = result.data.receipt;
    if (receipt.clientMessageId !== clientMessageId) return "error";
    return await completeAcceptedReceipt(draftAuthority, receipt) ? "recovered" : "error";
  }, [clearRevokedView, completeAcceptedReceipt, run]);
  const refreshSnapshot = useCallback(async (): Promise<boolean> => {
    const epoch = snapshotEpoch.current;
    try {
      const result = await run("collaboration.load", { forceRemoteNavigation: true });
      if (epoch !== snapshotEpoch.current) return false;
      if (result.ok && "snapshot" in result.data) {
        revokedRef.current = false;
        setSnapshot(result.data.snapshot);
        return true;
      }
      if (!result.ok && result.error.code === "access_revoked") clearRevokedView();
      else if (!result.ok) setStatus(result.error.userMessage);
      return false;
    } catch (failure) {
      if (epoch !== snapshotEpoch.current || revokedRef.current) return false;
      const described = describeStudioCommandFailure(failure);
      if (described.revoked) clearRevokedView();
      else setStatus(described.message);
      return false;
    }
  }, [clearRevokedView, run]);
  const refreshSnapshotRef = useRef(refreshSnapshot);
  refreshSnapshotRef.current = refreshSnapshot;

  const loadPage = useCallback(async (id: string, selectedTeamId: string, cursor: string | null = null): Promise<boolean> => {
    if (!UUID.test(id) || !UUID.test(selectedTeamId)) return false;
    setLoading(true);
    try {
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
          setMessageSelection({ teamId: selectedTeamId, threadId: id });
          setMessages((current) => {
            if (cursor === null && current.length === 0) return validated.data.items;
            return mergeTeamMessages(current, validated.data.items);
          });
          return true;
        }
      }
      if (stillSelected) {
        if (!result.ok && result.error.code === "access_revoked") clearRevokedView();
        else setStatus(result.ok ? null : result.error.userMessage);
      }
      return false;
    } catch (failure) {
      const stillSelected = selectedRef.current.teamId === selectedTeamId && selectedRef.current.threadId === id;
      if (stillSelected && !revokedRef.current) {
        const described = describeStudioCommandFailure(failure);
        if (described.revoked) clearRevokedView();
        else setStatus(described.message);
      }
      return false;
    } finally {
      if (selectedRef.current.teamId === selectedTeamId && selectedRef.current.threadId === id) setLoading(false);
    }
  }, [clearRevokedView, run]);
  const loadPageRef = useRef(loadPage);
  loadPageRef.current = loadPage;

  useEffect(() => {
    setVisibleRead(null);
  }, [teamId, threadId]);

  useEffect(() => {
    void refreshSnapshot();
    if (!teamId) return;
    return client.subscribe(async (event) => {
      if (event.type === "update") {
        const selected = selectedRef.current;
        if (selected.teamId !== teamId) return false;
        if (event.resource.scope !== "team" || event.resource.teamId !== teamId) return true;
        const changedThread = event.resource.threadId;
        const historyApplied = changedThread && changedThread === selected.threadId
          ? await loadPageRef.current(changedThread, selected.teamId)
          : true;
        const snapshotApplied = await refreshSnapshotRef.current();
        const current = selectedRef.current;
        return realtimeUpdateMayAcknowledge({
          eventTeamId: teamId,
          eventThreadId: changedThread,
          currentTeamId: current.teamId,
          currentThreadId: current.threadId,
          historyApplied,
          snapshotApplied
        });
      } else if (event.type === "durable_send") {
        const sendAuthority = event.send.authority;
        const currentAuthorityKey = authorityKeyRef.current;
        if (sendAuthority.scope !== "team" || sendAuthority.teamId !== teamId ||
          !studioSelectionMatches({ teamId: sendAuthority.teamId, threadId: sendAuthority.threadId }, selectedRef.current) ||
          !durableSendMatchesAuthority(event.send, currentAuthorityKey)) return true;
        if (event.send.state === "sent") {
          const message = event.message;
          if (!message || message.clientMessageId !== event.send.clientMessageId) return true;
          const draftAuthority: DraftAuthority = {
            backendId: sendAuthority.backendId,
            principalUserId: sendAuthority.principalUserId,
            teamId: sendAuthority.teamId,
            threadId: sendAuthority.threadId
          };
          void completeAcceptedReceipt(draftAuthority, {
            thread: { scope: "team", teamId: sendAuthority.teamId, threadId: sendAuthority.threadId },
            clientMessageId: event.send.clientMessageId,
            message
          });
        } else {
          const latest = currentAuthorityKey ? draftByAuthority.current.get(currentAuthorityKey) : undefined;
          if (latest?.pendingSend?.clientMessageId === event.send.clientMessageId) {
            if (event.send.state === "failed" && durableSendFailureDisposition(event.send.failure?.code ?? null) === "authority_lost") {
              clearRevokedView();
              return true;
            }
            if (event.send.state === "failed" && currentAuthorityKey) {
              const settled = resolvePendingSend(latest, event.send.clientMessageId, "not-sent", latest.pendingSend.body);
              draftByAuthority.current.set(currentAuthorityKey, settled);
              setDraftText(settled.text);
              setPendingSend(settled.pendingSend);
              setStatus(event.send.failure?.userMessage
                ? `Not sent. ${event.send.failure.userMessage}`
                : "Message was not sent. Your draft is ready to send again.");
              const draftAuthority: DraftAuthority = {
                backendId: sendAuthority.backendId,
                principalUserId: sendAuthority.principalUserId,
                teamId: sendAuthority.teamId,
                threadId: sendAuthority.threadId
              };
              void persistDraft(draftAuthority, settled).catch(() => {
                if (authorityKeyRef.current === currentAuthorityKey) setStatus("Message was not sent. The updated draft could not be saved on this device.");
              });
            } else {
              setStatus(durableSendStatus(event.send));
            }
          }
        }
      } else if (event.type === "connection" && event.connection.state === "access_revoked") {
        clearRevokedView();
      } else if (event.type === "connection" && event.connection.state === "live") {
        const currentAuthority = authorityKeyRef.current ? JSON.parse(authorityKeyRef.current) as DraftAuthority : null;
        const currentDraft = currentAuthority && draftByAuthority.current.get(JSON.stringify(currentAuthority));
        if (currentAuthority?.teamId === teamId && currentDraft?.pendingSend) {
          const recovery = await recoverPendingReceipt(currentAuthority, currentDraft.pendingSend.clientMessageId);
          if (recovery === "error") return false;
        }
      } else if (event.type === "control" && event.reason === "access_revoked") {
        clearRevokedView();
      } else if (event.type === "snapshot" || event.type === "control" || event.type === "connection") {
        if (selectedRef.current.teamId !== teamId) return false;
        const snapshotApplied = await refreshSnapshotRef.current();
        if (!snapshotApplied) return false;
        const selected = selectedRef.current;
        if (selected.teamId === teamId && selected.threadId) return await loadPageRef.current(selected.threadId, teamId);
        return true;
      }
      return true;
    }, async (next) => {
      if (revokedRef.current || selectedRef.current.teamId !== teamId) return;
      if (!next.navigation.teams.some((team) => team.id === teamId)) {
        clearRevokedView();
        return;
      }
      setSnapshot(next);
      const selected = selectedRef.current;
      if (selected.threadId) await loadPageRef.current(selected.threadId, teamId);
    }, teamId);
  }, [client, clearRevokedView, completeAcceptedReceipt, drafts, persistDraft, recoverPendingReceipt, teamId]);

  useEffect(() => {
    if (teamId && !threads.some((thread) => thread.id === threadId)) {
      const team = snapshot?.navigation.teams.find((item) => item.id === teamId);
      setThreadId(team?.channels.find((thread) => thread.name === "general")?.id ?? team?.channels[0]?.id ?? team?.sharedProjects[0]?.thread.id ?? "");
    }
  }, [snapshot, teamId, threadId, threads]);

  useEffect(() => {
    setHydratedAuthorityKey(null);
    setVisibleRead(null);
    setMessages([]);
    setMessageSelection(null);
    setPage(null);
    setDraftText("");
    setPendingSend(null);
    if (!activeThread || !authority) {
      if (!revokedRef.current) setStatus(null);
      return;
    }
    setStatus(null);
    let active = true;
    void drafts.loadDraft(authority).then((stored) => {
      if (!mayCompleteDraftHydration({ active, revoked: revokedRef.current })) return;
      const key = JSON.stringify(authority);
      const hydratedDraft = stored ?? { text: "", pendingSend: null };
      draftByAuthority.current.set(key, hydratedDraft);
      setDraftText(hydratedDraft.text);
      setPendingSend(hydratedDraft.pendingSend);
      setHydratedAuthorityKey(key);
      void (async () => {
        if (hydratedDraft.receiptAckPending) {
          try {
            await clearSavedReceiptMarker(authority, hydratedDraft.receiptAckPending);
          } catch {
            if (authorityKeyRef.current === key && !revokedRef.current) setStatus("Message sent. Device confirmation is still being saved.");
          }
        }
        if (hydratedDraft.pendingSend && !revokedRef.current) {
          try { await recoverPendingReceipt(authority, hydratedDraft.pendingSend.clientMessageId); }
          catch { if (authorityKeyRef.current === key && !revokedRef.current) setStatus("Send status could not be checked. Your original draft is still available to reconcile."); }
        }
      })();
    }).catch(() => {
      if (mayCompleteDraftHydration({ active, revoked: revokedRef.current })) {
        setStatus("Draft recovery is unavailable on this device.");
        setHydratedAuthorityKey(JSON.stringify(authority));
      }
    });
    void loadPageRef.current(activeThread.id, teamId);
    return () => { active = false; };
  }, [activeThread?.id, authority?.backendId, authority?.principalUserId, authority?.teamId, clearSavedReceiptMarker, drafts, recoverPendingReceipt, teamId]);

  useEffect(() => {
    if (!authority || !mayPersistTeamDraft({ authorityKey, hydratedAuthorityKey })) return;
    const key = authorityKey!;
    const persist = () => {
      if (revokedRef.current) return;
      const latest = draftByAuthority.current.get(key) ?? { text: draftText, pendingSend };
      void persistDraft(authority, { ...latest, updatedAt: new Date().toISOString() }).catch(() => {
        if (authorityKeyRef.current === key && !revokedRef.current) setStatus("Draft could not be saved on this device.");
      });
    };
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
  }, [authority, authorityKey, hydratedAuthorityKey, draftText, pendingSend, persistDraft]);

  useEffect(() => {
    const focusedVisible = document.visibilityState === "visible" && document.hasFocus();
    const visible = visibleRead;
    if (!focusedVisible || !activeThread || !visible || !authority || !authorityKey || !messagesMatchSelection || !studioSelectionMatches({ teamId: visible.teamId, threadId: visible.threadId }, selectedRef.current) || readPending.current.get(authorityKey) === visible.sequence || !visibleReadMayAdvance({
      messageId: visible.id,
      sequence: visible.sequence,
      senderId: visible.senderId,
      principalUserId: authority.principalUserId,
      focused: focusedVisible,
      lastReportedSequence: readSequenceFor(readReported.current, authorityKey)
    })) return;
    const capturedKey = authorityKey;
    const capturedTeamId = visible.teamId;
    const capturedThreadId = visible.threadId;
    readPending.current.set(capturedKey, visible.sequence);
    void run("collaboration.mark_read", {
      thread: { scope: "team", teamId: capturedTeamId, threadId: capturedThreadId },
      messageId: visible.id
    }).then((result) => {
      if (result.ok && readCompletionMayApply(capturedKey, authorityKeyRef.current)) {
        rememberReadSequence(readReported.current, capturedKey, visible.sequence);
      }
      if (readPending.current.get(capturedKey) === visible.sequence) readPending.current.delete(capturedKey);
    }).catch(() => { if (readPending.current.get(capturedKey) === visible.sequence) readPending.current.delete(capturedKey); });
  }, [activeThread, authority, authorityKey, messagesMatchSelection, run, teamId, visibleRead]);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        const visible = [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-message-visible='true']") ?? [])]
          .sort((left, right) => Number(right.dataset.sequence) - Number(left.dataset.sequence))[0];
        const visibleTeamId = visible?.dataset.teamId;
        const visibleThreadId = visible?.dataset.threadId;
        if (visible && visibleTeamId && visibleThreadId && studioSelectionMatches({ teamId: visibleTeamId, threadId: visibleThreadId }, selectedRef.current)) {
          setVisibleRead({ id: visible.dataset.messageId ?? "", sequence: Number(visible.dataset.sequence), senderId: visible.dataset.senderId ?? "", teamId: visibleTeamId, threadId: visibleThreadId });
        }
      }
    };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => { window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, []);

  const selectThread = async (thread: CollaborationThread) => {
    if (!activeTeam) return false;
    const generation = ++threadSelectionGeneration.current;
    const selectedTeamId = activeTeam.id;
    try {
      const result = await run("collaboration.select", {
        selection: thread.kind === "team_project_channel"
          ? { kind: "team_project_channel", teamId: activeTeam.id, teamProjectId: thread.teamProjectId, threadId: thread.id }
          : thread.kind === "dm" || thread.kind === "group_dm"
            ? { kind: "team_direct_message", teamId: activeTeam.id, threadId: thread.id }
            : { kind: "team_channel", teamId: activeTeam.id, threadId: thread.id },
        navigationIntent: "foreground"
      });
      if (generation !== threadSelectionGeneration.current || selectedRef.current.teamId !== selectedTeamId) return false;
      if (!result.ok) {
        if (result.error.code === "access_revoked") clearRevokedView();
        else setStatus(result.error.userMessage);
        return false;
      }
      selectedRef.current = { teamId: selectedTeamId, threadId: thread.id };
      setThreadId(thread.id);
      return true;
    } catch (failure) {
      if (revokedRef.current || generation !== threadSelectionGeneration.current || selectedRef.current.teamId !== selectedTeamId) return false;
      const described = describeStudioCommandFailure(failure);
      if (described.revoked) clearRevokedView();
      else setStatus(described.message);
      return false;
    }
  };

  const startDirectMessage = async (participantUserIds: string[]) => {
    if (!activeTeam || !snapshot?.navigation.teamPrincipal) throw new Error("Team access changed. Refresh to check your access.");
    const selectedTeamId = activeTeam.id;
    const principalId = snapshot.navigation.teamPrincipal.id;
    const principalUserId = snapshot.navigation.teamPrincipal.id;
    const enabledMemberIds = new Set(activeTeam.people.filter((person) => person.membershipState === "enabled").map((person) => person.id));
    const participants = participantUserIds.slice().sort();
    if (!directMessageParticipantsAreEligible({ principalUserId, participantUserIds: participants, enabledMemberIds })) throw new Error("Choose an enabled teammate to message.");
    const key = directMessageAttemptKey(activeTeam.id, principalUserId, participants);
    const requestId = directMessageRequestIds.current.get(key) ?? crypto.randomUUID();
    directMessageRequestIds.current.set(key, requestId);
    const result = participants.length === 1
      ? await run("collaboration.start_direct_message", { teamId: activeTeam.id, participantUserId: participants[0] }, requestId)
      : await run("collaboration.start_group_direct_message", { teamId: activeTeam.id, participantUserIds: participants }, requestId);
    if (revokedRef.current || selectedRef.current.teamId !== selectedTeamId || snapshot?.navigation.teamPrincipal?.id !== principalId) throw new Error("Team access changed. Refresh to check your access.");
    if (!result.ok) {
      if (!result.error.retryable) directMessageRequestIds.current.delete(key);
      if (result.error.code === "access_revoked") clearRevokedView();
      throw new Error(result.error.userMessage);
    }
    if (!("thread" in result.data)) {
      throw new Error("Koed returned an invalid direct message.");
    }
    const createdThread = result.data.thread;
    if (createdThread.kind !== "dm" && createdThread.kind !== "group_dm") {
      throw new Error("Koed returned an invalid direct message.");
    }
    if (!directMessageThreadMatchesRequest({
      requestedTeamId: selectedTeamId,
      principalUserId,
      participantUserIds: participants,
      thread: createdThread
    })) {
      throw new Error("Koed returned an invalid direct message.");
    }
    directMessageRequestIds.current.delete(key);
    setSnapshot((current) => current && ({
      ...current,
      navigation: {
        ...current.navigation,
        teams: current.navigation.teams.map((team) => team.id === activeTeam.id
          ? { ...team, directMessages: [...team.directMessages.filter((item) => item.id !== createdThread.id), createdThread] }
          : team)
      }
    }));
    if (!await selectThread(createdThread)) throw new Error("The direct message was created, but it could not be opened. Refresh to check your access.");
  };

  const send = async (body: string) => {
    const key = authorityKey;
    if (!key) return;
    if (sendLocks.current.has(key)) {
      setStatus("A send is already being confirmed for this conversation.");
      throw new Error("A send is already being confirmed for this conversation.");
    }
    sendLocks.current.add(key);
    try {
      await sendMessage(body, key);
    } finally {
      sendLocks.current.delete(key);
    }
  };

  const sendMessage = async (body: string, lockedAuthorityKey: string) => {
    if (!activeThread || !authority) return;
    const capturedAuthority = authority;
    const capturedKey = authorityKey;
    if (capturedKey !== lockedAuthorityKey) return;
    const capturedTeamId = teamId;
    const capturedThreadId = activeThread.id;
    if (!capturedKey) return;
    if (pendingSend) {
      setStatus("Resolve the earlier send before sending edited text.");
      return;
    }
    const draftBeforePreflight = draftByAuthority.current.get(capturedKey)?.text ?? draftText;
    const unacknowledgedReceipt = draftByAuthority.current.get(capturedKey)?.receiptAckPending;
    if (unacknowledgedReceipt) {
      try {
        await clearSavedReceiptMarker(capturedAuthority, unacknowledgedReceipt);
      } catch {
        setStatus("Confirm the previous sent message on this device before sending another.");
        throw new Error("The previous sent message is still being confirmed on this device.");
      }
      if (revokedRef.current || authorityKeyRef.current !== capturedKey) return;
    }
    const latestText = draftByAuthority.current.get(capturedKey)?.text ?? draftBeforePreflight;
    const nextDraftText = draftTextAfterSendPreflight({ textBeforePreflight: draftBeforePreflight, latestText });
    const nextPending = { clientMessageId: crypto.randomUUID(), body, createdAt: new Date().toISOString() };
    draftByAuthority.current.set(capturedKey, { ...draftByAuthority.current.get(capturedKey), text: nextDraftText, pendingSend: nextPending });
    setPendingSend(nextPending);
    setDraftText(nextDraftText);
    let requestStarted = false;
    try {
      await persistDraft(capturedAuthority, draftByAuthority.current.get(capturedKey)!);
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
        if (sentMessage.clientMessageId === nextPending.clientMessageId && sentMessage.delivery === "sent") {
          await completeAcceptedReceipt(capturedAuthority, {
            thread: { scope: "team", teamId: capturedTeamId, threadId: capturedThreadId },
            clientMessageId: nextPending.clientMessageId,
            message: sentMessage
          });
        }
      } else if (result.ok && "durableSend" in result.data) {
        const durableSend = result.data.durableSend;
        const currentPending = draftByAuthority.current.get(capturedKey)?.pendingSend;
        if (currentlySelected && authorityKey === capturedKey &&
          durableSend.clientMessageId === nextPending.clientMessageId && currentPending?.clientMessageId === nextPending.clientMessageId &&
          durableSendMatchesAuthority(durableSend, capturedKey)) {
          setStatus(durableSendStatus(durableSend));
        }
      } else if (!result.ok && result.error.code === "access_revoked") {
        clearRevokedView();
      } else if (!result.ok && result.error.retryable) {
        const latest = draftByAuthority.current.get(capturedKey) ?? { text: "", pendingSend: nextPending };
        const retained = retainPendingSendAfterUncertainOutcome(latest, nextPending);
        draftByAuthority.current.set(capturedKey, retained);
        await persistDraft(capturedAuthority, retained).catch(() => undefined);
        if (currentlySelected && authorityKey === capturedKey) {
          setDraftText(retained.text);
          setPendingSend(retained.pendingSend);
          setStatus("Send status is unknown. Resolve the original send before retrying.");
        }
      } else {
        const latest = draftByAuthority.current.get(capturedKey) ?? { text: "", pendingSend: nextPending };
        const settled = resolvePendingSend(latest, nextPending.clientMessageId, "not-sent", body);
        draftByAuthority.current.set(capturedKey, settled);
        await persistDraft(capturedAuthority, settled);
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
      await persistDraft(capturedAuthority, settled).catch(() => undefined);
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
    const receiptResult = await recoverPendingReceipt(capturedAuthority, original.clientMessageId).catch(() => "error" as const);
    if (receiptResult !== "missing") return;
    if (revokedRef.current || authorityKeyRef.current !== capturedKey) return;
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
        await persistDraft(capturedAuthority, settled);
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
    if (!visible || !authority || !message.teamId || !studioSelectionMatches({ teamId: message.teamId, threadId: message.threadId }, selectedRef.current) || !visibleReadMayAdvance({
      messageId: message.id,
      sequence: message.sequence,
      senderId: message.sender.id,
      principalUserId: authority.principalUserId,
      focused: document.visibilityState === "visible" && document.hasFocus(),
      lastReportedSequence: -1
    })) return;
    setVisibleRead((current) => !current || message.sequence > current.sequence
      ? { id: message.id, sequence: message.sequence, senderId: message.sender.id, teamId: message.teamId!, threadId: message.threadId }
      : current);
  }, [authority?.principalUserId]);
  const changeDraftText = (text: string) => {
    if (authorityKey && hydratedAuthorityKey === authorityKey) {
      draftByAuthority.current.set(authorityKey, { ...draftByAuthority.current.get(authorityKey), text, pendingSend });
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
    if (!activeThread || !visiblePage?.hasOlder || !visiblePage.olderCursor) return;
    void loadPage(activeThread.id, teamId, visiblePage.olderCursor);
  };

  if (!snapshot || !activeTeam) return <div className="flex h-full min-h-0 w-full bg-background text-foreground"><nav aria-label="Workspace navigation" className="flex h-full w-[72px] shrink-0 flex-col items-center border-r border-border bg-sidebar py-4 pt-10"><Link href="/" aria-label="Personal Workspace" title="Personal Workspace" className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-surface-hover text-foreground"><User className="h-5 w-5" /></Link><div className="mt-auto"><Link href="/settings" aria-label="Settings" title="Settings" className="flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-surface-hover"><Settings className="h-5 w-5" /></Link></div></nav><div className="flex flex-1 items-center justify-center text-sm text-muted"><div className="text-center">{status ?? "No Team access is available."}<button type="button" onClick={onRefresh} className="ml-3 underline">Refresh</button></div></div></div>;
  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      <SidebarProvider>
      <aside className="flex w-[72px] shrink-0 flex-col items-center border-r border-border bg-sidebar py-4 pt-10">
        <Link href="/" aria-label="Personal Workspace" title="Personal Workspace" className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-surface-hover text-foreground transition-colors hover:bg-surface-active"><User className="h-5 w-5" /></Link>
        <div className="my-2 h-px w-8 bg-surface-hover" />
        {snapshot.navigation.teams.map((team, index) => <button key={team.id} type="button" aria-label={team.name} aria-current={team.id === teamId ? "page" : undefined} title={team.name} onClick={() => {
          threadSelectionGeneration.current += 1;
          setTeamId(team.id);
          const next = snapshot.navigation.teams.find((item) => item.id === team.id);
          const initialThreadId = next?.channels.find((thread) => thread.name === "general")?.id ?? next?.channels[0]?.id ?? next?.sharedProjects[0]?.thread.id ?? "";
          selectedRef.current = { teamId: team.id, threadId: initialThreadId };
          setThreadId(initialThreadId);
        }} className={`mb-3 flex h-10 w-10 items-center justify-center rounded-xl border text-sm font-semibold ${team.id === teamId ? "border-accent/50 bg-surface-hover text-foreground ring-2 ring-accent" : "border-border bg-surface text-muted hover:bg-surface-hover"}`}>{team.name.slice(0, 1).toUpperCase() || index + 1}</button>)}
        <Link href="/settings" aria-label="Settings" title="Settings" className="mt-auto flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-hover hover:text-foreground"><Settings className="h-5 w-5" /></Link>
      </aside>
      <TeamChannelNavigation
        teamName={activeTeam.name}
        channels={threads.filter((thread) => thread.kind !== "dm" && thread.kind !== "group_dm").map((thread) => ({ id: thread.id, name: thread.name }))}
        people={activeTeam.people.filter((person) => person.membershipState === "enabled").map((person) => ({ id: person.id, name: person.displayName }))}
        principalUserId={snapshot.navigation.teamPrincipal?.id ?? ""}
        directMessages={activeTeam.directMessages}
        selectedId={threadId}
        onSelect={(id) => { const thread = threads.find((item) => item.id === id); if (thread) void selectThread(thread); }}
        onCreate={() => { setChannelError(null); setCreateChannelOpen(true); }}
        onNewDirectMessage={startDirectMessage}
      />
      <section className="relative flex min-w-0 flex-1 flex-col">
        <TeamShell
          wallpaper={!activeDirectMessage}
          crumbs={activeDirectMessage ? [activeTeam.name, activeDirectMessageTitle] : undefined}
          subheader={!activeDirectMessage ? <ChannelHeader channelName={activeThread?.name ?? "Select a channel"} project={null} agents={[]} members={activeTeam.people.map((person) => ({ id: person.id, name: person.displayName }))} /> : undefined}
          footer={<footer className="border-t border-border bg-background p-4"><div className="mx-auto max-w-3xl"><div className="no-drag">{visiblePendingSend && <div className="mb-2 flex items-center justify-between rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted"><span>Previous send may have been accepted. Resolve it before retrying.</span><button type="button" onClick={() => void reconcilePendingSend()} className="font-medium text-foreground hover:underline">Reconcile send</button></div>}<fieldset disabled={!activeThread || hydratedAuthorityKey !== authorityKey} className="m-0 min-w-0 border-0 p-0"><ChatComposer placeholder={activeDirectMessage ? `Message ${activeDirectMessageTitle}` : `Message #${activeThread?.name ?? "channel"}`} projectName={activeDirectMessage ? activeTeam.name : activeThread?.name ?? "Team"} branch="shared" value={visibleDraftText} onChange={changeDraftText} onSend={(text) => send(text)} showExecutionControls={false} showMetaBar={false} showFormattingToolbar sendEnabled={Boolean(activeThread && hydratedAuthorityKey === authorityKey)} footer={visiblePendingSend ? "Resolve the earlier send before sending this edit." : activeDirectMessage ? "Direct messages stay among these people." : "Message everyone in this channel."} /></fieldset></div></div></footer>}
        >
          <div ref={bodyRef} className={`mx-auto max-w-3xl pt-4 ${activeDirectMessage ? "space-y-4" : "space-y-3"}`}>
            {visiblePage?.hasOlder && <button type="button" onClick={loadOlder} className="mx-auto block text-xs text-muted hover:text-foreground">Load older messages</button>}
            {visibleMessages.length === 0 && !loading && <p className="pt-8 text-sm text-subtle">{activeDirectMessage ? `Private to ${activeDirectMessageTitle}. Agents are not in this thread.` : "No messages yet. Start the conversation."}</p>}
            {visibleMessages.map((message) => <MessageRow key={message.id} message={message} onVisibility={onMessageVisibility} directMessagePrincipalUserId={activeDirectMessage ? snapshot.navigation.teamPrincipal?.id ?? "" : undefined} />)}
            {status && <p role="status" className="text-xs text-warning">{status}</p>}
          </div>
        </TeamShell>
      </section>
      </SidebarProvider>
      {createChannelOpen && <CreateChannelModal teamName={activeTeam.name} existingNames={threads.filter((thread) => thread.kind !== "dm" && thread.kind !== "group_dm").map((thread) => thread.name.toLowerCase())} onClose={() => setCreateChannelOpen(false)} onCreateChat={(name) => void createChannel(name)} onChooseProject={() => { setCreateChannelOpen(false); setCreateProjectOpen(true); }} />}
      {createProjectOpen && <CreateProjectModal teams={[{ id: activeTeam.id, name: activeTeam.name }]} forceTeamId={activeTeam.id} onChooseFolder={chooseLocalProjectFolder} onClose={() => setCreateProjectOpen(false)} onBack={() => { setCreateProjectOpen(false); setCreateChannelOpen(true); }} onCreate={createProject} />}
      {channelError && <div role="alert" className="fixed bottom-5 right-5 z-[110] rounded-lg border border-border bg-surface px-4 py-3 text-sm shadow-xl">{channelError}</div>}
    </div>
  );
}

function MessageRow({ message, onVisibility, directMessagePrincipalUserId }: { message: CollaborationMessage; onVisibility: (message: CollaborationMessage, visible: boolean) => void; directMessagePrincipalUserId?: string }) {
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
  const isDirectMessage = directMessagePrincipalUserId !== undefined;
  const isYou = isDirectMessage && message.sender.id === directMessagePrincipalUserId;
  return <article ref={rowRef} data-message-visible="false" data-message-id={message.id} data-sequence={message.sequence} data-sender-id={message.sender.id} data-team-id={message.teamId ?? ""} data-thread-id={message.threadId} className={isDirectMessage ? isYou ? "flex justify-end" : "flex justify-start" : "flex gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover/30"}>{isDirectMessage
    ? <TeamDirectMessageBubble message={message} principalUserId={directMessagePrincipalUserId} />
    : <><div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-xs font-semibold">{name.slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-baseline gap-2"><span className="text-sm font-medium">{name}</span><time className="text-[10px] text-subtle">{new Date(message.createdAt).toLocaleString()}</time></div><p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground-secondary">{message.body}</p>{message.delivery === "failed" && <p className="text-xs text-warning">Not sent</p>}</div></>}
  </article>;
}

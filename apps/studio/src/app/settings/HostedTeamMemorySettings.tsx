"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StudioCollaborationClient, type HostedOwnedShare, type HostedStudioNavigation } from "@/lib/studio-collaboration-client";
import { OwnedConversationShareDialog } from "@/components/studio/OwnedConversationShareDialog";
import { canCancelUnactivatedPendingShare, canStopRetainedUpdates, isHostedTeamMembershipEnabled, mayApplyTeamMemoryResult } from "./team-memory-settings.guards";

type Tab = "members" | "memory" | "my-shares";
type Member = { userId: string; displayName: string | null; enabled: boolean; version: number };
type RetainedItem = {
  shareGrantId: string;
  teamWorkspaceId: string;
  logicalMemoryId: string;
  title: string;
  contributorLabel: string;
  grantVersion: number;
  sourceUpdateState: "active" | "stopped";
  retainedAt: string;
};
type ShareRow = {
  kind: "grant" | "pending";
  id: string;
  logicalMemoryId: string;
  source: { kind: string; sessionId?: string; logicalMemoryId?: string };
  teamId: string;
  teamWorkspaceId: string;
  grantVersion: number | null;
  retentionEnabled: boolean;
  mode: "snapshot" | "continuous";
  sourceTitle: string;
  teamName: string;
  copyReady: boolean;
  lifecycle?: string;
  ownerUpdatesState?: string;
  pendingState?: string;
  pendingStage?: string;
  workspaceAccessState?: string;
  sourceUpdateState?: string;
  operationVersion?: number;
  grantId?: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function normalizeHostedShare(item: HostedOwnedShare): ShareRow | null {
  if (!isRecord(item.summary) || typeof item.summary.sourceTitle !== "string" || typeof item.summary.teamName !== "string") return null;
  if (item.kind === "grant") {
    const grant = item.grant;
    if (!grant || !isRecord(grant) || !isRecord(grant.source) || typeof grant.source.kind !== "string" ||
      typeof grant.id !== "string" || typeof grant.logicalMemoryId !== "string" || typeof grant.teamId !== "string" ||
      typeof grant.teamWorkspaceId !== "string" || !Number.isSafeInteger(grant.grantVersion) || typeof grant.retentionEnabled !== "boolean" ||
      (grant.mode !== "snapshot" && grant.mode !== "continuous") || typeof grant.lifecycle !== "string" || typeof grant.ownerUpdatesState !== "string") return null;
    return {
      kind: "grant", id: grant.id, logicalMemoryId: grant.logicalMemoryId,
      source: grant.source as ShareRow["source"], teamId: grant.teamId, teamWorkspaceId: grant.teamWorkspaceId,
      grantVersion: grant.grantVersion as number, retentionEnabled: grant.retentionEnabled, mode: grant.mode,
      sourceTitle: item.summary.sourceTitle, teamName: item.summary.teamName,
      copyReady: item.summary.workspaceContentAccess === "available" && typeof item.summary.lastReadyRevision === "number",
      lifecycle: grant.lifecycle, ownerUpdatesState: grant.ownerUpdatesState
    };
  }
  const pending = item.pendingShare;
  if (!pending || !isRecord(pending) || !isRecord(pending.source) || typeof pending.source.kind !== "string" ||
    typeof pending.id !== "string" || typeof pending.logicalMemoryId !== "string" || typeof pending.teamId !== "string" ||
    typeof pending.workspaceId !== "string" || !Number.isSafeInteger(pending.operationVersion) || typeof pending.retentionEnabled !== "boolean" ||
    (pending.mode !== "snapshot" && pending.mode !== "continuous") || typeof pending.state !== "string" ||
    typeof pending.stage !== "string" || typeof pending.workspaceAccessState !== "string" || typeof pending.sourceUpdateState !== "string" ||
    !(typeof pending.grantId === "string" || pending.grantId === null) || !(typeof pending.grantVersion === "number" || pending.grantVersion === null)) return null;
  return {
    kind: "pending", id: pending.id, logicalMemoryId: pending.logicalMemoryId,
    source: pending.source as ShareRow["source"], teamId: pending.teamId, teamWorkspaceId: pending.workspaceId,
    grantVersion: pending.grantVersion, retentionEnabled: pending.retentionEnabled, mode: pending.mode,
    sourceTitle: item.summary.sourceTitle, teamName: item.summary.teamName,
    copyReady: item.summary.workspaceContentAccess === "available" && typeof item.summary.lastReadyRevision === "number",
    pendingState: pending.state, pendingStage: pending.stage, workspaceAccessState: pending.workspaceAccessState,
    sourceUpdateState: pending.sourceUpdateState, operationVersion: pending.operationVersion as number, grantId: pending.grantId
  };
}

function retainedItem(value: Record<string, unknown>): RetainedItem | null {
  if (typeof value.shareGrantId !== "string" || typeof value.teamWorkspaceId !== "string" || typeof value.logicalMemoryId !== "string" ||
    typeof value.title !== "string" || typeof value.contributorLabel !== "string" || !Number.isSafeInteger(value.grantVersion) ||
    (value.sourceUpdateState !== "active" && value.sourceUpdateState !== "stopped") || typeof value.retainedAt !== "string") return null;
  return value as RetainedItem;
}

export function HostedTeamMemorySettings() {
  const client = useMemo(() => new StudioCollaborationClient(), []);
  const [navigation, setNavigation] = useState<HostedStudioNavigation | null>(null);
  const [teamId, setTeamId] = useState("");
  const [tab, setTab] = useState<Tab>("members");
  const [members, setMembers] = useState<Member[]>([]);
  const [retainedItems, setRetainedItems] = useState<RetainedItem[]>([]);
  const [retainedCursor, setRetainedCursor] = useState<string | null>(null);
  const [shareRows, setShareRows] = useState<ShareRow[]>([]);
  const [shareCursor, setShareCursor] = useState<{ createdAt: string; recordKind: "grant" | "pending"; id: string } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removePrompt, setRemovePrompt] = useState<RetainedItem | null>(null);
  const [dialogTarget, setDialogTarget] = useState<{ source: { id: string; logicalMemoryId: string; title: string }; teamId: string; grant: { id: string; grantVersion: number; retentionEnabled: boolean } } | null>(null);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const sessionSequence = useRef(0);
  const dataSequence = useRef(0);
  const teamGeneration = useRef(0);
  const busyGeneration = useRef(0);
  const sharesGeneration = useRef(0);
  const sessionSequenceRef = useRef(0);
  const authorityRef = useRef<string | null>(null);
  const teamIdRef = useRef("");
  const navigationRef = useRef<HostedStudioNavigation | null>(null);
  const shareCursorRef = useRef<typeof shareCursor>(null);
  const shareSnapshotAtRef = useRef<string | null>(null);

  const teams = useMemo(() => (navigation?.teams ?? [])
    .filter(({ membership }) => isHostedTeamMembershipEnabled(membership.status))
    .map(({ team, membership }) => ({ id: team.id, name: team.name, role: membership.role })), [navigation]);
  const selectedTeam = teams.find((team) => team.id === teamId) ?? null;
  const canManage = selectedTeam?.role === "owner" || selectedTeam?.role === "admin";

  const loadSession = useCallback(async (focusRefresh = false) => {
    const sequence = ++sessionSequence.current;
    sessionSequenceRef.current = sequence;
    try {
      const next = await client.loadHostedSession();
      if (sequence !== sessionSequence.current) return;
      const nextAuthority = `${window.location.origin}:${next.principal.id}`;
      const sameAuthority = authorityRef.current === nextAuthority;
      const currentTeamStillActive = next.teams.some(({ team, membership }) => team.id === teamIdRef.current && isHostedTeamMembershipEnabled(membership.status));
      const nextTeamId = currentTeamStillActive
        ? teamIdRef.current
        : next.teams.find(({ membership }) => isHostedTeamMembershipEnabled(membership.status))?.team.id ?? "";
      if (authorityRef.current && !sameAuthority) {
        teamGeneration.current += 1;
        dataSequence.current += 1;
        sharesGeneration.current += 1;
        setDialogTarget(null);
        setMembers([]);
        setRetainedItems([]);
        setShareRows([]);
        setRetainedCursor(null);
        setShareCursor(null);
        shareCursorRef.current = null;
        shareSnapshotAtRef.current = null;
        setRemovePrompt(null);
      }
      if (!currentTeamStillActive) {
        teamGeneration.current += 1;
        dataSequence.current += 1;
        setMembers([]);
        setRetainedItems([]);
        setRetainedCursor(null);
        setRemovePrompt(null);
        setDialogTarget(null);
      }
      const selected = next.teams.find(({ team }) => team.id === nextTeamId);
      const canManageSelected = selected?.membership.role === "owner" || selected?.membership.role === "admin";
      if (!canManageSelected) {
        setMembers([]);
        setRetainedItems([]);
        setRetainedCursor(null);
        setRemovePrompt(null);
      }
      teamIdRef.current = nextTeamId;
      setTeamId(nextTeamId);
      authorityRef.current = nextAuthority;
      navigationRef.current = next;
      setNavigation(next);
      setState("ready");
      setError(null);
      setSessionGeneration((value) => value + 1);
    } catch (reason) {
      if (sequence !== sessionSequence.current) return;
      const status = isRecord(reason) && typeof reason.status === "number" ? reason.status : null;
      if (status === 401 || status === 403) {
        teamGeneration.current += 1;
        dataSequence.current += 1;
        busyGeneration.current += 1;
        sharesGeneration.current += 1;
        authorityRef.current = null;
        navigationRef.current = null;
        setNavigation(null);
        setTeamId("");
        teamIdRef.current = "";
        setMembers([]);
        setRetainedItems([]);
        setShareRows([]);
        setRetainedCursor(null);
        setShareCursor(null);
        shareCursorRef.current = null;
        shareSnapshotAtRef.current = null;
        setRemovePrompt(null);
        setDialogTarget(null);
        setState("unavailable");
      } else if (!navigationRef.current || !focusRefresh) {
        setState("unavailable");
      }
      setError(reason instanceof Error ? reason.message : "Hosted Team memory is unavailable.");
    }
  }, [client]);

  useEffect(() => {
    queueMicrotask(() => { void loadSession(); });
    const onFocus = () => {
      dataSequence.current += 1;
      sessionSequence.current += 1;
      sessionSequenceRef.current = sessionSequence.current;
      busyGeneration.current += 1;
      setBusyKey(null);
      void loadSession(true);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      sessionSequence.current += 1;
      dataSequence.current += 1;
      teamGeneration.current += 1;
      busyGeneration.current += 1;
      sharesGeneration.current += 1;
      authorityRef.current = null;
      window.removeEventListener("focus", onFocus);
    };
  }, [loadSession]);

  const loadOwnedShares = useCallback(async (append = false) => {
    const sequence = ++sharesGeneration.current;
    const requestAuthority = authorityRef.current;
    const requestSession = sessionSequenceRef.current;
    const cursor = append ? shareCursorRef.current : null;
    const snapshotAt = append ? shareSnapshotAtRef.current ?? undefined : undefined;
    let result: Awaited<ReturnType<typeof client.listOwnedShares>>;
    try {
      result = await client.listOwnedShares({
        limit: 100,
        history: false,
        ...(cursor ? { afterCreatedAt: cursor.createdAt, afterKind: cursor.recordKind, afterId: cursor.id } : {}),
        ...(snapshotAt ? { snapshotAt } : {})
      });
    } catch (reason) {
      if (sequence !== sharesGeneration.current || requestSession !== sessionSequenceRef.current || requestAuthority !== authorityRef.current) return;
      throw reason;
    }
    if (!mayApplyTeamMemoryResult({ active: true, requestGeneration: requestSession, currentGeneration: sessionSequenceRef.current, requestAuthority, currentAuthority: authorityRef.current }) || sequence !== sharesGeneration.current) return;
    const normalized = result.shares.map(normalizeHostedShare);
    if (normalized.some((row) => !row)) throw new Error("Koed returned incomplete owner share details.");
    setShareRows((current) => append ? [...current, ...(normalized as ShareRow[])] : normalized as ShareRow[]);
    setShareCursor(result.pagination.hasMore ? result.pagination.next : null);
    shareCursorRef.current = result.pagination.hasMore ? result.pagination.next : null;
    shareSnapshotAtRef.current = result.pagination.snapshotAt;
  }, [client]);

  useEffect(() => {
    if (state !== "ready" || !teamId || !canManage) return;
    const sequence = ++dataSequence.current;
    const requestTeamGeneration = teamGeneration.current;
    const requestAuthority = authorityRef.current;
    const requestSession = sessionSequenceRef.current;
    const allowed = () => sequence === dataSequence.current && requestTeamGeneration === teamGeneration.current && mayApplyTeamMemoryResult({
      active: true, requestGeneration: requestSession, currentGeneration: sessionSequenceRef.current,
      requestAuthority, currentAuthority: authorityRef.current, requestTeamId: teamId, currentTeamId: teamIdRef.current
    });
    void (async () => {
      try {
        if (tab === "members") {
          const result = await client.listTeamMemoryRetentionMembers(teamId);
          if (!allowed() || result.teamId !== teamId) return;
          setMembers(result.members);
        } else if (tab === "memory") {
          const result = await client.listRetainedTeamMemory(teamId, { limit: 50 });
          if (!allowed() || result.teamId !== teamId) return;
          const parsed = result.items.map(retainedItem);
          if (parsed.some((row) => !row)) throw new Error("Koed returned incomplete retained Team memory details.");
          setRetainedItems(parsed as RetainedItem[]);
          setRetainedCursor(result.nextCursor);
        }
      } catch (reason) {
        if (allowed()) setError(reason instanceof Error ? reason.message : "Team memory settings are unavailable.");
      }
    })();
    return () => { dataSequence.current += 1; };
  // A refreshed hosted navigation snapshot must restart the selected Team's
  // load even when its authority, role, tab, and Team id are unchanged. The
  // session sequence invalidates older reads as soon as a refresh starts, so
  // key this effect to the accepted snapshot as well as the selection.
  }, [canManage, client, navigation, sessionGeneration, state, tab, teamId]);

  useEffect(() => {
    if (state !== "ready") return;
    void loadOwnedShares().catch((reason: unknown) => {
      if (authorityRef.current) setError(reason instanceof Error ? reason.message : "My shares are unavailable.");
    });
  }, [loadOwnedShares, state, sessionGeneration]);

  const selectTeam = (nextTeamId: string) => {
    teamGeneration.current += 1;
    dataSequence.current += 1;
    busyGeneration.current += 1;
    teamIdRef.current = nextTeamId;
    setBusyKey(null);
    setError(null);
    setTeamId(nextTeamId);
    setMembers([]);
    setRetainedItems([]);
    setRetainedCursor(null);
    setRemovePrompt(null);
    setDialogTarget(null);
  };

  const changeRetention = async (member: Member, enabled: boolean) => {
    if (!teamId || !canManage) return;
    const requestTeamId = teamId;
    const requestTeamGeneration = teamGeneration.current;
    const requestSession = sessionSequenceRef.current;
    const requestAuthority = authorityRef.current;
    const busyToken = ++busyGeneration.current;
    setBusyKey(`member:${member.userId}`);
    setError(null);
    try {
      await client.updateTeamMemoryRetention({ teamId, userId: member.userId, enabled, expectedVersion: member.version, mutationId: crypto.randomUUID() });
      if (!mayApplyTeamMemoryResult({ active: true, requestGeneration: requestSession, currentGeneration: sessionSequenceRef.current, requestAuthority, currentAuthority: authorityRef.current, requestTeamId, currentTeamId: teamIdRef.current }) || requestTeamGeneration !== teamGeneration.current) return;
      const result = await client.listTeamMemoryRetentionMembers(requestTeamId);
      if (!mayApplyTeamMemoryResult({ active: true, requestGeneration: requestSession, currentGeneration: sessionSequenceRef.current, requestAuthority, currentAuthority: authorityRef.current, requestTeamId, currentTeamId: teamIdRef.current }) || requestTeamGeneration !== teamGeneration.current || result.teamId !== requestTeamId) return;
      setMembers(result.members);
    } catch (reason) {
      if (requestAuthority === authorityRef.current && requestSession === sessionSequenceRef.current && requestTeamGeneration === teamGeneration.current) setError(reason instanceof Error ? reason.message : "The retention setting could not be updated.");
    } finally {
      if (busyToken === busyGeneration.current) setBusyKey(null);
    }
  };

  const loadMoreRetained = async () => {
    if (!teamId || !retainedCursor || busyKey) return;
    const requestTeamId = teamId;
    const requestTeamGeneration = teamGeneration.current;
    const requestSession = sessionSequenceRef.current;
    const requestAuthority = authorityRef.current;
    const cursor = retainedCursor;
    const busyToken = ++busyGeneration.current;
    setBusyKey("memory-page");
    try {
      const result = await client.listRetainedTeamMemory(requestTeamId, { limit: 50, cursor });
      if (!mayApplyTeamMemoryResult({ active: true, requestGeneration: requestSession, currentGeneration: sessionSequenceRef.current, requestAuthority, currentAuthority: authorityRef.current, requestTeamId, currentTeamId: teamIdRef.current }) || requestTeamGeneration !== teamGeneration.current || result.teamId !== requestTeamId) return;
      const parsed = result.items.map(retainedItem);
      if (parsed.some((row) => !row)) throw new Error("Koed returned incomplete retained Team memory details.");
      setRetainedItems((current) => [...current, ...(parsed as RetainedItem[])]);
      setRetainedCursor(result.nextCursor);
    } catch (reason) {
      if (requestTeamGeneration === teamGeneration.current && requestAuthority === authorityRef.current) setError(reason instanceof Error ? reason.message : "More retained Team memory could not be loaded.");
    } finally {
      if (busyToken === busyGeneration.current) setBusyKey(null);
    }
  };

  const loadMoreShares = async () => {
    if (!shareCursor || busyKey) return;
    const busyToken = ++busyGeneration.current;
    setBusyKey("shares-page");
    try { await loadOwnedShares(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "More shares could not be loaded."); }
    finally { if (busyToken === busyGeneration.current) setBusyKey(null); }
  };

  const removeRetained = async () => {
    if (!teamId || !canManage || !removePrompt) return;
    const target = removePrompt;
    const requestTeamId = teamId;
    const requestTeamGeneration = teamGeneration.current;
    const requestSession = sessionSequenceRef.current;
    const requestAuthority = authorityRef.current;
    const busyToken = ++busyGeneration.current;
    setBusyKey(`remove:${target.shareGrantId}`);
    setError(null);
    try {
      const result = await client.removeRetainedTeamMemory({ teamId: requestTeamId, shareGrantId: target.shareGrantId, expectedGrantVersion: target.grantVersion, mutationId: crypto.randomUUID() });
      if (!result.removed || !mayApplyTeamMemoryResult({ active: true, requestGeneration: requestSession, currentGeneration: sessionSequenceRef.current, requestAuthority, currentAuthority: authorityRef.current, requestTeamId, currentTeamId: teamIdRef.current }) || requestTeamGeneration !== teamGeneration.current) return;
      setRetainedItems((current) => current.filter((item) => item.shareGrantId !== target.shareGrantId));
      setRemovePrompt(null);
    } catch (reason) {
      if (requestAuthority === authorityRef.current && requestSession === sessionSequenceRef.current && requestTeamGeneration === teamGeneration.current) setError(reason instanceof Error ? reason.message : "The retained Team memory could not be removed.");
    } finally { if (busyToken === busyGeneration.current) setBusyKey(null); }
  };

  const controlShare = async (row: ShareRow, action: "stop-updates" | "stop-sharing") => {
    const expectedGrantVersion = row.grantVersion;
    if (row.kind !== "grant" || !expectedGrantVersion) return;
    const requestSession = sessionSequenceRef.current;
    const requestAuthority = authorityRef.current;
    const busyToken = ++busyGeneration.current;
    setBusyKey(`${action}:${row.id}`);
    try {
      if (action === "stop-updates") {
        if (!canStopRetainedUpdates({ retentionEnabled: row.retentionEnabled, updatesActive: row.lifecycle === "active" && row.ownerUpdatesState === "active", shareGrantId: row.id, grantVersion: expectedGrantVersion })) return;
        await client.stopOwnedTeamMemoryUpdates({ teamId: row.teamId, teamWorkspaceId: row.teamWorkspaceId, shareGrantId: row.id, expectedGrantVersion, mutationId: crypto.randomUUID() });
      } else {
        if (row.retentionEnabled || row.lifecycle !== "active") return;
        await client.revokeOwnedShare({ teamId: row.teamId, teamWorkspaceId: row.teamWorkspaceId, shareGrantId: row.id, expectedGrantVersion, mutationId: crypto.randomUUID(), reasonCode: "owner_stopped_sharing" });
      }
      if (requestAuthority !== authorityRef.current || requestSession !== sessionSequenceRef.current) return;
      await loadOwnedShares();
    } catch (reason) {
      if (requestAuthority === authorityRef.current && requestSession === sessionSequenceRef.current) setError(reason instanceof Error ? reason.message : "This share could not be stopped.");
    } finally { if (busyToken === busyGeneration.current) setBusyKey(null); }
  };

  const cancelPendingShare = async (row: ShareRow) => {
    if (row.kind !== "pending" || !row.operationVersion || !canCancelUnactivatedPendingShare({ pendingShareId: row.id, grantId: row.grantId ?? null, state: row.pendingState ?? "", workspaceAccessState: row.workspaceAccessState ?? "" })) return;
    const requestSession = sessionSequenceRef.current;
    const requestAuthority = authorityRef.current;
    const busyToken = ++busyGeneration.current;
    setBusyKey(`cancel:${row.id}`);
    try {
      await client.controlOwnedPendingShare(row.id, { mutationId: crypto.randomUUID(), expectedOperationVersion: row.operationVersion, action: "revoke" });
      if (requestAuthority !== authorityRef.current || requestSession !== sessionSequence.current) return;
      await loadOwnedShares();
    } catch (reason) {
      if (requestAuthority === authorityRef.current && requestSession === sessionSequence.current) setError(reason instanceof Error ? reason.message : "This pending share could not be cancelled.");
    } finally { if (busyToken === busyGeneration.current) setBusyKey(null); }
  };

  const pendingGrantIds = new Set(shareRows.filter((row) => row.kind === "pending" && row.grantId).map((row) => row.grantId));

  return (
    <section className="mt-8 border-t border-border pt-8" aria-labelledby="hosted-team-memory-settings-heading">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 id="hosted-team-memory-settings-heading" className="text-sm font-medium text-foreground-secondary">Teams · Memory</h2><p className="mt-1 text-xs leading-5 text-muted">Member changes apply to future shares. Retained Team copies remain until an admin removes them.</p></div>
        {teams.length > 0 ? <label className="text-xs text-subtle">Team<select value={teamId} onChange={(event) => selectTeam(event.target.value)} className="ml-2 rounded-md border border-border bg-surface px-2 py-1.5 text-foreground">{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label> : null}
      </header>
      {state === "ready" && teams.length > 0 ? <>
        <nav className="mt-5 flex gap-1 border-b border-border" aria-label="Team memory settings">
          {([ ["members", "Members"], ["memory", "Team memory"], ["my-shares", "My shares"] ] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`border-b-2 px-3 py-2 text-xs ${tab === value ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"}`}>{label}</button>)}
        </nav>
        {tab === "members" ? canManage ? <div role="tabpanel" className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface/40">
          {members.length === 0 ? <p className="p-4 text-xs text-muted">Loading member retention settings…</p> : members.map((member) => <div key={member.userId} className="flex items-center gap-3 px-4 py-3"><span className="min-w-0 flex-1 truncate text-sm text-foreground-secondary">{member.displayName?.trim() || "Team member"}</span><span className="text-xs text-muted">Retain new shares</span><button type="button" role="switch" aria-checked={member.enabled} aria-label={`Retain new shares for ${member.displayName || "Team member"}`} disabled={Boolean(busyKey)} onClick={() => void changeRetention(member, !member.enabled)} className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${member.enabled ? "bg-accent" : "bg-border-strong"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${member.enabled ? "translate-x-4" : "translate-x-0.5"}`} /></button></div>)}
        </div> : <p role="tabpanel" className="mt-3 text-xs text-muted">Only Team admins can manage member retention and retained Team memory.</p> : null}
        {tab === "memory" ? canManage ? <div role="tabpanel" className="mt-3 space-y-2">
          {retainedItems.length === 0 ? <p className="rounded-lg border border-border bg-surface/40 p-4 text-xs text-muted">No retained Team memory is available.</p> : retainedItems.map((item) => <article key={item.shareGrantId} className="flex items-start gap-3 rounded-lg border border-border bg-surface/40 px-4 py-3"><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium text-foreground">{item.title}</h3><p className="mt-1 truncate text-xs text-muted">Contributed by {item.contributorLabel}</p><p className="mt-1 text-[11px] text-subtle">Updates {item.sourceUpdateState} · Retained {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(item.retainedAt))}</p></div><button type="button" disabled={Boolean(busyKey)} onClick={() => setRemovePrompt(item)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:border-warning/40 hover:text-warning disabled:opacity-50">Remove</button></article>)}
          {retainedCursor ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void loadMoreRetained()} className="rounded-md px-3 py-2 text-xs text-muted hover:bg-surface-hover hover:text-foreground">{busyKey === "memory-page" ? "Loading…" : "Load more"}</button> : null}
        </div> : <p role="tabpanel" className="mt-3 text-xs text-muted">Only Team admins can manage member retention and retained Team memory.</p> : null}
        {tab === "my-shares" ? <div role="tabpanel" className="mt-3 space-y-2">
          {shareRows.length === 0 ? <p className="rounded-lg border border-border bg-surface/40 p-4 text-xs text-muted">No active Personal Memory shares.</p> : shareRows.map((row) => {
            const pendingUpdate = row.kind === "pending" && row.grantId !== null && row.grantId !== undefined;
            const grantActive = row.kind === "grant" && row.lifecycle === "active";
            const canStop = row.kind === "grant" && canStopRetainedUpdates({ retentionEnabled: row.retentionEnabled, updatesActive: grantActive && row.ownerUpdatesState === "active", shareGrantId: row.id, grantVersion: row.grantVersion });
            const canRevoke = row.kind === "grant" ? grantActive && !row.retentionEnabled : canCancelUnactivatedPendingShare({ pendingShareId: row.id, grantId: row.grantId ?? null, state: row.pendingState ?? "", workspaceAccessState: row.workspaceAccessState ?? "" });
            const sourceReady = row.source.kind === "captured_session" && typeof row.source.sessionId === "string" && row.source.logicalMemoryId === row.logicalMemoryId && Boolean(row.logicalMemoryId);
            const canReview = row.kind === "grant" && sourceReady && row.lifecycle === "active" && !pendingGrantIds.has(row.id) && row.grantVersion !== null;
            const resumeAndRefresh = () => {
              if (!canReview || row.kind !== "grant" || !row.source.sessionId) return;
              setDialogTarget({ source: { id: row.source.sessionId, logicalMemoryId: row.logicalMemoryId, title: row.sourceTitle }, teamId: row.teamId, grant: { id: row.id, grantVersion: row.grantVersion!, retentionEnabled: row.retentionEnabled } });
            };
            return <article key={`${row.kind}:${row.id}`} className="flex items-start gap-3 rounded-lg border border-border bg-surface/40 px-4 py-3"><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium text-foreground">{row.sourceTitle}</h3><p className="mt-1 truncate text-xs text-muted">{row.teamName} · {row.mode === "snapshot" ? "Snapshot" : "Ongoing updates"}</p><p className="mt-1 text-[11px] text-subtle">{pendingUpdate ? "An update is preparing; the current copy stays available until ready." : row.kind === "pending" ? `${row.pendingStage?.replaceAll("_", " ")} · ${row.pendingState?.replaceAll("_", " ")}` : !row.copyReady ? "Preparing privacy-processed Team copy" : row.ownerUpdatesState === "stopped" ? "Updates stopped" : "Updates active"}{row.retentionEnabled ? " · retained Team copy stays until admin removal" : " · stopping also blocks future recall"}</p></div>
              {canReview ? <button type="button" disabled={Boolean(busyKey)} onClick={resumeAndRefresh} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:text-foreground disabled:opacity-50">Review / refresh</button> : sourceReady && pendingUpdate ? <span className="px-2.5 py-1.5 text-xs text-muted">Already preparing</span> : null}
              {canStop ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void controlShare(row, "stop-updates")} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:border-warning/40 hover:text-warning disabled:opacity-50">{busyKey === `stop-updates:${row.id}` ? "Stopping…" : "Stop updates"}</button> : null}
              {canRevoke ? <button type="button" disabled={Boolean(busyKey)} onClick={() => row.kind === "grant" ? void controlShare(row, "stop-sharing") : void cancelPendingShare(row)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:border-warning/40 hover:text-warning disabled:opacity-50">{busyKey?.endsWith(row.id) ? "Stopping…" : row.kind === "pending" ? "Cancel share" : "Stop sharing"}</button> : null}
            </article>;
          })}
          {shareCursor ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void loadMoreShares()} className="rounded-md px-3 py-2 text-xs text-muted hover:bg-surface-hover hover:text-foreground">{busyKey === "shares-page" ? "Loading…" : "Load more"}</button> : null}
        </div> : null}
      </> : null}
      {state === "loading" ? <p role="status" className="mt-3 text-xs text-muted">Loading Team settings…</p> : null}
      {state === "unavailable" ? <p className="mt-3 text-xs text-muted">Hosted Team memory settings are unavailable.</p> : null}
      {teams.length === 0 && state === "ready" ? <p className="mt-3 text-xs text-muted">Join a Team to manage Team memory.</p> : null}
      {error ? <p role="alert" className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">{error}</p> : null}
      {removePrompt ? <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"><section role="alertdialog" aria-modal="true" aria-labelledby="hosted-remove-retained-title" className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-2xl"><h3 id="hosted-remove-retained-title" className="text-sm font-semibold text-foreground">Remove retained Team memory?</h3><p className="mt-2 text-sm text-foreground-secondary">“{removePrompt.title}” by {removePrompt.contributorLabel} will no longer be available to Team members.</p><p className="mt-2 text-xs text-muted">This does not change the contributor’s Personal Memory or copies in other Teams.</p><div className="mt-5 flex justify-end gap-2"><button type="button" disabled={Boolean(busyKey)} onClick={() => setRemovePrompt(null)} className="rounded-md px-3 py-2 text-xs text-muted hover:bg-surface-hover">Cancel</button><button type="button" disabled={Boolean(busyKey)} onClick={() => void removeRetained()} className="rounded-md bg-warning px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{busyKey?.startsWith("remove:") ? "Removing…" : "Remove memory"}</button></div></section></div> : null}
      {dialogTarget ? <OwnedConversationShareDialog key={`${dialogTarget.teamId}:${dialogTarget.source.id}:${dialogTarget.grant.id}`} client={client} source={dialogTarget.source} teams={teams.map(({ id, name }) => ({ id, name }))} hostedBrowser initialTeamId={dialogTarget.teamId} initialTargetGrant={dialogTarget.grant} onComplete={() => void loadOwnedShares()} onClose={() => setDialogTarget(null)} /> : null}
    </section>
  );
}

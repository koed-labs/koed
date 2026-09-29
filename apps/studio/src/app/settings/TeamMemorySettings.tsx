"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StudioCollaborationClient } from "@/lib/studio-collaboration-client";
import type { CollaborationSnapshot, OwnedShareItem, OwnedSharedMemoryGrant } from "@koed/shared/collaboration";
import { HostedTeamMemorySettings } from "./HostedTeamMemorySettings";
import { canCancelUnactivatedPendingShare, canStopRetainedUpdates, mayApplyTeamMemoryResult } from "./team-memory-settings.guards";

type Tab = "members" | "memory" | "my-shares";
type Member = {
  userId: string;
  displayName: string | null;
  enabled: boolean;
  version: number;
};
type RetainedItem = {
  shareGrantId: string;
  logicalMemoryId: string;
  title: string;
  contributorLabel: string;
  grantVersion: number;
  sourceUpdateState: "active" | "stopped";
  retainedAt: string;
};

function commandData<T>(
  result: Awaited<ReturnType<StudioCollaborationClient["run"]>>,
  expectedCommand: string
): T {
  if (!result.ok || result.command !== expectedCommand) {
    throw new Error("Koed returned an unexpected Team settings result.");
  }
  return result.data as T;
}

export function TeamMemorySettings() {
  if (process.env.NEXT_PUBLIC_KOED_STUDIO_HOSTED === "1") return <HostedTeamMemorySettings />;
  return <NativeTeamMemorySettings />;
}

function NativeTeamMemorySettings() {
  const client = useMemo(() => new StudioCollaborationClient(), []);
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(null);
  const [teamId, setTeamId] = useState("");
  const [tab, setTab] = useState<Tab>("members");
  const [members, setMembers] = useState<Member[]>([]);
  const [items, setItems] = useState<RetainedItem[]>([]);
  const [ownedShares, setOwnedShares] = useState<OwnedShareItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [ownedSharesNextCursor, setOwnedSharesNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removePrompt, setRemovePrompt] = useState<RetainedItem | null>(null);
  const loadSequence = useRef(0);
  const sessionSequence = useRef(0);
  const teamGeneration = useRef(0);
  const busyGeneration = useRef(0);
  const ownedSharesGeneration = useRef(0);
  const authorityKeyRef = useRef<string | null>(null);
  const lastAuthorityKeyRef = useRef<string | null>(null);
  const teamIdRef = useRef("");
  const sessionLoadRef = useRef<Promise<{ authorityKey: string; snapshot: CollaborationSnapshot } | null> | null>(null);
  const teams = (snapshot?.navigation.teams ?? []).filter((team) => team.lifecycle === "active");
  const selectedTeam = teams.find((team) => team.id === teamId) ?? null;
  const canManage = selectedTeam?.role === "owner" || selectedTeam?.role === "admin";

  useEffect(() => {
    let active = true;
    const loadSession = () => {
      const sequence = ++sessionSequence.current;
      const pending = client.loadSession().then((value) => {
        if (!active || sequence !== sessionSequence.current) return null;
        loadSequence.current += 1;
        ownedSharesGeneration.current += 1;
        const authorityKey = `${value.connection.backendId ?? ""}:${value.navigation.teamPrincipal?.id ?? ""}`;
        const authorityChanged = lastAuthorityKeyRef.current !== null && lastAuthorityKeyRef.current !== authorityKey;
        const currentTeamIsActive = value.navigation.teams.some((team) => team.id === teamIdRef.current && team.lifecycle === "active");
        const nextTeamId = currentTeamIsActive
          ? teamIdRef.current
          : value.navigation.teams.find((team) => team.lifecycle === "active")?.id ?? "";
        const selectedTeam = value.navigation.teams.find((team) => team.id === nextTeamId && team.lifecycle === "active");
        const canStillManage = selectedTeam?.role === "owner" || selectedTeam?.role === "admin";
        if (authorityChanged || !currentTeamIsActive) {
          teamGeneration.current += 1;
          setMembers([]);
          setItems([]);
          setNextCursor(null);
          setRemovePrompt(null);
        } else if (!canStillManage) {
          setMembers([]);
          setItems([]);
          setNextCursor(null);
          setRemovePrompt(null);
        }
        if (authorityChanged) {
          setOwnedShares([]);
          setOwnedSharesNextCursor(null);
        }
        teamIdRef.current = nextTeamId;
        authorityKeyRef.current = authorityKey;
        lastAuthorityKeyRef.current = authorityKey;
        setSnapshot(value);
        setTeamId(nextTeamId);
        setState("ready");
        setError(null);
        return { authorityKey, snapshot: value };
      }).catch((reason: unknown) => {
        if (!active || sequence !== sessionSequence.current) return null;
        const status = reason && typeof reason === "object" && "status" in reason ? (reason as { status?: unknown }).status : null;
        if (status === 401 || status === 403) {
          authorityKeyRef.current = null;
          lastAuthorityKeyRef.current = null;
          setSnapshot(null);
          setTeamId("");
          teamIdRef.current = "";
          setMembers([]);
          setItems([]);
          setOwnedShares([]);
          setOwnedSharesNextCursor(null);
          setNextCursor(null);
          setRemovePrompt(null);
          setState("unavailable");
        } else if (lastAuthorityKeyRef.current) {
          authorityKeyRef.current = lastAuthorityKeyRef.current;
          setState("ready");
        } else {
          setState("unavailable");
        }
        setError(reason instanceof Error ? reason.message : "Team settings are unavailable.");
        return null;
      });
      sessionLoadRef.current = pending;
    };
    const reloadFocused = () => {
      loadSequence.current += 1;
      sessionSequence.current += 1;
      busyGeneration.current += 1;
      ownedSharesGeneration.current += 1;
      authorityKeyRef.current = null;
      setState("loading");
      setError(null);
      setBusyKey(null);
      loadSession();
    };
    loadSession();
    window.addEventListener("focus", reloadFocused);
    return () => {
      active = false;
      sessionSequence.current += 1;
      loadSequence.current += 1;
      teamGeneration.current += 1;
      busyGeneration.current += 1;
      ownedSharesGeneration.current += 1;
      authorityKeyRef.current = null;
      window.removeEventListener("focus", reloadFocused);
    };
  }, [client]);

  const loadTeamData = useCallback(async (currentTeamId: string, currentTab: Tab) => {
    const sequence = ++loadSequence.current;
    if (!currentTeamId || !canManage) return;
    try {
      if (currentTab === "members") {
        const result = await client.run("collaboration.list_team_memory_retention_members", { teamId: currentTeamId });
        const data = commandData<{ teamId: string; members: Member[] }>(result, "collaboration.list_team_memory_retention_members");
        if (sequence !== loadSequence.current || data.teamId !== currentTeamId) return;
        setMembers(data.members);
      } else {
        const result = await client.run("collaboration.list_team_retained_memory", { teamId: currentTeamId, cursor: null, limit: 50 });
        const data = commandData<{ teamId: string; items: RetainedItem[]; nextCursor: string | null }>(result, "collaboration.list_team_retained_memory");
        if (sequence !== loadSequence.current || data.teamId !== currentTeamId) return;
        setItems(data.items);
        setNextCursor(data.nextCursor);
      }
    } catch (reason) {
      if (sequence !== loadSequence.current) return;
      setError(reason instanceof Error ? reason.message : "Team memory settings are unavailable.");
    }
  }, [canManage, client]);

  useEffect(() => {
    if (state !== "ready" || !teamId || !canManage) return;
    let active = true;
    const sequence = ++loadSequence.current;
    const load = async () => {
      try {
        if (tab === "members") {
          const result = await client.run("collaboration.list_team_memory_retention_members", { teamId });
          const data = commandData<{ teamId: string; members: Member[] }>(result, "collaboration.list_team_memory_retention_members");
          if (active && sequence === loadSequence.current && data.teamId === teamId) setMembers(data.members);
        } else {
          const result = await client.run("collaboration.list_team_retained_memory", { teamId, cursor: null, limit: 50 });
          const data = commandData<{ teamId: string; items: RetainedItem[]; nextCursor: string | null }>(result, "collaboration.list_team_retained_memory");
          if (active && sequence === loadSequence.current && data.teamId === teamId) {
            setItems(data.items);
            setNextCursor(data.nextCursor);
          }
        }
      } catch (reason) {
        if (active && sequence === loadSequence.current) setError(reason instanceof Error ? reason.message : "Team memory settings are unavailable.");
      }
    };
    void load();
    return () => { active = false; };
  // Session refreshes invalidate in-flight reads via loadSequence. Include the
  // accepted snapshot so a same-authority refresh starts a replacement read
  // even when state, tab, Team, and role did not change.
  }, [canManage, client, snapshot, state, tab, teamId]);

  useEffect(() => {
    if (state !== "ready") return;
    let active = true;
    const generation = ++ownedSharesGeneration.current;
    const load = async () => {
      try {
        const authority = authorityKeyRef.current;
        const result = await client.run("collaboration.list_owned_shares", { cursor: null, limit: 100, history: false });
        const data = commandData<{ shares: OwnedShareItem[]; nextCursor: string | null }>(result, "collaboration.list_owned_shares");
        if (mayApplyTeamMemoryResult({
          active,
          requestGeneration: generation,
          currentGeneration: ownedSharesGeneration.current,
          requestAuthority: authority,
          currentAuthority: authorityKeyRef.current
        })) {
          setOwnedShares(data.shares);
          setOwnedSharesNextCursor(data.nextCursor);
        }
      } catch {
        // The Team retention panel remains usable if personal share history is unavailable.
      }
    };
    void load();
    return () => { active = false; };
  }, [client, state]);

  const changeRetention = async (member: Member, enabled: boolean) => {
    if (!teamId || !canManage) return;
    const requestTeamId = teamId;
    const requestAuthority = authorityKeyRef.current;
    const requestGeneration = sessionSequence.current;
    const requestTeamGeneration = teamGeneration.current;
    const busyToken = ++busyGeneration.current;
    const reconcileAcceptedChange = async () => {
      if (requestTeamGeneration !== teamGeneration.current || requestTeamId !== teamIdRef.current || requestAuthority !== lastAuthorityKeyRef.current) return;
      const sessionLoad = sessionLoadRef.current;
      if (!sessionLoad) return;
      const refreshed = await sessionLoad;
      if (!refreshed || refreshed.authorityKey !== requestAuthority || requestTeamId !== teamIdRef.current || requestTeamGeneration !== teamGeneration.current) return;
      const refreshedTeam = refreshed.snapshot.navigation.teams.find((team) => team.id === requestTeamId && team.lifecycle === "active");
      if (refreshedTeam?.role !== "owner" && refreshedTeam?.role !== "admin") return;
      const reconciliationSequence = sessionSequence.current;
      const result = await client.run("collaboration.list_team_memory_retention_members", { teamId: requestTeamId });
      const data = commandData<{ teamId: string; members: Member[] }>(result, "collaboration.list_team_memory_retention_members");
      if (data.teamId !== requestTeamId || requestTeamId !== teamIdRef.current || requestTeamGeneration !== teamGeneration.current || reconciliationSequence !== sessionSequence.current || authorityKeyRef.current !== requestAuthority) return;
      setMembers(data.members);
    };
    const key = `member:${member.userId}`;
    setBusyKey(key);
    setError(null);
    try {
      const result = await client.run("collaboration.update_team_memory_retention", {
        teamId: requestTeamId,
        userId: member.userId,
        enabled,
        expectedVersion: member.version,
        mutationId: crypto.randomUUID()
      });
      const { policy } = commandData<{ policy: { teamId: string; enabled: boolean; version: number; userId: string } }>(result, "collaboration.update_team_memory_retention");
      const stillCurrent = mayApplyTeamMemoryResult({
        active: true,
        requestGeneration,
        currentGeneration: sessionSequence.current,
        requestAuthority,
        currentAuthority: authorityKeyRef.current,
        requestTeamId,
        currentTeamId: teamIdRef.current
      }) && requestTeamGeneration === teamGeneration.current && policy.teamId === requestTeamId;
      if (!stillCurrent) {
        await reconcileAcceptedChange();
        return;
      }
      setMembers((current) => current.map((item) => item.userId === policy.userId
        ? { ...item, enabled: policy.enabled, version: policy.version }
        : item));
    } catch (reason) {
      if (requestAuthority !== authorityKeyRef.current || requestGeneration !== sessionSequence.current || requestTeamGeneration !== teamGeneration.current) return;
      setError(reason instanceof Error ? reason.message : "The retention setting could not be updated.");
      await loadTeamData(requestTeamId, "members");
    } finally {
      if (busyToken === busyGeneration.current) setBusyKey(null);
    }
  };

  const loadMore = async () => {
    if (!teamId || !nextCursor || busyKey) return;
    const requestTeamId = teamId;
    const requestAuthority = authorityKeyRef.current;
    const requestGeneration = sessionSequence.current;
    const requestTeamGeneration = teamGeneration.current;
    const cursor = nextCursor;
    const sequence = ++loadSequence.current;
    const busyToken = ++busyGeneration.current;
    setBusyKey("page");
    try {
      const result = await client.run("collaboration.list_team_retained_memory", { teamId: requestTeamId, cursor, limit: 50 });
      const data = commandData<{ teamId: string; items: RetainedItem[]; nextCursor: string | null }>(result, "collaboration.list_team_retained_memory");
      if (sequence !== loadSequence.current || data.teamId !== requestTeamId || requestTeamGeneration !== teamGeneration.current || !mayApplyTeamMemoryResult({
        active: true,
        requestGeneration,
        currentGeneration: sessionSequence.current,
        requestAuthority,
        currentAuthority: authorityKeyRef.current,
        requestTeamId,
        currentTeamId: teamId
      })) return;
      setItems((current) => [...current, ...data.items]);
      setNextCursor(data.nextCursor);
    } catch (reason) {
      if (sequence === loadSequence.current && requestTeamGeneration === teamGeneration.current) setError(reason instanceof Error ? reason.message : "More retained memory could not be loaded.");
    } finally {
      if (busyToken === busyGeneration.current) setBusyKey(null);
    }
  };

  const loadMoreOwnedShares = async () => {
    if (!ownedSharesNextCursor || busyKey) return;
    const cursor = ownedSharesNextCursor;
    const requestAuthority = authorityKeyRef.current;
    const requestGeneration = sessionSequence.current;
    const ownerSharesRequest = ++ownedSharesGeneration.current;
    const busyToken = ++busyGeneration.current;
    setBusyKey("my-shares-page");
    try {
      const result = await client.run("collaboration.list_owned_shares", { cursor, limit: 100, history: false });
      const data = commandData<{ shares: OwnedShareItem[]; nextCursor: string | null }>(result, "collaboration.list_owned_shares");
      if (!mayApplyTeamMemoryResult({
        active: true,
        requestGeneration,
        currentGeneration: sessionSequence.current,
        requestAuthority,
        currentAuthority: authorityKeyRef.current
      }) || ownerSharesRequest !== ownedSharesGeneration.current) return;
      setOwnedShares((current) => [...current, ...data.shares]);
      setOwnedSharesNextCursor(data.nextCursor);
    } catch (reason) {
      if (requestGeneration === sessionSequence.current && requestAuthority === authorityKeyRef.current && ownerSharesRequest === ownedSharesGeneration.current) {
        setError(reason instanceof Error ? reason.message : "More shares could not be loaded.");
      }
    } finally {
      if (busyToken === busyGeneration.current) setBusyKey(null);
    }
  };

  const removeRetained = async () => {
    if (!teamId || !canManage || !removePrompt) return;
    const target = removePrompt;
    const requestTeamId = teamId;
    const requestAuthority = authorityKeyRef.current;
    const requestGeneration = sessionSequence.current;
    const requestTeamGeneration = teamGeneration.current;
    const busyToken = ++busyGeneration.current;
    setBusyKey(`remove:${target.shareGrantId}`);
    setError(null);
    try {
      const result = await client.run("collaboration.remove_team_retained_memory", {
        teamId: requestTeamId,
        shareGrantId: target.shareGrantId,
        expectedGrantVersion: target.grantVersion,
        mutationId: crypto.randomUUID()
      });
      const data = commandData<{ shareGrantId: string; removed: boolean }>(result, "collaboration.remove_team_retained_memory");
      if (requestAuthority !== authorityKeyRef.current || requestGeneration !== sessionSequence.current || requestTeamGeneration !== teamGeneration.current) return;
      if (!data.removed) {
        throw new Error("This retained item changed before it could be removed. Refresh the Team memory list.");
      }
      setItems((current) => current.filter((item) => item.shareGrantId !== data.shareGrantId));
      setRemovePrompt(null);
    } catch (reason) {
      if (requestAuthority !== authorityKeyRef.current || requestGeneration !== sessionSequence.current || requestTeamGeneration !== teamGeneration.current) return;
      setError(reason instanceof Error ? reason.message : "The retained Team memory could not be removed.");
      await loadTeamData(requestTeamId, "memory");
    } finally {
      if (busyToken === busyGeneration.current) setBusyKey(null);
    }
  };

  const stopUpdates = async (item: OwnedShareItem) => {
    if (item.kind !== "grant") return;
    const grant = item.grant;
    const shareGrantId = grant.id;
    const expectedGrantVersion = grant.grantVersion;
    if (!canStopRetainedUpdates({
      retentionEnabled: grant.retentionEnabled,
      updatesActive: grant.lifecycle === "active" && grant.ownerUpdatesState === "active",
      shareGrantId,
      grantVersion: expectedGrantVersion
    })) return;
    const key = `stop:${shareGrantId}`;
    const requestAuthority = authorityKeyRef.current;
    const requestGeneration = sessionSequence.current;
    const busyToken = ++busyGeneration.current;
    setBusyKey(key);
    setError(null);
    try {
      const result = await client.run("collaboration.stop_owned_team_memory_updates", {
        teamId: grant.teamId,
        workspaceId: grant.workspaceId,
        shareGrantId,
        expectedGrantVersion,
        mutationId: crypto.randomUUID()
      });
      if (requestAuthority !== authorityKeyRef.current || requestGeneration !== sessionSequence.current) return;
      const { grant: updated } = commandData<{ grant: OwnedSharedMemoryGrant }>(result, "collaboration.stop_owned_team_memory_updates");
      setOwnedShares((current) => current.map((candidate) => {
        if (candidate.kind === "grant" && candidate.grant.id === updated.id) return { ...candidate, grant: updated };
        if (candidate.kind === "pending" && candidate.pendingShare.grantId === updated.id) return { kind: "grant", grant: updated, sourceAccess: candidate.sourceAccess, summary: candidate.summary, preview: candidate.preview };
        return candidate;
      }));
    } catch (reason) {
      if (requestAuthority !== authorityKeyRef.current || requestGeneration !== sessionSequence.current) return;
      setError(reason instanceof Error ? reason.message : "Updates could not be stopped for this Team.");
    } finally {
      if (busyToken === busyGeneration.current) setBusyKey(null);
    }
  };

  const revokeShare = async (item: OwnedShareItem) => {
    const key = item.kind === "grant" ? item.grant.id : item.pendingShare.id;
    const requestAuthority = authorityKeyRef.current;
    const requestGeneration = sessionSequence.current;
    const busyToken = ++busyGeneration.current;
    setBusyKey(`revoke:${key}`);
    setError(null);
    try {
      if (item.kind === "grant") {
        const result = await client.run("collaboration.revoke_shared_memory", {
          mutationId: crypto.randomUUID(),
          teamId: item.grant.teamId,
          workspaceId: item.grant.workspaceId,
          shareGrantId: item.grant.id,
          expectedGrantVersion: item.grant.grantVersion,
          reasonCode: "owner_stopped_sharing"
        });
        if (requestAuthority !== authorityKeyRef.current || requestGeneration !== sessionSequence.current) return;
        const { grant: updated } = commandData<{ grant: OwnedSharedMemoryGrant }>(result, "collaboration.revoke_shared_memory");
        setOwnedShares((current) => current.map((candidate) => candidate.kind === "grant" && candidate.grant.id === updated.id
          ? { ...candidate, grant: updated }
          : candidate));
      } else {
        const result = await client.run("collaboration.control_pending_share", {
          pendingShareId: item.pendingShare.id,
          mutationId: crypto.randomUUID(),
          expectedOperationVersion: item.pendingShare.operationVersion,
          action: "revoke"
        });
        if (requestAuthority !== authorityKeyRef.current || requestGeneration !== sessionSequence.current) return;
        const { pendingShare } = commandData<{ pendingShare: typeof item.pendingShare }>(result, "collaboration.control_pending_share");
        setOwnedShares((current) => current.map((candidate) => candidate.kind === "pending" && candidate.pendingShare.id === pendingShare.id
          ? { ...candidate, pendingShare }
          : candidate));
      }
    } catch (reason) {
      if (requestAuthority !== authorityKeyRef.current || requestGeneration !== sessionSequence.current) return;
      setError(reason instanceof Error ? reason.message : "This share could not be stopped.");
    } finally {
      if (busyToken === busyGeneration.current) setBusyKey(null);
    }
  };

  const selectTeam = (nextTeamId: string) => {
    teamGeneration.current += 1;
    loadSequence.current += 1;
    busyGeneration.current += 1;
    teamIdRef.current = nextTeamId;
    setBusyKey(null);
    setError(null);
    setTeamId(nextTeamId);
    setMembers([]);
    setItems([]);
    setNextCursor(null);
    setRemovePrompt(null);
  };

  return (
    <section className="mt-8 border-t border-border pt-8" aria-labelledby="team-memory-settings-heading">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="team-memory-settings-heading" className="text-sm font-medium text-foreground-secondary">Teams · Memory</h2>
          <p className="mt-1 text-xs leading-5 text-muted">New members start with retention enabled. Member changes apply to future shares and do not remove existing retained copies.</p>
        </div>
        {state === "ready" && teams.length > 0 ? <label className="text-xs text-subtle">Team
          <select value={teamId} onChange={(event) => selectTeam(event.target.value)} className="ml-2 rounded-md border border-border bg-surface px-2 py-1.5 text-foreground">
            {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
        </label> : null}
      </header>
      {state === "ready" && teams.length > 0 ? <>
        <div className="mt-4 flex gap-1 border-b border-border" role="tablist" aria-label="Team memory settings">
          {(["members", "memory", "my-shares"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`border-b-2 px-3 py-2 text-xs ${tab === value ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"}`}>
            {value === "members" ? "Members" : value === "memory" ? "Memory" : "My shares"}
          </button>)}
        </div>
        {tab === "members" || tab === "memory" ? canManage ? <>
        {tab === "members" ? <div role="tabpanel" className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface/40">
          {members.length === 0 ? <p className="p-4 text-xs text-muted">Loading member retention settings…</p> : members.map((member) => <div key={member.userId} className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1 truncate text-sm text-foreground-secondary">{member.displayName?.trim() || "Team member"}</span>
            <span className="text-xs text-muted">Retain new shares</span>
            <button type="button" role="switch" aria-checked={member.enabled} aria-label={`Retain new shares for ${member.displayName || "Team member"}`} disabled={Boolean(busyKey)} onClick={() => void changeRetention(member, !member.enabled)} className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${member.enabled ? "bg-accent" : "bg-border-strong"}`}>
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${member.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
            </button>
          </div>)}
        </div> : <div role="tabpanel" className="mt-3 space-y-2">
          {items.length === 0 ? <p className="rounded-lg border border-border bg-surface/40 p-4 text-xs text-muted">No retained Team memory is available.</p> : items.map((item) => <article key={item.shareGrantId} className="flex items-start gap-3 rounded-lg border border-border bg-surface/40 px-4 py-3">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-medium text-foreground">{item.title}</h3>
              <p className="mt-1 truncate text-xs text-muted">Contributed by {item.contributorLabel}</p>
              <p className="mt-1 text-[11px] text-subtle">Updates {item.sourceUpdateState} · Retained {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(item.retainedAt))}</p>
            </div>
            <button type="button" disabled={Boolean(busyKey)} onClick={() => setRemovePrompt(item)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:border-warning/40 hover:text-warning disabled:opacity-50">Remove</button>
          </article>)}
          {nextCursor ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void loadMore()} className="rounded-md px-3 py-2 text-xs text-muted hover:bg-surface-hover hover:text-foreground">{busyKey === "page" ? "Loading…" : "Load more"}</button> : null}
        </div>}
        </> : <p role="tabpanel" className="mt-3 text-xs text-muted">Only Team admins can manage member retention and retained Team memory.</p> : <div role="tabpanel" className="mt-3 space-y-2">
          {ownedShares.length === 0 ? <p className="rounded-lg border border-border bg-surface/40 p-4 text-xs text-muted">No active Personal Memory shares.</p> : ownedShares.map((item) => {
            const pending = item.kind === "pending" ? item.pendingShare : null;
            const grant = item.kind === "grant" ? item.grant : null;
            const record = grant ?? pending!;
            const shareGrantId = grant?.id ?? pending?.grantId;
            const version = grant?.grantVersion ?? pending?.grantVersion;
            const updatesActive = grant
              ? grant.lifecycle === "active" && grant.ownerUpdatesState === "active"
              : pending?.workspaceAccessState === "active" && pending.sourceUpdateState === "active";
            const canStop = grant ? canStopRetainedUpdates({
              retentionEnabled: record.retentionEnabled,
              updatesActive,
              shareGrantId,
              grantVersion: version
            }) : false;
            const canRevoke = grant
              ? grant.lifecycle === "active" && !grant.retentionEnabled
              : canCancelUnactivatedPendingShare({
                pendingShareId: pending!.id,
                grantId: pending!.grantId,
                state: pending!.state,
                workspaceAccessState: pending!.workspaceAccessState
              });
            return <article key={`${item.kind}:${record.id}`} className="flex items-start gap-3 rounded-lg border border-border bg-surface/40 px-4 py-3">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium text-foreground">{item.summary.sourceTitle}</h3>
                <p className="mt-1 truncate text-xs text-muted">{item.summary.teamName} · {record.mode === "snapshot" ? "Snapshot" : "Ongoing updates"}</p>
                <p className="mt-1 text-[11px] text-subtle">{pending ? `${pending.stage.replaceAll("_", " ")} · ${pending.state.replaceAll("_", " ")}` : item.summary.lastReadyRevision === null || item.summary.workspaceContentAccess === "unavailable" ? "Preparing privacy-processed Team copy" : grant?.ownerUpdatesState === "stopped" ? "Updates stopped" : "Updates active"}{record.retentionEnabled ? " · retained Team copy stays until admin removal" : " · stopping also blocks future recall"}</p>
              </div>
              {canStop ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void stopUpdates(item)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:border-warning/40 hover:text-warning disabled:opacity-50">{busyKey === `stop:${shareGrantId}` ? "Stopping…" : "Stop updates"}</button> : null}
              {canRevoke ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void revokeShare(item)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:border-warning/40 hover:text-warning disabled:opacity-50">{busyKey === `revoke:${record.id}` ? "Stopping…" : "Stop sharing"}</button> : null}
            </article>;
          })}
          {ownedSharesNextCursor ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void loadMoreOwnedShares()} className="rounded-md px-3 py-2 text-xs text-muted hover:bg-surface-hover hover:text-foreground">{busyKey === "my-shares-page" ? "Loading…" : "Load more"}</button> : null}
        </div>}
      </> : null}
      {state === "loading" ? <p role="status" className="mt-3 text-xs text-muted">Loading Team settings…</p> : null}
      {teams.length === 0 && state === "ready" ? <p className="mt-3 text-xs text-muted">Connect a Team backend to manage Team memory.</p> : null}
      {error ? <p role="alert" className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">{error}</p> : null}
      {removePrompt ? <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
        <section role="alertdialog" aria-modal="true" aria-labelledby="remove-retained-title" className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-2xl">
          <h3 id="remove-retained-title" className="text-sm font-semibold text-foreground">Remove retained Team memory?</h3>
          <p className="mt-2 text-sm text-foreground-secondary">“{removePrompt.title}” by {removePrompt.contributorLabel} will no longer be available to Team members.</p>
          <p className="mt-2 text-xs text-muted">This does not change the contributor’s Personal Memory or copies in other Teams.</p>
          <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={Boolean(busyKey)} onClick={() => setRemovePrompt(null)} className="rounded-md px-3 py-2 text-xs text-muted hover:bg-surface-hover">Cancel</button><button type="button" disabled={Boolean(busyKey)} onClick={() => void removeRetained()} className="rounded-md bg-warning px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{busyKey === `remove:${removePrompt.shareGrantId}` ? "Removing…" : "Remove memory"}</button></div>
        </section>
      </div> : null}
    </section>
  );
}

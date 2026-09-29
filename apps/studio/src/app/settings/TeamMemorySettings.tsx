"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StudioCollaborationClient } from "@/lib/studio-collaboration-client";
import type { CollaborationSnapshot, OwnedShareItem, OwnedSharedMemoryGrant } from "@koed/shared/collaboration";

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
  const client = useMemo(() => new StudioCollaborationClient(), []);
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(null);
  const [teamId, setTeamId] = useState("");
  const [tab, setTab] = useState<Tab>("members");
  const [members, setMembers] = useState<Member[]>([]);
  const [items, setItems] = useState<RetainedItem[]>([]);
  const [ownedShares, setOwnedShares] = useState<OwnedShareItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removePrompt, setRemovePrompt] = useState<RetainedItem | null>(null);
  const loadSequence = useRef(0);
  const sessionSequence = useRef(0);
  const authorityKeyRef = useRef<string | null>(null);
  const teams = (snapshot?.navigation.teams ?? []).filter((team) => team.lifecycle === "active");
  const selectedTeam = teams.find((team) => team.id === teamId) ?? null;
  const canManage = selectedTeam?.role === "owner" || selectedTeam?.role === "admin";

  useEffect(() => {
    let active = true;
    const loadSession = () => {
      const sequence = ++sessionSequence.current;
      void client.loadSession().then((value) => {
        if (!active || sequence !== sessionSequence.current) return;
        loadSequence.current += 1;
        authorityKeyRef.current = `${value.connection.backendId ?? ""}:${value.navigation.teamPrincipal?.id ?? ""}`;
        setSnapshot(value);
        setTeamId((current) => current && value.navigation.teams.some((team) => team.id === current && team.lifecycle === "active")
          ? current
          : value.navigation.teams.find((team) => team.lifecycle === "active")?.id ?? "");
        setState("ready");
      }).catch((reason: unknown) => {
        if (!active || sequence !== sessionSequence.current) return;
        setError(reason instanceof Error ? reason.message : "Team settings are unavailable.");
        setState("unavailable");
      });
    };
    const reloadFocused = () => {
      loadSequence.current += 1;
      authorityKeyRef.current = null;
      setState("loading");
      setError(null);
      setMembers([]);
      setItems([]);
      setOwnedShares([]);
      setRemovePrompt(null);
      setTeamId("");
      loadSession();
    };
    loadSession();
    window.addEventListener("focus", reloadFocused);
    return () => { active = false; window.removeEventListener("focus", reloadFocused); };
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
  }, [canManage, client, state, tab, teamId]);

  useEffect(() => {
    if (state !== "ready") return;
    let active = true;
    const load = async () => {
      try {
        const result = await client.run("collaboration.list_owned_shares", { cursor: null, limit: 50, history: false });
        const data = commandData<{ shares: OwnedShareItem[] }>(result, "collaboration.list_owned_shares");
        if (active) setOwnedShares(data.shares);
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
      if (requestAuthority !== authorityKeyRef.current || requestGeneration !== sessionSequence.current || policy.teamId !== requestTeamId) return;
      setMembers((current) => current.map((item) => item.userId === policy.userId
        ? { ...item, enabled: policy.enabled, version: policy.version }
        : item));
    } catch (reason) {
      if (requestAuthority !== authorityKeyRef.current || requestGeneration !== sessionSequence.current) return;
      setError(reason instanceof Error ? reason.message : "The retention setting could not be updated.");
      await loadTeamData(requestTeamId, "members");
    } finally {
      setBusyKey(null);
    }
  };

  const loadMore = async () => {
    if (!teamId || !nextCursor || busyKey) return;
    const cursor = nextCursor;
    const sequence = ++loadSequence.current;
    setBusyKey("page");
    try {
      const result = await client.run("collaboration.list_team_retained_memory", { teamId, cursor, limit: 50 });
      const data = commandData<{ teamId: string; items: RetainedItem[]; nextCursor: string | null }>(result, "collaboration.list_team_retained_memory");
      if (sequence !== loadSequence.current || data.teamId !== teamId) return;
      setItems((current) => [...current, ...data.items]);
      setNextCursor(data.nextCursor);
    } catch (reason) {
      if (sequence === loadSequence.current) setError(reason instanceof Error ? reason.message : "More retained memory could not be loaded.");
    } finally {
      setBusyKey(null);
    }
  };

  const removeRetained = async () => {
    if (!teamId || !canManage || !removePrompt) return;
    const target = removePrompt;
    const requestTeamId = teamId;
    const requestAuthority = authorityKeyRef.current;
    const requestGeneration = sessionSequence.current;
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
      if (requestAuthority !== authorityKeyRef.current || requestGeneration !== sessionSequence.current) return;
      if (!data.removed) {
        throw new Error("This retained item changed before it could be removed. Refresh the Team memory list.");
      }
      setItems((current) => current.filter((item) => item.shareGrantId !== data.shareGrantId));
      setRemovePrompt(null);
    } catch (reason) {
      if (requestAuthority !== authorityKeyRef.current || requestGeneration !== sessionSequence.current) return;
      setError(reason instanceof Error ? reason.message : "The retained Team memory could not be removed.");
      await loadTeamData(requestTeamId, "memory");
    } finally {
      setBusyKey(null);
    }
  };

  const stopUpdates = async (item: OwnedShareItem) => {
    const grant = item.kind === "grant" ? item.grant : null;
    const pending = item.kind === "pending" ? item.pendingShare : null;
    const shareGrantId = grant?.id ?? pending?.grantId;
    const expectedGrantVersion = grant?.grantVersion ?? pending?.grantVersion;
    if (!shareGrantId || !expectedGrantVersion) return;
    const key = `stop:${shareGrantId}`;
    const requestAuthority = authorityKeyRef.current;
    const requestGeneration = sessionSequence.current;
    setBusyKey(key);
    setError(null);
    try {
      const result = await client.run("collaboration.stop_owned_team_memory_updates", {
        teamId: grant?.teamId ?? pending!.teamId,
        workspaceId: grant?.workspaceId ?? pending!.workspaceId,
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
      setBusyKey(null);
    }
  };

  const revokeShare = async (item: OwnedShareItem) => {
    const key = item.kind === "grant" ? item.grant.id : item.pendingShare.id;
    const requestAuthority = authorityKeyRef.current;
    const requestGeneration = sessionSequence.current;
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
      setBusyKey(null);
    }
  };

  return (
    <section className="mt-8 border-t border-border pt-8" aria-labelledby="team-memory-settings-heading">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="team-memory-settings-heading" className="text-sm font-medium text-foreground-secondary">Teams · Memory</h2>
          <p className="mt-1 text-xs leading-5 text-muted">New members start with retention enabled. Member changes apply to future shares and do not remove existing retained copies.</p>
        </div>
        {state === "ready" && teams.length > 0 ? <label className="text-xs text-subtle">Team
          <select value={teamId} onChange={(event) => { setTeamId(event.target.value); setMembers([]); setItems([]); }} className="ml-2 rounded-md border border-border bg-surface px-2 py-1.5 text-foreground">
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
            const canStop = Boolean(shareGrantId && version && updatesActive);
            const canRevoke = grant
              ? grant.lifecycle === "active" && !grant.retentionEnabled
              : pending?.workspaceAccessState !== "revoked" && pending?.state !== "revoked";
            return <article key={`${item.kind}:${record.id}`} className="flex items-start gap-3 rounded-lg border border-border bg-surface/40 px-4 py-3">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium text-foreground">{item.summary.sourceTitle}</h3>
                <p className="mt-1 truncate text-xs text-muted">{item.summary.teamName} · {record.mode === "snapshot" ? "Snapshot" : "Ongoing updates"}</p>
                <p className="mt-1 text-[11px] text-subtle">{pending ? `${pending.stage.replaceAll("_", " ")} · ${pending.state.replaceAll("_", " ")}` : grant?.ownerUpdatesState === "stopped" ? "Updates stopped" : "Updates active"}{record.retentionEnabled ? " · retained Team copy stays until admin removal" : " · stopping also blocks future recall"}</p>
              </div>
              {canStop ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void stopUpdates(item)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:border-warning/40 hover:text-warning disabled:opacity-50">{busyKey === `stop:${shareGrantId}` ? "Stopping…" : "Stop updates"}</button> : null}
              {canRevoke ? <button type="button" disabled={Boolean(busyKey)} onClick={() => void revokeShare(item)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:border-warning/40 hover:text-warning disabled:opacity-50">{busyKey === `revoke:${record.id}` ? "Stopping…" : "Stop sharing"}</button> : null}
            </article>;
          })}
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
